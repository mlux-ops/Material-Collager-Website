# Material Collager fidelity ledger

Status date: 2026-07-13

Implementation state: isolated scene-lab implemented; Library integration implemented and locally verified; release/deployment gates remain open

Reference session: `unveil-live-iab-20260712-224258-cdt`

This ledger separates gates for the isolated scene-lab, later Library integration, and final production/deployment. A later-phase blocker does not block an earlier phase. “Reference locked” means the target and measurement method are sufficiently documented; it does not mean a local implementation passes.

Severity:

- **S0 blocker:** required evidence, legal approval, accessibility, or regression protection for the named phase is absent.
- **S1 reject:** major visual, motion, responsive, functional, or routing mismatch for the named phase.
- **S2 material:** mismatch that must be fixed unless explicitly waived.
- **S3 polish:** low-impact refinement that may remain only if documented and approved.

Status values: `pass`, `reference locked`, `open decision`, `blocked`, `not started`, and `not applicable in phase`.

## Scene-lab gates

### Reference and provenance

| ID | Sev. | Target / evidence | Measurement method | Pass criterion | Status |
|---|---:|---|---|---|---|
| LAB-REF-01 | S0 | Four canonical sheets and 24 raw PNGs | Manifest/file inventory | Each required viewport has six captured visual anchors | Reference locked |
| LAB-REF-02 | S0 | Anchor meaning | Manifest plus capture procedure | p00/p20/p40/p60/p80/p100 are labeled implementation-assigned anchors, not claimed equal reference-progress increments | Reference locked |
| LAB-REF-03 | S1 | Recording and 90 extracted frames | Ordered frame inspection | Motion/selection claims trace to frames; recording sheet is sequence overview, not normalized progress | Reference locked |
| LAB-REF-04 | S1 | Active comparison sources | Manifest designation | Only four canonical sheets, raw canonical captures, canonical recording sheet/sequence, manifest, and source recording are active; legacy/duplicates are archive-only | Reference locked |
| LAB-REF-05 | S0 | Explicit source allowlist | Parse `artifacts/reference-audit/active-sources.json` and compare resolved paths | QA uses only listed paths; no archive/duplicate PNG globbing | Reference locked |
| LAB-REF-06 | S0 | Full-field screen-space geometry | `validate_reference_audit.py`; JSON count/metric review | All 4 viewports × 6 anchors contain every materially visible polygon: 10 desktop, 9 tablet, 8 mobile; stable `track_id`, per-anchor role, pixel aspect, focal/edge metadata, uncertainty, and no world-coordinate claim | Reference locked |
| LAB-REF-07 | S0 | Geometry overlay lock | 24 raw-image overlays plus four viewport review sheets | Every polygon/label is reviewed directly over its allowlisted raw capture before `locked_after_overlay_verification` is true | Reference locked |
| LAB-REF-08 | S0 | Audit validator | Run `python artifacts/reference-audit/validate_reference_audit.py` | Fails for missing states, continuity/focal/edge/aspect conflicts, uncertainty above tolerance, or non-allowlisted QA source | Reference locked |
| LAB-BASE-01 | S0 | Pre-scene-lab regression baseline | Artifact/doc inventory and result review | Two screenshots, route inventory, passing build, console state, 11-test result, and Generator smoke baseline exist before changes | Reference locked |

### Isolation and product protection

| ID | Sev. | Target / evidence | Measurement method | Pass criterion | Status |
|---|---:|---|---|---|---|
| LAB-SCP-01 | S0 | `/scene-lab` only | Git diff and route inspection | `app/page.tsx` and production Library behavior are unchanged | Pass |
| LAB-SCP-02 | S0 | Generator/API/data untouched | Git diff plus regression smoke | No unapproved changes to generator, uploads, references, review, drafts, history, API, or data logic | Pass |
| LAB-SCP-03 | S1 | Initial lab scope | Route/feature inspection | Spatial planes, anchors, all input modes, hover/focus, selection, centering, attenuation, and responsive states present; production routing, Contact, final details, and draft restoration absent/not required | Pass |
| LAB-IA-01 | S1 | Material Collager chrome labels | DOM text inspection | Chrome treatment retained; labels default to MATERIAL COLLAGER / LIBRARY / GENERATOR; no copied Unveil product labels | Pass |
| LAB-COMPAT-01 | S0 | R3F/Vinext client-only spike | Browser, console, dependency graph, hot-reload, navigation, and build checks | One unlit plane; no SSR/window error, hydration mismatch, duplicate Three, or Vite optimization failure; navigation/HMR/build pass | Pass — see `scene-lab-compatibility-spike.md` |
| LAB-COMPAT-02 | S0 | Architecture fallback | Spike evidence and decision record | If R3F is unstable, direct Three.js is used without production-route changes or framework migration | Pass — R3F stable; fallback not required |

