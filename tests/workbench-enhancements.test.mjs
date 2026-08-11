import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { collectFinalImageOutputs } from "../app/components/workbench/final-outputs.ts";
import { MANIFESTS, outputValuesFor } from "../app/components/workbench/nodes/manifests.ts";
import {
  buildMaskedReferencePrompt,
  clampFluxGuidance,
  FLUX_FILL_GUIDANCE_DEFAULT,
  FLUX_FILL_GUIDANCE_MAX,
  FLUX_FILL_GUIDANCE_MIN,
  FLUX_FILL_SEED_MAX,
  maskedReferenceSupported,
  normalizeFluxSeed,
} from "../app/components/workbench/nodes/maskedEdit.manifest.ts";
import { IMAGE_DESCRIPTION_INSTRUCTION } from "../app/components/workbench/nodes/imageDescription.manifest.ts";
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
  assert.equal(maskedReferenceSupported("gpt-image"), true);
  assert.equal(maskedReferenceSupported("workers-ai"), false);
  assert.equal(maskedReferenceSupported("flux-fill"), false);

  assert.equal(buildMaskedReferencePrompt("Replace the tile.", "", false), "Replace the tile.");
  assert.match(
    buildMaskedReferencePrompt("Replace the tile.", "Match its veining, not its layout.", true),
    /Replace the tile[\s\S]*second input image[\s\S]*Match its veining, not its layout/i,
  );
});

test("Masked Edit exposes FLUX Fill guidance and seed, defaulting guidance below BFL's literal-prompt 60", () => {
  const manifest = MANIFESTS.maskedEdit;

  assert.equal(manifest.defaultParams.fluxGuidance, FLUX_FILL_GUIDANCE_DEFAULT);
  assert.ok(FLUX_FILL_GUIDANCE_DEFAULT < 60, "the default must blend material fills rather than render prompts literally");
  assert.equal(manifest.importSchema.paramKeys.fluxGuidance.type, "number");
  assert.equal(manifest.importSchema.paramKeys.fluxSeed.integer, true);
  // Unset seed means "random per run", so it must not ship a default.
  assert.equal("fluxSeed" in manifest.defaultParams, false);

  assert.equal(clampFluxGuidance(35), 35);
  assert.equal(clampFluxGuidance(500), FLUX_FILL_GUIDANCE_MAX);
  assert.equal(clampFluxGuidance(0), FLUX_FILL_GUIDANCE_MIN);
  assert.equal(clampFluxGuidance(""), FLUX_FILL_GUIDANCE_DEFAULT);

  assert.equal(normalizeFluxSeed(""), undefined, "a cleared seed field means random, not seed 0");
  assert.equal(normalizeFluxSeed(undefined), undefined);
  assert.equal(normalizeFluxSeed(-4), undefined);
  assert.equal(normalizeFluxSeed(0), 0, "0 is a seed BFL honours and must survive normalization");
  assert.equal(normalizeFluxSeed(1e12), FLUX_FILL_SEED_MAX);
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
