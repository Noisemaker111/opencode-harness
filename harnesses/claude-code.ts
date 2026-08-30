import { parseJsonl, type HarnessSpec, type HarnessStreamEvent } from "./types"

/** A tool_use block's input, summarized for a one-line activity note. */
function toolSummary(name: string | undefined, input: unknown): HarnessStreamEvent {
  const brief = input && typeof input === "object" && Object.keys(input as object).length ? JSON.stringify(input).slice(0, 120) : ""
  return { kind: "tool", name: String(name ?? "tool"), ...(brief ? { text: brief } : {}) }
}

/** Anthropic's Claude Code CLI. The only harness with explicit session ids. */
export const claudeCode: HarnessSpec = {
  id: "claude-code",
  label: "Claude Code (Harness)",
  provider: "claude-code",
  executable: "claude",
  models: [
    { id: "claude", name: "Claude Code" },
    { id: "opus", name: "Claude Code Opus" },
    { id: "sonnet", name: "Claude Code Sonnet" },
  ],
  // --session-id names a new session; --resume continues one we already know.
  // Passing the wrong one for the state is how "session not found" happens.
  args: ({ model, sessionId, resumed }) => [
    "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--permission-mode", "bypassPermissions",
    ...(model ? ["--model", model] : []),
    ...(sessionId ? [resumed ? "--resume" : "--session-id", sessionId] : []),
  ],
  promptOnStdin: true,
  parse: (stdout) => parseJsonl(stdout, (v) =>
    v.type === "stream_event" && v.event?.delta?.text ? { delta: v.event.delta.text }
    : v.type === "result" && typeof v.result === "string" ? { final: v.result }
    : undefined),
  // --include-partial-messages streams both thinking and text deltas; the
  // assistant message restates tool_use blocks; the terminal `result` carries
  // the final text (or, with is_error, the failure prose in `errors[]`).
  streamEvent: (v: any): HarnessStreamEvent | undefined => {
    if (v?.type === "stream_event") {
      const event = v.event
      if (event?.type === "content_block_delta") {
        const delta = event.delta
        if (typeof delta?.thinking === "string" && delta.thinking) return { kind: "thinking", text: delta.thinking }
        if (typeof delta?.text === "string" && delta.text) return { kind: "text", text: delta.text }
        return undefined
      }
      if (event?.type === "content_block_start" && event.content_block?.type === "tool_use") {
        return toolSummary(event.content_block.name, event.content_block.input)
      }
      return undefined
    }
    if (v?.type === "assistant") {
      const block = Array.isArray(v.message?.content)
        ? v.message.content.find((b: any) => b?.type === "tool_use")
        : undefined
      return block ? toolSummary(block.name, block.input) : undefined
    }
    if (v?.type === "result") {
      if (v.is_error === true) {
        const prose = [v.result, ...(Array.isArray(v.errors) ? v.errors : [])]
          .filter((s: unknown) => typeof s === "string").join("; ")
        return { kind: "error", text: prose || String(v.subtype ?? "error") }
      }
      return typeof v.result === "string" ? { kind: "final", text: v.result } : undefined
    }
    return undefined
  },
  // Also covers "--session-id names a conversation it already has" only in the
  // task file's separate classifier; this one is the "points nowhere" case.
  sessionNotFound: /no conversation found|session (?:id )?.{0,80}(?:not found|does not exist)/i,
  versionArgs: ["--version"],
}
