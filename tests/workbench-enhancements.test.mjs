import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { collectFinalImageOutputs } from "../app/components/workbench/final-outputs.ts";
import { MANIFESTS, outputValuesFor } from "../app/components/workbench/nodes/manifests.ts";
import { EXPORT_FORMAT, EXPORT_VERSION, validateImport } from "../app/components/workbench/export-import.ts";
import { estimateSunburstCost, generationDraftOverride } from "../app/components/workbench/nodes/generation.ts";
import { buildMaskedReferencePrompt, usesRetiredEngine } from "../app/components/workbench/nodes/maskedEdit.manifest.ts";
import { signatureFor } from "../app/components/workbench/signature.ts";
import { SUNBURST_MODEL } from "../app/lib/sunburst.ts";
import { IMAGE_DESCRIPTION_INSTRUCTION } from "../app/components/workbench/nodes/imageDescription.manifest.ts";
import {
  channelCorrection,
  clampPatchFeather,
  featherRadiusPx,
  PATCH_COLOR_GAIN_MAX,
  PATCH_COLOR_GAIN_MIN,
  PATCH_FEATHER_DEFAULT,
  PATCH_FEATHER_MAX_PX,
  resolvePatchFit,
} from "../app/components/workbench/nodes/patch.manifest.ts";
import { replaceTextOutput } from "../app/components/workbench/run-output.ts";

function image(cacheKey) {
  return { kind: "image", cacheKey, url: `blob:${cacheKey}` };
}

function node(id, kind, run, params = {}) {
  return {
    id,
    type: kind,
    position: { x: 0, y: 0 },
    data: {
      kind,
      params,
      status: run ? "done" : "idle",
      runs: run ? [run] : [],
      activeRun: 0,
    },
  };
}

test("Masked Edit declares a GPT-native optional reference image plus dedicated reference guidance", () => {
  const manifest = MANIFESTS.maskedEdit;
  const reference = manifest.spec.inputs.find((port) => port.id === "reference");

  assert.deepEqual(reference, { id: "reference", kind: "image", label: "Reference image" });
  assert.equal(manifest.defaultParams.referenceInstruction, "");
  assert.equal(manifest.importSchema.paramKeys.referenceInstruction.type, "string");

  assert.equal(buildMaskedReferencePrompt("Replace the tile.", "", false), "Replace the tile.");
  assert.match(
    buildMaskedReferencePrompt("Replace the tile.", "Match its veining, not its layout.", true),
    /Replace the tile[\s\S]*second input image[\s\S]*Match its veining, not its layout/i,
  );
});

test("Masked Edit has a single Sunburst backend: no engine, FLUX or Workers AI params remain", () => {
  const manifest = MANIFESTS.maskedEdit;
  for (const key of ["engine", "fluxGuidance", "fluxSeed"]) {
    assert.equal(key in manifest.defaultParams, false, `${key} must not ship as a default`);
    assert.equal(key in manifest.importSchema.paramKeys, false, `${key} must not be importable`);
  }
  assert.equal(manifest.defaultParams.model, SUNBURST_MODEL);
  assert.deepEqual(manifest.importSchema.paramKeys.model.values, [SUNBURST_MODEL]);
});

function maskedExport(params) {
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: Date.now(),
    graphOnly: true,
    nodes: [{ id: "masked-legacy", kind: "maskedEdit", position: { x: 0, y: 0 }, params }],
    edges: [],
    images: {},
  };
}

