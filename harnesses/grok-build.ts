import type { HarnessSpec, HarnessStreamEvent } from "./types"

/**
 * xAI's Grok CLI. `-p/--single` is its single-turn headless mode; `-c/--continue`
 * resumes the most recent session for this cwd, which is the closest thing it
 * offers to Claude Code's explicit --session-id.
 */
export const grokBuild: HarnessSpec = {
  id: "grok-build",
  label: "Grok Build (Harness)",
  provider: "grok-build",
  executable: "grok",
  models: [
    { id: "grok-4.6", name: "Grok Build 4.6" },
    { id: "grok-4.5", name: "Grok Build 4.5" },
  ],
  args: ({ model, resumed }) => [
    "--output-format", "plain",
    "--always-approve",
    ...(model ? ["-m", model] : []),
    ...(resumed ? ["-c"] : []),
    "-p", "-",
  ],
  promptOnStdin: true,
  parse: (stdout) => stdout.trim(),
  // TODO: verify whether the grok CLI exposes a JSON event format
  // (`--output-format` alternatives); until one is confirmed, plain stdout is
  // streamed line-by-line as text deltas and the trailing stdout (the parse())
  // is deduplicated downstream by prefix match.
  streamEventLine: (line: string): HarnessStreamEvent | undefined => {
    if (!line.trim()) return undefined
    return { kind: "text", text: line + "\n" }
  },
  versionArgs: ["--version"],
}
