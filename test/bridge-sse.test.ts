/**
 * The bridge speaks OpenAI-compatible SSE. Framing it wrong made every
 * streamed harness turn die with "OpenAI Chat stream ended without
 * finish_reason", which read like a model fault and was really a missing
 * blank line between events.
 */
import { expect, test } from "bun:test"
import { openaiChatCompletion } from "../plugins-active/claude-code-session"

const MODEL = "claude-code/sonnet"

/** Parse a stream the way a client does: split on blank lines. */
function events(body: string): string[] {
  return body.split("\n\n").map((chunk) => chunk.trim()).filter(Boolean)
}

test("streamed events are separated by a blank line", () => {
  const parsed = events(openaiChatCompletion("HARNESS_OK", MODEL, true))
  expect(parsed).toHaveLength(3)
  expect(parsed.every((e) => e.startsWith("data: "))).toBe(true)
})

test("the stream carries content, a finish_reason, and a terminator", () => {
  const parsed = events(openaiChatCompletion("HARNESS_OK", MODEL, true))
  const first = JSON.parse(parsed[0].slice("data: ".length))
  expect(first.choices[0].delta.content).toBe("HARNESS_OK")
  expect(first.choices[0].finish_reason).toBeNull()

  const second = JSON.parse(parsed[1].slice("data: ".length))
  expect(second.choices[0].finish_reason).toBe("stop")

  expect(parsed[2]).toBe("data: [DONE]")
})

test("every streamed chunk names the model it came from", () => {
  for (const event of events(openaiChatCompletion("x", MODEL, true)).slice(0, 2)) {
    expect(JSON.parse(event.slice("data: ".length)).model).toBe(MODEL)
  }
})

test("the non-streaming shape is a single completion object", () => {
  const parsed = JSON.parse(openaiChatCompletion("HARNESS_OK", MODEL, false))
  expect(parsed.object).toBe("chat.completion")
  expect(parsed.choices[0].message).toEqual({ role: "assistant", content: "HARNESS_OK" })
  expect(parsed.choices[0].finish_reason).toBe("stop")
})
