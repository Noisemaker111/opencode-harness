/**
 * opencode-mcp.ts — shared MCP surface for cross-harness subagents.
 *
 * One spec for the MCP server that every harness can load. No spawning,
 * no I/O — just the tool contract and the temp-file helper that
 * `harness-run` and `claude-code-task` call to build a `--mcp-config`.
 *
 * The server that serves these tools is `opencode-mcp-stdio.mjs`, which
 * carries its own copy of the list: it runs as a child of the harness CLI and
 * cannot import TypeScript. Keep the tool names here in step with that file.
 *
 * Owner: harnesses/ (pure). Import only from stdlib — boundary test in
 * test/harnesses.test.ts enforces this.
 */


/** OpenCode flattens MCP server + tool names, so `mcp` + `agent` is `mcp_agent`. */
export const OPENCODE_MCP_SERVER_NAME = "mcp"
export const OPENCODE_MCP_BRIDGE_URL = "http://127.0.0.1:3012"
export const OPENCODE_MCP_ENV_PARENT = "OPENCODE_PARENT_SESSION_ID"
export const OPENCODE_MCP_ENV_CWD = "OPENCODE_CWD"

export type OpencodeMcpToolName =
  | "agent"
  | "agent_status"
  | "agent_output"
  | "pick_model"

export type OpencodeMcpAgentInput = {
  task: string
  questID: string
  model: string
  sessionID?: string
  cwd?: string
}

export const OPENCODE_MCP_TOOLS = [
  {
    name: "agent",
    description: "Start a model worker through the OpenCode server, never an in-process Task/subagent. Exposed to OpenCode as mcp_agent. Works from any harness and always returns immediately.",
    inputSchema: {
      type: "object" as const,
      properties: {
        task: { type: "string", description: "What the model worker should do" },
        questID: { type: "string", description: "Canonical Quest ID. Hidden role is derived from this Quest's lineage." },
        model: { type: "string", description: "Required provider/model, e.g. opencode-go/grok-4.6, grok-sub/grok-4.6, claude-code/sonnet, grok-build/grok-4.6, codex/default." },
        sessionID: { type: "string", description: "Existing mcp_agent OpenCode session to continue; must already belong to this Quest." },
        cwd: { type: "string", description: "Working directory for the subagent (defaults to parent cwd)" },
      },
      required: ["task", "questID", "model"],
      additionalProperties: false,
    },
  },
  {
    name: "pick_model",
    description: "Pick the best available model for a task using capacity and usage telemetry.",
    inputSchema: {
      type: "object" as const,
      properties: {
        task: { type: "string", description: "What the subagent would be asked to do" },
      },
      required: ["task"],
      additionalProperties: false,
    },
  },
  {
    name: "agent_status",
    description: "Check a model worker started by mcp_agent (queued/running/completed).",
    inputSchema: {
      type: "object" as const,
      properties: {
        runID: { type: "string", description: "Session/run ID returned by mcp_agent" },
        sessionID: { type: "string", description: "Alternative: opencode session ID" },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "agent_output",
    description: "Get output/completion from a model worker started by mcp_agent.",
    inputSchema: {
      type: "object" as const,
      properties: {
        runID: { type: "string" },
        sessionID: { type: "string" },
      },
      required: [],
      additionalProperties: false,
    },
  },
] as const

export function mcpConfigForWrapper(wrapperPath: string, parentSessionId?: string, cwd?: string): Record<string, unknown> {
  const env: Record<string, string> = {}
  if (parentSessionId) env[OPENCODE_MCP_ENV_PARENT] = parentSessionId
  if (cwd) env[OPENCODE_MCP_ENV_CWD] = cwd
  return {
    mcpServers: {
      [OPENCODE_MCP_SERVER_NAME]: {
        command: "node",
        args: [wrapperPath],
        env: Object.keys(env).length ? env : undefined,
      },
    },
  }
}

export function mcpConfigJson(wrapperPath: string, parentSessionId?: string, cwd?: string): string {
  return JSON.stringify(mcpConfigForWrapper(wrapperPath, parentSessionId, cwd), null, 2)
}
