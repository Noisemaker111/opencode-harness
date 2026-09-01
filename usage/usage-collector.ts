// Subscription usage collector for Jk's model subscriptions.
//
//   SOURCE A (backbone, always): local OpenCode DB (read-only) per-message usage.
//     - message + session_message tables carry JSON `data` with per-message
//       { providerID/modelID, tokens:{input,output,reasoning,cache}, cost }
//       and a ms epoch timestamp. Rows are deduped by message id (the two
//       tables overlap for some older sessions).
//   SOURCE B (best-effort probes): local proxies and provider APIs
//     - http://127.0.0.1:3011 (grok-sub SuperGrok proxy; /usage + /ping)
//       NOTE: upstream cli-chat-proxy.grok.com answers /usage with a 404 whose
//       body is invalid gzip, so Bun's fetch throws ZlibError on it. The probe
//       catch handles this (proxy classified alive via /ping, no usage data).
//     - http://localhost:3000 (cursor-openai-api proxy; /usage, /v1/usage, /usage/status)
//     - ChatGPT WHAM usage (OpenAI OAuth) and Cursor public usage API are
//       fallbacks when the local proxies are stopped. WHAM's rate_limit windows
//       are authoritative subscription percentages; no local dollar estimate is
//       substituted when WHAM is unavailable. Provider failures are
//       isolated: one dead endpoint never discards DB usage or other probes.
//   SOURCE C: OpenCode Go usage API (auth.json opencode-go key)
//     GET https://opencode.ai/zen/go/v1/usage
//     rolling/weekly/monthly { percent, status, resetsAt }. status "rate-limited"
//     is the real 5h cap (TUI orange "5-hour usage limit reached") — the local
//     $12/5h mapping is NOT what 402s. If the API is unreachable, a DB heuristic
//     treats recent "5-hour usage limit reached" / opencode-go 402 as cap-hit.
//
//   $ mapping: per-message input tokens x costInput + (output+reasoning) x
//   costOutput from models-cache.json (exact provider/model key, grok-sub
//   falls back to the xai/ list price of the same model, then id/suffix
//   match, then 0). The OpenCode DB's own per-message `cost` is ALSO summed
//   and reported as dbCost for comparison.
//
//   Windows are rolling: 5h, 7d (current week), 30d (current month).
//   resetsInSeconds is ALWAYS populated for known window lengths:
//     1. server resetsAt / probe reset timestamp
//     2. rolling drain (oldest counted message ages out)
//     3. full window length when the bucket is empty (fresh window, never "—")
//   Percent is the truth for quota products (OpenCode Go API percent /
//   rate-limited). Local $12/$30/$60 is stored as cap for whoever wants it
//   but MUST NOT be Math.round'd into a fake 0% when used is a few cents.
//
//   CLI: bun usage-collector.ts [--dry] [--json]
//   --dry = print without writing usage-cache.json
//   --json = print the raw cache JSON instead of the human table

import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const DB_PATH = join(homedir(), ".local", "share", "opencode", "opencode.db")
const AUTH_FILE = join(homedir(), ".local", "share", "opencode", "auth.json")
const CODEX_AUTH_FILE = join(homedir(), ".codex", "auth.json")
const CACHE_FILE = join(HERE, "usage-cache.json")
const PLANS_FILE = join(HERE, "usage-plans.json")
const MODELS_CACHE_FILE = join(dirname(HERE), "models", "models-cache.json")
const GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage"
const GO_API_WINDOW: Record<string, string> = { rolling: "5h", weekly: "7d", monthly: "30d" }

const WINDOWS = [
  { label: "5h", ms: 5 * 3600_000 },
  { label: "7d", ms: 7 * 86400_000 },
  { label: "30d", ms: 30 * 86400_000 },
]

/** The cache deliberately keeps official observations separate from local measurements and forecasts. */
export type TelemetryProvenance = "provider-observed" | "local-measured" | "predicted" | "unknown"
export type UsageConfidence = "high" | "medium" | "low"
export type UsageForecast = {
  state: "unlikely" | "at-risk" | "likely" | "unknown"
  confidence: UsageConfidence
  horizonSeconds: number | null
  assumesResetAt: string | null
  basis: "provider-rate" | "local-rate" | "insufficient-data"
}
export type UsageCache = { updated: string; cacheAgeSeconds?: number | null; maxAgeSeconds?: number; sources: any[] }

const MAX_CACHE_AGE_SECONDS = 15 * 60
const inFlight = new Map<string, Promise<unknown>>()

/** Coalesce concurrent refreshes in this process; callers receive the same result. */
export function singleFlight<T>(key: string, task: () => Promise<T>): Promise<T> {
  const current = inFlight.get(key) as Promise<T> | undefined
  if (current) return current
  const pending = Promise.resolve().then(task)
  inFlight.set(key, pending)
  pending.finally(() => { if (inFlight.get(key) === pending) inFlight.delete(key) }).catch(() => {})
  return pending
}

/** Replace the cache in one rename so readers never observe a partial JSON document. */
export function writeJsonAtomic(path: string, value: unknown): void {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temp, JSON.stringify(value, null, 2), { encoding: "utf8", flag: "wx" })
  try { renameSync(temp, path) } catch (error) { try { unlinkSync(temp) } catch {} ; throw error }
}

export function readUsageCache(path: string, now = Date.now(), maxAgeSeconds = MAX_CACHE_AGE_SECONDS): (UsageCache & { stale: boolean }) | undefined {
  const cache = readJsonOr(path, undefined)
  if (!cache || typeof cache !== "object" || typeof cache.updated !== "string" || !Array.isArray(cache.sources)) return undefined
  const updated = Date.parse(cache.updated)
  const skewed = !Number.isFinite(updated) || updated > now + 60_000
  const age = skewed ? null : Math.max(0, Math.round((now - updated) / 1000))
  return { ...cache, cacheAgeSeconds: age, maxAgeSeconds, stale: skewed || age! > maxAgeSeconds }
}

export function predictWindowExhaustion(opts: {
  used: number
  pct?: number | null
  observedAt?: number
  now: number
  resetAt?: number | null
  windowMs: number
  priorUsed?: number
  priorAt?: number
}): UsageForecast {
  const resetAt = Number.isFinite(opts.resetAt) ? new Date(Number(opts.resetAt)).toISOString() : null
  const remaining = opts.pct != null && Number.isFinite(opts.pct) ? Math.max(0, 100 - opts.pct) : null
  const elapsed = opts.priorAt != null ? opts.now - opts.priorAt : opts.observedAt != null ? opts.now - opts.observedAt : 0
  const delta = opts.priorUsed != null ? opts.used - opts.priorUsed : opts.used
  if (!(elapsed > 0) || !(delta > 0) || remaining == null) {
    return { state: "unknown", confidence: "low", horizonSeconds: null, assumesResetAt: resetAt, basis: "insufficient-data" }
  }
  const rate = delta / elapsed
  const toExhaustion = (remaining / 100 * Math.max(opts.used, 1)) / rate
  const horizonSeconds = Math.max(0, Math.round(toExhaustion / 1000))
  const state = horizonSeconds <= 3600 ? "likely" : horizonSeconds <= Math.max(3600, (opts.resetAt ?? opts.now + opts.windowMs) - opts.now) / 1000 ? "at-risk" : "unlikely"
  return { state, confidence: opts.priorAt != null ? "medium" : "low", horizonSeconds, assumesResetAt: resetAt, basis: "local-rate" }
}

