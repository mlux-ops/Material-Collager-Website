# Scene-lab visual QA

Status: isolated completed-collage scene-lab S0/S1 evidence complete on 2026-07-13

Scope: isolated `/scene-lab` only. Library integration and deployment were not performed.

Current evidence note: all 24 canonical screenshots and projected-corner exports were recaptured through Browser against the built worker after the completed-collage correction and preview optimization. `artifacts/visual-qa/scene-lab/canonical-console.json` records zero warnings and zero errors for the capture run.

## Evidence policy

- Canonical reference paths were resolved only from `artifacts/reference-audit/active-sources.json`.
- No reference-audit PNG globbing was used.
- Implementation screenshots and projected-corner exports are in `artifacts/visual-qa/scene-lab/`.
- Top-level planes are completed finish collages only. Individual references, material samples, fixture images, analysis images, and source assets are excluded from the scene catalog.
- No Unveil image, font, label, code, or project identity was copied or hotlinked.
- ImageGen was not used.
- Canonical URLs are `/scene-lab?qa=1&anchor=p00`, `p20`, `p40`, `p60`, `p80`, and `p100`.

## Completed-collage content model

- Production Library records come from `GET /api/library`, which reads completed, visible `generation_jobs` rows with a non-null `output_key`. The API supplies the stable collage `id`, `title`, existing generation metadata, and `imageUrl`.
- Each persisted collage preview uses the API-provided `imageUrl` field (`/api/library/{id}/image`), backed by that record's existing `output_key` object. The lab does not read or create a parallel collage database.
- The current Library payload exposes no separate project/detail route. Scene items therefore retain the existing Library association at `/`; no route or project ID was invented.
- The local Library returned zero persisted completed collage records during this QA run.
- With no persisted records available, the isolated lab uses four completed collages supplied directly by the user under `public/scene-lab/collages/`. They are a deterministic temporary lab manifest, not a parallel database. Scene rendering uses 1600 px WebP preview derivatives of the same four collages; the original user-supplied PNG copies remain source-quality lab assets.
- The four stable collage IDs are `user-finish-collage-01` through `user-finish-collage-04`, ordered exactly as supplied. Each repeats five times across the 20 geometry tracks and is explicitly identified as a repeated lab instance; repeated instances are not represented as different real collages.
- QA exports distinguish four available completed collages from zero persisted Library records through `actualCollageCount` and `persistedCollageCount`.
- The 20 temporary copied reference textures formerly under `public/scene-lab/assets/` were removed.
- Canonical projected-corner exports now include `collageId`, `instanceId`, actual collage count, catalog source, repetition status, and unique collage IDs.

## Renderer and deterministic-QA contract

- Full-viewport `#fafafa` R3F/WebGL field with orthographic pixel-space projection.
- Unlit `MeshBasicMaterial`; explicit sRGB textures/output; `NoToneMapping`; opaque renderer with `premultipliedAlpha: false`.
- Transparent planes use `depthTest: true`, `depthWrite: false`, and stable `renderOrder` derived from locked `z_rank` and stable `track_id`.
- UV cover cropping uses per-track deterministic crop anchors. Repeated lab instances share one texture per collage URL; catalogs with more than ten distinct URLs retain moving-window disposal. Textures and fallback textures are disposed at lifecycle boundaries and restored after WebGL context recovery.
- Canonical QA freezes progress and inertia, uses deterministic ordering/crops/geometry, and exports normalized and pixel projected corners, role, opacity, z-rank, edge intersections, policies, performance telemetry, and a stable geometry hash.
- Reload checks at p40 produced identical hashes twice at every viewport: `1a2500eb`, `497e5ce7`, `11f9f559`, and `6b92711c`.

## Metric conventions

- `coverage` is the rasterized union of all materially visible projected polygons divided by viewport area.
- `field` and `focal` are normalized bounds in `left,top,right,bottom` order.
- `centroid` is the area-weighted centroid of the polygon union.
- `edges` is the union of locked viewport-edge intersection metadata.
- `overlap` reports maximum and mean pairwise intersection area divided by the smaller polygon area.
- `tracks exact` means plane count, `track_id`, role, z-rank, corners, and edge metadata exactly match the approved `reference-geometry.json` fixture. The coverage, field, focal, centroid, edge, and overlap values below are fixture-conformance measurements, not an independent remeasurement of the reference pixels.
- Every canonical capture had zero Browser console errors and zero warnings. `performance pass` refers to the measured gates below.

