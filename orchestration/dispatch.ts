export type WorkerRuntime = "native" | "claude-code"

/** Internal lineage only. The public identity is always provider/model - task. */
export type WorkerIdentity = {
  agentRole: "worker" | "orchestrator"
  providerID: string
  modelID: string
  runtime: WorkerRuntime
  openCodeSessionId?: string
  runtimeSessionId?: string
  parentID: string
  runID: string
  task: string
}

const CLAUDE_MODELS = new Set(["claude", "default", "opus", "sonnet", "haiku"])
const FORBIDDEN_CALLER_FIELDS = ["agent", "agentRole", "role", "runtime", "subagent", "subagent_type"] as const

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

export function splitProviderModel(value: string): { providerID: string; modelID: string } | undefined {
  const slash = value.indexOf("/")
  if (slash <= 0 || slash === value.length - 1) return
  const providerID = value.slice(0, slash).trim()
  const modelID = value.slice(slash + 1).trim()
  if (!providerID || !modelID || /\s/.test(providerID)) return
  return { providerID, modelID }
}

export function taskDescription(input: Record<string, unknown>): string {
  return text(input.task) || text(input.prompt) || text(input.description)
}

export function canonicalWorkerTitle(identity: Pick<WorkerIdentity, "providerID" | "modelID" | "task">): string {
  return `${identity.providerID}/${identity.modelID} - ${identity.task}`
}

export function bindWorkerSessions(identity: WorkerIdentity, sessions: { openCodeSessionId?: string; runtimeSessionId?: string }): WorkerIdentity {
  return { ...identity, openCodeSessionId: sessions.openCodeSessionId ?? identity.openCodeSessionId, runtimeSessionId: sessions.runtimeSessionId ?? identity.runtimeSessionId }
}

export function claudeModelAlias(model: unknown): string | undefined {
  const raw = text(model)
  if (!raw || raw === "claude-code") return "claude"
  const parsed = splitProviderModel(raw)
  const alias = parsed ? parsed.modelID : raw
  if (parsed && parsed.providerID !== "claude-code") return
  return CLAUDE_MODELS.has(alias) ? alias : undefined
}

/** Short names Jk actually says. Claude Code rides the in-process harness bridge as a normal provider. */
export const MODEL_ALIASES: Record<string, { providerID: string; modelID: string }> = {
  claude: { providerID: "claude-code", modelID: "opus" },
  "claude-code": { providerID: "claude-code", modelID: "opus" },
  opus: { providerID: "claude-code", modelID: "opus" },
  sonnet: { providerID: "claude-code", modelID: "sonnet" },
  haiku: { providerID: "claude-code", modelID: "haiku" },
  grok: { providerID: "cliproxyapi", modelID: "grok-4.6" },
  codex: { providerID: "codex", modelID: "default" },
}

export function aliasModel(value: unknown): { providerID: string; modelID: string } | undefined {
  const raw = text(value).toLowerCase()
  return raw ? MODEL_ALIASES[raw] : undefined
}

function normalizeMuseModel(value: unknown): { providerID: string; modelID: string } | undefined {
  const raw = text(value)
  if (!raw) return
  if (/muse/i.test(raw) && /spark/i.test(raw)) return { providerID: "opencode-go", modelID: "grok-4.6" }
  if (/muse/i.test(raw)) return { providerID: "openai", modelID: "gpt-5.6-luna-fast" }
}

const DISPATCH_TOOLS = /^(task|subagent)$/i

/**
 * Fail-closed dispatch boundary. Approved Quest work enters through the native
 * subagent/task tool with only questID, cwd, and a short task. Role and runtime
 * are derived; callers may not select them.
 */
export function canonicalizeDispatch(event: unknown): WorkerIdentity | undefined {
  const ev = (event ?? {}) as Record<string, unknown>
  const tool = text(ev.tool ?? ev.name)
  if (!DISPATCH_TOOLS.test(tool)) return

  const input = (ev.input ?? ev.args) as Record<string, unknown> | undefined
  if (!input || typeof input !== "object") throw new Error("Quest dispatch requires an input object")
  const forbidden = FORBIDDEN_CALLER_FIELDS.find((field) => field in input)
  if (forbidden) throw new Error(`Quest dispatch derives hidden role/runtime; caller field ${forbidden} is forbidden`)

  const task = taskDescription(input)
  if (!task) throw new Error("Quest dispatch requires task")
  if (!text(input.questID)) throw new Error("Quest dispatch requires questID")
  const selected = splitProviderModel(text(input.model)) ?? aliasModel(input.model) ?? normalizeMuseModel(input.model)
  if (text(input.model) && !selected) throw new Error("Quest dispatch model must be an explicit provider/model")
  if (selected?.providerID === "claude-code" && !claudeModelAlias(`${selected.providerID}/${selected.modelID}`)) {
    throw new Error("claude-code only accepts claude-code/{claude|default|opus|sonnet|haiku}")
  }

  const parentID = text(ev.sessionID ?? ev.parentSessionID)
  const runID = text(ev.callID ?? ev.id ?? ev.messageID)
  if (!parentID || !runID) throw new Error("Quest dispatch requires parent session and run IDs")
  const identity: WorkerIdentity = {
    agentRole: "worker",
    providerID: selected?.providerID ?? "",
    modelID: selected?.modelID ?? "",
    // A native subagent stays native even on the claude-code provider: the CLI sits behind the bridge, the session is OpenCode's.
    runtime: "native",
    parentID,
    runID,
    task,
  }
  if (selected) input.model = `${selected.providerID}/${selected.modelID}`
  ev.workerIdentity = identity
  const metadata = ev.metadata && typeof ev.metadata === "object" ? ev.metadata as Record<string, unknown> : {}
  const title = identity.providerID && identity.modelID ? canonicalWorkerTitle(identity) : identity.task
  ev.metadata = { ...metadata, worker: { ...identity, title } }
  return identity
}

export function workerIdentityFromEvent(event: unknown): WorkerIdentity | undefined {
  const value = (event as { workerIdentity?: unknown } | undefined)?.workerIdentity
  return value && typeof value === "object" ? value as WorkerIdentity : undefined
}

/** Workers are evidence on the Quest board, never user conversation routes. */
export function nativeSessionNavigation(): undefined {
  return undefined
}
