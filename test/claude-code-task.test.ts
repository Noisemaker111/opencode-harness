import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { classifyFailure, classifyStreamResult, parseClaudeStreamResult, parseClaudeStreamText, claudeCodeTaskTool, claudeCodeTool, discoverClaudeRuntime, extractSessionId, installClaudeCodeIntercept, interceptClaudeCodeTask, isClaudeCodeSpawn, makeClaudeCodeTaskTool, resolveClaudeCodeWorkerName, runClaudeCodeTask } from "../plugins-active/claude-code-task"
import { appendLedger, readLedger, recordScopeRejection, trackedChildren } from "../orchestration/orchestration-ledger"
import { canonicalizeDispatch } from "../orchestration/dispatch"
import { normalizeScope, pathIsOwned, validateContinuation, type TaskScopeManifest } from "../orchestration/task-scope"
import { superviseForeground, windowsBatchLaunch } from "../scripts/foreground-supervisor"
import audit from "./fixtures/scope-audit-scenarios.json"

const scope: TaskScopeManifest = { taskId: "task-harness", questId: "quest-test", workUnitId: "unit-harness", role: "worker", domains: ["harness"], components: ["claude-code-task"], ownedPaths: ["plugins-active/claude-code-task.ts"], prohibitedPaths: ["plugins-active/favorite-router.ts"], branch: "scope-enforcement-upstream", worktree: "C:/worktrees/harness", parentId: "ses_parent", ownerId: "ses_owner", integrationId: "int-harness", modelPin: "claude-code/claude", lifecycle: "running", deliverables: ["scope guard"], allowedFollowUpKinds: ["fix", "review", "verify", "integrate"] }

async function withIsolatedSessionState<T>(run: (isolatedRoot: string, previousLocalAppData: string | undefined) => Promise<T>): Promise<T> {
  const previousLocalAppData = process.env.LOCALAPPDATA
  const isolatedRoot = await mkdtemp(join(tmpdir(), "cc-state-"))
  process.env.LOCALAPPDATA = isolatedRoot
  try {
    return await run(isolatedRoot, previousLocalAppData)
  } finally {
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = previousLocalAppData
    await rm(isolatedRoot, { recursive: true, force: true })
  }
}

test("missing scope fails loud on the direct claude_code_task tool", async () => {
  await expect((makeClaudeCodeTaskTool() as any).execute({ task: "no scope" })).rejects.toThrow(/Missing key: scope|scope manifest is required/i)
  await expect(runClaudeCodeTask({ task: "no scope" } as any)).rejects.toThrow(/scope manifest is required/i)
})

test("Task agent=claude-code intercepts to the official CLI with its own alias", async () => {
  let received: { input?: { model?: unknown; scope?: unknown }; context?: unknown } | undefined
  const event = {
    tool: "task",
    sessionID: "ses_parent",
    id: "call-cc",
    input: { agent: "claude-code", description: "do the work", model: "claude-code/sonnet" },
  }
  canonicalizeDispatch(event)
  const result = await interceptClaudeCodeTask(event, async (input, context) => {
    received = { input, context }
    return { content: "Claude Code (Harness) completed: ok", metadata: { sessionId: "claude-session", runtime: "claude-code" } }
  })
  expect(isClaudeCodeSpawn(event.input)).toBe(true)
  expect(event.input.model).toBe("claude-code/sonnet")
  expect(received?.input?.model).toBe("sonnet")
  expect((received?.input as any)?.task).toBe("do the work")
  expect(received?.input?.scope).toMatchObject({ modelPin: "claude-code/sonnet", role: "worker" })
  expect(result).toMatchObject({ content: expect.stringContaining("Claude Code"), metadata: { runtime: "claude-code" } })
  await expect(interceptClaudeCodeTask({ ...event, input: { ...event.input, model: "opencode/x-preview-f-free" } })).rejects.toThrow(/only accepts/)
})

test("installClaudeCodeIntercept aborts the Task spawn after running the CLI", async () => {
  let hookName: string | undefined
  let handler: ((event: unknown) => Promise<unknown>) | undefined
  await installClaudeCodeIntercept(
    {
      tool: {
        hook: async (name: string, fn: (event: unknown) => Promise<unknown>) => {
          hookName = name
          handler = fn
        },
      },
    },
    async () => ({ content: "Claude Code (Harness) completed: direct", metadata: { runtime: "claude-code" } }),
  )
  expect(hookName).toBe("execute.before")
  const event = { tool: "task", sessionID: "ses_parent", id: "call-cc", input: { agent: "claude-code", description: "run tests" } }
  await expect(handler?.(event)).rejects.toMatchObject({ name: "ClaudeCodeDirectResult", result: { metadata: { runtime: "claude-code" } } })
  expect(event.input.model).toBeUndefined()
  expect(JSON.stringify(event.input)).not.toContain("x-preview")
  const ignored = { tool: "task", input: { agent: "build", description: "normal worker" } }
  await expect(handler?.(ignored)).resolves.toBeUndefined()
})

