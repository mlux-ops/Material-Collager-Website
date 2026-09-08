# GPT Image 2 optimization — 2026-09-07

Implemented locally against GitHub `main` at `1e5dee9`. The workspace was fast-forwarded from `70b2844` before editing so the existing Autoboard quality-review work was retained.

## Changes

- `app/lib/collage.ts`: shortened repeated instructions while retaining ordered image mapping, primary/supporting views, exact product count, finish/geometry requirements, user notes, and final verification instructions. Styling props now have an explicit count exception. Approved drafts control arrangement, camera, and lighting without contradictory presets. Explicit item edits take precedence over general preservation rules.
- `app/api/generate/route.ts`: Final requests use high quality and lossless PNG, preserving their requested dimensions and original submitted reference bytes. Removed the extra lower-resolution fallback that could change aspect ratio and issue four upstream calls. Cancellation reaches reference downloads and image generation. Oversized prompts fail before reference retrieval.
- `app/lib/image-edit.ts` and `app/lib/openai-server.ts`: one upstream image-edit attempt per user action; failures surface with request diagnostics rather than silently repeating a potentially billable render. Quota, billing, and user-correctable image errors remain terminal. Shared prompt validation also protects workbench generation/edit calls. Usage remains the API's returned usage, without inventing token discounts.
- `app/api/economy/route.ts`: history polling records failed batches without buying a smaller replacement render; validates prompts before submission.
- `src/material_collager/prompts.py`: omitted the unrelated metal-finish glossary, made supporting-view instructions conditional, condensed duplication, and clarified the styling count exception.
- Regression coverage: `tests/image-efficiency.test.mjs`, `tests/image-routes.test.mjs`, `tests/collage-layout-master.test.mjs`, `tests/collage-prompt.test.mjs`, and `tests/test_prompts.py`.
- Measurement tool: `scripts/benchmark-image-prompts.mjs`.

## Prompt measurements

Reproduce with `node --experimental-strip-types scripts/benchmark-image-prompts.mjs 1e5dee9`.

| Fixture | Before characters | After characters | Reduction |
|---|---:|---:|---:|
| Single views | 3,452 | 2,829 | 18.0% |
| Supporting views | 4,792 | 3,463 | 27.7% |
| Approved draft | 3,872 | 2,650 | 31.6% |
| Uploaded layout | 4,448 | 3,326 | 25.2% |

These are text-length measurements, **not measured token billing or total-cost reductions**. Image inputs and high-quality output can dominate cost. No references were downsampled or dropped by these changes. Existing draft/studio quality choices remain available.

## Validation

- `node --experimental-strip-types --test --test-reporter=dot tests/*.test.mjs`: 411 passing JavaScript tests.
- `PYTHONPATH=src python -m unittest discover -s tests -p 'test_*.py'`: 13 passing Python tests (set `PYTHONPATH` using PowerShell on Windows).
- Targeted ESLint on the changed TypeScript, new JavaScript tests, and benchmark: passed.
- `npm run build`: passed; existing large-chunk warning remains. Set `WRANGLER_LOG_PATH` to a writable local path for sandboxed builds.
- `npm run typecheck`: 26 errors. A one-off compiler comparison (run locally during review, not kept in the repo — it baselined against `HEAD`, which is meaningless once the change is merged) found identical errors against the pre-change source. These concern missing Cloudflare/Drizzle types and an existing scene geometry assertion, not newly introduced diagnostics.
- `git diff --check`: passed.
- Preview attempted at `http://localhost:5173/generator`: HTTP 403. No Browser screenshots or visual-fidelity claim; the temporary preview server was stopped.

No live OpenAI renders were purchased during validation. The tests exercise prompt construction, original-byte transmission, settings, failures, retry counts, persistence inputs, and cancellation using mocked upstream calls. Improved visual accuracy and adherence remain to be evaluated on real renders. A useful follow-up is a matched before/after comparison of the four fixtures above, reviewing product count, finish/color, geometry, layout, artifacts, returned usage, and rerun rate. Do not infer visual quality from shorter prompts alone.

No deployment or live OpenAI render was performed. The existing `.claude/settings.local.json` was preserved.

## Official guidance used

GPT Image 2 processes inputs at high fidelity automatically, so `input_fidelity` remains omitted. High-quality final output and explicit dimensions are retained; resolutions above 3,686,400 pixels are documented as experimental. See the [OpenAI image-generation guide](https://developers.openai.com/api/docs/guides/image-generation).

The prompt changes use short labeled sections, clear source-image roles, and explicit preservation/change instructions, following the [GPT Image prompting guide](https://developers.openai.com/cookbook/examples/multimodal/image-gen-models-prompting-guide). These are implementation choices, not a guarantee of exact reproduction.
