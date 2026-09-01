import { accessSync, existsSync } from "node:fs"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { delimiter, isAbsolute, join, resolve } from "node:path"
import { homedir, tmpdir } from "node:os"
import { appendLedger, claimCompletionDelivery, completionEvidence, recordCompletionDelivered, recordHeartbeat, recordLifecycle, recordNotification } from "../orchestration/orchestration-ledger"
import { normalizeScope, stringList, validateContinuation, type TaskScopeManifest } from "../orchestration/task-scope"
import { superviseForeground } from "../scripts/foreground-supervisor"
import { recordHang } from "./papercut-memory"
import { canonicalWorkerTitle, claudeModelAlias, workerIdentityFromEvent } from "../orchestration/dispatch"
import { harnessFor, mcpConfigForWrapper } from "../harnesses"
import { wireStreamEvents } from "./harness-run"
import { isUsageReached, usageReachedMessage } from "../usage/usage-reached"

const SAFE_ENV = ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "HOME", "HOMEDRIVE", "HOMEPATH", "USERPROFILE", "USERNAME", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "LANG", "LC_ALL", "TERM", "ComSpec", "COMSPEC"]
const AUTH_PREFIXES = ["CLAUDE_", "ANTHROPIC_"]
const sessionFile = () => join(process.env.LOCALAPPDATA ?? process.env.HOME ?? process.cwd(), "opencode", "claude-code-sessions.json")
const MAX_OUTPUT = 2 * 1024 * 1024
const PROBE_LIMIT = 128 * 1024
const PROBE_TIMEOUT_MS = 8_000
/** The one description of how to drive this CLI. Never re-spelled by hand. */
const SPEC = harnessFor("claude-code")!

import type { HarnessStreamEvent } from "../harnesses"

/** Hand the CLI an MCP server so the harness can spawn opencode subagents back through us. */
async function mcpConfigPathFor(parentSessionId?: string, cwd?: string): Promise<string | undefined> {
  try {
    const wrapper = join(homedir(), ".config", "opencode", "harnesses", "opencode-mcp-stdio.mjs")
    if (!existsSync(wrapper)) return undefined
    const file = join(tmpdir(), `opencode-mcp-${randomUUID()}.json`)
    await writeFile(file, JSON.stringify(mcpConfigForWrapper(wrapper, parentSessionId, cwd), null, 2), "utf8")
    return file
  } catch { return undefined }
}

export type ClaudeCodeTaskInput = { task: string; cwd?: string; constraints?: string; verification?: string; sessionKey?: string; resume?: boolean; model?: string; scope?: TaskScopeManifest; followUpKind?: string; executable?: string; executableArgs?: string[] }
export type ClaudeCodeTaskContext = { sessionID?: string; callID?: string; abortSignal?: AbortSignal; signal?: AbortSignal; onHeartbeat?: () => void; onEvent?: (event: HarnessStreamEvent) => void; onBlocked?: (event: { sessionID?: string; command: string; elapsedMs: number; state: "BLOCKED/HUNG" }) => void }
export type ClaudeCodeCliInput = { prompt: string; cwd?: string; sessionKey?: string; sessionId?: string; resumed?: boolean; model?: string; sessionRecord?: { model?: string; scope?: TaskScopeManifest }; executable?: string; executableArgs?: string[] }
export type ClaudeCodeCliResult = { text: string; sessionId?: string; runID: string; output: string }
export class ClaudeCodeCliError extends Error {
  constructor(readonly kind: "blocked" | "failed" | "cancelled", message: string) {
    super(message)
    this.name = "ClaudeCodeCliError"
  }
}
export type ClaudeRuntimeModel = { id: string; alias?: string; name?: string; source: "official-cli" }
export type ClaudeRuntimeStatus = { registered: true; runtime: "claude-code"; available: boolean; authenticated: boolean | "unknown"; capacity: "available" | "unavailable" | "unknown"; models: ClaudeRuntimeModel[]; detail: string; usage?: unknown }
export type ClaudeRuntimeRegistration = { id: "claude-code"; label: "Claude Code (Harness)"; runtime: "claude-code"; discover: typeof discoverClaudeRuntime }

