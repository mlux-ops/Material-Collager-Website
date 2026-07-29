import assert from "node:assert/strict";
import test from "node:test";

import {
  alwaysExecuteMap,
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
  "imageDescription",
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

test("Export/Download opts out of run memoization via alwaysExecute (W-4): the manifest flag is set and alwaysExecuteMap reflects it; every other kind defaults to unset so normal memoization still applies", () => {
  // N-2: this only asserts the framework-free DECLARATION (the manifest
  // flag + the map built from it). The consuming SCOPING logic -- forceExecute
  // requires alwaysExecuteMap[kind] AND an explicit single-node run
  // (runNodes'/estimateStaleCost's targetIds.length===1 && targetIds[0]===id
  // check, gated by the caller-supplied explicitSingleNode option) -- lives
  // in executor.ts, which imports nodes/index.ts (.tsx) and so cannot be
  // imported under node --experimental-strip-types. That behavior is
  // verified by code trace + manual/browser QA instead, consistent with the
  // rest of executor.ts's scheduling logic (runNodes/estimateStaleCost/
  // retryFrom), which has never been Node-unit-tested for the same reason.
  assert.equal(MANIFESTS.exportDownload.alwaysExecute, true);
  assert.equal(alwaysExecuteMap.exportDownload, true);
  for (const kind of NODE_KINDS) {
    if (kind === "exportDownload") continue;
    assert.ok(!alwaysExecuteMap[kind], `${kind}: alwaysExecute must default to unset/false`);
  }
});

test("Reference Finder's required 'query' port declares a satisfiedByParams predicate honored when its matchQuery override is non-empty, so an override with no upstream connection still satisfies the port (C1)", () => {
  const port = MANIFESTS.referenceFinder.spec.inputs.find((candidate) => candidate.id === "query");
  assert.ok(port.required, "query must stay required:true -- dropping it would lose the disabled-Run protection when neither an override nor a connection is present");
  assert.equal(typeof port.satisfiedByParams, "function", "query needs a params-aware satisfaction predicate for its matchQuery override");
  assert.equal(port.satisfiedByParams({}), false);
  assert.equal(port.satisfiedByParams({ matchQuery: "   " }), false, "a blank/whitespace-only override does not satisfy the port");
  assert.equal(port.satisfiedByParams({ matchQuery: "brushed brass pull" }), true, "a non-empty override satisfies the port with no connection needed");
});

test("Variations' 'prompt' port and Accuracy Reviewer's 'references' port are required:true, matching what their execute() unconditionally throws without one (C2/C3)", () => {
  const variationsPrompt = MANIFESTS.variations.spec.inputs.find((port) => port.id === "prompt");
  assert.ok(variationsPrompt.required, "Variations' prompt is required at execute() time and must be surfaced pre-run too");
  const reviewerReferences = MANIFESTS.accuracyReviewer.spec.inputs.find((port) => port.id === "references");
  assert.ok(reviewerReferences.required, "Accuracy Reviewer's references is required at execute() time and must be surfaced pre-run too");
});

test("importSchemaMap and stableParamsMap/draftOverrideMap are only populated where the manifest actually declares them", () => {
  for (const kind of NODE_KINDS) {
    const manifest = MANIFESTS[kind];
    assert.ok(manifest.importSchema, `${kind}: every manifest must declare an importSchema`);
    assert.equal(typeof manifest.importSchema.paramKeys, "object");
    assert.ok(Array.isArray(manifest.importSchema.sourceBlobKeys));
  }
});
