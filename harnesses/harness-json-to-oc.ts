/**
 * harness-json-to-oc.ts — one pretty layer for every harness.
 *
 * Image 1 (broken): `tool Bash: {"command":"ls -la ...","description":"List home directory"}`
 * Image 2 (nice):    `$ ls -la /c/Users/Jk101 2>/dev/null | head -60`
 *                    `FullName …`  `Command exited with code 0.`
 *                    `→ Explored - 1 read`  `+ Thought · 2 steps · 12.6s`
 *
 * Each harness speaks its own JSON dialect (Claude's stream-json, Codex's
 * exec --json, Grok's plain). This file is the single translation surface:
 * raw JSON -> opencode's canonical display. No spawning, no ledger, no
 * side-effects — a pure formatter each spec can call from its `streamEvent`
 * / `streamEventLine`.
 *
 * Owner: harnesses/ (pure). Import only from ./types and stdlib — boundary
 * test in test/harnesses.test.ts enforces this.
 */

import type { HarnessID, HarnessStreamEvent } from "./types"

// ---------------------------------------------------------------------------
// tiny helpers
// ---------------------------------------------------------------------------

const MAX_TOOL_TEXT = 300
const MAX_ONE_LINE = 240

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n - 1) + "…"
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim()
}

function truncateOneLine(s: string, n = MAX_ONE_LINE): string {
  return truncate(oneLine(s), n)
}

function shortPath(p: string): string {
  // keep last 2 segments for readability, but preserve absolute hint
  const norm = p.replace(/\\/g, "/")
  const parts = norm.split("/").filter(Boolean)
  if (parts.length <= 3) return p
  return "…/" + parts.slice(-2).join("/")
}

function formatDescription(d: string | undefined): string {
  return d ? `  • ${truncateOneLine(d, 80)}` : ""
}

// ---------------------------------------------------------------------------
// Claude Code — each tool has a hand-tuned line
// Image-1's `{"command":"…","description":"…"}` becomes Image-2's `$ …`
// ---------------------------------------------------------------------------

function claudeBash(input: Record<string, unknown>): string {
  const cmd = asString(input.command) ?? asString(input.cmd) ?? ""
  const desc = asString(input.description) ?? asString(input.desc)
  if (!cmd) return truncateOneLine(JSON.stringify(input), MAX_TOOL_TEXT)
  // keep the literal command so `Get-ChildItem` stays `Get-ChildItem` and
  // `ls -la` stays `ls -la` — Image 2 shows the pwsh variant, Image 1 the bash one.
  const line = `$ ${truncateOneLine(cmd, MAX_ONE_LINE)}`
  const suffix = formatDescription(desc)
  return suffix ? `${line}${suffix}` : line
}

function claudeRead(input: Record<string, unknown>): string {
  if (!Object.keys(input).length) return "→ Read"
  const fp = asString(input.file_path) ?? asString(input.filePath) ?? asString(input.path) ?? ""
  const limit = input.limit != null ? `:${String(input.limit)}` : ""
  const offset = input.offset != null ? `@${String(input.offset)}` : ""
  if (fp) return `→ Read ${truncateOneLine(shortPath(fp) + limit + offset, 120)}`
  return `→ Read ${truncateOneLine(JSON.stringify(input), 120)}`
}

function claudeWrite(input: Record<string, unknown>): string {
  if (!Object.keys(input).length) return "→ Write"
  const fp = asString(input.file_path) ?? asString(input.filePath) ?? asString(input.path) ?? ""
  const content = asString(input.content)
  const len = content ? ` (${content.length} chars)` : ""
  if (fp) return `→ Write ${truncateOneLine(shortPath(fp), 120)}${len}`
  return `→ Write ${truncateOneLine(JSON.stringify(input), 120)}`
}

function claudeEdit(input: Record<string, unknown>): string {
  if (!Object.keys(input).length) return "→ Edit"
  const fp = asString(input.file_path) ?? asString(input.filePath) ?? asString(input.path) ?? ""
  if (fp) return `→ Edit ${truncateOneLine(shortPath(fp), 120)}`
  return `→ Edit ${truncateOneLine(JSON.stringify(input), 120)}`
}

function claudeGlob(input: Record<string, unknown>): string {
  if (!Object.keys(input).length) return "→ Glob"
  const pat = asString(input.pattern) ?? ""
  const path = asString(input.path) ?? ""
  if (pat) return `→ Glob ${truncateOneLine(pat, 80)}${path ? ` in ${shortPath(path)}` : ""}`
  return `→ Glob ${truncateOneLine(JSON.stringify(input), 120)}`
}

