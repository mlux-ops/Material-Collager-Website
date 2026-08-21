# Material Collager Foundation

**Version**: 1.0.0
**Ratification Date**: 2026-08-21
**Last Amended**: 2026-08-21
**Foundation Type**: react

## Purpose

Material Collager is a browser app for creating high-end interior design material collage boards from real image references. It preserves original source files (up to 16 PNG/JPEG/WebP references, each under 50 MB) in a browser draft, transfers them in request-safe chunks, and sends them through the multipart Image API as actual `gpt-image-2` inputs — references are never reduced to text descriptions or silently compressed. The product goal is agency-level visual and interaction fidelity paired with a functional professional composition workspace, self-hosted on Cloudflare Workers.

## Technology Stack

- **Framework**: React 19.2 with Next.js 16.2 (App Router), served through vinext on Vite 8
- **Language**: TypeScript 5.9 (strict), `jsx: react-jsx`, `@/*` path alias
- **Build Tool**: Vite via `vinext` with `@cloudflare/vite-plugin` (RSC environment with SSR child environment); Wrangler for deployment
- **Runtime / Hosting**: Cloudflare Workers (`worker/index.ts`), D1 (Drizzle ORM, lazily provisioned tables), R2 for generated outputs; Miniflare simulates bindings in local dev
- **State Management**: Zustand 5 (workbench store at `app/components/workbench/store.ts`); React state/hooks elsewhere
- **3D / Motion**: three.js 0.182 with @react-three/fiber 9 (scene-lab, scene-wheel); CSS View Transitions for route changes (`app/components/TransitionLink.tsx`, `app/effects.css`)
- **Node editor**: @xyflow/react 12 (workbench)
- **Styling**: Tailwind CSS 4 (PostCSS) plus hand-authored token CSS (`app/globals.css`, `app/effects.css`, `app/motion-tokens.css`); design tokens are CSS custom properties
- **Test Framework**: Node built-in test runner (`node --test` with `--experimental-strip-types`), suite-per-feature `tests/*.test.mjs`; Python tests for the legacy CLI under `tests/test_*.py`
- **Package Manager**: npm (lockfile committed); Node >= 22.13
- **API surface**: Next route handlers under `app/api/*` (dry-run, economy, generate, library, references, release-import, workbench)

## Core Principles

### Principle 1: Reference Fidelity Is Binding
**Requirements**: Visual work MUST follow the source-of-truth order in `AGENTS.md` (approved recording/frames, live-reference inspection, `docs/reference-spec.md`, screenshots, breakdown files/tokens, existing behavior, prompt prose — in that order). Landing-page work MUST NOT invent marketing furniture (heroes, CTA strips, testimonials), substitute gradients for assets, flatten depth into box shadows, or use default typography where the reference specifies a face. Claims of live-reference inspection MUST be backed by recorded Browser evidence. Fidelity MUST NOT be fabricated; inaccessible references are reported as blockers.
**Rationale**: The product's value is agency-level reproduction of an approved reference. Every shortcut that "looks close enough" erodes exactly the quality the project exists to deliver.
**Compliance Verification**: Discrepancies logged in `docs/visual-qa.md`; deterministic QA states (`?qa=1&progress=…`) compared at the six mandated progress values across the four mandated viewports; task completion blocked while any high-severity discrepancy remains.

### Principle 2: Preserve Original Reference Data End-to-End
**Requirements**: Source images MUST reach the Image API as actual file inputs via the documented multipart workflow. References MUST NOT be reduced to text descriptions, silently recompressed, or combined into a lossy single request. Upload limits (16 references, 50 MB each, 32 MB request bodies per `next.config.ts`) MUST be respected and changed only with an explicit rationale recorded in code comments.
**Rationale**: High-input-fidelity generation is the core product promise; degrading inputs degrades every output invisibly.
**Compliance Verification**: `tests/workbench-*.test.mjs` (chunked transport, export/import, persistence migration) pass; request-body limits documented where set.

### Principle 3: Functional Workspace Over Styling Convenience
**Requirements**: All generator/workbench functions, state, uploads, reference items, review controls, draft behavior, and routes MUST be preserved through redesigns. Working state management and data logic MUST NOT be rewritten solely for styling. Interaction inventories and regression checks MUST precede generator changes. Hierarchy MUST come from typography, grouping, proportion, imagery, and state treatment — not only borders and whitespace.
**Rationale**: The generator is a professional tool, not a landing page; a restyle that costs a workflow is a regression, not a redesign.
**Compliance Verification**: `docs/workbench-interaction-inventory.md` updated before generator changes; `npm run test:workbench` and `npm run test:collage` pass; release-readiness suite (`npm run test:release-readiness`) green before deploy.

### Principle 4: Evidence-Based Rendering Choices
**Requirements**: Rendering stacks MUST be chosen and justified explicitly (DOM + CSS 3D vs React Three Fiber vs other), not picked from habit. CSS 3D SHOULD be used where DOM semantics suffice; WebGL where recordings show texture-plane behavior, depth compositing, or camera motion CSS cannot reproduce. Components MUST be functional with hooks; established state patterns (Zustand for workbench) MUST be followed rather than introducing parallel stores. New dependencies MUST be justified against bundle and Workers-runtime impact and SHOULD be pinned (this repo pins exact versions for runtime dependencies).
**Rationale**: The codebase already carries two rendering systems (DOM/CSS and R3F); undisciplined additions multiply maintenance cost and QA surface.
**Compliance Verification**: Architecture choices recorded in `docs/reference-spec.md` or the relevant design doc; `npm run lint` passes; dependency changes reviewed against `package.json` pinning convention.

