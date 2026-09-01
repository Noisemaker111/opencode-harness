# opencode-harness

Harnesses for OpenCode 2 — drive Claude Code, Grok Build and Codex through their own CLIs on their own subscriptions, behind one OpenAI-compatible bridge. No API keys.

## What it does

A harness is another vendor's coding agent, driven through its own CLI on
your own subscription. No API key is used and nothing is billed per token —
authentication belongs to `claude`, `grok` and `codex` themselves.

| Harness | CLI | Models |
|---|---|---|
| Claude Code | `claude` | `claude`, `opus`, `sonnet`, `haiku` |
| Grok Build | `grok` | `grok-4.6`, `grok-4.5` |
| Codex | `codex` | account default, `gpt-5.6-sol` |

All three are served behind one OpenAI-compatible bridge on `127.0.0.1:3012`,
so a harness is selected the way a model is.

The `favorite-router` entrypoint owns this integration layer: it registers
the harness tools and presents model selection without taking ownership of
models' routing policy.

```jsonc
// opencode.jsonc
{ "plugin": ["./plugins-active/favorite-router.ts"] }
```

```jsonc
"grok-build": {
  "name": "Grok Build (Harness)",
  "package": "@opencode-ai/ai/providers/openai-compatible",
  "env": [],
  "settings": { "baseURL": "http://127.0.0.1:3012/v1", "apiKey": "local" },
  "models": { "grok-4.6": { "limit": { "context": 500000, "output": 500000 } } }
}
```

Declaring `limit` is required: these provider ids have no models.dev entry,
and an omitted limit makes the host invent a default — which will compact a
500k model less than halfway through its window.

## Things these CLIs do that will bite you

- **npm installs them as `.CMD`**, and Windows refuses to spawn a batch shim
  without a shell. `windowsBatchLaunch` routes them through `cmd.exe`.
- **They report API failures in-band and still exit 0.** The terminal
  `result` event carries `is_error` / `api_error_status` while `subtype`
  stays `"success"`. Check it before the exit code, or an expired login reads
  as `exited with code 1` — or the error prose is returned as the answer.
- **Partial-message streams repeat themselves.** The deltas and the terminal
  result carry the same text; concatenating both doubles every answer.
- **SSE needs a blank line between events**, or clients report
  `stream ended without finish_reason`.

## Usage reached

Every way a provider says the plan is spent — 402, 403, 429,
`resource_exhausted`, `usage balance exhausted`, `you've hit your usage
limit` — collapses to one line:

```
Usage reached — grok-build/grok-4.6. Falling over to openai/gpt-5.6-luna-fast.
```

No status code or provider dump reaches the user; the excerpt stays on
`failure.detail` for logs.

## Requires

- `opencode-papercuts` — imported, not vendored. Install it alongside.

## License

MIT
