#!/usr/bin/env node
/**
 * opencode-mcp-stdio.mjs — MCP server that lets any harness (claude-code, codex, grok)
 * start model workers through the OpenCode server instead of an in-process
 * Task/subagent call. OpenCode exposes server `mcp` + tool `agent` as
 * `mcp_agent`.
 *
 * Transport: stdio JSON-RPC 2.0 (MCP spec). Each line is one JSON message.
 *
 * Env expected from the harness launcher:
 *   OPENCODE_PARENT_SESSION_ID — parent opencode session (ses_...)
 *   OPENCODE_CWD — parent cwd; the child session is moved here after create
 *   OPENCODE_SERVER_URL / OPENCODE_PASSWORD — override service.json discovery
 *
 * Keep this file self-contained: it runs as a child of the harness CLI, not
 * inside the plugin host, so it must not import from `harnesses/` TS sources.
 * It talks to the instance HTTP API with plain fetch rather than
 * @opencode-ai/sdk — the pinned SDK is generated against an older route set
 * (`/session/{id}/prompt_async`, `/session/{id}/status`, `/config/providers`
 * are all 404 on the running server) and those calls silently no-op.
 *
 * Routes used, all confirmed against OpenCode 2 OpenAPI (prompt/wait/permission):
 *   POST /api/session               { title, agent, model: { providerID, id } }
 *   POST /api/session/{id}/move     { directory }
 *   POST /api/session/{id}/prompt   { text, delivery? } — durably admits, returns at once
 *   POST /api/session/{id}/wait     204 when the agent loop is idle (503 → poll messages)
 *   GET  /api/session/{id}/permission
 *   POST /api/session/{id}/permission/{requestID}/reply  { reply: "always"|"once"|"reject" }
 *   GET  /api/session?parentID=     children of a desk parent
 *   GET  /api/session/{id}
 *   GET  /api/session/{id}/message  newest-first
 *   GET  /api/model
 */

import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs"
import { spawn } from "node:child_process"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createInterface } from "node:readline"

const SELF = fileURLToPath(import.meta.url)

/** Used when the caller names no model. Must exist in GET /api/model. Never Luna. Never Hy3. */
const DEFAULT_MODEL = { providerID: "opencode-go", id: "grok-4.6" }

/** Desk session_start/session_prompt wait until COMPLETE unless the caller opts out with wait=0. */
export const DEFAULT_WAIT_MS = 8 * 60 * 60 * 1000
/** Idle parent/child continuations until COMPLETE. A tiny cap is how one-loop death returns. */
export const DEFAULT_MAX_STEERS = 128
/** Real OC2 ids are long (ses_ + ≥16). Fixtures like ses_wait1 / ses_valid1 / ses_desk1 are not. */
export const LIVE_SESSION_SUFFIX_MIN = 16