## 1440 × 900

| Anchor | Reference path | Implementation / geometry | Coverage | Field | Focal | Centroid | Edges | Overlap | Planes / continuity | Visual, correction, remaining | Console / performance |
|---|---|---|---:|---|---|---|---|---|---|---|---|
| p00 | `artifacts/reference-audit/raw/unveil-live-iab-20260712-224258-cdt/1440x900-p00.png` | `artifacts/visual-qa/scene-lab/1440x900-p00.png`; `1440x900-p00-geometry.json` | 28.24% | 0.000,0.000,0.940,1.000 | 0.169,0.395,0.371,0.845 | 0.395,0.524 | bottom+left+top | max .775 / mean .053 | 10; tracks exact | D1 / C1 / R1 | 0/0; performance pass |
| p20 | `artifacts/reference-audit/raw/unveil-live-iab-20260712-224258-cdt/1440x900-p20.png` | `artifacts/visual-qa/scene-lab/1440x900-p20.png`; `1440x900-p20-geometry.json` | 28.71% | 0.000,0.000,0.944,1.000 | 0.161,0.433,0.403,0.820 | 0.402,0.534 | bottom+left+top | max .789 / mean .054 | 10; tracks exact | D1 / C1 / R1 | 0/0; performance pass |
| p40 | `artifacts/reference-audit/raw/unveil-live-iab-20260712-224258-cdt/1440x900-p40.png` | `artifacts/visual-qa/scene-lab/1440x900-p40.png`; `1440x900-p40-geometry.json` | 28.17% | 0.000,0.000,0.934,1.000 | 0.163,0.391,0.365,0.841 | 0.390,0.521 | bottom+left+top | max .732 / mean .052 | 10; tracks exact | D1 / C1 / R1 | 0/0; performance pass |
| p60 | `artifacts/reference-audit/raw/unveil-live-iab-20260712-224258-cdt/1440x900-p60.png` | `artifacts/visual-qa/scene-lab/1440x900-p60.png`; `1440x900-p60-geometry.json` | 28.59% | 0.000,0.000,0.941,1.000 | 0.157,0.437,0.399,0.824 | 0.401,0.536 | bottom+left+top | max .802 / mean .054 | 10; tracks exact | D1 / C1 / R1 | 0/0; performance pass |
| p80 | `artifacts/reference-audit/raw/unveil-live-iab-20260712-224258-cdt/1440x900-p80.png` | `artifacts/visual-qa/scene-lab/1440x900-p80.png`; `1440x900-p80-geometry.json` | 28.42% | 0.000,0.000,0.940,1.000 | 0.169,0.409,0.371,0.859 | 0.397,0.536 | bottom+left+top | max .787 / mean .053 | 10; tracks exact | D1 / C1 / R1 | 0/0; performance pass |
| p100 | `artifacts/reference-audit/raw/unveil-live-iab-20260712-224258-cdt/1440x900-p100.png` | `artifacts/visual-qa/scene-lab/1440x900-p100.png`; `1440x900-p100-geometry.json` | 28.52% | 0.000,0.000,0.939,1.000 | 0.155,0.433,0.397,0.820 | 0.399,0.532 | bottom+left+top | max .789 / mean .054 | 10; tracks exact | D1 / C1 / R1 | 0/0; performance pass |

## 1280 × 800

