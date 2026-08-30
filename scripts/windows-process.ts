/** Central fail-closed process policy for background OpenCode work on Windows. */
import { execFile, execFileSync, type ExecFileOptions } from "node:child_process"

export const HEADLESS_EXEC_OPTIONS: ExecFileOptions = {
  shell: false,
  windowsHide: true,
  stdio: ["ignore", "pipe", "ignore"],
  timeout: 10_000,
}

export function hiddenExecFileSync(file: string, args: string[], options: ExecFileOptions = {}) {
  return execFileSync(file, args, { ...HEADLESS_EXEC_OPTIONS, ...options, shell: false, windowsHide: true })
}

export function hiddenExecFile(file: string, args: string[], options: ExecFileOptions = {}, callback?: (error: Error | null) => void) {
  return execFile(file, args, { ...HEADLESS_EXEC_OPTIONS, ...options, shell: false, windowsHide: true }, callback)
}

export function assertBackgroundCommand(command: string) {
  if (process.platform !== "win32") return
  if (/\b(?:start|start-process|wt(?:\.exe)?|conhost(?:\.exe)?|explorer(?:\.exe)?|cmd(?:\.exe)?\s*\/c)\b/i.test(command)) {
    throw new Error("visible Windows process denied in background execution")
  }
}