### Geometry and plane field

| ID | Sev. | Target / evidence | Measurement method | Pass criterion | Status |
|---|---:|---|---|---|---|
| LAB-GEO-01 | S1 | Full viewport field and `#fafafa` clear | DOM/canvas bounds and pixel sample | 100vw × 100vh with no seam or native scrollbar | Pass |
| LAB-GEO-02 | S1 | Projected polygon coverage | Export projected corners; polygon union divided by comparison-region area | Within approved per-anchor tolerance recorded in visual QA | Pass — exact locked polygons |
| LAB-GEO-03 | S1 | Field bounding box | Full materially-visible polygon union bounds | Edge/crop relationship matches; per-viewport secondary tolerance is ±6% desktop, ±8% tablet, ±11% mobile | Pass — exact locked polygons |
| LAB-GEO-04 | S1 | Focal plane bounds | Named focal polygon bounds | ±4% desktop, ±5% tablet, ±7% mobile; reference uncertainty is 3%/4%/6% and never exceeds tolerance | Pass — exact locked polygons |
| LAB-GEO-05 | S1 | Geometric centroid | Area-weighted centroid of full projected polygon union | Within the viewport's approved secondary-bounds tolerance | Pass — exact locked polygons |
| LAB-GEO-06 | S1 | Edge intersection count | Count polygon-edge intersections at top/right/bottom/left | Exact for dominant planes; total fragments ±1 | Pass — exact metadata |
| LAB-GEO-07 | S1 | Pairwise overlap | Polygon intersection area divided by smaller polygon area | Direction/order exact; ratio within ±8/±10/±12 percentage points for desktop/tablet/mobile | Pass — exact locked polygons |
| LAB-GEO-08 | S2 | Color/luminance occupancy | Existing threshold method | Informational only; never sole pass/fail gate | Reference locked |
| LAB-PLN-01 | S1 | Visible field density | Full polygon inventory | 10 desktop, 9 tablet, 8 mobile materially-visible polygons; four dominant, exactly one focal | Pass |
| LAB-PLN-02 | S1 | Track continuity and slot/role matching | Stable `track_id` path plus role map per anchor | Travelling planes advance far/mid → adjacent/focal/near; match aspect class, projected size, depth role, overlap, crop edge, sequence position; Unveil identity is irrelevant | Pass |
| LAB-PLN-03 | S1 | Aspect preservation | Exported pixel bbox width/height/aspect vs declared class and track catalog | Class remains stable for each `track_id` across anchors/viewports; no unexplained portrait/landscape change or stretch | Pass |
| LAB-PLN-04 | S1 | Stable transparent ordering | Frame capture during crossings | No flicker, holes, or array-index-only sorting | Pass |
| LAB-PLN-05 | S2 | Perceived sharpness hierarchy | Same-frame visual comparison at anchor | Focal sharp; adjacent slightly softened; distant softened | Documented S2 — role opacity/source sampling; no unsupported shader blur |
| LAB-PLN-06 | S1 | Crop direction | Projected polygon/UV inspection | Required left/bottom near and top/right far crops present; no contain-all behavior | Pass |

### Chrome and temporary typography

