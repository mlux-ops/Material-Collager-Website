# Reference contact-sheet manifest

Audit date: 2026-07-13 (America/Chicago)

This manifest designates the active comparison sources and archives legacy or duplicate contact sheets without deleting or moving them.

## Anchor interpretation

`p00`, `p20`, `p40`, `p60`, `p80`, and `p100` are six captured visual anchors from one uninterrupted live Browser session. They are labels, not proof of equal normalized increments in the reference renderer. Canonical local evidence must use `/scene-lab?qa=1&anchor=p00`, `/scene-lab?qa=1&anchor=p20`, `/scene-lab?qa=1&anchor=p40`, `/scene-lab?qa=1&anchor=p60`, `/scene-lab?qa=1&anchor=p80`, and `/scene-lab?qa=1&anchor=p100`. An optional `progress=` parameter is development-only and non-canonical.

## Active comparison sources

Only the following are active fidelity-comparison sources:

1. the four canonical viewport sheets;
2. the 24 raw canonical Browser captures;
3. this manifest and its capture provenance; and
4. the approved recording sequence: `references/unveil-scroll.mp4`, the 90 ordered frames in `references/video-frames/`, and the labeled recording-sequence sheet.

Current Material Collager screenshots remain failure/context baselines, not active reference geometry sources. Design breakdowns remain lower-priority supporting evidence under `AGENTS.md`.

`artifacts/reference-audit/active-sources.json` is the machine-readable allowlist. Every QA script must read it and must not glob this directory for PNGs. `reference-geometry.json` contains the locked full materially-visible field annotations, stable track continuity, pixel-space aspect metrics, and uncertainty; it does not add new visual sources. The 24 files in `geometry-overlays/` are verification derivatives composited over allowlisted raw captures, not additional reference sources.

## Canonical live capture procedure

- Source URL: `https://unveil.fr/?ref=siteinspire`
- Browser: Codex in-app Browser
- Session identifier: `unveil-live-iab-20260712-224258-cdt`
- Page loads: 1
- Refreshes after navigation: 0
- Browser tabs used: 1
- Reference order: one randomized order loaded once, then preserved across every anchor and viewport
- Captured visual anchors: `p00`, `p20`, `p40`, `p60`, `p80`, `p100`
- Viewport order at every anchor: 1440 × 900, 1280 × 800, 1024 × 768, 390 × 844
- Advancement: performed only at 1440 × 900; the same settled scene state was resized and captured at every viewport without refresh
- Raw screenshots: `artifacts/reference-audit/raw/unveil-live-iab-20260712-224258-cdt/`
- Page identity: URL remained `https://unveil.fr/?ref=siteinspire`, title remained `UNVEIL®`
- Browser health: canvas present at all 24 captures; no relevant console warnings or errors

The preserved ordering supports matching scene slots/roles across viewports. It does not require Material Collager to reproduce Unveil project identities.

## Active inventory

| File/path | Source | Count | Role | Designation |
|---|---|---:|---|---|
| `artifacts/reference-audit/unveil-live-1440x900-progress-contact-sheet.png` | canonical live Browser session | 6 | Desktop anchors | **Active canonical** |
| `artifacts/reference-audit/unveil-live-1280x800-progress-contact-sheet.png` | same session | 6 | Compact-desktop anchors | **Active canonical** |
| `artifacts/reference-audit/unveil-live-1024x768-progress-contact-sheet.png` | same session | 6 | Tablet anchors | **Active canonical** |
| `artifacts/reference-audit/unveil-live-390x844-progress-contact-sheet.png` | same session | 6 | Mobile anchors | **Active canonical** |
| `artifacts/reference-audit/raw/unveil-live-iab-20260712-224258-cdt/` | same session | 24 | Raw source for screen-space geometry measurements | **Active canonical** |
| `artifacts/reference-audit/contact-sheet-manifest.md` | audit provenance | 1 | Interpretation, session, and source designation | **Active canonical** |
| `artifacts/reference-audit/active-sources.json` | machine-readable path allowlist | 1 | Required QA input selection; prevents archive/duplicate globbing | **Active canonical control** |
| `artifacts/reference-audit/reference-geometry.json` | screenshot-space annotation data | 4 viewports × 6 anchors; 10/10/9/8 planes per desktop/compact/tablet/mobile state | Full-field polygons, stable `track_id`, current role, pixel width/height/aspect, z rank, edge intersections, focal flags, uncertainty/tolerance | **Active canonical annotation** |
| `artifacts/reference-audit/geometry-overlays/` | derivative verification overlays | 24 state overlays + 4 viewport review sheets | Direct raw-capture comparison used to lock geometry; not a new source | **Active audit evidence** |
| `artifacts/reference-audit/validate_reference_audit.py` | deterministic audit control | 1 | Validates state completeness, continuity, focal/edge/aspect metadata, tolerances, baseline, and source allowlist | **Active canonical control** |
| `references/unveil-scroll.mp4` | approved recording | 1 | Highest-priority motion/transition evidence | **Active recording sequence** |
| `references/video-frames/frame-0001.jpg` … `frame-0090.jpg` | extracted recording | 90 | Ordered frame evidence | **Active recording sequence** |
| `artifacts/reference-audit/unveil-recording-2494x1270-frame-sequence-contact-sheet.png` | labeled recording overview | 1 sheet / 90 frames | Navigation aid for recording sequence; not anchor progress | **Active recording sequence** |

