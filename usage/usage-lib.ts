/** Shared usage cache, collector spawn, and agent/HUD formatters.
 * Server plugins import this; neither plugin's setup owns the other's tools. */
import { existsSync, readFileSync } from "node:fs"
import { spawn } from "node:child_process"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const CONFIG_ROOT = dirname(fileURLToPath(import.meta.url))
export const USAGE_CACHE_FILE = join(CONFIG_ROOT, "usage-cache.json")
export const USAGE_COLLECTOR = join(CONFIG_ROOT, "usage-collector.ts")
export const USAGE_STALE_MS = 30_000 // collect threshold; also STALE marker
export const USAGE_COLLECT_AWAIT_MS = 8_000 // usage_status await cap
const USAGE_COLLECT_DEBOUNCE_MS = 30_000 // skip extra spawn if one ran this recently
const USAGE_COLLECT_STATE_KEY = Symbol.for("opencode-config.usage.collect")

type UsageCollectState = { inflight: Promise<boolean> | undefined; lastStart: number }
function usageCollectState(): UsageCollectState {
  const g = globalThis as { [USAGE_COLLECT_STATE_KEY]?: UsageCollectState }
  if (!g[USAGE_COLLECT_STATE_KEY]) g[USAGE_COLLECT_STATE_KEY] = { inflight: undefined, lastStart: 0 }
  return g[USAGE_COLLECT_STATE_KEY]
}

const USAGE_SHORT: Record<string, string> = {
  "opencode-go": "go",
  opencode: "free",
  openai: "openai",
  cursor: "cursor",
  "grok-sub": "grok",
  xai: "xai",
}

export type UsageWindow = {
  label: string
  usedTokens: number
  used: number
  cap: number | null
  pct: number | null
  resetsInSeconds: number | null
  remaining?: number | null
  status?: string
  estimated?: boolean
  provenance?: "provider-observed" | "local-measured" | "predicted" | "unknown"
}

export type UsageSource = {
  id: string
  kind?: string
  source?: string
  windows?: UsageWindow[]
  probe?: string
  probeDetail?: string
  apiCapHit?: boolean
  apiCapDetail?: string
}

export type UsageCache = { updated: string; sources: UsageSource[] }

export type CapacityState = "available" | "exhausted" | "unknown"
export type CapacityEntry = { state: CapacityState; resetAt?: number; authenticated?: boolean }
export type CapacitySnapshot = { updated: string; stale: boolean; providers: Record<string, CapacityEntry> }

function readJson(path: string): unknown {
  if (!existsSync(path)) return
  try {
    return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""))
  } catch {
    return
  }
}

export function usageCache(): UsageCache | undefined {
  return readJson(USAGE_CACHE_FILE) as UsageCache | undefined
}

export function usageAgeMs(cache: UsageCache | undefined, now = Date.now()): number {
  if (!cache || typeof cache.updated !== "string") return Infinity
  const t = Date.parse(cache.updated)
  return Number.isFinite(t) ? now - t : Infinity
}

export function usageWindowResetAt(cache: UsageCache | undefined, win: UsageWindow | undefined): number | undefined {
  if (!cache || !win || typeof win.resetsInSeconds !== "number" || !Number.isFinite(win.resetsInSeconds)) return
  const collectedAt = Date.parse(cache.updated)
  if (!Number.isFinite(collectedAt)) return
  return collectedAt + Math.max(0, win.resetsInSeconds) * 1000
}

/** Quota/cap on a single usage window. Quota is not a model-quality failure. */
export function windowCapped(win: UsageWindow | undefined): boolean {
  if (!win) return false
  if (win.status === "rate-limited" || win.status === "cap") return true
  if (win.estimated) return false
  if (win.pct != null && win.pct >= 100) return true
  if (win.cap != null && win.used >= win.cap) return true
  return false
}

/**
 * One provider-capacity truth shared by picker and dispatch.
 * Reset timestamps never imply health: only an official observation can mark a
 * subscription available, while explicit cap evidence marks it exhausted.
 */