const TOOLS = [
  {
    name: "agent",
    description: "Harness-only: start an OpenCode worker from a vendor CLI. Returns immediately with a session ID to poll.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "What the subagent should do" },
        questID: { type: "string", description: "Canonical Quest ID; hidden role is derived from its lineage" },
        model: { type: "string", description: "provider/model, e.g. opencode-go/grok-4.6, claude-code/sonnet, codex/default" },
        sessionID: { type: "string", description: "Existing mcp_agent OpenCode session to continue" },
        cwd: { type: "string", description: "Working directory for the subagent" },
      },
      required: ["task", "questID", "model"],
      additionalProperties: false,
    },
  },
  {
    name: "pick_model",
    description: "List the models this opencode instance can actually run, with a recommendation for a task.",
    inputSchema: {
      type: "object",
      properties: { task: { type: "string" } },
      required: ["task"],
      additionalProperties: false,
    },
  },
  {
    name: "agent_status",
    description: "Check whether a model worker started by mcp_agent is still running or has finished.",
    inputSchema: {
      type: "object",
      properties: {
        sessionID: { type: "string", description: "opencode session ID (ses_...)" },
        runID: { type: "string" },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "agent_output",
    description: "Get the latest assistant output from a model worker started by mcp_agent.",
    inputSchema: {
      type: "object",
      properties: {
        sessionID: { type: "string" },
        runID: { type: "string" },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "session_start",
    description: "Allbot desk: spawn an OpenCode 2 session with an explicit provider/model[#variant]. No Quest ledger required. Waits/steers until COMPLETE by default (pass wait=0 only to admit and return).",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", description: "provider/model or provider/model#variant, e.g. cliproxyapi/gpt-5.6-luna or openai/gpt-5.6-luna-fast#max" },
        variant: { type: "string", description: "Effort/variant if not encoded in model (max, xhigh, high, default)" },
        effort: { type: "string", description: "Alias of variant" },
        agent: { type: "string", description: "Host agent envelope. Default build." },
        title: { type: "string" },
        text: { type: "string", description: "Optional first prompt" },
        cwd: { type: "string" },
        questID: { type: "string", description: "Canonical Quest ID so this parent can fan out children on the same quest" },
        quest: { type: "string", description: "Alias of questID" },
        wait: { type: "number", description: "Milliseconds to stay in wait/steer. Default is hours, not 0. 0 = admit and return." },
        maxSteers: { type: "number", description: "Idle continuations until COMPLETE. Default 128." },
      },
      required: ["model"],
      additionalProperties: false,
    },
  },
  {
    name: "session_prompt",
    description: "Allbot desk: send a prompt or follow-up to an existing OpenCode 2 session. Waits/steers until COMPLETE by default.",
    inputSchema: {
      type: "object",
      properties: {
        sessionID: { type: "string" },
        text: { type: "string" },
        questID: { type: "string" },
        quest: { type: "string" },
        wait: { type: "number", description: "Milliseconds to stay in wait/steer. Default is hours, not 0. 0 = admit and return." },
        maxSteers: { type: "number" },
      },
      required: ["sessionID", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "session_status",
    description: "Runtime poll only (running/completed). Not quest check-in.",
    inputSchema: {
      type: "object",
      properties: {
        sessionID: { type: "string" },
      },
      required: ["sessionID"],
      additionalProperties: false,
    },
  },
  {
    name: "session_checkin",
    description: "Allbot check-in: ask the OC2 session if the quest is complete. Returns that session's COMPLETE or NOT_COMPLETE. Does not review the work.",
    inputSchema: {
      type: "object",
      properties: {
        sessionID: { type: "string" },
        questID: { type: "string", description: "Optional quest id to name in the question" },
        quest: { type: "string", description: "Alias of questID" },
      },
      required: ["sessionID"],
      additionalProperties: false,
    },
  },
]

function log(...args) {
  // MCP servers must not write to stdout except JSON-RPC. Use stderr.
  console.error("[opencode-mcp]", ...args)
}

// --- service discovery -------------------------------------------------

/** Live OC2 serve. `opencode2 serve --service` writes a random port into state/. */
const LIVE_SERVE = "http://127.0.0.1:4096"

export function discoverService() {
  if (process.env.OPENCODE_SERVER_URL) {
    return { url: process.env.OPENCODE_SERVER_URL, password: process.env.OPENCODE_PASSWORD || "" }
  }
  const configPath = join(homedir(), ".config", "opencode", "service.json")
  const statePath = join(homedir(), ".local", "state", "opencode", "service.json")
  const candidates = [
    process.env.OPENCODE_SERVICE_FILE,
    configPath,
    statePath,
  ].filter(Boolean)
  const loaded = []
  for (const path of candidates) {
    if (!existsSync(path)) continue
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"))
      const url = parsed.url ? String(parsed.url).replace(/\/+$/, "") : ""
      const password = parsed.password || process.env.OPENCODE_PASSWORD || ""
      loaded.push({ url, password, path })
    } catch { /* try the next candidate */ }
  }
  const live = loaded.find((row) => row.url === LIVE_SERVE && row.password)
  if (live) return { url: live.url, password: live.password }
  const passwordOnly = loaded.find((row) => !row.url && row.password)
  if (passwordOnly) return { url: LIVE_SERVE, password: passwordOnly.password }
  const named = loaded.find((row) => row.url && row.password)
  if (named) return { url: named.url, password: named.password }
  return { url: LIVE_SERVE, password: process.env.OPENCODE_PASSWORD || "" }
}

let cachedApi = null
/** One `call(method, path, body)` against the instance API, with the envelope peeled. */
function api() {
  if (cachedApi) return cachedApi
  const service = discoverService()
  if (!service?.url) throw new Error("opencode service not found (service.json missing and OPENCODE_SERVER_URL not set)")
  const base = service.url.replace(/\/$/, "") + "/api"
  const headers = { Accept: "application/json", "Content-Type": "application/json" }
  const password = service.password || process.env.OPENCODE_PASSWORD || ""
  if (password) headers.Authorization = "Basic " + Buffer.from("opencode:" + password).toString("base64")
  cachedApi = async (method, path, body) => {
    const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await response.text()
    let parsed
    try { parsed = text ? JSON.parse(text) : undefined } catch { parsed = text }
    if (!response.ok) {
      const detail = typeof parsed === "string" ? parsed : JSON.stringify(parsed ?? "")
      throw new Error(`${method} ${path} -> ${response.status}${detail ? " " + detail.slice(0, 300) : ""}`)
    }
    // Successful bodies are wrapped as { data: ... }.
    return parsed && typeof parsed === "object" && "data" in parsed ? parsed.data : parsed
  }
  return cachedApi
}

// --- input normalization -----------------------------------------------

/** Explicit `provider/model[#variant]` to the { providerID, id, variant? } the API wants. */
export function normalizeModel(model, variant) {
  const raw = String(model ?? "").trim()
  if (!raw) return null
  const slash = raw.indexOf("/")
  if (slash <= 0) return null
  const providerID = raw.slice(0, slash).trim()
  let id = raw.slice(slash + 1).trim()
  let effort = String(variant ?? "").trim()
  const hash = id.lastIndexOf("#")
  if (hash > 0) {
    if (!effort) effort = id.slice(hash + 1).trim()
    id = id.slice(0, hash).trim()
  }
  if (!providerID || !id) return null
  const out = { providerID, id }
  if (effort) out.variant = effort
  return out
}

function formatModel(model) {
  if (!model) return "?"
  const base = `${model.providerID}/${model.id}`
  return model.variant ? `${base}#${model.variant}` : base
}

export function isLiveSessionID(sessionID) {
  const match = String(sessionID ?? "").trim().match(/^ses_([A-Za-z0-9_-]+)$/)
  return Boolean(match && match[1].length >= LIVE_SESSION_SUFFIX_MIN)
}

export function parseWaitMs(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_WAIT_MS
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_WAIT_MS
  return n
}

export function parseMaxSteers(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_MAX_STEERS
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MAX_STEERS
  return Math.floor(n)
}

export function questVerdict(text) {
  const raw = String(text ?? "")
  if (/\bNOT_COMPLETE\b/.test(raw)) return "NOT_COMPLETE"
  if (/(^|\n)\s*COMPLETE\b/.test(raw)) return "COMPLETE"
  return null
}

export function steerQuestion(questID) {
  const id = String(questID ?? "").trim()
  const who = id ? `quest ${id}` : "the current quest"
  return `Continue ${who} until it is COMPLETE. Fan out independent child sessions on this same questID via mcp_agent; do not wait for Grok. If complete, reply with exactly COMPLETE and one line naming the done-check. If not, keep working. No Grok reviewer.`
}

export function shouldAllowPermission(request) {
  if (String(request?.action ?? "") === "external_directory") return true
  const resources = Array.isArray(request?.resources) ? request.resources : []
  return resources.some((item) => String(item).includes("external_directory"))
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function waitUntil(deadline) {
  let timer
  const promise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("wait deadline"), { code: "DEADLINE" })), Math.max(1, deadline - Date.now()))
  })
  return { promise, cancel() { clearTimeout(timer) } }
}

