// Parity pins for the shared-core extraction (app/lib/autoboard/*.ts).
//
// Every test here asserts behaviour that the existing suite leaves unobserved
// and that a reasonable-looking TypeScript port would silently change. They
// were written against the .mjs modules BEFORE any code moved, so a green run
// on both sides of the extraction is the proof that the move changed nothing.
// A failure here is a behaviour change, not a style disagreement.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { emptyGaps } from "../scripts/autoboard/lib/source.mjs";
import { assignSlots, buildBoards, loadBuildLog, makeDiskImageResolver } from "../scripts/autoboard/lib/match.mjs";
import { withUploads } from "../scripts/autoboard/lib/uploads.mjs";
import { boardPayload, boardReferenceFiles } from "../scripts/autoboard/lib/variants.mjs";

function row(overrides) {
  return {
    rowId: "1",
    unitType: "Penthouse",
    roomLabel: "Bath 2",
    roomOriginal: "Bath 2",
    costCode: "11 45 Plumbing Fixtures M",
    itemName: "Item",
    sku: "SKU-1",
    qty: 1,
    reference: "",
    ...overrides,
  };
}

function makeFakeLibrary(csvRows) {
  const root = mkdtempSync(path.join(os.tmpdir(), "autoboard-parity-"));
  const buildDir = path.join(root, "Master_Library_Build");
  mkdirSync(buildDir, { recursive: true });
  const header = "row_id,item_name,sku,folder,matched_files";
  const lines = csvRows.map((r) => `${r.row_id},${r.item_name},${r.sku},${r.folder},${r.matched_files}`);
  writeFileSync(path.join(buildDir, "_BUILD_LOG.csv"), [header, ...lines].join("\n") + "\n", "utf8");
  return root;
}

