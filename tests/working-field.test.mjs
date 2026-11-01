import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const {
  WORKING_FIELD_DITHER_LEVELS,
  WORKING_FIELD_TOKENS,
  contrastWithWhite,
  hexToRgb01,
  mixHex,
  workingFieldMode,
  workingFieldPalette,
  workingFieldPlaying,
  workingFieldSeed,
  worstCaseGround,
} = await import("../app/lib/working-field.ts");

// WorkingField.tsx passes this grain to Velaris; the contrast bound uses it.
const FIELD_GRAIN = 0.2;

test("potato skips the field, reduced motion freezes it, otherwise it runs", () => {
  assert.equal(workingFieldMode({ potato: true, reduced: false }), "off");
  // Potato wins over reduced motion: no GPU work at all beats a static frame.
  assert.equal(workingFieldMode({ potato: true, reduced: true }), "off");
  assert.equal(workingFieldMode({ potato: false, reduced: true }), "static");
  assert.equal(workingFieldMode({ potato: false, reduced: false }), "live");
});

test("a live field plays only while visible and on screen", () => {
  const visible = { documentHidden: false, onscreen: true };
  assert.equal(workingFieldPlaying("live", visible), true);
  assert.equal(workingFieldPlaying("live", { documentHidden: true, onscreen: true }), false);
  assert.equal(workingFieldPlaying("live", { documentHidden: false, onscreen: false }), false);
  assert.equal(workingFieldPlaying("live", { documentHidden: true, onscreen: false }), false);
  // A static field holds its one frame and an off field has nothing to play,
  // whatever the viewport says.
  assert.equal(workingFieldPlaying("static", visible), false);
  assert.equal(workingFieldPlaying("off", visible), false);
});

test("seeds are never zero and neighbouring jobs land far apart", () => {
  for (let n = 0; n < 200; n += 1) {
    const seed = workingFieldSeed(n);
    assert.ok(seed >= 1 && seed < 11, `seed ${seed} for ${n} out of range`);
  }
  for (let n = 0; n < 50; n += 1) {
    assert.ok(Math.abs(workingFieldSeed(n) - workingFieldSeed(n + 1)) > 1, `jobs ${n} and ${n + 1} too close`);
  }
  // Garbage in still yields a usable seed.
  for (const bad of [Number.NaN, Infinity, -Infinity]) {
    const seed = workingFieldSeed(bad);
    assert.ok(Number.isFinite(seed) && seed >= 1 && seed < 11);
  }
  assert.ok(workingFieldSeed(-3) >= 1, "negative inputs wrap into range");
});

test("palette tokens match the live :root in globals.css", () => {
  // globals.css declares :root twice; the later "Compact studio workspace"
  // block wins, so read the LAST declaration of each token.
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  const last = (name) => {
    const matches = [...css.matchAll(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`, "g"))];
    assert.ok(matches.length > 0, `${name} not found`);
    return matches[matches.length - 1][1].toLowerCase();
  };
  assert.equal(WORKING_FIELD_TOKENS.accent, last("--accent"));
  assert.equal(WORKING_FIELD_TOKENS.accentDark, last("--accent-dark"));
  assert.equal(WORKING_FIELD_TOKENS.paper, last("--mono-off-white"));
  assert.equal(WORKING_FIELD_TOKENS.ink, last("--mono-black"));
});

test("both palettes are four colours plus a background, all teal family or neutral", () => {
  for (const variant of ["track", "pill"]) {
    const palette = workingFieldPalette(variant);
    assert.equal(palette.colors.length, 4);
    for (const hex of [palette.bg, ...palette.colors]) {
      assert.match(hex, /^#[0-9a-f]{6}$/);
      const [r, g, b] = hexToRgb01(hex);
      // Teal or neutral: red never leads, so nothing warm creeps in.
      assert.ok(r <= g + 1e-9 && r <= b + 1e-9, `${variant} ${hex} is not teal/neutral`);
    }
  }
  // The track ground is the accent itself, so the clipped edge of the
  // determinate span stays an exact --accent on paper.
  assert.equal(workingFieldPalette("track").bg, WORKING_FIELD_TOKENS.accent);
});

test("the pill keeps its white label at AA on the brightest possible ground", () => {
  const palette = workingFieldPalette("pill");
  const worst = worstCaseGround(palette, FIELD_GRAIN);
  assert.ok(contrastWithWhite(worst) >= 4.5, `worst-case ground contrast ${contrastWithWhite(worst).toFixed(2)}`);
  // The ordered dither is mean-preserving, but a single dot can round a whole
  // quantization step up; even that dot stays above the 3:1 non-text floor.
  const step = 1 / (WORKING_FIELD_DITHER_LEVELS - 1);
  const roundedUp = worst.map((c) => Math.min(1, Math.ceil(c / step) * step));
  assert.ok(contrastWithWhite(roundedUp) >= 3, `rounded-up dot contrast ${contrastWithWhite(roundedUp).toFixed(2)}`);
});

test("the dither keeps the hue: more than two quantization levels", () => {
  // Two levels snap each channel to 0/1, turning teal into RGB primaries.
  assert.ok(WORKING_FIELD_DITHER_LEVELS > 2);
});

test("mixHex blends in sRGB like the shader's mix()", () => {
  assert.equal(mixHex("#000000", "#ffffff", 0), "#000000");
  assert.equal(mixHex("#000000", "#ffffff", 1), "#ffffff");
  assert.equal(mixHex("#000000", "#ffffff", 0.5), "#808080");
  assert.equal(mixHex("#0c574c", "#000000", 0.5), "#062c26");
});
