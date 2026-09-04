/**
 * Model routing, quota and the subagent roster.
 *
 * Extracted from favorite-router.ts, which had grown to 1859 lines covering
 * five unrelated concerns: routing, the Claude Code harness intercept, task
 * display labels, the orchestration ledger, and shell/tool guards. Nothing
 * here touches the plugin host — it is pure policy over the declared roster in
 * model-profiles.json, the usage cache, and the capacity registry — so it can
 * be tested and shipped on its own.
 *
 * The plugin wiring lives in plugins-active/models.ts.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import { blockLane, laneBlock, taskState } from "./capacity-registry"
import { isClaudeCodeModel, isForbiddenXai, openRouterTwin, overlayProviderLane, splitProviderModel } from "./model-catalog"
import { pickAvailableModel } from "./model-router"
import {
  capacitySnapshot as usageCapacitySnapshot,
  type UsageCache,
  usageCache,
  usageAgeMs,
  USAGE_CACHE_FILE,
  USAGE_STALE_MS,
  startUsageCollector,
  usageWindowResetAt,
  windowCapped,
} from "../usage/usage-lib"
import { failureMessage, usageReachedMessage, type ProviderFailure } from "../usage/usage-reached"
import { assertModelImmutable } from "./session-lifecycle"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = dirname(HERE)
const PROFILES_FILE = join(HERE, "model-profiles.json")
const CACHE_FILE = join(HERE, "models-cache.json")
const JSONC_FILE = join(REPO_ROOT, "opencode.jsonc")
const STATE_FILES = [
  join(homedir(), ".local", "state", "opencode", "model.json"),
  join(homedir(), ".local", "share", "opencode", "state", "model.json"),
]
const AGENT_DIR = join(homedir(), ".opencode", "agent")

type Fav = { providerID: string; modelID: string }
type Lane = "go-quota" | "sub" | "free" | "metered"
type Tier = "worker" | "utility" | "precise" | "codegen" | "heavy" | "escalate" | "explore"

type Profile = {
  id: string
  match: string[]
  name: string
  lane: Lane
  tier: Tier
  best: string
  avoid: string
  notes?: string
  priceInput?: number
  priceOutput?: number
  context?: number
  output?: number
}

type CacheEntry = {
  key: string
  id: string
  name?: string
  costInput?: number
  costOutput?: number
  context?: number
  output?: number
  tools?: boolean
  reasoning?: boolean
  structured?: boolean
}

const LANE_LABEL: Record<Lane, string> = {
  "go-quota": "Go-quota",
  sub: "Sub",
  free: "Free",
  metered: "Metered",
}


// ---- Go-cap spawn guard. Cache/collector/formatters: usage-lib.ts. usage_status: plugins-active/usage.ts. ----

/** Sol is an escalation lane, never an automatic implementation choice when
 * OpenAI budget telemetry is absent or cannot establish a known allowance. */
export function solAutomaticSelectionAllowed(task: string, usage: UsageCache | undefined): boolean {
  if (!usage) return false
  const source = usage.sources?.find((entry) => entry.id === "openai")
  const known = source?.windows?.some((window) =>
    typeof window.pct === "number" || (typeof window.cap === "number" && typeof window.used === "number"),
  )
  if (!known) return false
  return /\b(?:architect(?:ure)?|consult(?:ation|ing)?|escalat(?:e|ion))\b/i.test(task)
}

const CAP_WINDOW_LABELS = ["5h", "7d", "30d"] as const

export type Cap = { hit: boolean; windows: string[] }

/** Hard cap for any usage-cache source. Missing source is not a cap. Estimated-only is not a cap. */
export function sourceCapHit(sourceId: string, cache: UsageCache | undefined = usageCache()): Cap {
  const src = cache?.sources?.find((s) => s.id === sourceId)
  if (!src) return { hit: false, windows: [] }
  const windows: string[] = []
  for (const label of CAP_WINDOW_LABELS) {
    const win = src.windows?.find((w) => w.label === label)
    if (windowCapped(win) && (usageWindowResetAt(cache, win) ?? Infinity) > Date.now()) windows.push(label)
  }
  const expired = src.windows?.some((win) => windowCapped(win) && (usageWindowResetAt(cache, win) ?? Infinity) <= Date.now()) === true
  if (src.apiCapHit && windows.length === 0 && !expired) windows.push("api")
  return { hit: windows.length > 0, windows }
}

/** Usage-cache hard cap for a provider id. xai is always blocked (metered). Never unfavorite. */
export function providerCapBlocked(providerID: string, cache?: UsageCache): boolean {
  if (providerID === "xai") return true
  return sourceCapHit(providerID, cache).hit
}

/**
 * The line a user or an agent sees when a provider's window is spent.
 *
 * This used to be one hand-written paragraph about OpenCode Go that named its
 * fallbacks inline, so every other provider fell back to a generic sentence
 * and no other provider could ever gain the same treatment. It is now built
 * from the same usage-reached vocabulary as every other exhaustion path: what
 * ran out, which window, and what picks the work up.
 */
export function capMessage(
  providerID: string,
  cap: Cap = { hit: true, windows: [] },
  fallback?: { providerID: string; modelID: string },
): string {
  const windows = cap.windows.length ? ` (${cap.windows.join(", ")} spent)` : ""
  return `${usageReachedMessage({ providerID }, fallback).replace(` — ${providerID}.`, ` — ${providerID}${windows}.`)} ` +
    `Quota is not a model failure — do not unfavorite, disable, or drop ${providerID} models from use.`
}