export function resolveClaudeCodeWorkerName(name: unknown): "claude-code" | undefined {
  const normalized = String(name ?? "").trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ")
  return ["claude", "claude code", "claude code harness", "harness"].includes(normalized) ? "claude-code" : undefined
}
export function resolveClaudeExecutable(input?: string, environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const requested = input?.trim() || "claude"
  if (isAbsolute(requested)) { try { accessSync(requested); return resolve(requested) } catch { return undefined } }
  for (const dir of (environment.PATH ?? environment.Path ?? "").split(delimiter)) for (const ext of process.platform === "win32" ? (environment.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""]) {
    const candidate = join(dir, requested + (ext && !requested.toLowerCase().endsWith(ext.toLowerCase()) ? ext : ""))
    if (existsSync(candidate)) return resolve(candidate)
  }
  return undefined
}
function isAuthKey(key: string) {
  const upper = key.toUpperCase()
  return AUTH_PREFIXES.some((prefix) => upper.startsWith(prefix))
}
const safeEnv = (input: NodeJS.ProcessEnv) => Object.fromEntries(Object.entries(input).filter(([key, value]) => value && (SAFE_ENV.includes(key) || isAuthKey(key)))) as NodeJS.ProcessEnv
const redact = (text: string) => text.replace(/(authorization\s*[:=]\s*bearer\s+)[^\s]+/gi, "$1[REDACTED]").replace(/(api[_-]?key|token|secret|password)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2[REDACTED]")

async function invoke(executable: string, args: string[], cwd = process.cwd(), timeout = PROBE_TIMEOUT_MS) {
  try {
    const result = await superviseForeground(executable, args, { cwd, env: safeEnv(process.env), timeoutMs: timeout, leaseMs: Math.min(5_000, timeout) })
    return { ...result, stdout: result.stdout.slice(-PROBE_LIMIT), stderr: result.stderr.slice(-PROBE_LIMIT) }
  } catch (error) { return { code: 1, stdout: "", stderr: "", error: error as Error } }
}

function parseModels(text: string): ClaudeRuntimeModel[] {
  const found = new Map<string, ClaudeRuntimeModel>()
  const add = (id: string, alias?: string, name?: string) => { if (id && !/[<>$]/.test(id)) found.set(`${alias ?? ""}:${id}`, { id, alias, name, source: "official-cli" }) }
  try {
    const value = JSON.parse(text); const rows = Array.isArray(value) ? value : value?.models ?? value?.data ?? []
    if (Array.isArray(rows)) for (const row of rows) if (typeof row === "string") add(row); else if (row?.id || row?.model) add(String(row.id ?? row.model), row.alias, row.name)
  } catch { /* help text is handled below */ }
  for (const alias of text.match(/\b(?:opus|sonnet|haiku)(?:[-_][\w.-]+)?\b/gi) ?? []) add(alias.toLowerCase(), alias.toLowerCase(), alias)
  return [...found.values()]
}

export function extractSessionId(text: string): string | undefined {
  let id: string | undefined
  for (const line of text.split(/\r?\n/)) {
    try {
      const value = JSON.parse(line)
      const found = value?.session_id ?? value?.sessionId ?? value?.event?.session_id
      if (typeof found === "string" && found.trim()) id = found.trim()
    } catch { /* non-JSON stream chunks are ignored */ }
  }
  return id
}

export type ClaudeStreamResult = { isError: boolean; apiErrorStatus?: number; text?: string; terminalReason?: string; errors?: string[]; subtype?: string }

/** The CLI says a resumed conversation is gone. Recoverable: start a fresh one. */
export function isStaleSession(text: string): boolean {
  // The signature lives on the harness spec so every harness sharing this
  // failure mode can declare it once; no claude-only special case here.
  return SPEC.sessionNotFound?.test(text) ?? false
}
/** The CLI says `--session-id` names a conversation it already has. Recoverable: resume it. */
export function isSessionAlreadyInUse(text: string): boolean {
  return /session id .{0,80}is already in use/i.test(text)
}

/**
 * The CLI reports API failures *in band* and can still exit 0: the terminal
 * `result` event carries `is_error` and `api_error_status` while `subtype`
 * stays "success". Checking only the process exit code turned an expired login
 * into `provider: Claude Code exited with code 1.` — or worse, returned the
 * error prose as if it were the assistant's answer.
 */
export function parseClaudeStreamResult(output: string): ClaudeStreamResult | undefined {
  let found: ClaudeStreamResult | undefined
  for (const line of output.split(/\r?\n/)) {
    try {
      const v = JSON.parse(line)
      if (v?.type !== "result") continue
      found = {
        isError: v.is_error === true || typeof v.api_error_status === "number",
        apiErrorStatus: typeof v.api_error_status === "number" ? v.api_error_status : undefined,
        text: typeof v.result === "string" ? v.result : undefined,
        terminalReason: typeof v.terminal_reason === "string" ? v.terminal_reason : undefined,
        // The failure prose lives here, not in `result`. An error event carries
        // neither `result` nor `terminal_reason`, so reading only those two
        // reported every in-band failure as "(unknown reason)".
        errors: Array.isArray(v.errors) ? v.errors.filter((e: unknown) => typeof e === "string") : undefined,
        subtype: typeof v.subtype === "string" ? v.subtype : undefined,
      }
    } catch { /* non-JSON stream chunks are ignored */ }
  }
  return found
}

/** Turn an in-band CLI failure into the same vocabulary every other provider uses. */
export function classifyStreamResult(result: ClaudeStreamResult): string {
  const text = result.text ?? ""
  const errors = (result.errors ?? []).join("; ")
  // Both, because a terminal error event carries `errors` and no `result`,
  // while a mid-turn API failure carries `result` and no `errors`.
  const said = `${text} ${errors}`
  if (isUsageReached(said) || result.apiErrorStatus === 429) {
    return usageReachedMessage({ providerID: "claude-code", modelID: "claude" })
  }
  if (result.apiErrorStatus === 401 || result.apiErrorStatus === 403 || /authenticat|oauth|token has expired|re-authenticate/i.test(said)) {
    return "auth: Claude Code is signed out or its token expired. Run `claude` and sign in again, then retry."
  }
  const detail = redact(text).trim() || redact(errors).trim()
  // `subtype` ("error_during_execution") is the last thing the CLI still tells
  // us when it names no reason at all; it beats the bare "unknown reason".
  return `provider: ${detail || `Claude Code failed (${result.terminalReason ?? result.subtype ?? "unknown reason"}).`}`
}

/**
 * `--include-partial-messages` emits both the incremental deltas and a terminal
 * `result` holding the same complete text, so concatenating everything returned
 * every answer twice. The terminal result wins when present; the deltas are the
 * fallback for a stream that ended without one — that rule lives in the
 * harness spec, shared with every other JSONL CLI. Redaction is applied here.
 */
export function parseClaudeStreamText(output: string): string {
  return redact(SPEC.parse(output))
}

/**
 * Exhaustion collapses to the same blanket line every other provider path uses
 * — no exit codes, no CLI prose. Other failure classes keep their prefix
 * because they are actionable (auth needs a login, depth needs a new session).
 */
export function classifyFailure(error: string, code: number, context?: { args?: string[]; stdoutTail?: string }): string {
  if (isUsageReached(error)) return usageReachedMessage({ providerID: "claude-code", modelID: "claude" })
  const prefix = /auth|login|unauthorized/i.test(error) ? "auth: "
    : /depth|maximum.*turn|context.*length/i.test(error) ? "depth-limit: "
    : /model/i.test(error) ? "model: "
    : "provider: "
  const detail = redact(error).trim()
  if (detail) return `${prefix}${detail}`
  // A bare exit code is unactionable — "Claude Code exited with code 1" was
  // reported for an expired login, a bad --resume id and an empty stdin
  // alike. When the CLI says nothing, report what we asked it to do.
  const flags = (context?.args ?? []).filter((a) => a.startsWith("--")).join(" ")
  const tail = redact(context?.stdoutTail ?? "").trim().slice(-300)
  const clues = [flags && `flags: ${flags}`, tail && `last output: ${tail}`].filter(Boolean).join(" | ")
  return `${prefix}Claude Code exited with code ${code} and said nothing.${clues ? ` ${clues}` : ""}`
}

function parseAuth(stdout: string, stderr: string, code: number): boolean | "unknown" {
  try {
    const value = JSON.parse(stdout)
    const flag = value?.loggedIn ?? value?.authenticated ?? value?.isAuthenticated
    if (typeof flag === "boolean") return flag
  } catch { /* help/status text is handled below */ }
  if (code === 0) return true
  if (/login|auth|unauthorized|credential/i.test(stderr + stdout)) return false
  return "unknown"
}

/** Uses only documented CLI surfaces. No token files or credential material is read. */
export async function discoverClaudeRuntime(executableInput?: string, executableArgs: string[] = []): Promise<ClaudeRuntimeStatus> {
  const executable = resolveClaudeExecutable(executableInput)
  if (!executable) return { registered: true, runtime: "claude-code", available: false, authenticated: "unknown", capacity: "unknown", models: [], detail: "client-not-started: Claude Code CLI was not found" }
  const version = await invoke(executable, [...executableArgs, "--version"])
  if (version.error || version.code !== 0) return { registered: true, runtime: "claude-code", available: false, authenticated: "unknown", capacity: "unknown", models: [], detail: `client-not-started: ${redact(version.error?.message ?? (version.stderr.trim() || "Claude Code version probe failed"))}` }
  const [help, auth, modelsProbe] = await Promise.all([
    invoke(executable, [...executableArgs, "--help"]),
    invoke(executable, [...executableArgs, "auth", "status", "--json"]),
    invoke(executable, [...executableArgs, "models", "--json"]),
  ])
  const authenticated = parseAuth(auth.stdout, auth.stderr, auth.code)
  const models = parseModels(modelsProbe.stdout + "\n" + help.stdout)
  const detail = authenticated === false ? "auth: Claude Code is installed but not authenticated" : "available; capacity is not exposed by the official CLI"
  return { registered: true, runtime: "claude-code", available: true, authenticated, capacity: "unknown", models, detail, usage: { version: redact(version.stdout.trim()) || "unknown" } }
}
export const claudeCodeRuntimeRegistration: ClaudeRuntimeRegistration = { id: "claude-code", label: "Claude Code (Harness)", runtime: "claude-code", discover: discoverClaudeRuntime }

type StoredSession = { id: string; model?: string; scope?: TaskScopeManifest; resumed?: boolean }
type SessionRecord = { model?: string; scope?: TaskScopeManifest }
const projectKey = (key: string, cwd: string) => `${resolve(cwd)}::${key}`
const readSessionMap = async (file: string): Promise<Record<string, StoredSession | string>> => { try { return JSON.parse(await readFile(file, "utf8")) } catch { return {} } }
async function storedSession(key: string | undefined, cwd: string, resume: boolean, scope?: TaskScopeManifest, model?: string): Promise<StoredSession | undefined> {
  if (!key) return undefined
  const file = sessionFile(); await mkdir(resolve(file, ".."), { recursive: true })
  const map = await readSessionMap(file)
  const prior = map[projectKey(key, cwd)]
  if (resume && prior) return typeof prior === "string" ? { id: prior, resumed: true } : { ...prior, resumed: true }
  // Mint but do NOT persist: the mapping must name a conversation the CLI
  // actually created. Writing the pre-generated id before the run poisoned
  // the map — a first turn that died before Claude persisted anything left a
  // pointer to a conversation that never existed, and every later turn
  // resumed straight into "No conversation found". The record is written by
  // saveRuntimeSession() after a successful turn only.
  return { id: randomUUID(), model, scope, resumed: false }
}
/**
 * Drop a mapping whose Claude conversation does not exist.
 *
 * Every later turn resuming a dead id makes `--resume` fail with "No
 * conversation found", and the failure echoes the same id straight back into
 * the map — so retrying alone never breaks the loop. Forgetting the key is
 * what breaks it.
 */
async function forgetRuntimeSession(key: string | undefined, cwd: string) {
  if (!key) return
  const file = sessionFile()
  try {
    const map = JSON.parse(await readFile(file, "utf8"))
    delete map[`${resolve(cwd)}::${key}`]
    await writeFile(file, JSON.stringify(map), { mode: 0o600 })
  } catch { /* a missing or unreadable map is already "forgotten" */ }
}
/**
 * Record the session id the CLI ACTUALLY created, after a successful turn.
 * Failed runs persist nothing, so a dead conversation can never be adopted as
 * the resume target. The model/scope metadata rides along so continuation
 * validation sees the same record storedSession() used to mint.
 */
async function saveRuntimeSession(key: string | undefined, cwd: string, id: string | undefined, record?: SessionRecord) {
  if (!key || !id) return
  const file = sessionFile(); const lock = `${file}.lock`
  for (let i = 0; i < 200; i++) try {
    await mkdir(lock)
    try {
      const map = await readSessionMap(file)
      const keyName = projectKey(key, cwd)
      const prior = map[keyName]
      const base: SessionRecord = prior && typeof prior === "object" ? { model: prior.model, scope: prior.scope } : {}
      map[keyName] = { ...base, ...(record?.model ? { model: record.model } : {}), ...(record?.scope ? { scope: record.scope } : {}), id }
      await writeFile(`${file}.${process.pid}.tmp`, JSON.stringify(map), { mode: 0o600 }); await rename(`${file}.${process.pid}.tmp`, file)
      return
    } finally { await rm(lock, { recursive: true, force: true }) }
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; await new Promise((r) => setTimeout(r, 5)) }
  throw new Error("Claude Code session state is locked.")
}

/** Chat/session path: resume the mapped Claude session when one exists. No Task scope envelope. */
export async function runClaudeCodeChat(input: Omit<ClaudeCodeCliInput, "sessionId" | "resumed"> & { resume?: boolean }, context: ClaudeCodeTaskContext = {}) {
  const cwd = input.cwd || process.cwd()
  const session = await storedSession(input.sessionKey || context.sessionID, cwd, input.resume !== false, undefined, input.model)
  return runClaudeCodeCli({ ...input, sessionKey: input.sessionKey || context.sessionID, sessionId: session?.id, resumed: session?.resumed, sessionRecord: { model: input.model } }, context)
}

/** Official CLI invoke. No Task scope. Chat and Task both use this; Task wraps ledger/scope. */
export async function runClaudeCodeCli(input: ClaudeCodeCliInput, context: ClaudeCodeTaskContext = {}, healSession = true): Promise<ClaudeCodeCliResult> {
  const runID = `cc_${randomUUID()}`
  const fail = (kind: ClaudeCodeCliError["kind"], message: string): never => { throw new ClaudeCodeCliError(kind, message) }
  if (!input.prompt?.trim()) return fail("blocked", "Claude Code prompt must not be empty.")
  const executable = resolveClaudeExecutable(input.executable)
  if (!executable) return fail("blocked", "client-not-started: Claude Code CLI was not found. Install and authenticate Claude Code normally.")
  const cwd = input.cwd || process.cwd()
  const id = input.sessionId
  const mcpConfigPath = await mcpConfigPathFor(input.sessionKey || context.sessionID, cwd)
  const args = [...(input.executableArgs ?? []), ...SPEC.args({ model: input.model, sessionId: id, resumed: input.resumed, mcpConfigPath })]
  const abort = context.abortSignal || context.signal
  let result: Awaited<ReturnType<typeof superviseForeground>>
  try {
    result = await superviseForeground(executable, args, {
      cwd, env: safeEnv(process.env), input: input.prompt, sessionID: context.sessionID, abortSignal: abort,
      timeoutMs: 15 * 60 * 1000, leaseMs: 30_000, onHeartbeat: context.onHeartbeat, onBlocked: context.onBlocked,
      onStdoutLine: wireStreamEvents(SPEC, context.onEvent),
    })
  } finally {
    if (mcpConfigPath) { try { await rm(mcpConfigPath, { force: true }) } catch {} }
  }
  const output = result.stdout.slice(-MAX_OUTPUT), error = result.stderr.slice(-MAX_OUTPUT), runtimeID = extractSessionId(output)
  if (result.timedOut) return fail("failed", "Claude Code timed out after 900000 ms.")
  if (abort?.aborted) return fail("cancelled", "Claude Code cancelled.")
  // In-band errors are checked before the exit code: the CLI frequently
  // reports an API failure in the terminal `result` event and still exits 0,
  // and its message is far more specific than anything stderr carries.
  const streamResult = parseClaudeStreamResult(output)
  // The CLI's two session-lifecycle failures are both recoverable and both are
  // permanent if handed straight back: `--resume` on a conversation that was
  // never created, and `--session-id` naming one that already exists. Heal
  // once, here, rather than surfacing a dead session as a provider error.
  const sessionKey = input.sessionKey || context.sessionID
  const said = `${error} ${streamResult?.text ?? ""} ${(streamResult?.errors ?? []).join("; ")}`
  if (healSession && sessionKey && !result.timedOut && !abort?.aborted) {
    if (input.resumed && isStaleSession(said)) {
      await forgetRuntimeSession(sessionKey, cwd)
      const fresh = await storedSession(sessionKey, cwd, false, undefined, input.model)
      return runClaudeCodeCli({ ...input, sessionId: fresh?.id, resumed: false }, context, false)
    }
    if (!input.resumed && isSessionAlreadyInUse(said)) {
      return runClaudeCodeCli({ ...input, resumed: true }, context, false)
    }
  }
  if (streamResult?.isError) return fail("failed", classifyStreamResult(streamResult))
  if (result.code !== 0) return fail("failed", classifyFailure(error, result.code, { args, stdoutTail: output.slice(-500) }))
  const text = parseClaudeStreamText(output)
  const sessionId = runtimeID || id
  // Persist only what the CLI actually created, and only on success — a failed
  // run used to record its session id here, and the next turn resumed straight
  // into "No conversation found with session ID".
  await saveRuntimeSession(input.sessionKey || context.sessionID, cwd, sessionId, input.sessionRecord)
  return { text: text || redact(output.trim()), sessionId, runID, output }
}

export async function runClaudeCodeTask(input: ClaudeCodeTaskInput, context: ClaudeCodeTaskContext = {}) {
  const runID = `cc_${randomUUID()}`, parentID = context.sessionID || "opencode", callID = context.callID || runID
  const requestedAlias = claudeModelAlias(input.model)
  const scopeAlias = claudeModelAlias((input.scope as { modelPin?: unknown } | undefined)?.modelPin)
  if (input.model != null && !requestedAlias) throw new Error("Claude Code only accepts its own model aliases: claude, default, opus, sonnet, or haiku.")
  const alias = requestedAlias ?? scopeAlias
  const identity = { agentRole: "claude-code" as const, providerID: "claude-code", modelID: alias ?? "claude", runtime: "claude-code" as const, parentID, runID, task: redact(input.task) }
  const questID = typeof input.scope?.questId === "string" ? input.scope.questId : undefined
  appendLedger({ kind: "spawn", parentID, callID, agent: "claude-code", agentRole: identity.agentRole, providerID: identity.providerID, modelID: identity.modelID, runtime: identity.runtime, runID, task: identity.task, description: canonicalWorkerTitle(identity), questID })
  appendLedger({ kind: "bound", parentID, callID, childID: runID, runtime: "claude-code", runID })
  recordLifecycle(parentID, callID, "accepted", runID)
  const acknowledge = (state: "completed" | "failed" | "cancelled" | "stopped", summary: string) => {
    recordNotification(parentID, callID, runID, state, summary)
    const completion = completionEvidence(parentID, callID, runID)
    if (completion && claimCompletionDelivery(completion)) recordCompletionDelivered(parentID, completion.idempotencyKey)
  }
  const fail = (state: "blocked" | "failed" | "cancelled", message: string): never => {
    recordLifecycle(parentID, callID, state, runID)
    appendLedger({ kind: "terminal", parentID, callID, childID: runID, state })
    acknowledge(state === "blocked" ? "stopped" : state, message)
    throw new Error(message)
  }
  if (!input.task?.trim()) return fail("blocked", "Claude Code task must not be empty.")
  if (!resolveClaudeExecutable(input.executable)) return fail("blocked", "client-not-started: Claude Code CLI was not found. Install and authenticate Claude Code normally.")
  const scope = normalizeScope(input.scope)
  if (!scope) return fail("blocked", "Task scope manifest is required and must include the immutable envelope fields.")
  if (!alias || !scopeAlias) return fail("blocked", "Claude Code only accepts its own model aliases: claude, default, opus, sonnet, or haiku.")
  if (requestedAlias && requestedAlias !== scopeAlias) return fail("blocked", "MODEL_IMMUTABLE: the worker model is pinned by its Task envelope; create a linked replacement session.")
  const model = `claude-code/${alias}`
  const runtimeModel = alias === "claude" || alias === "default" ? undefined : alias
  const cwd = input.cwd || process.cwd(), session = await storedSession(input.sessionKey || context.sessionID, cwd, input.resume === true, scope, model)
  const rejection = input.resume ? validateContinuation(session?.scope, scope, input.followUpKind, model, session?.model) : undefined
  if (rejection) { appendLedger({ kind: "scope-rejected", parentID, callID, childID: runID, errorCode: rejection.code, scopeDelta: rejection.delta, state: "failed" }); return fail("blocked", `${rejection.code}: new-session-required; create a separate Quest/session.`) }
  if (runtimeModel) { const runtime = await discoverClaudeRuntime(input.executable, input.executableArgs); if (runtime.available && runtime.models.length && !runtime.models.some((entry) => entry.id === runtimeModel || entry.alias === runtimeModel)) return fail("blocked", `model: runtime model alias is not exposed by the installed Claude Code client: ${runtimeModel}`) }
  const prompt = [input.task.trim(), input.constraints && `Constraints:\n${input.constraints}`, input.verification && `Verification:\n${input.verification}`].filter(Boolean).join("\n\n")
  recordLifecycle(parentID, callID, "executing", runID)
  try {
    const cli = await runClaudeCodeCli({
      prompt,
      cwd,
      sessionKey: input.sessionKey || context.sessionID,
      sessionId: session?.id,
      resumed: session?.resumed,
      model: runtimeModel,
      sessionRecord: { model, scope },
      executable: input.executable,
      executableArgs: input.executableArgs,
    }, {
      sessionID: parentID,
      callID,
      abortSignal: context.abortSignal,
      signal: context.signal,
      onHeartbeat: () => recordHeartbeat(parentID, callID, runID),
      onEvent: context.onEvent,
      onBlocked: (event) => { recordLifecycle(parentID, callID, "blocked", runID); recordNotification(parentID, callID, runID, "stopped", `${event.state} session=${event.sessionID ?? parentID} command=${event.command} elapsedMs=${event.elapsedMs}`); try { recordHang({ command: event.command, cwd, sessionID: event.sessionID ?? parentID, startedAt: new Date(Date.now() - event.elapsedMs).toISOString() }, event.elapsedMs) } catch { /* papercut memory must never affect execution */ } },
    })
    appendLedger({ kind: "bound", parentID, callID, childID: runID, runtime: "claude-code", runtimeSessionId: cli.sessionId, runID })
    appendLedger({ kind: "terminal", parentID, callID, childID: runID, state: "completed" })
    acknowledge("completed", cli.text)
    const title = canonicalWorkerTitle(identity)
    return { content: `Claude Code (Harness) completed:\n${cli.text}`, metadata: { runtimeSessionId: cli.sessionId, sessionId: cli.sessionId, runID, runtime: "claude-code", agentRole: "claude-code", providerID: "claude-code", modelID: alias, parentID, task: identity.task, title, label: title } }
  } catch (error) {
    if (error instanceof ClaudeCodeCliError) return fail(error.kind, error.message)
    throw error
  }
}
export function makeClaudeCodeTaskTool(run = runClaudeCodeTask) { return { name: "claude_code_task", description: "Claude Code (Harness): run with an immutable Task scope envelope.", input: { type: "object", properties: { task: { type: "string" }, cwd: { type: "string" }, constraints: { type: "string" }, verification: { type: "string" }, sessionKey: { type: "string" }, resume: { type: "boolean" }, model: { type: "string" }, scope: { type: "object" }, followUpKind: { type: "string", enum: ["fix", "review", "verify", "integrate"] } }, required: ["task", "scope"], additionalProperties: false }, execute: run } }
export const claudeCodeTaskTool = makeClaudeCodeTaskTool(); export const claudeCodeTool = { ...claudeCodeTaskTool, name: "claude_code" }


// ---- Task/subagent intercept ---------------------------------------------
// The host's Task tool is the only surface most callers reach the harness
// through. Owning the intercept here keeps the harness installable on its own:
// the router plugin just calls installClaudeCodeIntercept.

/**
 * Whether a Task spawn targets this harness rather than a chat-model agent.
 * Every field a caller might name the agent in is checked — a spawn that slips
 * through is routed to a relay model instead of the real CLI.
 */
export function isClaudeCodeSpawn(args: unknown): boolean {
  const a = (args ?? {}) as Record<string, unknown>
  return [a.agent, a.subagent_type, a.subagent, a.name].some((name) => resolveClaudeCodeWorkerName(name) !== undefined)
}

/** Build the required Task scope envelope for a Claude Code intercept. Fail loud when it cannot. */
export function claudeCodeScopeFromTask(input: Record<string, unknown>, event: Record<string, unknown> = {}, modelAlias = claudeModelAlias(input.model) ?? "claude"): TaskScopeManifest {
  const existing = normalizeScope(input.scope)
  if (existing) return existing
  const callID = String(event.callID ?? event.id ?? input.taskId ?? input.taskID ?? "claude-code-task")
  const parentID = String(event.sessionID ?? input.parentId ?? "unknown")
  const filled = {
    taskId: String(input.taskId ?? input.taskID ?? callID),
    questId: String(input.questId ?? input.questID ?? "unbound"),
    workUnitId: String(input.workUnitId ?? input.taskId ?? input.taskID ?? callID),
    role: String(input.role ?? "worker"),
    domains: stringList(input.domains, ["claude-code"]),
    components: stringList(input.components, ["claude-code-task"]),
    ownedPaths: stringList(input.ownedPaths ?? input.include, ["."]),
    prohibitedPaths: stringList(input.prohibitedPaths ?? input.exclude, []),
    branch: String(input.branch ?? "shared-tree"),
    ...(typeof input.worktree === "string" && input.worktree.trim() ? { worktree: input.worktree.trim() } : {}),
    parentId: parentID,
    ownerId: String(input.ownerId ?? parentID),
    integrationId: String(input.integrationId ?? input.questID ?? "unbound"),
    modelPin: `claude-code/${modelAlias}`,
    lifecycle: "running",
    deliverables: stringList(input.deliverables, [String(input.description ?? input.prompt ?? input.task ?? "claude-code-task")]),
    allowedFollowUpKinds: stringList(input.allowedFollowUpKinds, ["fix", "review", "verify", "integrate"]),
  }
  const scope = normalizeScope(filled)
  if (!scope) throw new Error("Invalid arguments for tool claude_code: Missing key: scope")
  return scope
}

export type ClaudeCodeDirectResult = Error & { name: "ClaudeCodeDirectResult"; result: unknown }

function claudeCodeDirectResult(result: unknown): ClaudeCodeDirectResult {
  const content = result && typeof result === "object" && "content" in result ? String((result as { content?: unknown }).content ?? "") : String(result ?? "")
  const error = new Error(content || "Claude Code (Harness) completed") as ClaudeCodeDirectResult
  error.name = "ClaudeCodeDirectResult"
  error.result = result
  return error
}

/**
 * Intercept Task/subagent agent=claude-code and run the official CLI directly.
 * Never pins a chat model (no x-preview / GLM / luna relay).
 */
export async function interceptClaudeCodeTask(event: unknown, run: typeof runClaudeCodeTask = runClaudeCodeTask): Promise<unknown> {
  const ev = (event ?? {}) as Record<string, unknown>
  if (!/^(task|subagent)$/i.test(String(ev.tool ?? ev.name ?? ""))) return
  const input = (ev.input ?? ev.args ?? {}) as Record<string, unknown>
  if (!input || typeof input !== "object" || !isClaudeCodeSpawn(input)) return
  const identity = workerIdentityFromEvent(ev)
  const requestedAlias = claudeModelAlias(input.model)
  if (input.model != null && !requestedAlias) throw new Error("agent claude-code only accepts claude-code/{claude|default|opus|sonnet|haiku}")
  const alias = identity?.runtime === "claude-code" ? identity.modelID : requestedAlias
  if (!alias) throw new Error("agent claude-code only accepts claude-code/{claude|default|opus|sonnet|haiku}")
  const task = String(input.prompt ?? input.description ?? input.title ?? input.task ?? "").trim()
  if (!task) throw new Error("Invalid arguments for tool claude_code: Missing key: task")
  const scope = claudeCodeScopeFromTask(input, ev, alias)
  input.scope = scope
  const result = await run({
    task,
    cwd: typeof input.cwd === "string" ? input.cwd : undefined,
    constraints: typeof input.constraints === "string" ? input.constraints : undefined,
    verification: typeof input.verification === "string" ? input.verification : undefined,
    sessionKey: typeof input.sessionKey === "string" ? input.sessionKey : typeof ev.sessionID === "string" ? ev.sessionID : undefined,
    resume: input.resume === true,
    model: alias,
    scope,
    followUpKind: typeof input.followUpKind === "string" ? input.followUpKind : undefined,
    executable: typeof input.executable === "string" ? input.executable : undefined,
    executableArgs: Array.isArray(input.executableArgs) ? input.executableArgs.map(String) : undefined,
  }, {
    sessionID: typeof ev.sessionID === "string" ? ev.sessionID : undefined,
    callID: typeof ev.callID === "string" ? ev.callID : typeof ev.id === "string" ? ev.id : undefined,
    abortSignal: (ev.abortSignal ?? input.abortSignal) as AbortSignal | undefined,
    signal: (ev.signal ?? input.signal) as AbortSignal | undefined,
  })
  ev.output = result
  return result
}

/**
 * Register the intercept on execute.before. `registerHook` is the seam the host
 * plugin uses to wrap the callback in its own isolation and health journal; the
 * default registers plainly so the harness needs no host plumbing of its own.
 */
export async function installClaudeCodeIntercept(
  ctx: { tool?: { hook?: Function } },
  run: typeof runClaudeCodeTask = runClaudeCodeTask,
  registerHook: (hook: Function, name: string, callback: (...args: any[]) => any) => Promise<void> = async (hook, name, callback) => { await hook(name, callback) },
) {
  const toolHook = ctx?.tool?.hook
  if (typeof toolHook !== "function") return
  await registerHook(toolHook, "execute.before", async (event: unknown) => {
    const result = await interceptClaudeCodeTask(event, run)
    if (result !== undefined) throw claudeCodeDirectResult(result)
  })
}
