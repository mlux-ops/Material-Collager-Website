import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { lightSamples, lightVector, pointToLight, sampleMap } from "../app/lib/raking-light.ts";

test("drag positions and keyboard bearing use the same north-up convention", () => {
  for (const [x, y, bearing] of [[0, -1, 0], [1, 0, 90], [0, 1, 180], [-1, 0, 270]]) {
    assert.deepEqual(pointToLight(x, y), { azimuth: bearing, elevation: 10 });
    const [lightX, lightY, lightZ] = lightVector(bearing, 10);
    assert.ok(Math.abs(lightX - x * Math.cos(Math.PI / 18)) < 1e-8);
    assert.ok(Math.abs(lightY + y * Math.cos(Math.PI / 18)) < 1e-8);
    assert.ok(lightZ > 0);
    assert.ok(Math.abs(Math.hypot(lightX, lightY, lightZ) - 1) < 1e-8);
  }
  assert.equal(pointToLight(0, 0).elevation, 80);
  assert.equal(pointToLight(4, 4).elevation, 10);
});

test("every specimen ships its own diffuse, GL normal, roughness and swatch", () => {
  assert.equal(new Set(lightSamples.map(sample => sample.id)).size, lightSamples.length);
  for (const sample of lightSamples) {
    const paths = ["diffuse", "nor_gl", "rough"].map(map => sampleMap(sample, map));
    paths.push(`/raking-light/${sample.id}-swatch.webp`);
    for (const path of paths) {
      const image = readFileSync(new URL(`../public${path}`, import.meta.url));
      assert.equal(image.toString("ascii", 8, 12), "WEBP");
    }
  }
});
