# OpenAI image prompting: GPT Image 2.6

This is a summary, in our own words, of
<https://developers.openai.com/api/docs/guides/image-prompting> (GPT Image 2.6
tab), taken from a copy of that page saved on 2026-11-04. GPT Image 2.6 is the
model family this app runs on. OpenAI revises the page, so check the source
before relying on any number here. Older revisions of this file summarised the
2.5 tab. Where 2.6 changed something, this file says so.

Sections marked **[repo]** are notes about Material Collager, not upstream
guidance.

The workbench's **Prompt Expert** node is grounded in a separate, condensed
version of this guide that is written for a model, not a person:
`scripts/cli-bridge/personas/gpt-image-2-6-prompting.md`
(see `docs/cli-bridge.md`). Keep the two in step when the guide changes.

## Model choice

There are two models in the 2.6 family. Both generate, edit, and produce
transparent backgrounds.

| Model | Role |
|---|---|
| `gpt-image-2.6-flare` | The smaller model, for workflows where response time matters most. |
| `gpt-image-2.6-sunburst` | The base model, for demanding detail, layout or edit-accuracy requirements. |

Upstream's starting points when moving to 2.6:

| If today you have... | Test first |
|---|---|
| A GPT Image 2 workflow that already meets your bar, or a 2.5 Flare workflow | `gpt-image-2.6-flare`: check quality and latency on your existing prompts |
| A complex task where GPT Image 2 falls short, or a 2.5 Sunburst workflow | `gpt-image-2.6-sunburst`: check the details that decide whether the image is usable |

Once Sunburst passes, upstream suggests trying Flare with the same prompts,
references, dimensions and quality, and comparing results and response times.

**[repo]** We run Sunburst everywhere (`SUNBURST_MODEL` =
`gpt-image-2.6-sunburst`, in `app/lib/sunburst.ts`). The one exception is the
workbench Test node, which stays pinned to `gpt-image-2.5-sunburst-2026-09-08`
for A/B comparison (`TEST_MODEL_2_5`). Economy mode, and Flare with it, was
removed: Flare costs the same as Sunburst, and Batch supports neither. In this
repo's own measurements, cost is driven by reference-image *input* tokens, so
a faster model is not automatically a cheaper one. Treat any Flare change as an
experiment with a measured before and after.

## Parameters

| Parameter | 2.6 values |
|---|---|
| `model` | `gpt-image-2.6-flare` or `gpt-image-2.6-sunburst` |
| `quality` | `auto`, `low`, `medium`, `high`, `xhigh`, `max`. How much fine detail (texture, small lettering) the model can render. |
| `complexity` | **New in 2.6.** `low`, `medium`, `high`. How much the model plans before rendering. Defaults to `high` on both models when omitted. |
| `size` | `auto` or `WIDTHxHEIGHT`, for example `1024x1024`, `1536x1024`, `1024x1536` |
| `background` | `auto`, `opaque`, `transparent` |
| `output_format` | `png`, `jpeg`, `webp`. **New in 2.6:** generations can also return `svg` and `gif`. |
| `markup` | **New in 2.6**, edits only. A transparent PNG overlay with the same pixel size as the first input image. |

Other 2.6 rules:

- Omit `input_fidelity` on edits.
- 2.6 does not support `reasoning.summary`.
- `output_compression` applies to JPEG and WebP only.

### Custom size constraints

- Both edges must be multiples of 16.
- The aspect ratio must be between 1:3 and 3:1. Upstream's landscape slide
  example uses `1536x864`.

The 2.5 tab also listed these limits; the 2.6 tab does not repeat them, so
re-check them before relying on them:

- Each edge is at most 3,840 px.
- Total pixels are between 655,360 and 8,294,400.
- Anything above 3,686,400 px (2560x1440) is experimental.

**[repo]** `app/lib/image-model-limits.ts` (`classifySize()`) encodes these
limits and marks experimental sizes:

| Surface | Value | Pixels | Status |
| --- | --- | --- | --- |
| `app/lib/collage.ts` (square) | 1920x1920 | 3,686,400 | at the experimental threshold, not above |
| `app/components/workbench/nodes/generation.ts` GENERATION_SIZES | 2048x2048 | 4,194,304 | experimental, kept and labelled |
| `app/components/workbench/nodes/upscaler.manifest.ts` UPSCALE_SIZES | 2048x2048 / 3200x1792 / 3840x2160 | 4,194,304 / 5,734,400 / 8,294,400 | experimental, kept and labelled |

The upscaler keeps its experimental sizes on purpose, because large output is
the whole point of that node.

### Complexity vs quality

This is the main new lever in 2.6. Upstream's advice:

- **Leave complexity at its default for the first run.** On a complex layout,
  check how labels and connected objects were placed.
