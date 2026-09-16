import assert from "node:assert/strict";
import test from "node:test";

import { classifySize, QUALITY_OPTIONS, BACKGROUND_OPTIONS, MODEL_FLARE, MODEL_SUNBURST } from "../app/lib/image-model-limits.ts";

test("classifySize: clearly legal size", () => {
  const result = classifySize("1536x1024");

  assert.equal(result.size, "1536x1024");
  assert.equal(result.width, 1536);
  assert.equal(result.height, 1024);
  assert.equal(result.pixels, 1572864);
  assert.equal(result.legal, true);
  assert.equal(result.experimental, false);
  assert.deepEqual(result.reasons, []);
});

test("classifySize: 2560x1440 is exactly at 3686400 px boundary — legal, not experimental", () => {
  const result = classifySize("2560x1440");

  assert.equal(result.size, "2560x1440");
  assert.equal(result.width, 2560);
  assert.equal(result.height, 1440);
  assert.equal(result.pixels, 3686400);
  assert.equal(result.legal, true);
  assert.equal(result.experimental, false);
  assert.deepEqual(result.reasons, []);
});

test("classifySize: 1920x1920 is exactly at 3686400 px boundary — legal, not experimental", () => {
  const result = classifySize("1920x1920");

  assert.equal(result.size, "1920x1920");
  assert.equal(result.width, 1920);
  assert.equal(result.height, 1920);
  assert.equal(result.pixels, 3686400);
  assert.equal(result.legal, true);
  assert.equal(result.experimental, false);
  assert.deepEqual(result.reasons, []);
});

test("classifySize: 2048x2048 is legal but experimental", () => {
  const result = classifySize("2048x2048");

  assert.equal(result.size, "2048x2048");
  assert.equal(result.width, 2048);
  assert.equal(result.height, 2048);
  assert.equal(result.pixels, 4194304);
  assert.equal(result.legal, true);
  assert.equal(result.experimental, true);
  assert.deepEqual(result.reasons, ["above 3,686,400 px"]);
});

test("classifySize: 3840x2160 is legal, experimental, at max pixel budget", () => {
  const result = classifySize("3840x2160");

  assert.equal(result.size, "3840x2160");
  assert.equal(result.width, 3840);
  assert.equal(result.height, 2160);
  assert.equal(result.pixels, 8294400);
  assert.equal(result.legal, true);
  assert.equal(result.experimental, true);
  assert.deepEqual(result.reasons, ["above 3,686,400 px"]);
});

test("classifySize: 1000x1000 is not a multiple of 16", () => {
  const result = classifySize("1000x1000");

  assert.equal(result.legal, false);
  assert.ok(result.reasons.includes("edges must be multiples of 16"));
  assert.equal(result.experimental, false);
});

test("classifySize: 320x320 is too small (below 655360 px minimum)", () => {
  const result = classifySize("320x320");

  assert.equal(result.legal, false);
  assert.ok(result.reasons.includes("pixels must be between 655360 and 8294400 inclusive"));
  assert.equal(result.experimental, false);
});

test("classifySize: 3840x640 violates 3:1 aspect ratio", () => {
  const result = classifySize("3840x640");

  assert.equal(result.legal, false);
  assert.ok(result.reasons.includes("aspect ratio must not exceed 3:1"));
  assert.equal(result.experimental, false);
});

test("classifySize: 4096x1024 has an oversized edge", () => {
  const result = classifySize("4096x1024");

  assert.equal(result.legal, false);
  assert.ok(result.reasons.includes("edges must be <= 3840"));
  assert.equal(result.experimental, true);
});

test("classifySize: garbage string returns unparseable error", () => {
  const result = classifySize("banana");

  assert.equal(result.width, 0);
  assert.equal(result.height, 0);
  assert.equal(result.pixels, 0);
  assert.equal(result.legal, false);
  assert.equal(result.experimental, false);
  assert.ok(result.reasons.includes("invalid format, must be WIDTHxHEIGHT"));
});

test("classifySize: never throws", () => {
  const testCases = [
    "1536x1024",
    "2560x1440",
    "2048x2048",
    "3840x2160",
    "1000x1000",
    "320x320",
    "3840x640",
    "4096x1024",
    "banana",
    "",
    "x",
    "1920",
    "1920x",
    "1920xabc",
    "abc x 1920",
    "-1x-1",
    "0x0",
  ];

  for (const testCase of testCases) {
    assert.doesNotThrow(() => classifySize(testCase), `classifySize("${testCase}") threw unexpectedly`);
  }
});

test("exports: QUALITY_OPTIONS", () => {
  assert.deepEqual(QUALITY_OPTIONS, ["auto", "low", "medium", "high", "xhigh", "max"]);
});

test("exports: BACKGROUND_OPTIONS", () => {
  assert.deepEqual(BACKGROUND_OPTIONS, ["auto", "opaque", "transparent"]);
});

test("exports: MODEL_FLARE", () => {
  assert.equal(MODEL_FLARE, "gpt-image-2.5-flare");
});

test("exports: MODEL_SUNBURST", () => {
  assert.equal(MODEL_SUNBURST, "gpt-image-2.5-sunburst");
});