| Anchor | Reference path | Implementation / geometry | Coverage | Field | Focal | Centroid | Edges | Overlap | Planes / continuity | Visual, correction, remaining | Console / performance |
|---|---|---|---:|---|---|---|---|---|---|---|---|
| p00 | `artifacts/reference-audit/raw/unveil-live-iab-20260712-224258-cdt/1280x800-p00.png` | `artifacts/visual-qa/scene-lab/1280x800-p00.png`; `1280x800-p00-geometry.json` | 28.64% | 0.000,0.000,0.950,1.000 | 0.179,0.395,0.381,0.845 | 0.401,0.528 | bottom+left+top | max .772 / mean .053 | 10; tracks exact | D1 / C1 / R1 | 0/0; performance pass |
| p20 | `artifacts/reference-audit/raw/unveil-live-iab-20260712-224258-cdt/1280x800-p20.png` | `artifacts/visual-qa/scene-lab/1280x800-p20.png`; `1280x800-p20-geometry.json` | 29.07% | 0.000,0.000,0.955,1.000 | 0.171,0.433,0.413,0.820 | 0.408,0.537 | bottom+left+top | max .787 / mean .053 | 10; tracks exact | D1 / C1 / R1 | 0/0; performance pass |
| p40 | `artifacts/reference-audit/raw/unveil-live-iab-20260712-224258-cdt/1280x800-p40.png` | `artifacts/visual-qa/scene-lab/1280x800-p40.png`; `1280x800-p40-geometry.json` | 28.54% | 0.000,0.000,0.945,1.000 | 0.173,0.391,0.375,0.841 | 0.395,0.525 | bottom+left+top | max .732 / mean .052 | 10; tracks exact | D1 / C1 / R1 | 0/0; performance pass |
| p60 | `artifacts/reference-audit/raw/unveil-live-iab-20260712-224258-cdt/1280x800-p60.png` | `artifacts/visual-qa/scene-lab/1280x800-p60.png`; `1280x800-p60-geometry.json` | 28.95% | 0.000,0.000,0.951,1.000 | 0.167,0.437,0.409,0.824 | 0.406,0.539 | bottom+left+top | max .799 / mean .054 | 10; tracks exact | D1 / C1 / R1 | 0/0; performance pass |
| p80 | `artifacts/reference-audit/raw/unveil-live-iab-20260712-224258-cdt/1280x800-p80.png` | `artifacts/visual-qa/scene-lab/1280x800-p80.png`; `1280x800-p80-geometry.json` | 28.77% | 0.000,0.000,0.951,1.000 | 0.179,0.409,0.381,0.859 | 0.403,0.539 | bottom+left+top | max .785 / mean .053 | 10; tracks exact | D1 / C1 / R1 | 0/0; performance pass |
| p100 | `artifacts/reference-audit/raw/unveil-live-iab-20260712-224258-cdt/1280x800-p100.png` | `artifacts/visual-qa/scene-lab/1280x800-p100.png`; `1280x800-p100-geometry.json` | 28.87% | 0.000,0.000,0.949,1.000 | 0.165,0.433,0.407,0.820 | 0.404,0.535 | bottom+left+top | max .790 / mean .053 | 10; tracks exact | D1 / C1 / R1 | 0/0; performance pass |

## 1024 × 768

| Anchor | Reference path | Implementation / geometry | Coverage | Field | Focal | Centroid | Edges | Overlap | Planes / continuity | Visual, correction, remaining | Console / performance |
|---|---|---|---:|---|---|---|---|---|---|---|---|
| p00 | `artifacts/reference-audit/raw/unveil-live-iab-20260712-224258-cdt/1024x768-p00.png` | `artifacts/visual-qa/scene-lab/1024x768-p00.png`; `1024x768-p00-geometry.json` | 30.05% | 0.000,0.000,1.000,1.000 | 0.134,0.405,0.366,0.835 | 0.415,0.508 | bottom+left+top | max .744 / mean .070 | 9; tracks exact | D1 / C1 / R1 | 0/0; performance pass |
| p20 | `artifacts/reference-audit/raw/unveil-live-iab-20260712-224258-cdt/1024x768-p20.png` | `artifacts/visual-qa/scene-lab/1024x768-p20.png`; `1024x768-p20-geometry.json` | 30.57% | 0.000,0.000,1.000,1.000 | 0.123,0.441,0.401,0.811 | 0.421,0.519 | bottom+left+right+top | max .759 / mean .071 | 9; tracks exact | D1 / C1 / R1 | 0/0; performance pass |
| p40 | `artifacts/reference-audit/raw/unveil-live-iab-20260712-224258-cdt/1024x768-p40.png` | `artifacts/visual-qa/scene-lab/1024x768-p40.png`; `1024x768-p40-geometry.json` | 29.95% | 0.000,0.000,0.994,1.000 | 0.128,0.401,0.360,0.831 | 0.409,0.505 | bottom+left+top | max .700 / mean .070 | 9; tracks exact | D1 / C1 / R1 | 0/0; performance pass |
| p60 | `artifacts/reference-audit/raw/unveil-live-iab-20260712-224258-cdt/1024x768-p60.png` | `artifacts/visual-qa/scene-lab/1024x768-p60.png`; `1024x768-p60-geometry.json` | 30.46% | 0.000,0.000,0.999,1.000 | 0.119,0.445,0.397,0.815 | 0.420,0.519 | bottom+left+top | max .770 / mean .071 | 9; tracks exact | D1 / C1 / R1 | 0/0; performance pass |
| p80 | `artifacts/reference-audit/raw/unveil-live-iab-20260712-224258-cdt/1024x768-p80.png` | `artifacts/visual-qa/scene-lab/1024x768-p80.png`; `1024x768-p80-geometry.json` | 30.25% | 0.000,0.000,1.000,1.000 | 0.134,0.419,0.366,0.849 | 0.417,0.520 | bottom+left+top | max .753 / mean .070 | 9; tracks exact | D1 / C1 / R1 | 0/0; performance pass |
| p100 | `artifacts/reference-audit/raw/unveil-live-iab-20260712-224258-cdt/1024x768-p100.png` | `artifacts/visual-qa/scene-lab/1024x768-p100.png`; `1024x768-p100-geometry.json` | 30.36% | 0.000,0.000,0.997,1.000 | 0.117,0.441,0.395,0.811 | 0.418,0.516 | bottom+left+top | max .759 / mean .071 | 9; tracks exact | D1 / C1 / R1 | 0/0; performance pass |