// DB providerID -> canonical source id. Also maps the cursor-acp alias.
const PROVIDER_TO_SOURCE: Record<string, string> = {
  "opencode-go": "opencode-go",
  opencode: "opencode",
  openai: "openai",
  cursor: "cursor",
  "cursor-acp": "cursor",
  "grok-sub": "grok-sub",
  xai: "xai",
  anthropic: "claude",
  claude: "claude",
  "claude-code": "claude-code",
  "grok-build": "grok-build",
  codex: "codex",
  openrouter: "openrouter",
}

const KIND: Record<string, string> = {
  "opencode-go": "sub", // Go quota subscription
  opencode: "sub", // OpenCode free/Pro lane of the subscription
  openai: "sub", // OpenAI/ChatGPT subscription (Luna/Sol ride it)
  cursor: "sub", // Cursor subscription
  "grok-sub": "sub", // SuperGrok subscription via local proxy
  xai: "metered", // x.ai API per-token
  claude: "sub", // Claude Code capacity is unknown unless officially reported
  "claude-code": "sub", // official Claude CLI subscription via the local bridge
  "grok-build": "sub", // official Grok CLI subscription via the local bridge
  codex: "sub", // official Codex CLI subscription via the local bridge
  openrouter: "metered",
}

// These providers are configured local lanes even when they have no recent DB
// row yet. Keeping a shell entry makes /usage honest about what can be picked:
// unknown is visibly different from an absent provider.
const CONFIGURED_SOURCES = ["claude-code", "grok-build", "codex", "openrouter"]

type ProbeSpec = { source: string; urls: string[]; headers?: Record<string, string> }

function bearer(value: unknown): Record<string, string> | undefined {
  return typeof value === "string" && value.length > 0 ? { Authorization: `Bearer ${value}`, Accept: "application/json" } : undefined
}

async function refreshOpenAiAccess(auth: any): Promise<string | undefined> {
  const refreshToken = auth?.refresh ?? auth?.refresh_token
  const accessToken = auth?.access ?? auth?.access_token
  if (!refreshToken) return undefined
  const expires = Number(auth.expires)
  let jwtExpires: number | undefined
  if (typeof accessToken === "string") {
    try {
      const payload = JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString())
      if (Number.isFinite(Number(payload.exp))) jwtExpires = Number(payload.exp) * 1000
    } catch {}
  }
  if (typeof accessToken === "string" && (!Number.isFinite(expires) || expires > Date.now() + 30_000) &&
      (jwtExpires == null || jwtExpires > Date.now() + 30_000)) return accessToken
  // The OAuth client id is also present in the access JWT. Keeping this
  // derived avoids putting a credential/client secret in the config.
  let clientId = "app_EMoamEEZ73f0CkXaXp7hrann"
  try {
    const payload = JSON.parse(Buffer.from(String(accessToken).split(".")[1] ?? "", "base64url").toString())
    if (typeof payload.client_id === "string") clientId = payload.client_id
  } catch {}
  try {
    const res = await fetch("https://auth.openai.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }),
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) return undefined
    const token = await res.json() as any
    if (typeof token.access_token !== "string") return undefined
    const all = readJsonOr(AUTH_FILE, {})
    all.openai = {
      ...auth,
      access: token.access_token,
      ...(typeof token.refresh_token === "string" ? { refresh: token.refresh_token } : {}),
      expires: Date.now() + Number(token.expires_in ?? 3600) * 1000,
    }
    try { writeFileSync(AUTH_FILE, JSON.stringify(all, null, 2)) } catch {}
    return token.access_token
  } catch {
    return undefined
  }
}

async function providerProbeHeaders(source: string, url: string): Promise<Record<string, string> | undefined> {
  // Never send provider credentials to a local proxy. Local endpoints are
  // probes only; credentials are scoped to the provider's HTTPS origin.
  let origin: string
  try { origin = new URL(url).origin } catch { return undefined }
  if (source === "openai") {
    if (origin !== "https://chatgpt.com" && origin !== "https://chat.openai.com") return undefined
    const opencode = readJsonOr(AUTH_FILE, {})?.openai
    const codexAuth = readJsonOr(CODEX_AUTH_FILE, {})
    const codex = codexAuth?.tokens
    // WHAM is a ChatGPT subscription endpoint. OpenCode's OpenAI OAuth token
    // can be valid for model calls and still receive 401 here; Codex's ChatGPT
    // account token is the authoritative credential when present.
    const codexAccountId = codex?.account_id ?? codexAuth?.account_id
    const auth = codex?.access_token && codexAccountId ? codex : opencode
    const headers = bearer(auth === codex ? codex.access_token : await refreshOpenAiAccess(opencode) ?? opencode?.access ?? opencode?.access_token)
    // WHAM rejects an otherwise valid OAuth bearer unless the ChatGPT account
    // is supplied separately (the account id is intentionally not in the URL).
    const accountId = auth === codex ? codexAccountId : auth?.accountId ?? auth?.account_id
    if (headers && typeof accountId === "string" && accountId) {
      headers["ChatGPT-Account-Id"] = accountId
      headers.Origin = "https://chatgpt.com"
      headers.Referer = "https://chatgpt.com/"
      headers["User-Agent"] = "Mozilla/5.0"
    }
    return headers
  }
  if (source === "cursor") {
    if (origin !== "https://api.cursor.com") return undefined
    return bearer(process.env.CURSOR_API_KEY)
  }
  return undefined
}

const PROBES: ProbeSpec[] = [
  { source: "grok-sub", urls: ["http://127.0.0.1:3011/usage", "http://127.0.0.1:3011/ping"] },
  {
    source: "cursor",
    urls: [
      "http://localhost:3000/usage",
      "http://localhost:3000/v1/usage",
      "http://localhost:3000/usage/status",
      "https://api.cursor.com/v0/usage",
    ],
  },
  {
    source: "openai",
    urls: ["https://chatgpt.com/backend-api/wham/usage", "https://chat.openai.com/backend-api/wham/usage"],
  },
]

