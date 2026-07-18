# Pre-scene-lab regression baseline

Status: captured before any scene-lab dependency or application change

Recorded: 2026-07-13 (America/Chicago)

Structured results: `artifacts/pre-scene-lab-baseline/baseline-results.json`

## Purpose

This is the required regression baseline before an R3F/Vinext compatibility spike or any application/package change. Later scene-lab work must preserve the current `/`, `/generator`, API, draft, and generation workflow unless a separate approved task changes them.

## Environment

- Local URL: `http://localhost:3000`
- Browser: Codex in-app Browser
- Capture viewport: 1440 × 900 CSS px
- Framework: Next.js 16.2.6 through vinext 0.0.50 and Vite 8.0.13
- Package state: unchanged; no package installation occurred

## Screenshots

| Route | Artifact | Page identity | Result |
|---|---|---|---|
| `/` | `artifacts/pre-scene-lab-baseline/current-library-1440x900.png` | URL `/`, title `Material Collager` | Pass; Library rendered with navigation, sample collage, and Generator entry |
| `/generator` | `artifacts/pre-scene-lab-baseline/current-generator-1440x900.png` | URL `/generator`, title `Material Collager` | Pass; setup, art direction, reference tray, preview, and review controls rendered |

## Route inventory

Page routes:

- `/`
- `/generator`

API routes reported by the production build:

- `/api/dry-run`
- `/api/economy`
- `/api/economy/output/:id`
- `/api/generate`
- `/api/library`
- `/api/library/:id`
- `/api/library/:id/image`
- `/api/references/analyze`
- `/api/references/complete`
- `/api/references/import`
- `/api/references/matches`
- `/api/references/part`
- `/api/references/start`

## Build baseline

- Command: `npm run build`
- Result: **pass**
- Evidence: vinext completed client-reference analysis, server-reference analysis, RSC, client, and SSR environments and reported `Build complete`.
- Environment note: the restricted command sandbox produced the known `spawn EPERM` limitation; the approved unsandboxed rerun passed. This is an execution-environment constraint, not an application build failure.

## Test baseline

- Command: `$env:PYTHONPATH='src'; python -m unittest discover -s tests -v`
- Result: **pass**
- Count: 11 tests
- Duration: 0.135 seconds
- Coverage represented: CLI dry runs, image-reference transfer, request validation/defaults, prompt behavior, and QA parsing/review behavior.

## Console baseline

| Route | Errors | Warnings | Framework overlay |
|---|---:|---:|---|
| `/` | 0 | 0 | None |
| `/generator` | 0 | 0 | None |

## Existing Generator smoke baseline

The smoke flow was read-only with respect to external systems and did not save a draft or submit generation:

1. Loaded `/generator` and verified Board setup, Art direction, Reference tray, and Collage and review regions.
2. Changed Board type from Bathroom Fixture Collage to Kitchen Material Palette.
3. Verified the reference tray updated to kitchen roles, including wood and countertop.
4. Restored Board type to Bathroom Fixture Collage.
5. Activated Review prompt with zero references.
6. Verified expected inline validation: `Add at least one reference image for vanity_faucet.`
7. Confirmed zero Browser console warnings/errors after the flow.

## Regression gate

Before any dependency or application change, this document, both screenshots, and `baseline-results.json` must exist. After the compatibility spike and after every Library integration stage:

- rerun the build and the 11-test suite;
- recapture `/` and `/generator` at 1440 × 900;
- compare page identity, console state, route inventory, and the Generator smoke flow;
- treat any unexplained loss of existing behavior as an S0 regression blocker.
