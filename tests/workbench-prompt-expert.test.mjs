import assert from "node:assert/strict";
import test from "node:test";

import { CLI_EFFORTS } from "../app/components/workbench/nodes/cliAssistant.manifest.ts";
import { defaultParams, MANIFESTS, NODE_KINDS, paidMap } from "../app/components/workbench/nodes/manifests.ts";
import { promptExpertManifest } from "../app/components/workbench/nodes/promptExpert.manifest.ts";
import { EXPORT_FORMAT, EXPORT_VERSION, validateImport } from "../app/components/workbench/export-import.ts";

function graphWith(params) {
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: Date.now(),
    graphOnly: true,
    nodes: [{ id: "n1", kind: "promptExpert", position: { x: 0, y: 0 }, params }],
    edges: [],
    images: {},
  };
}

test("Prompt Expert is registered right after Codex CLI and is not paid", () => {
  assert.equal(MANIFESTS.promptExpert, promptExpertManifest);
  assert.equal(NODE_KINDS.indexOf("promptExpert"), NODE_KINDS.indexOf("codexCli") + 1);
  assert.equal(promptExpertManifest.spec.title, "Prompt Expert");
  assert.equal(paidMap.promptExpert, false);
});

test("Prompt Expert defaults to an empty instruction at the model's own effort, with no model param", () => {
  assert.deepEqual(defaultParams("promptExpert"), { instruction: "", effort: "default" });
});

test("Prompt Expert takes images and context text, and outputs a text prompt", () => {
  const { inputs, outputs } = promptExpertManifest.spec;
  const images = inputs.find((port) => port.id === "image");
  assert.equal(images.label, "Images");
  assert.equal(images.multi, true);
  assert.deepEqual(images.acceptedKinds, ["image", "references"]);
  const context = inputs.find((port) => port.id === "text");
  assert.equal(context.kind, "text");
  assert.equal(context.label, "Context");
  assert.deepEqual(outputs, [{ id: "text", kind: "text", label: "Prompt" }]);
});

test("the Prompt Expert effort dropdown offers exactly the bridge's levels", () => {
  assert.deepEqual([...promptExpertManifest.importSchema.paramKeys.effort.values], [...CLI_EFFORTS]);
});

test("importing a Prompt Expert keeps a known effort and drops an unknown one or a model", () => {
  const kept = validateImport(graphWith({ instruction: "a kitchen", effort: "high" }));
  assert.equal(kept.nodes[0].params.effort, "high");
  assert.equal(kept.nodes[0].params.instruction, "a kitchen");

  const dropped = validateImport(graphWith({ instruction: "a kitchen", effort: "turbo", model: "gpt-5" }));
  assert.equal(dropped.nodes[0].params.effort, "default", "an unknown effort falls back to the default");
  assert.equal("model" in dropped.nodes[0].params, false, "the model is fixed, so an imported one is ignored");
});