| ID | Sev. | Target / evidence | Measurement method | Pass criterion | Status |
|---|---:|---|---|---|---|
| LAB-CHR-01 | S1 | Rounded implementation tokens | DOM bounding boxes | 66 px header and 58 px cells within ±3 px desktop/tablet, ±2 px mobile | Pass |
| LAB-CHR-02 | S1 | View control | DOM bounding box | Practical 142 × 40 px token within ±2 px when present | Pass |
| LAB-CHR-03 | S2 | Observed vs implementation values | Token/source review | Observations 66.016/58.016/142.266 remain documented; implementation uses rounded tokens | Reference locked |
| LAB-CHR-04 | S1 | Desktop/tablet Material Collager header | DOM bounding boxes at 1440, 1280, and 1024 widths | 580 px total: 220/180/180 px; 58 px cell height; 4 px outer inset | Pass |
| LAB-CHR-05 | S1 | Mobile Material Collager header | DOM bounding boxes at 390 × 844 | 382 px total: 152/115/115 px; 58 px cell height; 4 px outer inset | Pass |
| LAB-CHR-06 | S2 | Approved brand abbreviation | Text/accessible-name inspection | Only `MATERIAL COLL.` may replace a colliding full brand; cell remains 152 px and accessible name/title remains `MATERIAL COLLAGER` | Pass |
| LAB-TYP-01 | S2 | Approved substitute | Computed font inspection | Self-hosted Inter is applied consistently; release captures confirm metrics remain acceptable | Implemented locally; release capture pending |
| LAB-TYP-02 | S2 | Micro type | DOM computed style | Approximately 10.5 px with existing tolerance; final family not claimed | Pass |

### Motion, input, selection, and accessibility

| ID | Sev. | Target / evidence | Measurement method | Pass criterion | Status |
|---|---:|---|---|---|---|
| LAB-CNT-01 | S0 | Completed finish-collage content model | Adapter/API/DOM/QA-export inspection | Every top-level plane maps either to a persisted completed Library collage record or to an explicitly identified user-provided completed-collage lab fixture; repeated instances preserve the underlying collage identity; no individual source/reference image is a scene item | Pass — isolated lab uses 0 persisted Library records, 4 user-provided completed-collage fixtures, and 20 deterministic scene instances |
| LAB-MOT-01 | S1 | Continuous bidirectional progress | Timestamped synthetic delta trace and frame capture | Direction matches reference; reverse is reversible; no snap | Pass |
| LAB-MOT-02 | S2 | Damping and wheel impulse | Record input deltas, target/current progress, and settle frames | Final values documented; initial ranges are not represented as measured reference constants | Pass |
| LAB-MOT-03 | S1 | Soft endpoints | End-input interaction test | First production model soft-stops without hard visual collision; continuous wrap remains optional later | Pass |
| LAB-INP-01 | S1 | Wheel/trackpad | Browser interaction and state trace | Fine deltas remain continuous; delta modes normalized; no double momentum | Pass |
| LAB-INP-02 | S1 | Touch/pointer | Emulated and later physical input trace | Drag direction, bounded inertia, cancel/lost capture, and no rubber-band leak pass | Pass — emulated/shared Pointer Events path verified; physical-device acceptance deferred to PROD-PRF-01 |
| LAB-INP-03 | S1 | Tap threshold | Pointer travel matrix around chosen threshold | Chosen threshold documented; initial 8–12 px range tuned; drags do not select | Pass — 10 px |
| LAB-INP-04 | S1 | Keyboard finish-collage navigation | Keyboard-only walkthrough | Left/Up previous; Right/Down next; Page Up/Down multi-collage; Home/End first/last; Enter/Space select; Escape cancel/close Index; focused-control Space never drives free progress | Pass |
| LAB-SEL-01 | S1 | Hover/focus/selection synchronization | Active-id and visible-state assertions | Pointer and keyboard identify the same plane/slot | Pass |
| LAB-SEL-02 | S1 | Centering and sibling attenuation | Projected bounds and transition frames | Selected plane centers within ±3% viewport; siblings attenuate smoothly | Pass |
| LAB-SEL-03 | S2 | Phase/opacity/softness ranges | Frame-by-frame transition ledger | Chosen values and method documented; no unsupported exact-reference claim | Pass — documented in visual QA |
| LAB-A11Y-01 | S0 | Approved DOM-equivalent model | DOM/accessibility tree inspection | Canvas is `aria-hidden`; one semantic DOM completed-finish-collage collection is the sole announcement source and uses roving tabindex | Pass |
| LAB-A11Y-02 | S1 | Visible synchronized focus | Keyboard walkthrough plus screenshot | Focus updates visible active plane/title; pointer, hover, focus, and Index share one active id | Pass |
| LAB-A11Y-03 | S1 | Explicit Index and no duplicates | Tab/Index walkthrough and accessibility tree | Tab does not auto-switch views; Index is user-selected; canvas and DOM do not duplicate announcements | Pass |
| LAB-A11Y-04 | S1 | Reduced motion | Emulated media query and keyboard walkthrough | Stable/stepped access, no long inertia/softness animation, all lab content operable | Pass |

