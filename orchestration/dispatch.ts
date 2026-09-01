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
  return text(input.task)
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

function normalizeMuseModel(value: unknown): { providerID: string; modelID: string } | undefined {
  const raw = text(value)
  if (!raw) return
  if (/muse/i.test(raw) && /spark/i.test(raw)) return { providerID: "opencode-go", modelID: "grok-4.6" }
  if (/muse/i.test(raw)) return { providerID: "openai", modelID: "gpt-5.6-luna-fast" }
}

/**
 * Fail-closed dispatch boundary. Task/subagent can no longer start anything;
 * every model worker must enter through the local MCP server's mcp_agent tool.
 */
export function canonicalizeDispatch(event: unknown): WorkerIdentity | undefined {
  const ev = (event ?? {}) as Record<string, unknown>
  const tool = text(ev.tool ?? ev.name)
  if (/^(task|subagent)$/i.test(tool)) throw new Error("Direct Task/subagent dispatch is disabled; use mcp_agent")
  if (!/^mcp_agent$/i.test(tool)) return

  const input = (ev.input ?? ev.args) as Record<string, unknown> | undefined
  if (!input || typeof input !== "object") throw new Error("mcp_agent requires an input object")
  const forbidden = FORBIDDEN_CALLER_FIELDS.find((field) => field in input)
  if (forbidden) throw new Error(`mcp_agent derives hidden role/runtime; caller field ${forbidden} is forbidden`)

  const task = taskDescription(input)
  if (!task) throw new Error("mcp_agent requires task")
  if (!text(input.questID)) throw new Error("mcp_agent requires questID")
  const selected = splitProviderModel(text(input.model)) ?? normalizeMuseModel(input.model)
  if (!selected) throw new Error("mcp_agent requires an explicit provider/model selected by the picker")
  if (selected.providerID === "claude-code" && !claudeModelAlias(`${selected.providerID}/${selected.modelID}`)) {
    throw new Error("claude-code only accepts claude-code/{claude|default|opus|sonnet|haiku}")
  }

  const parentID = text(ev.sessionID ?? ev.parentSessionID)
  const runID = text(ev.callID ?? ev.id ?? ev.messageID)
  if (!parentID || !runID) throw new Error("mcp_agent requires parent session and run IDs")
  const identity: WorkerIdentity = {
    // The Quest tracker changes this to orchestrator only for the first owner
    // of an ownerless Quest. It is never accepted from the caller.
    agentRole: "worker",
    providerID: selected.providerID,
    modelID: selected.modelID,
    runtime: selected.providerID === "claude-code" ? "claude-code" : "native",
    parentID,
    runID,
    task,
  }
  input.model = `${selected.providerID}/${selected.modelID}`
  ev.workerIdentity = identity
  const metadata = ev.metadata && typeof ev.metadata === "object" ? ev.metadata as Record<string, unknown> : {}
  ev.metadata = { ...metadata, worker: { ...identity, title: canonicalWorkerTitle(identity) } }
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