export function capacitySnapshot(cache: UsageCache | undefined, now = Date.now()): CapacitySnapshot {
  const stale = usageAgeMs(cache, now) >= 15 * 60_000
  const providers: Record<string, CapacityEntry> = {}
  for (const source of cache?.sources ?? []) {
    const cappedWindows = source.windows?.filter((win) => windowCapped(win) && (usageWindowResetAt(cache, win) ?? Infinity) > now) ?? []
    const hadExpiredCap = source.windows?.some((win) => windowCapped(win) && (usageWindowResetAt(cache, win) ?? Infinity) <= now) === true
    const capped = cappedWindows.length > 0 || Boolean(source.apiCapHit && !hadExpiredCap)
    const official = source.windows?.some((win) =>
      win.provenance === "provider-observed" &&
      (win.pct != null || win.status === "ok" || win.status === "cap" || win.status === "rate-limited"),
    ) === true
    const resetAt = cappedWindows
      .map((win) => usageWindowResetAt(cache, win))
      .filter((value): value is number => typeof value === "number")
      .sort((a, b) => a - b)[0]
    providers[source.id] = {
      state: stale || hadExpiredCap ? "unknown" : capped ? "exhausted" : source.probe === "ok" && official ? "available" : "unknown",
      ...(capped && resetAt != null ? { resetAt } : {}),
      authenticated: source.probe === "ok" ? true : source.probe === "err" ? false : undefined,
    }
  }
  return { updated: cache?.updated ?? "", stale, providers }
}

function runUsageCollector(timeoutMs = 30_000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(ok)
    }
    const attempt = (cmd: string): boolean => {
      try {
        const child = spawn(cmd, [USAGE_COLLECTOR], { windowsHide: true, stdio: "ignore" })
        child.once("exit", () => done(true))
        child.once("error", () => {
          if (cmd === "bun" && !settled) {
            const alt = join(homedir(), ".bun", "bin", "bun.exe")
            if (existsSync(alt)) attempt(alt)
            else done(false)
          } else {
            done(false)
          }
        })
        return true
      } catch {
        done(false)
        return false
      }
    }
    const timer = setTimeout(() => done(false), timeoutMs)
    attempt("bun")
  })
}

export function startUsageCollector(opts: { force?: boolean; timeoutMs?: number } = {}): Promise<boolean> {
  const st = usageCollectState()
  if (st.inflight) return st.inflight
  const now = Date.now()
  if (!opts.force && now - st.lastStart < USAGE_COLLECT_DEBOUNCE_MS) return Promise.resolve(true)
  st.lastStart = now
  const p = runUsageCollector(opts.timeoutMs ?? 30_000).finally(() => {
    if (st.inflight === p) st.inflight = undefined
  })
  st.inflight = p
  return p
}

/** Fire-and-forget background collect. Debounced. Never awaited by the context hook. */
export function kickUsageCollector() {
  void startUsageCollector({ force: false }).catch((error) => {
    console.warn("[usage] background usage collect failed", error)
  })
}

function awaitCollect(p: Promise<boolean>, capMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(ok)
    }
    const timer = setTimeout(() => done(false), capMs)
    p.then((ok) => done(ok), () => done(false))
  })
}

/** Re-collect when stale or forced, then re-read the cache. Await capped so usage_status cannot hang. */
export async function ensureUsageCache(force = false): Promise<{
  cache: UsageCache | undefined
  collectFailed: boolean
  stale: boolean
}> {
  const existing = usageCache()
  if (!force && usageAgeMs(existing) < USAGE_STALE_MS) {
    return { cache: existing, collectFailed: false, stale: false }
  }
  let collectFailed = false
  try {
    const ok = await awaitCollect(startUsageCollector({ force }), USAGE_COLLECT_AWAIT_MS)
    collectFailed = !ok
  } catch (error) {
    collectFailed = true
    console.warn("[usage] usage collector spawn failed", error)
  }
  const cache = usageCache() ?? existing
  return { cache, collectFailed, stale: usageAgeMs(cache) >= USAGE_STALE_MS }
}

function formatAgeMs(ms: number): string {
  if (!Number.isFinite(ms) || ms === Infinity) return "unknown"
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return rm ? `${h}h${rm}m` : `${h}h`
}

