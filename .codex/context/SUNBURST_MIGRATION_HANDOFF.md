# Sunburst Migration Handoff

Parked: 2026-09-08 17:10 CDT

## Resume point

Tasks 1 and 2 are complete and accepted. The Material Collager Generator and local Autoboard Review/CLI are operational under local, mocked, non-billable validation. Task 3 was delegated, began editing Workbench files, and was then intentionally interrupted at the user's requested stopping point. Task 3 is incomplete and unreviewed. Task 4 has not started.

Do not treat the current Workbench edits as accepted. Resume at Task 3 with Luna B, review the complete Task 3 diff, and keep Task 4 gated until Task 3 passes orchestrator review.

## Approved four-task plan

Source: `C:\Users\cowey\Downloads\Pasted text.txt`, SHA-256 `FE61188E033A1832AC7878BC0EA892318D72E61F3D0AF0006445DE00A2DCCFE7`, approved plan at lines 736-837.

### Task 1 — Core migration and Generator — accepted

Owner: Luna A, GPT-5.6 Luna, Extra High.

- Centralize the TypeScript Sunburst model and quality/background contract; mirror it in Python.
- Migrate immediate, diagnostic, Economy Batch, and Python image calls.
- Support `low`, `medium`, `high`, `xhigh`, `max`, and `auto`.
- Keep Final default/minimum `high`, preserving explicit `xhigh`/`max`.
- Add Generator Solid white default and optional Transparent background; old drafts stay opaque.
- Change only background-related prompt instructions for transparency.
- Keep Finals PNG; transparent non-Finals require PNG/WebP and reject JPEG before spending.
- Replace fixed estimates with unavailable pre-render cost and usage-based completed cost.
- Persist model, quality, background, format, and usage metadata without relabeling history.

### Task 2 — Local Autoboard Review and CLI — accepted

Owner: Luna A, continuing at Extra High.

- Save quality/background choices through plan persistence.
- Preserve references, uploads, notes, hero selection, and Review behavior.
- Thread options through generate, redraft, confirm, finalize, and batch-finalize.
- Precedence is explicit CLI option, then saved board option, then stage default.
- Old plans remain opaque and keep low/medium/high stage defaults.
- Render-option changes stale affected candidates while historical files/settings remain intact.
- Remove automatic paid retries; keep explicit manual rerun and structured diagnostics.
- Show unavailable pre-render cost and usage-based completed cost.
- Preserve transparent local previews/downloads.

### Task 3 — Workbench migration and transparent media handling — parked, incomplete

Owner on resume: Luna B, GPT-5.6 Luna, Extra High.

- Complete migration across every image-generating Workbench node and node-specific request builder.
- Expose higher qualities and optional transparency in applicable controls, types, import/export, and saved workflows while retaining current defaults.
- Include effective model, quality, background, and format in Sunburst-backed cache identity; preserve pinned outputs and avoid invalidating unrelated local/text/vision nodes.
- Remove legacy token formulas/calibration from Sunburst. Mixed totals must disclose unknown costs rather than presenting partial totals as complete.
- Preserve MIME type, extension, alpha, and provenance through cache, thumbnail, library, persistence, and export.
- Use checkerboard previews for alpha without baking the checkerboard into image bytes.
- Preserve PNG/WebP alpha; explicit JPEG export remains a documented white-flattening conversion.
- Retain Masked Edit/Patch compositing guarantees and validate mask ordering/compatibility.

Acceptance: old workflows import opaque; new settings round-trip; only relevant caches invalidate; transparent fixtures survive thumbnail/save/reload/export; protected pixels outside composite regions remain unchanged.

### Task 4 — Integrated validation, documentation, and delivery — not started

Owner: Luna A, with Luna B fixing its owned areas.

- Test Generator and Autoboard Review together first, then Workbench.
- Run JavaScript/Python suites, targeted lint, production build, and baseline/current typecheck comparison.
- Browser-check defaults, transparency, quality persistence, previews, and downloads with deterministic mocked fixtures.
- Update active docs/examples/model labels while preserving historical reports and metadata.
- Produce a workflow coverage matrix and remaining limitations.
- Prepare reviewed branch/change summary; do not deploy or merge.
- Do not purchase live renders; visual quality/prompt-adherence remain unmeasured until separately authorized.

