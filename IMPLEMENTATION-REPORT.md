# Material Collager release-readiness implementation

Implementation date: 2026-07-13

## Approved decisions applied

- Private staging/review environment with D1 and R2 resources isolated from production.
- Inter as the application font.
- Physical iPhone Safari testing available.
- Android real-device testing remains pending; a borrowed device or cloud-hosted real Android device can close that gate. An emulator is preliminary evidence only.

## Implemented changes

### Typography

- Converted the supplied Inter variable TTF files to production WOFF2 files.
- Added normal and italic variable fonts with weight range 100–900 and optical-size data.
- Configured `next/font/local` in `app/layout.tsx` using the `--font-inter` CSS variable.
- Applied Inter globally and removed the active Geist and Scene Lab Arial/Helvetica split.
- Added the Inter license and font implementation notes under `app/fonts/`.

Generated files:

- `app/fonts/InterVariable.woff2` — 349,124 bytes
- `app/fonts/InterVariable-Italic.woff2` — 384,672 bytes

### Release data and rights

- Added a durable rights manifest using stable `assetKey` identifiers.
- Added a JSON schema and executable manifest validator.
- Added release mode requiring at least eight fully approved collages.
- Kept temporary D1 record identifiers out of the permanent rights manifest.

### Library validation and integrity

- Added a non-mutating validator for `GET /api/library` and all preview endpoints.
- Validates completed/final/visible records, timestamps, expiration, duplicate IDs, duplicate image URLs, HTTP status, and image content type.
- Release mode requires at least eight qualifying records.
- Hardened storage queries so only completed final outputs can be Library-visible or returned by the Library listing.

### QA and staging

- Added release-decision documentation.
- Added staging deployment and rollback checklist for isolated D1/R2 resources.
- Added iPhone, Android, desktop Chrome, reduced-motion, zoom, forced-colors, broken-preview, and WebGL recovery test matrices.
- Added a dated QA-run scaffolding script and evidence templates.

### Repository maintenance

- Repaired the omitted `build/sites-vite-plugin.ts` source required by `vite.config.ts`.
- Replaced an internal raw anchor with `next/link` and removed a stale lint suppression.
- Corrected the Node test command for the installed Node runtime.
- Pinned `postcss` to `8.5.14` through an override; production dependency audit now reports zero vulnerabilities.

## Verification results

| Check | Result |
|---|---|
| Rights manifest schema validation | PASS; empty preparation manifest is valid |
| Release-readiness tests | PASS — 8/8 |
| Scene Lab tests | PASS — 14/14 |
| Python tests | PASS — 11/11 |
| Reference audit | PASS |
| ESLint | PASS |
| Production build | PASS |
| `npm audit --omit=dev` | PASS — 0 vulnerabilities |

The build still reports a non-fatal warning that one or more minified client chunks exceed 500 kB. This is a performance optimization item, not a current build failure.

## Remaining release gates

1. Fill `docs/release-collage-rights.json` with at least eight approved collages.
2. Create private staging D1 and R2 resources and bind them as `DB` and `OUTPUTS`.
3. Deploy the exact release-candidate commit to the private review URL.
4. Generate 8–10 real final collages after generation cost is authorized.
5. Run populated Library validation and integration QA against staging.
6. Complete iPhone Safari testing.
7. Complete Android testing on a borrowed or cloud-hosted real device.
8. Record final desktop GPU, performance, and context-restoration evidence.

No production deployment, paid generation, Cloudflare mutation, commit, push, or pull request was performed. The uploaded archive did not contain `.git`, so no branch or commit could be created in this workspace.

## Apply locally

Copy the contents of `project-files/` over the root of the existing Material Collager project, allowing replacements. Then run:

```powershell
npm ci
npm run validate:rights
npm run test:release-readiness
npm run test:scene-lab
$env:PYTHONPATH = "src"
python -m unittest discover -s tests -v
python artifacts/reference-audit/validate_reference_audit.py
npm run lint
npm run build
npm audit --omit=dev
```

The complete command outputs are included in the `verification/` directory of the patch package.
