import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import * as legacyCost from "../app/components/workbench/cost.ts";
import {
  describeCostEstimate,
  estimateRunBreakdownUsd,
  estimateRunUsd,
  formatCostFigure,
  formatCostSplit,
  formatUsdSplit,
  isEstimableQuality,
  recordImageTokenCalibration,
  setCalibrationStorageAdapter,
} from "../app/lib/image-cost.ts";
import * as sharedCost from "../app/lib/image-cost.ts";

// The shared estimator's calibration persistence is storage-adapter-injected,
// like tests/workbench-cost.test.mjs: restore the default after every test so
// no in-memory adapter leaks between tests.
afterEach(() => {
  setCalibrationStorageAdapter(null);
});

function createMemoryAdapter(seed) {
  const store = new Map(seed ? Object.entries(seed) : []);
  return {
    get: (key) => (store.has(key) ? store.get(key) : null),
    set: (key, value) => {
      store.set(key, value);
    },
    remove: (key) => {
      store.delete(key);
    },
    store,
  };
}

const COMBINATIONS = [
  { size: "1536x1024", quality: "low", candidates: 1, inputImages: 0 },
  { size: "1536x1024", quality: "low", candidates: 1, inputImages: 6 },
  { size: "2048x1360", quality: "medium", candidates: 1, inputImages: 3 },
  { size: "2560x1440", quality: "high", candidates: 1, inputImages: 7 },
  { size: "1440x2560", quality: "high", candidates: 2, inputImages: 12 },
  { size: "1920x1920", quality: "xhigh", candidates: 1, inputImages: 4 },
];

test("the breakdown's total is exactly estimateRunUsd for every combination, flat seed and calibrated alike", () => {
  setCalibrationStorageAdapter(createMemoryAdapter());
  for (const options of COMBINATIONS) {
    const breakdown = estimateRunBreakdownUsd(options);
    assert.ok(breakdown !== null, `${options.size}|${options.quality} should be estimable`);
    assert.equal(breakdown.totalUsd, estimateRunUsd(options));
  }

  // A calibrated bucket changes the input term; the two must still agree.
  recordImageTokenCalibration("1536x1024", "low", 8349, 6);
  for (const options of COMBINATIONS) {
    assert.equal(estimateRunBreakdownUsd(options).totalUsd, estimateRunUsd(options));
  }
});

test("input + output = total, and the input term scales with the image count", () => {
  setCalibrationStorageAdapter(createMemoryAdapter());
  for (const options of COMBINATIONS) {
    const { inputUsd, outputUsd, totalUsd } = estimateRunBreakdownUsd(options);
    assert.ok(Math.abs(inputUsd + outputUsd - totalUsd) < 1e-12);
    assert.ok(inputUsd >= 0 && outputUsd > 0);
  }
  const none = estimateRunBreakdownUsd({ size: "1536x1024", quality: "low", candidates: 1, inputImages: 0 });
  const six = estimateRunBreakdownUsd({ size: "1536x1024", quality: "low", candidates: 1, inputImages: 6 });
  assert.equal(none.inputUsd, 0);
  assert.equal(none.outputUsd, six.outputUsd, "images add input cost only, never output cost");
  assert.ok(six.inputUsd > 0);
});

test("the breakdown is null exactly when estimateRunUsd is null", () => {
  setCalibrationStorageAdapter(createMemoryAdapter());
  const cases = [
    ...COMBINATIONS,
    { size: "bogus", quality: "medium", candidates: 1, inputImages: 2 },
    { size: "", quality: "low", candidates: 1, inputImages: 0 },
    { size: "auto", quality: "high", candidates: 1, inputImages: 3 },
    { size: "1024x", quality: "high", candidates: 1, inputImages: 1 },
  ];
  for (const options of cases) {
    const breakdown = estimateRunBreakdownUsd(options);
    const total = estimateRunUsd(options);
    assert.equal(breakdown === null, total === null, `${options.size}|${options.quality}`);
  }
  assert.equal(estimateRunBreakdownUsd({ size: "bogus", quality: "medium", candidates: 1, inputImages: 2 }), null);
});

test("isEstimableQuality is true only for the tiers the formula has a real factor for", () => {
  assert.equal(isEstimableQuality("low"), true);
  assert.equal(isEstimableQuality("medium"), true);
  assert.equal(isEstimableQuality("high"), true);
  assert.equal(isEstimableQuality("xhigh"), false);
  assert.equal(isEstimableQuality("max"), false);
  assert.equal(isEstimableQuality("auto"), false);
  assert.equal(isEstimableQuality(""), false);
  // Inherited object keys are not tiers.
  assert.equal(isEstimableQuality("toString"), false);
  assert.equal(isEstimableQuality("constructor"), false);
});