## Repository baseline and protected changes

- Repository: `E:\Games\Claude\Material-Collager-Website`
- Branch: `autonomous-agent`
- Baseline commit: `ac1a39384b983238cb9c12a703be5c60e3b347b6`
- At baseline there were no tracked changes and one unrelated untracked file: `docs/generator-design-concept.md`.
- Preserve `docs/generator-design-concept.md` unchanged.
- Preserve `.codex/context/TASK_STATE.md`; it is the parent-owned orchestration ledger.
- Do not reset, discard, or rewrite unrelated changes.
- No deployment, merge, push, secret access, data migration, or paid/live OpenAI request was authorized or performed.

## Task 1 implementation and review

Core files:

- `app/lib/sunburst.ts`
- `app/api/generate/route.ts`
- `app/api/economy/route.ts`
- `app/api/workbench/edit/route.ts` (Task 1 legacy-contract guard only)
- `app/generator/page.tsx`
- `app/lib/collage.ts`
- `app/lib/generation-jobs.ts`
- `app/lib/image-edit.ts`
- `src/material_collager/cli.py`
- `src/material_collager/client.py`
- `src/material_collager/models.py`
- `src/material_collager/prompts.py`
- `tests/collage-output-format.test.mjs`
- `tests/collage-prompt.test.mjs`
- `tests/image-routes.test.mjs`
- `tests/sunburst-cost.test.mjs`
- `tests/workbench-quality-contract.test.mjs`
- `tests/test_client.py`
- `tests/test_models.py`
- `tests/test_prompts.py`
- `docs/visual-qa.md`

Orchestrator review returned and verified fixes for:

- Python direct-constructor validation before any client call.
- Isolation of the legacy Workbench GPT Image 2 quality subset until Task 3.
- Correct 0.5 Batch-rate multiplier.
- Immediate usage-cost calculation independent of storage and accurate status-aware history display.
- Removal of scratch `.playwright-cli` state.

Accepted evidence:

- Parent-run focused Node suite: 45/45.
- Parent-run Python suite: 22/22.
- Parent-run transition/full Node suite at Task 1 boundary: 482/482.
- Lint: 0 errors, 10 pre-existing warnings.
- Production build: passed; only the existing chunk-size warning.
- `git diff --check`: clean.
- Typecheck remained blocked only by the pre-existing Cloudflare/Drizzle environment types and existing scene geometry assertion; no new Sunburst diagnostic.
- Local Generator URL: `http://127.0.0.1:3000/generator`.
- Browser console: 0 errors, 0 warnings.

Task 1 screenshots:

- `output/playwright/generator-task1-1440x900.png`
- `output/playwright/generator-task1-1280x800.png`
- `output/playwright/generator-task1-1024x768.png`
- `output/playwright/generator-task1-390x844.png`
- `output/playwright/generator-task1-1440x900-transparent.png`

## Task 2 implementation and review

Core files:

- `scripts/autoboard/cli.mjs`
- `scripts/autoboard/lib/openai-upload.mjs`
- `scripts/autoboard/lib/render.mjs`
- `scripts/autoboard/lib/render-queue.mjs`
- `scripts/autoboard/lib/review-core.mjs`
- `scripts/autoboard/lib/review-page.mjs`
- `scripts/autoboard/lib/review-server.mjs`
- `scripts/autoboard/lib/variants.mjs`
- `tests/autoboard-cli.test.mjs`
- `tests/autoboard-page.test.mjs`
- `tests/autoboard-render.test.mjs`
- `tests/autoboard-render-queue.test.mjs`
- `tests/autoboard-review.test.mjs`
- `docs/visual-qa.md`

Orchestrator review returned and verified fixes for:

- Keeping failure lifecycle `status: "error"` separate from `httpStatus`.
- Preserving structured status/code/retry-after/diagnostic data with one paid request per user action.
- Including exact source kind/id and Final force semantics in Review queue deduplication.
- Reporting completed cost from the actual completed stage rather than a prior draft.
- Applying shared candidate-staleness gates to direct finalize and batch-finalize, with CLI override precedence and old-plan compatibility.
- Preserving source draft quality/background through Confirm instead of overwriting them with the confirmation tier.

