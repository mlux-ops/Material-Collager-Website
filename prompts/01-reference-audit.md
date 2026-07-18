@Browser @Build Web Apps

Read `AGENTS.md` completely before doing anything else.

This task is REFERENCE ANALYSIS ONLY. Do not edit application code. Do not use ImageGen. Do not redesign or reinterpret the reference.

## Inputs

- Live URL: read `references/live-url.txt`
- Screen recording: `references/unveil-scroll.mp4`
- Extracted frames: `references/video-frames/` (the 90 existing frame files are valid)
- Reference screenshots: `references/screenshots/`
- Four design breakdowns: `references/design-breakdowns/`
- Existing landing and generator screenshots: `references/screenshots/current-landing.png` and `references/screenshots/current-generator.png`

## Required Browser inspection

Open the live reference in Browser at:

- 1440 × 900
- 1280 × 800
- 390 × 844

At each viewport:

1. capture the initial state;
2. move through the complete scroll interaction;
3. capture representative states at approximately 0%, 20%, 40%, 60%, 80%, and 100%;
4. inspect whether the experience uses DOM elements, canvas/WebGL, CSS 3D, or a hybrid;
5. inspect computed typography, fixed controls, media dimensions, container geometry, network-loaded fonts and assets, and any accessible DOM structure;
6. record any access limitation rather than guessing.

Analyze the screen recording frame sequence for:

- scroll direction and total progression;
- panel entry and exit paths;
- camera/perspective behavior;
- panel scale, rotation, opacity, blur, crop, overlap, and z-order;
- easing, inertia, damping, snapping, and overscroll;
- responsive differences;
- fixed versus moving elements.

## Deliverable

Create `docs/reference-spec.md` with these sections:

1. **Reference evidence** — files inspected, Browser URLs, viewports, screenshots, and any unavailable inputs.
2. **Current-build failure audit** — specifically explain why the current landing and generator do not match.
3. **Composition map** — exact fixed regions, viewport usage, panel field, negative space, and navigation.
4. **Panel geometry table** — for each representative scene state, estimate x/y/width/height/z/rotation/opacity/blur for visible panels.
5. **Motion model** — input mapping, normalized progress, interpolation, damping/easing, entry/exit rules, and mobile gestures.
6. **Typography and tokens** — actual fonts, weights, sizes, line heights, tracking, colors, borders, radii, opacity, and blur.
7. **Responsive rules** — desktop, tablet, and mobile differences.
8. **Asset inventory** — required images, fonts, icons, and missing licensed assets.
9. **Architecture decision** — choose DOM + CSS 3D, React Three Fiber/Three.js, or another approach and justify it from evidence.
10. **Implementation plan** — components, hooks, state, loading, performance, accessibility, and reduced motion.
11. **Acceptance rubric** — measurable criteria and rejection conditions.
12. **Open questions** — only genuine unresolved items.

Do not write implementation code. Stop after creating the spec and ask for approval.
