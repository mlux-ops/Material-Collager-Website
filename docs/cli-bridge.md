# CLI bridge: Claude CLI and Codex CLI workbench nodes

The workbench's **Claude CLI** and **Codex CLI** nodes work like the AI
Assistant node (instruction + optional context text and images in, plain text
out), but they are answered by the `claude` and `codex` CLIs on your own
computer, on your Claude and ChatGPT subscriptions, with no API key and no
per-call charge.

The browser calls a small local helper directly. The Worker can't reach your
machine, so nothing goes through the site's server. The nodes therefore work
from `npm run dev` and from the deployed site, but only on a computer where
the helper is running.

## Running it

```bash
npm run cli-bridge
```

At startup it prints whether each provider is ready:

```
claude: ready (C:\...\claude.exe)
codex: ready (C:\...\codex.exe)
CLI bridge listening on http://127.0.0.1:4795
```

A provider is enabled only when its CLI is signed in to a subscription:
`claude` must report `authMethod: "claude.ai"` (run `claude`, then `/login`), and
`codex login status` must say ChatGPT (run `codex login`). Otherwise the node
shows the reason.

Options: `--port <n>` (the nodes expect 4795, so change it only together with
`CLI_BRIDGE_ORIGIN` in `cliAssistant.manifest.ts`) and `--allow-origin <url>`
(repeatable) for an origin other than local dev or the deployed site.
`CLAUDE_BIN` / `CODEX_BIN` override where the executables are found.

The first time the deployed site reaches the helper, Chrome asks for
permission to access devices on your local network. Allow it for the site.

## What keeps it on the subscription

- Every child process gets an environment with `ANTHROPIC_*`, `CLAUDE*`,
  `OPENAI_API_KEY`, `CODEX_API_KEY` and `OPENAI_BASE_URL` removed. If any of
  those is set, the CLI bills it instead of the login. A key can also come
  from the `env` block of `~/.claude/settings.json`, which the next point
  covers.
- Claude runs with `--setting-sources project`, so that settings `env` block
  never loads. Its stream's init event reports `apiKeySource`, and the helper
  kills the run before the model is called if it isn't `none`.
- Codex runs with `--ignore-user-config` (auth still comes from `CODEX_HOME`).

## What the models can do

Nothing but answer:

- Claude: `--tools ""` (no tools at all), no MCP servers
  (`--strict-mcp-config`), no saved session. Images go in the stream-json
  message as base64, so no file path is handed over.
- Codex: `--sandbox read-only` with the shell (`shell_tool`, `unified_exec`),
  browser, computer use, apps, plugins, hooks, code mode and image generation
  disabled (`CODEX_DISABLED_FEATURES` in `scripts/cli-bridge/lib.mjs`).
  Verified against codex-cli 0.158.0: asked to run a command, it has no shell.
  Images are written to the run's temp directory and passed with `-i`.
- Both start in a fresh empty temp directory, deleted afterwards, so no
  project's CLAUDE.md, AGENTS.md or `.claude/` settings load.

## Who can call the helper

- It binds `127.0.0.1` only.
- The `Host` header must be `127.0.0.1:<port>` or `localhost:<port>`, which
  blocks DNS rebinding.
- A browser `Origin` must be on the allowlist: `http://localhost:3000`,
  `http://127.0.0.1:3000`, the deployed workers.dev origin, plus any
  `--allow-origin`. `POST /run` requires `Content-Type: application/json`, so
  every browser call needs a CORS preflight that only the allowlist passes.
  Requests with no `Origin` come from local processes, which could run the
  CLI themselves anyway.
- Payload caps match `/api/workbench/assist`: 32,000-character instruction,
  16 images (PNG, JPEG or WebP), 30M base64 characters.
- At most 2 runs at once; each is killed after 5 minutes or when the node run
  is cancelled.

## Limits

- Text only. Image renders still go through the OpenAI Image API and its key.
  A ChatGPT subscription doesn't cover that.
- Runs count against the same usage limits as your normal Claude and ChatGPT
  use, and each call pays a few seconds of CLI start-up.
- Codex offers only its default model (whatever the ChatGPT plan gives it).
  Claude offers `sonnet`, `opus` and `haiku`.