### WebGL and performance

| ID | Sev. | Target / evidence | Measurement method | Pass criterion | Status |
|---|---:|---|---|---|---|
| LAB-GL-01 | S1 | sRGB and no color shift | Source/render color patches and screenshot comparison | Texture/output color spaces explicit; no unintended visible shift | Pass |
| LAB-GL-02 | S1 | Unlit/tone mapping policy | Material/renderer inspection | Unlit image material and no tone mapping unless contrary evidence is documented | Pass |
| LAB-GL-03 | S1 | Alpha/depth policy | Renderer/material inspection and crossing capture | Premultiplication documented; depthTest/depthWrite deliberate; crossings stable | Pass |
| LAB-GL-04 | S2 | Anisotropy and UV crop | Renderer capability log and oblique/crop captures | Cap documented; aspect/crop correct; no unintended resampling | Pass — anisotropy cap 4 |
| LAB-GL-05 | S1 | Disposal/loss recovery | Texture counts, unmount cycles, forced context loss | No unbounded growth or reload loop; semantic fallback usable | Pass |
| LAB-PRF-01 | S1 | Desktop performance | Chromium/Windows 11, 1440×900, DSF1, hardware acceleration, AC, no throttle, warm cache, 10 s scripted motion, three runs; record browser/CPU/GPU | p95 frame time ≤20 ms; no long task >100 ms | Evidence recorded; acceptance pending — built-worker trace evidence is documented in `scene-lab-visual-qa.md`, but browser/GPU frame-time acceptance is not yet verified |
| LAB-PRF-02 | S1 | Constrained mobile emulation | Chromium, 390×844, DSF2, DPR cap1.25, 4× CPU, 150 ms RTT, 1.6 Mbps down/750 Kbps up, cold load then 10 s warm motion, three runs; record CDP settings | p95 frame time ≤33 ms; no long task >100 ms | Evidence recorded; acceptance pending — constrained-emulation built-worker trace evidence and the 23.63 s cold-ready observation are documented in `scene-lab-visual-qa.md`, but browser/GPU frame-time acceptance is not yet verified |
| LAB-QA-01 | S0 | Deterministic named anchors | Reload `/scene-lab?qa=1&anchor=p00`, `/scene-lab?qa=1&anchor=p20`, `/scene-lab?qa=1&anchor=p40`, `/scene-lab?qa=1&anchor=p60`, `/scene-lab?qa=1&anchor=p80`, `/scene-lab?qa=1&anchor=p100` and compare geometry export/hash | Same order and geometry on repeat; only named-anchor URLs produce canonical evidence; `progress=` remains optional/non-canonical | Pass |
| LAB-QA-02 | S1 | 24 local Browser captures | Browser capture inventory | All required viewports/anchors captured after the latest content change; all S0/S1 lab discrepancies resolved | Pass — 24 current built-worker captures and exports |

## Library integration gates

