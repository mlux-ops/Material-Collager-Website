import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import sharp from "sharp";

import { annotateReferenceMeta } from "../scripts/autoboard/lib/image-meta.mjs";

async function withTempDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "autoboard-image-meta-test-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function writeImage(dir, name, width, height) {
  const filePath = path.join(dir, name);
  const buffer = await sharp({ create: { width, height, channels: 3, background: { r: 100, g: 100, b: 100 } } }).png().toBuffer();
  writeFileSync(filePath, buffer);
  return filePath;
}

function emptyGaps() {
  return { unfilledSlots: [] };
}

test("annotateReferenceMeta records width/height for every image in order and leaves high-res items ungapped", async () => {
  await withTempDir(async (dir) => {
    const bigImage = await writeImage(dir, "big.png", 1200, 900);
    const boards = [
      {
        unitType: "Penthouse",
        roomLabel: "Bath 2",
        collageType: "bathroom_fixture_collage",
        items: [{ slotId: "vanity_faucet", name: "Brizo Faucet", images: [bigImage] }],
      },
    ];
    const gaps = emptyGaps();
    await annotateReferenceMeta(boards, gaps);

    assert.deepEqual(boards[0].items[0].imageMeta, [{ path: bigImage, width: 1200, height: 900 }]);
    assert.deepEqual(gaps.lowResolutionReferences, []);
  });
});

test("annotateReferenceMeta flags an image whose long edge is under the threshold, without excluding it", async () => {
  await withTempDir(async (dir) => {
    const smallImage = await writeImage(dir, "small.png", 400, 300);
    const boards = [
      {
        unitType: "Penthouse",
        roomLabel: "Bath 2",
        collageType: "bathroom_fixture_collage",
        items: [{ slotId: "vanity_faucet", name: "Some Faucet", images: [smallImage] }],
      },
    ];
    const gaps = emptyGaps();
    await annotateReferenceMeta(boards, gaps);

    // Not excluded — the item and its image are still present.
    assert.deepEqual(boards[0].items[0].images, [smallImage]);
    assert.deepEqual(boards[0].items[0].imageMeta, [{ path: smallImage, width: 400, height: 300 }]);
    assert.equal(gaps.lowResolutionReferences.length, 1);
    assert.deepEqual(gaps.lowResolutionReferences[0], {
      unitType: "Penthouse",
      roomLabel: "Bath 2",
      collageType: "bathroom_fixture_collage",
      slotId: "vanity_faucet",
      itemName: "Some Faucet",
      path: smallImage,
      width: 400,
      height: 300,
      reason: "short edge 300 px",
    });
  });
});

// Height changed from the original 500 to 650 (long edge stays 700): a short
// edge of 500 would now also fail the default minShortEdge (600) and flag
// regardless of minLongEdge, which would defeat this test's purpose of
// isolating the minLongEdge option. 650 keeps the short edge clear of the
// default floor in both calls below.
test("annotateReferenceMeta respects a custom minLongEdge", async () => {
  await withTempDir(async (dir) => {
    const image = await writeImage(dir, "mid.png", 700, 650);
    const boards = [
      { unitType: "U", roomLabel: "R", collageType: "kitchen_material_palette", items: [{ slotId: "wood", name: "Wood", images: [image] }] },
    ];
    const gaps = emptyGaps();
    await annotateReferenceMeta(boards, gaps, { minLongEdge: 800 });
    assert.equal(gaps.lowResolutionReferences.length, 1);

    const gaps2 = emptyGaps();
    await annotateReferenceMeta(boards, gaps2, { minLongEdge: 600 });
    assert.equal(gaps2.lowResolutionReferences.length, 0);
  });
});

test("annotateReferenceMeta flags a thin strip via the short edge even though the long edge clears the floor", async () => {
  await withTempDir(async (dir) => {
    const stripImage = await writeImage(dir, "strip.png", 122, 1200);
    const boards = [
      { unitType: "U", roomLabel: "R", collageType: "kitchen_material_palette", items: [{ slotId: "tile", name: "Strip Tile", images: [stripImage] }] },
    ];
    const gaps = emptyGaps();
    await annotateReferenceMeta(boards, gaps);

    assert.equal(gaps.lowResolutionReferences.length, 1);
    assert.equal(gaps.lowResolutionReferences[0].reason, "short edge 122 px");
  });
});

test("annotateReferenceMeta does not flag a square image at the floor", async () => {
  await withTempDir(async (dir) => {
    const squareImage = await writeImage(dir, "square.png", 900, 900);
    const boards = [
      { unitType: "U", roomLabel: "R", collageType: "kitchen_material_palette", items: [{ slotId: "tile", name: "Square Tile", images: [squareImage] }] },
    ];
    const gaps = emptyGaps();
    await annotateReferenceMeta(boards, gaps);

    assert.deepEqual(gaps.lowResolutionReferences, []);
  });
});

test("annotateReferenceMeta flags a squat strip via the short edge", async () => {
  await withTempDir(async (dir) => {
    const squatImage = await writeImage(dir, "squat.jpg", 1200, 453);
    const boards = [
      { unitType: "U", roomLabel: "R", collageType: "kitchen_material_palette", items: [{ slotId: "tile", name: "Squat Tile", images: [squatImage] }] },
    ];
    const gaps = emptyGaps();
    await annotateReferenceMeta(boards, gaps);

    assert.equal(gaps.lowResolutionReferences.length, 1);
    assert.equal(gaps.lowResolutionReferences[0].reason, "short edge 453 px");
  });
});

test("annotateReferenceMeta initializes gaps.lowResolutionReferences even if absent, and handles multiple images per item", async () => {
  await withTempDir(async (dir) => {
    const first = await writeImage(dir, "first.png", 1000, 1000);
    const second = await writeImage(dir, "second.png", 200, 200);
    const boards = [
      {
        unitType: "Triplex",
        roomLabel: "Kitchen",
        collageType: "kitchen_material_palette",
        items: [{ slotId: "countertop", name: "Quartz", images: [first, second] }],
      },
    ];
    const gaps = {}; // no lowResolutionReferences key at all
    await annotateReferenceMeta(boards, gaps);

    assert.ok(Array.isArray(gaps.lowResolutionReferences));
    assert.deepEqual(boards[0].items[0].imageMeta, [
      { path: first, width: 1000, height: 1000 },
      { path: second, width: 200, height: 200 },
    ]);
    assert.equal(gaps.lowResolutionReferences.length, 1);
    assert.equal(gaps.lowResolutionReferences[0].path, second);
  });
});

test("annotateReferenceMeta records an error and skips the gap for an unreadable file", async () => {
  await withTempDir(async (dir) => {
    const badPath = path.join(dir, "not-an-image.png");
    writeFileSync(badPath, Buffer.from("not actually an image"));
    const boards = [
      { unitType: "U", roomLabel: "R", collageType: "kitchen_material_palette", items: [{ slotId: "wood", name: "Wood", images: [badPath] }] },
    ];
    const gaps = emptyGaps();
    await annotateReferenceMeta(boards, gaps);

    assert.equal(boards[0].items[0].imageMeta.length, 1);
    assert.equal(boards[0].items[0].imageMeta[0].path, badPath);
    assert.ok(boards[0].items[0].imageMeta[0].error);
    assert.equal(boards[0].items[0].imageMeta[0].width, undefined);
    assert.deepEqual(gaps.lowResolutionReferences, []);
  });
});