function humanizeSeconds(total: number): string {
  const s = Math.max(0, Number(total) || 0)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return h > 0 ? `${d}d${h}h` : `${d}d`
  if (h > 0) return m > 0 ? `${h}h${m}m` : `${h}h`
  if (m > 0) return `${m}m`
  return `${s}s`
}

/** TUI/cell missing marker. Never "n/a" — slash wraps into "n/" + leftover "a". */
const MISSING_CELL = "—"

/** Always two decimals. Never `$3.` truncated, never `n/a`. */
function fmtMoney(n: number): string {
  if (!Number.isFinite(n)) return MISSING_CELL
  return `$${n.toFixed(2)}`
}

/** $ only for real dollar caps (xai) or used>0 on a metered-looking source. Never Go/free $0.00. */
function shouldShowMoney(sourceId: string, kind: string | undefined, used: number, cap: number | null): boolean {
  return sourceId === "xai" && kind === "metered" && (used ?? 0) > 0
}

function padCell(value: string, width: number, align: "left" | "right"): string {
  const t = value.length > width ? value.slice(0, width) : value
  const space = " ".repeat(Math.max(0, width - t.length))
  return align === "right" ? space + t : t + space
}

const USAGE_TABLE_COL = { src: 6, win: 3, pct: 4, reset: 6 }

/** Compact one-line summary. Percent + reset first; $ only when it's real spend, never fake Go $12. */
export function usageSummaryLine(cache: UsageCache | undefined): string {
  const age = usageAgeMs(cache)
  const stale = age >= USAGE_STALE_MS
  const ageBit = `${formatAgeMs(age)}${stale ? " STALE" : ""}`
  if (!cache || !Array.isArray(cache.sources) || cache.sources.length === 0) {
    return `USAGE (${ageBit}) missing — /usage`
  }
  const parts: string[] = []
  for (const source of cache.sources) {
    const win5 = source.windows?.find((w) => w.label === "5h")
    const otherCaps = (source.windows ?? []).filter((w) => w.label !== "5h" && windowCapped(w))
    const short = USAGE_SHORT[source.id] ?? source.id
    const show5h = Boolean(win5 && (win5.used > 0 || win5.pct != null || win5.cap != null || windowCapped(win5)))
    if (show5h && win5) {
      const bits = [`${short} 5h`]
      if (win5.pct != null) bits.push(`${Math.round(win5.pct)}%`)
      if (windowCapped(win5)) bits.push("CAP")
      if (win5.resetsInSeconds != null) bits.push(humanizeSeconds(win5.resetsInSeconds))
      if (shouldShowMoney(source.id, source.kind, win5.used, win5.cap)) bits.push(fmtMoney(win5.used))
      let part = bits.join(" ")
      if (otherCaps.length) {
        part += ` ${otherCaps.map((w) => `${w.label} CAP${w.pct != null ? ` ${w.pct}%` : ""}`).join(" ")}`
      }
      parts.push(part)
    } else if (otherCaps.length) {
      parts.push(`${short} ${otherCaps.map((w) => `${w.label} CAP${w.pct != null ? ` ${w.pct}%` : ""}`).join(" ")}`)
    }
  }
  const body = parts.length ? parts.slice(0, 4).join(" · ") : "no 5h windows"
  const line = `USAGE (${ageBit}) ${body} — /usage`
  return line.length <= 220 ? line : `${line.slice(0, 217)}...`
}

/**
 * Agent-facing quota feed. Unlike usageSummaryLine (which intentionally omits
 * quiet/empty sources to keep /usage compact), this always names every source
 * in the cache so model selection cannot mistake missing output for available
 * quota. The context hook reads the JSON file on every turn; a stale marker is
 * retained rather than silently presenting old data as current.
 */
