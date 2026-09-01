/** The harness index. One entry per CLI; the entries themselves live one file each. */
import { claudeCode } from "./claude-code"
import { codex } from "./codex"
import { grokBuild } from "./grok-build"
import type { HarnessID, HarnessSpec } from "./types"

export { parseJsonl } from "./types"
export type { HarnessID, HarnessModel, HarnessSpec, HarnessStreamEvent } from "./types"
export * from "./opencode-mcp"

export const HARNESSES: Record<HarnessID, HarnessSpec> = {
  "claude-code": claudeCode,
  "grok-build": grokBuild,
  codex,
}

export function harnessList(): HarnessSpec[] {
  return Object.values(HARNESSES)
}

export function harnessFor(id: string): HarnessSpec | undefined {
  return HARNESSES[id as HarnessID]
}

/** Resolve `provider/model` (or a bare provider) to the harness that serves it. */
export function harnessForProvider(providerID: string): HarnessSpec | undefined {
  return harnessList().find((h) => h.provider === providerID)
}

const ALIASES: Record<string, HarnessID> = {
  claude: "claude-code",
  "claude code": "claude-code",
  "claude code harness": "claude-code",
  harness: "claude-code",
  grok: "grok-build",
  "grok build": "grok-build",
  "grok cli": "grok-build",
  codex: "codex",
  "codex cli": "codex",
  "openai codex": "codex",
}

export function resolveHarnessName(name: unknown): HarnessID | undefined {
  const normalized = String(name ?? "").trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ")
  if (!normalized) return undefined
  return ALIASES[normalized] ?? (normalized in HARNESSES ? normalized as HarnessID : undefined)
}
