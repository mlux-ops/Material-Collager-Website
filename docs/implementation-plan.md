# Material Collager scene implementation plan

Status: planned only; no implementation authorized

Depends on approval of: `docs/reference-spec.md`

Initial scope: isolated `/scene-lab` only

## Outcome and scope guardrails

The first implementation must create an isolated `/scene-lab` without replacing `app/page.tsx` or changing production Library behavior. It must preserve every generator capability and all existing data, upload, reference, review, draft, history, and route behavior.

The scene-lab includes spatial planes, deterministic implementation-assigned anchors, wheel/trackpad/touch/keyboard progress, hover/focus, selection, centering, sibling attenuation, reduced motion, and responsive states. It initially excludes production routing, Contact, final project details, draft restoration, Library replacement, generator redesign, and deployment.

The six labels p00, p20, p40, p60, p80, and p100 are captured visual anchors. Canonical screenshot URLs are `/scene-lab?qa=1&anchor=p00`, `/scene-lab?qa=1&anchor=p20`, `/scene-lab?qa=1&anchor=p40`, `/scene-lab?qa=1&anchor=p60`, `/scene-lab?qa=1&anchor=p80`, and `/scene-lab?qa=1&anchor=p100`. An optional `progress=` parameter may support arbitrary development inspection, but it never produces canonical evidence.

## Architecture

Use React Three Fiber over Three.js for the spatial field and normal React DOM for product chrome, accessible navigation, synchronized focus, fallback, and reduced motion. The initial route is `/scene-lab`.

Before scene construction, run the isolated R3F/Vinext compatibility spike defined below. If R3F is unstable after the documented checks, retain the WebGL architecture and use direct Three.js. Do not modify production routes or migrate frameworks as a workaround.

State is divided into four layers:

1. **Candidate content:** stable temporary lab ids, local texture files, intrinsic dimensions, aspect class, provisional crop anchors, and lab order. The 58 current assets are candidates, not an approved public manifest.
2. **Scene configuration:** responsive camera/track, full materially-visible anchor geometry, stable travelling-plane `track_id`, per-anchor role, opacity/softness tuning ranges, culling window, and deterministic anchor mapping.
3. **Interaction state:** target/rendered progress, velocity, active/focused id, selected id, input modality, transition phase, and responsive state.
4. **Accessibility state:** focus origin, reduced-motion preference, texture-loading status, semantic Index state, and the single DOM announcement source.

The render loop reads refs/store selectors so animation does not rerender the full React tree. Lab selection and focus remain declarative React state.

## Rendering contract

- Textures and renderer output use sRGB color space; source-to-render comparisons must show no unintended image color shift.
- Use unlit image materials unless lighting is demonstrated by later evidence.
- Start with no tone mapping for image planes and document any later change.
- Choose and document one premultiplied-alpha convention across renderer, textures, materials, and custom shaders.
- Default `depthTest` to true. Decide `depthWrite` per transparent plane class and validate crossings for holes or flicker.
- Sort transparent planes by depth role and camera distance with a stable deterministic tie-breaker.
- Use mipmaps/filtering and anisotropy capped by measured performance; verify oblique image detail.
- Dispose textures, materials, geometries, and transient targets when removed or unmounted.
- Apply crop anchors through UV handling while preserving source aspect.
- Preserve the perceived sharpness hierarchy: focal sharp, adjacent slightly softened, distant softened. Numeric blur values are not acceptance gates unless directly measured by a documented method.

## Approved accessible DOM-equivalent model

- Set the canvas `aria-hidden="true"`.
- Use one synchronized semantic DOM project collection as the sole announcement source.
- Use roving tabindex so one project is in the tab order and arrow-key movement updates focus/active state.
- Keyboard focus updates the visible active plane and title.
- Pointer, hover, focus, and Index share the same active id.
- Index is explicitly user-selected; Tab must not automatically switch views.
- Do not duplicate project names or state announcements between canvas and DOM.

## Scene-lab header geometry

