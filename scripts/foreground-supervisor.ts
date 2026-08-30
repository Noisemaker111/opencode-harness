import { execFile, spawn, type ChildProcess } from "node:child_process"
import { startCommandWatchdog, terminateWatchedChild, type ProcessInfo } from "./command-watchdog"

export type SupervisorClock = { now(): number; setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout }
export type SupervisorOptions = { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; leaseMs?: number; timeoutMs?: number; clock?: SupervisorClock; sessionID?: string; abortSignal?: AbortSignal; onHeartbeat?: (elapsedMs: number) => void; onBlocked?: (event: { sessionID?: string; command: string; elapsedMs: number; state: "BLOCKED/HUNG" }) => void; onStdoutLine?: (line: string) => void; spawn?: typeof spawn; inspect?: (pid: number) => ProcessInfo | undefined }
export type SupervisedResult = { code: number; stdout: string; stderr: string; timedOut: boolean; blocked: boolean; elapsedMs: number }
const realClock: SupervisorClock = { now: Date.now, setTimeout, clearTimeout }
const safeCommand = (value: string) => value.replace(/(authorization|token|secret|password|api[_-]?key)\s*[:=]\s*[^\s]+/gi, "$1=[REDACTED]").slice(0, 240)

export function terminateExactChild(child: Pick<ChildProcess, "pid" | "kill">): Promise<void> {
  if (!child.pid) return Promise.resolve()
  if (process.platform === "win32") return new Promise((resolve) => execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => resolve()))
  try { process.kill(-child.pid, "SIGTERM") } catch { child.kill("SIGTERM") }
  return new Promise((resolve) => setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL") } catch { try { child.kill("SIGKILL") } catch {} } resolve() }, 1000))
}

/**
 * Windows refuses to spawn a `.cmd`/`.bat` directly without a shell — Node
 * raises EINVAL. npm installs every CLI shim as a `.CMD`, so `claude`,
 * `grok` and `codex` all hit this the moment they run under the real host
 * rather than a bun script. Route batch shims through cmd.exe, keeping
 * `shell: false` so arguments are still passed as a vector, not re-parsed.
 */
export function windowsBatchLaunch(executable: string, args: string[]): { executable: string; args: string[] } {
  if (process.platform !== "win32" || !/\.(cmd|bat)$/i.test(executable)) return { executable, args }
  const comspec = process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe"
  return { executable: comspec, args: ["/d", "/s", "/c", executable, ...args] }
}

export function superviseForeground(executable: string, args: string[], options: SupervisorOptions = {}): Promise<SupervisedResult> {
  const clock = options.clock ?? realClock, started = clock.now(), leaseMs = options.leaseMs ?? 30_000, timeoutMs = options.timeoutMs ?? 900_000, launcher = options.spawn ?? spawn
  const launch = windowsBatchLaunch(executable, args)
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try { child = launcher(launch.executable, launch.args, { cwd: options.cwd, env: options.env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }) } catch (error) { reject(error); return }
    let stdout = "", stderr = "", settled = false, blocked = false, timedOut = false, lastProgress = started
    let leaseTimer: ReturnType<typeof setTimeout>
    const finish = (code: number) => { if (settled) return; settled = true; watchdog.cancel(); clock.clearTimeout(leaseTimer); if (options.onStdoutLine && stdoutPending) { const rest = stdoutPending; stdoutPending = ""; options.onStdoutLine(rest) } resolve({ code, stdout, stderr, timedOut, blocked, elapsedMs: clock.now() - started }) }
    let notified = false
    const checkLease = () => { if (!settled && !notified && clock.now() - lastProgress >= leaseMs) { notified = true; blocked = true; options.onBlocked?.({ sessionID: options.sessionID, command: safeCommand([executable, ...args].join(" ")), elapsedMs: clock.now() - started, state: "BLOCKED/HUNG" }) } }
    const scheduleLease = () => { leaseTimer = clock.setTimeout(() => { checkLease(); if (!settled && !notified) scheduleLease() }, leaseMs) }
    scheduleLease()
    const inspect = options.inspect ?? ((pid: number) => ({ pid, name: executable, commandLine: [executable, ...args].join(" ") }))
    const watchdog = startCommandWatchdog(child, {
      timeoutMs,
      clock,
      inspect,
      terminate: terminateExactChild,
      onTimeout: () => { timedOut = true; finish(124) },
    })
    const progress = () => { lastProgress = clock.now(); options.onHeartbeat?.(lastProgress - started) }
    // Incremental stdout observer for callers that stream events live. The
    // buffered accumulation below is unchanged, so existing callers keep
    // today's behavior exactly.
    let stdoutPending = ""
    const emitStdoutLines = (chunk: string) => {
      if (!options.onStdoutLine) return
      stdoutPending += chunk
      const lines = stdoutPending.split(/\r?\n/)
      stdoutPending = lines.pop() ?? ""
      for (const line of lines) options.onStdoutLine(line)
    }
    child.stdout?.on("data", (chunk) => { const text = chunk.toString(); stdout = (stdout + text).slice(-2 * 1024 * 1024); emitStdoutLines(text); progress() })
    child.stderr?.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-2 * 1024 * 1024); progress() })
    const onAbort = () => { void terminateWatchedChild(child, { inspect, terminate: terminateExactChild }) }
    options.abortSignal?.addEventListener("abort", onAbort, { once: true })
    child.stdin?.on("error", () => {})
    if (options.input !== undefined) child.stdin?.end(options.input)
    else child.stdin?.end()
    child.once("error", () => finish(1)); child.once("close", (code) => { options.abortSignal?.removeEventListener("abort", onAbort); finish(timedOut ? 124 : code ?? 1) })
  })
}
