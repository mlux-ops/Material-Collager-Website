import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Text guards for the Library veil's exit. The CSS Modules rename once
// silently disabled the archive's dissolve (a module-scoped animation-name
// pointed at keyframes nothing defined), and no runtime test can see that.
// These pin the veil exit to the global class and the shared keyframes, and
// keep it stripped under both reduced-motion sources.

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

function ruleBody(css, selectorPattern) {
  const match = css.match(new RegExp(`${selectorPattern}\\s*\\{([^}]*)\\}`));
  return match ? match[1] : null;
}

test("the veil exit reuses the shared Bayer keyframes in reverse", async () => {
  const css = await read("../app/effects.css");
  const body = ruleBody(css, "(?:^|\\n)\\.mc-veil-dissolve");
  assert.ok(body, "effects.css has no .mc-veil-dissolve rule");
  assert.ok(body.includes("animation: mc-bayer-dissolve"), "veil exit must use mc-bayer-dissolve");
  assert.ok(body.includes("reverse"), "veil exit must run the dissolve in reverse");
  assert.ok(body.includes("steps(17, end)"), "veil exit must step like the archive dissolve");
  assert.ok(body.includes("mask-size: 6px 6px"), "veil exit must use the archive's 6px tile");
});

test("both reduced-motion sources strip the veil dissolve", async () => {
  const css = await read("../app/effects.css");

  const attrBody = ruleBody(css, 'html\\[data-reduce-motion="1"\\] \\.mc-veil-dissolve');
  assert.ok(attrBody, 'no html[data-reduce-motion="1"] .mc-veil-dissolve rule');
  assert.ok(attrBody.includes("mask-image: none"), "data-reduce-motion rule must clear the mask");

  const media = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.mc-veil-dissolve[^{]*\{([^}]*)\}/);
  assert.ok(media, "no prefers-reduced-motion: reduce rule covers .mc-veil-dissolve");
  assert.ok(media[1].includes("mask-image: none"), "prefers-reduced-motion rule must clear the mask");
});

test("the scene module reaches the dissolve through the global class, not a module name", async () => {
  const tsx = await read("../app/components/scene-wheel-v2/SceneWheelV2.tsx");
  assert.ok(tsx.includes('"mc-veil-dissolve"'), "SceneWheelV2 must add the literal global class");
  assert.doesNotMatch(tsx, /styles\.mcVeilDissolve|styles\["mc-veil-dissolve"\]/);

  const moduleCss = await read("../app/components/scene-wheel-v2/scene-wheel-v2.module.css");
  assert.ok(
    !moduleCss.includes("@keyframes mc-bayer-dissolve"),
    "a module copy of the keyframes would be renamed and silently do nothing",
  );
});

test("the dissolve clock is a motion token", async () => {
  const tokens = await read("../app/motion-tokens.css");
  assert.ok(tokens.includes("--veil-dissolve-dur: 620ms"), "motion-tokens.css must define --veil-dissolve-dur");

  const css = await read("../app/effects.css");
  const body = ruleBody(css, "(?:^|\\n)\\.mc-veil-dissolve");
  assert.ok(body, "effects.css has no .mc-veil-dissolve rule");
  assert.ok(body.includes("var(--veil-dissolve-dur"), ".mc-veil-dissolve must run on the token");
});
