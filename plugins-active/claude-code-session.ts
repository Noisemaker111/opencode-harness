/**
 * Session-model path for Claude Code: picker identity claude-code/claude
 * (opus/sonnet) talks through the official CLI. Not an Anthropic API provider.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { CLAUDE_CODE_MODELS, CLAUDE_CODE_PROVIDER, claudeCliModelID, ensureClaudeCodeCatalog, isClaudeCodeModel, splitProviderModel } from "../models/model-catalog"
import { resolveClaudeExecutable, runClaudeCodeChat, type ClaudeCodeCliResult } from "./claude-code-task"
import { harnessForProvider, harnessList, type HarnessStreamEvent } from "../harnesses"
import { runHarness } from "./harness-run"
import { USAGE_REACHED } from "../usage/usage-reached"

export const CLAUDE_CODE_BRIDGE_HOST = "127.0.0.1"
export const CLAUDE_CODE_BRIDGE_PORT = Number(process.env.CLAUDE_CODE_BRIDGE_PORT ?? 3012)
export const CLAUDE_CODE_BRIDGE_URL = `http://${CLAUDE_CODE_BRIDGE_HOST}:${CLAUDE_CODE_BRIDGE_PORT}/v1`

const STATE_FILES = [
  join(homedir(), ".local", "state", "opencode", "model.json"),
  join(homedir(), ".local", "share", "opencode", "state", "model.json"),
]
const BRIDGE_STATE = Symbol.for("opencode-config.claude-code-bridge")

type Fav = { providerID: string; modelID: string }
type BridgeState = { server?: ReturnType<typeof createServer>; cwd: string; run: typeof runClaudeCodeChat }
type SessionEvent = {
  sessionID?: string
  cwd?: string
  model?: unknown
  sessionModel?: unknown
  messages?: unknown
  prompt?: unknown
  input?: { model?: unknown }
  tools?: Record<string, unknown>
  abortSignal?: AbortSignal
  signal?: AbortSignal
  onEvent?: (event: HarnessStreamEvent) => void
}

function bridgeState(): BridgeState {
  const g = globalThis as { [BRIDGE_STATE]?: BridgeState }
  if (!g[BRIDGE_STATE]) g[BRIDGE_STATE] = { cwd: process.cwd(), run: runClaudeCodeChat }
  return g[BRIDGE_STATE]
}

export function lastUserPrompt(messages: unknown): string {
  if (typeof messages === "string") return messages.trim()
  if (!Array.isArray(messages)) return ""
  for (let i = messages.length - 1; i >= 0; i--) {
    const row = messages[i]
    if (!row || typeof row !== "object") continue
    const role = String((row as { role?: unknown }).role ?? "").toLowerCase()
    if (role && role !== "user") continue
    const content = (row as { content?: unknown; text?: unknown }).content ?? (row as { text?: unknown }).text
    if (typeof content === "string" && content.trim()) return content.trim()
    if (Array.isArray(content)) {
      const text = content.flatMap((part) => typeof part === "string" ? [part] : part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? [(part as { text: string }).text] : []).join("\n").trim()
      if (text) return text
    }
  }
  return ""
}

export function sessionModelRef(event: SessionEvent): { providerID: string; modelID: string } | undefined {
  const model = event.model ?? event.sessionModel
  if (typeof model === "string") return splitProviderModel(model)
  if (model && typeof model === "object") {
    const providerID = String((model as { providerID?: unknown }).providerID ?? "")
    const modelID = String((model as { id?: unknown; modelID?: unknown }).id ?? (model as { modelID?: unknown }).modelID ?? "")
    if (providerID && modelID) return { providerID, modelID }
  }
  return
}

export function assertClaudeCodeNotRelayed(sessionModel: unknown, requested?: unknown) {
  if (!isClaudeCodeModel(sessionModel)) return
  const pin = typeof requested === "string" ? requested : requested && typeof requested === "object" ? `${(requested as { providerID?: string }).providerID ?? ""}/${(requested as { id?: string; modelID?: string }).id ?? (requested as { modelID?: string }).modelID ?? ""}` : ""
  if (pin && pin !== "/" && !isClaudeCodeModel(requested) && !isClaudeCodeModel(pin)) {
    throw new Error(`Claude Code session must not pin a relay model (${pin}). Chat goes to the official CLI.`)
  }
}

export function ensureClaudeCodeFavoriteList(favorite: Fav[]): Fav[] {
  if (favorite.some((row) => row.providerID === CLAUDE_CODE_PROVIDER && row.modelID === "claude")) return favorite
  return [{ providerID: CLAUDE_CODE_PROVIDER, modelID: "claude" }, ...favorite]
}

export function persistClaudeCodeFavorite(files = STATE_FILES): boolean {
  const file = files.find((path) => existsSync(path))
  if (!file) return false
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as { favorite?: unknown }
    const current = Array.isArray(parsed.favorite) ? parsed.favorite.filter((row): row is Fav => !!row && typeof row === "object" && typeof (row as Fav).providerID === "string" && typeof (row as Fav).modelID === "string") : []
    const next = ensureClaudeCodeFavoriteList(current)
    if (next === current || (next.length === current.length && next[0]?.providerID === current[0]?.providerID && next[0]?.modelID === current[0]?.modelID)) return false
    writeFileSync(file, JSON.stringify({ ...parsed, favorite: next }))
    return true
  } catch {
    return false
  }
}

function promptFromEvent(event: SessionEvent): string {
  if (typeof event.prompt === "string") return event.prompt.trim()
  if (event.prompt && typeof event.prompt === "object" && typeof (event.prompt as { text?: unknown }).text === "string") return String((event.prompt as { text: string }).text).trim()
  return lastUserPrompt(event.messages)
}

export async function interceptClaudeCodeSession(event: unknown, run: typeof runClaudeCodeChat = runClaudeCodeChat) {
  const ev = (event ?? {}) as SessionEvent
  const ref = sessionModelRef(ev)
  if (!isClaudeCodeModel(ref ?? ev.model ?? ev.sessionModel)) return
  assertClaudeCodeNotRelayed(ref ?? ev.model ?? ev.sessionModel, ev.input?.model)
  const prompt = promptFromEvent(ev)
  if (!prompt) throw new Error("Claude Code chat prompt is empty.")
  return run({
    prompt,
    cwd: typeof ev.cwd === "string" ? ev.cwd : bridgeState().cwd,
    sessionKey: typeof ev.sessionID === "string" ? ev.sessionID : undefined,
    model: claudeCliModelID(ref?.modelID),
  }, {
    sessionID: typeof ev.sessionID === "string" ? ev.sessionID : undefined,
    abortSignal: ev.abortSignal,
    signal: ev.signal,
    onEvent: ev.onEvent,
  })
}

export function prepareClaudeCodeContext(event: SessionEvent) {
  if (!isClaudeCodeModel(event.model ?? event.sessionModel ?? sessionModelRef(event))) return
  assertClaudeCodeNotRelayed(event.model ?? event.sessionModel, event.input?.model)
  if (event.tools) for (const key of Object.keys(event.tools)) delete event.tools[key]
  if (!resolveClaudeExecutable()) throw new Error("client-not-started: Claude Code CLI was not found. Install and authenticate Claude Code normally.")
}

export const SSE_CONTENT_TYPE = "text/event-stream; charset=utf-8"

export function openaiChatCompletion(text: string, model: string, stream: boolean) {
  const id = `chatcmpl-claude-${Date.now().toString(36)}`
  const created = Math.floor(Date.now() / 1000)
  if (!stream) {
    return JSON.stringify({ id, object: "chat.completion", created, model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] })
  }
  // SSE events are separated by a BLANK line. Joining with a single "\n" made
  // the client read one malformed event and report "stream ended without
  // finish_reason", so every streamed harness turn failed.
  return [
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}`,
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
    "data: [DONE]",
    "",
  ].join("\n\n")
}

// ---- Incremental SSE streaming --------------------------------------------
// The CLIs already emit stream events; buffering their whole stdout and
// answering with ONE chunk threw all of that away. When the request streams,
// the bridge writes real SSE as the events arrive: thinking → reasoning_content,
// text → content, tools → visible activity lines, then the terminal text
// (deduplicated against what was already streamed) and finish/[DONE].

export type BridgeWrite = (chunk: string) => void
export type BridgeStream = (write: BridgeWrite, signal?: AbortSignal) => Promise<void>
export type BridgeResponse = { status: number; contentType: string; body: string; stream?: BridgeStream; streamMeta?: { id: string; created: number; model: string } }

/** A failure raised by a stream that has not written anything yet, so the HTTP status is still settable. */
export class BridgeStreamError extends Error {
  constructor(readonly response: { status: number; contentType: string; body: string }) {
    super("bridge stream failed before any output")
    this.name = "BridgeStreamError"
  }
}

