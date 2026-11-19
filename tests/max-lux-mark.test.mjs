import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Lock the owner's outlines and their paint order at rest. JSX and the
// source SVG represent stroke styles differently, so compare the geometry.
function outlines(source) {
  return [...source.matchAll(/<(path|polyline|rect|line)\b([^>]+)>/g)].map(([, tag, attributes]) => [
    tag,
    ...[...attributes.matchAll(/\b(d|points|x|y|width|height|x1|x2|y1|y2)="([^"]+)"/g)]
      .map(([, key, value]) => [key, value]).sort(([a], [b]) => a.localeCompare(b)),
  ]);
}

test("the dimensional MAX LUX face retains every outline in the approved SVG", () => {
  const reference = readFileSync(new URL("../references/maxlux-logo-final.svg", import.meta.url), "utf8");
  const component = readFileSync(new URL("../app/components/MaxLuxMark.tsx", import.meta.url), "utf8");
  assert.deepEqual(outlines(component), outlines(reference));
  assert.ok(component.includes(reference.match(/viewBox="([^"]+)"/)[1]));
});