for (const engine of ["workers-ai", "flux-fill"]) {
  test(`importing a saved Masked Edit on the retired "${engine}" engine yields a Sunburst node`, () => {
    const result = validateImport(maskedExport({
      engine,
      fluxGuidance: 45,
      fluxSeed: 7,
      prompt: "ignored",
      size: "1024x1024",
      quality: "high",
      maskRegionX: 10,
      maskRegionY: 20,
      maskRegionWidth: 300,
      maskRegionHeight: 400,
    }));
    const [node] = result.nodes;
    assert.equal(node.kind, "maskedEdit");
    assert.equal("engine" in node.params, false);
    assert.equal("fluxGuidance" in node.params, false);
    assert.equal("fluxSeed" in node.params, false);
    assert.equal(node.params.model, SUNBURST_MODEL);
    // Settings that still mean something survive the migration.
    assert.equal(node.params.size, "1024x1024");
    assert.equal(node.params.quality, "high");
    assert.equal(node.params.maskRegionWidth, 300);
  });

  test(`a persisted Masked Edit still carrying "${engine}" is billed, drafted and signed as a Sunburst edit`, () => {
    const manifest = MANIFESTS.maskedEdit;
    // persistence.ts restores `{ ...defaultParams, ...stored.params }`, so a
    // reloaded graph keeps the dead keys; nothing may act on them.
    const legacy = { ...manifest.defaultParams, engine, fluxGuidance: 30, fluxSeed: 3 };
    const current = { ...manifest.defaultParams };
    assert.equal(usesRetiredEngine(legacy), true);

    const estimate = manifest.estimateCost({ params: legacy, inputImages: 1 });
    assert.equal(estimate, estimateSunburstCost({ params: current, inputImages: 1 }));
    assert.notEqual(estimate, 0, "a formerly free Workers AI node must not show $0 and then bill Sunburst");
    assert.deepEqual(manifest.draftOverride(legacy), generationDraftOverride(legacy));

    // The old SD/FLUX run was signed with the engine in it: the signature must
    // move so the cached output is stale and the next run goes to Sunburst.
    const context = { incoming: new Map(), liveNode: () => undefined, draft: false };
    const asNode = (params) => node("m", "maskedEdit", undefined, params);
    const stable = manifest.stableParams(legacy);
    assert.equal("engine" in stable, false);
    assert.equal("fluxGuidance" in stable, false);
    assert.equal("fluxSeed" in stable, false);
    assert.equal(signatureFor(context, asNode(legacy)), signatureFor(context, asNode(current)));
  });
}

test("an existing GPT Image Masked Edit keeps its signature, so its cached run is not re-billed", () => {
  const manifest = MANIFESTS.maskedEdit;
  const saved = { ...manifest.defaultParams, engine: "gpt-image", fluxGuidance: 30 };
  assert.equal(usesRetiredEngine(saved), false);
  assert.deepEqual(manifest.stableParams(saved), saved);
});

