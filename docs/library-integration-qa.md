# Library integration QA

Status: **local implementation verified; not approved for production deployment.**

The production `/` route mounts `SceneLabExperience` with `surface="library"`. It reads only `GET /api/library`; fixtures remain restricted to `/scene-lab`. The scene renderer is dynamically imported, so the Generator route does not load the Three/R3F scene module through this integration.

## Method and evidence boundaries

The in-app Browser inspected the real local `/` response at `http://localhost:3000/`: it was empty, Library was the active route, the Scene/Index controls had pressed state, and Generator-to-Library history returned correctly. The in-app Browser's image-transfer endpoint was unreliable, so deterministic image files were captured with the local Playwright fallback after Browser interaction verification. This is a capture fallback only.

Mocked rows below use the existing `/api/library` shape. They are not claims about production records, rights, or final preview artwork. "Visible planes" is the bounded visual field; the semantic count remains the normalized completed-record count.

## Evidence matrix

| Route | Viewport | Data state | Actual / semantic / visible | Source | Screenshot or snapshot | Console | Keyboard / pointer | Reduced / a11y / routing / perf | Discrepancy, correction, remaining deviation |
|---|---|---|---:|---|---|---|---|---|---|
| `/` | 1440x900 | Real empty | 0 / 0 / 0 | Real local `/api/library` | `library-empty-1440x900-current.png` | No application error | Empty route has only Generator link | Browser tree names chrome and Generator; back from `/generator` returns `/` | Fixed: no lab fixture promotion. Real populated data unavailable. |
| `/` | 1280x800 | Real empty | 0 / 0 / 0 | Real local API | `library-empty-1280x800.png` | Clean | N/A | Responsive empty control available | No remaining local discrepancy. |
| `/` | 1024x768 | Real empty | 0 / 0 / 0 | Real local API | `library-empty-1024x768.png` | Clean | N/A | Responsive empty control available | No remaining local discrepancy. |
| `/` | 390x844 | Real empty | 0 / 0 / 0 | Real local API | `library-empty-390x844.png` | Clean | N/A | Full accessible brand retained behind shortened visual label | Physical mobile device still untested. |
| `/` | 1440x900 | One valid record | 1 / 1 / 20 repeated presentation instances | Contract-faithful mock | `library-one-1440x900.png` | 0 errors | Semantic button is available | One announcement, no lab repetition label | Verified local preview asset only; production preview rights blocked. |
| `/` | 1440x900 | Two valid records / Index | 2 / 2 / 20 | Contract-faithful mock | `library-two-1440x900.png`, `library-two-index-1440x900.png` | 0 errors | Scene/Index toggle and selection dialog verified | Exactly two semantic buttons, pressed state exposed | Directional-key focus needs physical-device follow-up. |
| `/` | 1440x900 | Four valid records | 4 / 4 / 20 | `api-four.json` mock | `library-four-index-verified-1440x900.png` | Clean | Index click not stolen by scene pointer handler | Four semantic controls; canvas is not an announcement source | No local discrepancy. |
| `/?qa=1&progress=0.00/.20/.40/.60/.80/1.00` | 1440x900 | Four records, deterministic scene | 4 / 4 / 20 | `api-four.json` mock | `library-four-p00-1440x900.png` through `library-four-p100-1440x900.png` | Clean | QA state freezes scene geometry | Shared deterministic scene behavior | Visual use is a completed-collage adaptation, not a claim of Unveil artwork parity. |
| `/` | 1440x900 | 21 valid records | 21 / 21 / 20-window | `api-twenty-one.json` mock | `library-twenty-one-centered-1440x900.png` | Clean | Index selects record 21, moves the 20-plane window, opens its detail dialog; removal closes it | 21 list items in Browser snapshot; one selected item remains accessible | Fixed: semantic records are no longer limited to visual tracks; no production 21-record response available. |
| `/` | 1440x900 | Removal response | 20 / 20 / 20 after selected r21 removal | PATCH mock `{ ok: true }` | Browser snapshot recorded after removal | Clean | Remove closes dialog and updates collection | No stale selected record announced | Real API permission/error behavior remains release-environment work. |
| `/` | 1440x900 | New record after initial load | 1 / 1 / 20, then 2 / 2 / 20 | 30-second polling mock | `library-new-record-after-poll-1440x900.png` | 0 errors | Existing collection updates from Initial finish to New finish + Initial finish | Both identities appear once in the semantic collection | Verified against an intercepted API only. |
| `/` | 1440x900 | Reload after active selection | 1 / 1 / 20 | Contract-faithful mock | `library-selected-before-reload-1440x900.png`, `library-after-selection-reload-1440x900.png` | 0 errors | Index selection opens the dialog; reload returns to clean Scene state | No invented detail route or stale modal | Selection is intentionally not URL-persisted because the existing route/data model has no detail-state contract. |
| `/` | 1440x900 | Slow API then settled | 0 / 0 / 0 while loading; 1 / 1 / 20 after response | 3.5 s delayed mock | `library-slow-loading-1440x900.png`, `library-slow-settled-1440x900.png` | 0 errors | Loading status remains accessible | Loading uses live status and does not show fixtures | Network-throttle / physical-device evidence remains open. |
| `/` | 1440x900 | Slow image response | 1 / 1 / 20 | 3.5 s delayed preview mock | `library-slow-image-loading-1440x900.png`, `library-slow-image-settled-1440x900.png` | 0 errors | Collage control remains available before preview settles | Semantic collection remains one item; canvas uses normal texture readiness | Cold CDN/cache behavior still needs release evidence. |
| `/?qa=1&progress=.4&failTexture=track-01` | 1440x900 | Broken preview | 4 / 4 / 20 | Existing deterministic QA hook | `library-four-broken-preview-1440x900.png` | Expected 404 for deliberately missing QA image | Retry is exposed | Status announces one neutral placeholder, not a fatal canvas failure | Expected test 404 only. |
| `/` | 1440x900 | Forced WebGL loss and restore | 2 / 2 / 20 | Local dispatched context events on a two-record mock | `library-context-loss-1440x900.png`, `library-context-restored-1440x900.png` | 0 errors; two Three/driver texture-upload warnings while restoring | Index fallback is explicit and restored Scene is operable | Fallback status remains readable and collection is available | Warnings prevent a warning-free GPU acceptance claim. |
| `/` | 1440x900 | HTTP 500 and malformed payload | 0 / 0 / 0 | API mocks | Playwright accessibility snapshots | Expected failed request only | Retry stays in place | Error message, Generator path, no fixtures | No screenshot file; visual fallback still needs release test. |

