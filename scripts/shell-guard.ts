/** Windows shell guard shared by the shell hook and the smoke test. */

export type ShellViolation = { rule: string; message: string }

const unixBinary = /\b(head|tail|cat|grep|ls|rm|cp|mv)(?=\s|$)/
const hint = "See skills/windows-shell/SKILL.md."

export function shellViolations(command: string): ShellViolation[] {
  const text = String(command ?? "")
  const violations: ShellViolation[] = []
  const add = (rule: string, message: string) => violations.push({ rule, message })

  if (unixBinary.test(text)) add("unix-binary", `Use PowerShell or rg instead of Unix binaries. ${hint}`)
  if (/(?:\\[^\r\n;&|]*)&&|&&[^\r\n;&|]*\\/i.test(text)) add("backslash-chain", `Use PowerShell ';' instead of &&. ${hint}`)
  if (/\bcd\s+[^\r\n;&|]*&&/i.test(text)) add("cd-chain", `Use Set-Location and ';' instead of cd ... &&. ${hint}`)
  if (/\bgit\s+ls-tree\b/i.test(text) && !/(?:^|\s)(?:-r|--recursive)(?:\s|$)/i.test(text)) {
    add("ls-tree-object", `Use git show for commit history or add -r/--recursive. ${hint}`)
  }
  // /dev/null as a PATH ARGUMENT (not a redirect) is rewritten to `nul` by MSYS
  // on Windows, and the tool then writes a real file with that name. `nul` is a
  // reserved DOS device, so git cannot hash it: every later commit dies with
  // "fatal: mmap failed: Invalid argument" until the file is removed.
  if (/(?:^|\s)--?[\w-]+[= ]\/dev\/null\b/.test(text)) {
    add("devnull-argument", `/dev/null becomes the reserved file "nul" when passed as an argument on Windows, and it breaks every later git commit. Write to a temp file, or drop the flag. ${hint}`)
  }
  return violations
}

/** Reserved DOS device names. A file with one of these names poisons the repo for git. */
export const RESERVED_NAMES = /^(nul|con|prn|aux|com[1-9]|lpt[1-9])(\.|$)/i

/**
 * Real work never happens in a temp directory.
 *
 * Sessions have been launched with a cwd under %TEMP%, builds have been staged
 * there, and 4.6 GB of untraceable output accumulated across 302 directories —
 * including a candidate tree a live session was still running inside. Once the
 * work is in temp there is no way to find it, review it, or commit it.
 *
 * Throwaway probes are fine; anything that writes is not.
 */
const TEMP_ROOTS = ["\\appdata\\local\\temp\\", "\\windows\\temp\\", "/tmp/", "/var/tmp/"]

function normalize(p: string): string {
  return String(p ?? "").replace(/\//g, "\\").toLowerCase()
}

export function isTempPath(path: string): boolean {
  const p = normalize(path)
  return TEMP_ROOTS.some((root) => p.includes(normalize(root)))
}

/** A session whose working directory is temp cannot produce traceable work. */
export function workspaceViolations(cwd: string | undefined): ShellViolation[] {
  if (!cwd || !isTempPath(cwd)) return []
  return [{
    rule: "temp-workspace",
    message: `Working directory is a temp path (${cwd}). Real work is staged in the repo (gitignored) so it stays traceable — see AGENTS.md.`,
  }]
}

/** Commands that build, install, clone or write INTO temp. Reading is fine. */
const TEMP_WRITE = /\b(git\s+(clone|init|worktree\s+add)|npm\s+(i|install|ci)|pnpm\s+(i|install)|bun\s+(install|add)|cargo\s+build|dotnet\s+build|msbuild|make|cmake|tsc\s+--?\w*out|New-Item|Copy-Item|Move-Item|mkdir)\b/i

export function assertSafeShell(command: string, cwd?: string): void {
  const hits = [...shellViolations(command), ...workspaceViolations(cwd)]
  const text = String(command ?? "")
  // Writing into temp from a sane cwd is the same mistake, one level removed.
  if (!hits.some((h) => h.rule === "temp-workspace") && TEMP_WRITE.test(text)) {
    const target = text.match(/[A-Za-z]:[\\/][^\s"']*|\/(?:var\/)?tmp\/[^\s"']*/g)?.find(isTempPath)
    if (target) {
      hits.push({
        rule: "temp-write",
        message: `Refusing to build or write into a temp path (${target}). Stage it in the repo instead — see AGENTS.md.`,
      })
    }
  }
  if (hits.length) throw new Error(`[shell-guard] ${hits.map((h) => h.message).join("; ")}`)
}

function selfTest(): void {
  const bad = ["ls -la", "cd vendor\\t3code && pnpm run build", "git ls-tree --name-only HEAD"]
  const good = ["Set-Location vendor/t3code; pnpm -C vendor/t3code run build", "Get-Content README.md", "rg -n pattern .", "git ls-tree -r HEAD", "git ls-tree --recursive --name-only HEAD"]
  for (const command of bad) if (!shellViolations(command).length) throw new Error(`did not reject: ${command}`)
  for (const command of good) if (shellViolations(command).length) throw new Error(`rejected: ${command}`)

  const tempCwd = "C:\\Users\\dev\\AppData\\Local\\Temp\\opencode\\candidate-123"
  if (!workspaceViolations(tempCwd).length) throw new Error("did not reject a temp working directory")
  if (workspaceViolations("C:\\Users\\dev\\.config\\opencode").length) throw new Error("rejected a real working directory")
  let threw = false
  try { assertSafeShell("bun install", tempCwd) } catch { threw = true }
  if (!threw) throw new Error("did not reject a build in a temp working directory")
  threw = false
  try { assertSafeShell("git clone https://x/y C:\\Users\\dev\\AppData\\Local\\Temp\\scratch") } catch { threw = true }
  if (!threw) throw new Error("did not reject cloning into a temp path")
  assertSafeShell("Get-Content C:\\Users\\dev\\AppData\\Local\\Temp\\probe.log")
  console.log("PASS: shell guard rejects bad commands, temp workspaces, and temp builds.")
}

if (import.meta.main && process.argv.includes("--self-test")) selfTest()