function makeFolderWithImage(root, folderName, fileName) {
  const dir = path.join(root, ...folderName.split("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, fileName), "fake image bytes");
}

// ---------------------------------------------------------------------------
// 1. The injected-resolver arity, which differs between definition and use.
// ---------------------------------------------------------------------------

// buildBoards calls resolveImages(rowId, sku) with TWO arguments and
// makeDiskImageResolver honours the second one (it is the whole reused-row-id
// guard). But both production call sites — cli.mjs and review-server.mjs —
// wrap it in withUploads, whose closure takes ONE parameter and drops the sku.
// So in the shipped CLI the SKU guard never fires, and the row-id entry is
// trusted unconditionally.
//
// That swallow is load-bearing, not a bug to tidy up on the way past: turning
// the guard on would reroute which folder's photos land on a board whose row
// id was reused, which is a rendering change and belongs in its own reviewed
// commit. Typing the resolver as (rowId) => string[] would delete the guard;
// forwarding the sku in withUploads would switch it on. This test pins the
// third option — signature keeps the optional sku, withUploads keeps dropping
// it — so either drift fails loudly.
test("withUploads drops the sku argument, so the disk resolver's SKU guard stays dormant in production", (t) => {
  const root = makeFakeLibrary([
    { row_id: "1", item_name: "GROHE Chrome Valve", sku: "GRH-1", folder: "GROHE_Valve", matched_files: "photo.jpg" },
    { row_id: "2", item_name: "Hansgrohe Hand Shower", sku: "HG-2", folder: "Hansgrohe_HandShower", matched_files: "hand.jpg" },
  ]);
  const uploadsRoot = mkdtempSync(path.join(os.tmpdir(), "autoboard-parity-uploads-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(uploadsRoot, { recursive: true, force: true });
  });
  makeFolderWithImage(root, "GROHE_Valve", "photo.jpg");
  makeFolderWithImage(root, "Hansgrohe_HandShower", "hand.jpg");

  const buildLog = loadBuildLog(root);
  const bare = makeDiskImageResolver(root, buildLog);

  // Called directly with a mismatched sku, the guard fires and the bySku index
  // wins: row 1's id now belongs to a different product.
  assert.ok(bare("1", "HG-2")[0].endsWith(path.join("Hansgrohe_HandShower", "hand.jpg")));

  // Through withUploads — the only way production ever calls it — the same
  // arguments resolve to the row-id folder, because the sku never arrives.
  const wrapped = withUploads(bare, uploadsRoot);
  assert.ok(wrapped("1", "HG-2")[0].endsWith(path.join("GROHE_Valve", "photo.jpg")));
  assert.equal(wrapped.length, 1, "withUploads' closure must keep taking exactly one declared parameter");
});

// ---------------------------------------------------------------------------
// 2. The tile sentinel the CLI's HOLD warning keys on.
// ---------------------------------------------------------------------------

// cli.mjs detects a not-yet-released tile pick with `item.rowId === null` and
// prints the operator-facing "release status is still HOLD" line off that
// count. `undefined` or "" fails that check and the warning silently vanishes,
// so the sentinel is strictNull, and the ported type must be `string | null`
// rather than optional.
test("injected tile items carry rowId === null exactly, and row-sourced tiles do not", () => {
  const tileIndex = new Map([
    ["WT2", { code: "WT2", materialName: "Cortar Bone Reed", filePath: "/fake/WT2.jpg" }],
    ["AT1", { code: "AT1", materialName: "Clara Caviar", filePath: "/fake/AT1.jpg" }],
  ]);
  const tileAssignments = new Map([["penthouse::bath 2", { mainTile: "WT2", accentTile: "AT1" }]]);
  const { boards } = buildBoards(
    [
      row({ rowId: "1", itemName: "Brizo Odin Lavatory Faucet" }),
      row({ rowId: "2", itemName: "Brizo Round Showerhead" }),
    ],
    { resolveImages: (rowId) => [`/fake/${rowId}.png`], gaps: emptyGaps(), tileAssignments, tileIndex },
  );
  const board = boards.find((entry) => entry.collageType === "bathroom_fixture_collage");
  // strictEqual, so `undefined` is a failure rather than a loose-equal pass.
  assert.strictEqual(board.items.find((item) => item.slotId === "main_tile").rowId, null);
  assert.strictEqual(board.items.find((item) => item.slotId === "accent_tile").rowId, null);

  // A project whose tiles are ordinary manifest rows (651 Belmont) must keep a
  // real row id, so the CLI does not tar it with the Wieland HOLD schedule.
  const fromRows = buildBoards(
    [
      row({ rowId: "1", itemName: "Brizo Odin Lavatory Faucet" }),
      row({ rowId: "2", itemName: "Brizo Round Showerhead" }),
      row({ rowId: "3", itemName: "MSI Sande Ivory Floor Tile" }),
    ],
    { resolveImages: (rowId) => [`/fake/${rowId}.png`], gaps: emptyGaps() },
  ).boards.find((entry) => entry.collageType === "bathroom_fixture_collage");
  assert.strictEqual(fromRows.items.find((item) => item.slotId === "main_tile").rowId, "3");
});

// ---------------------------------------------------------------------------
// 3. One substitute record per slot the row was kept out of.
// ---------------------------------------------------------------------------

// A substitute is never added to assignedRowIds, so it is re-tested against
// every remaining slot and emits a record each time it matches. That is the
// documented intent — gaps.md tells the operator which slots it was kept out
// of — but the existing substitute tests all use rows that match exactly one
// slot, so collapsing the accumulator to a Map keyed by rowId (a natural tidy-
// up, since a `heldBack` Set is already in scope) would pass them all while
// quietly shortening gaps.md.
test("a substitute matching two slots is reported once per slot", () => {
  const rows = [
    row({ rowId: "80", itemName: "Brizo Vanity Faucet Light", status: "alternative" }),
  ];
  const { substitutes } = assignSlots(rows, "bathroom_fixture_collage");
  assert.deepEqual(
    substitutes.map((entry) => entry.slotId),
    ["vanity_faucet", "light_fixture"],
  );
  assert.deepEqual(new Set(substitutes.map((entry) => entry.rowId)), new Set(["80"]));
});

// ---------------------------------------------------------------------------
// 4. Reference names are basenames under win32 semantics.
// ---------------------------------------------------------------------------

// variants.mjs builds every item's imageNames and the matching multipart
// files[].name as `${slotId}--${path.basename(imagePath)}`. The existing
// alignment test compares the two lists against each other — both built from
// the same helper — so a wrong-but-consistent basename keeps them aligned and
// passes. This pins the value itself.
//
// It pins it against node:path rather than against a literal, because
// path.basename is PLATFORM-SENSITIVE and the current behaviour differs by
// platform: the library root is a Windows path (source.mjs DEFAULT_LIBRARY_ROOT),
// so on the operator's machine path.basename strips the backslash-separated
// directories and yields "photo.jpg", while on Linux it strips nothing and the
// whole "H:\\Games\\...\\photo.jpg" becomes the reference name. Asserting the
// win32 literal here would fail on CI today; asserting path.basename pins
// whatever this platform does, which is what a refactor must not change.
// Hand-rolling `imagePath.split("/").pop()` passes on Linux and corrupts every
// name on Windows — that is the failure this catches.
//
// The platform split itself is a real defect, not something to fix inside an
// extraction: see docs/autoboard-shared-core.md.
test("reference names are basenames, matching node:path on this platform", () => {
  const windowsPath = "H:\\Games\\1529 Wieland - Master Library\\GROHE_Valve\\photo.jpg";
  const posixPath = "/srv/library/GROHE_Valve/photo.jpg";
  const board = {
    id: "penthouse-bath-2-fixture",
    unitType: "Penthouse",
    roomLabel: "Bath 2",
    collageType: "bathroom_fixture_collage",
    kindLabel: "Fixture Collage",
    title: "Penthouse Bath 2 Fixture Collage",
    items: [
      {
        slotId: "vanity_faucet",
        role: "faucet",
        required: true,
        rowId: "1",
        sku: "GRH-1",
        brand: "GROHE",
        name: "GROHE Valve",
        notes: "",
        images: [windowsPath, posixPath],
      },
    ],
  };
  const payload = boardPayload(board, {});
  assert.deepEqual(payload.items[0].imageNames, [
    `vanity_faucet--${path.basename(windowsPath)}`,
    `vanity_faucet--${path.basename(posixPath)}`,
  ]);
  // A POSIX path basenames the same way on every platform, so this half is an
  // unconditional literal.
  assert.equal(payload.items[0].imageNames[1], "vanity_faucet--photo.jpg");
  assert.deepEqual(
    boardReferenceFiles(board).map((file) => file.name),
    payload.items[0].imageNames,
  );
});

// ---------------------------------------------------------------------------
// 5. app/lib/autoboard stays loadable by both runtimes.
// ---------------------------------------------------------------------------

// app/lib is compiled into the BROWSER bundle as well as the Worker, and
// nothing else in app/ or worker/ imports a node: builtin today. Node's ESM
// resolver also rejects two forms the rest of app/ uses freely: extensionless
// relative imports and the "@/" tsconfig alias, neither of which exists at
// runtime for a .mjs entry point. None of build, lint or typecheck produces a
// signal for any of this, so the grep IS the gate.
const AUTOBOARD_CORE_DIR = new URL("../app/lib/autoboard/", import.meta.url);

function coreModuleFiles() {
  let names = [];
  try {
    names = readdirSync(AUTOBOARD_CORE_DIR);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return names.filter((name) => name.endsWith(".ts"));
}

test("app/lib/autoboard modules import no node: builtin, no alias, and no JSON", () => {
  const files = coreModuleFiles();
  assert.ok(files.length > 0, "expected at least one module under app/lib/autoboard/");
  for (const name of files) {
    const source = readFileSync(new URL(name, AUTOBOARD_CORE_DIR), "utf8");
    const specifiers = [...source.matchAll(/\bfrom\s+"([^"]+)"/g)].map((entry) => entry[1]);
    for (const specifier of specifiers) {
      assert.ok(!specifier.startsWith("node:"), `${name} imports the node: builtin ${specifier}`);
      assert.ok(!specifier.startsWith("@/"), `${name} uses the "@/" alias (${specifier}), which Node cannot resolve`);
      assert.ok(!specifier.includes("scripts/"), `${name} imports back into scripts/ (${specifier})`);
      assert.ok(!specifier.endsWith(".json"), `${name} imports JSON (${specifier}), which needs an import attribute`);
      if (specifier.startsWith(".")) {
        assert.ok(specifier.endsWith(".ts"), `${name} imports ${specifier} without the explicit .ts extension`);
      }
    }
  }
});

test("app/lib/autoboard modules load from a .mjs entry point with no loader hooks", async () => {
  for (const name of coreModuleFiles()) {
    await import(new URL(name, AUTOBOARD_CORE_DIR).href);
  }
});

// ---------------------------------------------------------------------------
// 6. `plan` end to end, through the real CLI.
// ---------------------------------------------------------------------------

// The suite's other CLI test only runs `generate` against a hand-written
// plan.json, so the entire first half of the pipeline — loadLibraryRows ->
// withUploads(makeDiskImageResolver(libraryRoot)) -> buildBoards ->
// annotateReferenceMeta -> gapsMarkdown -> the HOLD warning — had no end-to-end
// coverage at all. In particular makeDiskImageResolver's `buildLog =
// loadBuildLog(libraryRoot)` DEFAULT PARAMETER is the form both production call
// sites use and the form no unit test uses: every one passes buildLog
// explicitly. Lose that default to an empty Map during a refactor and every row
// resolves to zero images, every board falls under minSlots, and `plan` exits 0
// having written an empty board list and a fat gaps.md. Nothing else fails.
//
// Spawned with cwd set to a temp dir, because RUNS_ROOT is relative — so the
// run folder lands there and leaves the repo alone.

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8cfc0c0c0c40000000704fe07b3ee7e0000000049454e44ae426082",
  "hex",
);

function makePlanLibrary(items) {
  const root = mkdtempSync(path.join(os.tmpdir(), "autoboard-plan-e2e-"));
  const manifest = [
    "row_id,unit_type,room_type,cost_code,item_name,sku,qty,reference,status",
    ...items.map((item) =>
      [item.rowId, "Penthouse", "Bath 2", item.costCode, item.itemName, item.sku, "1", "", item.status ?? ""].join(","),
    ),
  ];
  writeFileSync(path.join(root, "build_manifest_v2.csv"), manifest.join("\n") + "\n", "utf8");

  const buildDir = path.join(root, "Master_Library_Build");
  mkdirSync(buildDir, { recursive: true });
  const log = [
    "row_id,item_name,sku,folder,matched_files",
    ...items.map((item) => [item.rowId, item.itemName, item.sku, item.folder, "photo.png"].join(",")),
  ];
  writeFileSync(path.join(buildDir, "_BUILD_LOG.csv"), log.join("\n") + "\n", "utf8");

  for (const item of items) {
    const dir = path.join(root, item.folder);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "photo.png"), PNG);
  }
  // Part of the library-root contract: indexTileCodes reads Tile/tiles
  // unconditionally and a plan run dies with ENOENT without it. Left empty —
  // this project's tiles are manifest rows, not schedule photos.
  mkdirSync(path.join(root, "Tile", "tiles"), { recursive: true });
  return root;
}

