/**
 * One supervised, non-interactive turn against any registered harness CLI.
 *
 * Claude Code keeps its own richer path in claude-code-task.ts (scope
 * envelopes, session resume, the ledger). This is the plain path the other
 * harnesses need: run the CLI, get the text, classify failures with the same
 * blanket vocabulary so no harness leaks a status code.
 */
import { accessSync, existsSync } from "node:fs"
import { delimiter, isAbsolute, join, resolve } from "node:path"
import { superviseForeground } from "../scripts/foreground-supervisor"
import { recordHang } from "./papercut-memory"
import { harnessFor, harnessList, type HarnessSpec, type HarnessStreamEvent } from "../harnesses"
import { isUsageReached, usageReachedMessage } from "../usage/usage-reached"

const SAFE_ENV = ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "HOME", "HOMEDRIVE", "HOMEPATH", "USERPROFILE", "USERNAME", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "LANG", "LC_ALL", "TERM", "ComSpec", "COMSPEC"]
/** Each harness inherits only its own vendor's credentials — never another's. */
const AUTH_PREFIXES: Record<string, string[]> = {
  "claude-code": ["CLAUDE_", "ANTHROPIC_"],
  "grok-build": ["GROK_", "XAI_"],
  codex: ["CODEX_", "OPENAI_"],
}
const TURN_TIMEOUT_MS = 15 * 60 * 1000
const PROBE_TIMEOUT_MS = 8_000
const MAX_OUTPUT = 2 * 1024 * 1024

export const redact = (text: string) =>
  text.replace(/(authorization\s*[:=]\s*bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/(api[_-]?key|token|secret|password)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2[REDACTED]")

export function resolveHarnessExecutable(name: string, environment: NodeJS.ProcessEnv = process.env): string | undefined {
  if (isAbsolute(name)) { try { accessSync(name); return resolve(name) } catch { return undefined } }
  const exts = process.platform === "win32" ? (environment.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""]
  for (const dir of (environment.PATH ?? environment.Path ?? "").split(delimiter)) {
    for (const ext of exts) {
      const candidate = join(dir, name + (ext && !name.toLowerCase().endsWith(ext.toLowerCase()) ? ext : ""))
      if (existsSync(candidate)) return resolve(candidate)
    }
  }
  return undefined
}

function harnessEnv(spec: HarnessSpec, input: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const prefixes = AUTH_PREFIXES[spec.id] ?? []
  return Object.fromEntries(
    Object.entries(input).filter(([key, value]) =>
      value && (SAFE_ENV.includes(key) || prefixes.some((p) => key.toUpperCase().startsWith(p)))),
  ) as NodeJS.ProcessEnv
}

export type HarnessStatus = {
  id: string
  label: string
  provider: string
  available: boolean
  models: Array<{ id: string; name: string }>
  detail: string
}

export async function discoverHarness(id: string): Promise<HarnessStatus | undefined> {
  const spec = harnessFor(id)
  if (!spec) return undefined
  const executable = resolveHarnessExecutable(spec.executable)
  if (!executable) {
    return { id: spec.id, label: spec.label, provider: spec.provider, available: false, models: spec.models, detail: `client-not-started: ${spec.executable} was not found on PATH` }
  }
  const probe = await superviseForeground(executable, spec.versionArgs, {
    cwd: process.cwd(), env: harnessEnv(spec), timeoutMs: PROBE_TIMEOUT_MS, leaseMs: PROBE_TIMEOUT_MS,
  }).catch(() => undefined)
  const available = probe?.code === 0
  return {
    id: spec.id,
    label: spec.label,
    provider: spec.provider,
    available,
    models: spec.models,
    detail: available ? `available (${redact((probe?.stdout ?? "").trim()) || "version unknown"})` : "client-not-started: version probe failed",
  }
}

export async function discoverHarnesses(): Promise<HarnessStatus[]> {
  return (await Promise.all(harnessList().map((spec) => discoverHarness(spec.id)))).filter((x): x is HarnessStatus => !!x)
}

/** Last error message a JSONL harness stream reported, unwrapping nested JSON payloads. */
export function streamErrorMessage(stdout: string): string | undefined {
  let found: string | undefined
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const v = JSON.parse(line)
      const raw = v?.type === "error" ? v.message
        : v?.error?.message ?? (v?.item?.type === "error" ? v.item.message : undefined)
      if (typeof raw !== "string") continue
      // Some CLIs stuff a whole JSON error document into the message string.
      try {
        const inner = JSON.parse(raw)
        found = typeof inner?.error?.message === "string" ? inner.error.message : raw
      } catch { found = raw }
    } catch { /* progress noise */ }
  }
  return found ? redact(found).trim().slice(0, 400) : undefined
}

export class HarnessError extends Error {
  constructor(readonly kind: "blocked" | "failed" | "cancelled", message: string) {
    super(message)
    this.name = "HarnessError"
  }
}