function claudeGrep(input: Record<string, unknown>): string {
  if (!Object.keys(input).length) return "→ Grep"
  const pat = asString(input.pattern) ?? ""
  const path = asString(input.path) ?? ""
  const incl = asString(input.include)
  if (pat) {
    const where = path ? ` in ${shortPath(path)}` : ""
    const inc = incl ? ` • ${incl}` : ""
    return `→ Grep "${truncateOneLine(pat, 60)}"${where}${inc}`
  }
  return `→ Grep ${truncateOneLine(JSON.stringify(input), 120)}`
}

function claudeTask(input: Record<string, unknown>): string {
  if (!Object.keys(input).length) return "→ Task"
  const desc = asString(input.description) ?? asString(input.prompt) ?? asString(input.task) ?? ""
  if (desc) return `→ Task ${truncateOneLine(desc, 100)}`
  return `→ Task ${truncateOneLine(JSON.stringify(input), 120)}`
}

function claudeTodo(input: Record<string, unknown>): string {
  if (!Object.keys(input).length) return "→ Todos"
  const todos = input.todos
  if (Array.isArray(todos) && todos.length) {
    const done = todos.filter((t: any) => t?.status === "completed").length
    return `→ Todos ${done}/${todos.length}`
  }
  return `→ Todos ${truncateOneLine(JSON.stringify(input), 120)}`
}

function claudeWebFetch(input: Record<string, unknown>): string {
  if (!Object.keys(input).length) return "→ Fetch"
  const url = asString(input.url) ?? ""
  if (url) return `→ Fetch ${truncateOneLine(url, 120)}`
  return `→ Fetch ${truncateOneLine(JSON.stringify(input), 120)}`
}

function claudeWebSearch(input: Record<string, unknown>): string {
  if (!Object.keys(input).length) return "→ Search"
  const q = asString(input.query) ?? asString(input.q) ?? ""
  if (q) return `→ Search "${truncateOneLine(q, 80)}"`
  return `→ Search ${truncateOneLine(JSON.stringify(input), 120)}`
}

function claudeGeneric(name: string, input: Record<string, unknown>): string {
  // Fallback: pick the most informative string field, else one-liner JSON
  const preferred = asString(input.file_path) ?? asString(input.path) ?? asString(input.pattern) ?? asString(input.url) ?? asString(input.query) ?? asString(input.command)
  if (preferred) return `→ ${name} ${truncateOneLine(shortPath(preferred), 120)}`
  const brief = oneLine(JSON.stringify(input))
  if (brief && brief !== "{}") return `→ ${name} ${truncate(brief, 120)}`
  return `→ ${name}`
}

/** Claude Code tool input -> pretty one-liner (Image 2). */
export function claudeToolToOc(name: string | undefined, input: unknown): string {
  const n = String(name ?? "tool").trim() || "tool"
  const rec = asRecord(input)
  if (!rec) return `→ ${n}`
  switch (n.toLowerCase()) {
    case "bash":
    case "shell":
    case "exec":
      return claudeBash(rec)
    case "read":
      return claudeRead(rec)
    case "write":
      return claudeWrite(rec)
    case "edit":
    case "multiedit":
    case "notebookedit":
      return claudeEdit(rec)
    case "glob":
      return claudeGlob(rec)
    case "grep":
      return claudeGrep(rec)
    case "task":
    case "agent":
      return claudeTask(rec)
    case "todowrite":
    case "todo_write":
      return claudeTodo(rec)
    case "webfetch":
    case "web_fetch":
      return claudeWebFetch(rec)
    case "websearch":
    case "web_search":
      return claudeWebSearch(rec)
    default:
      return claudeGeneric(n, rec)
  }
}

