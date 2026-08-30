/**
 * One blanket vocabulary for "we ran out of usage".
 *
 * Providers spell exhaustion a dozen ways — 402, 403, 429, "resource
 * exhausted", "5-hour usage limit", "insufficient credits". None of that is
 * useful to read. Everything that means *the plan is spent* collapses to a
 * single `Usage reached — <provider/model>` line plus the failover target.
 * Raw status codes and provider snippets never reach the user.
 */

export const USAGE_REACHED = "Usage reached"

/** Anything that means the plan/quota/credits are spent, in any provider dialect. */
const USAGE_RE = new RegExp(
  [
    // explicit windowed limits
    /\d+\s*-?\s*(hour|day|week|month)ly?\s+usage\s+limit/.source,
    /(5-hour|weekly|7-day|monthly|daily)\s+usage\s+limit/.source,
    /usage\s+limit\s+(reached|exceeded|hit)/.source,
    // "You've hit your usage limit" (Codex) — the verb leads instead of trails.
    /(hit|reached|exceeded|past|over)\s+(your|the|its)?\s*\w*\s*usage\s+limit/.source,
    // "usage balance exhausted" (Grok Build)
    /usage\s+balance\s+exhausted/.source,
    // generic quota / credit / capacity language
    /quota\s+(exceeded|reached|exhausted)/.source,
    /out\s+of\s+(quota|credits?)/.source,
    /insufficient\s+(quota|credits?|balance|funds)/.source,
    /resource.?exhausted/.source,
    /rate.?limit(ed|\s+exceeded|\s+reached)?/.source,
    /too\s+many\s+requests/.source,
    /over\s+capacity/.source,
    /billing\s+(hard\s+)?limit/.source,
    /credit\s+balance\s+is\s+too\s+low/.source,
    // status codes, in the shapes providers actually emit them
    /"?(status|statusCode|code)"?\s*[:=]\s*"?(402|403|429)"?\b/.source,
    /\bHTTP\s+(402|403|429)\b/.source,
    /\b(402|403|429)\s+(Payment\s+Required|Forbidden|Too\s+Many\s+Requests)\b/.source,
  ].join("|"),
  "i",
)

/** A provider blew up for a reason that is not exhaustion. Still summarized, never dumped. */
const PROVIDER_RE = /\b(apierror|provider (error|returned)|returned error|upstream error|internal server error|"?status(Code)?"?\s*[:=]\s*"?5\d\d"?)\b/i

const KNOWN_PROVIDERS = [
  "opencode-go",
  "grok-sub",
  "claude-code",
  "openrouter",
  "openai",
  "anthropic",
  "cursor",
  "opencode",
  "xai",
]

export type FailureKind = "usage" | "provider"
export type ProviderFailure = {
  kind: FailureKind
  providerID?: string
  modelID?: string
  /** Redacted, bounded excerpt. For logs and papercuts only — never shown verbatim to the user. */
  detail: string
}

function excerpt(blob: string, index: number): string {
  const start = Math.max(0, index - 40)
  return blob.slice(start, start + 400).replace(/\s+/g, " ").trim()
}

/** Pull `provider/model` out of a provider error blob without inventing one. */
export function providerModelFromBlob(blob: string): { providerID?: string; modelID?: string } {
  const providerID =
    /"providerID"\s*:\s*"([^"]+)"/i.exec(blob)?.[1] ??
    KNOWN_PROVIDERS.find((id) => new RegExp(`\\b${id.replace(/[-/]/g, "[-/]")}\\b`, "i").test(blob))
  const modelID =
    /"modelID"\s*:\s*"([^"]+)"/i.exec(blob)?.[1] ??
    /"model"\s*:\s*"([^"]+)"/i.exec(blob)?.[1] ??
    (providerID ? new RegExp(`${providerID}/([\\w.:-]+)`, "i").exec(blob)?.[1] : undefined)
  return { providerID, modelID }
}

/**
 * Classify a provider failure blob. Exhaustion wins over generic provider
 * errors: a 403 that also says "internal error" is still usage reached.
 */
export function detectProviderFailure(blob: string): ProviderFailure | undefined {
  if (!blob) return
  const usage = USAGE_RE.exec(blob)
  if (usage) return { kind: "usage", ...providerModelFromBlob(blob), detail: excerpt(blob, usage.index) }

  const generic =
    PROVIDER_RE.exec(blob) ??
    /opencode-go[\s\S]{0,200}(apierror|provider (error|returned)|returned error)/i.exec(blob) ??
    /(apierror|provider (error|returned)|returned error)[\s\S]{0,200}opencode-go/i.exec(blob)
  if (generic) return { kind: "provider", ...providerModelFromBlob(blob), detail: excerpt(blob, generic.index) }
  return
}

export function failureTarget(failure: Pick<ProviderFailure, "providerID" | "modelID">): string {
  if (failure.providerID && failure.modelID) return `${failure.providerID}/${failure.modelID}`
  return failure.providerID ?? failure.modelID ?? "the current model"
}

/**
 * The one line a user ever sees for exhaustion. No status codes, no provider
 * prose — just what ran out and what picks the work up.
 */
export function usageReachedMessage(
  failure: Pick<ProviderFailure, "providerID" | "modelID">,
  fallback?: { providerID: string; modelID: string },
): string {
  const spent = failureTarget(failure)
  return fallback
    ? `${USAGE_REACHED} — ${spent}. Falling over to ${fallback.providerID}/${fallback.modelID}.`
    : `${USAGE_REACHED} — ${spent}. No healthy failover target is available; this work is paused until the window resets.`
}

/** Summary line for a non-exhaustion provider failure. Still bounded, still no raw dump. */
export function providerFailureMessage(
  failure: Pick<ProviderFailure, "providerID" | "modelID">,
  fallback?: { providerID: string; modelID: string },
): string {
  const failed = failureTarget(failure)
  return fallback
    ? `Provider unavailable — ${failed}. Falling over to ${fallback.providerID}/${fallback.modelID}.`
    : `Provider unavailable — ${failed}. No healthy failover target is available.`
}

/** User-facing text for either kind, so callers never branch on status codes. */
export function failureMessage(
  failure: ProviderFailure,
  fallback?: { providerID: string; modelID: string },
): string {
  return failure.kind === "usage" ? usageReachedMessage(failure, fallback) : providerFailureMessage(failure, fallback)
}

export function isUsageReached(blob: string): boolean {
  return detectProviderFailure(blob)?.kind === "usage"
}
