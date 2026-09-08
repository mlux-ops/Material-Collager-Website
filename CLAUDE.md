# Material Collager

Browser app for generating interior-design material collage boards from real image
references, deployed as a Cloudflare Worker. References are sent to the OpenAI Image
API as actual image inputs — never downsampled to text descriptions.

Frontend visual-fidelity rules live in `AGENTS.md`. Read it before touching the
landing page or the generator UI.

## Commands

```bash
npm run dev          # vinext dev on Miniflare — simulates D1/R2 locally, no CF account needed
npm run build
npm run lint
npm run typecheck
```

Node 22.13+ required (`engines` in `package.json`).

### Tests

There is no run-all script. Suites are invoked individually:

```bash
npm run test:collage
npm run test:workbench            # uses --test-isolation=none: these suites share setup state
npm run test:workbench-export-import
npm run test:autoboard
npm run test:transitions
npm run test:scene-lab
npm run test:access
npm run test:release-readiness
```

Node's built-in runner over `tests/*.test.mjs`. `tests/test_*.py` covers the legacy
Python CLI and is deliberately not wired into npm.

### Autoboard

Board-generation pipeline in `scripts/autoboard/`, run as `npm run autoboard -- <cmd>`.
Subcommands: `plan`, `generate`, `redraft`, `confirm`, `finalize`, `batch-finalize`,
`batch-status`, `review`.

`review` starts a dependency-free `node:http` review UI on **port 4790** (`--port` to
override). Its render-workflow POST endpoints require `Content-Type: application/json`
as a CSRF defense.

## Architecture

| Path | Role |
|---|---|
| `app/` | The live Next.js App Router source — pages, `app/api/*` handlers, `app/lib/*`, `app/components/*` |
| `worker/` | Cloudflare Worker entry (`index.ts`, per `wrangler.jsonc` `main`); gates on Access JWT, then delegates to vinext's app-router entry |
| `src/material_collager/` | Legacy Python CLI, superseded by the web app but still shipped |
| `db/` | Drizzle schema over D1; tables are created lazily |
| `scripts/` | Autoboard pipeline plus release-validation and QA scaffolding scripts |
| `references/` | Approved design reference assets — the fidelity source of truth per `AGENTS.md` |

Image generation entry point is `app/api/generate/route.ts` (edge runtime).

## Cloudflare bindings

Declared in `wrangler.jsonc`: `DB` (D1, `material-collager-db`), `OUTPUTS` (R2),
`IMAGES` (image optimizer behind `/_vinext/image`), `AI` (Workers AI, used by
`/api/workbench/inpaint`). Access vars `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD`
are enforced by `worker/access.ts`.

## Deploy

Push to `main` triggers `.github/workflows/deploy.yml`, which resolves the real D1
UUID via `wrangler d1 list` before `wrangler deploy` — the UUID in `wrangler.jsonc`
is a local placeholder, so do not treat it as real. Repo secrets required:
`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`. `OPENAI_API_KEY` is a runtime Worker
secret set separately (`wrangler secret put`), and locally lives in git-ignored
`.dev.vars`. See `docs/DEPLOYING.md`.

## Gotchas

- Dev, build, and start all run through `vinext`, not `next` directly. Reaching for
  `npx next dev` will not work.
- Tests need `node --experimental-strip-types`. That strips types only — no enums,
  namespaces, or decorators in anything a test imports.
- Request bodies cap at 32 MB (`next.config.ts` `serverActions.bodySizeLimit`), applied
  to route handlers too. Large reference sets must use the chunked transport rather
  than one request.
- The `AI` binding hits Cloudflare's network even in local dev: it spends real
  free-tier neurons and needs a logged-in `wrangler` session.
- `package.json` scripts use Bash-style globs while `README.md` documents PowerShell
  continuations. Match the shell you are actually in — this repo mixes both.
