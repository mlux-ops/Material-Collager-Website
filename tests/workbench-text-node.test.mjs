import assert from "node:assert/strict";
import test from "node:test";

import { textManifest } from "../app/components/workbench/nodes/text.manifest.ts";

function run(params, incoming) {
  const applied = [];
  const ctx = {
    params,
    signature: "sig",
    inputs: (portId) => (portId === "text" ? incoming.map((text) => ({ kind: "text", text })) : []),
    createRunId: () => "run-1",
    applyRun: (value) => applied.push(value),
  };
  return textManifest.execute(ctx).then(() => applied[0]?.values[0][0].text);
}

test("the text node declares one optional text input", () => {
  assert.deepEqual(
    textManifest.spec.inputs.map((port) => [port.id, port.kind, Boolean(port.required)]),
    [["text", "text", false]],
  );
});

test("an unconnected text node still outputs what was typed", async () => {
  assert.equal(await run({ text: "  warm oak  " }, []), "warm oak");
});

test("connected text flows through untouched until the user edits it", async () => {
  assert.equal(await run({ text: "stale", textEdited: false }, ["from upstream"]), "from upstream");
});

test("the user's edit wins over connected text", async () => {
  assert.equal(await run({ text: "my version", textEdited: true }, ["from upstream"]), "my version");
});

test("an edited node with the incoming text disconnected keeps its text", async () => {
  assert.equal(await run({ text: "my version", textEdited: true }, []), "my version");
});

test("several connections join with a newline", async () => {
  assert.equal(await run({}, ["a", "b"]), "a\nb");
});

test("empty text still raises", async () => {
  await assert.rejects(run({ text: "  " }, []), /Enter some text/);
});

test("every param the node writes is declared in its importSchema", () => {
  for (const key of ["text", "textEdited"]) {
    assert.ok(key in textManifest.importSchema.paramKeys, key);
  }
});
