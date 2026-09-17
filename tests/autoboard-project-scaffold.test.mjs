import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { validateCollageRequest } from "../app/lib/collage.ts";
import { csvObjects, emptyGaps, loadOfflineRows } from "../scripts/autoboard/lib/source.mjs";
import { buildBoards, loadBuildLog, makeDiskImageResolver } from "../scripts/autoboard/lib/match.mjs";
import { boardPayload, DEFAULT_VARIANTS } from "../scripts/autoboard/lib/variants.mjs";
import {
  fetchReferenceImages,
  folderFor,
  loadImageManifest,
  loadProjectDefinition,
  scaffoldProject,
} from "../scripts/autoboard/scaffold-project.mjs";

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8cfc0c0c0c40000000704fe07b3ee7e0000000049454e44ae426082",
  "hex",
);

function tempRoot() {
  return mkdtempSync(path.join(os.tmpdir(), "autoboard-project-"));
}

async function belmont() {
  return loadProjectDefinition("651-belmont");
}

// Photos for every item the document actually selected a product for; the
// "pending" rows stay empty on purpose, exactly as they will on disk.
function addSelectedPhotos(definition, root, rooms) {
  for (const room of definition.rooms) {
    if (rooms && !rooms.includes(room.room)) continue;
    for (const item of room.items) {
      if ((item.status ?? "preferred") === "pending") continue;
      const folder = path.join(root, ...folderFor(room, item).split("/"));
      writeFileSync(path.join(folder, `${item.rowId}.png`), PNG);
    }
  }
}

