# Material Collager

Browser app for generating interior-design material collage boards from real image
references, deployed as a Cloudflare Worker. References are sent to the OpenAI Image
API as actual image inputs — never downsampled to text descriptions.

Frontend visual-fidelity rules live in `AGENTS.md`. Read it before touching the
landing page or the generator UI.

**Design details come from the existing site.** Measure the running app — type,
colour and spacing — and match it. Do not design from `globals.css`: the
`.generator-shell` block near the end of that file overrides the earlier rules,
so the source reads nothing like what renders. The live scale is 8.4px uppercase
labels and buttons, 10px sub text, 11px body and controls, 14px headings and
item titles; nothing on any page is larger than 14px, and chrome text is black
or `#657069`, never the teal — which is reserved for state.

## Commands

```bash
npm run dev          # vinext dev on Miniflare — simulates D1/R2 locally, no CF account needed
npm run build
npm run lint
npm run typecheck
```

Node 22.13+ required (`engines` in `package.json`).

### Tests

`npm run test:transitions` is misnamed: its glob is `tests/*.test.mjs`, so it runs
the **entire** suite (466 tests), not just transitions. Use it as the run-all.

Individual suites:

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

The slot rules and board assembly live in `app/lib/autoboard/`, not in
`scripts/autoboard/lib/`; the `.mjs` files there re-export them, so existing
imports are unchanged. Anything under `app/lib/autoboard/` must avoid `node:`
builtins, the `@/` alias and extensionless imports — `docs/autoboard-shared-core.md`
has the rules and the reasons, and `tests/autoboard-parity.test.mjs` enforces
them (nothing else does).

`review` starts a dependency-free `node:http` review UI on **port 4790** (`--port` to
override). Its render-workflow POST endpoints require `Content-Type: application/json`
as a CSRF defense.

The web equivalent is `/review-boards`: point it at a project's Smartsheet, pick
the unit types and rooms you want, collect a reference photo per row, and it
builds and stores the boards. It runs the same core. Reference photos come from
the sheet's link (resolved through the product page's `og:image` when the link
is a page, not an image), a pasted URL, or an upload; nothing is used until a
person selects it in the review grid. Storage is the lazily-created D1 tables
`autoboard_projects` and `autoboard_photos` plus R2 under `autoboard/`; reading a
sheet needs the `SMARTSHEET_ACCESS_TOKEN` Worker secret.

Server-side URL fetching is an SSRF surface — a sheet cell is untrusted input.
`app/lib/autoboard/photo-sources.ts` holds the guard; read it before touching
anything that fetches. See `docs/autoboard-shared-core.md`.

`npm run autoboard:seed-web -- --project 651-belmont [--select]` fills a running
`/review-boards` from a tracked project definition and the library root the
scaffold already built — the web board's D1/R2 state is per-machine, so a fresh
checkout otherwise means collecting a photo for every row by hand before the
first draft. It reads the library and uploads copies through the app's own API;
nothing in the library root is touched. A project seeded this way has no sheet
behind it, so `refresh` refuses it by design.

Projects without a Smartsheet sheet of their own live as tracked definitions in
`scripts/autoboard/projects/`; `npm run autoboard:scaffold -- --project <id>` turns one
into the library root (`build_manifest_v2.csv` + `_BUILD_LOG.csv` + photo folders) that
`plan --offline --library-root` reads, and `--fetch-images` pulls each item's vendor
reference photos from the project's `<id>-images.json` (URLs only — the image files are
third-party product photography and are never committed). 651 Belmont is the first — see
`docs/autoboard-651-belmont.md`, which also covers running its review board on port 4791
alongside Wieland's on 4790.

## Architecture

| Path | Role |
|---|---|
| `app/` | The live Next.js App Router source — pages, `app/api/*` handlers, `app/lib/*`, `app/components/*` |
| `app/lib/autoboard/` | Board-building rules shared by the CLI and the web review board — see `docs/autoboard-shared-core.md` before adding to it |
| `worker/` | Cloudflare Worker entry (`index.ts`, per `wrangler.jsonc` `main`); gates on Access JWT, then delegates to vinext's app-router entry |
| `src/material_collager/` | Legacy Python CLI, superseded by the web app but still shipped |
| `db/` | Drizzle schema over D1; tables are created lazily |
| `scripts/` | Autoboard pipeline plus release-validation and QA scaffolding scripts |
| `references/` | Approved design reference assets — the fidelity source of truth per `AGENTS.md` |