export function quotaSummaryLine(cache: UsageCache | undefined): string {
  const age = usageAgeMs(cache)
  const ageBit = !Number.isFinite(age) || age === Infinity
    ? "unknown STALE"
    : `${formatAgeMs(age)}${age >= USAGE_STALE_MS ? " STALE" : ""}`
  if (!cache || !Array.isArray(cache.sources) || cache.sources.length === 0) {
    return `QUOTA: unavailable (${ageBit}) — do not dispatch opencode-go/* until usage is known`
  }

  const parts = cache.sources.flatMap((source) => {
    const windows = source.windows ?? []
    const live = windows.some((w) => w.provenance === "provider-observed" || w.pct != null || windowCapped(w)) || Boolean(source.apiCapHit) || source.probe === "ok"
    if (!live) return []
    const win = windows.find((candidate) => windowCapped(candidate)) ??
      windows.find((candidate) => candidate.provenance === "provider-observed") ??
      windows.find((candidate) => candidate.label === "5h") ??
      windows.find((candidate) => candidate.pct != null || candidate.status) ??
      windows[0]
    const short = USAGE_SHORT[source.id] ?? source.id
    if (!win) {
      const probe = source.probe === "ok" ? "ok" : source.probe === "cap" ? "CAP" : "unknown"
      return [`${short} ${probe}`]
    }
    const used = win.pct == null ? null : Math.round(win.pct)
    const left = win.remaining != null && Number.isFinite(win.remaining)
      ? Math.round(win.remaining)
      : used != null ? Math.max(0, 100 - used) : null
    const pct = used == null ? "?" : `${win.estimated ? "~" : ""}${used}%`
    const leftBit = left == null ? "" : ` ${left}% left`
    const state = windowCapped(win)
      ? "CAP"
      : win.status === "ok" || (win.status == null && used != null && used < 100)
        ? "ok"
        : win.status ?? "unknown"
    return [`${short} ${win.label || "?"} ${pct}${leftBit} ${state}`]
  })
  if (!parts.length) {
    return `QUOTA: unavailable (${ageBit}) — do not dispatch opencode-go/* until usage is known`
  }
  const goBlocked = cache.sources.some((source) => source.id === "opencode-go" &&
    (source.apiCapHit || (source.windows ?? []).some((win) => windowCapped(win))))
  const instruction = goBlocked ? " — do not dispatch opencode-go/*" : ""
  const line = `QUOTA: ${parts.join(" | ")} (${ageBit})${instruction}`
  return line.length <= 300 ? line : `${line.slice(0, 297)}...`
}

/** Compact aligned table for usage_status. src win pct reset first; $ trailing; never n/a, usedTokens, or probe. */
export function formatUsageTable(cache: UsageCache | undefined, extra?: { collectFailed?: boolean }): string {
  if (!cache) {
    return extra?.collectFailed ? "No usage data. Collect failed or timed out." : "No usage data."
  }
  const age = usageAgeMs(cache)
  const stale = age >= USAGE_STALE_MS
  const lines: string[] = []
  lines.push(
    `Subscription usage  ${cache.updated}  ${formatAgeMs(age)}${stale ? " STALE" : ""}`,
  )
  if (extra?.collectFailed) lines.push("Collect failed or timed out; showing last file.")
  lines.push(
    [
      padCell("src", USAGE_TABLE_COL.src, "left"),
      padCell("win", USAGE_TABLE_COL.win, "left"),
      padCell("pct", USAGE_TABLE_COL.pct, "right"),
      padCell("reset", USAGE_TABLE_COL.reset, "right"),
    ].join(" "),
  )
  for (const source of cache.sources) {
    const src = (USAGE_SHORT[source.id] ?? source.id).slice(0, USAGE_TABLE_COL.src)
    for (const w of source.windows ?? []) {
      const cells = [
        padCell(src, USAGE_TABLE_COL.src, "left"),
        padCell(w.label || MISSING_CELL, USAGE_TABLE_COL.win, "left"),
        padCell(w.pct == null ? MISSING_CELL : `${Math.round(w.pct)}%`, USAGE_TABLE_COL.pct, "right"),
        padCell(w.resetsInSeconds == null ? MISSING_CELL : humanizeSeconds(w.resetsInSeconds), USAGE_TABLE_COL.reset, "right"),
      ]
      if (shouldShowMoney(source.id, source.kind, w.used ?? 0, w.cap ?? null)) {
        cells.push(fmtMoney(w.used))
      }
      lines.push(cells.join(" "))
    }
  }
  return lines.join("\n")
}
