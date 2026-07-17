# Material Collager landing reference specification

Status: reference audit complete; implementation not started

Audit date: 2026-07-12 (America/Chicago)

Canonical Browser session: `unveil-live-iab-20260712-224258-cdt`

This document is a measurement and behavior specification. It does not authorize implementation, asset copying, font copying, or deployment. Where the available evidence cannot prove a behavior, the text says so and defines an accessibility contract rather than presenting a guess as reference fact.

## 1. Reference evidence

### Evidence precedence and files inspected

The audit follows `AGENTS.md`: recording and extracted frames first, live Browser inspection second, then approved documents/screenshots, then design breakdowns, and finally the current application.

| Evidence | Path or URL | Status and use |
|---|---|---|
| Approved recording | `references/unveil-scroll.mp4` | Inspected; 2494 × 1270, 45.013 s. Primary motion and route-transition evidence. |
| Extracted sequence | `references/video-frames/` | Inspected; 90 ordered frames. Used for motion, selection, detail, return, and Index sequence. |
| Recording sheet | `artifacts/reference-audit/unveil-recording-2494x1270-frame-sequence-contact-sheet.png` | Inspected; one labeled view of all 90 frames. Not a normalized p00–p100 sheet. |
| Live URL | `https://unveil.fr/?ref=siteinspire` | Opened in the in-app Browser. Title remained `UNVEIL®`. |
| Canonical live desktop | `artifacts/reference-audit/unveil-live-1440x900-progress-contact-sheet.png` | Six captured visual anchors: p00, p20, p40, p60, p80, p100. Labels are implementation-assigned, not measured reference progress. |
| Canonical live compact desktop | `artifacts/reference-audit/unveil-live-1280x800-progress-contact-sheet.png` | Six states, same page load and ordering. |
| Canonical live tablet | `artifacts/reference-audit/unveil-live-1024x768-progress-contact-sheet.png` | Six states, same page load and ordering. |
| Canonical live mobile | `artifacts/reference-audit/unveil-live-390x844-progress-contact-sheet.png` | Six states, same page load and ordering. |
| Raw Browser captures | `artifacts/reference-audit/raw/unveil-live-iab-20260712-224258-cdt/` | 24 PNGs; source for screen-space geometry and informational color measurements. |
| Capture provenance | `artifacts/reference-audit/contact-sheet-manifest.md` | One page load, zero refreshes, one project order across all four viewports. |
| Active-source allowlist | `artifacts/reference-audit/active-sources.json` | Explicit paths for every canonical sheet, raw capture, recording, frame, and labeled recording sheet. QA scripts must use this allowlist and must not glob archive/duplicate PNGs. |
| Geometry annotations | `artifacts/reference-audit/reference-geometry.json` | Full materially-visible field polygons for all 24 viewport/anchor states: 10 planes at each desktop state, 9 at tablet, and 8 at mobile. Includes stable `track_id`, per-anchor role, pixel-space aspect measurements, tolerances, uncertainty, and no world-coordinate claim. |
| Geometry overlays | `artifacts/reference-audit/geometry-overlays/` | 24 raw-image overlays plus four viewport review sheets. Every state was visually reviewed before the geometry data was locked. |
| Audit validator | `artifacts/reference-audit/validate_reference_audit.py` | Fails on incomplete states, broken track continuity, invalid focal/edge/aspect data, uncertainty above tolerance, or a non-allowlisted QA source. |
| Current landing | `references/screenshots/current-landing.png` | 2048 × 1043 failure baseline. |
| Current generator | `references/screenshots/current-generator.png` | 2048 × 1040 failure baseline only; generator is outside this landing slice. |
| Pre-scene-lab regression baseline | `docs/pre-scene-lab-regression-baseline.md` and `artifacts/pre-scene-lab-baseline/` | Captures unchanged `/`, `/generator`, routes, build, tests, console state, and Generator smoke behavior before dependency/application changes. |
| Design breakdowns | `references/design-breakdowns/` | Inspected as supporting, lower-priority evidence. |

The canonical live capture sequence was made in one uninterrupted Browser page instance. The scene was advanced at 1440 × 900, then the exact settled visual state was resized to 1280 × 800, 1024 × 768, and 390 × 844 without refresh. The labels p00, p20, p40, p60, p80, and p100 identify six captured visual anchors only. They are not proven equal normalized increments of the reference's internal scene progress. The future deterministic QA values `0.00…1.00` are implementation-assigned addresses for reproducing those anchors. Corresponding states preserve slot/role sequence and render order across viewports; they do not require Material Collager to reproduce Unveil project identities. Legacy and duplicate sheets are archived comparison evidence and are not active cross-viewport sources.

### Browser rendering and computed-style evidence

- The spatial field is one full-viewport `<canvas>` with a WebGL context. It is not a DOM card stack, CSS 3D composition, `<img>` list, video, or SVG scene.
- Fixed navigation and overlays are semantic DOM. The experience is therefore a WebGL + DOM hybrid.
- `html` and `body` are viewport-sized with native scrolling disabled. Input advances virtual scene state.
- The live application was Svelte-based. That framework is evidence about the reference only and does not constrain the local React implementation.
- Browser inspection observed 250 loaded resources: 226 images, 21 scripts, one stylesheet, one font, and one other resource.
- The loaded font file was `nbinternationalproreg-webfont.woff2`; the computed family was NB International Pro Regular, weight 400.
- The canvas exposed WebGL context lifecycle listeners. No relevant console errors appeared during the 24 canonical captures.
- The initial DOM and computed-style inspection was available. WebGL internal buffers, shader source, exact world coordinates, exact camera focal length, and licensed source assets were not available. Those values below are screen-space measurements or bounded estimates, not extracted source constants.