test("Masked Edit executes only through /api/workbench/edit", async () => {
  const source = await readFile(new URL("../app/components/workbench/nodes/maskedEdit.tsx", import.meta.url), "utf8");
  assert.match(source, /fetch\("\/api\/workbench\/edit"/);
  assert.doesNotMatch(source, /\/api\/workbench\/inpaint/);
  assert.doesNotMatch(source, /fluxGuidance|fluxSeed|"workers-ai"|"flux-fill"|<select/);
});

test("Patch declares two image inputs plus an optional Region mask input and stays a free, blob-owning-free client node", () => {
  const manifest = MANIFESTS.patch;

  assert.deepEqual(
    manifest.spec.inputs.map((port) => [port.id, port.required ?? false]),
    [["base", true], ["patch", true], ["region", false]],
  );
  assert.equal(manifest.spec.inputs.find((port) => port.id === "region").kind, "mask");
  // Crop's Region output is what feeds that port.
  assert.deepEqual(MANIFESTS.crop.spec.outputs.map((port) => [port.id, port.kind]), [["image", "image"], ["region", "mask"]]);
  assert.equal(manifest.spec.paid ?? false, false, "canvas compositing costs nothing");
  assert.equal(manifest.paid ?? false, false);
  // The region is re-rendered from maskShapes at execute time, so unlike
  // Masked Edit this node caches no mask blob to persist or GC.
  assert.deepEqual(manifest.importSchema.sourceBlobKeys, []);
  assert.equal(manifest.defaultParams.patchColorMatch, true);
  assert.equal(manifest.defaultParams.patchFit, "auto");
});

test("Patch auto-detects whether the edited image is a full frame or a crop of the region", () => {
  const base = 1500 / 1000;   // 3:2 frame
  const region = 400 / 400;   // square region inside it

  // A square patch matches the region, not the frame.
  assert.equal(resolvePatchFit("auto", 1, base, region), "region");
  // A 3:2 patch matches the frame.
  assert.equal(resolvePatchFit("auto", base, base, region), "aligned");
  // An explicit choice always wins over the heuristic.
  assert.equal(resolvePatchFit("aligned", 1, base, region), "aligned");
  assert.equal(resolvePatchFit("region", base, base, region), "region");
  // Degenerate inputs fall back to the safer mode rather than throwing.
  assert.equal(resolvePatchFit("auto", 0, base, region), "aligned");
  assert.equal(resolvePatchFit("auto", Number.NaN, base, region), "aligned");
  // Ties go to aligned: a region covering the whole frame is ambiguous.
  assert.equal(resolvePatchFit("auto", base, base, base), "aligned");
});

test("Patch feather is resolution-independent and capped in absolute pixels", () => {
  assert.equal(clampPatchFeather(""), PATCH_FEATHER_DEFAULT, "a cleared field reverts to the default");
  assert.equal(clampPatchFeather(-5), 0);
  assert.equal(clampPatchFeather(999), 10);

  // Same percentage, two resolutions -> proportional bands, so a graph re-run
  // at a larger size keeps the same seam.
  assert.equal(featherRadiusPx(1, 1000, 2000), 10);
  assert.equal(featherRadiusPx(1, 2000, 4000), 20);
  // ...until the absolute ceiling, which stops a feather becoming a smear.
  assert.equal(featherRadiusPx(10, 40000, 40000), PATCH_FEATHER_MAX_PX);
  assert.equal(featherRadiusPx(0, 1000, 1000), 0, "zero feather means a hard edge");
});

test("Patch colour correction maps the patch onto the base's statistics, with bounded gain", () => {
  // Patch is uniformly 20 levels darker with identical spread -> pure offset.
  const shifted = channelCorrection(120, 10, 100, 10);
  assert.equal(shifted.gain, 1);
  assert.equal(shifted.offset, 20);
  assert.equal(shifted.gain * 100 + shifted.offset, 120, "the correction lands the patch mean on the base mean");

  // A flat patch channel has no spread to rescale; only the offset is real.
  const flat = channelCorrection(120, 10, 100, 0);
  assert.equal(flat.gain, 1);
  assert.equal(flat.offset, 20);

  // Wild ratios clamp rather than inventing contrast.
  assert.equal(channelCorrection(128, 80, 128, 1).gain, PATCH_COLOR_GAIN_MAX);
  assert.equal(channelCorrection(128, 1, 128, 80).gain, PATCH_COLOR_GAIN_MIN);
});

test("Variations keeps an aggregate output and declares ten stable individual image outputs", () => {
  const manifest = MANIFESTS.variations;
  assert.equal(manifest.defaultParams.separateOutputs, false);
  assert.equal(manifest.importSchema.paramKeys.separateOutputs.type, "boolean");
  assert.deepEqual(
    manifest.spec.outputs.map((port) => port.id),
    ["image", ...Array.from({ length: 10 }, (_, index) => `variation-${index + 1}`)],
  );

  const stable = manifest.stableParams({ n: 4, quality: "medium", separateOutputs: true });
  assert.equal("separateOutputs" in stable, false, "the handle-visibility toggle must not trigger a paid generation");
});

test("individual Variations ports resolve legacy aggregate-only runs by original candidate index", () => {
  const candidate0 = image("variations-1:run-a:0");
  const candidate1 = image("variations-1:run-a:1");
  const candidate2 = image("variations-1:run-a:2");
  const run = {
    runId: "selection-run",
    signature: "sig",
    at: 1,
    // Candidate 2 is selected and therefore first in the aggregate array.
    values: [[candidate2, candidate0, candidate1]],
  };
  const variations = node("variations-1", "variations", run, { n: 3, separateOutputs: true });

  assert.deepEqual(outputValuesFor(variations, run, "variation-1"), [candidate0]);
  assert.deepEqual(outputValuesFor(variations, run, "variation-2"), [candidate1]);
  assert.deepEqual(outputValuesFor(variations, run, "variation-3"), [candidate2]);
});

test("Image Description is a required-image, editable-text-producing paid node with the requested focus", () => {
  const manifest = MANIFESTS.imageDescription;
  assert.equal(manifest.spec.inputs.find((port) => port.id === "image")?.required, true);
  assert.deepEqual(manifest.spec.outputs, [{ id: "description", kind: "text", label: "Description" }]);
  assert.equal(manifest.paid, true);
  assert.match(IMAGE_DESCRIPTION_INSTRUCTION, /lighting/i);
  assert.match(IMAGE_DESCRIPTION_INSTRUCTION, /materiality/i);
  assert.match(IMAGE_DESCRIPTION_INSTRUCTION, /organization/i);
});

test("editing a generated text output updates only that value and mints a downstream-invalidating run identity", () => {
  const source = {
    runId: "generated",
    signature: "same-paid-request",
    at: 1,
    values: [[{ kind: "text", text: "Original description" }]],
    usage: { model: "vision" },
  };

  const edited = replaceTextOutput(source, 0, 0, "Edited description", "edited-run", 2);
  assert.equal(edited.runId, "edited-run");
  assert.equal(edited.signature, source.signature, "manual editing must not make the paid request look stale");
  assert.equal(edited.at, 2);
  assert.equal(edited.values[0][0].text, "Edited description");
  assert.deepEqual(edited.usage, source.usage);
  assert.equal(source.values[0][0].text, "Original description", "the original run must stay immutable");
});

test("final-output collection deduplicates aggregate/individual variation handles", () => {
  const candidates = [image("v:run:0"), image("v:run:1"), image("v:run:2")];
  const run = { runId: "run", signature: "sig", at: 1, values: [candidates] };
  const variations = node("v", "variations", run, { n: 3, separateOutputs: true });

  const outputs = collectFinalImageOutputs([variations], []);
  assert.deepEqual(outputs.map((entry) => entry.value.cacheKey), candidates.map((entry) => entry.cacheKey));
  assert.equal(new Set(outputs.map((entry) => entry.identity)).size, 3);
});

test("final-output collection saves only the selected aggregate candidate until separate variation outputs are enabled", () => {
  const candidate0 = image("v:paid-run:0");
  const candidate1 = image("v:paid-run:1");
  const paidRun = { runId: "paid-run", signature: "same-request", at: 1, values: [[candidate0, candidate1]] };
  const aggregateOnly = node("v", "variations", paidRun, { n: 2, separateOutputs: false });
  assert.deepEqual(
    collectFinalImageOutputs([aggregateOnly], []).map((entry) => entry.value.cacheKey),
    [candidate0.cacheKey],
  );

  const selectionRun = { ...paidRun, runId: "selection-run", at: 2, values: [[candidate1, candidate0]] };
  const selected = node("v", "variations", selectionRun, { n: 2, separateOutputs: false });
  const selectedOutput = collectFinalImageOutputs([selected], [])[0];
  assert.equal(selectedOutput.value.cacheKey, candidate1.cacheKey);
  assert.equal(
    selectedOutput.identity,
    collectFinalImageOutputs([node("v", "variations", { ...paidRun, values: [[candidate1, candidate0]] }, { n: 2 })], [])[0].identity,
    "a presentation-only selection runId must not make unchanged image content save twice",
  );
});

test("final-output collection follows the image input of a text/report/download terminal but skips explicit Save to Library", () => {
  const photoRun = { runId: "photo-run", signature: "photo", at: 1, values: [[image("photo:src")]] };
  const photo = node("photo", "photo", photoRun);
  const descriptionRun = {
    runId: "description-run",
    signature: "description",
    at: 2,
    values: [[{ kind: "text", text: "Description" }]],
  };
  const description = node("description", "imageDescription", descriptionRun);
  const edgeToDescription = {
    id: "e1",
    source: "photo",
    sourceHandle: "image",
    target: "description",
    targetHandle: "image",
  };
  assert.deepEqual(
    collectFinalImageOutputs([photo, description], [edgeToDescription]).map((entry) => entry.value.cacheKey),
    ["photo:src"],
  );

  const save = node("save", "saveToLibrary", {
    runId: "save-run",
    signature: "save",
    at: 3,
    values: [],
    usage: { jobId: "already-saved" },
  });
  const edgeToSave = { ...edgeToDescription, id: "e2", target: "save" };
  assert.deepEqual(collectFinalImageOutputs([photo, save], [edgeToSave]), []);
});

test("the workbench toolbar exposes both requested controls", async () => {
  const source = await readFile(new URL("../app/components/workbench/WorkbenchApp.tsx", import.meta.url), "utf8");
  assert.match(source, /Clear all nodes/i);
  assert.match(source, /Auto-save final/i);
  assert.match(
    source,
    /estimateStaleCost\(terminalIds\)\.staleCount > 0/,
    "cancelled or otherwise incomplete runs must not auto-save stale final images",
  );
});
