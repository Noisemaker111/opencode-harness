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
 * Routes used, all confirmed against the instance's /openapi.json:
 *   POST /api/session               { title, agent, model: { providerID, id } }
 *   POST /api/session/{id}/move     { directory }
 *   POST /api/session/{id}/prompt   { text } — durably admits, returns at once
 *   GET  /api/session/{id}
 *   GET  /api/session/{id}/message  newest-first
 *   GET  /api/model
 */

import { readFileSync, existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"

/** Used when the caller names no model. Must exist in GET /api/model. */
const DEFAULT_MODEL = { providerID: "opencode-go", id: "grok-4.6" }

const TOOLS = [
  {
    name: "agent",
    description: "Start a model worker through the OpenCode server. This is mcp_agent in OpenCode and returns immediately with a session ID to poll.",
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
]

function log(...args) {
  // MCP servers must not write to stdout except JSON-RPC. Use stderr.
  console.error("[opencode-mcp]", ...args)
}

// --- service discovery -------------------------------------------------

function discoverService() {
  if (process.env.OPENCODE_SERVER_URL) {
    return { url: process.env.OPENCODE_SERVER_URL, password: process.env.OPENCODE_PASSWORD || "" }
  }
  const candidates = [
    process.env.OPENCODE_SERVICE_FILE,
    join(homedir(), ".local", "state", "opencode", "service.json"),
    join(homedir(), ".config", "opencode", "service.json"),
  ].filter(Boolean)
  for (const path of candidates) {
    if (!existsSync(path)) continue
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"))
      if (parsed.url) return parsed
    } catch { /* try the next candidate */ }
  }
  return null
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

/** Explicit `provider/model` to the { providerID, id } the API wants. */
function normalizeModel(model) {
  const raw = String(model ?? "").trim()
  if (!raw) return null
  const slash = raw.indexOf("/")
  if (slash > 0) {
    const providerID = raw.slice(0, slash).trim()
    const id = raw.slice(slash + 1).trim()
    if (providerID && id) return { providerID, id }
  }
  return null
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

/** The caller supplies no role. The first planned session owns the Quest; its descendants are workers. */
function agentForQuest(cwd, questID) {
  const source = questSource(cwd, questID)
  if (!source) throw new Error(`mcp_agent: Quest ${questID} is not in the canonical ledger`)
  const boundOwner = /^integrationOwner:\s*["']?ses_[A-Za-z0-9_-]+/m.test(source)
  const plannedOwner = /^sessions:\s*.*"role":"integration-owner".*"state":"planned"/m.test(source)
  if (!boundOwner && !plannedOwner) throw new Error(`mcp_agent: Quest ${questID} has no derived integration-owner plan`)
  return boundOwner ? "build" : "orchestrator"
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
  const harness = ids.filter((id) => /^(claude-code|grok-build|grok-sub|codex|opencode-go)\//.test(id))
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
      else if (name === "agent_status") result = await taskStatus(args)
      else if (name === "agent_output") result = await taskOutput(args)
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