/** Claude Code tool_result block -> dim output preview. */
export function claudeToolResultToOc(content: unknown, isError?: boolean): string {
  let text = ""
  if (typeof content === "string") text = content
  else if (Array.isArray(content)) text = content.map((p: any) => typeof p === "string" ? p : typeof p?.text === "string" ? p.text : "").join("\n")
  else if (content && typeof content === "object" && typeof (content as any).text === "string") text = String((content as any).text)
  else text = String(content ?? "")
  text = text.trim()
  if (!text) return isError ? "  ⎿ error (no output)" : "  ⎿ (no output)"
  // keep first few lines like Image 2's `FullName` table, then ellipsis
  const lines = text.split(/\r?\n/)
  const head = lines.slice(0, 12).join("\n")
  const tail = lines.length > 12 ? `\n  … (${lines.length - 12} more lines)` : ""
  const prefix = isError ? "  ⎿ ✗ " : "  ⎿ "
  return prefix + truncate(head, 800).replace(/\n/g, "\n  ") + tail
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

export function codexToolToOc(item: unknown): string {
  const rec = asRecord(item)
  if (!rec) return "→ codex"
  if (rec.type === "command_execution" || typeof rec.command === "string") {
    const cmd = asString(rec.command) ?? ""
    if (cmd) return `$ ${truncateOneLine(cmd, MAX_ONE_LINE)}`
  }
  if (rec.type === "file_change" || rec.type === "patch") {
    const fp = asString(rec.path) ?? asString(rec.file) ?? ""
    if (fp) return `→ Patch ${shortPath(fp)}`
  }
  if (rec.type === "mcp_tool") {
    const name = asString(rec.tool) ?? asString(rec.name) ?? "mcp"
    return `→ ${name} ${truncateOneLine(JSON.stringify(rec.input ?? rec.arguments ?? ""), 80)}`
  }
  const t = asString(rec.type)
  if (t) return `→ ${t} ${truncateOneLine(JSON.stringify(rec), 100)}`
  return `→ codex ${truncateOneLine(JSON.stringify(rec), 100)}`
}

export function codexReasoningToOc(text: string): string {
  const t = truncateOneLine(text, 120)
  return `+ Thought · ${t}`
}

// ---------------------------------------------------------------------------
// Grok Build — plain stdout, no JSON contract yet
// ---------------------------------------------------------------------------

export function grokLineToOc(line: string): string {
  const s = line.trim()
  if (!s) return s
  // Grok already prints `$`-like progress; passthrough with gentle trim.
  // Detect obvious tool-ish lines and prefix, else return as-is.
  if (/^\$/.test(s) || /^(read|write|edit|glob|grep)\b/i.test(s)) return s
  return s
}

// ---------------------------------------------------------------------------
// Unified entrypoints — what harnesses and the bridge should call
// ---------------------------------------------------------------------------

/**
 * Normalized HarnessStreamEvent -> display line.
 * Used by `claude-code-session.ts:streamTurn` and any TUI sink so every
 * harness gets Image-2 polish in one place.
 */
export function harnessEventToOcLine(event: HarnessStreamEvent, harness?: HarnessID): string {
  switch (event.kind) {
    case "thinking":
      return event.text ? `+ Thought · ${truncateOneLine(event.text, 160)}` : "+ Thought"
    case "text":
      return event.text ?? ""
    case "tool": {
      // `event.text` is already the pretty line if the spec used `harnessToolToOc`;
      // if it's still raw JSON (`{"command":"ls"}`), re-pretty it.
      const raw = event.text?.trim() ?? ""
      const name = event.name ?? "tool"
      const lower = name.toLowerCase()
      const isBash = lower === "bash" || lower === "shell" || lower === "exec" || lower === "command"
      if (raw.startsWith("{") || raw.startsWith("[")) {
        try {
          const parsed = JSON.parse(raw)
          const rec = asRecord(parsed)
          if (rec && harness === "claude-code") return claudeToolToOc(name, rec)
          if (rec && raw.includes("command")) return claudeToolToOc(name, rec)
        } catch { /* fall through to raw */ }
      }
      // If the spec already produced `"$ ls …"` keep it; else wrap.
      if (raw.startsWith("$") || raw.startsWith("→") || raw.startsWith("+") || raw.startsWith("  ⎿")) return raw
      if (raw) {
        // Bash/command tools get `$` like Image 2; others get `→`
        if (isBash) return `$ ${truncateOneLine(raw, 180)}`
        // If harness already formatted as `"$ cmd"` but we only got the command, add `$`
        return `→ ${name} ${truncateOneLine(raw, 180)}`
      }
      return `→ ${name}`
    }
    case "final":
      return event.text ?? ""
    case "error":
      return event.text ? `[error] ${event.text}` : "[error]"
    default:
      return event.text ?? ""
  }
}

/**
 * Raw harness JSON (one stream-json line) -> pretty line or undefined.
 * Each harness keeps its dialect; this file owns the mapping.
 * Call this from `HarnessSpec.streamEvent` / `streamEventLine` or from the
 * bridge fallback that only has the normalized event.
 */
export function harnessRawJsonToOc(raw: unknown, harness?: HarnessID): string | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const v: any = raw

  // ---- Claude Code -------------------------------------------------------
  if (harness === "claude-code" || v.type === "stream_event" || v.type === "assistant" || v.type === "result") {
    // content_block_start tool_use — the Image-1 case
    if (v.type === "stream_event" && v.event?.type === "content_block_start" && v.event?.content_block?.type === "tool_use") {
      return claudeToolToOc(v.event.content_block.name, v.event.content_block.input)
    }
    if (v.type === "assistant") {
      const block = Array.isArray(v.message?.content) ? v.message.content.find((b: any) => b?.type === "tool_use") : undefined
      if (block) return claudeToolToOc(block.name, block.input)
      // also handle tool_result inside assistant/user message
      const resultBlock = Array.isArray(v.message?.content) ? v.message.content.find((b: any) => b?.type === "tool_result") : undefined
      if (resultBlock) return claudeToolResultToOc(resultBlock.content, resultBlock.is_error)
    }
    // tool_result as a user message (some Claude versions)
    if (v.type === "user" && Array.isArray(v.message?.content)) {
      const r = v.message.content.find((b: any) => b?.type === "tool_result")
      if (r) return claudeToolResultToOc(r.content, r.is_error)
    }
    if (v.type === "stream_event" && v.event?.type === "content_block_delta") {
      const d = v.event.delta
      if (typeof d?.thinking === "string" && d.thinking) return `+ Thought · ${truncateOneLine(d.thinking, 160)}`
      if (typeof d?.text === "string" && d.text) return d.text
    }
    if (v.type === "result" && typeof v.result === "string") return v.result
    if (v.type === "result" && v.is_error === true) {
      const prose = [v.result, ...(Array.isArray(v.errors) ? v.errors : [])].filter((s: unknown) => typeof s === "string").join("; ")
      return prose ? `[error] ${prose}` : "[error]"
    }
  }

  // ---- Codex -------------------------------------------------------------
  if (harness === "codex" || v.type?.startsWith?.("item.") || v.delta != null) {
    if (v?.item?.type === "command_execution" && typeof v.item.command === "string") return `$ ${truncateOneLine(v.item.command, MAX_ONE_LINE)}`
    if (v?.item?.type === "reasoning") {
      const text = typeof v.item.text === "string" ? v.item.text : Array.isArray(v.item.summary) ? v.item.summary.map((s: any) => s?.text).join("\n") : ""
      if (text) return codexReasoningToOc(text)
    }
    if (typeof v?.delta === "string" && v.delta) return v.delta
    if (v?.type === "item.completed" && v.item?.type === "agent_message" && typeof v.item.text === "string") return v.item.text
    if (v?.type === "error" && typeof v.message === "string") return `[error] ${v.message}`
  }

  // ---- Grok Build --------------------------------------------------------
  if (harness === "grok-build" || typeof v?.text === "string") {
    // plain — line handler is preferred; this is just the JSON-shaped fallback
    if (typeof v.text === "string") return grokLineToOc(v.text)
  }

  return undefined
}