function sseDelta(meta: { id: string; created: number; model: string }, delta: Record<string, unknown>, finish_reason: string | null = null): string {
  return `data: ${JSON.stringify({ id: meta.id, object: "chat.completion.chunk", created: meta.created, model: meta.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`
}

/**
 * What is left of the terminal text after the deltas already streamed. The
 * terminal message normally repeats the streamed text in full — re-sending it
 * doubled every answer; when the shapes diverge (a plain-text CLI's trimmed
 * stdout, say) the deltas already carry the answer, so nothing is added.
 */
export function remainingText(final: string, streamed: string): string {
  if (!final) return ""
  if (!streamed) return final
  if (final.startsWith(streamed)) return final.slice(streamed.length)
  return ""
}

/**
 * Run one harness turn and write it as incremental OpenAI SSE. Failures that
 * happen before any output propagate as a BridgeStreamError so the caller can
 * still send the mapped HTTP status; failures after output are delivered
 * inside the stream.
 */
function streamTurn(options: {
  write: BridgeWrite
  signal?: AbortSignal
  meta: { id: string; created: number; model: string }
  turn: (onEvent: (event: HarnessStreamEvent) => void) => Promise<string>
  mapError: (error: unknown) => { status: number; contentType: string; body: string }
}): Promise<void> {
  const { write, signal, meta, turn, mapError } = options
  let sent = false
  const emit = (delta: Record<string, unknown>, finish_reason: string | null = null) => {
    if (signal?.aborted) return
    sent = true
    write(sseDelta(meta, delta, finish_reason))
  }
  let streamed = ""
  return (async () => {
    try {
      const text = await turn((event) => {
        if (event.kind === "thinking" && event.text) emit({ reasoning_content: event.text })
        else if (event.kind === "text" && event.text) { streamed += event.text; emit({ content: event.text }) }
        else if (event.kind === "tool") emit({ content: `[tool] ${event.name ?? "tool"}${event.text ? `: ${event.text}` : ""}\n` })
        // "final" and "error" events are folded into the terminal text and
        // the thrown failure below; nothing is written for them here.
      })
      const tail = remainingText(text, streamed)
      if (tail) emit({ content: tail })
      emit({}, "stop")
      if (!signal?.aborted) write("data: [DONE]\n\n")
    } catch (error) {
      if (!sent) throw new BridgeStreamError(mapError(error))
      const message = error instanceof Error ? error.message : String(error)
      emit({ content: `\n[error] ${message}` })
      emit({}, "stop")
      if (!signal?.aborted) write("data: [DONE]\n\n")
    }
  })()
}

