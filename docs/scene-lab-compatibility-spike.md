# Scene Lab R3F/Vinext compatibility spike

Status: **pass — Stage 1 only**

Verified: 2026-07-13 (America/Chicago)

Local URL: `http://localhost:3000/scene-lab`

This work stops at one approved local image texture on one unlit WebGL plane. It does not implement the spatial field, deterministic anchors, multi-plane sorting, scene interaction, final chrome, Library integration, Generator changes, or deployment.

## Existing stack inspected

- Node.js `24.15.0`
- npm `11.12.1`
- React `19.2.6`
- React DOM `19.2.6`
- Next.js `16.2.6`
- Vinext `0.0.50`
- Vite `8.0.13`
- TypeScript `5.9.3`

React, React DOM, Next.js, Vinext, and Vite were not upgraded. The npm registry reports that `@react-three/fiber@9.6.1` supports `react` and `react-dom` `>=19 <19.3`, which includes the installed React `19.2.6`.

## Dependencies added

Runtime dependencies:

- `@react-three/fiber@9.6.1`
- `three@0.182.0`

Development dependency:

- `@types/three@0.182.0`

The first registry check identified Three `0.185.1`, but Browser exposed R3F's `THREE.Clock` deprecation warning. Three's official migration guide places the deprecation after r182. r184 still produced the warning, so the final compatible pin is r182. The final `npm ls` graph contains one deduplicated `three@0.182.0` instance and one React `19.2.6` instance.

## Files created or modified

Modified:

- `package.json`
- `package-lock.json`

Created:

- `app/scene-lab/page.tsx`
- `app/scene-lab/SceneLabCompatibilitySpike.tsx`
- `app/scene-lab/scene-lab.module.css`
- `public/scene-lab/compatibility-texture.png`
- `docs/scene-lab-compatibility-spike.md`

The public texture is a byte-identical copy of `references/assets/Source Reference for Geometry, Color, Perspective, Camera, and Lighting.png` (SHA-256 `6817825A27E1B2F25DBCE03CDAD2BEED84D199A5584B1BF15AC64419EDD34A95`).

Protected files and systems were not modified. In particular, the final Git diff is empty for `app/page.tsx`, `app/generator/page.tsx`, `app/api/**`, the protected `app/lib/**` files, and `src/**`.

## R3F or direct-Three decision

**Decision: retain React Three Fiber.**

The client-only R3F route passes Vinext development, Browser, navigation, hot-reload, dependency-optimization, and production-build checks after pinning Three to r182. Direct Three.js fallback was not needed. The route uses `next/dynamic` with `ssr: false`; the R3F component has no server-side `window` or `document` access.

## Rendering contract verified

- Texture: `SRGBColorSpace`
- Renderer output: `SRGBColorSpace`
- Material: unlit `meshBasicMaterial`
- Tone mapping: `NoToneMapping` and `toneMapped={false}`
- Alpha: opaque renderer (`alpha: false`), `premultipliedAlpha: false`, opaque material (`transparent: false`, opacity `1`, alpha test `0`)
- Depth: `depthTest: true`, `depthWrite: true`
- Disposal: the loaded texture is disposed if loading completes after cancellation and again through the guarded unmount cleanup path
- Aspect: decoded source `1672 × 941`, aspect `1.7768331562`; mesh height is derived from width divided by that decoded aspect
- Sampling: linear magnification, linear mipmapped minification, mipmaps enabled

At 1440 × 900, the aspect-preserving screenshot match measured `1038 × 584`, aspect `1.7773972603`, for approximately `0.032%` ratio error. The best aligned source/render comparison averaged approximately `2.12` RGB levels of absolute channel delta, with no visible unintended color shift.

## Browser and console result

Browser: Codex in-app Browser.

- Page identity: `http://localhost:3000/scene-lab`, title `Material Collager`
- Meaningful DOM: spike heading, contract label, Library link, and Generator link present
- Canvas: exactly one canvas at 1440 × 900 and exactly one plane in the R3F scene
- Framework overlay: none
- Hydration mismatch: none reported on a fresh tab or reload
- SSR/window/document error: none in development or production build
- Duplicate Three instance: none; `npm ls` reports one deduplicated `three@0.182.0`
- Vite dependency optimization: rsc, ssr, and client optimizers completed after the lockfile change; no optimization error
- Relevant console errors or warnings on the final r182 run: zero
- Native scroll leak on `/scene-lab`: none