/**
 * Map a supervisor stdout line through the harness's stream-event vocabulary.
 * Returns undefined unless the caller wants live events AND the spec knows how
 * to translate this CLI's dialect — buffering callers are unaffected.
 */
export function wireStreamEvents(spec: HarnessSpec, onEvent: ((event: HarnessStreamEvent) => void) | undefined): ((line: string) => void) | undefined {
  if (!onEvent || (!spec.streamEvent && !spec.streamEventLine)) return undefined
  return (line: string) => {
    if (!line.trim()) return
    let event: HarnessStreamEvent | undefined
    try { event = spec.streamEvent?.(JSON.parse(line)) } catch { /* plain-text output or non-JSON progress chatter */ }
    if (!event) event = spec.streamEventLine?.(line)
    if (event) onEvent(event)
  }
}

export type HarnessRunInput = { harness: string; prompt: string; cwd?: string; model?: string; sessionId?: string; resumed?: boolean }
export type HarnessRunContext = { abortSignal?: AbortSignal; sessionID?: string; onHeartbeat?: () => void; onEvent?: (event: HarnessStreamEvent) => void }

async function runHarnessOnce(spec: HarnessSpec, executable: string, input: HarnessRunInput, context: HarnessRunContext, sessionId: string | undefined, resumed: boolean | undefined): Promise<{ text: string; harness: string }> {
  const args = spec.args({ model: input.model, sessionId, resumed })
  const result = await superviseForeground(executable, args, {
    cwd: input.cwd || process.cwd(),
    env: harnessEnv(spec),
    input: spec.promptOnStdin ? input.prompt : undefined,
    sessionID: context.sessionID,
    abortSignal: context.abortSignal,
    timeoutMs: TURN_TIMEOUT_MS,
    leaseMs: 30_000,
    onHeartbeat: context.onHeartbeat,
    onStdoutLine: wireStreamEvents(spec, context.onEvent),
    onBlocked: (event) => { try { recordHang({ command: event.command, cwd: input.cwd || process.cwd(), sessionID: event.sessionID ?? context.sessionID, startedAt: new Date(Date.now() - event.elapsedMs).toISOString() }, event.elapsedMs) } catch { /* papercut memory must never affect execution */ } },
  })
  const stdout = result.stdout.slice(-MAX_OUTPUT)
  const stderr = result.stderr.slice(-MAX_OUTPUT)
  if (result.timedOut) throw new HarnessError("failed", `${spec.label} timed out after ${TURN_TIMEOUT_MS} ms.`)
  if (context.abortSignal?.aborted) throw new HarnessError("cancelled", `${spec.label} cancelled.`)

  const blob = `${stdout}\n${stderr}`
  if (isUsageReached(blob)) {
    throw new HarnessError("failed", usageReachedMessage({ providerID: spec.provider, modelID: input.model ?? spec.models[0]?.id }))
  }
  if (result.code !== 0) {
    // stderr is mostly progress chatter ("Reading prompt from stdin..."); the
    // CLI's own structured error is the one worth reporting.
    const reported = streamErrorMessage(stdout) ?? redact(stderr).trim()
    throw new HarnessError("failed", `provider: ${reported || `${spec.label} exited with code ${result.code}.`}`)
  }
  const text = spec.parse(stdout)
  if (!text.trim()) {
    // An in-band failure with exit 0 and no prose (a terminal error event
    // carrying no `result`) still deserves its real message, not "returned
    // no text" — the stream and stderr are the only places it can live.
    const reported = streamErrorMessage(stdout) ?? redact(stderr).trim()
    throw new HarnessError("failed", reported ? `provider: ${reported}` : `${spec.label} returned no text.`)
  }
  return { text: redact(text), harness: spec.id }
}

export async function runHarness(input: HarnessRunInput, context: HarnessRunContext = {}, retryFreshSession = true): Promise<{ text: string; harness: string }> {
  const spec = harnessFor(input.harness)
  if (!spec) throw new HarnessError("blocked", `Unknown harness: ${String(input.harness)}`)
  if (!input.prompt?.trim()) throw new HarnessError("blocked", `${spec.label} prompt must not be empty.`)
  const executable = resolveHarnessExecutable(spec.executable)
  if (!executable) throw new HarnessError("blocked", `client-not-started: ${spec.executable} was not found. Install and authenticate ${spec.label} normally.`)

  try {
    return await runHarnessOnce(spec, executable, input, context, input.sessionId, input.resumed)
  } catch (error) {
    // A poisoned session mapping makes every retry hit the same wall: the CLI
    // reports "this session does not exist" before doing any work. One
    // downgrade to a fresh conversation per turn is the cure; the guard keeps
    // it from ever looping.
    if (retryFreshSession && input.sessionId && error instanceof HarnessError && error.kind === "failed" && spec.sessionNotFound?.test(error.message)) {
      return runHarness({ ...input, sessionId: undefined, resumed: false }, context, false)
    }
    throw error
  }
}
