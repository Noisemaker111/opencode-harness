/** Lock-safe provider capacity and task lifecycle registry shared by all sessions. */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"

/**
 * Lane blocks are real routing state, so a test run must never write to the
 * live file — `bun test` was blocking lanes in the user's own capacity.json
 * and changing which models their next session would pick. The override makes
 * isolation mechanical rather than something each test has to remember.
 */
export const CAPACITY_FILE = process.env.OPENCODE_CAPACITY_FILE
  ?? join(homedir(), ".local", "state", "opencode", "capacity.json")
type Lane = { state: "available" | "blocked"; resetAt?: string; reason?: string; evidence?: string; updated: string }
type Task = { id: string; parentID: string; lineage: string; lane: string; state: "accepted" | "executing" | "blocked" | "terminal"; reason?: string; updated: string }
type Registry = { schema: 1; lanes: Record<string, Lane>; tasks: Record<string, Task> }
const empty = (): Registry => ({ schema: 1, lanes: {}, tasks: {} })
const redact = (x: unknown) => String(x ?? "").replace(/(token|key|password|authorization)\s*[:=]\s*\S+/gi, "$1=[redacted]").slice(0, 500)
function load(file = CAPACITY_FILE): Registry { try { const x = JSON.parse(readFileSync(file, "utf8")); return x?.schema === 1 ? x : empty() } catch { return empty() } }
function lock<T>(file: string, fn: () => T): T { const l = `${file}.lock`, start = Date.now(); for (;;) { try { mkdirSync(l); try { return fn() } finally { rmSync(l, { recursive: true, force: true }) } } catch (e) { if ((e as any)?.code !== "EEXIST") throw e; try { if (Date.now() - statSync(l).mtimeMs > 30_000) rmSync(l, { recursive: true, force: true }) } catch {}; if (Date.now() - start > 10_000) throw new Error("capacity registry lock timeout"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5) } } }
function update(fn: (r: Registry) => void, file = CAPACITY_FILE) { mkdirSync(dirname(file), { recursive: true }); lock(file, () => { const r = load(file); reconcile(r); fn(r); const t = `${file}.${process.pid}.tmp`; writeFileSync(t, JSON.stringify(r, null, 2)); renameSync(t, file) }) }
function reconcile(r: Registry, now = Date.now()) { for (const [k, lane] of Object.entries(r.lanes)) if (lane.state === "blocked" && lane.resetAt && Date.parse(lane.resetAt) <= now) delete r.lanes[k]; for (const task of Object.values(r.tasks)) if (task.state === "accepted" && now - Date.parse(task.updated) > 60_000) { task.state = "blocked"; task.reason = "startup timeout reconciled"; task.updated = new Date(now).toISOString() } }
/**
 * A block always expires. reconcile() only clears a lane whose resetAt has
 * passed, so a block written without one stayed blocked forever — and the
 * caller has no reset time whenever the usage cache reports none, which is
 * every transient provider failure. A lane was therefore removed from routing
 * permanently by one bad minute.
 *
 * This is only the blind default. A caller that knows the real window — 5h or
 * 7d — passes resetAt and it is honoured verbatim; capResetAt() in
 * model-routing reads it off the usage cache. Blind, the default is short on
 * purpose: sourceCapHit still gates a genuinely spent window, so the worst
 * case of expiring early is one re-probe, while the worst case of never
 * expiring is a dead lane. Guessing 5h instead would strand a lane that was
 * never actually capped for five hours.
 */
export const LANE_BLOCK_TTL_MS = 30 * 60_000
export function blockLane(lane: string, reason: unknown, resetAt?: string, evidence?: unknown, file = CAPACITY_FILE) { update(r => { r.lanes[lane] = { state: "blocked", resetAt: resetAt ?? new Date(Date.now() + LANE_BLOCK_TTL_MS).toISOString(), reason: redact(reason), evidence: redact(evidence), updated: new Date().toISOString() } }, file) }
export function laneBlock(lane: string, file = CAPACITY_FILE): Lane | undefined { const r = load(file); reconcile(r); return r.lanes[lane]?.state === "blocked" ? r.lanes[lane] : undefined }
export function taskState(id: string, parentID: string, lineage: string, lane: string, state: Task["state"], reason?: unknown, file = CAPACITY_FILE) { update(r => { r.tasks[id] = { id, parentID, lineage, lane, state, reason: redact(reason), updated: new Date().toISOString() } }, file) }
export function capacitySnapshot(file = CAPACITY_FILE) { const r = load(file); reconcile(r); const tasks = Object.values(r.tasks); return { lanes: r.lanes, tasks, counts: { reported: tasks.length, executing: tasks.filter(x => x.state === "executing").length, blocked: tasks.filter(x => x.state === "blocked").length, running: tasks.filter(x => x.state === "executing").length } } }