function deskDriverEnabled() {
  const raw = String(process.env.OPENCODE_DESK_DRIVER ?? "1").trim().toLowerCase()
  return raw !== "0" && raw !== "false"
}

function driveLockPath(sessionID) {
  const dir = process.env.OPENCODE_DESK_LOCK_DIR || join(homedir(), ".local", "state", "opencode")
  return join(dir, `desk-drive-${sessionID}.pid`)
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

function tryDriveLock(sessionID) {
  const file = driveLockPath(sessionID)
  try { mkdirSync(dirname(file), { recursive: true }) } catch { /* best-effort */ }
  if (existsSync(file)) {
    const owner = Number(readFileSync(file, "utf8").trim())
    if (pidAlive(owner)) return null
    try { unlinkSync(file) } catch { /* raced */ }
  }
  try { writeFileSync(file, String(process.pid), { flag: "wx" }) }
  catch { return null }
  return {
    release() {
      try { if (readFileSync(file, "utf8").trim() === String(process.pid)) unlinkSync(file) } catch { /* gone */ }
    },
  }
}

function spawnDeskDriver({ sessionID, questID, waitMs, maxSteers }) {
  if (!deskDriverEnabled() || !isLiveSessionID(sessionID)) return false
  const file = driveLockPath(sessionID)
  try {
    if (existsSync(file) && pidAlive(Number(readFileSync(file, "utf8").trim()))) return false
  } catch { /* spawn anyway */ }
  const args = [SELF, "session", "drive", "--id", sessionID, "--wait", String(waitMs || DEFAULT_WAIT_MS), "--max-steers", String(maxSteers || DEFAULT_MAX_STEERS)]
  if (questID) args.push("--quest", questID)
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, OPENCODE_DESK_DRIVER: "0" },
    windowsHide: true,
  })
  child.unref()
  return true
}

async function pendingPermissions(sessionID, call) {
  try {
    const rows = await call("GET", `/session/${sessionID}/permission`)
    return Array.isArray(rows?.data) ? rows.data : Array.isArray(rows) ? rows : []
  } catch { return [] }
}

async function allowExternalDirectory(sessionID, call) {
  if (!isLiveSessionID(sessionID)) return 0
  let allowed = 0
  for (const request of await pendingPermissions(sessionID, call)) {
    if (!shouldAllowPermission(request) || !request?.id) continue
    try {
      await call("POST", `/session/${sessionID}/permission/${request.id}/reply`, { reply: "always" })
      allowed++
    } catch (error) { log("permission reply failed", request.id, error.message) }
  }
  return allowed
}

async function pollUntilIdle(sessionID, deadline, call) {
  while (Date.now() < deadline) {
    await allowExternalDirectory(sessionID, call)
    const { final, assistant } = await latestAssistant(sessionID)
    const finish = assistant?.finish ?? assistant?.info?.finish
    if (finish === "error") return "error"
    if (final) return "idle"
    await sleep(1000)
  }
  return "timeout"
}

export async function waitForIdle(sessionID, deadline, call = api()) {
  if (!isLiveSessionID(sessionID)) return "ignored"
  const stop = { on: false }
  const perms = (async () => {
    while (!stop.on && Date.now() < deadline) {
      await allowExternalDirectory(sessionID, call)
      await sleep(150)
    }
  })()
  try {
    try {
      const abort = waitUntil(deadline)
      try {
        await Promise.race([call("POST", `/session/${sessionID}/wait`), abort.promise])
        return "idle"
      } finally {
        abort.cancel()
      }
    } catch (error) {
      if (error?.code === "DEADLINE") return "timeout"
      const detail = error?.message || String(error)
      if (/\s404\b/.test(detail) || /\s503\b/.test(detail) || /not found|unavailable/i.test(detail)) {
        return await pollUntilIdle(sessionID, deadline, call)
      }
      throw error
    }
  } finally {
    stop.on = true
    await perms
    await allowExternalDirectory(sessionID, call)
  }
}

