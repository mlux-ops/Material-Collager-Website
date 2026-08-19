# Material Collager

A browser app for creating high-end interior design material collage boards from real image references.

The app preserves selected source files in a browser draft and transfers each original reference in small request-safe chunks. Generation then retrieves those prepared files and sends them through the documented multipart Image API workflow as actual `gpt-image-2` inputs. References are not reduced to text descriptions or silently compressed into a small combined browser request.

Generation uses high input fidelity, item-by-item image mapping, explicit editorial art direction, and optional post-generation vision review. A board can use up to 16 PNG, JPEG, or WebP references, each under 50 MB.

## Local Development

Requires Node.js 22.13+ (see `engines` in `package.json`).

```powershell
git clone https://github.com/mlux-ops/Material-Collager-Website.git
cd Material-Collager-Website
npm install
cp .dev.vars.example .dev.vars   # then fill in OPENAI_API_KEY
npm run dev
```

Open the local URL shown in the terminal. `npm run dev` runs on Miniflare, which
simulates the Cloudflare D1/R2 bindings declared in `wrangler.jsonc` — no
Cloudflare account is needed for local development.

Using [Claude Code](https://claude.com/claude-code) locally against this repo
(rather than a remote/cloud session) gives full CLI features, including
`/plugin` and its marketplace. See `docs/DEPLOYING.md` for how pushes to
`main` deploy to the hosted Cloudflare Worker.

## Production Build

```powershell
npm run build
```

## Runtime Environment

The deployed Worker uses `OPENAI_API_KEY` as a Cloudflare Workers secret (see
`docs/DEPLOYING.md`). Locally, set it in `.dev.vars` (git-ignored).

If no server key is configured, the UI also accepts a per-request API key in
the password field. That key is sent only with the generation request and is
not stored by the app.

## App Workflow

- Choose a collage type.
- Use the preset item rows or add custom rows.
- Add, remove, and prioritize item-level reference images.
- Choose composition, spacing, lighting, styling, hero item, and output resolution.
- Run Dry Run to preview the exact prompt.
- Generate to receive a downloadable high-resolution PNG.
- Keep QA review enabled for an item-by-item fidelity check after generation.

## Legacy CLI

The original Python CLI remains available:

```powershell
material-collager dry-run --input request.json
material-collager generate --input request.json --output out.png
```

## Release Readiness

Inter is self-hosted from `app/fonts/`. Release evidence and staging procedures are documented in:

- `docs/release-decisions.md`
- `docs/staging-deployment-checklist.md`
- `docs/device-release-qa.md`

Validate the prepared rights manifest and local release tooling:

```powershell
npm run validate:rights
npm run test:release-readiness
npm run test:scene-lab
npm run lint
npm run build
```

After a private staging URL and at least eight approved final records exist:

```powershell
npm run qa:scaffold -- --date YYYY-MM-DD --commit COMMIT_SHA --base-url https://PRIVATE-REVIEW-URL
npm run validate:rights -- --release
npm run validate:library -- --base-url https://PRIVATE-REVIEW-URL --release `
  --output artifacts/release-qa/YYYY-MM-DD/library-validation.json `
  --records-output artifacts/release-qa/YYYY-MM-DD/library-records.json
```