function harnessErrorResponse(error: unknown): { status: number; contentType: string; body: string } {
  const message = error instanceof Error ? error.message : String(error)
  const missing = /client-not-started/i.test(message)
  const spent = message.startsWith(USAGE_REACHED)
  return { status: missing ? 503 : spent ? 429 : 500, contentType: "application/json; charset=utf-8", body: JSON.stringify({ error: { message, type: missing ? "not_found" : spent ? "usage_reached" : "api_error" } }) }
}

function claudeErrorResponse(error: unknown): { status: number; contentType: string; body: string } {
  const message = error instanceof Error ? error.message : String(error)
  const auth = /auth:|not authenticated|login/i.test(message)
  const missing = /client-not-started|CLI was not found/i.test(message)
  return { status: missing ? 503 : auth ? 401 : 500, contentType: "application/json; charset=utf-8", body: JSON.stringify({ error: { message, type: missing ? "not_found" : auth ? "authentication_error" : "api_error" } }) }
}

export async function handleClaudeCodeChatCompletions(body: unknown, headers: Record<string, string | string[] | undefined>, run: typeof runClaudeCodeChat = bridgeState().run): Promise<BridgeResponse> {
  const payload = body && typeof body === "object" ? body as { messages?: unknown; model?: unknown; stream?: unknown } : {}
  const sessionID = String(headers["x-opencode-session-id"] ?? headers["x-session-id"] ?? "").trim() || undefined
  const requested = typeof payload.model === "string" ? payload.model : `${CLAUDE_CODE_PROVIDER}/claude`
  const stream = payload.stream === true
  const meta = { id: `chatcmpl-claude-${Date.now().toString(36)}`, created: Math.floor(Date.now() / 1000), model: requested }

  // Non-Claude harnesses (Grok Build, Codex) ride the same bridge: same
  // OpenAI-compatible shape, same failure vocabulary, different CLI.
  const [maybeProvider, ...restOfModel] = requested.split("/")
  const harness = maybeProvider === CLAUDE_CODE_PROVIDER ? undefined : harnessForProvider(maybeProvider)
  if (harness) {
    const runTurn = (onEvent: (event: HarnessStreamEvent) => void, signal?: AbortSignal) => runHarness({
      harness: harness.id,
      prompt: lastUserPrompt(payload.messages),
      cwd: bridgeState().cwd,
      model: restOfModel.join("/") || harness.models[0]?.id,
      sessionId: sessionID,
    }, { onEvent, abortSignal: signal })
    if (!stream) {
      try {
        const result = await runTurn(() => {})
        return { status: 200, contentType: "application/json; charset=utf-8", body: openaiChatCompletion(result.text, requested, false) }
      } catch (error) {
        return harnessErrorResponse(error)
      }
    }
    return {
      status: 200, contentType: SSE_CONTENT_TYPE, body: "", streamMeta: meta,
      stream: (write, signal) => streamTurn({ write, signal, meta, turn: runTurn, mapError: harnessErrorResponse }),
    }
  }

  const modelID = requested.replace(/^claude-code\//, "")
  const runClaudeTurn = async (onEvent: (event: HarnessStreamEvent) => void, signal?: AbortSignal) => {
    const result = await interceptClaudeCodeSession({
      sessionID,
      model: { providerID: CLAUDE_CODE_PROVIDER, id: modelID },
      messages: payload.messages,
      cwd: bridgeState().cwd,
      onEvent,
      abortSignal: signal,
    }, run) as ClaudeCodeCliResult | undefined
    if (!result || typeof result.text !== "string") throw new Error("Claude Code session intercept returned no CLI result.")
    return result.text || "Claude Code completed without a text response."
  }
  if (!stream) {
    try {
      const text = await runClaudeTurn(() => {})
      return { status: 200, contentType: "application/json; charset=utf-8", body: openaiChatCompletion(text, `${CLAUDE_CODE_PROVIDER}/${modelID}`, false) }
    } catch (error) {
      return claudeErrorResponse(error)
    }
  }
  return {
    status: 200, contentType: SSE_CONTENT_TYPE, body: "", streamMeta: meta,
    stream: (write, signal) => streamTurn({ write, signal, meta, turn: runClaudeTurn, mapError: claudeErrorResponse }),
  }
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString("utf8")
}

function headerMap(req: IncomingMessage): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {}
  for (const [key, value] of Object.entries(req.headers)) out[key.toLowerCase()] = value
  return out
}

