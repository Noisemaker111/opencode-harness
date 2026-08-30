import { isAbsolute, normalize, resolve } from "node:path"

export const FOLLOW_UP_KINDS = ["fix", "review", "verify", "integrate"] as const
export type FollowUpKind = typeof FOLLOW_UP_KINDS[number]

/** Immutable, machine-readable ownership contract for one Task lineage. */
export type TaskScopeManifest = {
  taskId: string
  questId: string
  workUnitId: string
  role: string
  domains: string[]
  components: string[]
  ownedPaths: string[]
  prohibitedPaths: string[]
  branch: string
  worktree?: string
  parentId: string
  ownerId: string
  integrationId: string
  modelPin: string
  lifecycle: "planned" | "running" | "review" | "verifying" | "integrating" | "completed"
  deliverables: string[]
  allowedFollowUpKinds: FollowUpKind[]
}

export type ScopeRejection = { code: "OUT_OF_SCOPE_CONTINUATION" | "LEGACY_SCOPE_REQUIRED" | "MODEL_IMMUTABLE"; delta: Record<string, unknown> }

const keys: (keyof TaskScopeManifest)[] = ["taskId", "questId", "workUnitId", "role", "domains", "components", "ownedPaths", "prohibitedPaths", "branch", "parentId", "ownerId", "integrationId", "modelPin", "lifecycle", "deliverables", "allowedFollowUpKinds"]
const list = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim())
const unique = (items: string[]) => [...new Set(items.map((item) => item.trim()))].sort()

/** Coerce a caller-supplied scope field to a string list, or fall back. */
export function stringList(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim())) return value.map((item) => String(item).trim())
  if (typeof value === "string" && value.trim()) return [value.trim()]
  return fallback
}

export function normalizeScope(input: unknown): TaskScopeManifest | undefined {
  if (!input || typeof input !== "object") return undefined
  const value = input as Record<string, unknown>
  if (!keys.every((key) => key in value) || !keys.filter((key) => !["taskId", "questId", "workUnitId", "role", "branch", "parentId", "ownerId", "integrationId", "modelPin", "lifecycle"].includes(key)).every((key) => list(value[key]))) return undefined
  if (!["taskId", "questId", "workUnitId", "role", "branch", "parentId", "ownerId", "integrationId", "modelPin", "lifecycle"].every((key) => typeof value[key] === "string" && String(value[key]).trim())) return undefined
  if (value.worktree != null && typeof value.worktree !== "string") return undefined
  if (!["planned", "running", "review", "verifying", "integrating", "completed"].includes(String(value.lifecycle))) return undefined
  const followups = unique(value.allowedFollowUpKinds as string[])
  if (followups.some((kind) => !(FOLLOW_UP_KINDS as readonly string[]).includes(kind))) return undefined
  const worktree = typeof value.worktree === "string" ? String(value.worktree).trim() : ""
  return { taskId: String(value.taskId).trim(), questId: String(value.questId).trim(), workUnitId: String(value.workUnitId).trim(), role: String(value.role).trim(), domains: unique(value.domains as string[]), components: unique(value.components as string[]), ownedPaths: unique(value.ownedPaths as string[]).map(canonicalPath), prohibitedPaths: unique(value.prohibitedPaths as string[]).map(canonicalPath), branch: String(value.branch).trim(), worktree: worktree || undefined, parentId: String(value.parentId).trim(), ownerId: String(value.ownerId).trim(), integrationId: String(value.integrationId).trim(), modelPin: String(value.modelPin).trim(), lifecycle: value.lifecycle as TaskScopeManifest["lifecycle"], deliverables: unique(value.deliverables as string[]), allowedFollowUpKinds: followups as FollowUpKind[] }
}

function canonicalPath(value: string) {
  const raw = isAbsolute(value) ? normalize(resolve(value)) : normalize(value)
  const slashed = raw.replaceAll("\\", "/")
  return process.platform === "win32" ? slashed.toLowerCase() : slashed
}
function subset(requested: string[], original: string[]) { return requested.every((item) => original.includes(item)) }

export function validateContinuation(original: TaskScopeManifest | undefined, requested: TaskScopeManifest | undefined, kind: string | undefined, model: string | undefined, originalModel: string | undefined): ScopeRejection | undefined {
  if (!original || !requested) return { code: "LEGACY_SCOPE_REQUIRED", delta: { manifest: requested ?? null, followUpKind: kind ?? null } }
  if ((originalModel && model && originalModel !== model) || requested.modelPin !== original.modelPin) {
    return { code: "MODEL_IMMUTABLE", delta: { model: { original: originalModel ?? original.modelPin, requested: model ?? requested.modelPin } } }
  }
  const delta: Record<string, unknown> = {}
  for (const key of ["taskId", "questId", "workUnitId", "role", "branch", "worktree", "parentId", "ownerId", "integrationId"] as const) if (requested[key] !== original[key]) delta[key] = requested[key]
  if (requested.lifecycle !== original.lifecycle && requested.lifecycle !== "review" && requested.lifecycle !== "verifying" && requested.lifecycle !== "integrating" && requested.lifecycle !== "completed") delta.lifecycle = requested.lifecycle
  for (const key of ["domains", "components", "ownedPaths", "prohibitedPaths", "deliverables"] as const) if (!subset(requested[key], original[key])) delta[key] = requested[key].filter((item) => !original[key].includes(item))
  if (kind === undefined || !original.allowedFollowUpKinds.includes(kind as FollowUpKind)) delta.followUpKind = kind ?? null
  if (Object.keys(delta).length) return { code: "OUT_OF_SCOPE_CONTINUATION", delta }
}

export function pathIsOwned(path: string, manifest: TaskScopeManifest) {
  const target = canonicalPath(path)
  const owned = manifest.ownedPaths.some((owner) => target === owner || target.startsWith(owner.endsWith("/") ? owner : `${owner}/`))
  return owned && !manifest.prohibitedPaths.includes(target)
}