type TokenBucket = { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
type Msg = { id: string; ts: number; providerID: string; modelID: string; tokens: TokenBucket; dbCost: number }
type ModelAgg = {
  providerID: string
  modelID: string
  messages: number
  tokens: TokenBucket
  cost: number
  dbCost: number
  priceSource: string
}
type WinAgg = {
  usedTokens: number
  used: number
  dbCost: number
  oldestTs: number
  capOverride?: unknown
  pctOverride?: number | null
  resetFromProbe?: number
  statusOverride?: string
  remainingOverride?: number | null
  observedAt?: number
  priorUsed?: number
  priorAt?: number
}
type SourceAgg = {
  id: string
  kind: string
  windows: { windows: Record<string, WinAgg>; models: Map<string, ModelAgg> }
}

const notes: string[] = []

function log(msg: string) {
  notes.push(msg)
}

// ---------- tiny helpers ----------

function readJsonOr(path: string, fallback: unknown): any {
  try {
    if (!existsSync(path)) return fallback
    return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""))
  } catch {
    return fallback
  }
}

function round2(n: number) {
  const x = Math.round(Number(n) * 100) / 100
  return Number.isFinite(x) ? x : 0
}

/** TUI/cell missing marker. Never "n/a" — the slash wraps ("n/" + leftover "a"). */
export const MISSING_CELL = "—"

/** Probe tokens written to cache / shown in cells. Never sentences. */
export type ShortProbe = "ok" | "cap" | "none" | "stale" | "err"

