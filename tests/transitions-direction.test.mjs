import test from "node:test";
import assert from "node:assert/strict";

const { navDirection, NAV_ORDER } = await import("../app/lib/nav-direction.ts");

test("nav order is the main routes in progression order", () => {
  assert.deepEqual(NAV_ORDER, ["/", "/generator", "/workbench", "/archive"]);
});

// Exhaustive 4×4 matrix. Forward = moving right in NAV_ORDER, back = left,
// none = no movement. Browser back/forward needs no special casing: history
// traversal lands on a route whose index comparison gives the same answer.
const MATRIX = [
  ["/", "/", "none"],
  ["/", "/generator", "forward"],
  ["/", "/workbench", "forward"],
  ["/", "/archive", "forward"],
  ["/generator", "/", "back"],
  ["/generator", "/generator", "none"],
  ["/generator", "/workbench", "forward"],
  ["/generator", "/archive", "forward"],
  ["/workbench", "/", "back"],
  ["/workbench", "/generator", "back"],
  ["/workbench", "/workbench", "none"],
  ["/workbench", "/archive", "forward"],
  ["/archive", "/", "back"],
  ["/archive", "/generator", "back"],
  ["/archive", "/workbench", "back"],
  ["/archive", "/archive", "none"],
];

for (const [from, to, expected] of MATRIX) {
  test(`direction ${from} -> ${to} is ${expected}`, () => {
    assert.equal(navDirection(from, to), expected);
  });
}

test("routes outside the nav order never get a direction", () => {
  assert.equal(navDirection("/", "/dither-lab"), "none");
  assert.equal(navDirection("/scene-lab", "/generator"), "none");
  assert.equal(navDirection("/scene-lab", "/scene-lab-v2"), "none");
});

test("trailing slashes normalize (except root)", () => {
  assert.equal(navDirection("/generator/", "/workbench"), "forward");
  assert.equal(navDirection("/workbench/", "/generator/"), "back");
  assert.equal(navDirection("/", "/generator/"), "forward");
});

test("query strings and hashes are ignored", () => {
  assert.equal(navDirection("/?qa=1&progress=0.4", "/generator"), "forward");
  assert.equal(navDirection("/generator?x=1", "/#top"), "back");
});
