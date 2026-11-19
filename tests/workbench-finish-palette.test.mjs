import assert from "node:assert/strict";
import test from "node:test";
import { extractFinishPalette, finishTone, paletteDistance, toggleFinishPin } from "../app/components/workbench/nodes/finish-palette.ts";

test("material interior supplies tones, excluding transparent pixels and the frame", () => {
  const rgba = new Uint8ClampedArray(8 * 8 * 4);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const edge = !x || !y || x === 7 || y === 7;
      rgba.set(edge ? [255, 255, 255, 255] : [132, 105, 80, 255], (8 * y + x) * 4);
    }
  }
  rgba.set([0, 255, 0, 0], (8 * 3 + 3) * 4);
  assert.deepEqual(extractFinishPalette(rgba, 8, 8).map((tone) => tone.hex), ["#846950"]);
  assert.deepEqual(extractFinishPalette(new Uint8ClampedArray(4), 1, 1), []);
});

test("Oklab color and two-pin ranking reflect both source tones", () => {
  const red = finishTone(255, 0, 0);
  assert.ok(Math.abs(red.lab[0] - 0.62795536) < 0.000001);
  const oak = finishTone(143, 108, 84);
  const gray = finishTone(130, 129, 126);
  const grayOak = [finishTone(142, 107, 83), gray];
  assert.ok(paletteDistance(grayOak, [oak, gray]) < paletteDistance([oak], [oak, gray]));
  assert.equal(paletteDistance([], [oak]), Infinity);
  assert.equal(paletteDistance([], []), 0);
  assert.deepEqual(toggleFinishPin([oak, gray], red), [oak, red]);
  assert.deepEqual(toggleFinishPin([oak, gray], oak), [gray]);
});