export function finiteOrNull(v: unknown): number | null {
  if (v == null || v === "") return null
  if (typeof v === "string" && /^(n\/a|n\/|a|unknown|none|null|--?|\u2014)$/i.test(v.trim())) return null
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

/** Always two decimals. Never `$3.` truncated, never `n/a`. */
export function fmtMoney(n: number): string {
  if (!Number.isFinite(n)) return MISSING_CELL
  return `$${n.toFixed(2)}`
}

export function shortProbe(status: string | undefined, opts?: { capHit?: boolean }): ShortProbe {
  if (opts?.capHit) return "cap"
  if (status === "ok") return "ok"
  if (status === "cap") return "cap"
  if (status === "stale") return "stale"
  if (status === "error" || status === "err") return "err"
  return "none"
}

function fmtTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function humanizeSeconds(total: number) {
  const s = Math.max(0, Math.floor(total))
  if (!Number.isFinite(s)) return MISSING_CELL
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return h > 0 ? `${d}d${h}h` : `${d}d`
  if (h > 0) return m > 0 ? `${h}h${m}m` : `${h}h`
  if (m > 0) return `${m}m`
  return `${s}s`
}

/** Quota products (Go, OpenCode free): percent comes from the provider, never local $ mapping. */
export function derivePctFromCap(sourceId: string): boolean {
  // Subscription dollars are not a quota denominator. Only metered xAI plans
  // may derive a percentage from a configured local spend cap.
  return sourceId === "xai"
}

/**
 * Clamp a percent to 0..100.
 * When `nonzero` and the raw value is in (0, 0.5), return 1 so a few cents against
 * a $12 cap cannot Math.round into a fake 0%. API 0 stays 0 (do not pass nonzero).
 */
export function clampPct(n: number, opts?: { nonzero?: boolean }): number {
  if (!Number.isFinite(n)) return 0
  const x = Math.min(100, Math.max(0, n))
  const rounded = Math.round(x)
  if (opts?.nonzero && rounded === 0 && x > 0) return 1
  return rounded
}

/** Percent for a window. API/status first; $ used/cap only when deriveFromCap. */
export function computeWindowPct(opts: {
  pctOverride?: number | null
  status?: string
  used: number
  cap: number | null
  deriveFromCap: boolean
}): number | null {
  const api = finiteOrNull(opts.pctOverride)
  if (api != null) return clampPct(api)
  if (opts.status === "rate-limited" || opts.status === "cap") return 100
  if (opts.deriveFromCap && opts.cap != null && opts.cap > 0) {
    return clampPct((opts.used / opts.cap) * 100, { nonzero: opts.used > 0 })
  }
  return null
}

/**
 * Seconds until this window resets. Never null for a known window length.
 * Probe/API timestamp wins; else rolling drain from oldest usage; else a fresh full window.
 */
export function computeWindowReset(opts: {
  windowMs: number
  now: number
  resetFromProbe?: number | null
  oldestTs?: number
  hasUsage?: boolean
}): number {
  const probe = finiteOrNull(opts.resetFromProbe)
  if (probe != null) return Math.max(0, Math.round(probe))
  if (opts.hasUsage && opts.oldestTs != null && Number.isFinite(opts.oldestTs)) {
    return Math.max(0, Math.round((opts.windowMs - (opts.now - opts.oldestTs)) / 1000))
  }
  return Math.max(0, Math.round(opts.windowMs / 1000))
}

/** Subscription usage is not spend; only xai's metered dollar usage belongs in cells. */
export function shouldShowMoney(sourceId: string, kind: string | undefined, used: number, cap: number | null): boolean {
  return sourceId === "xai" && kind === "metered" && (used ?? 0) > 0
}

export function finalizeWindow(
  label: string,
  windowMs: number,
  win: Partial<WinAgg> | undefined,
  opts: { now: number; planCap: unknown; sourceId: string; estimated?: boolean },
) {
  const used = round2(win?.used ?? 0)
  const rawCap = win?.capOverride != null ? win.capOverride : opts.planCap
  const capNum = finiteOrNull(rawCap)
  const status = typeof win?.statusOverride === "string" ? win.statusOverride : undefined
  const pct = computeWindowPct({
    pctOverride: finiteOrNull(win?.pctOverride),
    status,
    used,
    cap: capNum,
    deriveFromCap: derivePctFromCap(opts.sourceId),
  })
  const hasUsage = (Number(win?.usedTokens) || 0) > 0 || used > 0
  const resets = computeWindowReset({
    windowMs,
    now: opts.now,
    resetFromProbe: finiteOrNull(win?.resetFromProbe),
    oldestTs: win?.oldestTs,
    hasUsage,
  })
  const measured = hasUsage ? { used, usedTokens: Math.max(0, Math.round(Number(win?.usedTokens) || 0)), provenance: "local-measured" as TelemetryProvenance } : undefined
  const official = finiteOrNull(win?.pctOverride) != null || status === "rate-limited" || status === "cap"
    ? { pct: pct, status: status ?? "ok", provenance: "provider-observed" as TelemetryProvenance }
    : undefined
  const resetAt = opts.now + resets * 1000
  const prediction = predictWindowExhaustion({
    used,
    pct,
    observedAt: win?.observedAt,
    now: opts.now,
    resetAt,
    windowMs,
    priorUsed: win?.priorUsed,
    priorAt: win?.priorAt,
  })
  return {
    label,
    usedTokens: Math.max(0, Math.round(Number(win?.usedTokens) || 0)),
    used,
    cap: capNum,
    pct,
    remaining: finiteOrNull(win?.remainingOverride),
    // A percentage derived from the local dollar cap is always an estimate;
    // provider/API percentages and explicit cap statuses are authoritative.
    estimated: Boolean(derivePctFromCap(opts.sourceId) && pct != null && finiteOrNull(win?.pctOverride) == null && status !== "rate-limited" && status !== "cap"),
    resetsInSeconds: resets,
    status,
    provenance: official?.provenance ?? measured?.provenance ?? "unknown",
    observed: official ?? measured ?? null,
    prediction,
  }
}

function padCell(value: string, width: number, align: "left" | "right"): string {
  const t = value.length > width ? value.slice(0, width) : value
  const space = " ".repeat(Math.max(0, width - t.length))
  return align === "right" ? space + t : t + space
}

// ---------- Source A: local OpenCode DB ----------

async function openDb(path: string): Promise<any | undefined> {
  try {
    const { Database } = await import("bun:sqlite")
    const db = new Database(path, { readonly: true, strict: false })
    // tiny verification query per spec (inside the same try/catch)
    const probe = db.query("SELECT count(*) AS n FROM sqlite_master").get() as { n: number } | undefined
    log(
      `db: opened ${path} readonly (bun:sqlite verified, ${probe ? `${probe.n} objects in sqlite_master` : "unverified"})`,
    )
    return db
  } catch (error) {
    log(`db: bun:sqlite unavailable or open failed: ${String(error)}`)
    return undefined
  }
}

function inspectSchema(db: any) {
  try {
    const tables = db.query("SELECT name, sql FROM sqlite_master WHERE type='table'").all() as { name: string; sql: string }[]
    const interesting = tables.filter((t) =>
      /message|part|usage|session/i.test(t.name) || /token|cost|usage/i.test(t.sql ?? ""),
    )
    log(`db schema: ${tables.length} tables; usage-carrying candidates: ${interesting.map((t) => t.name).join(", ")}`)
    for (const t of interesting) log(`  ${t.name}: ${(t.sql ?? "").replace(/\s+/g, " ").slice(0, 180)}`)
    // Decision: per-message usage lives in JSON `data` of message/session_message
    // (role/type + providerID/modelID + tokens + cost + time.created). Per-session
    // aggregates (session_v2.tokens_*/cost/model) exist but lack per-message time
    // precision, so messages are the primary source.
    return tables
  } catch (error) {
    log(`db schema inspect failed: ${String(error)}`)
    return []
  }
}

function parseTokens(t: any): TokenBucket | undefined {
  if (!t || typeof t !== "object") return undefined
  const input = Number(t.input)
  if (!Number.isFinite(input)) return undefined
  return {
    input,
    output: Number(t.output) || 0,
    reasoning: Number(t.reasoning) || 0,
    cacheRead: Number(t.cache?.read) || 0,
    cacheWrite: Number(t.cache?.write) || 0,
  }
}

/** Collect per-message usage rows from message + session_message, deduped by id. */
function collectMessages(db: any, since: number): Msg[] {
  const byId = new Map<string, Msg>()
  for (const table of ["message", "session_message"]) {
    try {
      const rows = db.query(`SELECT id, time_created, data FROM ${table} WHERE time_created > ?`).all(since) as {
        id: string
        time_created: number
        data: string
      }[]
      log(`db: ${table}: ${rows.length} rows in window`)
      for (const row of rows) {
        if (byId.has(row.id)) continue // dedupe overlapping tables
        try {
          const d = JSON.parse(row.data)
          const providerID = d.providerID ?? d.model?.providerID
          const modelID = d.modelID ?? d.model?.id
          const tokens = parseTokens(d.tokens)
          if (!providerID || !modelID || !tokens) continue
          if (!PROVIDER_TO_SOURCE[String(providerID)]) continue
          const ts = Number(d.time?.created) || Number(row.time_created)
          byId.set(row.id, {
            id: row.id,
            ts,
            providerID: String(providerID),
            modelID: String(modelID),
            tokens,
            dbCost: typeof d.cost === "number" && Number.isFinite(d.cost) ? d.cost : 0,
          })
        } catch {}
      }
    } catch (error) {
      log(`db: ${table} scan failed: ${String(error)}`)
    }
  }
  return [...byId.values()]
}

// ---------- cost lookup (models-cache.json) ----------

function loadCostIndex() {
  const cache = readJsonOr(MODELS_CACHE_FILE, { models: [] })
  const models = Array.isArray(cache.models) ? cache.models : []
  const byKey = new Map<string, any>()
  const byId = new Map<string, any>()
  for (const m of models) {
    if (!m || typeof m.key !== "string") continue
    byKey.set(m.key.toLowerCase(), m)
    if (typeof m.id === "string" && !byId.has(m.id.toLowerCase())) byId.set(m.id.toLowerCase(), m)
  }
  return { models, byKey, byId }
}

/**
 * Look up {costInput, costOutput, source} for (providerID, modelID).
 * 1. exact  provider/model key
 * 2. grok-sub -> xai/<model> (same model's list price; SuperGrok is a subscription)
 * 3. exact model id
 * 4. suffix match on key (openai/gpt-5.5 matches cursor/gpt-5.5 usage, etc.)
 * 5. fallback 0
 */
function makeCostLookup(index: { models: any[]; byKey: Map<string, any>; byId: Map<string, any> }) {
  return (providerID: string, modelID: string) => {
    const key = `${providerID}/${modelID}`.toLowerCase()
    let entry = index.byKey.get(key)
    let source = key
    if (!entry && providerID.toLowerCase() === "grok-sub") {
      entry = index.byKey.get(`xai/${modelID}`.toLowerCase())
      if (entry) source = `xai/${modelID}`.toLowerCase() // documented cross-provider fallback
    }
    if (!entry) {
      entry = index.byId.get(modelID.toLowerCase())
      if (entry) source = String(entry.key ?? entry.id)
    }
    if (!entry) {
      const suffix = `/${modelID.toLowerCase()}`
      for (const m of index.models) {
        if (String(m.key).toLowerCase().endsWith(suffix)) {
          entry = m
          source = String(m.key)
          break
        }
      }
    }
    if (!entry) return { input: 0, output: 0, source: "unknown (fallback 0)" }
    return { input: Number(entry.costInput) || 0, output: Number(entry.costOutput) || 0, source }
  }
}

// ---------- Source B: probes ----------

type ProbeResult = { source: string; status: "ok" | "no endpoint" | "error"; detail: string; usage?: any }

async function fetchProbe(
  url: string,
  timeoutMs = 5_000,
  headers?: Record<string, string>,
): Promise<{ ok: boolean; status?: number; body?: string; error?: string }> {
  let res: Response | undefined
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers })
    const body = await res.text()
    return { ok: res.ok, status: res.status, body: body.slice(0, 4096) }
  } catch (error) {
    // Bun can throw while decompressing a response body (notably the known
    // Grok 404). Preserve the HTTP status so it is not confused with an
    // unexpected usage endpoint failure.
    return { ok: false, status: res?.status, error: String(error).slice(0, 160) }
  }
}