### Principle 5: Motion Is Designed, Accessible, and Cheap
**Requirements**: Motion MUST use the project's token system (`--duration-*`, `--ease-*` in `app/motion-tokens.css` / `effects.css`) rather than ad-hoc values. Every animation MUST have a `prefers-reduced-motion` fallback that does not change normal reference behavior. Route transitions MUST degrade to plain navigation in unsupported browsers. Heavy scenes MUST hold frame rate on the mandated QA viewports; deterministic scene states MUST be preserved for comparison.
**Rationale**: Motion is part of the approved reference behavior, but it is also the easiest place to break accessibility and performance invisibly.
**Compliance Verification**: Reduced-motion checks in `app/effects.css` and `TransitionLink.tsx` remain intact; visual QA at frozen progress states; no high-severity interaction discrepancy at completion.

### Principle 6: Verified Completion, No Silent Deploys
**Requirements**: Implementation tasks MUST end with the completion report mandated by `AGENTS.md` (files changed, commands run, local URL, screenshots, discrepancies fixed, remaining deviations, tests performed). Deployment MUST NOT occur without explicit user approval of the local build. Release gates (`npm run validate:rights`, `npm run validate:library`, release QA scaffolding) MUST pass before release work is called done.
**Rationale**: The project's history (fidelity ledger, QA docs, release-rights worksheets) shows correctness is established by evidence, not assertion.
**Compliance Verification**: Completion reports present; `docs/staging-deployment-checklist.md` followed; CI deploy path per `docs/DEPLOYING.md` only from approved `main`.

## Domain Context

- **App Type**: Server-rendered Next.js App Router application deployed as a Cloudflare Worker (vinext + @cloudflare/vite-plugin, RSC + SSR environments), with heavy client-side interactive surfaces.
- **Component Pattern**: Feature-based — `app/components/{workbench,scene-lab,scene-wheel-v2}` own their feature's components, hooks, and stores; shared primitives (`TransitionLink`, `DropdownSelect`, `DitherReveal`, `CountUp`) sit at `app/components/` root; domain logic in `app/lib/`.
- **API Pattern**: REST-style Next route handlers under `app/api/*` with a typed client in `app/lib/api-client.ts`; OpenAI image generation server-side via `app/lib/openai-server.ts`; chunked image transport in `app/lib/image-transport.ts`.
- **Rendering Strategy**: SSR shell with client components for the three interactive surfaces (Library / Generator / Workbench); route transitions via the View Transitions API with reduced-motion and no-support fallbacks.
- **State**: Zustand store for the workbench node editor (draft signatures, persistence migration, cancellation, cost tracking — each covered by a dedicated test file); React hooks elsewhere.
- **Data**: D1 via Drizzle with lazily-created tables (see `db/schema.ts` comment); R2 bucket for generated outputs; browser drafts for in-progress work.
- **Testing convention**: One `tests/<feature>-<concern>.test.mjs` per concern, run through npm scripts with `--experimental-strip-types`; workbench suite runs with `--test-isolation=none`.

## Governance

### Amendment Procedure
Any contributor may propose an amendment by editing this document in a branch and opening a PR. The repository owner approves. Amendments that relax a fidelity or completion-report rule MUST cite the corresponding change in `AGENTS.md` — this document defers to `AGENTS.md` where the two overlap.

### Versioning Policy
- MAJOR (X.0.0): Backward-incompatible changes — removing or materially weakening a principle
- MINOR (x.Y.0): New principles or expanded sections
- PATCH (x.y.Z): Clarifications and wording improvements

### Compliance Reviews
Review at each release-readiness pass (alongside `npm run test:release-readiness`) and whenever a task's completion report shows a deviation from a principle.

## Dependent Artifacts

- `AGENTS.md` — binding fidelity rules; this foundation summarizes but does not replace it
- `docs/reference-spec.md`, `docs/visual-qa.md`, `docs/fidelity-ledger.md` — fidelity evidence chain
- `docs/workbench-interaction-inventory.md`, `docs/workbench-node-editor-design.md` — Principle 3 inputs
- `docs/production-readiness.md`, `docs/staging-deployment-checklist.md`, `docs/DEPLOYING.md` — Principle 6 gates
- `docs/release-decisions.md`, `docs/release-collage-rights.json` (+ schema), `docs/release-rights-worksheet.md` — release governance
- Generated documentation under `docs/` produced by `/buddy:docs`

## Domain References

From `Domains/react/profile.md`:

| File | Description | Load When |
|------|-------------|-----------|
| Reference/react-js.md | Comprehensive React code examples, patterns, and API reference | Plan, Implementation |

## Foundation Metadata

**Foundation Type**: react
**Domain**: React
**Created By**: codebase analysis (CreateFoundation workflow)
**Detection Score**: 330 (HIGH: next.config.ts, package.json "react", package.json "next"; MEDIUM: react-dom, app/ structure)