## 2. Current-build failure audit

### Landing failure

The current `/` route is a conventional Material Collager library: a title row, a horizontally scrolling set of bordered panels, metadata, and an item viewer. It fails the approved reference for structural reasons:

- it uses a bounded horizontal track rather than a fixed full-viewport diagonal depth field;
- it shows one dominant card row rather than 8–12 overlapping camera-space planes;
- depth is represented by CSS offsets and opacity, not perspective, z progression, crop, and depth softness;
- wheel input remaps to horizontal DOM scroll and card centering rather than inertial bidirectional virtual progress;
- the header, view toggle, typography, colors, radii, and negative space do not match the measured chrome;
- it lacks the continuous panel selection-to-centered-project-to-detail transition shown in the recording;
- it uses Geist/system fallback, not the measured NB International Pro Regular;
- it has no deterministic named-anchor scene state such as `/scene-lab?qa=1&anchor=p00`.

This cannot be repaired by styling the existing `.glass-track` as cards. The landing route needs a dedicated scene layer while preserving its data requirements and accessible project destinations.

### Generator failure and scope boundary

The current generator screenshot does not match the Unveil art direction: it is dense, grid-heavy, and dominated by repeated one-pixel boxes, small labels, native-looking controls, and undifferentiated action weights. Its preview is visually secondary and the full-screen workspace hierarchy is weak.

That finding does **not** authorize a generator redesign in the landing implementation. `app/generator/page.tsx` contains substantial upload, reference analysis, draft persistence, generation, selective repair, QA, history, and download behavior. It and all API/data files remain unchanged during the landing vertical slice. A separate approved generator concept and regression inventory are required first.

## 3. Composition map

### Fixed regions and scene coverage

1. **Scene:** x 0, y 0, 100vw × 100vh, background `#fafafa`, canvas z-index measured as 1.
2. **Header:** observed computed height 66.016 px and cell height 58.016 px, fixed x 0/y 0 with a 4 px outer inset. Practical implementation tokens are 66 px and 58 px with the existing tolerances.
3. **Overview/Index:** observed computed size 142.266 × 40 px, fixed 4 px from right and bottom. Practical implementation token is 142 × 40 px.
4. **Contact reference treatment:** the reference contains a full-viewport translucent/blurred overlay, but Contact is not part of the initial Material Collager `/scene-lab` unless separately approved.
5. **Panel field:** unconstrained by a DOM container. Crops at all viewport edges and may pass behind the fixed chrome.

Primary fidelity gates use geometric scene coverage, measured from projected plane polygons rather than texture luminance:

- union coverage of projected plane polygons as a percentage of the comparison region;
- union field bounding box;
- focal plane bounds;
- area-weighted geometric centroid of projected polygons;
- number of projected polygon edges intersecting each viewport edge; and
- pairwise overlap ratio, expressed against the smaller projected plane.

The implementation must export or otherwise expose projected corner coordinates in deterministic QA mode so these metrics can be computed independent of texture tone. The earlier luminance/color occupancy measurements are preserved below as informational observations only. They are not pass/fail gates because Material Collager textures have different tonal distributions.

The union, bounding-box, centroid, edge-intersection, overlap, and density reference metrics use every materially visible polygon in `reference-geometry.json`, not a six-plane core subset. Each travelling plane has a stable `track_id`; `role` is reassigned at each anchor as that track advances through far, mid, adjacent, focal, and near positions. Track continuity therefore interpolates travelling planes, not static role slots. The annotations are screenshot-space acceptance data, not reconstructed camera/world coordinates.

| Viewport | p00 | p20 | p40 | p60 | p80 | p100 | Range | Color-derived centroid range (x, y) |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| 1440 × 900 | 46.0% | 47.2% | 46.1% | 49.2% | 48.2% | 47.3% | 46.0–49.2% | x 47.6–49.4%, y 54.1–56.5% |
| 1280 × 800 | 45.6% | 46.8% | 45.7% | 48.8% | 47.8% | 46.9% | 45.6–48.8% | x 47.3–49.1%, y 54.5–56.9% |
| 1024 × 768 | 53.3% | 54.5% | 53.4% | 55.9% | 55.4% | 53.9% | 53.3–55.9% | x 47.6–50.3%, y 53.7–55.6% |
| 390 × 844 | 53.8% | 57.1% | 55.5% | 54.1% | 55.7% | 54.5% | 53.8–57.1% | x 48.1–54.1%, y 53.0–55.8% |

These color-derived values remain useful as diagnostics only. The geometric field bounding box reaches both horizontal edges and the bottom edge at every canonical anchor. This edge crop is intentional. The upper scene begins directly below or behind the 66 px practical header token, while approximately 35–45% of desktop width remains low-density negative space at any one depth slice.

### Spatial composition

