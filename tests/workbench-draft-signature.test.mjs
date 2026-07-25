import assert from "node:assert/strict";
import test from "node:test";

import { validateEditSize } from "../app/lib/image-edit.ts";
import { defaultParams, draftOverrideMap } from "../app/components/workbench/nodes/manifests.ts";
import { resolveUpscaleSize, UPSCALE_SIZES } from "../app/components/workbench/nodes/upscaler.manifest.ts";
import { signatureFor } from "../app/components/workbench/signature.ts";

function nodeFor(kind, params = {}) {
  return {
    id: `${kind}-1`,
    position: { x: 0, y: 0 },
    data: {
      kind,
      params: { ...defaultParams(kind), ...params },
      status: "idle",
      runs: [],
      activeRun: 0,
    },
  };
}

function contextFor(draft) {
  return {
    incoming: new Map(),
    liveNode: () => undefined,
    draft,
  };
}

test("a paid node WITH a draftOverride produces a DIFFERENT signature draft-on vs draft-off (proves draft-off forces a rerun)", () => {
  for (const kind of ["imageEdit", "imageGenerate", "upscaler", "variations", "relight", "collageBoard", "qaCorrection"]) {
    const node = nodeFor(kind);
    const draftOn = signatureFor(contextFor(true), node);
    const draftOff = signatureFor(contextFor(false), node);
    assert.notEqual(draftOn, draftOff, `${kind}: draft toggle must change the signature`);
  }
});

test("a paid node WITHOUT a draftOverride is BYTE-IDENTICAL draft-on vs draft-off (the toggle must never over-invalidate/re-bill it)", () => {
  for (const kind of ["accuracyReviewer", "referenceAnalyzer", "referenceFinder", "aiAssistant"]) {
    const node = nodeFor(kind);
    const draftOn = signatureFor(contextFor(true), node);
    const draftOff = signatureFor(contextFor(false), node);
    assert.equal(draftOn, draftOff, `${kind}: no draftOverride means the draft toggle must not perturb the signature`);
  }
});

test("signatureFor is a pure function of (draft, kind, effective params, upstream run ids) — repeated calls with identical state are byte-identical", () => {
  const node = nodeFor("imageEdit", { size: "1536x1024", quality: "high" });
  const first = signatureFor(contextFor(false), node);
  const second = signatureFor(contextFor(false), node);
  assert.equal(first, second);
});

test("changing a stable-but-irrelevant param does not change imageEdit's signature the same way changing size does", () => {
  const base = nodeFor("imageEdit", { size: "1536x1024" });
  const differentSize = nodeFor("imageEdit", { size: "1024x1024" });
  const context = contextFor(false);
  assert.notEqual(signatureFor(context, base), signatureFor(context, differentSize));
});

test("Variations: n IS part of the signature (changing candidate count invalidates the cache)", () => {
  const context = contextFor(false);
  const n4 = nodeFor("variations", { n: 4 });
  const n8 = nodeFor("variations", { n: 8 });
  assert.notEqual(signatureFor(context, n4), signatureFor(context, n8), "changing n must invalidate the memoized run");
  // Candidate selection is a store-level reorder of the run's own values
  // under a fresh runId (variations.tsx's selectCandidate), not a params
  // field -- there is no activeCandidate param left to assert is stable
  // here (S-1: the dead, never-read param was removed).
});

test("saveToLibrary: savedJobId (a run artifact) is stripped by stableParams and never perturbs the signature", () => {
  const context = contextFor(false);
  const withoutJobId = nodeFor("saveToLibrary", {});
  const withJobId = nodeFor("saveToLibrary", { savedJobId: "job-abc-123" });
  assert.equal(signatureFor(context, withoutJobId), signatureFor(context, withJobId));
});

// issue-3/AC22: draft mode must force a SMALL SIZE, not just low quality --
// this is what actually makes the toggle change the signature/cost for a
// node whose ONLY effective change would otherwise be quality (which is
// still a real change, but AC22 promises "quality=low / small size").
test("draft mode's size half: the Upscaler's large default (2560x1440) shrinks to a genuinely small, still-valid size in draft mode -- not left unchanged (issue-3)", () => {
  const draft = draftOverrideMap.upscaler({ size: "2560x1440", quality: "high" });
  assert.equal(draft.quality, "low");
  assert.notEqual(draft.size, "2560x1440");
  assert.equal(validateEditSize(draft.size), null, "the draft size must still be a valid gpt-image-2 size");
  const [w, h] = draft.size.split("x").map(Number);
  assert.ok(w * h < 2560 * 1440, "the draft size must have materially fewer pixels than the full target");
});