Image generation entry point is `app/api/generate/route.ts` (edge runtime).

Upstream prompting and parameter rules for the model this app runs on are
distilled in `docs/reference/openai-image-prompting.md` (OpenAI's GPT Image 2.5
guide). Read it before changing prompt construction in `app/lib/collage.ts`,
`src/material_collager/prompts.py`, or the autoboard stage payloads — it covers
reference-role assignment, multi-turn edit constraints, size limits, and the
transparency rules.

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
`.dev.vars`. A repository secret `SMARTSHEET_ACCESS_TOKEN`, if present, is pushed
to the Worker by the workflow's **Sync Worker secrets** step after each deploy,
and that step prints `wrangler secret list` (names only) every run. See
`docs/DEPLOYING.md`.

**Local dev enforces the Access gate.** `CF_ACCESS_TEAM_DOMAIN` and
`CF_ACCESS_AUD` are set in `wrangler.jsonc` `vars`, and Miniflare reads that
block too, so `npm run dev` answers 403 to every page with nothing in front of
localhost to mint a JWT. Blank both in `.dev.vars`, which overrides
`wrangler.jsonc` — `.dev.vars.example` has the full local set.

## Gotchas

- Dev, build, and start all run through `vinext`, not `next` directly. Reaching for
  `npx next dev` will not work.
- Tests need `node --experimental-strip-types`. That strips types only — no enums,
  namespaces, decorators, or constructor parameter properties in anything a test
  imports. `tsconfig.json` sets `erasableSyntaxOnly` so `npm run typecheck`
  rejects them; without it both `tsc` and `eslint` accept all four and only
  `node --test` fails. It also sets `verbatimModuleSyntax`, because a
  value-position import of a type is a link-time `SyntaxError` that neither gate
  can see.
- `npm run typecheck` is not a pass/fail gate: 14 errors pre-date this tree
  (workbench, scene-lab, `db/index.ts`, and the `examples/` tree). The usable
  criterion is that a change adds none. Cloudflare's own types come from
  `@cloudflare/workers-types` via tsconfig `types`; that array also has to list
  `node`, because naming it at all turns off automatic `@types/*` inclusion.
  `db/index.ts` still errors because workers-types' generic `Env` has no
  bindings — the fix is a generated `worker-configuration.d.ts` from
  `wrangler types`, not a hand-written declaration.
- Request bodies cap at 32 MB (`next.config.ts` `serverActions.bodySizeLimit`), applied
  to route handlers too. Large reference sets must use the chunked transport rather
  than one request.
- The `AI` binding hits Cloudflare's network even in local dev: it spends real
  free-tier neurons and needs a logged-in `wrangler` session.
- Sunburst rejects `input_fidelity`. The `/v1/images/edits` schema lists the
  field with no model restriction, but `gpt-image-2.5-sunburst-2026-09-08`
  answers HTTP 400 `invalid_input_fidelity_model`, and `gpt-image-2` rejects it
  too. Verified live 2026-09-08; do not re-add it on the strength of the schema.
- A render's cost is dominated by reference images, not by quality. Measured on
  a 6-reference board at quality `low`: 8,349 image input tokens ($0.067) vs 158
  image output tokens ($0.005) — 88% of the bill, and image input does not vary
  with the quality tier. Roughly 1,391 image input tokens per reference. The
  Images API also reports no `cached_tokens` at all, so prompt caching does not
  apply to `/v1/images/edits`.
- `package.json` scripts use Bash-style globs while `README.md` documents PowerShell
  continuations. Match the shell you are actually in — this repo mixes both.
- `wrangler.jsonc` sets `keep_vars: true` so variables added in the Cloudflare
  dashboard survive `wrangler deploy`. Without it a Text-type dashboard variable
  is deleted on every push to `main` (secrets are kept either way) — which is how
  a token that was "put in Cloudflare" can be gone after the next deploy.
