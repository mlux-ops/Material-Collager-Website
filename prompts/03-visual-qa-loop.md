@Browser @Build Web Apps

Read `AGENTS.md`, `docs/reference-spec.md`, and `docs/landing-build-report.md`.

This task is a closed-loop visual and interaction correction pass. Do not redesign. Do not change product scope. Do not deploy.

## Establish deterministic comparisons

For each viewport below, capture the landing at progress 0.00, 0.20, 0.40, 0.60, 0.80, and 1.00 using QA mode:

- 1440 × 900
- 1280 × 800
- 1024 × 768
- 390 × 844

Use Browser screenshots. If the project does not already have a deterministic screenshot runner, add Playwright without replacing existing tooling:

```bash
npm install -D @playwright/test
npx playwright install chromium
```

Store screenshots in:

```text
artifacts/local/landing-final/<viewport>/<progress>.png
```

## Compare and repair

Create or update `docs/visual-qa.md` with one row per discrepancy and these fields:

- viewport;
- progress;
- element/panel;
- reference measurement/appearance;
- implementation measurement/appearance;
- severity: P0, P1, P2, or P3;
- correction made;
- verification screenshot.

Prioritize in this order:

1. composition and panel geometry;
2. scene progression and motion response;
3. z-order, translucency, blur, crop, and depth cues;
4. typography and fixed controls;
5. responsive behavior;
6. minor color and subpixel differences.

A P0 or P1 discrepancy blocks completion.

## Interaction tests

Verify and document:

- mouse wheel;
- trackpad with small and large deltas;
- touch drag on mobile viewport;
- rapid direction reversal;
- resize while mid-scene;
- page refresh at top and mid-progress if supported;
- reduced-motion mode;
- keyboard focus and links;
- no console errors or missing assets.

Keep iterating until all P0/P1 issues are resolved and remaining P2/P3 deviations are explicitly listed. End with the screenshot paths and a truthful statement of any remaining differences.