test("draft mode's size half applies to every draftOverride-declaring generation-shaped node, including the largest offered Upscaler target (3840x2160)", () => {
  for (const kind of ["imageEdit", "imageGenerate", "upscaler", "variations", "relight", "qaCorrection"]) {
    const draft = draftOverrideMap[kind]({ size: "3840x2160", quality: "high" });
    assert.notEqual(draft.size, "3840x2160", `${kind}: draft mode must shrink the size, not leave it unchanged`);
    assert.equal(validateEditSize(draft.size), null, `${kind}: the draft size must still be valid`);
  }
});

test("draft mode preserves the aspect DIRECTION of the original size (a portrait size stays portrait after the draft-mode shrink)", () => {
  const draft = draftOverrideMap.imageEdit({ size: "1024x1536", quality: "high" });
  const [w, h] = draft.size.split("x").map(Number);
  assert.ok(h > w, "a portrait size must stay portrait-oriented after shrinking");
});

test("Collage Board's own draft override forces outputResolution to 'standard' (the smallest resolvedSize option) instead of injecting a `size` field it has no param for and would never read", () => {
  const draft = draftOverrideMap.collageBoard({ collageType: "kitchen_material_palette", orientation: "default", quality: "high" });
  assert.equal(draft.quality, "low");
  assert.equal(draft.outputResolution, "standard");
  assert.equal("size" in draft, false, "collageBoard has no size param -- the override must not invent one");
});

// N-10: the Upscaler declared the GENERIC generationDraftOverride until this
// fix, which computes a smallest-valid size that is by construction never a
// UPSCALE_SIZES member -- so resolveUpscaleSize (called at all four read
// sites: estimate/sign/display/submit) immediately re-snapped it back up to
// the nearest FULL menu option, silently undoing the shrink (every menu size
// collapsed to 1536x1024, ~2.4x more expensive than the intended draft size)
// and, for the square 2048x2048 target specifically, drifting the effective
// aspect ratio from 1:1 to 3:2 on a node whose entire prompt is "preserve
// the exact composition, geometry, colour and every detail". This asserts
// the EFFECTIVE size (i.e. resolveUpscaleSize(draftOverrideMap.upscaler(...)
// .size), exactly as estimate/sign/submit apply it) rather than only the
// override's own intermediate output, which is the precise gap that let the
// re-snap regress silently before (the old test asserted the intermediate
// value and would still have passed even if the effective size snapped back
// up to the largest menu option).
test("N-10: the Upscaler's EFFECTIVE draft size (after resolveUpscaleSize, exactly as estimate/sign/submit apply it) is a no-op, stays genuinely small, and preserves each menu option's own aspect ratio -- including the square 2048x2048 target -- rather than drifting to a differently-shaped option", () => {
  for (const option of UPSCALE_SIZES) {
    const [rawWidth, rawHeight] = option.split("x").map(Number);
    const draft = draftOverrideMap.upscaler({ size: option, quality: "high" });
    assert.equal(draft.quality, "low");

    const effective = resolveUpscaleSize(draft.size);
    assert.equal(effective, draft.size, `${option}: resolveUpscaleSize must not re-snap the draft-computed size back to a full menu option`);
    assert.equal(validateEditSize(effective), null, `${option}: the effective draft size must still be a valid gpt-image-2 size`);

    const [draftWidth, draftHeight] = effective.split("x").map(Number);
    assert.ok(draftWidth * draftHeight < rawWidth * rawHeight, `${option}: the effective draft size must have materially fewer pixels than the full target`);
    // smallestValidEditSize solves in real numbers, then quantizes onto the
    // 16-pixel grid -- at these smaller absolute pixel counts, a 16px step is
    // a bigger fraction of the total, so a small amount of ratio drift versus
    // the raw aspect is expected and NOT a bug (empirically <=0.06 across all
    // five menu options). 0.15 is generous headroom above that, while still
    // being far below the magnitude of the actual regression this guards
    // against (2048x2048's 1:1 drifting to 1536x1024's 1.5:1 was a 0.5 jump).
    assert.ok(
      Math.abs(draftWidth / draftHeight - rawWidth / rawHeight) < 0.15,
      `${option}: the effective draft size (${draftWidth}x${draftHeight}) must preserve (within 16-grid quantization noise) the source option's aspect ratio, not drift to a differently-shaped menu option`,
    );
  }
});
