import assert from "node:assert/strict";
import test from "node:test";

import { textManifest, withAppendedText } from "../app/components/workbench/nodes/text.manifest.ts";

function run(params, incoming, appended = []) {
  const applied = [];
  const ports = { text: incoming, append: appended };
  const ctx = {
    params,
    signature: "sig",
    inputs: (portId) => (ports[portId] ?? []).map((text) => ({ kind: "text", text })),
    createRunId: () => "run-1",
    applyRun: (value) => applied.push(value),
  };
  return textManifest.execute(ctx).then(() => applied[0]?.values[0][0].text);
}

test("the text node declares an optional text input and an explicit-only, multi Append input", () => {
  assert.deepEqual(
    textManifest.spec.inputs.map((port) => [port.id, port.kind, Boolean(port.required)]),
    [["text", "text", false], ["append", "text", false]],
  );
  const append = textManifest.spec.inputs.find((port) => port.id === "append");
  assert.equal(append.label, "Append");
  assert.equal(append.explicitOnly, true, "a text wire dropped on the card must still land on Text in");
  assert.equal(append.multi, true);
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

const NL = String.fromCharCode(10);

test("appended text goes at the bottom of the typed text after a blank line", async () => {
  assert.equal(
    await run({ text: "  warm oak  " }, [], ["Inside the red marks: swap the tile."]),
    ["warm oak", "", "Inside the red marks: swap the tile."].join(NL),
  );
});

test("appended text goes below connected text that has not been edited", async () => {
  assert.equal(await run({ text: "stale", textEdited: false }, ["from upstream"], ["tail"]), ["from upstream", "", "tail"].join(NL));
});

test("appended text goes below the user's edit when it wins over connected text", async () => {
  assert.equal(await run({ text: "my version", textEdited: true }, ["from upstream"], ["tail"]), ["my version", "", "tail"].join(NL));
});

test("with no text of its own the node outputs only the appended text", async () => {
  assert.equal(await run({ text: "   " }, [], ["  only the tail  "]), "only the tail");
});

test("several Append wires join with a newline", async () => {
  assert.equal(await run({ text: "base" }, [], ["one", "two"]), ["base", "", "one", "two"].join(NL));
});

test("blank appended text leaves the output exactly as before", async () => {
  assert.equal(await run({ text: "base" }, [], ["", "  "]), "base");
});

test("empty text and empty Append still raise", async () => {
  await assert.rejects(run({ text: "" }, [], ["  "]), /Enter some text/);
});

test("withAppendedText puts a blank line between the two blocks and trims both", () => {
  assert.equal(withAppendedText(" a ", " b "), ["a", "", "b"].join(NL));
  assert.equal(withAppendedText("a", ""), "a");
  assert.equal(withAppendedText("", "b"), "b");
  assert.equal(withAppendedText("", ""), "");
});
