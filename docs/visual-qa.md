# Visual QA - Scene Lab V2 production promotion

Date: 2026-07-18

## Scope

Promote the approved Scene Lab V2 linear glass rail from GitHub commit `6f62bf58198eb6b005ab7db7dfd30d5b59f9f5db` to the production Library homepage. Preserve the original Scene Lab at `/scene-lab`, the V2 review route at `/scene-lab-v2`, the Generator, API routes, and Library data integration.

## Environment

- Local URL: `http://localhost:4173/`
- V2 review URL: `http://localhost:4173/scene-lab-v2`
- Browser: Codex in-app Browser
- Desktop viewport: `1280 x 720`

## Checks

| Check | Result |
| --- | --- |
| Production homepage renderer | `scene-wheel-v2-spatial-glass` |
| Library source | `/api/library`, with completed-collage fixtures as local fallback |
| Native scroll progression | Passed; progress changed from `0.00000` to `0.76444` |
| Glass hover extraction | Passed; hovered pane separated and displayed its title |
| Pane viewer | Passed; click opened the full Warm oak fixture collage viewer |
| Horizontal overflow | None observed |
| Browser console | No errors or warnings observed |
| Automated checks | Scene Lab tests, lint, and production build passed |

## Evidence captured

- Settled desktop rail at initial progress.
- Scrolled rail with a visibly different pane composition.
- Hover title and glass-pane extraction.
- Full collage viewer after pane selection.

## Discrepancy fixed

The previous deployment promoted a separate world-space QA prototype. The tested V2 implementation is a distinct spatial-glass field under `app/components/scene-wheel-v2`; the homepage now loads that exact renderer.

## Remaining known deviations

- Mobile acceptance is intentionally out of scope at the user's direction.
- The original `/scene-lab` remains available as V1 and is not the production homepage.

## Navigation restoration

Date: 2026-07-18

- Restored the approved 580 px desktop navigation cluster: `MATERIAL COLLAGER / LIBRARY / GENERATOR`.
- Confirmed all three controls are visible above the Scene Lab V2 canvas at `1280 x 720`.
- Confirmed `GENERATOR` navigates from `/` to `/generator` and the working Board setup screen renders.
- Confirmed no framework overlay and no Browser console errors or warnings.
- Mobile navigation remains outside this acceptance scope at the user's direction.

## Wheel interaction repair

Date: 2026-07-18

- Reproduced the deployed regression: downward mouse-wheel input left both `window.scrollY` and scene progress unchanged.
- Changed Scene Lab V2 to consume wheel deltas directly and advance the glass rail in either direction, while preserving native-scroll updates for keyboard and scrollbar input.
- Browser acceptance requires forward wheel input to increase progress and reverse wheel input to return toward the starting composition without console errors.

## iPhone 15 Pro Max responsive pass

Date: 2026-07-18

- Target viewport: `430 x 932` CSS pixels, portrait orientation.
- Mobile navigation must fit the usable viewport with three 58 px touch targets and the approved `MATERIAL COLL.` abbreviation.
- Mobile WebGL framing uses the same rail geometry with a portrait-specific camera fit so the diagonal pane field fills the viewport instead of collapsing into a clipped sliver.
- The page opts into `viewport-fit=cover`; navigation, captions, and the viewer account for iPhone safe-area insets.
- The rail preserves vertical touch panning, and the full-screen viewer exposes a 44 px minimum Close target.
- The Generator fits the phone viewport without inner horizontal overflow, respects top/bottom safe areas, and exposes 44 px minimum form and button targets without changing application behavior.
- Desktop camera values remain unchanged.

## iPhone 15 final usability audit

Date: 2026-07-18