/**
 * Providers whose quota telemetry must be trustworthy before work is routed
 * to them. A subscription that silently keeps billing is worse than a refused
 * spawn, so an unreadable, stale or structurally incomplete cache fails closed
 * rather than open. Membership is policy, not a branch in the routing code.
 */
const QUOTA_AUTHORITY_REQUIRED = new Set(["opencode-go"])

/**
 * The one lane in model-profiles.json backed by a subscription window rather
 * than per-token billing, and the provider that window belongs to. Named once
 * so the pairing is a single declaration instead of an id repeated down the
 * file next to every message it appears in.
 */
export const QUOTA_LANE = { lane: "go-quota", providerID: "opencode-go" } as const

/**
 * The one line to show when the subscription-backed lane is spent, or nothing
 * when it is not. Three callers each derived this themselves from a cap probe
 * plus a message builder, which is why the wording drifted between them.
 */
export function quotaLaneNotice(usage?: UsageCache): string | undefined {
  const cap = sourceCapHit(QUOTA_LANE.providerID, usage)
  return cap.hit ? capMessage(QUOTA_LANE.providerID, cap) : undefined
}

const XAI_NEVER_MSG = "Never use xai/* (metered). Grok = cliproxyapi/grok-4.6 (SuperGrok via CLIProxyAPI on 127.0.0.1:8317)."

/**
 * A cache is authoritative for a provider only when it holds a fresh,
 * structurally complete record for it. An empty `sources` array is not
 * evidence that anything is uncapped: collectors write that shape while a
 * probe or a cache read is failing.
 */
function hasAuthoritativeQuota(providerID: string, cache: UsageCache | undefined): boolean {
  if (!cache || !Array.isArray(cache.sources)) return false
  const age = usageAgeMs(cache)
  if (!Number.isFinite(age) || age < 0 || age >= USAGE_STALE_MS) return false
  const source = cache.sources.find((candidate) => candidate?.id === providerID)
  if (!source || !Array.isArray(source.windows)) return false
  for (const label of CAP_WINDOW_LABELS) {
    const win = source.windows.find((candidate) => candidate?.label === label)
    if (!win || typeof win.used !== "number" || !Number.isFinite(win.used)) return false
    if (win.cap !== null && (typeof win.cap !== "number" || !Number.isFinite(win.cap))) return false
    if (win.pct !== null && (typeof win.pct !== "number" || !Number.isFinite(win.pct) || win.pct < 0 || win.pct > 100)) return false
    if (win.status !== undefined && typeof win.status !== "string") return false
  }
  return typeof source.apiCapHit === "undefined" || typeof source.apiCapHit === "boolean"
}

/** Fails closed: a provider that must prove its quota, and cannot, is not routable. */
function quotaUnreadable(providerID: string, cache: UsageCache | undefined): boolean {
  return QUOTA_AUTHORITY_REQUIRED.has(providerID) && !hasAuthoritativeQuota(providerID, cache)
}

/** xai/* bills api.x.ai per token. SuperGrok rides CLIProxyAPI (cliproxyapi/grok-4.6); grok-sub stays the lane id for usage and capacity. */
function demeterXai(fav: Fav): Fav {
  if (fav.providerID !== "xai" && fav.providerID !== "grok-sub") return fav
  return { providerID: "cliproxyapi", modelID: fav.modelID }
}

/** Read-modify-write apiCapHit on the opencode-go source only. Does not rebuild the cache. */
function markGoApiCapHit(detail?: string) {
  try {
    const parsed = readJson(USAGE_CACHE_FILE)
    let cache: UsageCache
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as UsageCache).sources)) {
      cache = parsed as UsageCache
    } else if (!existsSync(USAGE_CACHE_FILE)) {
      cache = { updated: new Date().toISOString(), sources: [] }
    } else {
      console.warn("[models] usage-cache.json unreadable; not stamping apiCapHit")
      return
    }
    let src = cache.sources.find((s) => s.id === "opencode-go")
    if (!src) {
      src = { id: "opencode-go" }
      cache.sources.unshift(src)
    }
    src.apiCapHit = true
    if (detail) src.apiCapDetail = detail.slice(0, 240)
    cache.updated = new Date().toISOString()
    writeFileSync(USAGE_CACHE_FILE, JSON.stringify(cache, null, 2))
  } catch (error) {
    console.warn("[models] failed to stamp apiCapHit on usage-cache.json", error)
  }
}

/** Child/session 402: stamp the shared cache immediately, then force a collector run. */
export function forceUsageCollectOnCap(detail: string) {
  markGoApiCapHit(detail)
  void startUsageCollector({ force: true })
    .then(() => {
      if (!sourceCapHit("opencode-go").hit) markGoApiCapHit(detail)
    })
    .catch((error) => {
      console.warn("[models] force usage collect after provider error failed", error)
    })
}

// ---- shared live-session view (self-contained; spawns tasks-status.ts) ----
function slug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function readJson(path: string): unknown {
  if (!existsSync(path)) return
  try {
    return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""))
  } catch {
    return
  }
}

