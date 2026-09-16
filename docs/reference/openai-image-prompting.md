# OpenAI image prompting — GPT Image 2.5

Distilled from <https://developers.openai.com/api/docs/guides/image-prompting>
(GPT Image 2.5 tab), captured 2026-09-16. This is the upstream guide for the
model family this app runs on — `gpt-image-2.5-sunburst`. Re-check the source
before relying on any number here; OpenAI revises this page.

Sections below marked **[repo]** are notes about Material Collager, not upstream
text.

## Model choice

Two models in the 2.5 family:

| Model | Role |
|---|---|
| `gpt-image-2.5-flare` | Small model, optimized for speed. Image quality comparable to GPT Image 2. |
| `gpt-image-2.5-sunburst` | Base model, optimized for quality. Higher quality than GPT Image 2. |

Both support generation, editing, and transparent backgrounds. Both improve on
precise editing and subject preservation relative to GPT Image 2.

Upstream selection rule: start with Sunburst when quality is the priority,
establish it meets requirements, *then* test Flare with identical prompts and
inputs and switch only if quality stays acceptable and latency improves.

> "Confirm current pricing rather than assuming the faster model costs less."

**[repo]** We run Sunburst everywhere (`SUNBURST_MODEL`, `app/lib/sunburst.ts`).
Flare is untested here. The draft stage is the plausible candidate — drafts are
throwaway `quality: "low"` renders whose only job is composition review — but
per this repo's own measurements, cost is dominated by reference-image *input*
tokens, not output, so a faster model may not be a cheaper one. Treat any Flare
change as an experiment with a measured before/after, not an assumed win.

## Parameters

| Parameter | Values |
|---|---|
| `model` | `gpt-image-2.5-flare` or `gpt-image-2.5-sunburst` |
| `quality` | `auto` (default), `low`, `medium`, `high`, `xhigh`, `max` |
| `size` | `auto` or custom `WIDTHxHEIGHT` |
| `background` | `auto`, `opaque`, `transparent` |

Common sizes: 1024x1024, 1536x1024, 1024x1536, 2048x2048, 2048x1152,
3840x2160, 2160x3840.

### Custom resolution constraints

- Each edge ≤ 3,840 px
- Both edges multiples of 16
- Longer:shorter edge ratio ≤ 3:1
- Total pixels between 655,360 and 8,294,400
- Above 3,686,400 total px (2560x1440) is **experimental**

### Format rules

- Transparency: request `background="transparent"` **and** use PNG or WebP.
- `output_compression` applies to JPEG/WebP only — **not** PNG.
- Verify the decoded alpha channel, especially hair, glass, shadows, edges.
  A drawn checkerboard is not transparency.

**[repo]** Our quality and background option lists in
`scripts/autoboard/lib/render.mjs` already match this set. The size constraints
are encoded in `app/lib/image-model-limits.ts` via `classifySize()`, which audits
whether a size is legal and marks experimental ones:

| Surface | Value | Pixels | Status |
| --- | --- | --- | --- |
| `app/lib/collage.ts` (square) | 2048x2048 → now 1920x1920 | 4,194,304 → 3,686,400 | was experimental, now at budget |
| `app/components/workbench/nodes/generation.ts` GENERATION_SIZES | 2048x2048 | 4,194,304 | experimental, kept and labeled |
| `app/components/workbench/nodes/upscaler.manifest.ts` UPSCALE_SIZES | 2048x2048 / 3200x1792 / 3840x2160 | 4,194,304 / 5,734,400 / 8,294,400 | experimental, kept and labeled |

All are legal; the only issue is that three of them exceed the experimental
threshold — `1920x1920` sits exactly at it, not above. The upscaler deliberately
keeps its experimental sizes because producing large output is that node's
entire purpose, so the module classifies rather than rejects.

### input_fidelity

> "For gpt-image-2, omit `input_fidelity`; image inputs are always processed at
> high fidelity."

**[repo]** This corroborates the gotcha already in CLAUDE.md — Sunburst answers
HTTP 400 `invalid_input_fidelity_model`. Upstream now documents the omission as
correct rather than a workaround. Do not re-add the field.

## Prompting fundamentals

Eight rules, condensed:

1. **Define the result.** Name subject and intended use. Specify composition,
   aspect ratio, placement constraints. For complex requests organize as scene,
   subject, details, constraints — using labeled sections.
2. **Choose a maintainable format.** Prose, JSON-like, tags, instructions all
   work. Pick what is easiest to read and update. No special syntax is magic.
3. **Describe visible details.** Name materials, lighting, colors, medium. Say
   "photorealistic" explicitly when that's the goal. Camera specs are cues for
   appearance, not physical simulation.
4. **Specify people and actions.** Body framing, relative scale, gaze,
   interaction with objects.
5. **Specify exact text.** Quote required wording, describe position and
   typography, spell unusual names letter by letter, ask for no extra text,
   then check spelling. Compare medium vs high quality for small text.
6. **Separate changes from constraints.** Say "change only X" and list what to
   preserve: identity, geometry, layout, lighting, labels. State exclusions
   (no text, logos, watermarks).