async function readVerdict(sessionID) {
  const { assistant, withText } = await latestAssistant(sessionID)
  const finish = assistant?.finish ?? assistant?.info?.finish
  const text = assistantText(withText || assistant || {})
  if (finish === "error") return { error: assistant?.error?.message || assistant?.info?.error?.message || "error", verdict: null, text }
  return { error: null, verdict: questVerdict(text), text }
}

async function listChildSessions(sessionID, questID, call) {
  const ids = new Set()
  try {
    const rows = await call("GET", `/session?parentID=${encodeURIComponent(sessionID)}`)
    const list = Array.isArray(rows?.data) ? rows.data : Array.isArray(rows) ? rows : []
    for (const row of list) {
      const id = row?.id
      if (isLiveSessionID(id) && id !== sessionID) ids.add(id)
    }
  } catch { /* parentID filter is optional */ }
  if (questID) {
    const source = questSource(process.env.OPENCODE_CWD || "", questID) || ""
    for (const id of source.match(/ses_[A-Za-z0-9_-]+/g) || []) {
      if (isLiveSessionID(id) && id !== sessionID) ids.add(id)
    }
  }
  return [...ids]
}

async function promptSteer(sessionID, questID, call) {
  const text = steerQuestion(questID)
  try { await call("POST", `/session/${sessionID}/prompt`, { text, delivery: "steer" }) }
  catch { await call("POST", `/session/${sessionID}/prompt`, { text }) }
}

async function driveChildren(parentID, questID, deadline, call) {
  for (const childID of await listChildSessions(parentID, questID, call)) {
    if (Date.now() >= deadline) break
    await waitForIdle(childID, deadline, call)
    const { error, verdict } = await readVerdict(childID)
    if (error || verdict === "COMPLETE") continue
    try { await promptSteer(childID, questID, call) }
    catch (error) { log("child steer failed", childID, error.message) }
    await waitForIdle(childID, deadline, call)
  }
}

export async function notifyStop(sessionID, reason, questID) {
  if (!isLiveSessionID(sessionID)) return false
  const url = String(process.env.OPENCODE_SESSION_STOP_WEBHOOK || "").trim()
  if (!url) return false
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID, reason, questID: questID || undefined }),
    })
    return true
  } catch (error) {
    log("stop webhook failed", error.message)
    return false
  }
}

async function steerLoop(sessionID, { waitMs, maxSteers, questID }) {
  const call = api()
  const deadline = Date.now() + waitMs
  let steers = 0
  await waitForIdle(sessionID, deadline, call)
  for (;;) {
    await driveChildren(sessionID, questID, deadline, call)
    const { error, verdict, text } = await readVerdict(sessionID)
    if (error) {
      await notifyStop(sessionID, "error", questID)
      return { run: "error", detail: error, steers }
    }
    if (verdict === "COMPLETE") {
      await notifyStop(sessionID, "complete", questID)
      return { run: "complete", detail: text, steers }
    }
    if (Date.now() >= deadline) return { run: "timeout", steers }
    if (steers >= maxSteers) return { run: "max-steers", steers }
    await promptSteer(sessionID, questID, call)
    steers++
    await waitForIdle(sessionID, deadline, call)
  }
}

async function watchUntilDone(sessionID, { waitMs, questID, maxSteers }) {
  const call = api()
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    const stolen = tryDriveLock(sessionID)
    if (stolen) {
      try { return await steerLoop(sessionID, { waitMs: Math.max(1, deadline - Date.now()), maxSteers: maxSteers || DEFAULT_MAX_STEERS, questID }) }
      finally { stolen.release() }
    }
    await allowExternalDirectory(sessionID, call)
    await waitForIdle(sessionID, deadline, call)
    const { error, verdict, text } = await readVerdict(sessionID)
    if (error) return { run: "error", detail: error, steers: 0 }
    if (verdict === "COMPLETE") return { run: "complete", detail: text, steers: 0 }
    await sleep(1000)
  }
  return { run: "timeout", steers: 0 }
}

function formatRun(prefixLines, result) {
  const extra = [`Run: ${result.run}`]
  if (result.steers) extra.push(`Steers: ${result.steers}`)
  if (result.run === "complete") extra.push("COMPLETE")
  else if (result.detail) extra.push(String(result.detail).split("\n")[0].slice(0, 300))
  return { content: [{ type: "text", text: [...prefixLines, ...extra].join("\n") }] }
}

async function finishDeskRun(sessionID, input, prefixLines) {
  const waitMs = parseWaitMs(input.wait)
  const maxSteers = parseMaxSteers(input.maxSteers)
  const questID = String(input.questID || input.quest || "").trim()
  if (!isLiveSessionID(sessionID)) {
    return { content: [{ type: "text", text: [...prefixLines, "Run: ignored"].join("\n") }] }
  }
  if (waitMs <= 0) {
    return { content: [{ type: "text", text: [...prefixLines, "Run: immediate"].join("\n") }] }
  }
  spawnDeskDriver({ sessionID, questID, waitMs, maxSteers })
  const lock = tryDriveLock(sessionID)
  const result = lock
    ? await (async () => { try { return await steerLoop(sessionID, { waitMs, maxSteers, questID }) } finally { lock.release() } })()
    : await watchUntilDone(sessionID, { waitMs, questID })
  return formatRun(prefixLines, result)
}

