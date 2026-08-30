/**
 * Harnesses, not providers.
 *
 * A harness is somebody else's coding agent driven through its own CLI, with
 * its own auth and its own subscription — Claude Code, Grok Build, Codex. The
 * point is the same one T3 makes: you should be able to pick the harness the
 * way you pick a model, instead of re-plumbing an API key for each one.
 *
 * A file in this directory DESCRIBES a CLI. It never runs one. Spawning,
 * supervision, redaction and failure classification live once, in harness-run.
 * The Claude path spent months re-spelling its own argv and its own stream
 * parser next to the spec that already had both; the boundary test in
 * test/harnesses.test.ts is what stops that happening again.
 */

export type HarnessID = "claude-code" | "grok-build" | "codex"

export type HarnessModel = { id: string; name: string }

/**
 * One normalized event from a harness's incremental output. Every CLI names
 * its parts differently; each spec translates its own dialect into this one
 * vocabulary so the supervisor, the bridge and the TUI never re-spell it.
 */
export type HarnessStreamEvent = {
  kind: "thinking" | "text" | "tool" | "final" | "error"
  text?: string
  /** Tool name, for `kind: "tool"`. */
  name?: string
}

export type HarnessSpec = {
  id: HarnessID
  label: string
  /** Provider id this harness is selectable as in the model picker. */
  provider: string
  /** Executable name resolved on PATH. */
  executable: string
  models: HarnessModel[]
  /** Argv for one non-interactive turn. The prompt goes on stdin when `promptOnStdin`. */
  args: (options: { model?: string; sessionId?: string; resumed?: boolean }) => string[]
  promptOnStdin: boolean
  /** Pull the assistant text out of this CLI's stdout. */
  parse: (stdout: string) => string
  /** Probe argv that must exit 0 when the harness is installed. */
  versionArgs: string[]
  /** Translate one parsed JSONL event into the shared vocabulary. */
  streamEvent?: (event: unknown) => HarnessStreamEvent | undefined
  /** Same, for harnesses whose stdout is plain text rather than JSONL. */
  streamEventLine?: (line: string) => HarnessStreamEvent | undefined
  /** Matches an in-band "this session id points nowhere" failure. */
  sessionNotFound?: RegExp
}

/** JSONL harnesses share a shape: incremental deltas plus one terminal result. */
export function parseJsonl(stdout: string, pick: (event: any) => { delta?: string; final?: string } | undefined): string {
  const deltas: string[] = []
  let final: string | undefined
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const picked = pick(JSON.parse(line))
      if (picked?.delta) deltas.push(picked.delta)
      if (typeof picked?.final === "string") final = picked.final
    } catch { /* non-JSON chunks are progress noise */ }
  }
  // The terminal message repeats the full text, so preferring it avoids the
  // doubling you get from concatenating deltas and result together.
  return final ?? deltas.join("")
}
