import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { indexTileCodes, resolveTileCode, tileLibraryDir } from "../scripts/autoboard/lib/tiles.mjs";

function withFakeTileLibrary(filenames, fn) {
  const libraryRoot = mkdtempSync(path.join(tmpdir(), "autoboard-tiles-test-"));
  const dir = tileLibraryDir(libraryRoot);
  mkdirSync(dir, { recursive: true });
  for (const name of filenames) writeFileSync(path.join(dir, name), "");
  try {
    return fn(libraryRoot);
  } finally {
    rmSync(libraryRoot, { recursive: true, force: true });
  }
}

test("indexTileCodes parses a single-code filename into code + material name", () => {
  withFakeTileLibrary(["AT1_Clara_Caviar.jpg"], (libraryRoot) => {
    const index = indexTileCodes(libraryRoot);
    const tile = resolveTileCode(index, "AT1");
    assert.equal(tile.materialName, "Clara Caviar");
    assert.ok(tile.filePath.endsWith("AT1_Clara_Caviar.jpg"));
  });
});

test("indexTileCodes maps a compound filename's photo to each of its codes", () => {
  withFakeTileLibrary(["FT1_WT1_Cortar_Bone.jpg"], (libraryRoot) => {
    const index = indexTileCodes(libraryRoot);
    const floor = resolveTileCode(index, "FT1");
    const wall = resolveTileCode(index, "WT1");
    assert.equal(floor.filePath, wall.filePath);
    assert.equal(floor.materialName, "Cortar Bone");
  });
});

test("indexTileCodes picks the alphabetically-first file when a code has duplicates", () => {
  withFakeTileLibrary(["WT5_Tones_Sapphire.png", "WT5_Tones_Sapphire_field.png"], (libraryRoot) => {
    const index = indexTileCodes(libraryRoot);
    const tile = resolveTileCode(index, "WT5");
    assert.ok(tile.filePath.endsWith("WT5_Tones_Sapphire.png"));
  });
});

test("resolveTileCode is case-insensitive and returns null for an unknown code", () => {
  withFakeTileLibrary(["AT2_Tones_Sandstone.png"], (libraryRoot) => {
    const index = indexTileCodes(libraryRoot);
    assert.ok(resolveTileCode(index, "at2"));
    assert.equal(resolveTileCode(index, "AT99"), null);
  });
});

test("indexTileCodes ignores non-image files and files with no leading code", () => {
  withFakeTileLibrary(["README.txt", "loose_photo_no_code.jpg", "WT2_Cortar_Bone_Reed.jpg"], (libraryRoot) => {
    const index = indexTileCodes(libraryRoot);
    assert.equal(index.size, 1);
    assert.ok(resolveTileCode(index, "WT2"));
  });
});