- Desktop path: approximately `(0.05w, 1.12h)` near/front → `(0.50w, 0.57h)` focal → `(0.96w, -0.12h)` far/back.
- Mobile path: approximately `(-0.18w, 1.10h)` → `(0.52w, 0.58h)` → `(1.20w, -0.10h)`. The same track is cropped by the narrower viewport; it is not replaced by a vertical list.
- The locked full-field annotation contains 10 materially visible planes per desktop/compact-desktop state, 9 per tablet state, and 8 per mobile state. Four planes are marked dominant and exactly one is the focal designation in every state. Visual source counts may still read approximately 8–12 desktop, 8–11 tablet, and 6–9 mobile because translucent edge fragments can merge.
- Source aspect is preserved. Observed visible plane ratios span approximately 0.62–0.82 portrait, 0.90–1.10 square/near-square, and 1.25–1.75 landscape.
- Planes have square texture edges, no card shell, no radius, no caption container, and no box shadow.
- Foreground planes overlap the next 1–3 planes by roughly 18–55% of the smaller plane's projected area. Far planes overlap more tightly because of perspective compression.

### Approved geometry amendment — parallel world-space frames

Approved 2026-07-16 after direct comparison of the recording, live reference, and current implementation.

- Overview panels are one family of very thin world-space frames with a shared orientation. Their surface normals remain parallel and align with the near/far direction of the row while the camera/field advances through depth. Do not billboard panels toward the camera, independently keyframe panel orientation, or reconstruct the overview by deforming four screen-space corners.
- Mild differences in projected edge angle come from perspective and each frame's world position, not independent per-panel yaw. The earlier yaw ranges are screen-space observations, not permission to assign unrelated rotations. A selected frame may interpolate away from the shared row-facing orientation only after selection begins. During extraction it moves out of the row and rotates toward a camera-facing, upright presentation; no unselected, hovered, or merely focal frame may perform that turn.
- Use a perspective camera and meaningful world-space z separation. Scroll changes the relative camera/field transform so near frames exhibit stronger parallax and scale change than far frames.
- Frames have a restrained physical edge. At 1440 × 900 the visible side treatment should normally read as approximately 1–3 CSS pixels at oblique edges, without a card shell, radius, drop shadow, or decorative border.
- Every frame inherits its texture's decoded intrinsic aspect ratio. World geometry must satisfy `frameWidth / frameHeight = sourceWidth / sourceHeight`; placement scale multiplies both dimensions uniformly.
- Use the complete source UV domain for Overview. Do not crop, stretch, or resample a texture to match a slot. Aspect classes remain placement hints only. Composition corrections must change world position, spacing, camera parameters, or uniform scale. Viewport-edge clipping remains intentional.
- Selection and centered presentation preserve the same intrinsic ratio and contain the complete source image.

Prototype acceptance adds these gates:

- overview panel-normal angular variance no greater than 0.5°;
- world-geometry/source-aspect error no greater than 0.1%;
- complete `[0,1] × [0,1]` source UV coverage;
- visible near/far parallax under one deterministic scroll trace;
- no per-panel camera-facing rotation before selection;
- p00, p40, and p80 at 1440 × 900 approved before expanding to all anchors and responsive viewports.

## 4. Panel geometry and render order

The following table records six captured visual anchors in normalized viewport coordinates. `x` and `y` are top-left; `w` and `h` are projected size. Values outside 0–1 indicate intentional crop. `z-rank 0` is nearest. Rotation is screen-space yaw/roll. Opacity and blur are apparent observations, not measured shader constants. The opacity and blur ranges are initial tuning ranges; acceptance uses the perceived sharpness hierarchy unless a later documented measurement method produces direct values.

This table preserves the original representative observations. The machine-readable full-field source is `artifacts/reference-audit/reference-geometry.json`, whose quadrilateral corners, pixel width/height/aspect, aspect class, stable `track_id`, current role, z rank, focal flag, and edge intersections were checked in 24 raw-image overlays. Normalized-corner uncertainty is 3% at desktop, 4% at tablet, and 6% at mobile. Acceptance is no tighter than that evidence: focal bounds ±4% desktop, ±5% tablet, ±7% mobile; secondary bounds ±6%, ±8%, and ±11%; overlap ±8, ±10, and ±12 percentage points respectively.