7. **Assign roles to references.** Identify each input *by number and purpose* —
   subject, style, clothing, background. Explain how inputs combine and which
   elements move where.
8. **Iterate deliberately.** Pass the previous output as the next edit input,
   request one change, repeat the details to preserve. Compare results before
   adding more instructions.

**[repo]** Rule 7 is already implemented — `app/lib/collage.ts:341-356` emits a
numbered REFERENCE MAP ("Image 1 -> …", "Images 2 onward define product
identity and detail") with explicit precedence when Image 1 is a layout master.
That is the documented best practice, independently arrived at.

## Patterns that map to this app

### Combine references — the core operation

Upstream pattern: pass the scene as image 1 and the subject as image 2, then
specify which element moves, its destination, and what stays unchanged.

> "Place the dog from the second image into the setting of image 1, right next
> to the woman, use the same style of lighting, composition and background.
> Do not change anything else."

### Change furniture in a room — closest published analogue

This is the interior-materials swap, verbatim from the guide:

> "In this room photo, replace ONLY the white chairs with chairs made of wood.
> Preserve camera angle, room lighting, floor shadows, and surrounding objects.
> Keep all other aspects of the image unchanged. Photorealistic contact shadows
> and fabric texture."

Note the shape: capitalized ONLY, an explicit preserve-list naming camera angle
and shadows, then a positive realism cue. Settings used: `size="1536x1024"`,
`quality="medium"`.

### Transparent product cutout

> "Extract the product from the input image and isolate it on a fully
> transparent background. Output: centered product, crisp silhouette, no
> halos/fringing. Preserve product geometry and label legibility exactly. Add
> only light polishing. Do not add a solid backdrop, checkerboard, scenery, or
> shadow."

Critical follow-on: **"For subsequent edits, repeat the requirement to preserve
the transparent background."**

**[repo]** Verified compliant. Our confirm and final stages pass the prior
render in as a layout reference, and upstream requires the transparency
constraint to be restated at each step rather than only the first. It is:
`resolvedBackground` feeds the transparent-background clause in
`buildGenerationPrompt` (`app/lib/collage.ts`), and all three stages call that
same builder, so every stage re-emits the full clause. `output_compression` is
likewise already gated behind `outputFormat !== "png"` in both
`app/api/generate/route.ts` and `app/api/workbench/edit/route.ts`.

### Refine across turns — our draft → confirm → final chain

> "Pass the previous output as the next edit input, request one change, and
> repeat the details to preserve."

And the warning that matters most for a multi-stage pipeline:

> "Repeated edits can still change details you intended to preserve. Restate
> those constraints and inspect each result. If a region must remain
> pixel-identical, composite the approved edit into the original image instead
> of relying on prompting alone."

**[repo]** "Restate constraints at every stage" is the upstream justification
for why the board instruction and per-item notes ride along on confirm and
final, not just draft. The pixel-identical caveat is a real ceiling: prompting
alone will not hold a region exactly, so a material that must match a spec
swatch precisely is a compositing problem, not a prompting one.

The change-scoped edit framing is now implemented: the shared vocabulary lives
in `app/lib/prompt-sections.ts` (`changeScopeLines`) and is used by both
`collage.ts`'s confirm/final stages and the workbench Prompt Builder node's
Edit mode.

### Quality tier guidance

- `quality="high"` for dense labels, diagrams, small text, or assets destined
  for slides and print.
- Test a higher tier only against an unmet requirement, then walk it back down
  to find the cheapest tier that still passes.
- "A higher setting doesn't guarantee a better result for every prompt."

## Checking the result

Upstream's acceptance checklist:

- Is required text accurate and legible? Are labels and relationships correct?
- Do identities, product shapes, labels, and reference details remain intact?
- Did the edit change **only** what was requested?
- If transparency is required, is there a real alpha channel rather than a
  painted background?

## Quality tier calibration

The guide's walk-down procedure as an operational checklist:

1. Establish a tier that passes your quality bar.
2. Step DOWN one tier at a time, re-running the same prompt, references, and dimensions on the lower tier.
3. Stop at the cheapest tier that still passes your quality bar.
4. Only reach for `xhigh` or `max` against a specific unmet requirement within your latency budget.

Keep the guide's caveat in mind: a higher setting does not guarantee a better result for every prompt.

**[repo]** This app's current tiers (draft=`low`, confirm=`medium`, final=`high`, with final floored at `high`) are unvalidated priors that have never been through this procedure. Because cost here is dominated by reference-image input tokens (~1,391 per reference) rather than output tokens, tier changes are relatively cheap to test against your actual rendering needs.

## Not captured here

The guide's remaining worked examples are not this app's domain and were left
out deliberately: comic strips, children's-book character consistency, logo
design, pitch-deck slides, scientific diagrams, historical scenes, holiday
cards, collectible merchandise, interface mockups, and the runnable
end-to-end Python/Ruby sample (which upstream notes is still pinned to
`gpt-image-2`). The page also carries tabs for GPT Image 2, 1.5, and 1 — only
the 2.5 tab is distilled above.
