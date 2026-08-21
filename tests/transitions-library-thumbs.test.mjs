import test from "node:test";
import assert from "node:assert/strict";

const {
  parseThumbStore,
  serializeThumbStore,
  storedThumbsMatch,
  sanitizeThumbs,
  MAX_THUMBS,
  MAX_THUMB_CHARS,
} = await import("../app/lib/library-thumbs.ts");

const validThumb = (id) => ({
  id,
  name: `Collage ${id}`,
  thumb: "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
  ar: 1.25,
});

test("round-trips a valid store", () => {
  const items = [validThumb("a"), validThumb("b")];
  assert.deepEqual(parseThumbStore(serializeThumbStore(items)), items);
});

test("caps stored and parsed thumbs at MAX_THUMBS", () => {
  const many = Array.from({ length: MAX_THUMBS + 9 }, (_, i) => validThumb(`t${i}`));
  const parsed = parseThumbStore(serializeThumbStore(many));
  assert.equal(parsed.length, MAX_THUMBS);
});

test("rejects garbage, wrong versions, and malformed entries", () => {
  assert.deepEqual(parseThumbStore(null), []);
  assert.deepEqual(parseThumbStore("not json {{{"), []);
  assert.deepEqual(parseThumbStore(JSON.stringify({ v: 1, items: [validThumb("a")] })), []);
  assert.deepEqual(parseThumbStore(JSON.stringify({ v: 1, items: "nope" })), []);
  const mixed = JSON.stringify({
    v: 2,
    items: [validThumb("ok"), { id: "", name: "x", thumb: "data:image/jpeg;base64,AA==", ar: 1 }, 42],
  });
  assert.deepEqual(parseThumbStore(mixed).map((t) => t.id), ["ok"]);
});

test("rejects non-data-URI thumb sources (store poisoning guard)", () => {
  const poisoned = JSON.stringify({
    v: 2,
    items: [
      { id: "x", name: "x", thumb: "https://evil.example/steal.png" },
      { id: "y", name: "y", thumb: "javascript:alert(1)" },
      validThumb("clean"),
    ],
  });
  assert.deepEqual(parseThumbStore(poisoned).map((t) => t.id), ["clean"]);
});

test("sanitizeThumbs is the shared guard for API input", () => {
  assert.deepEqual(sanitizeThumbs(null), []);
  assert.deepEqual(sanitizeThumbs("[]"), []);
  assert.deepEqual(sanitizeThumbs([validThumb("a")]).map((t) => t.id), ["a"]);
  // Oversized payloads are rejected per entry, not truncated
  const fat = { ...validThumb("fat"), thumb: `data:image/jpeg;base64,${"A".repeat(MAX_THUMB_CHARS)}` };
  assert.deepEqual(sanitizeThumbs([fat, validThumb("ok")]).map((t) => t.id), ["ok"]);
  // Extra properties are stripped, never stored
  const noisy = { ...validThumb("n"), extra: "field", __proto__: { evil: true } };
  const clean = sanitizeThumbs([noisy])[0];
  assert.deepEqual(Object.keys(clean).sort(), ["ar", "id", "name", "thumb"]);
});

test("aspect ratios clamp to the card range and default when absent", () => {
  const noAr = { id: "n", name: "n", thumb: "data:image/jpeg;base64,AA==" };
  assert.equal(sanitizeThumbs([noAr])[0].ar, 4 / 3);
  assert.equal(sanitizeThumbs([{ ...validThumb("w"), ar: 9 }])[0].ar, 1.65);
  assert.equal(sanitizeThumbs([{ ...validThumb("t"), ar: 0.1 }])[0].ar, 0.72);
});

test("storedThumbsMatch compares ids in order, capped", () => {
  const stored = [validThumb("a"), validThumb("b")];
  assert.equal(storedThumbsMatch(stored, ["a", "b"]), true);
  assert.equal(storedThumbsMatch(stored, ["b", "a"]), false);
  assert.equal(storedThumbsMatch(stored, ["a"]), false);
  assert.equal(storedThumbsMatch([], []), true);
});
