# GPT Image 2.5 prompting — shared constraints + mode-aware Prompt Builder

Date: 2026-09-16
Source of truth for the upstream rules: `docs/reference/openai-image-prompting.md`

## Problem

Two prompt-construction surfaces exist and they diverge.

`app/lib/collage.ts` (generator + autoboard) has strong prompt engineering —
labeled sections, a numbered REFERENCE MAP, object counts, negative
constraints. The workbench `promptBuilder` node has almost none: a domain line,
lighting, style, and free text, newline-joined.

Reviewing both against OpenAI's GPT Image 2.5 guide surfaced three gaps:

1. **Sizes past the experimental threshold.** The guide documents outputs above
   3,686,400 px as experimental. Five call sites emit such sizes.
2. **Edit turns are framed as generation.** `collage.ts` confirm/final pass the
   prior render as Image 1 but still open with "Create one …". The guide's edit
   pattern is change-scoped: "change only X", then an explicit preserve list.
3. **No tier calibration.** Quality tiers were chosen as priors and never
   validated by the guide's walk-down method.

Additionally, `promptBuilder` feeds five nodes — one generation node
(`imageGenerate`) and four edit-shaped ones (`imageEdit`, `maskedEdit`,
`relight`, `variations`) — while only knowing how to write generation prompts.

## Approach

Extract the upstream rules into two pure modules consumed by both surfaces, so
the vocabulary cannot drift, then rebuild the node on that foundation.

### Size audit (measured, not assumed)

| Surface | Value | Pixels | Status |
|---|---|---|---|
| `collage.ts:318,327` | `2048x2048` | 4,194,304 | experimental |
| `generation.ts:19` `GENERATION_SIZES` | `2048x2048` | 4,194,304 | experimental |
| `upscaler.manifest.ts:11` `UPSCALE_SIZES` | `2048x2048` | 4,194,304 | experimental |
| " | `3200x1792` | 5,734,400 | experimental |
| " | `3840x2160` | 8,294,400 | experimental, at max budget |

All are *legal*. They exceed only the experimental line. Values found in
`app/lib/scene-lab-geometry.ts` (`1440x900`, `1280x800`, `1024x768`, `390x844`)
are viewport keys, not image sizes, and are out of scope.

## Components

### 1. `app/lib/image-model-limits.ts` (new, pure, no imports)

Encodes the upstream constraints:

- each edge ≤ 3840
- both edges multiples of 16
- longer:shorter ratio ≤ 3:1
- total pixels 655,360 – 8,294,400
- **experimental** above 3,686,400

```ts
classifySize("2048x2048")
// { size: "2048x2048", width: 2048, height: 2048, pixels: 4194304,
//   legal: true, experimental: true, reasons: ["above 3,686,400 px"] }

classifySize("1000x1000")
// { legal: false, experimental: false, reasons: ["edges must be multiples of 16"] }
```

Also exports the 2.5 quality set (`auto|low|medium|high|xhigh|max`), background
set (`auto|opaque|transparent`), and both model ids (`gpt-image-2.5-flare`,
`gpt-image-2.5-sunburst`).

Classification never throws. Callers decide whether to block.

### 2. `app/lib/prompt-sections.ts` (new, pure)

- `assembleSections(sections)` — labeled-section joiner matching the shape
  `collage.ts` already proves works (section header, blank line, body).
- `buildReferenceMap(refs)` — numbered map with the primary-identity /
  supporting-view split, carried over from `collage.ts:380-385`.
- `changeScopeLines({ change, preserve, exclusions })` — the edit vocabulary,
  shared by the node's Edit mode and `collage.ts`'s confirm/final path.

### 3. `promptBuilder` node (rewrite)

Ports:

```
in:  references  (image, multi, acceptedKinds: ["image","references"])  NEW
in:  extra       (text)                                                 unchanged
out: text        (prompt)                                               unchanged
out: references  (references, pass-through)                             NEW
```

The pass-through output removes the desync risk by construction: references are
wired into `promptBuilder` once, and its own output feeds the generate/edit
node, so the map and the images always describe the same set. The old wiring
(references straight into the generate node) still works, without that
guarantee.

Modes:

| Mode | Sections | Consumers |
|---|---|---|
| Generate | `GOAL` · `SCENE` · `SUBJECT` · `MATERIALS AND DETAIL` · `REFERENCE MAP` · `CONSTRAINTS` · `OUTPUT` | `imageGenerate` |
| Edit | `CHANGE` · `PRESERVE` · `REFERENCE MAP` · `EXCLUSIONS` · `OUTPUT` | `imageEdit`, `maskedEdit`, `relight` |
| Refine | `SINGLE CHANGE` · `CARRY FORWARD` · `EXCLUSIONS` | `variations`, iterate-on-output |

Refine exposes exactly one change field, enforcing the guide's
one-change-per-turn rule structurally rather than by advice.

Reference roles come from the guide's vocabulary: `layout master`, `subject`,
`style`, `background`, `supporting view`. Unset roles fall back to a neutral
role; the map is never emitted empty.

Per-mode params live in separate namespaces so switching modes and back does not
destroy typed content.

`promptBuilder.tsx` renders a live preview of the assembled prompt plus the
reference count, calling the same pure assembler `execute` uses. Manifest stays
pure per the existing manifest/`.tsx` split.

### 4. `collage.ts` changes

- `resolvedSize` square → `1920x1920` (3,686,400 exactly, matching the pixel
  budget the landscape and portrait values already sit on). Both branches.
- When `request.layoutReference` is set (confirm and final), open with
  `changeScopeLines(...)` instead of `GOAL / Create one …`. Existing preserve
  lines are already correct and stay.
- Every value `resolvedSize` can return must pass `classifySize` as legal and
  non-experimental — enforced by test, not by convention.

### 5. Staleness correctness

Changing the confirm/final prompt changes output, but `selectionHash` covers
only instruction, items, and notes — not prompt shape. Without action,
pre-change renders would report as fresh while no longer matching what the
pipeline now produces.

Fold a prompt-shape version constant into `renderOptionsHash`
(`scripts/autoboard/lib/render.mjs`). Pre-change renders then correctly show as
**stale**, reusing machinery that already exists rather than adding a new
mechanism.

## Error handling

| Condition | Behavior |
|---|---|
| Illegal size | Throw at validation time (`validateCollageRequest` is the gate) |
| Experimental size | Classify and label. Never block — the upscaler needs these |
| Unset reference role | Neutral default role; map never empty |
| Generate prompt wired into an edit node | Soft warning in the node, not an error |

## Testing

- `tests/image-model-limits.test.mjs` — table test over every size the app can
  emit (`GENERATION_SIZES`, `UPSCALE_SIZES`, all `resolvedSize` branches),
  asserting legality and the experimental flag. This is the test that would
  have caught the finding.
- `tests/prompt-sections.test.mjs` — per-mode section output, reference-map
  numbering including the primary/supporting split, empty and single-reference
  edge cases.
- `tests/collage-prompt.test.mjs` — extend: confirm/final emit change-scope
  framing; plain generation unchanged.
- Node manifest test following existing registry-test conventions.
- Full suite green (507 at time of writing).

## Out of scope

- GPT Image 2.5 Flare evaluation. Cost here is dominated by reference-image
  input tokens (~1,391 each), which do not vary by model, so a faster model is
  not assumed cheaper. Separate measured experiment.
- Tier calibration runs themselves. The walk-down procedure is documented in
  `docs/reference/openai-image-prompting.md`; executing it is operational work.
- `scene-lab-geometry.ts` viewport keys.