function runCli(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", path.join(process.cwd(), "scripts", "autoboard", "cli.mjs"), ...args],
      { cwd, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("plan --offline builds boards end to end, resolving images through the default build log", async (t) => {
  const libraryRoot = makePlanLibrary([
    { rowId: "1", itemName: "Brizo Odin Lavatory Faucet", sku: "BRZ-1", costCode: "11 45 Plumbing Fixtures M", folder: "Brizo_Faucet" },
    { rowId: "2", itemName: "Brizo Round Showerhead", sku: "BRZ-2", costCode: "11 45 Plumbing Fixtures M", folder: "Brizo_Showerhead" },
    { rowId: "3", itemName: "MSI Sande Ivory Floor Tile", sku: "MSI-3", costCode: "09 30 Tiling M", folder: "MSI_Tile" },
    // Held back: an alternative must not win vanity_faucet off row 1.
    { rowId: "4", itemName: "AXOR Uno Lavatory Faucet", sku: "AXR-4", costCode: "11 45 Plumbing Fixtures M", folder: "AXOR_Faucet", status: "alternative" },
  ]);
  const workDir = mkdtempSync(path.join(os.tmpdir(), "autoboard-plan-cwd-"));
  t.after(() => {
    rmSync(libraryRoot, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  const result = await runCli(["plan", "--offline", "--library-root", libraryRoot], workDir);
  assert.equal(result.code, 0, `plan exited ${result.code}\n${result.stdout}\n${result.stderr}`);

  const runFolder = /Run folder: (.+)/.exec(result.stdout)?.[1].trim();
  assert.ok(runFolder, `no run folder in stdout:\n${result.stdout}`);
  const plan = JSON.parse(readFileSync(path.join(workDir, runFolder, "plan.json"), "utf8"));

  const fixture = plan.boards.find((board) => board.collageType === "bathroom_fixture_collage");
  assert.ok(fixture, `no fixture board in ${JSON.stringify(plan.boards.map((b) => b.id))}`);
  assert.equal(fixture.id, "penthouse-bath-2-fixture");

  // Images came off disk: proof the resolver was constructed with a real build
  // log via the default parameter, not an empty Map.
  const faucet = fixture.items.find((item) => item.slotId === "vanity_faucet");
  assert.equal(faucet.rowId, "1");
  assert.ok(faucet.images[0].includes("Brizo_Faucet"), faucet.images[0]);

  // The tile came from a manifest row, so it keeps a real row id and the HOLD
  // warning must NOT print for this project.
  assert.strictEqual(fixture.items.find((item) => item.slotId === "main_tile").rowId, "3");
  assert.doesNotMatch(result.stdout, /release status is still HOLD/);

  // The substitute was held back from the slot and reported as one.
  const gapsMd = readFileSync(path.join(workDir, runFolder, "gaps.md"), "utf8");
  assert.match(gapsMd, /Substitutes held back from a slot/);
  assert.match(gapsMd, /AXOR Uno Lavatory Faucet/);
});
