# Production readiness

Status: **not production-ready.** The local Library integration is complete enough for review; release gates remain intentionally open.

## 1. Completed and verified locally

- `/` now uses the shared spatial finished-collage experience and dynamically imports the Three/R3F scene; `/generator` remains isolated.
- Production data is limited to `GET /api/library`. Empty, invalid, malformed, reference/scene-lab URL, and duplicate-ID inputs cannot promote lab fixtures into `/`.
- One, two, four, and 21-record mocks were checked. The 20-plane field is a visual window only; all normalized records remain in the semantic collection.
- Selection, direct preview/download, removal, empty/error/retry, slow-load status, broken-preview fallback, deterministic QA scenes, and route history received local evidence. Details are in `docs/library-integration-qa.md`.
- `npm run test:scene-lab` passes 14/14, `npm run test:release-readiness` passes 8/8, Python tests pass 11/11, `npm run lint` passes, and `npm run build` passes.
- The production dependency audit reports zero known vulnerabilities after pinning PostCSS 8.5.14 through the package override.

## 2. Remaining S0 blockers

- The rights-manifest structure and validator are present, but each deployed completed-collage source package still requires approval data.
- A populated release Library dataset is required to confirm IDs, titles, ordering, preview URLs, download behavior, and removal permissions without mocks.
- Final production QA cannot pass until those inputs are available and the corresponding Browser evidence is recorded.

## 3. Remaining S1 blockers

- Physical iPhone Safari acceptance and Android Chrome real-device acceptance are unrecorded. An iPhone is available; Android remains pending through a borrowed or cloud-hosted real device.
- Browser/GPU performance acceptance is not recorded under the required desktop and constrained-mobile conditions.
- Browser/GPU restore acceptance remains open: a local context-loss fallback/restore pass works, but its renderer emitted two Three/driver texture-upload warnings. Browser zoom, forced-colors, and hard-reload behavior with real populated data need release-environment verification.

## 4. S2 material items

- The build reports a dynamically loaded chunk over 500 kB. It does not reach the Generator route, but should be profiled and split further if release performance evidence indicates a problem.

## 5. Final-production-only checks

- Confirm public asset rights and final metadata.
- Inspect Inter computed styles and captures on the release candidate at all target viewports.
- Capture a clean release build with the real API, authenticated permissions where applicable, and production CDN/cache behavior.
- Re-run the full visual, interaction, accessibility, history, resilience, and performance matrix without mocks.

## 6. Physical-device matrix

- iPhone Safari (physical device available): touch drag/tap, safe-area layout, reduced motion, memory, context recovery.
- Android Chrome (borrowed physical or cloud-hosted real device pending): touch drag/tap, safe-area layout, loading/preview fallback, memory, context recovery. Emulator evidence is preliminary only.
- Desktop Chromium/Windows: 1440x900 warm-cache scripted motion, GPU/frame timing, long-task trace.

## 7. Font status

Inter is the approved current release font. The project self-hosts normal and italic Inter variable WOFF2 files under `app/fonts/`, uses weights 100–900, retains optical-size data, and includes the SIL Open Font License 1.1. The build emits both WOFF2 files, injects local `@font-face` rules, and applies `--font-inter` to the global UI and Scene Lab. Release-environment computed-style and visual captures remain required.

## 8. Asset-rights status

Local screenshots use project sample imagery and contract-faithful mocks. No approval exists yet for public production preview use of each completed collage. Do not infer rights from local availability.

## 9. Deployment status

No deployment, database mutation, staging, commit, branch change, or fixture promotion occurred. Deployment was not requested.

## 10. Recommended next step

Populate a private staging Library after rights and paid-generation approval. Then run the Library validator, iPhone/Android/desktop matrix, and final performance traces before requesting production deployment approval.
