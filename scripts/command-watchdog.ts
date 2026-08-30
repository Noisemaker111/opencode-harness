/** Timeout hung subagent commands without touching Jk's interactive desktop TUI. */
import type { ChildProcess } from "node:child_process"

export const DEFAULT_COMMAND_TIMEOUT_MS = 900_000

export type ProcessInfo = {
  pid?: number
  name?: string
  commandLine?: string
}

export type WatchdogClock = {
  setTimeout: typeof setTimeout
  clearTimeout: typeof clearTimeout
}

const TUI_NAME = /^(opencode2|opencode|wt|conhost)(?:\.exe)?$/i
/** Command-token match only. Must not fire on dirs/temp names like `.config\opencode` or `opencode-claude-*`. */
const TUI_CMD = /(?:^|[\\/\s"])(?:opencode2|opencode|wt|conhost)(?:\.exe)?(?:\s|"|$)/i
const CLIPBOARD = /opentui clipboard/i
const ISOLATED_NAME = /opencode-usage-isolated|opencode-isolated/i

function processBasename(value: string): string {
  const trimmed = String(value ?? "").trim().replace(/^"+|"+$/g, "")
  const slash = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"))
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed
}

export function isIsolatedStandalone(commandLine: string): boolean {
  const cmd = String(commandLine ?? "")
  return /--standalone\b/i.test(cmd) && ISOLATED_NAME.test(cmd)
}

/** True for live desktop TUI / clipboard processes that must never be killed. */
export function isProtectedDesktopProcess(info: ProcessInfo): boolean {
  const name = String(info.name ?? "").trim()
  const cmd = String(info.commandLine ?? "")
  if (CLIPBOARD.test(name) || CLIPBOARD.test(cmd)) return true
  const tui = TUI_NAME.test(name) || TUI_NAME.test(processBasename(name)) || TUI_CMD.test(cmd)
  if (!tui) return false
  return !isIsolatedStandalone(cmd)
}

export function assertKillAllowed(info: ProcessInfo): void {
  if (!isProtectedDesktopProcess(info)) return
  throw new Error(
    `refused to kill protected desktop process pid=${info.pid ?? "?"} name=${info.name ?? "?"} — need BOTH --standalone AND an isolated temp name`,
  )
}

type TerminateFn = (child: Pick<ChildProcess, "pid" | "kill">) => Promise<void>

export async function terminateWatchedChild(
  child: Pick<ChildProcess, "pid" | "kill">,
  opts?: { inspect?: (pid: number) => ProcessInfo | undefined; terminate?: TerminateFn },
): Promise<void> {
  if (!child.pid) return
  const info = opts?.inspect?.(child.pid)
  if (info) assertKillAllowed(info)
  const terminate = opts?.terminate ?? (await import("./foreground-supervisor")).terminateExactChild
  await terminate(child)
}

export type CommandWatchdog = { cancel(): void; timedOut(): boolean }

/**
 * Hard-timeout a spawned subagent command. Uses terminateExactChild after a
 * desktop-TUI protection check. Default 900s matches foreground-supervisor.
 */
export function startCommandWatchdog(
  child: Pick<ChildProcess, "pid" | "kill">,
  opts: {
    timeoutMs?: number
    clock?: WatchdogClock
    inspect?: (pid: number) => ProcessInfo | undefined
    terminate?: TerminateFn
    onTimeout?: () => void
  } = {},
): CommandWatchdog {
  const clock = opts.clock ?? { setTimeout, clearTimeout }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
  let timedOut = false
  let settled = false
  const timer = clock.setTimeout(() => {
    if (settled) return
    timedOut = true
    settled = true
    void terminateWatchedChild(child, { inspect: opts.inspect, terminate: opts.terminate }).finally(() => {
      opts.onTimeout?.()
    })
  }, timeoutMs)
  return {
    cancel() {
      if (settled) return
      settled = true
      clock.clearTimeout(timer)
    },
    timedOut() {
      return timedOut
    },
  }
}