/**
 * Convenience: harness id + tool name + raw input -> pretty line.
 * The one-liner `tool Bash: {"command":"ls"}` callers currently paste
 * can be replaced with this.
 */
export function harnessToolToOc(harness: HarnessID, name: string, input: unknown): string {
  switch (harness) {
    case "claude-code":
      return claudeToolToOc(name, input)
    case "codex":
      return codexToolToOc(input)
    case "grok-build":
      return grokLineToOc(typeof input === "string" ? input : truncateOneLine(JSON.stringify(input ?? ""), 160))
    default:
      return claudeToolToOc(name, input)
  }
}

/**
 * Batch helper: turn a list of normalized events into grouped display lines
 * like Image 2 (`→ Explored - N reads`).
 */
export function groupOcEvents(events: HarnessStreamEvent[]): string[] {
  const out: string[] = []
  let readBatch = 0
  const flushReads = () => {
    if (readBatch > 0) { out.push(`→ Explored - ${readBatch} read${readBatch === 1 ? "" : "s"}`); readBatch = 0 }
  }
  for (const e of events) {
    if (e.kind === "tool" && /^(read|glob|grep)$/i.test(e.name ?? "")) { readBatch++; continue }
    flushReads()
    out.push(harnessEventToOcLine(e))
  }
  flushReads()
  return out
}