| State | Visible / dominant planes | Representative projected planes `(x,y,w,h)` | z progression and render order | Scale / rotation | Opacity / blur / crop |
|---|---|---|---|---|---|
| p00 | 10–12 / 4 | near `(-.04,.62,.27,.46)`; focal `(.10,.54,.27,.47)`; mid `(.27,.38,.23,.43)`; far `(.62,-.02,.18,.38)` | lower-left near 0 → focal -1/-2 → upper-right -5/-7 | near 1.20–1.45; focal 1.00; far .55–.75; yaw -6°→+7°, roll ±2° | near .70–.90/0–1 px; focal .90–1/0 px; far .30–.60/2–4 px; near bottom/left and far top/right crop |
| p20 | 10–12 / 4 | near `(-.02,.69,.31,.44)`; focal `(.16,.49,.28,.45)`; mid `(.43,.34,.23,.48)`; far `(.70,.02,.17,.35)` | incoming far plane remains behind; red/black focal planes cross in front as distance decreases | focal grows ~15–25% from p00; yaw trends toward 0° at focus | focal .88–1; adjacent .60–.82; edge fragments .25–.55; bottom crop increases |
| p40 | 9–12 / 4 | near `(-.03,.73,.28,.40)`; focal `(.13,.55,.27,.40)`; overlap `(.40,.42,.25,.46)`; far `(.76,-.02,.18,.42)` | selected depth is based on camera distance; nearer red/portrait plane occludes black/green planes | focal 1.00–1.18; far .60–.78; yaw within ±3° at focus | focal .92–1/0 px; mid .62–.86/0–2 px; far .35–.62/2–4 px |
| p60 | 9–12 / 4 | near `(-.05,.76,.30,.41)`; focal `(.17,.56,.27,.43)`; mid `(.43,.36,.23,.46)`; far `(.76,-.02,.19,.40)` | previous focal moves to z 0 and exits; next cluster advances -3→-1 | near peaks at 1.25–1.50 before exit; focal yaw near 0°; far +4–7° | near can remain .75–.95 until crop; focal .90–1; far .35–.60 |
| p80 | 9–11 / 4 | near `(-.02,.79,.32,.38)`; focal `(.15,.57,.29,.44)`; overlap `(.42,.42,.24,.46)`; far `(.78,-.04,.18,.39)` | photo/red planes now in front of earlier monochrome sequence; render order remains geometric, not DOM order | focal 1.05–1.25; far .58–.75; roll stays within about ±2° | focal .92–1; mid .65–.85; far .30–.58; strong bottom/left crop |
| p100 | 8–11 / 4 | near `(-.06,.77,.31,.45)`; focal `(.14,.56,.29,.46)`; overlap `(.45,.44,.24,.43)`; far `(.79,-.05,.19,.41)` | next project sequence is already visible upper-right; last listed foreground plane draws/composites in front | scale profile repeats rather than flattening at an endpoint | same depth opacity profile; no end-card, pagination, or snap is visible |

At 390 × 844, multiply the track crop rather than the world plane scale: focal planes project to approximately 0.46–0.78w and 0.30–0.62h; a plane may show only 15–35% of its area at an edge. Desktop focal planes project to approximately 0.18–0.32w and 0.38–0.68h. The larger mobile width fraction is necessary to preserve the reference's density.

Render order contract:

1. Opaque/near-opaque focal plane at the nearest camera distance.
2. Adjacent focal plane(s), ordered by camera z and allowed to overlap the nearest plane.
3. Mid-depth translucent planes.
4. Far softened planes.
5. `#fafafa` clear color.
6. DOM toggle and overlays above canvas; fixed header above all overview content.

Do not sort by project array index alone. Transparent textures must use stable depth-aware ordering to avoid flicker during crossings.

Material Collager matching is by **slot and scene role**, not Unveil project identity. At each anchor, match each role by aspect class, projected size, depth role, overlap relationship, crop edge, and sequence position. Texture subject, label, and project identity are intentionally different.

## 5. Motion and interaction model

### Implementation-assigned anchor progress and damping

The live overview is a continuous virtual track, not native document scroll and not a six-stop carousel. The six `p` labels identify captured visual anchors within one reproducible segment; they do not prove equal increments of the reference's internal progress. Canonical evidence uses exactly these URLs:

- `/scene-lab?qa=1&anchor=p00`
- `/scene-lab?qa=1&anchor=p20`
- `/scene-lab?qa=1&anchor=p40`
- `/scene-lab?qa=1&anchor=p60`
- `/scene-lab?qa=1&anchor=p80`
- `/scene-lab?qa=1&anchor=p100`

An optional arbitrary development control may use `progress=`, but it is not canonical screenshot evidence. Interpolation between anchors is a local implementation choice tuned against the recording.

- Positive input moves planes from upper-right/back toward lower-left/front. Negative input reverses the same path.
- Maintain `targetProgress`, `renderedProgress`, and velocity separately.
- Normalize deltas by viewport height and `WheelEvent.deltaMode`; clamp individual impulses before accumulation.
- Initial tuning only: damping equivalent to `exp(-5…-7 × dt)` and a clamped wheel impulse in the 400–700 CSS px range. The reference did not expose its constants; tune these ranges with a documented input trace and screen recording.
- No snapping, pagination detent, native scrollbar, native overscroll, or hard scene endpoint was observed in the captured segment. Recommend soft endpoints for the first production release; continuous wrap is a later optional decision.
- Interpolate camera/plane x, y, z, scale, yaw, roll, opacity, and depth softness continuously. Preserve exact image aspect and crop only at texture crop anchors or viewport edges.

### Input and transition behavior matrix

“Observed” means directly supported by Browser/recording evidence. “Required equivalent” is an accessibility contract when the exact reference mapping was not recoverable.