function parseProbeUsage(body: string): any | undefined {
  try {
    const j = JSON.parse(body)
    const find = (value: any, depth = 0): any | undefined => {
      if (!value || typeof value !== "object" || depth > 5) return undefined
      if (!Array.isArray(value)) {
        const hasUsage = value.usage != null || value.limit != null || value.used != null || value.remaining != null || value.quota != null ||
          value.percent != null || value.percentUsed != null || value.usagePercent != null || value.usedPercent != null
        if (hasUsage) {
          // Several compatible proxies wrap the actual payload in `usage`.
          // Returning the wrapper made mergeProbeIntoSource miss its windows
          // and fall back to a blank 5h row.
          const nested = value.usage && typeof value.usage === "object" && !Array.isArray(value.usage) ? value.usage : undefined
          const out = { ...(nested ?? value) }
          if (out.percent == null) out.percent = out.percentUsed ?? out.usagePercent ?? out.usedPercent
          return out
        }
        for (const child of Object.values(value)) {
          const found = find(child, depth + 1)
          if (found) return found
        }
      } else {
        for (const child of value) {
          const found = find(child, depth + 1)
          if (found) return found
        }
      }
      return undefined
    }
    return find(j)
  } catch {
    return undefined
  }
}

/** Parse ChatGPT's exact subscription quota response from the undocumented WHAM API. */
export function parseOpenAiWhamUsage(body: string): any | undefined {
  try {
    const root = JSON.parse(body)
    const limits = root?.rate_limit ?? root?.rate_limits
    if (!limits || typeof limits !== "object") return undefined
    const windows: Record<string, any> = {}
    const candidates = [
      limits.primary_window,
      limits.secondary_window,
      ...(Array.isArray(limits.windows) ? limits.windows : []),
    ]
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== "object") continue
      const duration = finiteOrNull(candidate.limit_window_seconds ?? candidate.window_seconds ?? candidate.windowSeconds)
      const label = duration == null ? undefined : duration <= 6 * 3600 ? "5h" : duration <= 10 * 86400 ? "7d" : "30d"
      if (!label) continue
      const used = finiteOrNull(candidate.used_percent ?? candidate.usedPercent ?? candidate.percent_used)
      const left = finiteOrNull(candidate.percent_left ?? candidate.remaining_percent ?? candidate.remainingPercent)
      windows[label] = {
        percent: left != null ? 100 - left : used,
        remaining: left ?? (used != null ? 100 - used : undefined),
        reset: resetSecondsFrom(candidate),
        status: limits.limit_reached === true || candidate.limit_reached === true ? "cap" : "ok",
      }
    }
    return Object.keys(windows).length ? { windows, planType: root.plan_type } : undefined
  } catch {
    return undefined
  }
}

function resetSecondsFrom(j: any): number | undefined {
  const raw = j.reset ?? j.resetsInSeconds ?? j.resetAfterSeconds ?? j.reset_after_seconds ?? j.resetAt ?? j.reset_at ?? j.resetsAt ?? j.resets_at
  if (raw == null) return undefined
  if (typeof raw === "object") {
    return resetSecondsFrom(raw)
  }
  if (typeof raw === "number") {
    // WHAM returns reset_at as an epoch (seconds); other probes commonly
    // return a duration. Keep accepting epoch milliseconds as well.
    if (raw > 1e12) return Math.max(0, Math.round(raw / 1000 - Date.now() / 1000))
    if (raw > 1e9) return Math.max(0, Math.round(raw - Date.now() / 1000))
    return Math.max(0, Math.round(raw))
  }
  if (typeof raw === "string") {
    const t = Date.parse(raw)
    if (Number.isFinite(t)) return Math.max(0, Math.round(t / 1000 - Date.now() / 1000))
    // iso-duration-ish strings stay unknown
  }
  return undefined
}