async function dispatchBridge(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || "/", `http://${CLAUDE_CODE_BRIDGE_HOST}:${CLAUDE_CODE_BRIDGE_PORT}`)
  if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/v1/health")) {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" })
    res.end(JSON.stringify({ ok: true, runtime: "claude-code" }))
    return
  }
  if (req.method === "GET" && url.pathname === "/v1/models") {
    // Every registered harness is listed, so one bridge URL serves Claude
    // Code, Grok Build and Codex the same way.
    const data = [
      ...CLAUDE_CODE_MODELS.map((model) => ({ id: model.modelID, object: "model", owned_by: CLAUDE_CODE_PROVIDER })),
      ...harnessList()
        .filter((h) => h.provider !== CLAUDE_CODE_PROVIDER)
        .flatMap((h) => h.models.map((model) => ({ id: model.id, object: "model", owned_by: h.provider }))),
    ]
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" })
    res.end(JSON.stringify({ object: "list", data }))
    return
  }
  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    let parsed: unknown = {}
    try { parsed = JSON.parse(await readRequestBody(req) || "{}") } catch { parsed = {} }
    const result = await handleClaudeCodeChatCompletions(parsed, headerMap(req))
    if (!result.stream) {
      res.writeHead(result.status, { "content-type": result.contentType })
      res.end(result.body)
      return
    }
    // Streaming: headers go out with the first write, so a turn that fails
    // before producing any output can still return its mapped error status.
    const abort = new AbortController()
    res.on("close", () => { if (!res.writableEnded) abort.abort() })
    let wrote = false
    const write: BridgeWrite = (chunk: string) => {
      if (res.writableEnded || res.destroyed) return
      if (!wrote) { res.writeHead(result.status, { "content-type": result.contentType }); wrote = true }
      res.write(chunk)
    }
    try {
      await result.stream(write, abort.signal)
    } catch (error) {
      if (error instanceof BridgeStreamError && !wrote) {
        res.writeHead(error.response.status, { "content-type": error.response.contentType })
        res.end(error.response.body)
        return
      }
      // Headers are already gone; deliver the failure inside the stream.
      const message = error instanceof Error ? error.message : String(error)
      const meta = result.streamMeta ?? { id: "chatcmpl-claude-error", created: Math.floor(Date.now() / 1000), model: "" }
      write(sseDelta(meta, { content: `\n[error] ${message}` }))
      write(sseDelta(meta, {}, "stop"))
      write("data: [DONE]\n\n")
    }
    res.end()
    return
  }
  res.writeHead(404, { "content-type": "application/json; charset=utf-8" })
  res.end(JSON.stringify({ error: { message: "not found" } }))
}

