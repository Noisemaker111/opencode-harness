/**
 * Preflight and health journal for optional OpenCode plugins.
 *
 * OpenCode2 loads configured modules in one host process. A module that throws
 * during import can therefore fail the host before our plugin code runs. This
 * file is intentionally outside plugins/ so it is never itself auto-discovered.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { homedir } from "node:os"
import { parse as parseJson5 } from "json5"

export const HEALTH_FILE = join(homedir(), ".local", "state", "opencode", "plugin-health.json")
const MAX_ERROR = 700

export type PluginHealth = {
  path: string
  phase: "syntax" | "import" | "init" | "hook" | "schema"
  timestamp: string
  error: string
  action: "quarantined" | "disabled" | "fail-closed" | "reloaded"
}

function redact(value: unknown): string {
  return String(value ?? "error")
    .replace(/(api[_-]?key|password|token|authorization)\s*[:=]\s*[^\s,;}]+/gi, "$1=[redacted]")
    .replace(/[A-Za-z0-9+/]{32,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_ERROR)
}

export function readPluginHealth(file = HEALTH_FILE): PluginHealth[] {
  try {
    const value = JSON.parse(readFileSync(file, "utf8"))
    return Array.isArray(value) ? value : []
  } catch { return [] }
}

export function recordPluginHealth(entry: Omit<PluginHealth, "timestamp">, file = HEALTH_FILE) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const rows = readPluginHealth(file).filter((x) => x.path !== entry.path)
    rows.push({ ...entry, error: redact(entry.error), timestamp: new Date().toISOString() })
    writeFileSync(file, JSON.stringify(rows, null, 2) + "\n", "utf8")
  } catch { /* health reporting must not brick a send */ }
}

export function clearPluginHealth(path: string, file = HEALTH_FILE) {
  try {
    const rows = readPluginHealth(file).filter((x) => x.path !== path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(rows, null, 2) + "\n", "utf8")
  } catch {}
}

function jsonc(text: string): any {
  return parseJson5(text)
}

export function configuredPluginPaths(root: string): string[] {
  const out: string[] = []
  const add = (value: unknown) => {
    if (typeof value !== "string" || !value.trim()) return
    if (value.startsWith("file://")) {
      try { out.push(new URL(value).pathname.replace(/^\/(\w):/, "$1:").replaceAll("/", "\\")); return } catch {}
    }
    out.push(resolve(root, value.replace(/^\.\//, "")))
  }
  for (const [config, key] of [["opencode.jsonc", "plugin"], ["cli.json", "plugins"]] as const) {
    const path = join(root, config)
    if (!existsSync(path)) continue
    const parsed = jsonc(readFileSync(path, "utf8"))
    if (!Array.isArray(parsed[key])) throw new Error(`${config}: ${key} must be an array`)
    for (const p of parsed[key]) add(p)
  }
  const live = join(root, "plugins")
  const walk = (dir: string) => { if (!existsSync(dir)) return; for (const name of readdirSync(dir)) { const path=join(dir,name); if(statSync(path).isDirectory())walk(path); else if(/\.(?:ts|tsx|js|mjs)$/.test(name))out.push(resolve(path)) } }
  walk(live)
  return [...new Set(out)]
}

function tuiSourceError(source: string): string | undefined {
  if (!/export\s+default\s+(?:Plugin\.define\s*\(\s*)?(?:\{|[A-Za-z_$])/.test(source)) return "missing default plugin export"
  if (!/\bid\s*:\s*[`'\"][^`'\"]+[`'\"]/.test(source)) return "missing non-empty plugin id"
  if (!/\bsetup\s*(?:\(|:)/.test(source)) return "missing setup()"
  if (/from\s+["']bun:test["']/.test(source)) return "bun:test is not valid in plugin discovery"
  return undefined
}

export async function validateConfiguredPlugins(root: string, file = HEALTH_FILE) {
  const failures: PluginHealth[] = []
  let paths: string[]
  try { paths = configuredPluginPaths(root) }
  catch (error) {
    const e = { path: "opencode.jsonc/cli.json", phase: "schema" as const, error: redact(error), action: "quarantined" as const }
    recordPluginHealth(e, file); return [{ ...e, timestamp: new Date().toISOString() }]
  }
  for (const path of paths) {
    const rel = path.startsWith(root) ? path.slice(root.length + 1).replaceAll("\\", "/") : path
    if (!existsSync(path)) {
      const e = { path: rel, phase: "syntax" as const, error: "file does not exist", action: "quarantined" as const }
      recordPluginHealth(e, file); failures.push({ ...e, timestamp: new Date().toISOString() }); continue
    }
    const source = readFileSync(path, "utf8")
    try { new Bun.Transpiler({ loader: path.endsWith(".tsx") ? "tsx" : "ts" }).transformSync(source) }
    catch (error) { const e={path:rel,phase:"syntax" as const,error:redact(error),action:"quarantined" as const};recordPluginHealth(e,file);failures.push({...e,timestamp:new Date().toISOString()});continue }
    // TUI JSX must be source-validated, not imported by Bun without the host.
    if (/\.tsx?$/.test(path) && /(?:plugins[\\/]tui|tui-active|tui-bootstrap)[\\/]/.test(path)) {
      const error = tuiSourceError(source)
      if (error) { const e = { path: rel, phase: "schema" as const, error, action: "quarantined" as const }; recordPluginHealth(e, file); failures.push({ ...e, timestamp: new Date().toISOString() }); continue }
      clearPluginHealth(rel, file); continue
    }
    try {
      const mod = await import(path + `?preflight=${Date.now()}`)
      if (!mod?.default) throw new Error("missing default plugin export")
      clearPluginHealth(rel, file)
    } catch (error) {
      const e = { path: rel, phase: "import" as const, error: redact(error), action: "quarantined" as const }
      recordPluginHealth(e, file); failures.push({ ...e, timestamp: new Date().toISOString() })
    }
  }
  return failures
}

if (import.meta.main) {
  const root = process.env.OPENCODE_CONFIG_ROOT ?? join(homedir(), ".config", "opencode")
  const failures = await validateConfiguredPlugins(root)
  if (failures.length) { console.error(JSON.stringify({ ok: false, failures }, null, 2)); process.exit(1) }
  console.log(JSON.stringify({ ok: true, plugins: configuredPluginPaths(root) }, null, 2))
}