function loadProfiles(): Profile[] {
  const parsed = readJson(PROFILES_FILE) as { profiles?: unknown[] } | undefined
  if (!Array.isArray(parsed?.profiles)) return []
  return parsed.profiles.filter((item): item is Profile => {
    if (typeof item !== "object" || item === null) return false
    const p = item as Partial<Profile>
    return (
      typeof p.id === "string" &&
      Array.isArray(p.match) &&
      typeof p.name === "string" &&
      typeof p.tier === "string" &&
      typeof p.best === "string" &&
      typeof p.avoid === "string"
    )
  })
}

function loadCache(): CacheEntry[] {
  const parsed = readJson(CACHE_FILE) as { models?: unknown[] } | undefined
  if (!Array.isArray(parsed?.models)) return []
  return parsed.models.filter((item): item is CacheEntry => typeof item === "object" && item !== null)
}

export function readFavorites(): Fav[] {
  const file = STATE_FILES.find((path) => existsSync(path))
  if (!file) return []
  const parsed = readJson(file) as { favorite?: unknown[] } | undefined
  if (!Array.isArray(parsed?.favorite)) return []
  return parsed.favorite.filter(
    (item): item is Fav =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as Fav).providerID === "string" &&
      typeof (item as Fav).modelID === "string",
  )
}

export { splitProviderModel }

export function fallbackFavoritesFromAgents(): Fav[] {
  return []
}