Accepted evidence:

- Parent-run `npm run test:autoboard`: 168/168 passed after final correction.
- Agent-run full Node suite: 492/492 passed before the last narrow correction; the final narrow correction is covered by the parent-run 168-test suite.
- Lint: 0 errors, 9 pre-existing warnings.
- All touched modules passed syntax checks.
- `git diff --check`: clean.
- CLI dry-run verified `xhigh` plus transparent settings without loading secrets or sending a request.
- Local Review URL: `http://127.0.0.1:4199/`.
- Browser console: 0 errors, 0 warnings.

Task 2 screenshots:

- `output/playwright/autoboard-review-1440x900.png`
- `output/playwright/autoboard-review-1280x800.png`
- `output/playwright/autoboard-review-1024x768.png`
- `output/playwright/autoboard-review-390x844.png`

## Task 3 partial work present at interruption

The following Workbench files gained tracked edits after Task 3 started. These edits are unreviewed and may be incomplete:

- `app/components/workbench/WorkbenchApp.tsx`
- `app/components/workbench/executor.ts`
- `app/components/workbench/nodes/generation.ts`
- `app/components/workbench/nodes/imageEdit.manifest.ts`
- `app/components/workbench/nodes/imageGenerate.manifest.ts`
- `app/components/workbench/nodes/maskedEdit.manifest.ts`
- `app/components/workbench/nodes/maskedEdit.tsx`
- `app/components/workbench/nodes/relight.manifest.ts`
- `app/components/workbench/nodes/shared.tsx`
- `app/components/workbench/nodes/upscaler.manifest.ts`
- `app/components/workbench/nodes/upscaler.tsx`
- `app/components/workbench/nodes/variations.manifest.ts`
- `app/components/workbench/nodes/variations.tsx`
- `app/components/workbench/types.ts`

Do not discard these edits. On resume, ask Luna B to inspect its partial diff, reconcile it against the exact Task 3 scope, complete tests and Browser QA, and then return it for orchestrator review.

## Remaining known limitations

- Task 3 Workbench changes are incomplete and unreviewed.
- Task 4 integrated validation, coverage matrix, final documentation, and delivery review have not started.
- No live/paid render was run. Local/mocked correctness is verified for Tasks 1-2, but real Sunburst visual quality and prompt adherence are not measured.
- Existing typecheck environment diagnostics remain; compare against the stored baseline before attributing any diagnostic to the migration.

## Exact resume sequence

1. Read `AGENTS.md`, `CLAUDE.md`, this handoff, and `.codex/context/TASK_STATE.md`.
2. Run `git status --short --branch` and `git diff --stat`; preserve all changes.
3. Reuse Luna B at GPT-5.6 Luna Extra High and give it Task 3 only. Tell it to reconcile, not discard, the partial Workbench edits listed above.
4. Keep Task 4 gated while Luna B completes Task 3.
5. Review Task 3 diff against every acceptance item, including node coverage, cache identity, mixed unknown costs, alpha/MIME/extension provenance, saved workflow round-trip, checkerboard-only presentation, JPEG white flattening, and Masked Edit protected-pixel behavior.
6. Run focused Workbench tests, targeted lint, build/typecheck comparison, and required Browser QA. Return concrete fixes to Luna B until Task 3 passes.
7. Only then open Task 4 and assign Luna A, with Luna B fixing Workbench-owned findings.

Suggested verification commands on resume:

```powershell
git status --short --branch
git diff --stat
npm run test:autoboard
$env:PYTHONPATH='src'; python -m unittest discover -s tests -p 'test_*.py'
npm run test:transitions
npm run lint
npm run build
npm run typecheck
git diff --check
```

## Usage at parking point

- 5-hour window: 10% remaining.
- Weekly window: 86% remaining.
- The user requested a detailed handoff at 5% or below. This handoff was created early because the migration was explicitly parked at the accepted Task 1-2 boundary.

## No-deploy status

No deployment, merge, push, paid render, live image-generation call, secret access, or production-state write occurred.