- Desktop/tablet: 580 px total, 4 px outer inset, 58 px cell height: `MATERIAL COLLAGER` 220 px, `LIBRARY` 180 px, `GENERATOR` 180 px.
- Mobile at 390 px: 382 px usable width inside 4 px insets, 58 px cell height: `MATERIAL COLLAGER` 152 px, `LIBRARY` 115 px, `GENERATOR` 115 px.
- If the full brand collides at an approved breakpoint, abbreviate only it to `MATERIAL COLL.` while keeping the 152 px cell and the full accessible name/title `MATERIAL COLLAGER`. No other abbreviation is approved.

## Intended future repository scope

No file listed here is changed by this audit revision.

### Scene-lab stage

| Future path | Responsibility | Constraint |
|---|---|---|
| `package.json` / lockfile | Add only approved, pinned Three/R3F and test dependencies if they are not already available. | Separate implementation approval; no installation during this audit. |
| `app/scene-lab/page.tsx` | Isolated lab route and client boundary. | Must not replace `app/page.tsx`. |
| `app/components/scene-lab/SceneLabExperience.tsx` | Compose product chrome treatment, canvas, accessibility model, controls, and fallback. | No Contact or production details. |
| `app/components/scene-lab/SceneLabCanvas.tsx` | Renderer, camera, render loop, loss handling, and lifecycle. | Follow the rendering contract. |
| `app/components/scene-lab/ScenePlane.tsx` | Plane geometry, UV crop, role, hit target, opacity/softness tuning, and ordering. | Match slots/roles, not Unveil identity. |
| `app/components/scene-lab/SceneLabIndex.tsx` | Explicitly selected semantic Index sharing active id with the roving DOM collection. | Never auto-switch on Tab; one announcement source. |
| `app/components/scene-lab/SceneLabChrome.tsx` | Material Collager labels with the reference chrome treatment. | Default labels: MATERIAL COLLAGER / LIBRARY / GENERATOR; do not copy Unveil labels. |
| `app/hooks/useVirtualProgress.ts` | Wheel, trackpad, touch/pointer, keyboard, damping, thresholds, and soft endpoints. | Constants begin as documented tuning ranges. |
| `app/hooks/useSceneLabQA.ts` | Parse named deterministic anchors and freeze time/order/inertia for capture. | Canonical URLs use `anchor=p00…p100`; `progress=` is optional/non-canonical. |
| `app/lib/scene-lab-assets.ts` | Temporary stable candidate order and metadata. | Not a public-rights manifest. |
| `app/lib/scene-lab-geometry.ts` | Anchor polygons, responsive layouts, roles, camera, and interpolation. | Export projected corners for measurement. |
| `tests/scene-lab/**` | Geometry, input, focus, renderer policy, lifecycle, and deterministic QA tests. | Additive only. |
| `scripts/capture-scene-lab-qa.mjs` | Capture 24 named-anchor local states and geometry exports. | Must load `active-sources.json`; no PNG globs or archive files. |
| `docs/visual-qa.md` | Record methods, measurements, discrepancies, and fixes. | Created during implementation. |

### Later Library integration

Only after scene-lab approval and public asset/product decisions may implementation modify `app/page.tsx`, shared layout/styles, production Library data adapters, Index integration, routes, or detail transitions. Contact requires separate approval. Draft restoration is a Library integration concern, not a scene-lab requirement.

### Files explicitly out of scope for scene-lab

- `app/page.tsx`
- `app/generator/page.tsx`
- `app/api/**`
- `app/lib/collage.ts`
- `app/lib/generation-jobs.ts`
- `app/lib/openai-server.ts`
- Python generation code under `src/`
- existing generator/API tests except additive non-regression coverage

Any proposed change to an out-of-scope file requires separate approval and a fidelity-ledger entry.

## Delivery stages

### Stage 0 — audit approval and lab baseline