async function runProbes(): Promise<ProbeResult[]> {
  return Promise.all(
    PROBES.map(async (p) => {
      // Probe endpoints concurrently. A sequential 4 x 5s Cursor fallback
      // used to outlive the TUI's 8s collector wait and leave /usage showing
      // stale or empty data even when a later endpoint was reachable.
      const results = await Promise.all(p.urls.map(async (url) => {
        try {
          return await fetchProbe(url, 5_000, p.headers ?? await providerProbeHeaders(p.source, url))
        } catch (error) {
          return { ok: false, error: String(error).slice(0, 120) }
        }
      }))
      const alive = results.some((r, i) => r.ok && /\/ping(?:[/?#]|$)/i.test(p.urls[i]))
      const anyReply = results.some((r) => r.status != null)
      const usageFailure = results.find((r, i) => !/\/ping(?:[/?#]|$)/i.test(p.urls[i]) && !r.ok && r.status !== 404)
      // merge the first body carrying usage/limit fields
      for (const [index, r] of results.entries()) {
        if (r.body) {
          const usage = p.source === "openai" ? parseOpenAiWhamUsage(r.body) : parseProbeUsage(r.body)
          if (usage) {
            return {
              source: p.source,
              status: "ok",
              detail: `usage endpoint answered (${p.urls[index]})`,
              usage,
            }
          }
        }
      }
      if (alive) {
        if (usageFailure) {
          const failure = usageFailure.error ?? `HTTP ${usageFailure.status ?? "error"}`
          return { source: p.source, status: "error", detail: `proxy alive; usage endpoint failed (${failure})` }
        }
        return { source: p.source, status: "no endpoint", detail: "proxy alive; no usage/limit endpoint answered" }
      }
      if (anyReply) {
        const codes = results.map((r) => (r.status != null ? String(r.status) : "err")).join(",")
        return { source: p.source, status: "no endpoint", detail: `server responded but no usage endpoint (HTTP ${codes})` }
      }
      const first = results[0]?.error ?? "unreachable"
      const refused = /ECONNREFUSED|connection refused/i.test(first)
      return {
        source: p.source,
        status: refused ? "no endpoint" : "error",
        detail: refused ? `no proxy listening (${p.urls[0]})` : `probe failed: ${first}`,
      }
    }),
  )
}

function goApiKey(): string | undefined {
  const auth = readJsonOr(AUTH_FILE, {})
  const key = auth?.["opencode-go"]?.key
  return typeof key === "string" && key.length > 0 ? key : undefined
}

/** Probe the real Go 5h/week/month windows. Local $ mapping is not what 402s. */
async function probeGoApi(): Promise<ProbeResult> {
  const key = goApiKey()
  if (!key) return { source: "opencode-go", status: "no endpoint", detail: "no opencode-go key in auth.json" }
  const r = await fetchProbe(GO_USAGE_URL, 8_000, { Authorization: `Bearer ${key}`, Accept: "application/json" })
  if (!r.ok || !r.body) {
    const code = r.status != null ? String(r.status) : "err"
    return {
      source: "opencode-go",
      status: r.status === 404 ? "no endpoint" : "error",
      detail: `Go usage API HTTP ${code}${r.error ? ` ${r.error}` : ""}`.trim(),
    }
  }
  try {
    const j = JSON.parse(r.body)
    const usage = j?.usage
    if (!usage || typeof usage !== "object") {
      return { source: "opencode-go", status: "ok", detail: "Go usage API answered but no usage object" }
    }
    return {
      source: "opencode-go",
      status: "ok",
      detail: formatGoApiDetail(usage),
      usage,
    }
  } catch {
    return { source: "opencode-go", status: "error", detail: "Go usage API returned non-JSON" }
  }
}

/** Fallback when the Go usage API is unreachable: recent session errors. */
function detectGoLimitError(db: any, since: number): { hit: boolean; detail: string } {
  if (!db) return { hit: false, detail: "" }
  for (const table of ["session_message", "message", "part"]) {
    try {
      const row = db
        .query(
          `SELECT id FROM ${table} WHERE time_created > ? AND (
            (data LIKE '%5-hour usage limit%' AND data LIKE '%opencode-go%')
            OR (data LIKE '%weekly usage limit%' AND data LIKE '%opencode-go%')
            OR (data LIKE '%7-day usage limit%' AND data LIKE '%opencode-go%')
            OR (data LIKE '%monthly usage limit%' AND data LIKE '%opencode-go%')
            OR (data LIKE '%usage limit reached%' AND data LIKE '%opencode-go%')
            OR ((data LIKE '%"statusCode":402%' OR data LIKE '%"code":"402"%' OR data LIKE '%"code":402%') AND data LIKE '%opencode-go%')
          ) LIMIT 1`,
        )
        .get(since) as { id: string } | undefined
      if (row?.id) return { hit: true, detail: `${table} ${row.id}: Go limit/402` }
    } catch (error) {
      log(`heuristic ${table} scan failed: ${String(error)}`)
    }
  }
  return { hit: false, detail: "" }
}

function ensureSource(bySource: Map<string, SourceAgg>, id: string): SourceAgg {
  let agg = bySource.get(id)
  if (!agg) {
    agg = { id, kind: KIND[id] ?? "sub", windows: { windows: {}, models: new Map() } }
    bySource.set(id, agg)
  }
  return agg
}

/** Compact Go API window summary: "rolling 5h 61% ok, weekly 7d 100% rate-limited, ..." */
export function formatGoApiDetail(usage: unknown): string {
  if (!usage || typeof usage !== "object") return "Go usage API answered but no usage object"
  const bits: string[] = []
  for (const [apiKey, label] of Object.entries(GO_API_WINDOW)) {
    const w = (usage as Record<string, any>)[apiKey]
    if (!w || typeof w !== "object") continue
    const pct = Number(w.percent)
    const status = typeof w.status === "string" ? w.status : "?"
    bits.push(`${apiKey} ${label} ${Number.isFinite(pct) ? `${pct}%` : "?"} ${status}`)
  }
  return bits.length ? `Go API ${bits.join(", ")}` : "Go usage API answered but no windows"
}

/** True when ANY Go API window (rolling 5h, weekly, monthly) is rate-limited or percent>=90. */
export function goApiCapFromUsage(usage: unknown): { apiCapHit: boolean; apiCapDetail?: string; windows: string[] } {
  if (!usage || typeof usage !== "object") return { apiCapHit: false, windows: [] }
  const windows: string[] = []
  for (const [apiKey, label] of Object.entries(GO_API_WINDOW)) {
    const w = (usage as Record<string, any>)[apiKey]
    if (!w || typeof w !== "object") continue
    const pct = Number(w.percent)
    const status = typeof w.status === "string" ? w.status : ""
    if (status === "rate-limited" || (Number.isFinite(pct) && pct >= 90)) windows.push(label)
  }
  const detail = formatGoApiDetail(usage)
  return {
    apiCapHit: windows.length > 0,
    apiCapDetail: windows.length ? `${detail} (capped: ${windows.join("+")})` : detail,
    windows,
  }
}

export function mergeGoApiIntoSource(agg: SourceAgg, probe: ProbeResult): { apiCapHit: boolean; apiCapDetail?: string } {
  const usage = probe.usage
  if (!usage || typeof usage !== "object") return { apiCapHit: false }
  const now = Date.now()
  for (const [apiKey, label] of Object.entries(GO_API_WINDOW)) {
    const w = usage[apiKey]
    if (!w || typeof w !== "object") continue
    let win = agg.windows.windows[label]
    if (!win) {
      win = { usedTokens: 0, used: 0, dbCost: 0, oldestTs: now }
      agg.windows.windows[label] = win
    }
    const percent = Number(w.percent)
    const status = typeof w.status === "string" ? w.status : undefined
    const remaining = finiteOrNull(w.remaining ?? w.remainingPercent ?? w.remaining_pct)
    const reset = resetSecondsFrom({ resetsAt: w.resetsAt, resetAt: w.resetsAt, reset: w.resetsAt })
    win.pctOverride = Number.isFinite(percent) ? percent : status === "rate-limited" ? 100 : win.pctOverride
    win.statusOverride = status
    if (remaining != null) win.remainingOverride = remaining
    if (reset != null) win.resetFromProbe = reset
  }
  const cap = goApiCapFromUsage(usage)
  return { apiCapHit: cap.apiCapHit, apiCapDetail: cap.apiCapDetail }
}

// ---------- aggregation & output ----------

function aggregate(messages: Msg[], costOf: (p: string, m: string) => { input: number; output: number; source: string }) {
  const bySource = new Map<string, SourceAgg>()
  const now = Date.now()
  for (const msg of messages) {
    const sourceId = PROVIDER_TO_SOURCE[msg.providerID]
    let agg = bySource.get(sourceId)
    if (!agg) {
      agg = {
        id: sourceId,
        kind: KIND[sourceId] ?? "metered",
        windows: {
          windows: {},
          models: new Map(),
        },
      }
      bySource.set(sourceId, agg)
    }
    const modelKey = `${msg.providerID}/${msg.modelID}`
    let model = agg.windows.models.get(modelKey)
    if (!model) {
      const price = costOf(msg.providerID, msg.modelID)
      model = {
        providerID: msg.providerID,
        modelID: msg.modelID,
        messages: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        cost: 0,
        dbCost: 0,
        priceSource: price.source,
      }
      agg.windows.models.set(modelKey, model)
    }
    const cost = (msg.tokens.input * costOf(msg.providerID, msg.modelID).input + (msg.tokens.output + msg.tokens.reasoning) * costOf(msg.providerID, msg.modelID).output) / 1e6
    model.messages += 1
    model.cost += cost
    model.dbCost += msg.dbCost
    for (const k of ["input", "output", "reasoning", "cacheRead", "cacheWrite"] as const) model.tokens[k] += msg.tokens[k]
    for (const w of WINDOWS) {
      if (now - msg.ts > w.ms) continue
      let win = agg.windows.windows[w.label]
      if (!win) {
        win = { usedTokens: 0, used: 0, dbCost: 0, oldestTs: msg.ts }
        agg.windows.windows[w.label] = win
      }
      win.usedTokens += msg.tokens.input + msg.tokens.output + msg.tokens.reasoning
      win.used += cost
      win.dbCost += msg.dbCost
      win.oldestTs = Math.min(win.oldestTs, msg.ts)
    }
  }
  return bySource
}

function mergeProbeIntoSource(agg: SourceAgg | undefined, probe: ProbeResult): void {
  if (!agg || !probe.usage || typeof probe.usage !== "object") return
  const j = probe.usage
  if (j.windows && typeof j.windows === "object") {
    for (const [label, windowUsage] of Object.entries(j.windows)) {
      if (!windowUsage || typeof windowUsage !== "object") continue
      let win = agg.windows.windows[label]
      if (!win) {
        win = { usedTokens: 0, used: 0, dbCost: 0, oldestTs: Date.now() }
        agg.windows.windows[label] = win
      }
      const w = windowUsage as any
      const percent = finiteOrNull(w.percent)
      const remaining = finiteOrNull(w.remaining)
      if (percent != null) win.pctOverride = percent
      if (remaining != null) win.remainingOverride = remaining
      if (typeof w.status === "string") win.statusOverride = w.status
      const reset = finiteOrNull(w.reset)
      if (reset != null) win.resetFromProbe = reset
    }
    return
  }
  const label = typeof j.window === "string" ? j.window : typeof j.windowLabel === "string" ? j.windowLabel : typeof j.label === "string" ? j.label : "5h"
  const now = Date.now()
  let win = agg.windows.windows[label]
  if (!win) {
    win = { usedTokens: 0, used: 0, dbCost: 0, oldestTs: now }
    agg.windows.windows[label] = win
  }
  const usedNum = Number(j.used ?? j.usage ?? 0)
  const cap = j.limit ?? j.cap ?? j.quota ?? null
  if (Number.isFinite(usedNum)) win.used = Math.max(win.used, usedNum)
  const tokens = j.tokens ?? j.used_tokens ?? 0
  if (Number.isFinite(Number(tokens))) win.usedTokens = Math.max(win.usedTokens, Number(tokens))
  const remaining = finiteOrNull(j.remaining ?? j.remainingPercent ?? j.remaining_pct)
  Object.assign(win, {
    capOverride: cap,
    pctOverride: j.percent != null ? Number(j.percent) : null,
    statusOverride: typeof j.status === "string" ? j.status : undefined,
    remainingOverride: remaining,
    resetFromProbe: resetSecondsFrom(j),
  })
}

function applyPriorCache(bySource: Map<string, SourceAgg>, previous: UsageCache | undefined): void {
  if (!previous) return
  const priorAt = Date.parse(previous.updated)
  if (!Number.isFinite(priorAt)) return
  for (const source of previous.sources) {
    const agg = bySource.get(source.id)
    if (!agg) continue
    for (const prior of source.windows ?? []) {
      const current = agg.windows.windows[prior.label]
      const used = finiteOrNull(prior.used)
      if (current && used != null && used >= 0) {
        current.priorUsed = used
        current.priorAt = priorAt
      }
    }
  }
}

function buildCache(
  bySource: Map<string, SourceAgg>,
  probes: ProbeResult[],
  plans: any,
  now: Date,
  extras?: Record<string, { apiCapHit?: boolean; apiCapDetail?: string }>,
): { updated: string; sources: any[] } {
  const planMap: Record<string, any> = plans?.plans ?? {}
  const sourcesOut: any[] = []
  for (const agg of bySource.values()) {
    const plan = planMap[agg.id]
    const windows: any[] = []
    for (const w of WINDOWS) {
      const win = agg.windows.windows[w.label]
      const planCap = plan?.windows?.find((p: any) => p.label === w.label)?.cap ?? null
      windows.push(
        finalizeWindow(w.label, w.ms, win, { now: now.getTime(), planCap, sourceId: agg.id, estimated: plan?.estimated }),
      )
    }
    const probe = probes.find((p) => p.source === agg.id)
    const models = [...agg.windows.models.values()]
      .sort((a, b) => b.cost - a.cost)
      .map((m) => ({
        providerID: m.providerID,
        modelID: m.modelID,
        messages: m.messages,
        tokens: m.tokens,
        cost: round2(m.cost),
        dbCost: round2(m.dbCost),
        priceSource: m.priceSource,
      }))
    const extra = extras?.[agg.id]
    const source: any = {
      id: agg.id,
      kind: agg.kind,
      source: "local-db",
      windows,
      dbCost: round2(agg.windows.windows["30d"]?.dbCost ?? 0),
      probe: probe ? probe.status : "none",
      probeDetail: probe ? probe.detail : "",
      models,
    }
    if (extra?.apiCapHit) source.apiCapHit = true
    if (extra?.apiCapDetail) source.apiCapDetail = extra.apiCapDetail
    sourcesOut.push(source)
  }
  // sources seen only via probes (no DB usage) get a shell entry so probe info is visible
  for (const probe of probes) {
    if (sourcesOut.some((s) => s.id === probe.source)) continue
    if (probe.source === "grok-sub" || probe.source === "cursor" || probe.source === "openai" || probe.source === "opencode-go") {
      const plan = planMap[probe.source]
      sourcesOut.push({
        id: probe.source,
        kind: KIND[probe.source] ?? "sub",
        source: "proxy",
        windows: WINDOWS.map((w) => {
          const planCap = plan?.windows?.find((p: any) => p.label === w.label)?.cap
          return finalizeWindow(w.label, w.ms, undefined, { now: now.getTime(), planCap, sourceId: probe.source, estimated: plan?.estimated })
        }),
        dbCost: 0,
        probe: probe.status,
        probeDetail: probe.detail,
        models: [],
      })
    }
  }
  // Configured harness/metered lanes may be perfectly usable while still
  // having no provider usage API or recent OpenCode DB message. Include them
  // as unknown shells instead of making the picker and /usage disagree about
  // what exists.
  for (const id of CONFIGURED_SOURCES) {
    if (sourcesOut.some((s) => s.id === id)) continue
    const plan = planMap[id]
    sourcesOut.push({
      id,
      kind: KIND[id] ?? "sub",
      source: "config",
      windows: WINDOWS.map((w) => {
        const planCap = plan?.windows?.find((p: any) => p.label === w.label)?.cap
        return finalizeWindow(w.label, w.ms, undefined, { now: now.getTime(), planCap, sourceId: id, estimated: plan?.estimated })
      }),
      dbCost: 0,
      probe: "none",
      probeDetail: "configured provider; no usage probe",
      models: [],
    })
  }
  // omit sources with zero usage AND no probe data at all (raw probe, before shortening)
  const kept = sourcesOut.filter((s) => {
    const hasUsage = s.windows?.some((w: any) => w.usedTokens > 0 || w.used > 0) ?? false
    const hasProbe = s.probe != null && s.probe !== "none"
    return hasUsage || hasProbe || s.source === "config" || CONFIGURED_SOURCES.includes(s.id)
  })
  for (const s of kept) {
    // Probe = probe result (ok/none/err). Window cap lives on window.status/pct, not here.
    s.probe = shortProbe(s.probe)
  }
  const order = ["opencode-go", "opencode", "cursor", "openai", "grok-sub", "xai"]
  kept.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id) || a.id.localeCompare(b.id))
  return {
    updated: now.toISOString(),
    cacheAgeSeconds: 0,
    maxAgeSeconds: MAX_CACHE_AGE_SECONDS,
    sources: kept,
  }
}

const TABLE_SHORT: Record<string, string> = {
  "opencode-go": "go",
  opencode: "free",
  openai: "openai",
  cursor: "cursor",
  "grok-sub": "grok",
  xai: "xai",
}

const TABLE_COL = { src: 6, win: 3, pct: 5, reset: 6 }

function tableHeader(): string {
  return [
    padCell("src", TABLE_COL.src, "left"),
    padCell("win", TABLE_COL.win, "left"),
    padCell("pct", TABLE_COL.pct, "right"),
    padCell("reset", TABLE_COL.reset, "right"),
  ].join(" ")
}

function tableRow(sourceId: string, kind: string | undefined, w: any): string {
  const src = (TABLE_SHORT[sourceId] ?? sourceId).slice(0, TABLE_COL.src)
  const cells = [
    padCell(src, TABLE_COL.src, "left"),
    padCell(String(w.label ?? MISSING_CELL), TABLE_COL.win, "left"),
    padCell(w.pct == null ? MISSING_CELL : `${w.estimated ? "~" : ""}${Math.round(w.pct)}%`, TABLE_COL.pct, "right"),
    padCell(w.resetsInSeconds == null ? MISSING_CELL : humanizeSeconds(w.resetsInSeconds), TABLE_COL.reset, "right"),
  ]
  if (shouldShowMoney(sourceId, kind, w.used ?? 0, w.cap ?? null)) {
    cells.push(fmtMoney(w.used))
  }
  return cells.join(" ")
}

export function formatCacheTable(cache: { updated: string; sources: any[] }): string {
  const lines: string[] = [tableHeader()]
  for (const s of cache.sources) {
    for (const w of s.windows ?? []) {
      lines.push(tableRow(s.id, s.kind, w))
    }
  }
  return lines.join("\n")
}

function humanTable(cache: { updated: string; sources: any[] }) {
  const lines: string[] = []
  lines.push(`usage ${cache.updated} (${notes.length} notes)`)
  lines.push("")
  lines.push(formatCacheTable(cache))
  lines.push("")
  lines.push("per-model (30d; usedTokens stay on the typed cache field, not in cells):")
  for (const s of cache.sources) {
    for (const m of s.models ?? []) {
      lines.push(
        `  ${s.id}/${m.modelID}: ${m.messages} msgs, ${fmtTokens(m.tokens.input)} in / ${fmtTokens(m.tokens.output + m.tokens.reasoning)} out+reas, ${fmtMoney(m.cost)} (price: ${m.priceSource}, dbCost ${fmtMoney(m.dbCost)})`,
      )
    }
  }
  if (notes.length) {
    lines.push("")
    lines.push("notes:")
    for (const n of notes) lines.push(`  ${n}`)
  }
  return lines.join("\n")
}

// ---------- main ----------

async function collectMain() {
  const args = process.argv.slice(2)
  const dry = args.includes("--dry")
  const asJson = args.includes("--json")
  if (args.some((a) => !["--dry", "--json"].includes(a))) {
    console.log("usage: bun usage-collector.ts [--dry] [--json]")
    process.exit(0)
  }

  const now = new Date()
  const previous = readUsageCache(CACHE_FILE, now.getTime())
  const plans = readJsonOr(PLANS_FILE, { plans: {} })
  const costIndex = loadCostIndex()
  log(`models-cache.json: ${costIndex.models.length} models loaded`)
  const costOf = makeCostLookup(costIndex)

  const db = await openDb(DB_PATH)
  let messages: Msg[] = []
  let goLimitError = { hit: false, detail: "" }
  if (db) {
    inspectSchema(db)
    const since = now.getTime() - (WINDOWS[2].ms + 3600_000) // 30d + 1h slack
    messages = collectMessages(db, since)
    // 30d lookback: monthly usage-limit errors must still be visible (WINDOWS[2]).
    goLimitError = detectGoLimitError(db, now.getTime() - WINDOWS[2].ms)
    try {
      db.close()
    } catch {}
  }
  log(`messages collected (deduped): ${messages.length}`)
  if (goLimitError.hit) log(`go cap error heuristic: ${goLimitError.detail}`)

  const [localProbes, goProbe] = await Promise.all([runProbes(), probeGoApi()])
  const probes = [...localProbes, goProbe]
  for (const p of probes) log(`probe ${p.source}: ${p.status} (${p.detail})`)

  const bySource = aggregate(messages, costOf)
  // Probes are authoritative even when the local DB has no messages for a
  // source. Create the aggregate first so WHAM's exact windows are not lost
  // before buildCache renders probe-only sources.
  for (const probe of localProbes) mergeProbeIntoSource(ensureSource(bySource, probe.source), probe)
  const goAgg = ensureSource(bySource, "opencode-go")
  const goMerge = mergeGoApiIntoSource(goAgg, goProbe)
  // Unknown/unreachable Go quota is fail-closed: never rebuild a healthy-looking
  // Go entry after a 403/network failure and let a spawn hit the provider blind.
  // Heuristic DB chatter (e.g. reasoning that mentions "5-hour usage limit")
  // must not override a healthy probe; only consider it when the probe itself
  // is unavailable.
  const unavailableGo = goProbe.status !== "ok"
  const heuristicHit = goLimitError.hit && unavailableGo
  const apiCapHit = goMerge.apiCapHit || unavailableGo || heuristicHit
  const apiCapDetail = goMerge.apiCapDetail ?? (heuristicHit ? `heuristic: ${goLimitError.detail}` : `Go usage API unavailable (${goProbe.status})`)
  if (apiCapHit) log(`GO CAP HIT (${apiCapDetail})`)
  applyPriorCache(bySource, previous)
  const cache = buildCache(bySource, probes, plans, now, { "opencode-go": { apiCapHit, apiCapDetail } })

  if (!dry) {
    try {
      writeJsonAtomic(CACHE_FILE, cache)
      log(`wrote ${CACHE_FILE}`)
    } catch (error) {
      log(`write failed: ${String(error)}`)
    }
  } else {
    log("--dry: cache not written")
  }

  if (asJson) {
    console.log(JSON.stringify(cache, null, 2))
  } else {
    console.log(humanTable(cache))
  }
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, "/").endsWith("usage-collector.ts") === true
if (invokedDirectly) {
  singleFlight("usage-cache-refresh", collectMain).catch((error) => {
    console.error("usage-collector crashed:", error)
    process.exit(1)
  })
}