| Input/behavior | Evidence | Required implementation behavior |
|---|---|---|
| Mouse wheel | Observed passive wheel listener and inertial response. Positive delta advances; reverse delta reverses. | Convert vertical or dominant-axis delta to target progress; prevent native page movement only while the scene owns input; retain inertia and no snap. |
| Trackpad | Uses the same wheel event path; the capture set does not identify hardware. | Preserve fine, high-frequency deltas without quantizing to “slides”; normalize delta mode; diagonal gesture uses the dominant axis; do not double-apply browser momentum. |
| Touch | Touch/pointer start/end/cancel listeners observed; exact physical-device trace was unavailable. | One-finger vertical drag feeds the same accumulator. Prevent rubber-band scroll inside the scene. Release retains bounded inertia. Cancel safely clears capture. Treat 8–12 CSS px as an initial tap-suppression tuning range, then document the chosen threshold and test method. |
| Pointer drag | Pointer lifecycle was present; exact reference drag gain is not measurable. | Use the touch contract for coarse pointers. Mouse drag may be supported only if it does not conflict with clicking; cursor and selection threshold must remain clear. |
| Keyboard progress | Keyboard handling was detected, but exact live keys/actions were not recoverable from accessible DOM or captures. | Accessible equivalent: ArrowLeft/ArrowUp move to the previous project with synchronized scene movement; ArrowRight/ArrowDown move to the next; Page Up/Down move multiple projects; Home/End move to the first/last lab position; Enter or Space selects the focused project; Escape cancels selection or closes Index. Space never advances free scene progress while a project control is focused. Use the synchronized semantic DOM collection with roving tabindex. Tab does not automatically switch to Index. Do not claim the key mapping as reference fact. |
| Hover/focus | Titles appear on/near focal project planes in the recording. Canvas content itself has no accessible nodes. | Hover or DOM focus identifies the same plane and produces a visible synchronized plane/title state. Focus must never be canvas-only, and canvas plus DOM must not announce the same item twice. |
| Selection | Recording frames show a chosen plane separating from the field, enlarging, centering, while surrounding planes attenuate. | Tap/click/Enter selects only below movement threshold. Freeze track input, promote the chosen plane, fade/soften surrounding planes, and preserve its texture continuously into the destination. |
| Centering | Selected plane travels to a stable centered presentation before/through detail entry; no snap cut is visible. | Interpolate selected plane to approximately `(0.50w, 0.50h)` visual center, yaw/roll to 0°, full opacity, zero depth blur. Preserve source aspect; contain rather than distort. |
| Detail route transition | Recording frames 25–71 show overview selection, isolated plane, then reference project-detail layouts. | Not required in the initial `/scene-lab`. If later approved for Library integration, use route-aware shared scene state or a transition overlay without copying Unveil labels or detail information architecture. |
| Back/overview return | Later recording frames return to the overview field, then enter Index. | Browser Back and Overview restore the prior virtual progress and project order, then return focus to the originating project link. |
| Index toggle | Fixed Overview/Index control remains available; recording ends in a thumbnail index. | Toggle is a real two-state control. Index is semantic, keyboard navigable, and preserves selection/order. It does not mutate the overview random order. |
| Contact route/overlay | Fixed Contact control and blurred full-viewport layer observed. | Reference evidence only. Contact is excluded from the initial Material Collager `/scene-lab` unless separately approved. |

### Selection state sequence

1. **Idle overview:** input controls virtual progress; a focal candidate can be highlighted.
2. **Commit:** once pointer travel is below threshold or keyboard activates, capture `selectedId`, current progress, camera, and projected bounds.
3. **Separate:** an initial 0–35% tuning range; selected plane moves toward z 0 while surrounding velocity damps and siblings attenuate.
4. **Center:** an initial 35–75% tuning range; selected plane reaches visual center, yaw/roll approach zero, and it becomes the sharpest plane.
5. **Settle:** an initial 75–100% tuning range. In `/scene-lab`, settle remains in place. A later approved Library route may reveal destination DOM and move focus to its heading.
6. **Return:** reverse continuity where feasible, restore saved progress/order, and restore focus.

Exact transition duration, phase percentages, sibling opacity, blur values, damping, wheel impulse, and tap threshold are not directly measured. They are initial tuning ranges until a documented method records an input trace and frame-by-frame response. The recording rejects an abrupt image swap but does not expose exact constants or easing.

### Reduced motion

For `prefers-reduced-motion: reduce`, use a stable representative field with explicit previous/next controls. Disable inertial camera travel, animated blur, and long centering. Selection may cross-fade quickly while preserving route, focus, and project access. This is an accessible alternative, not a change to normal behavior.

## 6. Typography, chrome, and product information architecture

Observed computed values are retained as evidence; practical implementation tokens are rounded for maintainability. The rounded values are the implementation targets and use the previously stated tolerances.

| Token | Measured value | Use/status |
|---|---|---|
| Primary face | NB International Pro Regular | Computed live reference face. |
| Required weight | 400 Regular | Only weight proven on the landing. Do not synthesize bold. |
| Root/body | 16 px / 24 px / 400 | Overlay/body baseline. |
| Nav micro | observed 10.5 px / 11.025 px / 400; implement approximately 10.5 px / 11 px | Header and view control. |
| Alternate micro | 10.5 px / 13 px / 400 | Legal/contact text. |
| Tracking | 0.1575 px | Header/toggle labels. |
| Case | uppercase | Fixed UI chrome. |
| Background | `#fafafa` | Canvas clear and page. |
| Text | `#000000` | Fixed chrome. |
| Chrome outline | black at ~13%, 1 px | Pseudo-element border. |
| Chrome fill | black at ~3% | Pseudo-element fill. |
| Contact overlay | `rgba(255,255,255,.70)` | Reference observation only; excluded from initial scene-lab. |
| Chrome radius | 6 px | Header cells and toggle. |
| Chrome blur | 24 px backdrop blur | Header/toggle. |
| Contact blur | 40 px backdrop / ~8 px transition filter | Contact reveal. |
| Plane radius/shadow | 0 / none | Texture planes. |