- **Compare one setting at a time.**
  - To compare complexity, hold `quality` fixed.
  - If the layout is right but small text is hard to read, hold complexity
    fixed and compare quality.
- **`high` complexity suits open-ended prompts**, where the prompt leaves
  design choices (props, lettering placement, composition) to the model.
  Upstream's comparison showed the composition changing noticeably between
  levels on such a prompt.
- **A fully specified prompt** (layout, text and style already set) may look
  much the same at any complexity.
- **Targeted edits: start at `low`** and check that the surrounding details
  survived.

**[repo]** The Workbench sends `complexity` only when a 2.6 render node sets
it (Image Generation, Image Edit, Relight, Variations, Masked Edit, Upscaler,
Collage Board).
When it is unset, the API default (`high`) applies. The 2.5 Test node never
sends it. `/generator` and `/api/generate` do not send it.

### Markup-guided edits

New in 2.6. You draw on a transparent overlay, for example a circle around the
object to change, and describe the change in the prompt.

- The overlay must match the first input image's pixel dimensions, and it
  applies to that image only. Any further images are plain references.
- Do not send `mask` or `prompt_rewriter` with `markup`.
- Ask in the prompt for the drawn mark to be removed from the finished image,
  and compare the rest of the image against the original for unintended
  changes.

**[repo]** The Workbench's Image Edit node sends `markup` as a multipart file
on `/v1/images/edits` when one is set, and never together with a mask.

### SVG and GIF output

Both are new in 2.6 and work on `/v1/images/generations` only.

- **SVG**
  - For scalable or recolourable artwork such as logos.
  - Use `n=1` and omit `stream`, `partial_images`, `output_compression` and
    `prompt_rewriter`.
  - `background="transparent"` works.
  - The base64 payload decodes to SVG XML.
- **GIF**
  - Short loops, controlled by `frame_count` and `frame_duration_ms`.
    Upstream's example uses 9 frames at 200 ms.
  - For a clean loop, give the subject a starting pose to return to, and say
    whether the camera moves.

**[repo]** The Workbench's Image Generation node can request `svg` (n=1, no
compression) and `gif` (`frame_count` / `frame_duration_ms`) when set.

### Transparency and format rules

- Ask for `background="transparent"` **and** use PNG or WebP (or SVG). Also
  ask for an isolated subject in the prompt.
- Keep the returned alpha channel, and check the decoded alpha, especially at
  hair, glass, shadows and edges. A drawn checkerboard is not transparency.
- On later edits of a transparent asset, ask again for the transparent
  background to be preserved.

**[repo]** Compliant. `resolvedBackground` feeds the transparent-background
clause in `buildGenerationPrompt` (`app/lib/collage.ts`). The draft, confirm
and final stages all call that builder, so every stage restates the clause.
`output_compression` is gated behind `outputFormat !== "png"` in
`app/api/generate/route.ts` and `app/api/workbench/edit/route.ts`.

### input_fidelity

The 2.6 guide says to leave it out of edits.

**[repo]** This matches the CLAUDE.md gotcha: Sunburst 2.5 answers HTTP 400
`invalid_input_fidelity_model`, and `SUNBURST_SUPPORTS_INPUT_FIDELITY` is
`false`. Do not re-add the field.

## Migrating a workflow (upstream's steps, condensed)

1. **Save a baseline** from the current model: representative prompts,
   references and outputs. Include hard edits, exact text, product geometry
   and transparent assets.
2. **Test the matching 2.6 model.** 2.5 Flare goes to 2.6 Flare, and 2.5
   Sunburst to 2.6 Sunburst. For GPT Image 2, use the table above.
3. **Keep the first comparison identical**: same prompt, references, size,
   quality and format. Leave complexity at the default.
4. **Inspect the results.** Look at text, layout, identity and whatever
   should have survived the edit. For an edit chain, check the final image
   *and* each intermediate one.
5. **Tune one setting at a time**, quality or complexity. Repeat runs and
   compare how often the output passes and how long it takes.
6. **Roll out per workflow.** Track latency, failures, retries and cost per
   accepted image before widening.

If part of an image must stay pixel-identical, composite the approved edit
into the original. Prompting alone will not hold it.

## Prompting fundamentals

These are unchanged in substance from 2.5.

1. **Define the result.** Name the subject and what the image is for. Give the
   composition, the aspect ratio and the placement rules. For complex
   requests, use labelled sections in the order scene, subject, details,
   constraints.
2. **Pick a format you can maintain.** Prose, sections, JSON-like structures
   and tags all work. No special syntax has hidden power.
3. **Describe what is visible**: materials, light, colour and medium. Ask for
   "photorealistic" outright when you want it.
   - Camera terms change the look; they do not simulate real optics.
   - For wide, low-light or atmospheric scenes, state scale, atmosphere and
     colour rather than relying on mood words.