test("scaffold writes a manifest the offline loader accepts", async () => {
  const root = tempRoot();
  try {
    const definition = await belmont();
    const summary = await scaffoldProject({ definition, root });
    assert.equal(summary.libraryRoot, path.resolve(root));

    const { rows, gaps } = await loadOfflineRows(root);
    assert.equal(rows.length, summary.itemCount);
    assert.deepEqual(gaps, { ...emptyGaps() });
    assert.deepEqual([...new Set(rows.map((row) => row.unitType))], ["651 Belmont"]);
    // "Bath 1" survives normalizeRoomLabel unchanged, so board types resolve,
    // and "Kitchen" carries the Penthouse appliances read from Smartsheet.
    assert.deepEqual([...new Set(rows.map((row) => row.roomLabel))].sort(), ["Bath 1", "Bath 2", "Bath 3", "Kitchen"]);

    const seafoam = rows.find((row) => row.sku === "PALETTE-SEAFOAM-6X6");
    assert.equal(seafoam.roomLabel, "Bath 2");
    assert.match(seafoam.reference, /^https:\/\/www\.elmsurfaces\.com\//);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scaffold quotes manifest cells containing commas", async () => {
  const root = tempRoot();
  try {
    const definition = await belmont();
    await scaffoldProject({ definition, root });
    const records = csvObjects(readFileSync(path.join(root, "build_manifest_v2.csv"), "utf8"));
    const holder = records.find((record) => record.row_id === "B2-11");
    assert.equal(holder.item_name, "Kohler Purist Toilet Paper Holder, vertical");
    assert.equal(holder.unit_type, "651 Belmont");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("re-running the scaffold picks up photos dropped into the item folders", async () => {
  const root = tempRoot();
  try {
    const definition = await belmont();
    const first = await scaffoldProject({ definition, root });
    assert.equal(first.withPhotos, 0);
    assert.ok(first.missingPhotos.includes("B2-01"));

    addSelectedPhotos(definition, root);
    const second = await scaffoldProject({ definition, root });
    assert.deepEqual(second.missingPhotos, []);
    assert.equal(second.withPhotos, second.itemCount - second.pendingCount);

    const resolve = makeDiskImageResolver(root, loadBuildLog(root));
    const images = resolve("B2-01", "PALETTE-SEAFOAM-6X6");
    assert.equal(images.length, 1);
    assert.equal(path.basename(images[0]), "B2-01.png");
    // A pending row has no photo and must resolve to nothing rather than
    // borrowing another row's folder.
    assert.deepEqual(resolve("B1-01", ""), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("651 Belmont boards fill the slots the recommendations document specifies", async () => {
  const root = tempRoot();
  try {
    const definition = await belmont();
    await scaffoldProject({ definition, root });
    addSelectedPhotos(definition, root);
    await scaffoldProject({ definition, root });

    const { rows } = await loadOfflineRows(root);
    const gaps = emptyGaps();
    const { boards } = buildBoards(rows, {
      resolveImages: makeDiskImageResolver(root, loadBuildLog(root)),
      gaps,
    });

    const byId = new Map(boards.map((board) => [board.id, board]));
    const slotSku = (boardId, slotId) => {
      const board = byId.get(boardId);
      assert.ok(board, `no board ${boardId} (built: ${[...byId.keys()].join(", ")})`);
      return board.items.find((item) => item.slotId === slotId)?.sku;
    };

    // Bath 2 — Seafoam field is the main tile, Caraibi the niche accent; the
    // wall-mounted Purist trim takes the faucet slot and the tub/shower trim
    // the valve slot.
    const bath2Fixtures = "651-belmont-bath-2-fixture";
    assert.equal(slotSku(bath2Fixtures, "main_tile"), "PALETTE-SEAFOAM-6X6");
    assert.equal(slotSku(bath2Fixtures, "accent_tile"), "NWGGEMCAR5X10G");
    assert.equal(slotSku(bath2Fixtures, "vanity_faucet"), "K-T14414-4-BN");
    assert.equal(slotSku(bath2Fixtures, "valve_trim"), "K-T14420-4G-BN");
    assert.equal(slotSku(bath2Fixtures, "cabinet_hardware"), "K-25498-BN");
    assert.equal(slotSku(bath2Fixtures, "light_fixture"), "WS-34125-30-BN");

    const bath2Tiles = "651-belmont-bath-2-tile";
    assert.equal(slotSku(bath2Tiles, "wall_tile"), "PALETTE-SEAFOAM-6X6");
    assert.equal(slotSku(bath2Tiles, "floor_tile"), "100324943");
    assert.equal(slotSku(bath2Tiles, "accent_tile"), "NWGGEMCAR5X10G");
    assert.equal(slotSku(bath2Tiles, "metal_finish"), "BN");

    // Bath 3 — the niche relief must win accent_tile over the shower-floor
    // mosaic, which is why B3-02 is listed before B3-04.
    const bath3Fixtures = "651-belmont-bath-3-fixture";
    assert.equal(slotSku(bath3Fixtures, "main_tile"), "GROUNDED-ALABASTER-12X24");
    assert.equal(slotSku(bath3Fixtures, "accent_tile"), "204221E");
    assert.equal(slotSku(bath3Fixtures, "vanity_faucet"), "K-14406-4-BL");
    assert.equal(slotSku(bath3Fixtures, "shower_head"), "K-22181-G-BL");
    assert.equal(slotSku(bath3Fixtures, "light_fixture"), "700BCBND24B-LED930");

    const bath3Tiles = "651-belmont-bath-3-tile";
    assert.equal(slotSku(bath3Tiles, "accent_tile"), "204221E");
    assert.equal(slotSku(bath3Tiles, "metal_finish"), "BL");

    // Bathroom 1 has no product selected at all, so it must produce no board
    // and be reported as a gap instead of a guess.
    assert.deepEqual([...byId.keys()].filter((id) => id.includes("bath-1")), []);
    assert.ok(gaps.skippedBoards.some((entry) => entry.roomLabel === "Bath 1"));

    // Every board the plan would carry has to pass the app's own validator.
    for (const board of boards) {
      for (const variant of DEFAULT_VARIANTS) {
        validateCollageRequest(boardPayload(board, variant));
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a dry run reports without writing anything", async () => {
  const root = tempRoot();
  try {
    const definition = await belmont();
    const summary = await scaffoldProject({ definition, root, dryRun: true });
    assert.equal(summary.dryRun, true);
    assert.ok(summary.itemCount > 0);
    await assert.rejects(() => loadOfflineRows(root), /ENOENT|no such file/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadProjectDefinition rejects an unknown project by name", async () => {
  await assert.rejects(() => loadProjectDefinition("not-a-project"), /No project definition/);
});

test("every imageKey in the 651 Belmont definition exists in its image manifest", async () => {
  const definition = await belmont();
  const manifest = await loadImageManifest("651-belmont");
  const keys = definition.rooms.flatMap((room) => room.items).filter((item) => item.imageKey);
  assert.ok(keys.length > 0, "the definition should carry image keys");
  const unknown = keys.filter((item) => !manifest.images[item.imageKey]);
  assert.deepEqual(unknown.map((item) => `${item.rowId} -> ${item.imageKey}`), []);
  // Every selected (non-pending) row must be wired to a key, or its photo can
  // never be fetched.
  const unwired = definition.rooms
    .flatMap((room) => room.items)
    .filter((item) => (item.status ?? "preferred") !== "pending" && !item.imageKey);
  assert.deepEqual(unwired.map((item) => item.rowId), []);
});

test("fetchReferenceImages writes each item's photos and the build log then finds them", async () => {
  const root = tempRoot();
  try {
    const definition = await belmont();
    await scaffoldProject({ definition, root });

    const manifest = {
      images: {
        "elm-palette-seafoam": {
          files: [
            { url: "https://example.test/seafoam-a.jpg", kind: "face", contentType: "image/jpeg", sha256: "aaa" },
            { url: "https://example.test/seafoam-b.jpg", kind: "detail", contentType: "image/jpeg", sha256: "bbb" },
          ],
        },
        "msi-gems-caraibi": { files: [], note: "vendor publishes no usable photo" },
      },
    };
    const requested = [];
    const download = async (url) => {
      requested.push(url);
      return { buffer: PNG, contentType: "image/jpeg" };
    };

    const first = await fetchReferenceImages({ definition, manifest, root, download });
    assert.equal(first.downloaded, 2);
    assert.equal(first.skipped, 0);
    assert.deepEqual(first.failures, []);
    // The manifest's recorded digests are deliberately wrong here, so both
    // downloads must be reported as having changed since review.
    assert.equal(first.drifted.length, 2);
    assert.ok(first.withoutImages.some((entry) => entry.imageKey === "msi-gems-caraibi"));
    assert.equal(requested.length, 2);

    const seafoamRoom = definition.rooms.find((room) => room.room === "Bath 2");
    const seafoam = seafoamRoom.items.find((item) => item.rowId === "B2-01");
    const folder = path.join(root, ...folderFor(seafoamRoom, seafoam).split("/"));
    assert.deepEqual(
      readdirSync(folder).sort(),
      ["B2-01-1-face.jpg", "B2-01-2-detail.jpg"],
    );

    // Re-running keeps what is on disk; --force replaces it.
    const second = await fetchReferenceImages({ definition, manifest, root, download });
    assert.equal(second.downloaded, 0);
    assert.equal(second.skipped, 2);
    const forced = await fetchReferenceImages({ definition, manifest, root, download, force: true });
    assert.equal(forced.downloaded, 2);

    // The build log only learns about the files once the scaffold re-runs.
    await scaffoldProject({ definition, root });
    const resolve = makeDiskImageResolver(root, loadBuildLog(root));
    const images = resolve("B2-01", "PALETTE-SEAFOAM-6X6");
    assert.equal(images.length, 2);
    assert.equal(path.basename(images[0]), "B2-01-1-face.jpg");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("re-fetching clears a file the manifest no longer writes, but not a hand-dropped photo", async () => {
  const root = tempRoot();
  try {
    const definition = await belmont();
    await scaffoldProject({ definition, root });
    const room = definition.rooms.find((entry) => entry.room === "Bath 2");
    const item = room.items.find((entry) => entry.rowId === "B2-01");
    const folder = path.join(root, ...folderFor(room, item).split("/"));

    const asJpeg = { images: { "elm-palette-seafoam": { files: [{ url: "https://example.test/a.jpg", kind: "face", contentType: "image/jpeg" }] } } };
    const download = async () => ({ buffer: PNG, contentType: "image/jpeg" });
    await fetchReferenceImages({ definition, manifest: asJpeg, root, download });
    // A photo someone put there by hand, which must survive every re-fetch.
    writeFileSync(path.join(folder, "site-photo.png"), PNG);
    assert.deepEqual(readdirSync(folder).sort(), ["B2-01-1-face.jpg", "site-photo.png"]);

    // Swapping the dealer's jpeg for the manufacturer's webp changes the
    // filename; the old one must not linger, or the build log sorts it first
    // and the board keeps rendering the picture that was replaced.
    const asWebp = { images: { "elm-palette-seafoam": { files: [{ url: "https://example.test/a.webp", kind: "face", contentType: "image/webp" }] } } };
    const summary = await fetchReferenceImages({ definition, manifest: asWebp, root, download, force: true });
    assert.deepEqual(readdirSync(folder).sort(), ["B2-01-1-face.webp", "site-photo.png"]);
    assert.deepEqual(summary.removed.map((entry) => entry.file), ["B2-01-1-face.jpg"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fetchReferenceImages records a download failure instead of throwing", async () => {
  const root = tempRoot();
  try {
    const definition = await belmont();
    await scaffoldProject({ definition, root });
    const manifest = {
      images: {
        "elm-palette-seafoam": {
          files: [{ url: "https://example.test/gone.jpg", kind: "face", contentType: "image/jpeg" }],
        },
      },
    };
    const summary = await fetchReferenceImages({
      definition,
      manifest,
      root,
      download: async () => {
        throw new Error("HTTP 404");
      },
    });
    assert.equal(summary.downloaded, 0);
    assert.deepEqual(summary.failures.map((failure) => failure.rowId), ["B2-01"]);
    assert.match(summary.failures[0].error, /404/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
