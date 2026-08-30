/** Explicit session/worker model immutability and replacement lineage. */
export type SessionState = "active" | "stopped" | "superseded"
export type SessionCheckpoint = { summary: string; taskID?: string; createdAt?: string }
export type SessionRecord = { id: string; model: string; variant?: string; parentID?: string; questID?: string; taskID?: string; state: SessionState; historyCount: number; workerStarted: boolean; checkpoint?: SessionCheckpoint; supersededBy?: string }
export class ModelChangeError extends Error { constructor(message = "Model is immutable for an executing session; create a linked replacement") { super(message); this.name = "ModelChangeError" } }
export function assertModelImmutable(session: Pick<SessionRecord, "model" | "variant" | "historyCount" | "workerStarted" | "state">, requestedModel: string, requestedVariant?: string) {
  if (session.model === requestedModel && session.variant === requestedVariant) return
  if (session.state !== "active" || session.historyCount > 0 || session.workerStarted) throw new ModelChangeError()
}
let sequence = 0
export function replaceSession(old: SessionRecord, requestedModel: string, checkpoint: SessionCheckpoint, id = `${old.id}:replacement:${++sequence}`, requestedVariant?: string): SessionRecord {
  if (old.state !== "active") throw new ModelChangeError("Only an active session can be replaced")
  const replacement: SessionRecord = { id, model: requestedModel, variant: requestedVariant, parentID: old.id, questID: old.questID, taskID: old.taskID, state: "active", historyCount: 0, workerStarted: false, checkpoint }
  old.state = "superseded"; old.supersededBy = replacement.id
  return replacement
}
export function recoverFailedWorker(session: SessionRecord, checkpoint: SessionCheckpoint, requestedModel = session.model, requestedVariant = session.variant) {
  if (session.state !== "stopped" && session.state !== "superseded") throw new Error("Worker recovery requires an explicitly stopped worker")
  return replaceSession({ ...session, state: "active", supersededBy: undefined }, requestedModel, checkpoint, `${session.id}:recovery:${++sequence}`, requestedVariant)
}
export function runningWorkerIDs(sessions: SessionRecord[]) { return sessions.filter((s) => s.state === "active" && s.workerStarted).map((s) => s.id) }
