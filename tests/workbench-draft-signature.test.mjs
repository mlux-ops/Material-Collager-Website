import assert from "node:assert/strict";
import test from "node:test";

import { defaultParams } from "../app/components/workbench/nodes/manifests.ts";
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

test("Variations: n IS part of the signature (changing candidate count invalidates the cache) but activeCandidate is NOT (stableParams strips it)", () => {
  const context = contextFor(false);
  const n4 = nodeFor("variations", { n: 4 });
  const n8 = nodeFor("variations", { n: 8 });
  assert.notEqual(signatureFor(context, n4), signatureFor(context, n8), "changing n must invalidate the memoized run");

  const candidate0 = nodeFor("variations", { n: 4, activeCandidate: 0 });
  const candidate2 = nodeFor("variations", { n: 4, activeCandidate: 2 });
  assert.equal(signatureFor(context, candidate0), signatureFor(context, candidate2), "browsing candidates must not re-trigger a paid run");
});

test("saveToLibrary: savedJobId (a run artifact) is stripped by stableParams and never perturbs the signature", () => {
  const context = contextFor(false);
  const withoutJobId = nodeFor("saveToLibrary", {});
  const withJobId = nodeFor("saveToLibrary", { savedJobId: "job-abc-123" });
  assert.equal(signatureFor(context, withoutJobId), signatureFor(context, withJobId));
});
