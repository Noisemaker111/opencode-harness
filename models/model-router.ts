import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { type CatalogModel, exactIdentity, overlayProviderLane } from "./model-catalog"
import type { CapacitySnapshot } from "../usage/usage-lib"

export type Fav = { providerID: string; modelID: string }

export type CostLane = "go-quota" | "sub" | "free" | "metered"
export type ModelTier = "worker" | "utility" | "precise" | "codegen" | "heavy" | "escalate" | "explore"

export type ModelProfile = {
  id: string
  match: string[]
  name: string
  lane: CostLane
  tier: ModelTier
  best: string
  avoid: string
  notes?: string
  priceInput?: number
  priceOutput?: number
  context?: number
  output?: number
}

export type ModelData = {
  costInput?: number
  costOutput?: number
  context?: number
  output?: number
  tools?: boolean
  reasoning?: boolean
  structured?: boolean
  source: "models-dev" | "profile"
}

export type UsageTelemetry = { capacity?: "available" | "exhausted" | "resetting" | "unknown"; resetAt?: number; authenticated?: boolean; recentSuccess?: number }

function isSubscriptionProvider(providerID: string): boolean {
  return ["opencode-go", "openai", "cursor", "grok-sub"].includes(providerID.toLowerCase())
}

export function telemetryFromCapacity(models: CatalogModel[], snapshot: CapacitySnapshot): Record<string, UsageTelemetry> {
  return Object.fromEntries(models.map((model) => {
    const key = `${model.providerID}/${model.modelID}${model.variant ? `#${model.variant}` : ""}`
    const source = snapshot.providers[model.providerID]
    return [key, { capacity: source?.state ?? "unknown", resetAt: source?.resetAt, authenticated: source?.authenticated }]
  }))
}

/** Apply the picker's exact provider/model to an otherwise unpinned native Task. */
export function applyPickedModel(input: Record<string, unknown>, models: CatalogModel[], telemetry: Record<string, UsageTelemetry>): string | undefined {
  if (typeof input.model === "string" && input.model.trim()) return input.model
  const role = String(input.agent ?? input.subagent_type ?? "").trim().toLowerCase()
  if (role !== "build" && role !== "explore" && role !== "orchestrator") return
  const task = String(input.task ?? input.prompt ?? input.description ?? input.title ?? "").trim()
  if (!task) return
  const picked = pickAvailableModel(role === "orchestrator" ? `orchestrate and plan: ${task}` : task, models, telemetry)
  if (!picked) return
  const model = `${picked.model.providerID}/${picked.model.modelID}`
  input.model = model
  if (picked.model.variant) input.variant = picked.model.variant
  return model
}