- Approve the reference specification, this plan, ledger, and canonical-source manifest.
- Require `docs/pre-scene-lab-regression-baseline.md` plus `artifacts/pre-scene-lab-baseline/`; the current baseline is captured and must remain unchanged before the spike.
- Require `artifacts/reference-audit/active-sources.json` and `reference-geometry.json` as the QA source/geometry inputs. Run `python artifacts/reference-audit/validate_reference_audit.py` before scene construction; all QA tooling must reject sources outside the allowlist.
- Treat the locked full-field counts as 10 planes per desktop state, 9 per tablet state, and 8 per mobile state. Compute field union, bounding box, centroid, edge intersections, overlap, and density from all materially visible polygons.
- Interpolate stable `track_id` paths across anchors and assign role from the current anchor. Never interpolate static far/mid/adjacent/focal/near slots as if they were persistent plane identities.
- Record dependency needs without installing them until implementation is authorized.

Exit: the lab can proceed without changing production routes or requiring public rights/font completion.

### Stage 1 — R3F/Vinext compatibility spike

- After implementation approval and dependency changes, create an isolated client-only `/scene-lab` route with one unlit texture plane only.
- Verify no SSR/`window` error, no hydration mismatch, no duplicate Three instance, and no Vite dependency-optimization failure.
- Verify navigation to/from existing routes and hot reload.
- Run `npm run build` and rerun the pre-scene-lab regression baseline.
- Do not modify production routes or migrate frameworks. If R3F remains unstable, keep the WebGL architecture and use direct Three.js for the scene-lab.

Exit: the spike passes every compatibility check, or a documented direct-Three fallback decision is approved. No spatial scene construction begins before this exit.

### Stage 2 — `/scene-lab` shell and deterministic anchors

- Create only the isolated lab route and scoped styles/components.
- Add six deterministic named anchors at the canonical URLs and projected-corner export.
- Add semantic fallback and the approved aria-hidden canvas/roving DOM collection model.
- Implement the approved 580 px desktop/tablet and 382 px mobile header geometry.
- Use the temporary labeled font fallback and candidate local assets.

Exit: `/`, Library, and Generator are unchanged; every anchor reloads deterministically at all four viewports.

### Stage 3 — spatial plane field

- Implement the locked full-field window: 10 materially visible planes on desktop/compact desktop, 9 on tablet, and 8 on mobile, using slot/role matching and stable travelling-plane identity.
- Match p00, p40, and p100 geometry first, then p20, p60, and p80 interpolation.
- Measure projected polygon union coverage, field bounding box, focal bounds, geometric centroid, edge intersections, and overlap ratio.
- Tune perceived sharpness and stable transparent sorting; keep color occupancy informational.

Exit: all 24 static lab anchors pass high-severity geometric gates with no sort flicker or color shift.

### Stage 4 — input, focus, and selection

- Implement wheel/trackpad/touch progress with soft endpoints. Keyboard project controls use Arrow Left/Up for previous, Arrow Right/Down for next, Page Up/Down for multi-project movement, Home/End for first/last lab position, Enter/Space for selection, and Escape for selection cancel or Index close. Space must not drive free progress while a project control is focused.
- Implement hover/focus, selection, centering, sibling attenuation, and settle in place.
- Implement the approved roving-tabindex synchronized keyboard model, explicitly selected Index, reduced motion, and WebGL fallback.
- Treat damping, wheel impulse, tap threshold, phase percentages, opacity, and blur as initial ranges; record the chosen values and tuning method.

Exit: inputs, focus, selection, centering, attenuation, accessibility, and responsive behavior pass automated and Browser checks.

### Stage 5 — performance and scene-lab visual QA

- Add texture windowing, placeholders, disposal, anisotropy policy, DPR caps, and context recovery.
- Capture the 24 local anchors through Browser using named-anchor URLs and the active-source allowlist; never glob archive/duplicate PNGs.
- Fix all scene-lab S0/S1 discrepancies and document lower-severity deviations.

Exit: scene-lab is locally approved. No Library integration or deployment occurs.

### Stage 6 — Library integration, separately approved

- Approve the final public subset, stable order, titles, routes, crop anchors, alt text, and rights for the 58 candidates.
- Approve Material Collager navigation/product IA and any Index/detail behavior.
- Integrate only the approved lab behavior without losing production Library or draft behavior.
- Keep soft endpoints for the first production release; continuous wrap remains optional later.

