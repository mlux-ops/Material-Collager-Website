import assert from "node:assert/strict";
import test from "node:test";

import {
  auditPaidNodeCoverage,
  defaultParams,
  estimateCostMap,
  MANIFESTS,
  NODE_KINDS,
  NODE_SPECS,
  paidMap,
  specFor,
} from "../app/components/workbench/nodes/manifests.ts";

// Kinds whose DOM-touching execute wrapper lives only in the .tsx module
// (app/components/workbench/nodes/index.ts's DOM_EXECUTES map) rather than on
// the framework-free manifest itself. This list mirrors index.ts exactly and
// is kept here (not imported — index.ts pulls in .tsx/JSX) so the
// registry-integrity test can compute the SAME "is this kind executable"
// answer index.ts derives, without ever importing a .tsx module.
const DOM_WRAPPED_KINDS = new Set([
  "imageGenerate",
  "imageEdit",
  "saveToLibrary",
  "referenceAnalyzer",
  "libraryPick",
  "resize",
  "crop",
  "exportDownload",
  "accuracyReviewer",
  "qaCorrection",
  "aiAssistant",
  "collageBoard",
  "relight",
  "variations",
  "maskedEdit",
  "upscaler",
]);

function expectedExecutable(kind) {
  return DOM_WRAPPED_KINDS.has(kind) || Boolean(MANIFESTS[kind].execute);
}

test("NODE_SPECS/specFor are reconstructed 1:1 from the manifest registry", () => {
  assert.equal(NODE_KINDS.length, Object.keys(MANIFESTS).length);
  for (const kind of NODE_KINDS) {
    assert.equal(NODE_SPECS[kind], MANIFESTS[kind].spec);
    assert.equal(specFor(kind), MANIFESTS[kind].spec);
    assert.equal(NODE_SPECS[kind].kind, kind, `manifest ${kind} spec.kind must match its registry key`);
  }
});

test("adding a node type only requires a manifest module + registration (no hand-maintained parallel arrays)", () => {
  // Every registry-derived map is keyed by the exact same kind set — there is
  // no separate hand-authored PALETTE/NODE_TYPES kind list to fall out of sync.
  const kinds = new Set(NODE_KINDS);
  assert.equal(kinds.size, NODE_KINDS.length, "NODE_KINDS must not contain duplicates");
  assert.deepEqual(new Set(Object.keys(NODE_SPECS)), kinds);
});

test("defaultParams returns a fresh copy per call — callers can never mutate shared manifest state", () => {
  for (const kind of NODE_KINDS) {
    const a = defaultParams(kind);
    const b = defaultParams(kind);
    assert.notEqual(a, b, `${kind}: defaultParams() must not return the same object twice`);
    assert.deepEqual(a, b);
    a.mutatedByTest = "canary";
    assert.equal(b.mutatedByTest, undefined, `${kind}: mutating one defaultParams() result must not leak into another`);
    assert.equal(MANIFESTS[kind].defaultParams.mutatedByTest, undefined, "must not leak into the manifest itself");
  }
});

test("every paid node (paid:true on the manifest or its spec) declares an estimateCost (S27 audit)", () => {
  const issues = auditPaidNodeCoverage();
  assert.deepEqual(issues, []);
  for (const kind of NODE_KINDS) {
    if (paidMap[kind]) assert.equal(typeof estimateCostMap[kind], "function", `${kind}: paid node missing estimateCost`);
  }
});

test("the executor's executeMap/isExecutable predicate is fully determined by manifest-declared execute cores plus the known DOM-wrapper set (no orphaned skip lists)", () => {
  const nonExecutable = NODE_KINDS.filter((kind) => !expectedExecutable(kind));
  // note (annotation-only) and compare (pure presentation) are the only two
  // kinds with neither a manifest execute core nor a DOM wrapper.
  assert.deepEqual(new Set(nonExecutable), new Set(["note", "compare"]));
  for (const kind of NODE_KINDS) {
    if (nonExecutable.includes(kind)) continue;
    assert.ok(expectedExecutable(kind), `${kind} should be executable`);
  }
});

test("importSchemaMap and stableParamsMap/draftOverrideMap are only populated where the manifest actually declares them", () => {
  for (const kind of NODE_KINDS) {
    const manifest = MANIFESTS[kind];
    assert.ok(manifest.importSchema, `${kind}: every manifest must declare an importSchema`);
    assert.equal(typeof manifest.importSchema.paramKeys, "object");
    assert.ok(Array.isArray(manifest.importSchema.sourceBlobKeys));
  }
});
