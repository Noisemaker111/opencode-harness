import { parseJsonl, type HarnessSpec, type HarnessStreamEvent } from "./types"

/**
 * OpenAI's Codex CLI. `codex exec` is the non-interactive entrypoint and reads
 * the prompt from stdin when it is piped; `--json` gives JSONL events like the
 * others.
 */
export const codex: HarnessSpec = {
  id: "codex",
  label: "Codex (Harness)",
  provider: "codex",
  executable: "codex",
  // Codex on a ChatGPT account rejects most `-m` values outright ("not
  // supported when using Codex with a ChatGPT account"), so `default` means
  // "whatever ~/.codex/config.toml already selects" and passes no -m at all.
  models: [
    { id: "default", name: "Codex (account default)" },
    { id: "gpt-5.6-sol", name: "Codex Sol" },
  ],
  args: ({ model }) => [
    "exec", "--json", "--color", "never",
    ...(model && model !== "default" ? ["-m", model] : []),
  ],
  promptOnStdin: true,
  parse: (stdout) => parseJsonl(stdout, (v) =>
    v.type === "item.completed" && v.item?.type === "agent_message" && typeof v.item.text === "string" ? { final: v.item.text }
    : typeof v.delta === "string" ? { delta: v.delta }
    : undefined),
  // Codex names its stream events per item type. TODO: verify the exact
  // reasoning-summary and delta event names against a live `codex exec --json`
  // run; the shapes below follow the same field names the parse() picker
  // already accepts and tolerate missing fields.
  streamEvent: (v: any): HarnessStreamEvent | undefined => {
    const item = v?.item
    if (v?.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") {
      return { kind: "final", text: item.text }
    }
    if (item?.type === "reasoning") {
      const text = typeof item.text === "string" ? item.text
        : Array.isArray(item.summary) ? item.summary.map((s: any) => s?.text).filter((s: unknown) => typeof s === "string").join("\n")
        : ""
      return text ? { kind: "thinking", text } : undefined
    }
    if ((v?.type === "item.started" || v?.type === "item.completed") && item?.type === "command_execution") {
      return { kind: "tool", name: "command", ...(typeof item.command === "string" ? { text: item.command.slice(0, 120) } : {}) }
    }
    if (v?.type === "error" && typeof v.message === "string") return { kind: "error", text: v.message }
    if (item?.type === "error" && typeof item.message === "string") return { kind: "error", text: item.message }
    if (typeof v?.delta === "string" && v.delta) return { kind: "text", text: v.delta }
    return undefined
  },
  versionArgs: ["--version"],
}