## Interaction and regression checks

- Selection uses the normalized record list used by the renderer. Blank IDs/URLs, reference URLs, scene-lab URLs, invalid entries, and older duplicate IDs are excluded; newest valid duplicate wins.
- With more than 20 records, `actualRecords` retains all data, the semantic collection exposes every record, and the visual 20-plane window shifts around an off-window selection instead of dropping it.
- Pointer handling ignores buttons and links before capture; tap, drag, cancel, and lost-capture cleanup are automated. A visible overlay previously blocked the viewer's Close control; the viewer is now layered above the semantic Index overlay (`z-index: 3000`).
- The production detail dialog preserves the existing direct image URL, download path, and removal PATCH contract. On successful removal it clears selection and re-derives the catalog. On API failure it remains a recoverable Library state.
- Library polling remains 30 seconds. A mocked new record is observed after one interval. Selection deliberately resets on hard reload because there is no existing detail-state route to restore; browser zoom, forced-colors, and real touch/trackpad device runs remain release evidence requirements.
- Reduced motion, WebGL fallback, and the shared keyboard model are inherited from the approved scene-lab. The standard Browser environment did not expose a media-emulation switch in this run, so reduced-motion production integration remains an S1 release check rather than a passed production claim.

## Visual comparison

`library-four-p60-1440x900.png` was reviewed beside the approved reference-audit p60 capture. The fixed chrome, diagonal upward panel field, cropping, depth layering, and Scene/Index control remain present. The Library deliberately uses completed-collage imagery, not Unveil imagery. The newly inspected 21-record viewer has the expected selected collage, direct preview, Download PNG, removal action, and unobscured Close control.

## Automated verification

- `npm run test:scene-lab` — **14/14 passing**. Covers normalization, production-empty fixture isolation, record ordering, duplicate handling, bounded 20-plane presentation, semantic record preservation, actual-record keyboard navigation/removal, payload parsing, navigation, and pointer cleanup.
- `$env:PYTHONPATH='src'; python -m unittest discover -s tests -v` — **11/11 passing**.
- `python artifacts/reference-audit/validate_reference_audit.py` — previously passed for the approved source audit; no source-audit files changed here.
- `npm run build` — passed when rerun outside the Windows sandbox. Vite retains a dynamically-loaded chunk larger than 500 kB warning.
- `bundle-size-current.json` records the emitted Library dynamic-import and Generator-isolation evidence. There is no trustworthy pre-integration manifest, so no before/after byte reduction is claimed.
- `npm run lint` — integration files are clean. The command still reports three errors and one warning in unchanged `app/generator/page.tsx` (two internal-link rules and one unused disable).

## Remaining deviations and external blockers

- No populated production records or preview-rights manifest was supplied. Local populated checks are contract-faithful mocks only.
- Inter is now the approved self-hosted application font. This historical QA capture predates the font change; release-candidate computed-style and visual captures still need to be recorded.
- Physical iPhone Safari, Android Chrome real-device, real GPU/frame timing, browser zoom, forced-colors, and populated staging remove/refresh acceptance are still open. Context loss/restoration and mocked slow image/API states are locally evidenced, but renderer warnings prevent GPU acceptance.
- No deployment, database mutation, staging, commit, branch operation, or fixture promotion occurred.