- The collage viewer locks background scrolling, moves focus to its Close control, restores focus on dismissal, and keeps the underlying rail inert while the dialog is open.
- Generator disclosure rows, Add item, remove-item, help, save/reset, and primary action controls expose at least 44 px touch targets in portrait and landscape layouts.
- Generator help text opens as a viewport-contained banner below the fixed navigation so field explanations never clip off either edge of the phone.
- Generator text inputs, selects, and textareas render at 16 px on phones to prevent Mobile Safari from zooming the page when a field receives focus.
- Portrait and landscape layouts account for iPhone safe areas; the landscape Library and Generator retain their wider desktop-derived composition without horizontal overflow.
- Local visual QA can freeze the WebGL rail deterministically with `?qa=1&progress=0.00` through `1.00`; production browsing keeps the normal continuous scroll behavior.
- Browser verification passed at `1440 x 900`, `1280 x 800`, `1024 x 768`, `390 x 844`, and the target `430 x 932` viewport. At each size, progress `0.00`, `0.20`, `0.40`, `0.60`, `0.80`, and `1.00` rendered the V2 canvas with an exact matching QA value, fitted navigation, and no horizontal overflow.

## Approved spatial-scroll refinement

Date: 2026-07-18

- Replaced the document-height scroll track and midpoint recentering with a viewport-locked virtual scroll controller. Mouse-wheel input now advances and reverses the scene while `window.scrollY` remains `0` and the document remains exactly one viewport high.
- Added bounded wheel/touch inertia and keyboard progression. The deterministic `?qa=1&progress=` states bypass inertia so visual captures are exact and repeatable.
- Reworked the rail into a curved, varied spatial field while retaining one coherent panel orientation. Scale, depth softness, focal opacity, and back-to-front ordering now produce a stronger camera-depth hierarchy.
- Preserved source aspect ratios and added depth-aware shader blur rather than flattening the field into ordinary cards or CSS shadows.
- Browser input proof at the local production route: a `+600` wheel gesture changed scene progress from `0.00000` to `1.31667`; a `-600` gesture returned it to `0.00000`. During both gestures, `window.scrollY` stayed `0`, the document height stayed equal to the viewport, and the Browser console remained clean.
- Captured 24 settled deterministic states at `1440 x 900`, `1280 x 800`, `1024 x 768`, and `390 x 844`, for progress `0.00`, `0.20`, `0.40`, `0.60`, `0.80`, and `1.00`. Evidence is stored outside the repository at `E:\Temp\material-collager-virtual-scroll-qa`.
- Automated verification: Scene Lab tests passed (`18/18`), lint passed, and the production build passed. The build retains the existing non-blocking large-chunk warning.
- Remaining fidelity work: the Library currently repeats a small local material-fixture set, so its image variety and long-range density remain below the live Unveil reference. Viewer/selection transitions were intentionally excluded from this approved slice.
- Opera GX Computer Use acceptance passed on the local production route. A forward `+600` mouse-wheel gesture visibly advanced the spatial field, a reverse `-600` gesture moved it back toward the starting composition, and the fixed navigation remained usable throughout.
- The `GENERATOR` navigation control was clicked in Opera GX and successfully opened the complete `/generator` workspace with its setup rail, reference tray, and review region intact.
- The Opera Browser Connector remained unavailable because its `Allow AI connection` switch is disabled; this did not affect the direct Opera GX Computer Use acceptance evidence.
- Deployment did not occur. The refined local build is approved for the completed scroll/navigation slice and remains ready for the user's deployment decision.

## Approved Library asset sync

Date: 2026-07-19

- Mirrored the eight approved release collages from the current hosted Library into `public/release-library`.
- The Library API now returns those approved records when a fresh local D1/R2 workspace has no persisted completed outputs. Persisted generation records still take precedence when present.
- Browser verification at the local Library route confirmed all eight distinct package titles render in the spatial field, repeated only as presentation instances to fill the 20-panel rail.
- Browser DOM verification passed. Browser screenshot capture timed out twice in the current browser session, so no new PNG capture was saved for this sync.

## Panel-path perpendicularity correction

Date: 2026-07-18

- Removed the camera-facing normal blend that left each panel approximately `110–120°` off the intended relationship to the travel path.
- The initial world-space correction was superseded: perspective made its apparent panel/path angle visibly wrong even though its 3D vectors were aligned.
- Each panel now solves its face normal from the rail tangent after projection through the active camera. That makes the panel surface perpendicular to the visible path of travel, which is the reference criterion.
- Added a regression assertion requiring the camera-projected panel normal and camera-projected travel tangent to be parallel within `1e-6`; this is the direct numerical proof for the apparent `90°` panel/path angle.
- Desktop Browser check at `1440 × 900`, deterministic progress `.40`: the corrected field rendered with no console warnings or errors.
