// The hashes the render workflow keys staleness on.
//
// A draft is fresh only while its recorded hash still matches the board's, and
// those digests are already written into every results.json on disk. So the
// algorithm is not free to change: a different hash marks every existing render
// stale and re-spends real money re-rendering boards that were already
// approved. These tests exist to make that impossible to do by accident.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";

import { sha1Hex } from "../app/lib/autoboard/sha1.ts";
import {
  boardForRender,
  renderOptionsHash,
  renderRecordIsStale,
  resolveRenderOptions,
  savedRenderOptions,
  selectionHash,
} from "../app/lib/autoboard/render-options.ts";

function board(overrides = {}) {
  return {
    id: "penthouse-bath-2-fixture",
    unitType: "Penthouse",
    roomLabel: "Bath 2",
    collageType: "bathroom_fixture_collage",
    kindLabel: "Fixture Collage",
    title: "Penthouse Bath 2 Fixture Collage",
    items: [
      { slotId: "vanity_faucet", role: "vanity faucet", required: true, rowId: "1", sku: "A", brand: "Brizo", name: "Odin Faucet", notes: "", images: ["/a.jpg"] },
      { slotId: "shower_head", role: "shower head", required: true, rowId: "2", sku: "B", brand: "Brizo", name: "Round Showerhead", notes: "", images: ["/b.jpg"] },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// sha1Hex vs node:crypto
// ---------------------------------------------------------------------------

test("sha1Hex matches node:crypto across lengths, block boundaries and unicode", () => {
  const cases = ["", "a", "abc", "The quick brown fox jumps over the lazy dog"];
  // 55/56 and 63/64/119/120 straddle the padding and block boundaries, which is
  // where a hand-written block loop goes wrong.
  for (const n of [54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 1000]) cases.push("x".repeat(n));
  cases.push("cafe ☕ 日本語 — em dash");
  cases.push(String.fromCharCode(0, 1, 0xfffd, 127));
  for (const value of cases) {
    assert.equal(sha1Hex(value), createHash("sha1").update(value).digest("hex"), `length ${value.length}`);
  }
});

test("sha1Hex matches node:crypto on random inputs", () => {
  for (let i = 0; i < 200; i++) {
    let value = "";
    const length = Math.floor(Math.random() * 300);
    for (let j = 0; j < length; j++) value += String.fromCharCode(Math.floor(Math.random() * 0x2000));
    assert.equal(sha1Hex(value), createHash("sha1").update(value).digest("hex"));
  }
});

// ---------------------------------------------------------------------------
// The two workflow hashes, pinned to literal digests
// ---------------------------------------------------------------------------

// Literal, not recomputed: a test that derives the expected value the same way
// the code does would pass through any change to either. These digests were
// taken from node:crypto over the same material the original implementation
// hashed, so they are what every stored results.json already contains — the
// pure sha1 has to keep reproducing them, not merely be self-consistent.
test("selectionHash is a stable digest of what the model sees", () => {
  assert.equal(selectionHash(board()), "962cff26d4d5aaa8c038c6f0eaf74a18549589f3");
  assert.equal(selectionHash(board(), "warmer metals"), "64019d6a439856bc9452a16b6eb233eb0248c862");
});

test("renderOptionsHash is a stable digest of the option set", () => {
  assert.equal(renderOptionsHash({ quality: "low", background: "opaque" }), "94990f0ea4a7f1d1725b934b4c12ad77146593be");
  assert.equal(renderOptionsHash({ quality: "high", background: "transparent" }), "c2ffb7ccee4e45b2e42f821290c9decbb7247496");
});

// ---------------------------------------------------------------------------
// What each hash does and does not respond to
// ---------------------------------------------------------------------------

test("selectionHash changes when the images, notes or instruction change", () => {
  const base = selectionHash(board());
  assert.notEqual(base, selectionHash(board({ items: [{ ...board().items[0], images: ["/c.jpg"] }, board().items[1]] })));
  assert.notEqual(base, selectionHash(board({ items: [{ ...board().items[0], note: "brushed, not polished" }, board().items[1]] })));
  assert.notEqual(base, selectionHash(board(), "warmer metals"));
  // Whitespace around an instruction is not a change.
  assert.equal(selectionHash(board(), "  warmer metals  "), selectionHash(board(), "warmer metals"));
});

test("selectionHash ignores bookkeeping the model never sees", () => {
  const base = selectionHash(board());
  for (const noise of [
    { title: "A completely different title" },
    { items: [{ ...board().items[0], overriddenAt: 1234 }, board().items[1]] },
    { items: [{ ...board().items[0], provenance: "picked by hand" }, board().items[1]] },
    { items: [{ ...board().items[0], imageMeta: [{ width: 10, height: 10 }] }, board().items[1]] },
  ]) {
    assert.equal(selectionHash(board(noise)), base, JSON.stringify(Object.keys(noise)));
  }
});

test("a photo replaced in place changes selectionHash only for boards whose items use it", () => {
  const before = selectionHash(board(), "");
  const replaced = board({ imageDigests: { "/a.jpg": "1".repeat(64) } });
  assert.notEqual(selectionHash(replaced, ""), before);
  assert.notEqual(selectionHash(board({ imageDigests: { "/a.jpg": "2".repeat(64) } }), ""), selectionHash(replaced, ""));
  // A digest for a path no item uses leaves the hash exactly as it was — which
  // is what keeps every hash already written to results.json valid.
  assert.equal(selectionHash(board({ imageDigests: { "/elsewhere.jpg": "3".repeat(64) } }), ""), before);
});

test("a render made before an in-place photo replacement is stale afterwards", () => {
  const record = { selectionHash: selectionHash(board(), "") };
  assert.equal(renderRecordIsStale(board(), record, "final", ""), false);
  assert.equal(renderRecordIsStale(board({ imageDigests: { "/b.jpg": "4".repeat(64) } }), record, "final", ""), true);
});

// ---------------------------------------------------------------------------
// Options and staleness
// ---------------------------------------------------------------------------

test("resolveRenderOptions layers overrides over saved options over stage defaults", () => {
  assert.deepEqual(resolveRenderOptions(board(), "draft"), { quality: "low", background: "opaque" });
  assert.deepEqual(resolveRenderOptions(board(), "confirm"), { quality: "medium", background: "opaque" });
  const saved = board({ renderOptions: { quality: "xhigh", background: "transparent" } });
  assert.deepEqual(resolveRenderOptions(saved, "draft"), { quality: "xhigh", background: "transparent" });
  assert.deepEqual(resolveRenderOptions(saved, "draft", { quality: "low" }), { quality: "low", background: "transparent" });
  // Junk falls back rather than reaching the API.
  assert.deepEqual(resolveRenderOptions(board(), "draft", { quality: "ludicrous" }), { quality: "low", background: "opaque" });
});

test("a final render never drops below high", () => {
  for (const requested of ["low", "medium", "auto"]) {
    assert.equal(resolveRenderOptions(board(), "final", { quality: requested }).quality, "high");
  }
  // An explicit choice above high is kept.
  assert.equal(resolveRenderOptions(board(), "final", { quality: "max" }).quality, "max");
});

test("savedRenderOptions leaves a plan written before the options UI opaque", () => {
  assert.deepEqual(savedRenderOptions(board()), { quality: undefined, background: "opaque" });
  assert.deepEqual(savedRenderOptions(null), { quality: undefined, background: "opaque" });
});

test("renderRecordIsStale compares the selection and the options", () => {
  const current = board();
  const fresh = { selectionHash: selectionHash(current), renderOptionsHash: renderOptionsHash(resolveRenderOptions(current, "draft")) };
  assert.equal(renderRecordIsStale(current, fresh, "draft"), false);
  assert.equal(renderRecordIsStale(current, null, "draft"), true);
  assert.equal(renderRecordIsStale(current, { ...fresh, selectionHash: "other" }, "draft"), true);
  assert.equal(renderRecordIsStale(current, { ...fresh, renderOptionsHash: "other" }, "draft"), true);
  // An instruction added after the render was made makes it stale.
  assert.equal(renderRecordIsStale(current, fresh, "draft", "warmer metals"), true);
});

test("renderRecordIsStale leaves a record predating renderOptionsHash alone until the board gains options", () => {
  const current = board();
  const legacy = { selectionHash: selectionHash(current) };
  assert.equal(renderRecordIsStale(current, legacy, "draft"), false);
  const withOptions = board({ renderOptions: { quality: "high", background: "opaque" } });
  assert.equal(renderRecordIsStale(withOptions, { selectionHash: selectionHash(withOptions) }, "draft"), true);
});

test("boardForRender puts the instruction on the hero item and mutates nothing", () => {
  const original = board();
  const snapshot = JSON.stringify(original);
  const rendered = boardForRender(original, "warmer metals throughout");
  assert.equal(JSON.stringify(original), snapshot, "boardForRender must not mutate the plan");
  // The collage request has no board-level notes field, so the instruction
  // rides on the hero item, prefixed so the model can tell it apart.
  const carrying = rendered.items.filter((item) => item.notes.includes("Board instruction:"));
  assert.equal(carrying.length, 1);
  assert.match(carrying[0].notes, /Board instruction: warmer metals throughout/);
  assert.equal(boardForRender(original, "").items.every((item) => !item.notes.includes("Board instruction")), true);
});