function findMatchingBrace(src: string, openIdx: number): number {
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i]
    if (inStr) {
      if (esc) {
        esc = false
        continue
      }
      if (c === "\\") {
        esc = true
        continue
      }
      if (c === '"') inStr = false
      continue
    }
    if (c === '"') {
      inStr = true
      continue
    }
    if (c === "{") depth++
    else if (c === "}") {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** Leftover model-* agents in opencode.jsonc. Empty after fake-agent removal. */
/**
 * The declared subagent roster: every model a Task may be routed to.
 *
 * This is the source of truth. It used to be `~/.local/state/opencode/model.json`
 * — the TUI's favourites list — which is machine state, is not in the repo, and
 * vanishes on a new machine, so "which models exist" was untracked and
 * unreviewable. model-profiles.json already curated these models; each entry
 * now also declares its canonical `model` id.
 */
export function favoritesFromProfiles(): Fav[] {
  try {
    const doc = JSON.parse(readFileSync(PROFILES_FILE, "utf8")) as { profiles?: Array<{ model?: unknown }> }
    const out: Fav[] = []
    for (const profile of doc.profiles ?? []) {
      const declared = Array.isArray(profile.model) ? profile.model : profile.model ? [profile.model] : []
      for (const entry of declared) {
        if (typeof entry !== "string") continue
        const split = splitProviderModel(entry)
        if (split?.providerID && split?.modelID) out.push(split)
      }
    }
    return out
  } catch (error) {
    console.error(`[models] model roster unreadable: ${String(error).slice(0, 200)}`)
    return []
  }
}

export function favoritesFromJsonc(): Fav[] {
  if (!existsSync(JSONC_FILE)) return []
  try {
    const raw = readFileSync(JSONC_FILE, "utf8")
    const match = raw.match(/"agents"\s*:\s*\{/)
    if (!match || match.index == null) return []
    const brace = raw.indexOf("{", match.index + match[0].length - 1)
    const end = findMatchingBrace(raw, brace)
    if (end < 0) return []
    const agents = JSON.parse(raw.slice(brace, end + 1)) as Record<string, { model?: unknown }>
    const favs: Fav[] = []
    for (const [key, val] of Object.entries(agents)) {
      if (!key.startsWith("model-")) continue
      const model = val?.model
      if (typeof model !== "string") continue
      const parsed = splitProviderModel(model)
      if (parsed) favs.push(parsed)
    }
    return favs
  } catch {
    return []
  }
}

export function mergeFavs(...lists: Fav[][]): Fav[] {
  const byKey = new Map<string, Fav>()
  for (const list of lists) {
    for (const fav of list) {
      const d = demeterXai(fav)
      if (d.providerID === "xai") continue
      const key = `${d.providerID}/${d.modelID}`
      if (!byKey.has(key)) byKey.set(key, d)
    }
  }
  return [...byKey.values()]
}

function spawnBlob(args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>
  return [a.agent, a.subagent_type, a.name, a.model, a.subagent].filter((v) => typeof v === "string").join(" ")
}

/** True when Task/subagent targets the official Claude Code harness, not a chat-model agent. */
export function blockedCappedSpawn(args: unknown, cache?: UsageCache): string | undefined {
  const provider = spawnProvider(args)
  if (!provider) return
  const cap = sourceCapHit(provider, cache)
  if (!cap.hit) return
  // Name the target that will actually pick the work up. The old message
  // listed two model ids inline, so it went stale the moment the roster moved.
  return capMessage(provider, cap, nextHealthyFallback(provider, cache))
}

function cacheKeys(cache = loadCache()): string[] {
  return cache.map((entry) => entry.key).filter((key): key is string => typeof key === "string")
}

function legacyModelAgentName(fav: { providerID: string; modelID: string }): string {
  return `model-${slug(fav.providerID)}-${slug(fav.modelID)}`
}

function workerRoleFor(fav: { providerID: string; modelID: string }): "explore" | "build" {
  return inferProfile(fav).tier === "explore" ? "explore" : "build"
}

function twinAgentName(twin: { providerID: string; modelID: string }): string {
  return workerRoleFor(twin)
}

function twinForSpawnToken(token: string, keys: readonly string[]) {
  if (!token || isForbiddenXai(token)) return
  const parsed = splitProviderModel(token)
  if (parsed) {
    if (parsed.providerID.toLowerCase() === "openrouter") return isForbiddenXai(`${parsed.providerID}/${parsed.modelID}`) ? undefined : parsed
    return openRouterTwin(parsed.modelID, keys)
  }
  const goAgent = token.match(/^model-opencode-go-(.+)$/i)
  if (goAgent) return openRouterTwin(goAgent[1], keys)
}

function applySpawnTarget(input: Record<string, unknown>, providerID: string, modelID: string): string {
  const agent = twinAgentName({ providerID, modelID })
  const model = `${providerID}/${modelID}`
  input.agent = agent
  input.model = model
  if (typeof input.subagent_type === "string") input.subagent_type = agent
  if (typeof input.subagent === "string") input.subagent = agent
  if (typeof input.name === "string") input.name = agent
  return agent
}

/**
 * In-place rewrite of a capped Task target to its OpenRouter twin. Returns the
 * twin agent name, or undefined when no twin is registered.
 *
 * The guard here used to be `isGoSpawn`, so a capped Anthropic or OpenAI model
 * with a perfectly good twin was sent to a generic fallback instead. Twin
 * lookup was never Go-specific — only this guard was.
 */
export function rewriteCappedSpawn(args: unknown, keys?: readonly string[]): string | undefined {
  const a = (args ?? {}) as Record<string, unknown>
  const resolved = keys ?? cacheKeys()
  const fields = ["agent", "subagent_type", "name", "model", "subagent"] as const
  let twin: { providerID: string; modelID: string } | undefined
  for (const field of fields) {
    const value = a[field]
    if (typeof value !== "string") continue
    twin = twinForSpawnToken(value, resolved)
    if (twin) break
  }
  if (!twin || isForbiddenXai(`${twin.providerID}/${twin.modelID}`)) return
  return applySpawnTarget(a, twin.providerID, twin.modelID)
}

export function spawnProvider(args: unknown): string | undefined {
  const a = (args ?? {}) as Record<string, unknown>
  if (typeof a.model === "string") {
    const parsed = splitProviderModel(a.model)
    if (parsed) return parsed.providerID
  }
  const blob = spawnBlob(args)
  if (!blob) return
  if (/opencode-go/i.test(blob) || /model-opencode-go-/i.test(blob)) return "opencode-go"
  if (/openrouter/i.test(blob) || /model-openrouter-/i.test(blob)) return "openrouter"
  if (/grok-sub|cliproxyapi/i.test(blob) || /model-grok-sub-/i.test(blob)) return "grok-sub"
  if (/\bxai\b/i.test(blob) || /model-xai-/i.test(blob)) return "xai"
  if (/model-openai-/i.test(blob) || /\bopenai\//i.test(blob)) return "openai"
  if (/model-cursor-/i.test(blob) || /\bcursor\//i.test(blob)) return "cursor"
  if (/model-opencode-/i.test(blob) || /\bopencode\//i.test(blob)) return "opencode"
}

function spawnNeedsFailover(provider: string | undefined, cache?: UsageCache): boolean {
  if (!provider) return false
  if (provider === "xai") return true
  if (quotaUnreadable(provider, cache)) return true
  if (providerCapBlocked(provider, cache)) return true
  return Boolean(laneBlock(provider))
}

const FALLBACK_GROK = { providerID: "cliproxyapi", modelID: "grok-4.6" }
const FALLBACK_LUNA = { providerID: "openai", modelID: "gpt-5.6-luna-fast" }
const FALLBACK_GLM = { providerID: "openrouter", modelID: "z-ai/glm-5.3-flash" }

function providerHealthy(providerID: string, cache?: UsageCache): boolean {
  if (providerID === "xai") return false
  // Usage, caps and lane blocks are keyed by lane (cliproxyapi/grok-4.6 rides the grok-sub lane).
  const lane = spawnLane(providerID)
  if (providerCapBlocked(lane, cache)) return false
  if (laneBlock(lane)) return false
  if (quotaUnreadable(lane, cache)) return false
  return true
}

/** Next healthy spawn target after a quota/limit rewrite. Never xai. Last resort is OpenRouter GLM. */
export function nextHealthyFallback(from: string, cache?: UsageCache): { providerID: string; modelID: string } {
  const order =
    from === "openai" ? [FALLBACK_GROK, FALLBACK_GLM]
    : from === "grok-sub" ? [FALLBACK_LUNA, FALLBACK_GLM]
    : from === "openrouter" ? [FALLBACK_GROK, FALLBACK_LUNA]
    : [FALLBACK_GROK, FALLBACK_LUNA, FALLBACK_GLM]
  const candidates = order.filter((target) => spawnLane(target.providerID) !== spawnLane(from) && providerHealthy(target.providerID, cache))
  const capacity = usageCapacitySnapshot(cache)
  const observedHealthy = candidates.find((target) => (capacity.providers[spawnLane(target.providerID)] ?? capacity.providers[target.providerID])?.state === "available")
  if (observedHealthy) return observedHealthy
  return candidates[0] ?? FALLBACK_GLM
}

export function spawnLane(target: string): string {
  if (/openrouter/i.test(target)) return "openrouter"
  if (/grok|cliproxyapi/i.test(target)) return "grok-sub"
  if (/opencode-go/i.test(target)) return "opencode-go"
  if (/openai/i.test(target)) return "openai"
  if (/cursor/i.test(target)) return "cursor"
  return "other"
}

function namedModelMatch(fav: Fav, profile: Profile, text: string): boolean {
  return [fav.modelID, fav.providerID, profile.name, profile.id, legacyModelAgentName(fav)].some((part) => {
    const raw = part.toLowerCase()
    const spaced = raw.replace(/[^a-z0-9]+/g, " ").trim()
    return text.includes(raw) || (spaced.length > 0 && text.includes(spaced))
  })
}

function modelDataFor(fav: Fav, cache = loadCache()): CacheEntry | undefined {
  const key = `${fav.providerID}/${fav.modelID}`.toLowerCase()
  const model = slug(fav.modelID)
  return cache.find((entry) => {
    const entryId = slug(entry.id)
    if (entry.key.toLowerCase() === key) return true
    if (entryId === model) return true
    if (slug(entry.name ?? "") === model) return true
    return entryId.length >= 6 && (entryId.includes(model) || model.includes(entryId))
  })
}

function overlayLane(profile: Profile, overlay: Lane | undefined): Profile {
  if (!overlay || overlay === profile.lane) return profile
  if (overlay !== "metered") return { ...profile, lane: overlay }
  return {
    ...profile,
    lane: overlay,
    best: `named ${profile.name} OpenRouter twin or last-resort when the home-lane is capped`,
    avoid: "default dispatch — metered pay-per-token; automatic pool must not pick this unless named",
  }
}

function inferProfile(fav: Fav, profiles = loadProfiles()): Profile {
  const key = `${fav.providerID}/${fav.modelID}`.toLowerCase()
  const model = fav.modelID.toLowerCase()
  const overlay = overlayProviderLane(fav.providerID)
  const hit = profiles.find((profile) =>
    profile.match.some((needle) => {
      const n = needle.toLowerCase()
      return key.includes(n) || model.includes(n)
    }),
  )
  if (hit) return overlayLane(hit, overlay)
  const provider = fav.providerID.toLowerCase()
  const lane: Lane = overlay ?? (provider === "opencode-go" ? "go-quota" : provider === "opencode" ? "free" : "sub")
  return {
    id: `inferred-${fav.modelID}`,
    match: [fav.modelID],
    name: fav.modelID,
    lane,
    tier: provider === "opencode-go" ? "worker" : "escalate",
    best: "general coding",
    avoid: "unknown strengths - prefer a curated profile if one fits",
  }
}

function ctxLabel(context: number | undefined) {
  if (!context) return "ctx ?"
  const m = context / 1_000_000
  return m >= 1 ? `${m % 1 === 0 ? m : m.toFixed(2)}M ctx` : `${Math.round(context / 1000)}k ctx`
}

function priceLabel(input: number | undefined, output: number | undefined) {
  if (typeof input !== "number" || typeof output !== "number") return "price n/a"
  return `$${input}/$${output} per 1M`
}

function capsLabel(entry: CacheEntry | undefined) {
  if (!entry) return ""
  const parts: string[] = []
  if (entry.tools) parts.push("tools")
  if (entry.reasoning) parts.push("reasoning")
  if (entry.structured) parts.push("structured")
  return parts.join("+")
}

function describe(fav: Fav, profile: Profile, entry: CacheEntry | undefined) {
  const caps = capsLabel(entry)
  return [
    `${LANE_LABEL[profile.lane]}/${profile.tier}`,
    ctxLabel(entry?.context ?? profile.context),
    priceLabel(entry?.costInput ?? profile.priceInput, entry?.costOutput ?? profile.priceOutput),
    ...(caps ? [caps] : []),
    `BEST: ${profile.best}`,
    `AVOID: ${profile.avoid}`,
    `Spawn ${profile.name} (${fav.providerID}/${fav.modelID}). If the user asks for N of this type, launch all N Task calls in one message.`,
  ].join(" · ")
}

function outputCost(fav: Fav, profile: Profile, entry: CacheEntry | undefined) {
  return typeof entry?.costOutput === "number" ? entry.costOutput : profile.priceOutput
}

function routingCard(favs: Fav[]) {
  const profiles = loadProfiles()
  const cache = loadCache()
  const lines = [
    "MODEL ROUTING - pick the cheapest favorite that can do the job.",
    "Prices are real list $/1M from models.dev cache, sorted by output price.",
    "Go-quota/Sub/Free lanes are cheap for you even if the list price looks big (Luna/Sol ride OpenAI subs; Grok 4.6 rides SuperGrok via cliproxyapi/grok-4.6 (CLIProxyAPI) ONLY - xai/* bills API per token). Metered = pay-per-token.",
    "Flash/Pro/fast suffixes are NAMES, not speed or quality guarantees - trust the cost column and curated BEST/AVOID.",
    "If the user names a model, use that. `general` is isolation, not a quality upgrade. `explore` is read-only search.",
    "HARNESS OPTION: Claude Code (Harness) / claude-code. Picker identity: claude-code/claude (also opus/sonnet/haiku). Fuzzy names: claude, claude code, harness, sonnet, opus, haiku. Session chat and Task(agent=claude-code) both use the official CLI — never a relay LLM. Direct tool: `claude_code_task` with required `scope`.",
    "",
  ]
  if (!favs.length) {
    lines.push("No favorited models synced. Run `bun favorite-agents.ts sync`.")
    return lines.join("\n")
  }
  const sorted = favs
    .map((fav) => {
      const profile = inferProfile(fav, profiles)
      const entry = modelDataFor(fav, cache)
      return { fav, profile, entry, cost: outputCost(fav, profile, entry) }
    })
    .toSorted((a, b) => (a.cost ?? Infinity) - (b.cost ?? Infinity))
  for (const { fav, profile, entry, cost } of sorted) {
    lines.push(
      [
        `- ${fav.providerID}/${fav.modelID}`,
        `${LANE_LABEL[profile.lane]}/${profile.tier}`,
        ctxLabel(entry?.context ?? profile.context),
        priceLabel(entry?.costInput ?? profile.priceInput, cost),
        ...(capsLabel(entry) ? [capsLabel(entry)] : []),
        `BEST: ${profile.best}`,
        `AVOID: ${profile.avoid}`,
      ].join(" · "),
    )
  }
  lines.push("")
  lines.push(
    "DEFAULT: Muse Spark 1.2 Contributor for ~90% of tasks — impl, tests, refactors, debug, UI/HUD, frontend, scene/codegen, grunt, bulk edits, docs, parallel fan-out, most coding (also most ops). GLM Flash only for tiny utility/ops when explicitly requesting cheapest 1M run — not default. Grok 4.6 (grok-sub only, never xai/*) only for hard debugging/long rewrites/when Muse shortcuts. DeepSeek Flash not default (Muse replaces it). Design/creativity/architecture -> Kimi K3 (slow, deliberate). Review -> hy3 (luna-fast while Go capped). Escalate Luna/Sol only when named or cheaper already failed.",
  )
  return lines.join("\n")
}

export function pickModel(task: string, favs: Fav[], usage?: UsageCache) {
  const profiles = loadProfiles()
  const cache = loadCache()
  const cap = sourceCapHit(QUOTA_LANE.providerID, usage)
  const capHit = cap.hit
  const safeFavs = favs.map(demeterXai).filter((fav) => fav.providerID !== "xai" && !isClaudeCodeModel(fav))
  const text = task.toLowerCase()
  if (namesClaudeHarness(text) || /\b(?:use|run|delegate to|send to)\s+(?:claude(?: code)?|harness)\b/.test(text)) {
    return {
      agent: "claude-code",
      model: undefined as string | undefined,
      reason: "user requested Claude Code (Harness)",
      profile: { name: "Claude Code (Harness)", lane: "sub", tier: "worker", best: "official Claude Code client", avoid: "native provider assumptions" },
      cost: undefined,
    }
  }
  const matches = safeFavs.filter((fav) => namedModelMatch(fav, inferProfile(fav, profiles), text))
  const named = capHit
    ? matches.find((fav) => inferProfile(fav, profiles).lane !== QUOTA_LANE.lane) ?? matches[0]
    : matches.find((fav) => inferProfile(fav, profiles).lane !== "metered") ?? matches[0]
  if (named) {
    const chosen = demeterXai(named)
    const profile = inferProfile(chosen, profiles)
    if (!(capHit && profile.lane === "go-quota")) {
      return {
        agent: workerRoleFor(chosen),
        model: `${chosen.providerID}/${chosen.modelID}`,
        reason: `user named ${chosen.providerID}/${chosen.modelID}`,
        profile,
        cost: outputCost(chosen, profile, modelDataFor(chosen, cache)),
      }
    }
    const twin = openRouterTwin(chosen.modelID, cacheKeys(cache))
    if (twin && !isForbiddenXai(`${twin.providerID}/${twin.modelID}`)) {
      const twinProfile = inferProfile(twin, profiles)
      return {
        agent: twinAgentName(twin),
        model: `${twin.providerID}/${twin.modelID}`,
        reason: `${capMessage(QUOTA_LANE.providerID, cap, twin)} Same-model failover to ${twin.providerID}/${twin.modelID}.`,
        profile: twinProfile,
        cost: outputCost(twin, twinProfile, modelDataFor(twin, cache)),
      }
    }
  }
  const pool = (capHit ? safeFavs.filter((fav) => inferProfile(fav, profiles).lane !== QUOTA_LANE.lane) : safeFavs)
    .filter((fav) => inferProfile(fav, profiles).lane !== "metered")
    .filter((fav) => !providerCapBlocked(spawnLane(fav.providerID), usage))
    .filter((fav) => inferProfile(fav, profiles).id !== "gpt-5.6-sol" || solAutomaticSelectionAllowed(task, usage))
  if (capHit && pool.length === 0) {
    const grok = safeFavs.find((fav) => fav.providerID === "cliproxyapi" || fav.providerID === "grok-sub") ?? FALLBACK_GROK
    const chosen = demeterXai(grok)
    const profile = inferProfile(chosen, profiles)
    return {
      agent: workerRoleFor(chosen),
        model: `${chosen.providerID}/${chosen.modelID}`,
      reason: `${capMessage(QUOTA_LANE.providerID, cap, chosen)} Hard-failover to ${chosen.providerID}/${chosen.modelID}.`,
      profile,
      cost: outputCost(chosen, profile, modelDataFor(chosen, cache)),
    }
  }
  const scored = pool
    .map((fav) => {
      const profile = inferProfile(fav, profiles)
      const entry = modelDataFor(fav, cache)
      const cost = outputCost(fav, profile, entry)
      let score = 0
      if (profile.lane === "go-quota") score += 22
      if (profile.lane === "free") score += 24
      if (profile.lane === "sub") score += 16
      if (profile.lane === "metered") score -= 40
      if (capHit) {
        if (spawnLane(fav.providerID) === "grok-sub") score += 50
        else if (fav.providerID === "openai") score += 35
        if (profile.lane === "go-quota") score -= 80
      }
      if (typeof cost === "number") {
        if (cost <= 0.3) score += 6
        else if (cost <= 2) score -= 8
        else score -= 28
        if (profile.lane === "go-quota" && cost > 2) score -= 12
      }
      const wantPrecise = /schema|type|contract|fail-?closed|fidelity|instruction/.test(text)
      const wantUi = /\bui\b|hud|frontend|css|react|scene|visual|player|hud/.test(text)
      const wantHeavy = /architect|long-?horizon|huge context|multimodal|vision|1m context|hard agentic|hard debug|long rewrite|big rewrite|reasoning-heavy|shortcut/.test(text)
      const wantUtility = /git|commit|verify|smoke|deploy|status|cleanup|rebase|merge|release|format|lint|typecheck|tripwire|check/.test(text)
      const wantCreative = /design|creative|creativ|concept|direction|aesthetic|art|novel|wireframe/.test(text)
      const wantGrunt = /impl|test|refactor|grunt|bulk|parallel|loop|motor|docs|mechanical|migrate/.test(text)
      const wantExplore = /preview|throwaway|second opinion/.test(text)
      const isMuse = profile.id === "muse-spark"
      if (!capHit && isMuse && !wantHeavy && !wantPrecise) score += 28
      if (!capHit && isMuse && (wantGrunt || wantUtility || wantUi)) score += 10
      const wantGrok = /hard debug|long rewrite|big rewrite|reasoning-heavy|shortcut/.test(text)
      if (wantGrok && profile.id === "grok-4-6") score += 45
      if (wantGrok && profile.tier === "worker") score += 15
      if (wantGrok && isMuse) score -= 12
      if (wantPrecise && profile.tier === "precise") score += 25
      if (wantUi && profile.tier === "codegen") score += 25
      if (wantHeavy && profile.tier === "heavy") score += 30
      if (wantGrunt && profile.tier === "codegen") score += 18
      if (wantGrunt && profile.tier === "worker") score += 8
      if (wantExplore && profile.tier === "explore") score += 15
      if (wantUtility && profile.tier === "utility") score += 12
      if (wantUtility && profile.tier === "codegen") score += 14
      if (wantUtility && (profile.tier === "heavy" || profile.tier === "escalate")) score -= 40
      if (wantCreative && profile.tier === "heavy") score += 25
      if (!wantHeavy && profile.tier === "heavy") score -= 20
      if (!wantUi && profile.tier === "codegen" && wantPrecise) score -= 15
      if (profile.tier === "escalate" && !wantHeavy) score -= 20
      if (isMuse && wantPrecise) score -= 12
      return { fav, profile, score, cost }
    })
    .toSorted((a, b) => b.score - a.score || (a.cost ?? Infinity) - (b.cost ?? Infinity))
  const best = scored[0]
  if (!best) return
  const chosen = demeterXai(best.fav)
  return {
    agent: workerRoleFor(chosen),
        model: `${chosen.providerID}/${chosen.modelID}`,
    reason: capHit
      ? `${capMessage(QUOTA_LANE.providerID, cap)} Excluded ${QUOTA_LANE.lane}. ${best.profile.name} scored ${best.score} (cost ${typeof best.cost === "number" ? `$${best.cost}/1M out` : "n/a"})`
      : `${best.profile.name} scored ${best.score} (cost ${typeof best.cost === "number" ? `$${best.cost}/1M out` : "n/a"})`,
    profile: best.profile,
    cost: best.cost,
  }
}

/**
 * Host tool.execute.before event (opencode2.exe Tool.execute):
 *   kn = { tool, inputSchema, sessionID, agent, messageID, id, input }
 *   trigger("tool", "execute.before", kn)
 * `event.agent` is the caller; the Task target is `event.input.agent`.
 */
export function rewriteLegacyModelAgent(input: unknown, favs?: Fav[]): void {
  if (!input || typeof input !== "object") return
  const args = input as Record<string, unknown>
  const name = String(args.agent ?? args.subagent_type ?? "").trim()
  if (!name.startsWith("model-")) return
  const list = favs ?? mergeFavs(favoritesFromProfiles(), readFavorites(), fallbackFavoritesFromAgents(), favoritesFromJsonc())
  const hit = list.find((item) => legacyModelAgentName(item) === name)
  if (!hit) return
  args.agent = workerRoleFor(hit)
  args.model = `${hit.providerID}/${hit.modelID}`
}

/**
 * execute.before for Task/subagent spawns: rewrite a spawn aimed at an
 * exhausted or unroutable provider onto one that can actually do the work.
 * Named for what it does rather than for the one provider it started with.
 */
export function spawnFailoverBefore(event: unknown, cache?: UsageCache, keys?: readonly string[]): void {
  const ev = (event ?? {}) as Record<string, unknown>
  const toolName = String(ev.tool ?? ev.name ?? "")
  if (!/^(task|subagent)$/i.test(toolName)) return
  const args = (ev.input ?? ev.args ?? event) as Record<string, unknown>
  if (!args || typeof args !== "object") return
  if (isClaudeCodeSpawn(args)) return
  rewriteLegacyModelAgent(args)
  const blob = spawnBlob(args)
  const id = String(ev.id ?? ev.callID ?? "failover")
  const sessionID = String(ev.sessionID ?? "unknown")
  const note = (lane: string, agent: string, reason: string) => {
    rememberFailoverNotice(reason)
    taskState(id, sessionID, id, lane, "executing", reason)
  }
  if (isForbiddenXai(blob)) {
    const fb = nextHealthyFallback("xai", cache)
    const agent = applySpawnTarget(args, fb.providerID, fb.modelID)
    note(fb.providerID, agent, `${XAI_NEVER_MSG} Rewrote Task -> ${agent}.`)
    return
  }
  const provider = spawnProvider(args)
  if (!spawnNeedsFailover(provider, cache)) return
  // One path for every provider. This used to fork: opencode-go got a twin
  // rewrite, a lane block and a bespoke message, and everything else got a
  // single generic sentence — so no other provider could ever gain the same
  // handling without another branch being written for it by hand.
  const from = provider ?? "other"
  const twinAgent = rewriteCappedSpawn(args, keys)
  const fb = twinAgent ? undefined : nextHealthyFallback(from, cache)
  const agent = twinAgent ?? applySpawnTarget(args, fb!.providerID, fb!.modelID)
  const target = twinAgent ? spawnTargetOf(args) : fb!
  const reason = quotaUnreadable(from, cache)
    ? `${from} quota unknown — usage cache is stale or incomplete, failing closed. Rewrote Task -> ${agent}; ${from} models stay favorited.`
    : `${capMessage(from, sourceCapHit(from, cache), target)} Rewrote Task -> ${agent}.`
  blockLane(from, reason, capResetAt(from, cache))
  note(target.providerID, agent, reason)
}

/** The provider/model a spawn now points at, after a rewrite. */
function spawnTargetOf(args: unknown): { providerID: string; modelID: string } {
  const model = (args as Record<string, unknown>)?.model
  const parsed = typeof model === "string" ? splitProviderModel(model) : undefined
  return parsed ?? { providerID: "unknown", modelID: "unknown" }
}

/**
 * The real end of the window a provider says it is capped in. The lane block
 * tracks that when telemetry reports it — a 5h or 7d window is not something
 * the router may shorten. Undefined when no capped window carries a reset, and
 * the caller falls back to a short retry rather than inventing a duration.
 */
export function capResetAt(providerID: string, cache?: UsageCache): string | undefined {
  const seconds = cache?.sources?.find(s => s.id === providerID)?.windows?.filter(w => windowCapped(w)).map(w => w.resetsInSeconds).find(x => typeof x === "number")
  return typeof seconds === "number" ? new Date(Date.now() + seconds * 1000).toISOString() : undefined
}

/** Task agent=claude-code runs the official CLI; never starts a relay chat-model session. */
// ---- failover notices ----------------------------------------------------
// A quota rewrite has to reach the orchestrator's next turn. These are drained
// by the models plugin's context hook and pushed as SystemPart objects — never
// as raw strings, which fail opencode2 schema validation.

export function systemPart(text: string): { type: "text"; text: string } {
  return { type: "text", text }
}

const failoverNotices: string[] = []

export function rememberFailoverNotice(text: string) {
  const trimmed = String(text ?? "").trim()
  if (trimmed) failoverNotices.push(trimmed)
}

export function drainFailoverNotices(): string[] {
  const out = failoverNotices.slice()
  failoverNotices.length = 0
  return out
}

export function failoverSystemParts(): { type: "text"; text: string }[] {
  return drainFailoverNotices().map(systemPart)
}

/**
 * Whether a Task spawn targets the Claude Code harness rather than a chat
 * model. Every field a caller might name the agent in is checked — a spawn
 * that slips through is routed to a relay model instead of the real CLI.
 */
export function isClaudeCodeSpawn(args: unknown): boolean {
  const a = (args ?? {}) as Record<string, unknown>
  return [a.agent, a.subagent_type, a.subagent, a.name].some((name) => namesClaudeHarness(name))
}

/**
 * Whether a name (or a task description) refers to the Claude Code harness.
 * Kept here rather than imported from the harness plugin: routing must not
 * depend on a plugin, or neither can ship on its own.
 */
export function namesClaudeHarness(name: unknown): boolean {
  const normalized = String(name ?? "").trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ")
  return ["claude", "claude code", "claude code harness", "harness"].includes(normalized)
}

/** The usage-cache shape plugins pass through to the spawn guard. */
export type UsageCacheLike = UsageCache
export function enforceSessionModelChange(event: unknown) {
  const ev = (event ?? {}) as Record<string, unknown>
  const input = (ev.input ?? ev.args ?? {}) as Record<string, unknown>
  const currentModel = typeof ev.sessionModel === "string" ? ev.sessionModel : typeof input.sessionModel === "string" ? input.sessionModel : undefined
  const requestedModel = typeof input.model === "string" ? input.model : undefined
  if (!currentModel || !requestedModel) return
  assertModelImmutable({ model: currentModel, variant: typeof ev.sessionVariant === "string" ? ev.sessionVariant : typeof input.sessionVariant === "string" ? input.sessionVariant : undefined, state: "active", historyCount: Number(ev.historyCount ?? input.historyCount ?? 0), workerStarted: ev.workerStarted === true || input.workerStarted === true }, requestedModel, typeof input.variant === "string" ? input.variant : undefined)
}
