export type WorkerRuntime = "native" | "claude-code"

export type WorkerIdentity = {
  agentRole: "build" | "explore" | "claude-code"
  providerID: string
  modelID: string
  runtime: WorkerRuntime
  openCodeSessionId?: string
  runtimeSessionId?: string
  parentID: string
  runID: string
  task: string
}

const CLAUDE_AGENTS = new Set(["claude-code", "claude-code-harness"])
const CLAUDE_MODELS = new Set(["claude", "default", "opus", "sonnet"])
const NATIVE_ROLES = new Set(["build", "explore"])

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function splitProviderModel(value: string): { providerID: string; modelID: string } | undefined {
  const slash = value.indexOf("/")
  if (slash <= 0 || slash === value.length - 1) return
  const providerID = value.slice(0, slash).trim()
  const modelID = value.slice(slash + 1).trim()
  if (!providerID || !modelID || /\s/.test(providerID)) return
  return { providerID, modelID }
}

export function taskDescription(input: Record<string, unknown>): string {
  return text(input.task ?? input.prompt ?? input.description ?? input.title)
}

export function canonicalWorkerTitle(identity: Pick<WorkerIdentity, "providerID" | "modelID" | "task">): string {
  return `${identity.providerID}/${identity.modelID} - ${identity.task}`
}

export function bindWorkerSessions(identity: WorkerIdentity, sessions: { openCodeSessionId?: string; runtimeSessionId?: string }): WorkerIdentity {
  return {
    agentRole: identity.agentRole,
    providerID: identity.providerID,
    modelID: identity.modelID,
    runtime: identity.runtime,
    openCodeSessionId: sessions.openCodeSessionId ?? identity.openCodeSessionId,
    runtimeSessionId: sessions.runtimeSessionId ?? identity.runtimeSessionId,
    parentID: identity.parentID,
    runID: identity.runID,
    task: identity.task,
  }
}

export function claudeModelAlias(model: unknown): string | undefined {
  const raw = text(model)
  if (!raw || raw === "claude-code") return "claude"
  const parsed = splitProviderModel(raw)
  const alias = parsed ? parsed.modelID : raw
  if (parsed && parsed.providerID !== "claude-code") return
  return CLAUDE_MODELS.has(alias) ? alias : undefined
}

export function canonicalizeDispatch(event: unknown): WorkerIdentity | undefined {
  const ev = (event ?? {}) as Record<string, unknown>
  if (!/^(task|subagent)$/i.test(text(ev.tool ?? ev.name))) return
  const input = (ev.input ?? ev.args) as Record<string, unknown> | undefined
  if (!input || typeof input !== "object") throw new Error("Task dispatch requires an input object")

  const description = taskDescription(input)
  if (!description) throw new Error("Task dispatch requires a task description")
  if (input.background === false) throw new Error("Foreground Task dispatch is not supported; subagents are always background")

  const requestedAgent = text(input.agent ?? input.subagent_type ?? input.subagent ?? input.name).toLowerCase()
  const parentSessionID = text(ev.sessionID ?? input.parentSessionID ?? input.parentId)
  const runID = text(ev.callID ?? ev.id ?? ev.messageID)
  if (!parentSessionID || !runID) throw new Error("Task dispatch requires parent session and run IDs")

  let identity: WorkerIdentity
  if (CLAUDE_AGENTS.has(requestedAgent)) {
    const alias = claudeModelAlias(input.model)
    if (!alias) throw new Error("agent claude-code only accepts claude-code/{claude|default|opus|sonnet}")
    identity = {
      agentRole: "claude-code",
      providerID: "claude-code",
      modelID: alias,
      runtime: "claude-code",
      parentID: parentSessionID,
      runID,
      task: description,
    }
    input.agent = "claude-code"
    input.model = `claude-code/${alias}`
  } else {
    if (!NATIVE_ROLES.has(requestedAgent)) {
      throw new Error(`Unsupported Task agent role: ${requestedAgent || "missing"}; use build, explore, or claude-code`)
    }
    const model = splitProviderModel(text(input.model))
    if (!model) throw new Error("Native Task dispatch requires an explicit provider/model selected by the picker")
    if (model.providerID === "claude-code") throw new Error("Claude models require agent claude-code; native build/explore cannot impersonate the harness")
    identity = {
      agentRole: requestedAgent as "build" | "explore",
      providerID: model.providerID,
      modelID: model.modelID,
      runtime: "native",
      parentID: parentSessionID,
      runID,
      task: description,
    }
  }

  input.background = true
  input.title = canonicalWorkerTitle(identity)
  ev.workerIdentity = identity
  const metadata = ev.metadata && typeof ev.metadata === "object" ? ev.metadata as Record<string, unknown> : {}
  ev.metadata = { ...metadata, worker: { ...identity, title: canonicalWorkerTitle(identity) } }
  return identity
}

export function workerIdentityFromEvent(event: unknown): WorkerIdentity | undefined {
  const value = (event as { workerIdentity?: unknown } | undefined)?.workerIdentity
  if (!value || typeof value !== "object") return
  return value as WorkerIdentity
}

export function nativeSessionNavigation(
  identity: WorkerIdentity,
  session: { id?: string; parentID?: string; parentId?: string } | undefined,
): { type: "session"; sessionID: string } | undefined {
  const sessionID = identity.openCodeSessionId
  if (identity.runtime !== "native" || !sessionID || !/^ses_[A-Za-z0-9_-]+$/.test(sessionID)) return
  if (session?.id !== sessionID) return
  if ((session.parentID ?? session.parentId) !== identity.parentID) return
  return { type: "session", sessionID }
}