export function startClaudeCodeBridge(options: { cwd?: string; run?: typeof runClaudeCodeChat; listen?: boolean } = {}) {
  const state = bridgeState()
  if (options.cwd) state.cwd = options.cwd
  if (options.run) state.run = options.run
  if (options.listen === false) return state.server
  if (state.server) return state.server
  const server = createServer((req, res) => { void dispatchBridge(req, res).catch((error) => {
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json; charset=utf-8" })
    res.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }))
  }) })
  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.warn(`[claude-code-session] bridge port ${CLAUDE_CODE_BRIDGE_PORT} in use; reusing existing listener`)
      if (state.server === server) state.server = undefined
      return
    }
    console.error("[claude-code-session] bridge failed:", error)
  })
  server.listen(CLAUDE_CODE_BRIDGE_PORT, CLAUDE_CODE_BRIDGE_HOST)
  state.server = server
  return server
}

export function stopClaudeCodeBridge() {
  const state = bridgeState()
  const server = state.server
  if (!server) return
  state.server = undefined
  server.close()
}

export async function installClaudeCodeSession(ctx: {
  session?: { hook?: Function }
  catalog?: { transform?: Function }
  location?: { directory?: string }
}, run: typeof runClaudeCodeChat = runClaudeCodeChat, options: { listen?: boolean; favoriteFiles?: string[] } = {}) {
  startClaudeCodeBridge({ cwd: ctx.location?.directory || process.cwd(), run, listen: options.listen })
  persistClaudeCodeFavorite(options.favoriteFiles)
  const catalog = ctx.catalog
  if (typeof catalog?.transform === "function") {
    try {
      await catalog.transform((draft: { model?: { update?: Function } }) => {
        for (const model of ensureClaudeCodeCatalog([])) {
          draft.model?.update?.(model.providerID, model.modelID, (next: { name?: string }) => { next.name = model.name })
        }
      })
    } catch (error) {
      console.warn("[claude-code-session] catalog.transform unavailable:", error)
    }
  }
  const hook = ctx.session?.hook
  if (typeof hook !== "function") return
  await hook("context", (event: SessionEvent) => { prepareClaudeCodeContext(event) })
  await hook("http.request", (event: { sessionID?: string; request?: { url?: string; headers?: { set?: Function } } }) => {
    const url = String(event.request?.url ?? "")
    if (!url.includes(`:${CLAUDE_CODE_BRIDGE_PORT}`) && !url.includes("claude-code")) return
    if (event.sessionID) event.request?.headers?.set?.("x-opencode-session-id", event.sessionID)
  })
}