test("the medium fallback for an unknown tier is unchanged (the Workbench relies on it)", () => {
  setCalibrationStorageAdapter(createMemoryAdapter());
  const medium = estimateRunUsd({ size: "1536x1024", quality: "medium", candidates: 1, inputImages: 0 });
  const xhigh = estimateRunUsd({ size: "1536x1024", quality: "xhigh", candidates: 1, inputImages: 0 });
  assert.equal(xhigh, medium);
});

test("formatUsdSplit prints three decimals and never NaN", () => {
  assert.equal(formatUsdSplit(0.067), "$0.067");
  assert.equal(formatUsdSplit(0.005), "$0.005");
  assert.equal(formatUsdSplit(1.25), "$1.250");
  assert.equal(formatUsdSplit(0.0004), "$0.000");
  assert.equal(formatUsdSplit(0), "$0.000");
  assert.equal(formatUsdSplit(Number.NaN), "$0.000");
  assert.equal(formatUsdSplit(Number.POSITIVE_INFINITY), "$0.000");
});

test("formatCostFigure prefixes a tilde except on the under-a-cent floor", () => {
  assert.equal(formatCostFigure(0.07), "~$0.07");
  assert.equal(formatCostFigure(1.2), "~$1.20");
  assert.equal(formatCostFigure(0.004), "<$0.01");
  assert.equal(formatCostFigure(Number.NaN), "~$0.00");
});

test("describeCostEstimate gives the settled figure in words for a button's accessible name", () => {
  assert.equal(describeCostEstimate(0.07), "estimated cost about $0.07");
  assert.equal(describeCostEstimate(0.004), "estimated cost under $0.01");
  assert.equal(describeCostEstimate(null), "cost is usage-based");
  assert.equal(describeCostEstimate(Number.NaN), "cost is usage-based");
});

test("formatCostSplit names the references and both terms, with per-style wording for Review Boards", () => {
  const breakdown = { inputUsd: 0.067, outputUsd: 0.005, totalUsd: 0.072 };
  assert.equal(formatCostSplit(6, breakdown), "6 references · input $0.067 + output $0.005");
  assert.equal(formatCostSplit(1, breakdown), "1 reference · input $0.067 + output $0.005");
  assert.equal(formatCostSplit(4, breakdown, { perStyle: true }), "4 references per style · input $0.067 + output $0.005");
});

test("formatCostSplit names an extra image beside the references without counting it as one", () => {
  const breakdown = { inputUsd: 0.067, outputUsd: 0.005, totalUsd: 0.072 };
  assert.equal(formatCostSplit(10, breakdown, { extra: "draft" }), "10 references + draft · input $0.067 + output $0.005");
  assert.equal(formatCostSplit(1, breakdown, { extra: "layout" }), "1 reference + layout · input $0.067 + output $0.005");
  assert.equal(formatCostSplit(6, breakdown, { extra: "" }), "6 references · input $0.067 + output $0.005");
  assert.equal(formatCostSplit(6, breakdown, { extra: "  " }), "6 references · input $0.067 + output $0.005");
});

test("the old Workbench path re-exports the very same functions and constants as the shared module", () => {
  const legacyNames = Object.keys(legacyCost).sort();
  const sharedNames = Object.keys(sharedCost).sort();
  assert.deepEqual(legacyNames, sharedNames);
  for (const name of sharedNames) {
    assert.equal(legacyCost[name], sharedCost[name], `${name} must be the same binding through both paths`);
  }
  assert.equal(legacyCost.estimateRunBreakdownUsd, estimateRunBreakdownUsd);
  assert.equal(legacyCost.CALIBRATION_STORAGE_KEY, "mc.workbench.imageTokenCalibration.v1");
  assert.equal(legacyCost.OUTPUT_TOKEN_STORAGE_KEY, "mc.workbench.outputTokens.v1");
});

test("calibration written through one path is read through the other (one shared store)", () => {
  const adapter = createMemoryAdapter();
  legacyCost.setCalibrationStorageAdapter(adapter);
  const before = estimateRunUsd({ size: "2048x1360", quality: "medium", candidates: 1, inputImages: 2 });
  legacyCost.recordImageTokenCalibration("2048x1360", "medium", 4000, 2);
  const after = estimateRunUsd({ size: "2048x1360", quality: "medium", candidates: 1, inputImages: 2 });
  assert.notEqual(after, before);
  assert.equal(after, legacyCost.estimateRunUsd({ size: "2048x1360", quality: "medium", candidates: 1, inputImages: 2 }));
});