## 390 × 844

| Anchor | Reference path | Implementation / geometry | Coverage | Field | Focal | Centroid | Edges | Overlap | Planes / continuity | Visual, correction, remaining | Console / performance |
|---|---|---|---:|---|---|---|---|---|---|---|---|
| p00 | `artifacts/reference-audit/raw/unveil-live-iab-20260712-224258-cdt/390x844-p00.png` | `artifacts/visual-qa/scene-lab/390x844-p00.png`; `390x844-p00-geometry.json` | 50.18% | 0.000,0.036,1.000,1.000 | -0.026,0.440,0.566,0.820 | 0.478,0.538 | bottom+left+right | max .741 / mean .146 | 8; tracks exact | D1 / C1 / R1 | 0/0; performance pass |
| p20 | `artifacts/reference-audit/raw/unveil-live-iab-20260712-224258-cdt/390x844-p20.png` | `artifacts/visual-qa/scene-lab/390x844-p20.png`; `390x844-p20-geometry.json` | 49.90% | 0.000,0.041,1.000,1.000 | -0.072,0.473,0.636,0.799 | 0.483,0.550 | bottom+left+right | max .756 / mean .138 | 8; tracks exact | D1 / C1 / R1 | 0/0; performance pass |
| p40 | `artifacts/reference-audit/raw/unveil-live-iab-20260712-224258-cdt/390x844-p40.png` | `artifacts/visual-qa/scene-lab/390x844-p40.png`; `390x844-p40-geometry.json` | 50.61% | 0.000,0.031,1.000,1.000 | -0.032,0.436,0.560,0.816 | 0.475,0.536 | bottom+left+right | max .699 / mean .141 | 8; tracks exact | D1 / C1 / R1 | 0/0; performance pass |
| p60 | `artifacts/reference-audit/raw/unveil-live-iab-20260712-224258-cdt/390x844-p60.png` | `artifacts/visual-qa/scene-lab/390x844-p60.png`; `390x844-p60-geometry.json` | 49.79% | 0.000,0.045,1.000,1.000 | -0.076,0.477,0.632,0.803 | 0.484,0.552 | bottom+left+right | max .766 / mean .138 | 8; tracks exact | D1 / C1 / R1 | 0/0; performance pass |
| p80 | `artifacts/reference-audit/raw/unveil-live-iab-20260712-224258-cdt/390x844-p80.png` | `artifacts/visual-qa/scene-lab/390x844-p80.png`; `390x844-p80-geometry.json` | 50.32% | 0.000,0.049,1.000,1.000 | -0.026,0.454,0.566,0.834 | 0.479,0.552 | bottom+left+right | max .754 / mean .145 | 8; tracks exact | D1 / C1 / R1 | 0/0; performance pass |
| p100 | `artifacts/reference-audit/raw/unveil-live-iab-20260712-224258-cdt/390x844-p100.png` | `artifacts/visual-qa/scene-lab/390x844-p100.png`; `390x844-p100-geometry.json` | 49.82% | 0.000,0.041,1.000,1.000 | -0.078,0.473,0.630,0.799 | 0.483,0.547 | bottom+left+right | max .757 / mean .138 | 8; tracks exact | D1 / C1 / R1 | 0/0; performance pass |

### Visual/correction codes

