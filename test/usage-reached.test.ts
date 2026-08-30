import { expect, test } from "bun:test"
import {
  USAGE_REACHED,
  detectProviderFailure,
  failureMessage,
  isUsageReached,
  providerModelFromBlob,
  usageReachedMessage,
} from "../usage/usage-reached"

const FALLBACK = { providerID: "openai", modelID: "gpt-5.6-luna-fast" }

test("every provider dialect for exhaustion classifies as usage", () => {
  const dialects = [
    "5-hour usage limit reached",
    "weekly usage limit",
    "monthly usage limit exceeded",
    "quota exceeded",
    "RESOURCE_EXHAUSTED",
    "rate limit exceeded",
    "429 Too Many Requests",
    "HTTP 403",
    "403 Forbidden",
    '{"statusCode":402}',
    '{"code":"429"}',
    '{"status":403}',
    "insufficient credits",
    "your credit balance is too low",
    "out of quota",
    "billing hard limit",
    "over capacity",
  ]
  for (const blob of dialects) {
    expect(isUsageReached(blob)).toBe(true)
    expect(detectProviderFailure(blob)?.kind).toBe("usage")
  }
})

test("403 specifically is usage reached, not a provider error", () => {
  // The regression this whole module exists for: 403 used to fall through the
  // 402-only classifier and surface as a raw provider dump.
  const failure = detectProviderFailure('{"statusCode":403,"providerID":"grok-sub","modelID":"grok-4.6"}')
  expect(failure?.kind).toBe("usage")
  expect(failure?.providerID).toBe("grok-sub")
  expect(failure?.modelID).toBe("grok-4.6")
})

test("exhaustion wins over generic provider language in the same blob", () => {
  expect(detectProviderFailure("APIError: provider returned error, status=403")?.kind).toBe("usage")
})

test("non-exhaustion failures stay classified as provider", () => {
  expect(detectProviderFailure("opencode-go returned error: malformed request")?.kind).toBe("provider")
  expect(detectProviderFailure('{"statusCode":500}')?.kind).toBe("provider")
})

test("ordinary assistant text is not a failure", () => {
  expect(detectProviderFailure("Here is the refactor you asked for.")).toBeUndefined()
  expect(detectProviderFailure("")).toBeUndefined()
})

test("provider and model are read, never invented", () => {
  expect(providerModelFromBlob("grok-sub/grok-4.6 blew up")).toEqual({ providerID: "grok-sub", modelID: "grok-4.6" })
  expect(providerModelFromBlob("something went wrong")).toEqual({ providerID: undefined, modelID: undefined })
})

test("the user-facing line names what ran out and what takes over, with no status code", () => {
  const message = usageReachedMessage({ providerID: "grok-sub", modelID: "grok-4.6" }, FALLBACK)
  expect(message).toBe(`${USAGE_REACHED} — grok-sub/grok-4.6. Falling over to openai/gpt-5.6-luna-fast.`)
  expect(message).not.toMatch(/40[023]|429|PROVIDER_ERROR/)
})

test("with no healthy successor the line says paused rather than pretending to fail over", () => {
  const message = usageReachedMessage({ providerID: "grok-sub", modelID: "grok-4.6" })
  expect(message).toContain("No healthy failover target")
  expect(message).not.toContain("Falling over")
})

test("failureMessage never renders a raw detail excerpt to the user", () => {
  const blob = '{"statusCode":403,"providerID":"grok-sub","error":"upstream said no, token=abc"}'
  const failure = detectProviderFailure(blob)!
  const message = failureMessage(failure, FALLBACK)
  expect(message).toStartWith(USAGE_REACHED)
  expect(message).not.toContain("upstream said no")
  // The detail survives for logs and papercuts, just not for the user.
  expect(failure.detail).toContain("upstream said no")
})

test("real exhaustion text captured from each installed harness classifies as usage", () => {
  // Verbatim from the CLIs on 2026-08-28, when all three plans were spent.
  const captured = {
    "grok-build": '{"message":"API error (status 402 Payment Required): Grok Build usage balance exhausted","http_status":402}',
    codex: '{"type":"error","message":"You\'ve hit your usage limit. Upgrade to Pro or try again at Sep 3rd, 2026."}',
    "claude-code": "Failed to authenticate. API Error: 429 rate limit exceeded",
  }
  for (const [harness, blob] of Object.entries(captured)) {
    expect(`${harness}: ${isUsageReached(blob)}`).toBe(`${harness}: true`)
  }
})