| ID | Sev. | Target / evidence | Measurement method | Pass criterion | Status |
|---|---:|---|---|---|---|
| LIB-AST-01 | S0 | Completed Library collage outputs | Existing record/preview adapter and approved rights review | Stable collage IDs, output previews, order, titles, routes, crop anchors, accessible names, and rights confirmed without exposing source/reference images as top-level items | Blocked pending populated production data/rights approval; local adapter tests cover exclusion and duplicate safety |
| LIB-IA-01 | S0 | Material Collager product IA | Approved navigation/route map | Actual functions and labels approved; Unveil labels not copied | Evidence recorded; Material Collager labels and `/` / `/generator` navigation retained |
| LIB-RTE-01 | S1 | Production Library integration | Route/history/focus tests | Approved scene behavior integrates without losing Library functions | Evidence recorded; Browser verifies the real empty `/` route, active Library chrome, Scene/Index state, `/generator`, and browser back to `/`; contract-faithful 1/2/4/21-record mocks verify semantics, selection, bounded visual window, and removal; see `library-integration-qa.md` |
| LIB-RTE-02 | S1 | Optional detail transition | Recording comparison plus route test | Required only if separately approved; selected texture remains continuous | Not applicable until approved |
| LIB-RTE-03 | S2 | Contact | Approved product decision | Not included unless separately approved; then route/focus/history contract passes | Not applicable until approved |
| LIB-DRAFT-01 | S0 | Existing Library/draft behavior | Regression inventory and Browser tests | Save/remove/restore/reset and existing project behavior unchanged | Evidence recorded; protected backend/generator diff is empty, Python 11/11 and scene tests 13/13 pass, Browser route/history smoke passes, and mocked removal is coherent; real populated-record workflow still needs release data |
| LIB-END-01 | S1 | First-release endpoints | Boundary interaction test | Soft endpoints used; wrap only after later explicit approval | Reference locked |

## Final production and deployment gates

| ID | Sev. | Target / evidence | Measurement method | Pass criterion | Status |
|---|---:|---|---|---|---|
| PROD-TYP-01 | S0 | Approved release font | License/binary record and computed font inspection | Inter approval, project-owned WOFF2 files, OFL record, and final metrics pass | Inter approved and installed; release computed-style/capture pending |
| PROD-AST-01 | S0 | Public collage-preview rights | Rights manifest | Every deployed completed-collage preview has confirmed rights and approved metadata | Blocked pending manifest |
| PROD-PRF-01 | S1 | Physical devices | Approved iPhone and Android real-device matrix with recorded runs | Touch, performance, memory, and responsive criteria pass | iPhone available; Android real-device access pending |
| PROD-QA-01 | S0 | Final visual/functional QA | Browser evidence, ledger, visual QA, regression suite | No S0/S1 production discrepancy remains | Blocked pending preview rights, physical-device acceptance, populated staging data, release font captures, and performance evidence; local Browser and saved QA evidence are recorded in `library-integration-qa.md` |
| DEP-01 | S0 | Explicit deployment approval | User instruction and deployment record | No deployment before separate approval | Reference locked |

## Phase blockers and decisions

| Item | Blocks scene-lab | Blocks Library integration | Blocks final/deployment |
|---|---|---|---|
| Populated completed-collage order/titles/routes/crop anchors/preview rights | No | Yes | Yes |
| Approved font binary/license/captures | No | No | Yes; Inter binary/license resolved, release captures pending |
| Product IA and navigation functions | No; use lab default | Yes | Yes |
| Project detail route/transition | No | Only if included | Only if included |
| Contact | No | Only if separately approved | Only if included |
| Continuous wrap | No; use soft endpoints | No; soft endpoints approved recommendation | Optional later decision |
| Physical iPhone and Android real-device evidence | No | No | Yes |

## Rejection conditions by phase

- **Scene-lab:** reject for production-route changes, app/page replacement, generator/data regressions, individual source/reference images exposed as top-level planes, missing deterministic anchors, failed geometric gates, unstable rendering, broken input/selection/focus, inaccessible canvas-only interaction, or duplicate announcements. Do not reject solely for historical reference-font mismatch, completed-collage preview-rights status, absent Contact, absent production routes/details, or absent draft restoration.
- **Library integration:** reject for unresolved completed-collage preview rights, copied Unveil labels, unapproved product IA, lost Library/draft behavior, or high-severity integration discrepancy.
- **Final production/deployment:** reject for unresolved release font captures, unresolved asset rights, missing physical-device acceptance, any open S0/S1 production gate, or deployment without explicit approval.