- **D1 — visible discrepancy:** the local Library contains zero persisted completed collages, so the isolated lab repeats four user-provided completed collages across the geometry tracks. The repetition is intentionally labeled.
- **C1 — correction performed:** replaced the single studio-sample fallback with four stable user-supplied finish-collage records; each retains one collage identity across five deterministic lab instances; QA exports now distinguish available from persisted collage counts.
- **R1 — remaining deviation:** the Material Collager collages are predominantly white product compositions, so their apparent depth/contrast differs materially from the dark, saturated Unveil reference art even with exact approved polygons. Repetition remains visible until the existing Library contains more completed records. Final licensed typography and physical-device acceptance remain later production gates.

## Staged comparison and corrections

| Stage | Five largest discrepancies inspected | Correction before proceeding |
|---|---|---|
| A — p00 / 1440 | Label backing; far/mid planes too pale; completed-collage crop hierarchy; chrome alignment; content-model identity | Removed backing, raised role opacity, retained deterministic crop anchors, verified 580 px header and 142 × 40 control, and confirmed every plane maps to a completed finish collage |
| B — p40 / 1440 | Intrinsic collage luminance; focal contrast; overlap readability; label visibility; edge crop | Retained sRGB/no-tone-map fidelity, used mix-blend title treatment, verified exact locked overlap/edge metadata, and exposed stable collage and lab-instance IDs |
| C — p100 / 1440 | End-state density; entering/exiting order; bottom/left crop; focal bounds; endpoint behavior | Verified 10 locked planes and stable tracks, deterministic sorting, exact focal bounds, and soft settle to 1.000000 |
| D — p20/p60/p80 | Static-slot interpolation risk; transient order; opacity during entry/exit; crop stability; hash repeatability | Interpolation keyed by stable `track_id`; roles come from current anchor; entering/exiting tracks fade and travel; crop anchors remain stable; reload hashes match |
| E — 1280 | Field scale; header width; focal placement; edge intersections; source contrast | Exact 10-plane geometry and 580 px header verified; apparent black comparison matte was disproved by direct RGB pixel inspection and single-image capture |
| F — 1024 | Plane count; right-edge behavior; field centroid; focal scale; control placement | Exact nine-plane geometry, edge metadata, centroid, focal bounds, and fixed chrome verified |
| G — 390 | Header collision; brand abbreviation; eight-plane density; offscreen focal crop; bottom control | Applied approved `MATERIAL COLL.` visual abbreviation with accessible `MATERIAL COLLAGER`; exact 382 px header and mobile geometry verified |
| H — input | Wheel scaling; fine trackpad deltas; drag direction; hard endpoint; damping settle | Normalized delta modes, clamped impulses, shared Pointer Events drag path, 10 px tap threshold, soft ±0.055 target envelope, exponential damping |
| I — keyboard/selection | Roving focus race; Home/End focus; Page movement; Space scrolling risk; sibling prominence | Added stable focus lock, synchronized finish-collage/progress movement, prevented Space default, centered selection, attenuated siblings to observed maximum opacity .144 |
| J — accessibility/reduced motion | Canvas duplication; Index ambiguity; Escape handling; reduced inertia; mobile name | Canvas `aria-hidden`, one semantic ordered list with roving tabindex, explicit pressed Index state, shell Escape handling, discrete reduced-motion controls |
| K — lifecycle/performance | Context-loss blank state; texture growth; DPR; frame cadence; console health | Index fallback on loss, automatic scene restoration, bounded texture-window disposal, DPR cap 1.25, measured performance gates, zero capture errors/warnings |

## Interaction and accessibility results

- Wheel: progress `0.200000 → 0.285316`, settling at target `0.285333`.
- Fine trackpad deltas: `0.398756 → 0.415638` continuously.
- Pointer drag: `0.285316 → 0.398734`; movement above 10 px suppresses click selection.
- Soft endpoint: target reached `1.026651`, then settled to progress/target `1.000000` with velocity `0.000000`.
- Keyboard: exactly one roving `tabindex=0`; Home/End focus first/last finish-collage instance and set p00/p100; arrows and Page keys update stable finish-collage focus and scene position; Enter/Space select; Space leaves free progress unchanged; Escape cancels selection or closes Index.
- Selection: phase reached `1.0000`; selected bounds centered at normalized x `0.290–0.710`, y `0.302–0.738`; maximum sibling opacity was `.1584`.
- Index: explicitly selected with `aria-pressed=true`; Escape returned Scene to `aria-pressed=true`.
- Reduced motion: wheel progress stayed `0.400000`; semantic Prev/Next controls appeared and moved immediately without inertia.
- Accessibility tree: one `Completed finish collages` ordered list contains 20 explicitly labeled instances derived from four underlying completed collages; canvas is `aria-hidden`; mobile visual abbreviation retains accessible name `Material Collager`.
- Pointer interruption: `1440x900-pointercancel-cleanup.json` and `1440x900-lostpointercapture-cleanup.json` both end with `data-drag-pointer-id=-1` and the matching finish reason.
- Touch note: the shared Pointer Events implementation and mobile drag path were verified at 390 × 844 with `touch-action:none`. The in-app Browser rejected native `Input.dispatchTouchEvent`, and its emulated drag reported `pointerType=mouse`; separate physical-device touch acceptance remains the documented final-production gate.