Measured chrome geometry:

- outer inset 4 px; observed header total height 66.016 px and cell height 58.016 px; implement 66 px and 58 px;
- cell padding 40 px 10 px 7 px;
- scene-lab desktop/tablet cluster total 580 px: `MATERIAL COLLAGER` 220 px, `LIBRARY` 180 px, `GENERATOR` 180 px;
- at 390 px, usable width inside 4 px insets is 382 px: `MATERIAL COLLAGER` 152 px, `LIBRARY` 115 px, `GENERATOR` 115 px;
- observed toggle 142.266 × 40 px; implement 142 × 40 px. Active/inactive opacity values are initial tuning values unless later measured by a documented alpha-compositing method.

Product information architecture:

- Preserve the measured chrome treatment, proportions, casing, restrained states, and fixed placement, but do not copy Unveil product labels.
- The default Material Collager navigation is `MATERIAL COLLAGER / LIBRARY / GENERATOR` unless another approved product function exists.
- The scene-lab header uses exactly these three cells and widths. If the full brand does not fit without collision at an approved breakpoint, abbreviate only the brand to `MATERIAL COLL.`; keep `LIBRARY` and `GENERATOR` unchanged, preserve the 152 px brand cell, and expose `MATERIAL COLLAGER` as the accessible name/title. No other abbreviation is approved without review.
- Contact is not an initial scene-lab control. Overview/Index naming may become Scene/Index or another approved Material Collager view label without copying Unveil taxonomy.

Font licensing:

- **Identity:** NB International Pro Regular, 400.
- **Licensing status:** proprietary. The font fetched from unveil.fr is inspection evidence and is not licensed for copying. No project-owned license or approved local binary was found.
- **Official foundry/product source:** [Neubau — NB International Pro](https://neubauberlin.com/project/nb-international-pro-e2019/).
- **Official webfont purchase/license source:** [Neubau Laden — NB International Pro CG Edition](https://neubauladen.com/product/nb-international-pro-cg-edition/).
- **Approved implementation substitute:** Inter variable is the current release font. The reference remains NB International Pro Regular, so release QA must verify line wrapping, chrome dimensions, and computed typography at every target viewport.

## 7. Responsive rules

### Desktop: 1280 × 800 and 1440 × 900

- Keep the same diagonal camera track and target the locked 10-plane materially-visible field with four dominant planes; the source may visually read as 8–12 fragments.
- Keep the 580 px header cluster at x/y 4; do not stretch it.
- Use fixed scene-lab widths 220/180/180 px and 58 px cell height.
- Match geometric polygon coverage, field bounding box, focal bounds, centroid, edge intersections, and overlap at every anchor. Color occupancy is informational only.
- Focal plane width is approximately 18–32vw; height approximately 38–68vh.
- Keep the lower-left and upper-right cropping and the desktop low-density negative field.
- DPR may be capped for performance, but edges and texture sampling must remain visually clean at capture size.

### Tablet: 1024 × 768

- Keep the desktop-size 580 px header cluster while it fits.
- Use fixed scene-lab widths 220/180/180 px and 58 px cell height.
- Target the locked 9-plane materially-visible field with four dominant planes; the source may visually read as 8–11 fragments.
- Match the tablet geometric coverage metrics; the narrower crop should increase projected field coverage without relying on texture luminance.
- Tighten projected x spacing, not source aspect. Do not collapse into cards or a horizontal strip.
- Touch and keyboard equivalents must be available even when a mouse is present.

### Mobile: 390 × 844

- The three Material Collager cells fill 382 px inside 4 px insets: 152/115/115 px, with 58 px height. Apply the approved `MATERIAL COLL.` abbreviation rule only if the full brand collides; do not copy the `UNVEIL®` label.
- Keep the practical 142 × 40 px view control at right/bottom 4 px when that control is present.
- Target the locked 8-plane materially-visible field with four dominant planes; the source may visually read as 6–9 fragments. Focal widths are 46–78vw.
- Match geometric field and focal centroids from projected polygons; retain the color-derived centroid only as an informational diagnostic.
- Preserve severe side and bottom crops. Do not shrink all planes merely to fit.
- Normalize drag gain by viewport height. Respect safe-area insets without moving the measured 4 px visual inset on devices that do not require one.
- Minimum interactive DOM target size is 44 × 44 CSS px even where the visible label is smaller.

## 8. Asset inventory

### Required local/approved assets

- `references/assets/` currently contains 58 candidate Material Collager assets. They are available for isolated scene-lab texture and geometry experiments only.
- The final public subset, stable order, titles, routes, crop anchors, alt text, and rights confirmation remain pending.
- Per selected public asset: stable id, intrinsic dimensions, aspect class, crop anchor, sequence index, product title, route slug if applicable, alt text, and explicit public-use approval.
- Two texture tiers: small blurred placeholder and display texture. Do not load every local original at full resolution.
- The approved Inter variable WOFF2 files and SIL Open Font License record satisfy the font-binary/license input. Release computed-style and visual-metric evidence remains required.
- Text-native Material Collager wordmark/chrome labels; no raster logo is required by the reference.
- Semantic DOM project links synchronized with canvas planes.

### Inspection-only assets

The 226 image requests and Unveil-hosted font file prove rendering behavior and typography. They are not reusable project assets. Do not hotlink or copy Unveil imagery, code, or font binaries.

### Missing approvals

1. Selection of the public subset from the 58 candidates, stable order, Material Collager titles, routes, crop anchors, alt text, and rights confirmation. This does not block isolated `/scene-lab`; it blocks Library integration, production acceptance, and deployment.
2. Release-candidate computed-style and viewport evidence for the approved Inter substitute. The binary/license decision is resolved; final metric acceptance remains open.
3. Approved project-detail destinations and content only if a later Library-integration phase includes the recording's detail-transition behavior.

## 9. Architecture decision

**Choose React Three Fiber / Three.js for the panel field, with semantic React DOM chrome and navigation.**

Before scene construction, run an isolated client-only R3F/Vinext compatibility spike at `/scene-lab` containing one unlit texture plane. It must verify: no SSR/`window` error, no hydration mismatch, no duplicate Three instance, no Vite dependency-optimization failure, working navigation and hot reload, and a passing `npm run build`. The spike must not modify production routes. If R3F is unstable after the documented spike, retain the WebGL architecture and fall back to direct Three.js; do not migrate frameworks or production routes as a workaround.

Evidence supporting this decision:

- the reference field is a full-viewport WebGL canvas;
- the recording depends on camera-space z, perspective scale, transparent plane overlap, depth softness, and continuous compositing;
- the panel field is absent from the accessible DOM while fixed controls are semantic;
- native document scrolling is disabled and input drives scene state;
- deterministic capture requires direct control over camera/plane interpolation.

DOM + CSS 3D is rejected for the field because a large continuously moving transparent texture stack would have less predictable depth sorting, crop, and depth softness, and would diverge from the observed renderer. Plain Three.js would work, but React Three Fiber better integrates resource lifetime, route state, and React 19 without changing the underlying WebGL model. DOM remains mandatory for product chrome, view controls, loading state, accessible equivalents, focus management, and reduced-motion mode. Contact is not required in the initial scene-lab.

WebGL rendering contract:

- Decode textures into sRGB color space and render to an sRGB output target; verify no unintended image color shift against the source asset.
- Use unlit image materials unless later evidence demonstrates lighting on the reference planes.
- Use an explicit tone-mapping policy: start with no tone mapping for image planes; any alternative requires before/after source-color evidence.
- Decide and document premultiplied alpha at renderer/material/texture boundaries; do not mix conventions.
- Document `depthWrite`/`depthTest` per plane class. Default to `depthTest: true`; choose `depthWrite` deliberately so transparent crossings do not punch holes.
- Use stable transparent sorting based on depth role and camera distance, with deterministic tie-breakers.
- Set anisotropy to the supported device maximum capped by a documented performance limit; validate oblique texture sharpness.
- Dispose textures, materials, and transient render targets when assets leave the active window or the scene unmounts.
- Handle UV crop anchors in shader/material sampling without changing source aspect or resampling the source into a distorted plane.
- Use mipmaps and filtering appropriate to the projected size; preserve the perceived hierarchy: focal sharp, adjacent slightly softened, distant softened.

Introduce a custom shader only if comparison proves standard unlit materials cannot reproduce depth softness or alpha. Do not add shader distortion or lighting without evidence.

Accessible DOM-equivalent model (approved):

- The canvas is `aria-hidden="true"` and is never an announcement source.
- One synchronized semantic DOM project collection is the sole announcement source.
- The collection uses roving tabindex: one project is in the tab order at a time, and arrow-key progress/focus updates the active item.
- Keyboard focus produces a visible synchronized active plane/title.
- Pointer, hover, DOM focus, and Index share one active id.
- Index remains explicitly user-selected. Tab or keyboard focus must not automatically switch views.
- Do not duplicate canvas and DOM announcements.

## 10. Implementation plan summary

The detailed staged plan and exact future files are in `docs/implementation-plan.md`. The first implementation action is the isolated R3F/Vinext compatibility spike; scene construction begins only after it passes or direct Three.js is selected from documented spike evidence. The isolated `/scene-lab` stage will:

1. preserve all generator behavior and API/data code;
2. leave `app/page.tsx` and production Library behavior unchanged;
3. add spatial planes, deterministic implementation-assigned anchors, responsive layouts, wheel/trackpad/touch/keyboard progress, hover/focus, selection, centering, sibling attenuation, accessible DOM equivalents, and reduced motion at `/scene-lab`;
4. load only textures near the active camera window and dispose them on exit;
5. capture all 24 required local states and record discrepancies in `docs/visual-qa.md` before approval;
6. avoid production routing, Contact, final project details, draft restoration, generator redesign, deployment, or asset/font copying.

## 11. Acceptance rubric

### Visual

- Capture 1440 × 900, 1280 × 800, 1024 × 768, and 390 × 844 using exactly `/scene-lab?qa=1&anchor=p00`, `/scene-lab?qa=1&anchor=p20`, `/scene-lab?qa=1&anchor=p40`, `/scene-lab?qa=1&anchor=p60`, `/scene-lab?qa=1&anchor=p80`, and `/scene-lab?qa=1&anchor=p100`. `progress=` is optional development-only input and cannot produce canonical screenshot evidence.
- Fixed chrome bounds: ±3 px desktop/tablet, ±2 px mobile.
- Header geometry: desktop/tablet 580 px total with 220/180/180 px cells; mobile 382 px total with 152/115/115 px cells; 58 px height and 4 px outer inset.
- Primary geometry gates: projected polygon union coverage, field bounding box, focal bounds, geometric centroid, viewport-edge intersection counts, and pairwise overlap ratio. The QA report must record the extraction method and reference/local values.
- Color/luminance occupancy is informational only and cannot fail a Material Collager texture comparison by itself.
- Dominant plane count exact; all visible fragments within ±1.
- Focal plane bounds within ±4% at 1440/1280, ±5% at 1024, and ±7% at 390. Secondary bounds use the wider ±6%/±8%/±11% viewport-specific tolerances. Pairwise overlap uses at least ±8/±10/±12 percentage points respectively. Annotation uncertainty (3%/4%/6%) must never exceed the applicable tolerance.
- Match slots/roles by aspect class, projected size, depth role, overlap, crop edge, and sequence position. Do not require matching Unveil project identity.
- Focal overlap and front-to-back order exact; no transparent-sort flicker.
- Focal rotation within ±1.5°; far rotation within ±3°.
- Opacity and blur begin as tuning ranges. Accept perceived sharpness hierarchy—focal sharp, adjacent slightly softened, distant softened—plus stable ordering; only enforce numeric values after a documented direct measurement method exists.
- Aspect ratio error below 0.5%; no unintended stretch. Required edge crop direction must match every state.
- Scene-lab may use the labeled fallback. Final typography acceptance requires licensed/approved font family; practical nav size is approximately 10.5 px with existing metric tolerances.

### Interaction

- Wheel and trackpad are continuous, bidirectional, non-snapping, and tuned from recorded input/response evidence; damping and impulse remain initial ranges until that method is documented.
- Touch direction matches wheel, release inertia is bounded, cancellation is safe, and the chosen tap threshold is documented and tested; 8–12 px is the initial tuning range.
- Every scene-lab item is reachable by keyboard and screen reader through the chosen synchronized DOM model.
- Scene-lab selection preserves the chosen image through separation, centering, sibling attenuation, and settle; no route is required initially.
- Visible keyboard focus in the roving semantic DOM collection is synchronized with the active plane/title. Index changes only through its explicit user control, and no announcement is duplicated.
- Reduced-motion mode removes continuous/inertial motion while preserving scene-lab content and controls.

### Performance

- No missing texture, failed configured fallback font, WebGL context, hydration, or uncaught console errors. The absent licensed final font is not a scene-lab runtime error.
- Desktop condition: current stable Chromium through Browser, Windows 11, 1440 × 900 CSS viewport, device scale factor 1, hardware acceleration on, AC power, no CPU/network throttle, warm texture cache after one complete load, 10 seconds of continuous scripted progress, three runs; record browser/GPU/CPU identifiers with results. Target 95th-percentile frame time ≤20 ms.
- Constrained mobile-emulation condition: current stable Chromium, 390 × 844 CSS viewport, device scale factor 2, renderer DPR capped at 1.25, 4× CPU slowdown, 150 ms RTT, 1.6 Mbps download/750 Kbps upload, cold initial load followed by a 10-second warm-cache scripted progress run, three runs; record exact emulation/CDP settings. Target 95th-percentile frame time ≤33 ms. Physical-device acceptance remains separate.
- No interaction long task over 100 ms; no unbounded texture growth across ten selection/reset cycles in the lab and later route/return cycles in production.
- Initial scene-lab transfer excludes full-resolution originals and loads only the first visible texture window.

### Accessibility and responsive

- Logical tab order, visible focus, real buttons/links, correct names/states, 44 × 44 CSS px targets, and no keyboard trap.
- Canvas is `aria-hidden="true"`; the synchronized semantic DOM collection is the sole project announcement/navigation source and uses roving tabindex.
- Contrast meets WCAG 2.2 AA for functional DOM labels/states; forced-colors mode retains controls.
- No native page scroll leak, horizontal overflow, chrome collision, or safe-area obstruction at any required viewport.
- Generator routes and behavior remain unchanged and pass their regression inventory.

### Automatic rejection

Reject `/scene-lab` for any high-severity mismatch in geometric composition, crop, z-order, fixed chrome treatment, motion direction, responsive behavior, selection continuity, or accessibility. Do not reject the isolated lab solely for the approved substitute differing from the reference face, pending public asset rights, absent Contact, production routing, final details, or draft restoration. Those become blockers at their later phase gates. Production integration/deployment is rejected for missing font evidence or unlicensed assets, unresolved product IA, modified generator functionality, or deployment before local approval.

## 12. Open questions

1. Which Material Collager images are approved for public use, in what stable order, with what titles, routes, and crop anchors?
2. Does the approved Inter substitute preserve the required line wrapping and chrome geometry in release-candidate captures?
3. After `/scene-lab` approval, should Library integration include a project detail route and shared-image transition?
4. Soft endpoints are recommended for the first production release. Should continuous wrap be explored later as an optional enhancement?
5. Is Contact a future approved Material Collager function? It is not part of the initial scene-lab.
6. Which iPhone model will be used, and which borrowed or cloud-hosted real Android device will close the Android gate?

No application code or scene should be created until this specification is approved.