4. **People and actions.** Describe body framing, relative scale, gaze, and
   how the hands meet objects.
5. **Exact text.**
   - Quote it, place it, describe the typography, and say how many times it
     appears.
   - Spell tricky names letter by letter, and forbid any extra text.
   - Then proof the output. Compare medium and high quality for small or
     dense text.
6. **Separate the change from the constraints.**
   - Say "change only X", then list what must be preserved: identity,
     geometry, layout, lighting, labels.
   - Then list exclusions: text, logos, watermarks.
   - For a fine local edit, also protect saturation, contrast, arrows, camera
     angle and nearby objects.
7. **Number the references and give each a role** (subject, style, clothing,
   background). Say how they combine, and which element goes where.
8. **Iterate one change at a time.** Feed the previous output back in, ask for
   a single change, and restate what must be kept. Compare results before
   adding instructions.

**[repo]** Rule 7 is implemented. `app/lib/collage.ts` emits a numbered
REFERENCE MAP ("Image 1 -> ...") with explicit precedence when Image 1 is a
layout master. The Prompt Expert persona applies the same rule to whatever is
wired into the node. Change-scoped edit wording (rule 6) lives in
`app/lib/prompt-sections.ts` (`changeScopeLines`). Both `collage.ts`'s
confirm and final stages and the Prompt Builder node's Edit mode use it.

## Patterns that map to this app

These are the shapes of upstream's examples, in our words, not their prompts.

- **Change furniture in a room.** This is the closest analogue to a material
  swap. Name the one object to replace, using "ONLY". Add an explicit list of
  what to preserve (camera angle, room lighting, floor shadows, surrounding
  objects), then a sentence keeping everything else unchanged and a positive
  realism cue (contact shadows, material texture). Upstream ran it at
  `1536x1024`, medium quality.
- **Combine references.** The scene is Image 1 and the subject is Image 2.
  Say which element moves, exactly where it lands, that it matches the
  scene's lighting, and that nothing else changes.
- **Style transfer.** Give the style image one role (palette, texture or
  medium), and describe the new subject separately.
- **Transparent product cutout.** Ask for the product isolated and centred,
  with a crisp silhouette and no halo. Keep its geometry and label legibility
  exact, allow light clean-up only, and forbid a backdrop, checkerboard,
  scenery or shadow. Pair this with the transparent API setting.
- **Sketch to photoreal.** Treat the drawing as a spec: keep the layout,
  proportions and perspective, add realism through named materials and
  lighting, and forbid new elements or text.
- **Remove an object.** Name it, preserve everything around it, and keep the
  edit local.
- **Slides, diagrams and charts.** Write them like an artifact spec: name the
  deliverable, the canvas and the hierarchy. Supply the real labels and
  numbers, ask for readable type, and forbid clutter. Use landscape sizes and
  high quality for small text, and check every figure afterwards.
- **Refining across turns.** Start an image, then change one condition (for
  example the weather) with a short follow-up on the previous output.

**[repo]** The draft, confirm and final chain is this "refine across turns"
pattern. Upstream's advice to restate constraints at every step is why the
board instruction and per-item notes ride along on confirm and final, not
just on draft. Prompting alone cannot hold a region pixel-exact, so a
material that must match a spec swatch exactly is a compositing problem.

## Checking the result

Upstream's acceptance checks:

- Is every word legible and correct? Are diagram labels and relationships
  right?
- Are identities, product shapes, labels and reference details intact?
- Did the edit change only what was asked?
- If transparency was needed, does the decoded file really have transparent
  pixels?

When changing prompts or models, compare quality, latency and cost on
representative inputs.

## Quality tier calibration

This is the operational version of "compare one setting at a time":

1. Find a tier that passes your quality bar, with complexity held fixed.
2. Step down one tier at a time, with the same prompt, references and size.
3. Stop at the cheapest tier that still passes.
4. Reach for `xhigh` or `max` only against a specific unmet requirement.

A higher setting does not guarantee a better result for every prompt.

**[repo]** The app's tiers (draft `low`, confirm `medium`, final `high`,
with final floored at `high`) are unvalidated priors that have never been
through this procedure. Reference-image input tokens (about 1,391 per
reference) dominate the cost, not output, so testing tier changes is
relatively cheap.

## Not captured here

Some of upstream's examples were left out because they are not this app's
domain:

- comic strips;
- children's-book character consistency;
- logo design (apart from the SVG note above);
- historical scenes;
- holiday cards and collectible merchandise;
- interface mockups;
- inserting a person into a scene, and changing clothing while preserving
  identity;
- the runnable Python and Ruby sample.

The page also carries tabs for GPT Image 2.5, 2, 1.5 and 1. Only the 2.6 tab
is summarised here.