## Navigation result

**Pass.** Browser exercised `/` → direct `/scene-lab` navigation, the scene-lab `Library` link back to `/`, the existing `Generator` link to `/generator`, and route reloads. Titles, meaningful DOM, canvas state, and console state remained correct. Navigating away unmounted the scene without a WebGL or disposal-related console error; returning created the single canvas again.

## Hot-reload result

**Pass.** While `/scene-lab` remained open, the contract text was temporarily changed to include `HMR probe`. Browser observed the new text at the same URL without a manual reload, Vite logged the scene-lab module HMR update, and the console remained clean. The probe text was then restored.

## Production-build result

**Pass.** `npm run build` completed Vinext's client-reference analysis, server-reference analysis, RSC, client, and SSR environments and reported `Build complete`. The route inventory gained only `/scene-lab`; the prior page and API routes remained present.

The build retains Vite's chunk-size warning for a chunk over 500 kB. This is not a build failure and is recorded below as a remaining risk.

## Regression-baseline comparison

The comparison used the approved pre-scene-lab artifacts at 1440 × 900 and fresh post-spike Browser captures at the same CSS viewport and device pixel ratio 1.

### Library `/`

- URL/title: pass (`/`, `Material Collager`)
- Console: zero warnings/errors
- Screenshot comparison: exact; difference bounding box `null`, mean absolute channel delta `0`, changed-pixel ratio `0`
- DOM: existing Library navigation, sample collage, empty-state copy, and Generator entry present

### Generator `/generator`

- URL/title: pass (`/generator`, `Material Collager`)
- Console: zero warnings/errors
- Required regions: Board setup, Art direction, Reference tray, and Collage and review present
- Smoke flow: switched to Kitchen Material Palette; verified wood cabinet/panel and countertop roles; restored Bathroom Fixture Collage; activated Review prompt with zero references; observed `Review failed: Add at least one reference image for vanity_faucet.`
- Raw screenshot comparison: `0.4279%` of pixels changed, limited to the top-right draft status and bottom troubleshooting/status text created by the smoke flow
- Screenshot comparison after masking only those two dynamic text regions: exact; remaining difference bounding box `null`, mean absolute channel delta `0`

The 11-test Python regression suite passed (`11` tests, `0.283s`). `npx eslint app/scene-lab` also passed. Repository-wide lint/typecheck still surface pre-existing protected-file lint issues and Cloudflare/Drizzle ambient-type gaps; they were not changed in this spike.

## Commands and checks run

- `python artifacts/reference-audit/validate_reference_audit.py` — pass
- npm registry compatibility/peer-dependency checks
- pinned dependency installation
- `npm ls @react-three/fiber three @types/three react react-dom next vinext vite` — one deduplicated Three and React instance
- `npx eslint app/scene-lab` — pass
- `$env:PYTHONPATH='src'; python -m unittest discover -s tests -v` — 11/11 pass
- `npm run build` — pass
- Browser DOM, console, screenshot, navigation, reload, and HMR checks
- 1440 × 900 pixel comparison against both approved regression screenshots

## Remaining technical risks

- This spike validates one static opaque plane only. It does not validate the future multi-plane transparent sorting, depth-write policy for translucent classes, camera motion, blur/softness, texture windowing, context-loss recovery, or performance targets.
- Texture disposal is explicit in code and navigation/unmount is console-clean, but GPU-memory accounting and forced context-loss testing remain Stage 5 work.
- The final build reports a chunk over 500 kB. The heavy scene module is already client-only and dynamically imported, but later bundle/performance work must measure and tune the production scene.
- npm currently reports 14 audit findings (`1` low, `7` moderate, `6` high). They were not automatically changed because audit fixes could upgrade unrelated framework/runtime packages outside this task.
- Repository-wide lint/typecheck has pre-existing failures outside the new route. The isolated scene-lab lint and Vinext production build pass.
- The Generator's transient draft-status text changes after the required smoke interaction; the protected code, layout, imagery, controls, and behavior match the baseline once those dynamic status regions are excluded.

No deployment occurred. No multi-plane scene work was started.