Exit: Library behavior and regression inventory pass; production routing decisions are resolved.

### Stage 7 — final typography and deployment gate

- Use the approved self-hosted Inter variable webfont and capture release-candidate computed styles at all target viewports.
- Complete final typography, public asset-rights, physical-device, and production QA.
- Deploy only after separate explicit user approval.

## Measurement and validation plan

### Geometry

For each viewport and anchor, capture projected plane corners from deterministic scene data and compute:

- union polygon coverage;
- field union bounding box;
- focal plane bounds;
- area-weighted polygon centroid;
- edge intersection count for top/right/bottom/left; and
- pairwise overlap ratio against the smaller polygon.

Use the locked full-field `artifacts/reference-audit/reference-geometry.json` as the screen-space annotation set and `active-sources.json` as the only reference-input allowlist. The source includes stable `track_id`, per-anchor role, full projected polygons, pixel width/height/aspect, focal designation, z rank, edge intersections, and viewport-specific uncertainty/tolerances. Record the extraction script/version, coordinate convention, excluded chrome region, reference values, local values, tolerance, and result. Color/luminance occupancy may be logged but cannot be the primary gate.

Before implementation, run `python artifacts/reference-audit/validate_reference_audit.py --write-overlays`. It must pass, produce exactly 24 overlays, and the four viewport review sheets must be visually checked against the raw screenshots. Use focal bounds tolerances of ±4% desktop, ±5% tablet, and ±7% mobile; secondary bounds ±6%/±8%/±11%; overlap ±8/±10/±12 percentage points. Annotation uncertainty is 3%/4%/6% and may not exceed its applicable tolerance.

### Motion tuning

Record a reproducible synthetic input trace with timestamped deltas and a frame capture of target/current progress. Choose final damping, impulse clamp, tap threshold, phase percentages, opacity, and softness values from that evidence. Until then, all such constants are ranges, not reference facts.

### Performance conditions

- **Desktop:** current stable Chromium through Browser; Windows 11; 1440 × 900 CSS viewport; device scale factor 1; hardware acceleration on; AC power; no CPU/network throttle; one warm-up load; 10 seconds scripted continuous progress; three runs; record browser, CPU, and GPU identifiers. Pass: p95 frame time ≤20 ms and no long task >100 ms.
- **Constrained mobile emulation:** current stable Chromium; 390 × 844 CSS viewport; device scale factor 2; renderer DPR cap 1.25; 4× CPU slowdown; 150 ms RTT; 1.6 Mbps down/750 Kbps up; cold load then 10-second warm-cache progress; three runs; record exact CDP settings. Pass: p95 frame time ≤33 ms and no long task >100 ms.
- **Physical devices:** later final-production gate with physical iPhone plus borrowed or cloud-hosted real Android device; emulation does not replace Android real-device acceptance.

### Regression and Browser QA

- Type check, lint, build, and additive scene-lab unit/e2e tests after implementation.
- Browser verifies page identity, meaningful DOM, no framework overlay, console health, screenshots, and interaction proof.
- Confirm `/`, Library, Generator, API/data behavior, and drafts are unchanged during scene-lab.
- Final local QA captures the four required viewports at all six named-anchor URLs; arbitrary `progress=` states are diagnostic only.

## Phase approval gates

1. **Audit approval:** revised documents and canonical active sources approved.
2. **Compatibility-spike approval:** R3F/Vinext checks pass, or the documented direct-Three fallback is approved, with the pre-scene-lab regression baseline still passing.
3. **Scene-lab static approval:** deterministic named anchors and geometry pass.
4. **Scene-lab interaction approval:** inputs, focus, selection, centering, attenuation, accessibility, and performance pass.
5. **Library integration approval:** public assets, product IA, routes, crop anchors, rights, and Library regressions pass.
6. **Final production approval:** licensed font/substitute, final typography, physical devices, and all production checks pass.
7. **Deployment:** separate explicit instruction only.

Implementation stops at the relevant phase gate; a later-phase blocker does not prevent isolated scene-lab work.
