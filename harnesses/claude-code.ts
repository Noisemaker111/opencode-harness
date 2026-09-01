import { parseJsonl, type HarnessSpec, type HarnessStreamEvent } from "./types"
import { claudeToolResultToOc, claudeToolToOc } from "./harness-json-to-oc"

/** A tool_use block's input, summarized for a one-line activity note. Now Image-2 pretty. */
function toolSummary(name: string | undefined, input: unknown): HarnessStreamEvent {
  const text = claudeToolToOc(name, input)
  return { kind: "tool", name: String(name ?? "tool"), text }
}

/** A tool_result block, rendered like Image 2's `FullName` table. */
function toolResultSummary(content: unknown, isError?: boolean): HarnessStreamEvent {
  return { kind: "text", text: claudeToolResultToOc(content, isError) }
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
    { id: "haiku", name: "Claude Code Haiku" },
  ],
  // --session-id names a new session; --resume continues one we already know.
  // Passing the wrong one for the state is how "session not found" happens.
  args: ({ model, sessionId, resumed, mcpConfigPath }) => [
    "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--permission-mode", "bypassPermissions",
    ...(mcpConfigPath ? ["--mcp-config", mcpConfigPath] : []),
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
      if (event?.type === "content_block_start" && event.content_block?.type === "tool_result") {
        return toolResultSummary(event.content_block.content, event.content_block.is_error)
      }
      return undefined
    }
    if (v?.type === "assistant") {
      const content = Array.isArray(v.message?.content) ? v.message.content : undefined
      const useBlock = content?.find((b: any) => b?.type === "tool_use")
      if (useBlock) return toolSummary(useBlock.name, useBlock.input)
      const resultBlock = content?.find((b: any) => b?.type === "tool_result")
      if (resultBlock) return toolResultSummary(resultBlock.content, resultBlock.is_error)
      return undefined
    }
    if (v?.type === "user" && Array.isArray(v.message?.content)) {
      const resultBlock = v.message.content.find((b: any) => b?.type === "tool_result")
      if (resultBlock) return toolResultSummary(resultBlock.content, resultBlock.is_error)
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