## WebGL lifecycle results

- Forced `WEBGL_lose_context` switched the page to usable Index fallback with `data-ready=false` and the WebGL-unavailable status.
- `restoreContext()` returned to Scene, `data-ready=true`, and the deterministic geometry hash without a reload loop.
- Renderer memory remained bounded during traversal. The four repeated collage URLs resolve to four shared sRGB textures across 20 semantic/track instances; restored desktop telemetry recorded 4 textures and 10 geometries with no pending or failed texture.
- Deterministic failure evidence (`1440x900-texture-failure-fallback.json`) records 19 loaded, 1 failed, 0 pending, a neutral fallback, and an available Retry control while the scene remains ready.

## Performance results

Environment: Chromium 150 on Windows 11, 16 logical cores, 32 GB reported device memory, ANGLE/D3D11 on NVIDIA GeForce RTX 4080.

| Gate | Settings | Run 1 | Run 2 | Run 3 | Result |
|---|---|---:|---:|---:|---|
| Desktop | Built worker; 1440×900, DSF1, no CPU/network throttle, warm cache, 10 s bidirectional scripted input | p95 2.9 ms; max 8.4 ms; 0 >100 ms | p95 2.9 ms; max 3.0 ms; 0 >100 ms | p95 2.9 ms; max 3.0 ms; 0 >100 ms | Pass |
| Constrained mobile | Built worker; 390×844, DSF2, renderer DPR 1.25, 4× CPU, 150 ms RTT, 200000 B/s down, 93750 B/s up; 23.63 s cold-ready load, one warm-up trace, then scored 10 s runs | p95 2.9 ms; max 13.9 ms; 0 >100 ms | p95 2.9 ms; max 14.0 ms; 0 >100 ms | p95 2.9 ms; max 13.9 ms; 0 >100 ms | Pass |

Artifacts are `artifacts/visual-qa/scene-lab/performance/desktop-run-{1,2,3}.json`, `mobile-warmup.json`, and `mobile-run-{1,2,3}.json`. Long-task results use the browser `PerformanceObserver` Long Tasks API. Renderer telemetry records the requested desktop/mobile viewport and DPR settings, four shared textures, no failed/pending texture, and 10/8 geometries at the desktop/mobile p40 telemetry states.

## Production regression

- `python artifacts/reference-audit/validate_reference_audit.py`: pass.
- `npm run build`: pass; route inventory adds only `/scene-lab`; all prior pages and API routes remain.
- `$env:PYTHONPATH='src'; python -m unittest discover -s tests -v`: 11/11 pass.
- `npm run test:scene-lab`: 8/8 pass.
- `/` and `/generator` were recaptured at 1440 × 900 in `artifacts/pre-scene-lab-baseline/`. The Library retains its sample collage and Generator entry. The Generator retains Board setup, Art direction, Reference tray, Collage/review controls, uploads, draft restore status, and history-facing UI.
- Browser console for `/` and `/generator`: zero errors, zero warnings.
- Generator smoke: Kitchen Material Palette exposed wood/countertop roles, Bathroom Fixture Collage restored, and Review prompt with zero references produced `Add at least one reference image for vanity_faucet.` Evidence: `post-scene-lab-generator-smoke.json`.
- Git diff for protected pages, APIs, production libraries, and `src/`: empty.
- Full-repository `npm run lint` remains blocked by six pre-existing errors in protected `app/page.tsx` and `app/generator/page.tsx`; targeted scene-lab ESLint passes and those protected files were not modified.

## Completion state

All isolated scene-lab S0/S1 ledger items pass with current Browser, build, test, performance, lifecycle, and regression evidence. Remaining items are documented S2/later-production gates: intrinsic collage/reference art-direction contrast, temporary fallback typography, and physical-device acceptance. Library integration was not begun. No deployment occurred.