async function startDeskSession(input) {
  const model = normalizeModel(input.model, input.variant || input.effort)
  if (!model) throw new Error("session_start: explicit provider/model is required")
  const call = api()
  const agent = String(input.agent || "build").trim() || "build"
  const title = String(input.title || `${formatModel(model)} - desk`).replace(/\s+/g, " ").slice(0, 240)
  const session = await call("POST", "/session", { title, agent, model })
  const sessionID = session?.id
  if (!sessionID) throw new Error("session create returned no id: " + JSON.stringify(session).slice(0, 300))
  const cwd = input.cwd || process.env.OPENCODE_CWD || ""
  if (cwd && session?.location?.directory !== cwd) {
    try { await call("POST", `/session/${sessionID}/move`, { directory: cwd }) }
    catch (error) { log("move failed", error.message) }
  }
  const text = String(input.text ?? "").trim()
  if (text) await call("POST", `/session/${sessionID}/prompt`, { text })
  const lines = [`Session: ${sessionID}`, `Model: ${formatModel(session?.model || model)}`, `Agent: ${session?.agent || agent}`, text ? "Prompt: sent" : "Prompt: none"]
  if (!text) return { content: [{ type: "text", text: lines.join("\n") }] }
  return finishDeskRun(sessionID, input, lines)
}

async function promptDeskSession(input) {
  const sessionID = String(input.sessionID ?? "").trim()
  if (!/^ses_[A-Za-z0-9_-]+$/.test(sessionID)) throw new Error("session_prompt: valid sessionID is required")
  const text = String(input.text ?? "").trim()
  if (!text) throw new Error("session_prompt: text is required")
  const call = api()
  await call("POST", `/session/${sessionID}/prompt`, { text })
  return finishDeskRun(sessionID, input, [`Session: ${sessionID}`, "Prompt: sent"])
}

const CHECKIN_MS = 90_000

export function checkinQuestion(questID) {
  const id = String(questID ?? "").trim()
  const who = id ? `quest ${id}` : "the current quest"
  return `Check-in only: is ${who} complete? Reply with exactly COMPLETE or NOT_COMPLETE, then one line naming the done-check. Do not summarize or review the work. No Grok reviewer.`
}