test("direct tool execute still forwards the complete task and context", async () => {
  let received: unknown
  const tool = makeClaudeCodeTaskTool(async (input, context) => {
    received = { input, context }
    return { content: "Claude Code (Harness) completed: ok", metadata: { sessionId: "claude-session" } }
  })
  const result = await tool.execute({ task: "full task", cwd: "C:\\repo", constraints: "no network", verification: "run tests", resume: true }, { sessionID: "ses_parent", callID: "call-1" })
  expect(result.content).toContain("Claude Code")
  expect(received).toEqual({ input: { task: "full task", cwd: "C:\\repo", constraints: "no network", verification: "run tests", resume: true }, context: { sessionID: "ses_parent", callID: "call-1" } })
})

test("fake official CLI invocation forwards task, bypasses permissions, and reuses documented session", async () => {
  await withIsolatedSessionState(async (isolatedRoot, previousLocalAppData) => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-claude-task-"))
    const fake = join(directory, "fake-claude.mjs")
    const capture = join(directory, "capture.json")
    const argvLog = join(directory, "argv.jsonl")
    const realFile = previousLocalAppData ? join(previousLocalAppData, "opencode", "claude-code-sessions.json") : undefined
    const beforeReal = realFile && existsSync(realFile) ? await readFile(realFile, "utf8") : ""
    await writeFile(fake, `import { appendFileSync, writeFileSync } from "node:fs"; const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk); const argv = process.argv.slice(2); writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ argv, stdin: Buffer.concat(chunks).toString() })); appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify({ argv }) + "\\n"); console.log(JSON.stringify({ type: "system", session_id: "ses_from_stream" })); console.log("not-json"); console.log(JSON.stringify({ type: "result", result: "ok" }))`)
    try {
      const first = await (makeClaudeCodeTaskTool() as any).execute({ task: "do the full task", cwd: directory, constraints: "stay scoped", verification: "run focused tests", sessionKey: "config-test", scope, executable: process.execPath, executableArgs: [fake] })
      expect(first.content).toContain("ok")
      expect(first.metadata).toMatchObject({ sessionId: "ses_from_stream", runtimeSessionId: "ses_from_stream", parentID: "opencode", task: "do the full task" })
      expect(first.metadata.openCodeSessionId).toBeUndefined()
      const recorded = JSON.parse(await readFile(capture, "utf8")) as { argv: string[]; stdin: string }
      expect(recorded.argv).toContain("--permission-mode")
      expect(recorded.argv).toContain("bypassPermissions")
      expect(recorded.argv).toContain("--session-id")
      expect(recorded.argv).not.toContain("--resume")
      expect(recorded.stdin).toContain("do the full task")
      expect(existsSync(join(isolatedRoot, "opencode", "claude-code-sessions.json"))).toBe(true)
      const second = await (makeClaudeCodeTaskTool() as any).execute({ task: "continue", cwd: directory, sessionKey: "config-test", resume: true, followUpKind: "verify", scope, executable: process.execPath, executableArgs: [fake] })
      expect(second.metadata.sessionId).toBe("ses_from_stream")
      const lines = (await readFile(argvLog, "utf8")).trim().split(/\n/).map((line) => JSON.parse(line) as { argv: string[] })
      expect(lines).toHaveLength(2)
      expect(lines[1].argv).toContain("--resume")
      expect(lines[1].argv).toContain("ses_from_stream")
      expect(lines[1].argv).not.toContain("--session-id")
      if (realFile) expect(existsSync(realFile) ? await readFile(realFile, "utf8") : "").toBe(beforeReal)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

test("resume of a brand-new session key uses --session-id not --resume", async () => {
  await withIsolatedSessionState(async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-claude-new-resume-"))
    const fake = join(directory, "fake-claude.mjs")
    const capture = join(directory, "capture.json")
    await writeFile(fake, `import { writeFileSync } from "node:fs"; const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk); writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ argv: process.argv.slice(2) })); console.log(JSON.stringify({ type: "result", result: "ok" }))`)
    try {
      await (makeClaudeCodeTaskTool() as any).execute({ task: "first", cwd: directory, sessionKey: "never-seen", resume: true, followUpKind: "verify", scope, executable: process.execPath, executableArgs: [fake] })
      const recorded = JSON.parse(await readFile(capture, "utf8")) as { argv: string[] }
      expect(recorded.argv).toContain("--session-id")
      expect(recorded.argv).not.toContain("--resume")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

test("direct harness run inherits Claude/Anthropic auth, drops unrelated secrets, and cancels", async () => {
  await withIsolatedSessionState(async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-claude-cancel-"))
    const fake = join(directory, "fake-claude.mjs")
    const capture = join(directory, "env.txt")
    await writeFile(fake, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.env)); setInterval(() => {}, 1000)`)
    const previous = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    }
    process.env.ANTHROPIC_API_KEY = "anthropic-should-forward"
    process.env.CLAUDE_CONFIG_DIR = "C:\\claude-config"
    process.env.OPENAI_API_KEY = "openai-must-not-forward"
    process.env.AWS_SECRET_ACCESS_KEY = "aws-must-not-forward"
    const controller = new AbortController()
    try {
      const pending = (makeClaudeCodeTaskTool() as any).execute({ task: "cancel me", cwd: directory, scope, executable: process.execPath, executableArgs: [fake] }, { sessionID: "ses_cancel", abortSignal: controller.signal })
      await new Promise((resolve) => setTimeout(resolve, 80))
      controller.abort()
      await expect(pending).rejects.toThrow(/cancelled|exited/i)
      const childEnv = JSON.parse(await readFile(capture, "utf8")) as Record<string, string>
      expect(childEnv.ANTHROPIC_API_KEY).toBe("anthropic-should-forward")
      expect(childEnv.CLAUDE_CONFIG_DIR).toBe("C:\\claude-config")
      expect(childEnv.OPENAI_API_KEY).toBeUndefined()
      expect(childEnv.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await rm(directory, { recursive: true, force: true })
    }
  })
})

test("harness ledger keeps parent lineage and runtime session metadata", () => {
  const file = join(tmpdir(), `opencode-ledger-${randomUUID()}.jsonl`)
  appendLedger({ kind: "spawn", parentID: "ses_parent", callID: "call-cc", agent: "claude-code", runtime: "claude-code", description: "task" }, file)
  appendLedger({ kind: "bound", parentID: "ses_parent", callID: "call-cc", childID: "cc_run", runtime: "claude-code", runtimeSessionId: "claude-session" }, file)
  const children = trackedChildren("ses_parent", { running: [{ id: "ses_child" }], recent: [] }, file)
  expect(children[0]).toMatchObject({ parentID: "ses_parent", childID: "cc_run", runtime: "claude-code", runtimeSessionId: "claude-session" })
  expect(children[0].openCodeSessionId).toBeUndefined()
})

test("missing client is blocked and never appears as running", async () => {
  await withIsolatedSessionState(async () => {
    const pending = (makeClaudeCodeTaskTool() as any).execute({ task: "blocked", scope, executable: "definitely-not-a-claude-client", cwd: process.cwd() }, { sessionID: "ses_parent", callID: "call-blocked" })
    await expect(pending).rejects.toThrow(/client-not-started|CLI was not found/)
  })
})

test("sanitized transcript audit covers both historical leaks and valid follow-ups", () => {
  expect(audit.scenarios).toHaveLength(12)
  for (const scenario of audit.scenarios) {
    const requested = { ...scope, domains: scenario.delta.domains ?? scope.domains, components: scenario.delta.components ?? scope.components }
    expect(Boolean(validateContinuation(scope, requested, scenario.kind, scope.modelPin, scope.modelPin))).toBe(scenario.decision === "reject")
    expect(JSON.stringify(scenario)).not.toMatch(/bearer|api[_-]?key|password|secret|raw transcript/i)
  }
})

test("scope rejection telemetry is bounded and redacted", () => {
  const file = join(tmpdir(), `scope-rejection-${randomUUID()}.jsonl`)
  recordScopeRejection("ses_audit", "call_audit", "OUT_OF_SCOPE_CONTINUATION", { token: "sensitive", delta: "x".repeat(10000) }, "cc_audit", file)
  const event = readLedger(file).find((item) => item.kind === "scope-rejected")
  expect(event?.errorCode).toBe("OUT_OF_SCOPE_CONTINUATION")
  expect(JSON.stringify(event)).not.toContain("sensitive")
  expect(JSON.stringify(event).length).toBeLessThan(6000)
})

test("supervisor closes stdin when input is omitted so probes cannot hang", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-stdin-close-"))
  const fake = join(directory, "wait-stdin.mjs")
  await writeFile(fake, `for await (const _ of process.stdin) {}; console.log("closed")`)
  try {
    const result = await superviseForeground(process.execPath, [fake], { cwd: directory, timeoutMs: 3000, leaseMs: 500 })
    expect(result.timedOut).toBe(false)
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe("closed")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("runtime discovery probes complete without hanging on an open stdin pipe", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-claude-probe-"))
  const fake = join(directory, "fake-claude.mjs")
  await writeFile(fake, `for await (const _ of process.stdin) {}; const args = process.argv.slice(2).join(" "); if (args.includes("--version")) console.log("1.0.0-test"); else if (args.includes("auth")) console.log(JSON.stringify({ loggedIn: true })); else if (args.includes("models")) console.log(JSON.stringify([{ id: "sonnet", alias: "sonnet" }])); else console.log("Usage: claude opus sonnet haiku")`)
  const started = Date.now()
  try {
    const status = await discoverClaudeRuntime(process.execPath, [fake])
    expect(Date.now() - started).toBeLessThan(4000)
    expect(status.available).toBe(true)
    expect(status.authenticated).toBe(true)
    expect(status.models.some((model) => model.id === "sonnet")).toBe(true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("stream-json session_id is extracted from mixed NDJSON", () => {
  const text = [
    "not json",
    JSON.stringify({ type: "system", session_id: "ses_first" }),
    JSON.stringify({ type: "assistant", event: { session_id: "ses_event" } }),
    JSON.stringify({ type: "result", result: "ok" }),
  ].join("\n")
  expect(extractSessionId(text)).toBe("ses_event")
  expect(extractSessionId("plain text")).toBeUndefined()
})

test("continuation checks legacy scope before model immutability", () => {
  expect(validateContinuation(undefined, scope, "fix", "model-a", "model-b")?.code).toBe("LEGACY_SCOPE_REQUIRED")
  expect(validateContinuation(scope, undefined, "fix", scope.modelPin, scope.modelPin)?.code).toBe("LEGACY_SCOPE_REQUIRED")
  expect(validateContinuation(scope, { ...scope, modelPin: "other-model" }, "fix", "other-model", scope.modelPin)?.code).toBe("MODEL_IMMUTABLE")
  expect(validateContinuation(scope, scope, "verify", scope.modelPin, scope.modelPin)).toBeUndefined()
})

test("path ownership matches Windows prefixes after slash and case canonicalization", () => {
  const ownedRoot = process.platform === "win32" ? "C:\\Users\\dev\\Work\\Owned" : "/tmp/work/owned"
  const secret = process.platform === "win32" ? "C:\\Users\\dev\\Work\\Owned\\secret.ts" : "/tmp/work/owned/secret.ts"
  const child = process.platform === "win32" ? "C:/Users/dev/Work/Owned/file.ts" : "/tmp/work/owned/file.ts"
  const other = process.platform === "win32" ? "C:\\Users\\dev\\Work\\Other\\file.ts" : "/tmp/work/other/file.ts"
  const manifest = normalizeScope({ ...scope, ownedPaths: [ownedRoot, "plugins-active"], prohibitedPaths: [secret] })
  expect(manifest).toBeDefined()
  expect(pathIsOwned(child, manifest!)).toBe(true)
  expect(pathIsOwned(process.platform === "win32" ? "C:\\Users\\dev\\Work\\Owned\\file.ts" : child, manifest!)).toBe(true)
  expect(pathIsOwned("plugins-active\\claude-code-task.ts", manifest!)).toBe(true)
  expect(pathIsOwned(secret, manifest!)).toBe(false)
  expect(pathIsOwned(other, manifest!)).toBe(false)
})

test("non-zero exits are classified as usage-reached, auth, or provider", () => {
  expect(classifyFailure("please login", 1)).toBe("auth: please login")
  expect(classifyFailure("unauthorized token=secret-value", 1)).toBe("auth: unauthorized token=[REDACTED]")
  expect(classifyFailure("unknown boom", 2)).toStartWith("provider:")
  expect(classifyFailure("", 1)).toStartWith("provider: Claude Code exited with code 1 and said nothing.")
})

test("a silent non-zero exit reports what the CLI was asked to do", () => {
  // "Claude Code exited with code 1" was reported for an expired login, a bad
  // --resume id and an empty stdin alike — nothing to act on.
  const message = classifyFailure("", 1, {
    args: ["-p", "--output-format", "stream-json", "--resume", "gone-id"],
    stdoutTail: '{"type":"system","subtype":"init"}',
  })
  expect(message).toContain("--resume")
  expect(message).toContain("last output")
  expect(message).not.toContain("gone-id")
})

test("exhaustion uses the one blanket line and never leaks a status code", () => {
  for (const raw of ["rate limit exceeded", "5-hour usage limit reached", "HTTP 403 Forbidden", '{"statusCode":429}']) {
    const message = classifyFailure(raw, 1)
    expect(message).toStartWith("Usage reached — claude-code/claude")
    expect(message).not.toMatch(/40[23]|429|capacity:|provider:/)
  }
})

test("code 1 with empty stdout still classifies stderr instead of returning raw text", async () => {
  await withIsolatedSessionState(async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-claude-authfail-"))
    const fake = join(directory, "fake-claude.mjs")
    await writeFile(fake, `console.error("unauthorized: please login"); process.exit(1)`)
    try {
      await expect((makeClaudeCodeTaskTool() as any).execute({ task: "auth fail", cwd: directory, scope, executable: process.execPath, executableArgs: [fake] })).rejects.toThrow(/^auth:/)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

test("an in-band API failure is a failure even when the CLI exits 0", () => {
  // The CLI emits is_error/api_error_status on the terminal result while
  // subtype stays "success". Only checking the exit code turned an expired
  // login into "provider: Claude Code exited with code 1."
  const stream = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }),
    JSON.stringify({
      type: "result", subtype: "success", is_error: true, api_error_status: 401,
      terminal_reason: "api_error",
      result: "Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.",
    }),
  ].join("\n")
  const parsed = parseClaudeStreamResult(stream)!
  expect(parsed.isError).toBe(true)
  expect(parsed.apiErrorStatus).toBe(401)
  expect(classifyStreamResult(parsed)).toStartWith("auth:")
  expect(classifyStreamResult(parsed)).toContain("sign in again")
})

test("an in-band 429 is usage reached, not an auth or provider error", () => {
  const parsed = parseClaudeStreamResult(
    JSON.stringify({ type: "result", is_error: true, api_error_status: 429, result: "rate limit" }),
  )!
  expect(classifyStreamResult(parsed)).toStartWith("Usage reached")
})

test("a terminal error event surfaces its errors[] instead of 'unknown reason'", () => {
  // The poisoned-resume failure carried its whole cause in errors[] and no
  // `result`/`terminal_reason` at all — reporting "(unknown reason)" made the
  // bridge return 500 and the client retry into the same wall forever.
  const parsed = parseClaudeStreamResult(JSON.stringify({
    type: "result", subtype: "error_during_execution", is_error: true,
    errors: ["No conversation found with session ID: 5f0f4c1b-1e5f-4a3e-9f4e-6c8a1b2c3d4e"],
  }))!
  expect(parsed.isError).toBe(true)
  expect(parsed.subtype).toBe("error_during_execution")
  expect(parsed.errors).toEqual(["No conversation found with session ID: 5f0f4c1b-1e5f-4a3e-9f4e-6c8a1b2c3d4e"])
  const message = classifyStreamResult(parsed)
  expect(message).toContain("No conversation found with session ID")
  expect(message).not.toContain("unknown reason")
})

test("a failed run does not persist its session mapping", async () => {
  await withIsolatedSessionState(async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-claude-poison-"))
    const fake = join(directory, "fake-claude.mjs")
    await writeFile(fake, `console.log(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["No conversation found with session ID: gone"] })); process.exit(0)`)
    try {
      await expect((makeClaudeCodeTaskTool() as any).execute({
        task: "poison", cwd: directory, sessionKey: "poisoned-key", scope,
        executable: process.execPath, executableArgs: [fake],
      })).rejects.toThrow(/No conversation found with session ID/)
      // storedSession() no longer writes the pre-generated id before the run,
      // and the failed turn persists nothing afterwards.
      expect(existsSync(join(process.env.LOCALAPPDATA ?? "", "opencode", "claude-code-sessions.json"))).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

test("a stale-session downgrade forgets the dead id and retries fresh once", async () => {
  await withIsolatedSessionState(async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-claude-heal-"))
    const fake = join(directory, "fake-claude.mjs")
    const argvLog = join(directory, "argv.jsonl")
    await writeFile(fake, [
      `import { appendFileSync } from "node:fs";`,
      `const argv = process.argv.slice(2);`,
      `appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(argv) + "\\n");`,
      `const dead = JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["No conversation found with session ID: gone"] });`,
      `const ok = JSON.stringify({ type: "system", session_id: "ses_fresh" }); console.log(ok);`,
      `console.log(JSON.stringify({ type: "result", subtype: "success", result: "fresh-ok", session_id: "ses_fresh" }));`,
      `if (argv.includes("--resume")) { console.log(dead) }`,
    ].join("\n"))
    // Pre-seed the map with a poisoned pointer: an id whose conversation the
    // CLI does not have (the state a crash before saveRuntimeSession used to
    // leave behind).
    const stateDir = join(process.env.LOCALAPPDATA ?? "", "opencode")
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, "claude-code-sessions.json"), JSON.stringify({ [`${directory}::heal-key`]: { id: "gone", model: "claude-code/claude", scope } }))
    try {
      const result = await (makeClaudeCodeTaskTool() as any).execute({
        task: "heal me", cwd: directory, sessionKey: "heal-key", resume: true, followUpKind: "verify", scope,
        executable: process.execPath, executableArgs: [fake],
      })
      expect(result.content).toContain("fresh-ok")
      const lines = (await readFile(argvLog, "utf8")).trim().split(/\n/).map((line) => JSON.parse(line) as string[])
      // Exactly one downgrade: turn 1 resumes the dead id, turn 2 starts fresh.
      expect(lines).toHaveLength(2)
      expect(lines[0]).toContain("--resume")
      expect(lines[1]).not.toContain("--resume")
      expect(lines[1]).toContain("--session-id")
      // The healed mapping points at the session the CLI actually created.
      const map = JSON.parse(await readFile(join(process.env.LOCALAPPDATA ?? "", "opencode", "claude-code-sessions.json"), "utf8"))
      const record = Object.values(map)[0] as { id?: string }
      expect(record.id).toBe("ses_fresh")
      expect(JSON.stringify(map)).not.toContain("gone")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

test("a clean run reports no in-band error", () => {
  const parsed = parseClaudeStreamResult(JSON.stringify({ type: "result", subtype: "success", result: "done" }))!
  expect(parsed.isError).toBe(false)
  expect(parsed.text).toBe("done")
})

test("partial deltas and the terminal result do not double the answer", () => {
  // --include-partial-messages emits both; concatenating them returned
  // "BRIDGE_OKBRIDGE_OK" over the session bridge.
  const stream = [
    JSON.stringify({ type: "stream_event", event: { delta: { text: "BRIDGE_" } } }),
    JSON.stringify({ type: "stream_event", event: { delta: { text: "OK" } } }),
    JSON.stringify({ type: "result", subtype: "success", result: "BRIDGE_OK" }),
  ].join("\n")
  expect(parseClaudeStreamText(stream)).toBe("BRIDGE_OK")
})

test("a stream that ends without a terminal result still yields the deltas", () => {
  const stream = [
    JSON.stringify({ type: "stream_event", event: { delta: { text: "par" } } }),
    JSON.stringify({ type: "stream_event", event: { delta: { text: "tial" } } }),
  ].join("\n")
  expect(parseClaudeStreamText(stream)).toBe("partial")
})

test("npm .CMD shims are launched through cmd.exe, not spawned directly", () => {
  // Spawning a .cmd without a shell raises EINVAL on Windows. Every npm CLI
  // shim (claude, grok, codex) is a .CMD, so the harness died with
  // "spawn ...\claude.CMD EINVAL" the moment it ran under the real host.
  if (process.platform !== "win32") return
  const shim = windowsBatchLaunch("C:\npm\claude.CMD", ["-p", "hello"])
  expect(shim.executable.toLowerCase()).toContain("cmd")
  expect(shim.args.slice(0, 3)).toEqual(["/d", "/s", "/c"])
  expect(shim.args).toContain("C:\npm\claude.CMD")
  expect(shim.args).toContain("hello")
})

test("real executables are still spawned directly", () => {
  const direct = windowsBatchLaunch("C:\tools\git.exe", ["status"])
  expect(direct).toEqual({ executable: "C:\tools\git.exe", args: ["status"] })
})