## Archive designation

The following remain preserved but are excluded from active fidelity comparison.

| File/path | Reason | Designation |
|---|---|---|
| `artifacts/reference-audit/unveil-live-legacy-refresh-1440x900-progress-contact-sheet.png` | Separate randomized legacy page load | **Archive — do not compare** |
| `artifacts/reference-audit/unveil-live-legacy-refresh-1280x800-progress-contact-sheet.png` | Separate randomized legacy page load | **Archive — do not compare** |
| `artifacts/reference-audit/unveil-live-legacy-refresh-390x844-progress-contact-sheet.png` | Separate randomized legacy page load; no matching tablet sheet | **Archive — do not compare** |
| `artifacts/reference-audit/unveil-live-1440x900-progress-contact-sheet - Copy.png` | Duplicate of canonical desktop sheet | **Archive — do not compare** |
| `artifacts/reference-audit/unveil-live-1280x800-progress-contact-sheet - Copy.png` | Duplicate of canonical compact-desktop sheet | **Archive — do not compare** |
| `artifacts/reference-audit/unveil-live-1024x768-progress-contact-sheet - Copy.png` | Duplicate of canonical tablet sheet | **Archive — do not compare** |
| `C:\Users\cowey\.codex\visualizations\2026\07\13\019f58ea-75aa-7db3-af54-ac94bf10295a\browser-reference-audit\1440x900-contact-sheet.jpg` | Ambiguous original duplicated by labeled legacy copy | **Archive — do not compare** |
| `C:\Users\cowey\.codex\visualizations\2026\07\13\019f58ea-75aa-7db3-af54-ac94bf10295a\browser-reference-audit\1280x800-contact-sheet.jpg` | Ambiguous original duplicated by labeled legacy copy | **Archive — do not compare** |
| `C:\Users\cowey\.codex\visualizations\2026\07\13\019f58ea-75aa-7db3-af54-ac94bf10295a\browser-reference-audit\390x844-contact-sheet.jpg` | Ambiguous original duplicated by labeled legacy copy | **Archive — do not compare** |
| `C:\Users\cowey\.codex\visualizations\2026\07\13\019f58ea-75aa-7db3-af54-ac94bf10295a\browser-reference-audit\recording-contact-sheet.jpg` | Unlabeled duplicate of canonical labeled recording overview | **Archive — do not compare** |
| `references/screenshots/current-landing.png` | Current-build failure baseline, not reference geometry | **Context baseline only** |
| `references/screenshots/current-generator.png` | Current generator baseline, outside scene-lab | **Context baseline only** |

No archived file was deleted or moved by this designation.

## Ordering verdict

The canonical four-sheet set preserves one reference sequence across all six anchors and all four viewport sizes. Compare corresponding travelling planes by stable `track_id`, then evaluate the plane's current slot/role geometry—aspect class, projected size, depth role, overlap, crop edge, and sequence position. Do not interpolate static role slots, and do not compare or copy Unveil project identities, product labels, or asset subject matter.
