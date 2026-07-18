# Visual QA - world-space renderer promotion

Date: 2026-07-17

## Scope

Promote the already-approved world-space perspective scroll renderer from the Scene Lab QA route to the production Library surface. This is a renderer promotion, not a new landing-page redesign or a full reference re-audit.

## Environment

- Local URL: `http://localhost:4173/`
- Deterministic route: `http://localhost:4173/scene-lab?qa=1&render=world&progress={anchor}`
- Browser: Codex in-app Browser

## Checks

| Check | Result |
| --- | --- |
| Production Library renderer | `data-scene-renderer="world-perspective"` |
| QA renderer anchors | Passed at `0.00`, `0.20`, `0.40`, `0.60`, `0.80`, and `1.00` |
| Desktop viewports | Passed at `1440 x 900` and `1280 x 800` |
| Tablet viewport | Passed at `1024 x 768` |
| Mobile viewport | Passed at `390 x 844` |
| Scroll interaction | Wheel input advanced the perspective panel field |
| Browser console | No errors or warnings observed |
| Automated checks | Scene Lab tests, lint, and production build passed |

## Evidence captured

- Settled perspective-field screenshots at `1440 x 900`, `1280 x 800`, `1024 x 768`, and `390 x 844`.
- Before/after wheel-scroll screenshots on the deterministic Scene Lab route.
- Renderer attribute checks at all six deterministic progress anchors.

## Discrepancy fixed

The production Library surface explicitly rejected the world-space renderer even though the latest renderer was present and working on the QA route. The renderer selection now makes world space the Library default while retaining the orthographic Scene Lab fallback unless QA explicitly requests world space.

## Remaining known deviations

- A fresh local Library has no persisted user collages, so the deterministic QA fixture route was used to verify populated-scene geometry and movement.
- This pass does not replace the broader approved-reference fidelity audit.
