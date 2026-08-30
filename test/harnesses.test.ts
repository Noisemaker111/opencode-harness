import { expect, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { HARNESSES, harnessFor, harnessForProvider, harnessList, resolveHarnessName } from "../harnesses"
import { streamErrorMessage } from "../plugins-active/harness-run"


test("aliases resolve to harnesses, and unknown names do not", () => {
  expect(resolveHarnessName("claude code")).toBe("claude-code")
  expect(resolveHarnessName("harness")).toBe("claude-code")
  expect(resolveHarnessName("Grok Build")).toBe("grok-build")
  expect(resolveHarnessName("codex cli")).toBe("codex")
  expect(resolveHarnessName("anthropic")).toBeUndefined()
  expect(resolveHarnessName("")).toBeUndefined()
})

test("providers map back to exactly one harness", () => {
  expect(harnessForProvider("grok-build")?.id).toBe("grok-build")
  expect(harnessForProvider("codex")?.id).toBe("codex")
  expect(harnessForProvider("openai")).toBeUndefined()
})

test("codex omits -m for the account default", () => {
  // Passing -m on a ChatGPT account fails with "not supported when using
  // Codex with a ChatGPT account".
  expect(HARNESSES.codex.args({ model: "default" })).not.toContain("-m")
  expect(HARNESSES.codex.args({ model: "gpt-5.6-sol" })).toContain("-m")
})

test("claude-code resumes an existing session but creates a new one by id", () => {
  expect(HARNESSES["claude-code"].args({ sessionId: "s1" })).toContain("--session-id")
  expect(HARNESSES["claude-code"].args({ sessionId: "s1", resumed: true })).toContain("--resume")
})

test("JSONL parsing prefers the terminal message over concatenated deltas", () => {
  const stream = [
    JSON.stringify({ type: "stream_event", event: { delta: { text: "HARNESS_" } } }),
    JSON.stringify({ type: "stream_event", event: { delta: { text: "OK" } } }),
    JSON.stringify({ type: "result", result: "HARNESS_OK" }),
  ].join("\n")
  expect(HARNESSES["claude-code"].parse(stream)).toBe("HARNESS_OK")
})

test("codex agent messages are extracted from its event stream", () => {
  const stream = [
    JSON.stringify({ type: "thread.started", thread_id: "t1" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "HARNESS_OK" } }),
  ].join("\n")
  expect(HARNESSES.codex.parse(stream)).toBe("HARNESS_OK")
})

test("claude-code stream events map into the shared vocabulary", () => {
  const pick = (event: unknown) => HARNESSES["claude-code"].streamEvent?.(event)
  expect(pick({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm " } } })).toEqual({ kind: "thinking", text: "hmm " })
  expect(pick({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } } })).toEqual({ kind: "text", text: "Hi" })
  expect(pick({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", name: "Bash", input: { command: "ls" } } } }))
    .toEqual({ kind: "tool", name: "Bash", text: '{"command":"ls"}' })
  expect(pick({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: {} }] } })).toEqual({ kind: "tool", name: "Read" })
  expect(pick({ type: "result", subtype: "success", result: "done" })).toEqual({ kind: "final", text: "done" })
  expect(pick({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["No conversation found with session ID: x"] }))
    .toEqual({ kind: "error", text: "No conversation found with session ID: x" })
  expect(pick({ type: "system", subtype: "init" })).toBeUndefined()
  expect(pick({ type: "stream_event", event: { type: "content_block_stop" } })).toBeUndefined()
})

test("codex stream events map into the shared vocabulary", () => {
  const pick = (event: unknown) => HARNESSES.codex.streamEvent?.(event)
  expect(pick({ type: "item.completed", item: { type: "agent_message", text: "done" } })).toEqual({ kind: "final", text: "done" })
  expect(pick({ type: "item.completed", item: { type: "reasoning", summary: [{ type: "summary_text", text: "thinking" }] } })).toEqual({ kind: "thinking", text: "thinking" })
  expect(pick({ type: "item.started", item: { type: "command_execution", command: "bun test" } })).toEqual({ kind: "tool", name: "command", text: "bun test" })
  expect(pick({ type: "error", message: "boom" })).toEqual({ kind: "error", text: "boom" })
  expect(pick({ delta: "par" })).toEqual({ kind: "text", text: "par" })
  expect(pick({ type: "thread.started" })).toBeUndefined()
})

test("grok-build streams plain stdout lines as text deltas", () => {
  expect(HARNESSES["grok-build"].streamEventLine?.("hello")).toEqual({ kind: "text", text: "hello\n" })
  expect(HARNESSES["grok-build"].streamEventLine?.("  ")).toBeUndefined()
  expect(HARNESSES["grok-build"].streamEventLine?.("")).toBeUndefined()
})

test("the stale-session signature lives on the spec, not in a task file", () => {
  expect(HARNESSES["claude-code"].sessionNotFound).toBeInstanceOf(RegExp)
  expect(HARNESSES["claude-code"].sessionNotFound?.test('{"errors":["No conversation found with session ID: abc"]}')).toBe(true)
  expect(HARNESSES["claude-code"].sessionNotFound?.test("Session abc does not exist")).toBe(true)
  expect(HARNESSES["claude-code"].sessionNotFound?.test("rate limit")).toBe(false)
})

test("the CLI's structured error beats stderr progress chatter", () => {
  // stderr said "Reading prompt from stdin..." while the real failure was in
  // the stdout event stream, nested one JSON level deep.
  const stream = [
    JSON.stringify({ type: "thread.started" }),
    JSON.stringify({ type: "error", message: JSON.stringify({ error: { message: "The model is not supported." } }) }),
  ].join("\n")
  expect(streamErrorMessage(stream)).toBe("The model is not supported.")
  expect(streamErrorMessage("not json at all")).toBeUndefined()
})

test("a harness spec describes a CLI and never runs one", () => {
  // This directory exists because the Claude path had re-spelled its own argv
  // and its own stream parser next to the spec that already held both. A spec
  // that can spawn a process, or write to the ledger, is an engine — and two
  // engines for one idea is exactly what got dismantled to make this dir.
  const dir = join(import.meta.dir, "..", "harnesses")
  const banned = ["foreground-supervisor", "orchestration-ledger", "node:child_process", "task-scope", "usage-lib"]
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".ts")) continue
    const src = readFileSync(join(dir, file), "utf8")
    for (const spec of [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1])) {
      const hit = banned.find((b) => spec.includes(b))
      expect(`harnesses/${file} -> ${spec}`).toBe(hit ? "" : `harnesses/${file} -> ${spec}`)
    }
  }
})

test("every harness is reachable by id, provider and fuzzy name", () => {
  for (const spec of harnessList()) {
    expect(harnessFor(spec.id)?.id).toBe(spec.id)
    expect(harnessForProvider(spec.provider)?.id).toBe(spec.id)
    expect(resolveHarnessName(spec.id)).toBe(spec.id)
    expect(spec.models.length).toBeGreaterThan(0)
  }
})