/** Select across the connected-provider catalog. Favorites are presentation metadata only. */
export function pickAvailableModel(task: string, models: CatalogModel[], telemetry: Record<string, UsageTelemetry> = {}, explicit?: string) {
  const keyOf = (m: CatalogModel) => `${m.providerID}/${m.modelID}${m.variant ? `#${m.variant}` : ""}`
  const named = explicit ? models.find((m) => keyOf(m).toLowerCase() === explicit.toLowerCase() || (`${m.providerID}/${m.modelID}`.toLowerCase() === explicit.toLowerCase() && !m.variant)) : undefined
  if (explicit && !named) throw new Error(`Requested model is not in the authoritative provider catalog: ${explicit}`)
  if (named) return { model: named, reason: `explicit user choice: ${exactIdentity(named)}` }
  const text = task.toLowerCase()
  const planning = /orchestrat|architect|plan(?:ning)?|hard reason|complex reason|strategy|design review/.test(text)
  const healthySubscription = models.some((model) => isSubscriptionProvider(model.providerID) && telemetry[keyOf(model)]?.capacity === "available")
  const scored = models.filter((m) => !m.harness).map((model) => {
    const usage = telemetry[keyOf(model)] ?? {}; let score = 0
    const fit = (re: RegExp, cap: keyof NonNullable<CatalogModel["capabilities"]>, points: number) => { if (re.test(text) && model.capabilities?.[cap] === true) score += points }
    fit(/vision|image|visual/, "vision", 30); fit(/reason|architect|hard|debug|long rewrite/, "reasoning", 24); fit(/tool|code|implement|test|refactor/, "tools", 18); fit(/schema|json|contract/, "structured", 16)
    if (typeof model.context === "number" && /long|huge|1m|context/.test(text)) score += Math.min(20, model.context / 100_000)
    if (typeof model.priceOutput === "number") score -= Math.min(18, model.priceOutput)
    if (usage.capacity === "exhausted") score -= 100
    if (usage.capacity === "resetting") score += usage.resetAt && usage.resetAt <= Date.now() + 15 * 60_000 ? 8 : -25
    if (usage.capacity === "unknown" || usage.capacity == null) score -= 4
    if (usage.authenticated === false) score -= 100
    if (typeof usage.recentSuccess === "number") score += Math.max(-10, Math.min(10, usage.recentSuccess * 10))
    if (usage.capacity === "available") score += 35
    if (healthySubscription && overlayProviderLane(model.providerID) === "metered") score -= 120
    if (model.providerID === "openai" && /gpt-5\.6-sol/i.test(model.modelID)) score += planning ? 90 : -35
    if (model.providerID === "openai" && /gpt-5\.6-luna-fast/i.test(model.modelID)) score += planning ? 10 : 85
    return { model, score }
  }).sort((a, b) => b.score - a.score || (a.model.priceOutput ?? Infinity) - (b.model.priceOutput ?? Infinity))
  const best = scored.find((x) => telemetry[keyOf(x.model)]?.capacity !== "exhausted" && telemetry[keyOf(x.model)]?.authenticated !== false)
  return best ? { model: best.model, reason: `dynamic task fit ${best.score.toFixed(1)}; telemetry is ${telemetry[keyOf(best.model)]?.capacity ?? "unknown"}` } : undefined
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

type CacheFile = { updated: string; models: CacheEntry[] }

const HERE = dirname(fileURLToPath(import.meta.url))
const PROFILES_FILE = join(HERE, "model-profiles.json")
const CACHE_FILE = join(HERE, "models-cache.json")

const LANE_LABEL: Record<CostLane, string> = {
  "go-quota": "Go-quota",
  sub: "Sub",
  free: "Free",
  metered: "Metered",
}

export function modelKey(fav: Fav) {
  return `${fav.providerID}/${fav.modelID}`
}

export function agentName(fav: Fav) {
  return `model-${slug(fav.providerID)}-${slug(fav.modelID)}`
}

export function slug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

export function loadProfiles(): ModelProfile[] {
  if (!existsSync(PROFILES_FILE)) return []
  const parsed = JSON.parse(readFileSync(PROFILES_FILE, "utf8").replace(/^\uFEFF/, ""))
  if (!Array.isArray(parsed.profiles)) return []
  return parsed.profiles.filter(isProfile)
}

function isProfile(value: unknown): value is ModelProfile {
  if (typeof value !== "object" || value === null) return false
  const item = value as Partial<ModelProfile>
  return (
    typeof item.id === "string" &&
    Array.isArray(item.match) &&
    typeof item.name === "string" &&
    (item.lane === "go-quota" || item.lane === "sub" || item.lane === "free" || item.lane === "metered") &&
    typeof item.tier === "string" &&
    typeof item.best === "string" &&
    typeof item.avoid === "string"
  )
}

export function readModelCache(): CacheFile | undefined {
  if (!existsSync(CACHE_FILE)) return
  try {
    const parsed = JSON.parse(readFileSync(CACHE_FILE, "utf8").replace(/^\uFEFF/, ""))
    if (typeof parsed !== "object" || parsed === null) return
    if (!Array.isArray((parsed as CacheFile).models)) return
    return parsed as CacheFile
  } catch {
    return
  }
}

export function writeModelCache(entries: CacheEntry[]) {
  const file: CacheFile = { updated: new Date().toISOString(), models: entries }
  writeFileSync(CACHE_FILE, JSON.stringify(file, null, 2))
  return file
}

export function modelDataFor(fav: Fav, cache = readModelCache()): ModelData | undefined {
  if (!cache) return
  const key = modelKey(fav).toLowerCase()
  const model = slug(fav.modelID)
  const name = slug(fav.modelID)
  const hit = cache.models.find((entry) => {
    const entryKey = entry.key.toLowerCase()
    const entryId = slug(entry.id)
    const entryName = slug(entry.name ?? "")
    if (entryKey === key) return true
    if (entryId === model || entryName === name) return true
    return entryId.length >= 6 && (entryId.includes(model) || model.includes(entryId))
  })
  if (!hit) return
  const data: ModelData = {
    costInput: hit.costInput,
    costOutput: hit.costOutput,
    context: hit.context,
    output: hit.output,
    tools: hit.tools,
    reasoning: hit.reasoning,
    structured: hit.structured,
    source: "models-dev",
  }
  return data
}

export function inferProfile(fav: Fav, profiles = loadProfiles()): ModelProfile {
  const key = modelKey(fav).toLowerCase()
  const model = fav.modelID.toLowerCase()
  const overlay = overlayProviderLane(fav.providerID)
  const hit = profiles.find((profile) =>
    profile.match.some((needle) => {
      const n = needle.toLowerCase()
      return key.includes(n) || model.includes(n)
    }),
  ) ?? fallbackProfile(fav)
  if (!overlay || overlay === hit.lane) return hit
  if (overlay !== "metered") return { ...hit, lane: overlay }
  return {
    ...hit,
    lane: overlay,
    best: `named ${hit.name} OpenRouter twin or last-resort when the home-lane is capped`,
    avoid: "default dispatch — metered pay-per-token; automatic pool must not pick this unless named",
  }
}

function fallbackProfile(fav: Fav): ModelProfile {
  const provider = fav.providerID.toLowerCase()
  const overlay = overlayProviderLane(fav.providerID)
  const lane: CostLane = overlay ?? (provider === "opencode-go" ? "go-quota" : provider === "opencode" ? "free" : "sub")
  return {
    id: `inferred-${fav.modelID}`,
    match: [fav.modelID],
    name: fav.modelID,
    lane,
    tier: "worker",
    best: "general coding",
    avoid: "unknown strengths — prefer a curated profile if one fits",
    notes: "No curated profile. Cost data still applies from the models.dev cache.",
  }
}

function ctxLabel(context: number | undefined) {
  if (!context) return "ctx ?"
  const m = context / 1_000_000
  if (m >= 1) return `${m % 1 === 0 ? m : m.toFixed(2)}M ctx`
  return `${Math.round(context / 1000)}k ctx`
}

function priceLabel(input: number | undefined, output: number | undefined) {
  if (typeof input !== "number" || typeof output !== "number") return "price n/a"
  return `$${input}/$${output} per 1M`
}

function capsLabel(data: ModelData | undefined) {
  if (!data) return ""
  const parts: string[] = []
  if (data.tools) parts.push("tools")
  if (data.reasoning) parts.push("reasoning")
  if (data.structured) parts.push("structured")
  return parts.length ? parts.join("+") : ""
}

function effectiveCost(fav: Fav, profile: ModelProfile, cache = readModelCache()) {
  const data = modelDataFor(fav, cache)
  return {
    input: data?.costInput ?? profile.priceInput,
    output: data?.costOutput ?? profile.priceOutput,
    context: data?.context ?? profile.context,
    outputLimit: data?.output ?? profile.output,
    data,
  }
}

export function agentDescription(fav: Fav, profiles = loadProfiles(), cache = readModelCache()) {
  const profile = inferProfile(fav, profiles)
  const cost = effectiveCost(fav, profile, cache)
  const caps = capsLabel(cost.data)
  const parts = [
    `${LANE_LABEL[profile.lane]}/${profile.tier}`,
    ctxLabel(cost.context),
    priceLabel(cost.input, cost.output),
    ...(caps ? [caps] : []),
    `BEST: ${profile.best}`,
    `AVOID: ${profile.avoid}`,
    `Spawn ${profile.name} (${modelKey(fav)}). If the user asks for N of this type, launch all N Task calls in one message.`,
  ]
  return parts.join(" · ")
}

function costRank(fav: Fav, profiles = loadProfiles(), cache = readModelCache()) {
  const profile = inferProfile(fav, profiles)
  const cost = effectiveCost(fav, profile, cache)
  return typeof cost.output === "number" ? cost.output : Number.POSITIVE_INFINITY
}

export function routingCard(favs: Fav[], profiles = loadProfiles(), cache = readModelCache()) {
  const lines = [
    "MODEL ROUTING — pick the cheapest favorite that can do the job.",
    "Prices below are real list $/1M from the models.dev-backed cache, sorted by output price.",
    "Go-quota, Sub, and Free lanes are cheap for you EVEN IF the list price looks big (Luna/Sol/Grok ride subs). Metered = pay-per-token; avoid unless named.",
    'Flash/Pro/fast suffixes are NAMES, not speed or quality guarantees — trust the cost column and curated BEST/AVOID.',
    "If the user names a model, use that. `general` is isolation, not a quality upgrade. `explore` is read-only search.",
    "",
  ]
  if (favs.length === 0) {
    lines.push("No favorited models synced.")
    return lines.join("\n")
  }
  const sorted = favs
    .map((fav) => ({ fav, rank: costRank(fav, profiles, cache) }))
    .toSorted((a, b) => a.rank - b.rank)
  for (const { fav } of sorted) {
    const profile = inferProfile(fav, profiles)
    const cost = effectiveCost(fav, profile, cache)
    const caps = capsLabel(cost.data)
    lines.push(
      [
        `- ${modelKey(fav)}`,
        `${LANE_LABEL[profile.lane]}/${profile.tier}`,
        ctxLabel(cost.context),
        priceLabel(cost.input, cost.output),
        ...(caps ? [caps] : []),
        `BEST: ${profile.best}`,
        `AVOID: ${profile.avoid}`,
      ].join(" · "),
    )
  }
  lines.push("")
  lines.push(
    "DEFAULT: Muse Spark 1.2 Contributor for ~90% of tasks — impl, tests, refactors, debug, UI/HUD, frontend, scene/codegen, grunt, bulk edits, docs, parallel fan-out, most coding (also most ops). GLM Flash only for tiny utility/ops when explicitly requesting cheapest 1M run — not default. Grok 4.6 (grok-sub only, never xai/*) only for hard debugging/long rewrites/when Muse shortcuts. DeepSeek Flash not default (Muse replaces it). Design/creativity/architecture -> Kimi K3 (slow, deliberate). Review -> hy3 (luna-fast while Go capped). Escalate Luna/Sol only when named or cheaper already failed.",
  )
  lines.push(
    "Curation lives in model-profiles.json; costs come from models-cache.json (auto-refreshed from models.dev). Edit profiles, then `bun favorite-agents.ts sync`.",
  )
  return lines.join("\n")
}

export function pickModel(
  task: string,
  favs: Fav[],
  profiles = loadProfiles(),
  cache = readModelCache(),
): { agent: string; model?: string; reason: string; profile: ModelProfile; outputCost: number | undefined } | undefined {
  const text = task.toLowerCase()
  const named = favs.find((fav) => {
    const profile = inferProfile(fav, profiles)
    return [fav.modelID, fav.providerID, profile.name, profile.id].some((part) =>
      text.includes(part.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()),
    )
  })
  if (named) {
    return {
      agent: inferProfile(named, profiles).tier === "explore" ? "explore" : "build",
      model: modelKey(named),
      reason: `user named ${modelKey(named)}`,
      profile: inferProfile(named, profiles),
      outputCost: effectiveCost(named, inferProfile(named, profiles), cache).output,
    }
  }

  const scored = favs
    .map((fav) => {
      const profile = inferProfile(fav, profiles)
      const cost = effectiveCost(fav, profile, cache)
      let score = 0
      if (profile.lane === "go-quota") score += 22
      if (profile.lane === "free") score += 24
      if (profile.lane === "sub") score += 16
      if (profile.lane === "metered") score -= 40

      const out = cost.output
      if (typeof out === "number") {
        if (out <= 0.3) score += 6
        else if (out <= 2) score -= 8
        else score -= 28
        if (profile.lane === "go-quota" && out > 2) score -= 12
      }

      const wantPrecise = /schema|type|contract|fail-?closed|fidelity|instruction/.test(text)
      const wantUi = /\bui\b|hud|frontend|css|react|scene|visual|player|hud/.test(text)
      const wantHeavy = /architect|long-?horizon|huge context|multimodal|vision|1m context|hard agentic|hard debug|long rewrite|big rewrite|reasoning-heavy|shortcut/.test(text)
      const wantUtility = /git|commit|verify|smoke|deploy|status|cleanup|rebase|merge|release|format|lint|typecheck|tripwire|check/.test(text)
      const wantCreative = /design|creative|creativ|concept|direction|aesthetic|art|novel|wireframe/.test(text)
      const wantGrunt = /impl|test|refactor|grunt|bulk|parallel|loop|motor|docs|mechanical|migrate/.test(text)
      const wantExplore = /preview|throwaway|second opinion/.test(text)
      const isMuse = profile.id === "muse-spark"

      // Muse is default workhorse for ~90% of tasks — boost unless task truly wants heavy/precise
      if (isMuse && !wantHeavy && !wantPrecise) score += 28
      if (isMuse && (wantGrunt || wantUtility || wantUi)) score += 10

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
      return { fav, profile, score, outputCost: out }
    })
    .toSorted((a, b) => b.score - a.score || (a.outputCost ?? Infinity) - (b.outputCost ?? Infinity))

  const best = scored[0]
  if (!best) return
  return {
    agent: best.profile.tier === "explore" ? "explore" : "build",
    model: modelKey(best.fav),
    reason: `${best.profile.name} scored ${best.score} (cost ` +
      (typeof best.outputCost === "number" ? `$${best.outputCost}/1M out` : "n/a") + ")",
    profile: best.profile,
    outputCost: best.outputCost,
  }
}

const AGENTS_MARK_START = "<!-- model-routing:start -->"
const AGENTS_MARK_END = "<!-- model-routing:end -->"

export function upsertAgentsRouting(existing: string, card: string) {
  const block = [
    AGENTS_MARK_START,
    "",
    "### Model routing",
    "",
    card,
    "",
    "Load the `model-routing` skill when the choice is not obvious. Agent `description` fields repeat lane/tier/cost/BEST/AVOID so the Task tool can see them.",
    "",
    AGENTS_MARK_END,
  ].join("\n")
  if (existing.includes(AGENTS_MARK_START) && existing.includes(AGENTS_MARK_END)) {
    return existing.replace(
      new RegExp(`${escapeRegExp(AGENTS_MARK_START)}[\\s\\S]*?${escapeRegExp(AGENTS_MARK_END)}`),
      block,
    )
  }
  if (existing.includes("## Subagents")) {
    return existing.replace("## Subagents", `## Subagents\n\n${block}\n`)
  }
  return `${existing.trimEnd()}\n\n${block}\n`
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export async function pullModelsDev(): Promise<CacheFile | undefined> {
  const response = await fetch("https://models.dev/api.json", { signal: AbortSignal.timeout(20_000) })
  if (!response.ok) return
  const json: unknown = await response.json()
  const entries = parseModelsDev(json)
  if (!entries) return
  return writeModelCache(entries)
}

function parseModelsDev(json: unknown): CacheEntry[] | undefined {
  const root = recordOf(json)
  if (!root) return
  const entries: CacheEntry[] = []
  for (const [providerKey, providerValue] of Object.entries(root)) {
    const provider = recordOf(providerValue)
    const models = recordOf(provider?.models)
    if (!models) continue
    for (const [modelKey, modelValue] of Object.entries(models)) {
      const entryValue = recordOf(modelValue)
      if (!entryValue) continue
      const cost = recordOf(entryValue.cost)
      const limit = recordOf(entryValue.limit)
      if (!cost && !limit) continue
      const id = typeof entryValue.id === "string" ? entryValue.id : modelKey
      entries.push({
        key: `${providerKey}/${id}`.toLowerCase(),
        id,
        name: typeof entryValue.name === "string" ? entryValue.name : undefined,
        costInput: typeof cost?.input === "number" ? cost.input : undefined,
        costOutput: typeof cost?.output === "number" ? cost.output : undefined,
        context: typeof limit?.context === "number" ? limit.context : undefined,
        output: typeof limit?.output === "number" ? limit.output : undefined,
        tools: entryValue.tool_call === true ? true : undefined,
        reasoning: entryValue.reasoning === true ? true : undefined,
        structured: entryValue.structured_output === true ? true : undefined,
      })
    }
  }
  return entries.length ? entries : undefined
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return
  return value as Record<string, unknown>
}