async function checkinDeskSession(input) {
  const sessionID = String(input.sessionID ?? "").trim()
  if (!/^ses_[A-Za-z0-9_-]+$/.test(sessionID)) throw new Error("session_checkin: valid sessionID is required")
  await promptDeskSession({ sessionID, text: checkinQuestion(input.questID || input.quest), wait: 0 })
  const deadline = Date.now() + CHECKIN_MS
  while (Date.now() < deadline) {
    const { final, withText, assistant } = await latestAssistant(sessionID)
    if (assistant?.finish === "error") {
      const err = assistant.error?.message || "error"
      return { content: [{ type: "text", text: `Session: ${sessionID}\nNOT_COMPLETE\n${err}` }] }
    }
    if (final) {
      const text = assistantText(withText || final) || "(no assistant output)"
      return { content: [{ type: "text", text: `Session: ${sessionID}\n${text}` }] }
    }
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  throw new Error("session_checkin: timed out waiting for the session to answer")
}

function assistantText(message) {
  const parts = Array.isArray(message?.content) ? message.content : Array.isArray(message?.parts) ? message.parts : []
  return parts.filter((part) => part?.type === "text" && part.text).map((part) => part.text).join("\n").trim()
}

function questSource(cwd, questID) {
  const candidates = [
    cwd && join(cwd, ".opencode", "quests"),
    join(homedir(), ".config", "opencode", ".opencode", "quests"),
  ].filter(Boolean)
  for (const directory of candidates) {
    try {
      const name = readdirSync(directory).find((entry) => entry === `${questID}.md` || entry.startsWith(`${questID}--`))
      if (name) return readFileSync(join(directory, name), "utf8")
    } catch { /* try the next canonical ledger */ }
  }
}

function questField(source, name, fallback) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const raw = source?.match(new RegExp(`^${escaped}:\\s*(.+)$`, "m"))?.[1]
  if (!raw) return fallback
  try { return JSON.parse(raw) } catch { return raw.replace(/^['"]|['"]$/g, "") }
}

function short(value, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim()
  return text.length <= max ? text : text.slice(0, max - 1) + "…"
}

/** Bounded executable context derived from the ledger; extensions/history never enter prompts. */
function compactQuestContext(source, questID) {
  const title = questField(source, "title", "Untitled Quest")
  const objective = questField(source, "objective", "")
  const nextAction = questField(source, "nextAction", "")
  const scope = questField(source, "scope", {})
  const stages = questField(source, "stages", [])
  const deliverables = questField(source, "deliverables", [])
  const criteria = questField(source, "acceptanceCriteria", [])
  const setbacks = questField(source, "setbacks", [])
  const usage = questField(source, "usageInstructions", [])
  const done = new Set(stages.filter((stage) => stage?.status === "done").map((stage) => stage.id))
  const stage = stages.find((item) => item?.status !== "done" && (item.needs ?? []).every((id) => done.has(id)))
    ?? stages.find((item) => item?.status !== "done")
  const stageIndex = stage ? stages.indexOf(stage) + 1 : 0
  const claim = stage?.claim ?? scope
  const paths = Array.isArray(claim?.include) ? claim.include : []
  const visible = paths.some((path) => /(?:^|[\\/])(tui|ui)(?:[\\/]|$)|\.(?:tsx?|jsx?|css|html|svg|png|jpg|jpeg|gif)$/i.test(path))
  const todos = stage?.todos?.filter((item) => item.status !== "done") ?? deliverables.filter((item) => item.status !== "done")
  const latestSetback = [...setbacks].reverse().find((item) => !stage || item.stageID === stage.id)
  const pendingCriteria = criteria.filter((item) => item?.satisfied !== true)
  const lines = [
    `Quest ${questID}: ${short(title, 140)}`,
    objective && `Goal: ${short(objective, 450)}`,
    nextAction && `Now: ${short(nextAction, 200)}`,
    stage && `Stage ${stageIndex}/${stages.length} [${stage.id}, attempt ${stage.attempt ?? 1}]: ${short(stage.title, 180)}`,
    `Proof: ${visible ? "command + run artifact + judgment" : "command"}`,
    latestSetback && `Prior failure (attempt ${latestSetback.attempt}): ${short(latestSetback.reason, 240)}`,
    todos.length && `Todos:\n${todos.slice(0, 6).map((item) => `- ${item.id}: ${short(item.title, 140)}`).join("\n")}`,
    paths.length && `Claim: ${short(paths.slice(0, 12).join(", "), 500)}`,
    Array.isArray(claim?.exclude) && claim.exclude.length && `Avoid: ${short(claim.exclude.slice(0, 8).join(", "), 300)}`,
    pendingCriteria.length && `Acceptance:\n${pendingCriteria.slice(0, 5).map((item) => `- ${item.id}: ${short(item.text, 160)}`).join("\n")}`,
    `Payout: ${usage.length ? `${usage.length} usage instruction(s) recorded` : "missing; Quest cannot complete"}`,
  ].filter(Boolean)
  return lines.join("\n").slice(0, 3600)
}

/** Harness spawn path. OpenCode Quest dispatch uses native subagent, not this server. */
function agentForQuest(cwd, questID) {
  const source = questSource(cwd, questID)
  if (!source) throw new Error(`mcp_agent: Quest ${questID} is not in the canonical ledger`)
  return "build"
}

/** Messages come back newest-first, so the freshest assistant turn is the first hit. */
async function latestAssistant(sessionID) {
  const call = api()
  const messages = await call("GET", `/session/${sessionID}/message`)
  const items = Array.isArray(messages?.data) ? messages.data : Array.isArray(messages) ? messages : []
  const latestUser = items.findIndex((message) => message?.type === "user" || message?.info?.role === "user")
  const currentTurn = latestUser < 0 ? items : items.slice(0, latestUser)
  const assistants = currentTurn.filter((message) => message?.type === "assistant" || message?.info?.role === "assistant")
  const assistant = assistants[0]
  const finish = assistant?.finish ?? assistant?.info?.finish
  const completed = assistant?.time?.completed ?? assistant?.info?.time?.completed
  // Only the newest message can finish the current turn. An older `stop`
  // belongs to a prior continuation and must not make this turn look done.
  const final = currentTurn[0] === assistant && completed && finish && finish !== "tool-calls" ? assistant : undefined
  const withText = assistants.find((message) => assistantText(message))
  return { items, assistant, final, withText }
}

// --- tools --------------------------------------------------------------

async function startAgent(input) {
  const task = String(input.task ?? "").trim()
  if (!task) throw new Error("mcp_agent: task is required")
  const questID = String(input.questID ?? "").trim()
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(questID)) throw new Error("mcp_agent: valid questID is required")
  const call = api()
  const cwd = input.cwd || process.env.OPENCODE_CWD || ""

  const model = normalizeModel(input.model)
  if (!model) throw new Error("mcp_agent: explicit provider/model is required")
  const requestedSessionID = String(input.sessionID ?? "").trim()
  if (requestedSessionID && !/^ses_[A-Za-z0-9_-]+$/.test(requestedSessionID)) throw new Error("mcp_agent: invalid sessionID")

  let session
  let title
  let sessionID
  if (requestedSessionID) {
    if (!questSource(cwd, questID)?.includes(requestedSessionID)) throw new Error(`mcp_agent: session ${requestedSessionID} is not bound to Quest ${questID}`)
    session = await call("GET", `/session/${requestedSessionID}`)
    const existingModel = session?.model
    if (existingModel && (existingModel.providerID !== model.providerID || existingModel.id !== model.id)) throw new Error(`mcp_agent: session model is immutable (${existingModel.providerID}/${existingModel.id})`)
    sessionID = requestedSessionID
    title = session?.title || `${model.providerID}/${model.id} - ${task.replace(/\s+/g, " ")}`.slice(0, 240)
  } else {
    // `agent` is deliberately not caller-selectable. It is the hidden host
    // capability envelope, derived from canonical Quest lineage.
    const agent = agentForQuest(cwd, questID)
    // This is the only worker label users should see: model, hyphen, task.
    title = `${model.providerID}/${model.id} - ${task.replace(/\s+/g, " ")}`.slice(0, 240)
    session = await call("POST", "/session", { title, agent, model })
    sessionID = session?.id
    if (!sessionID) throw new Error("session create returned no id: " + JSON.stringify(session).slice(0, 300))
  }

  // A session is created in the server's own directory; `move` is the only way
  // to put it in the caller's. Non-fatal: a misplaced subagent still runs.
  let directory = session?.location?.directory
  if (cwd && directory !== cwd) {
    try {
      await call("POST", `/session/${sessionID}/move`, { directory: cwd })
      directory = cwd
    } catch (error) {
      log("move failed, subagent stays in", directory, "-", error.message)
    }
  }

  const source = questSource(cwd, questID)
  if (!source) throw new Error(`mcp_agent: Quest ${questID} is not in the canonical ledger`)
  const text = `${compactQuestContext(source, questID)}\n\nTask: ${short(task, 500)}`
  try {
    await call("POST", `/session/${sessionID}/prompt`, { text })
  } catch (error) {
    // Preserve the created session identity so the Quest hook can bind and
    // terminalize it instead of leaving a phantom planned owner.
    throw new Error(`Session: ${sessionID}\nPrompt failed: ${error?.message ?? String(error)}`)
  }

  return {
    content: [{
      type: "text",
      text: [
        title,
        `Session: ${sessionID}`,
      ].join("\n"),
    }],
  }
}

async function taskStatus(input) {
  const sessionID = String(input.sessionID || input.runID || "").trim()
  if (!sessionID) throw new Error("mcp_agent_status: sessionID or runID required")
  const call = api()
  const session = await call("GET", `/session/${sessionID}`)
  const { items, assistant, final } = await latestAssistant(sessionID)
  // A tool-calls finish means the model is between tool turns, not done.
  const done = Boolean(final)
  const state = items.length === 0 ? "queued" : done ? "completed" : "running"
  return {
    content: [{
      type: "text",
      text: [
        `Session ${sessionID}: ${state}`,
        `Title: ${session?.title ?? "(untitled)"}`,
        `Model: ${session?.model?.providerID ?? "?"}/${session?.model?.id ?? "?"}`,
        `Messages: ${items.length}${(assistant?.finish ?? assistant?.info?.finish) ? `  Finish: ${assistant?.finish ?? assistant?.info?.finish}` : ""}`,
        session?.cost != null ? `Cost: ${session.cost}` : "",
      ].filter(Boolean).join("\n"),
    }],
  }
}

async function taskOutput(input) {
  const sessionID = String(input.sessionID || input.runID || "").trim()
  if (!sessionID) throw new Error("mcp_agent_output: sessionID or runID required")
  const { items, withText } = await latestAssistant(sessionID)
  const text = withText ? assistantText(withText) : ""
  return {
    content: [{
      type: "text",
      text: text
        ? `Output for ${sessionID}:\n${text.slice(0, 10000)}`
        : `Output for ${sessionID}: (no assistant output yet, ${items.length} message(s) so far)`,
    }],
  }
}

async function pickModel(input) {
  const task = String(input.task ?? "").trim()
  if (!task) throw new Error("pick_model: task required")
  const call = api()
  let ids = []
  try {
    const models = await call("GET", "/model")
    const list = Array.isArray(models?.data) ? models.data : Array.isArray(models) ? models : []
    ids = list.map((model) => `${model.providerID}/${model.modelID ?? model.id}`)
  } catch (error) {
    log("model list failed:", error.message)
  }
  // The harness providers are the interesting ones; the raw list runs to hundreds.
  const harness = ids.filter((id) => /^(cliproxyapi|openai|claude-code|grok-build|grok-sub|codex|opencode-go)\//.test(id))
  return {
    content: [{
      type: "text",
      text: [
        `Recommended for "${task.slice(0, 100)}": ${DEFAULT_MODEL.providerID}/${DEFAULT_MODEL.id}`,
        harness.length ? `Harness models: ${harness.join(", ")}` : "",
        ids.length ? `${ids.length} models available in total.` : "Model list unavailable; the recommendation is the built-in default.",
      ].filter(Boolean).join("\n"),
    }],
  }
}


async function driveDeskCli(flags) {
  process.env.OPENCODE_DESK_DRIVER = "0"
  const sessionID = String(flags.id || "").trim()
  const waitMs = parseWaitMs(flags.wait === undefined || flags.wait === "" ? DEFAULT_WAIT_MS : flags.wait) || DEFAULT_WAIT_MS
  const maxSteers = parseMaxSteers(flags["max-steers"])
  const questID = String(flags.quest || "").trim()
  if (!isLiveSessionID(sessionID)) {
    return { content: [{ type: "text", text: `Session: ${sessionID}\nRun: ignored` }] }
  }
  const lock = tryDriveLock(sessionID)
  const result = lock
    ? await (async () => { try { return await steerLoop(sessionID, { waitMs, maxSteers, questID }) } finally { lock.release() } })()
    : await watchUntilDone(sessionID, { waitMs, questID })
  return formatRun([`Session: ${sessionID}`], result)
}

function parseDeskArgs(argv) {
  const flags = {}
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--model" || arg === "--variant" || arg === "--effort" || arg === "--agent" || arg === "--title" || arg === "--text" || arg === "--id" || arg === "--cwd" || arg === "--task" || arg === "--quest" || arg === "--wait" || arg === "--max-steers") {
      flags[arg.slice(2)] = argv[++i] ?? ""
    } else if (arg.startsWith("--")) {
      throw new Error("unknown flag " + arg)
    } else rest.push(arg)
  }
  return { flags, rest }
}

async function runDeskCli(argv) {
  const sub = argv[0]
  const { flags, rest } = parseDeskArgs(argv.slice(1))
  let result
  if (sub === "start") {
    result = await startDeskSession({
      model: flags.model || rest[0],
      variant: flags.variant || flags.effort,
      agent: flags.agent,
      title: flags.title,
      text: flags.text || (flags.model ? rest.join(" ") : rest.slice(1).join(" ")),
      cwd: flags.cwd,
      questID: flags.quest,
      wait: flags.wait,
      maxSteers: flags["max-steers"],
    })
  } else if (sub === "prompt") {
    result = await promptDeskSession({ sessionID: flags.id || rest[0], text: flags.text || rest.slice(1).join(" "), questID: flags.quest, wait: flags.wait, maxSteers: flags["max-steers"] })
  } else if (sub === "drive") {
    result = await driveDeskCli(flags)
  } else if (sub === "status") {
    result = await taskStatus({ sessionID: flags.id || rest[0] })
  } else if (sub === "checkin") {
    result = await checkinDeskSession({ sessionID: flags.id || rest[0], questID: flags.quest || rest[1] })
  } else if (sub === "models") {
    result = await pickModel({ task: flags.task || rest.join(" ") || "desk" })
  } else {
    throw new Error("usage: session start|prompt|drive|status|checkin|models")
  }
  process.stdout.write((result.content?.[0]?.text || "") + "\n")
}

function isMainModule() {
  const entry = process.argv[1]
  if (!entry) return false
  try { return fileURLToPath(import.meta.url) === resolve(entry) } catch { return false }
}

if (process.argv[2] === "session") {
  runDeskCli(process.argv.slice(3)).catch((error) => {
    console.error(error.message || error)
    process.exit(1)
  })
} else if (isMainModule()) {
// --- MCP JSON-RPC loop --------------------------------------------------

const rl = createInterface({ input: process.stdin, terminal: false })

let inFlight = 0
let stdinClosed = false
// A tool call outlives the line that started it, so only exit once both the
// pipe is closed and nothing is still in flight.
const exitWhenIdle = () => { if (stdinClosed && inFlight === 0) process.exit(0) }

rl.on("line", async (line) => {
  if (!line.trim()) return
  let message
  try { message = JSON.parse(line) } catch { log("invalid json:", line.slice(0, 200)); return }
  const { id, method, params } = message
  const isNotification = id === undefined
  const send = (payload) => { if (!isNotification) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...payload }) + "\n") }

  inFlight++
  try {
    if (method === "initialize") {
      send({ result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "opencode", version: "1.0.0" } } })
    } else if (method === "notifications/initialized" || method === "notifications/cancelled") {
      // no-op
    } else if (method === "ping") {
      send({ result: {} })
    } else if (method === "tools/list") {
      send({ result: { tools: TOOLS } })
    } else if (method === "resources/list") {
      send({ result: { resources: [] } })
    } else if (method === "prompts/list") {
      send({ result: { prompts: [] } })
    } else if (method === "tools/call") {
      const name = params?.name
      const args = params?.arguments || {}
      let result
      if (name === "agent") result = await startAgent(args)
      else if (name === "pick_model") result = await pickModel(args)
      else if (name === "agent_status" || name === "session_status") result = await taskStatus(args)
      else if (name === "agent_output") result = await taskOutput(args)
      else if (name === "session_start") result = await startDeskSession(args)
      else if (name === "session_prompt") result = await promptDeskSession(args)
      else if (name === "session_checkin") result = await checkinDeskSession(args)
      else throw new Error(`unknown tool: ${name}`)
      send({ result: { content: result.content } })
    } else {
      send({ error: { code: -32601, message: `Method not found: ${method}` } })
    }
  } catch (error) {
    const detail = error?.message || String(error)
    log("error handling", method, detail)
    // Tool failures go back in-band so the model can react to them; protocol
    // failures use the JSON-RPC error channel.
    if (method === "tools/call") send({ result: { content: [{ type: "text", text: `Error: ${detail}` }], isError: true } })
    else send({ error: { code: -32603, message: detail } })
  } finally {
    inFlight--
    exitWhenIdle()
  }
})

rl.on("close", () => { stdinClosed = true; exitWhenIdle() })

process.on("uncaughtException", (error) => log("uncaught", error))
process.on("unhandledRejection", (error) => log("unhandled", error))

log("started pid", process.pid, "parent", process.env.OPENCODE_PARENT_SESSION_ID || "none")
}
