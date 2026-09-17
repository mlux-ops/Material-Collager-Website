#!/usr/bin/env node
//
// Materializes the library root the autoboard CLI reads for a project that
// has no Smartsheet sheet of its own — the 651 Belmont bathrooms are the
// first — from a tracked project definition under scripts/autoboard/projects/.
//
//   node scripts/autoboard/scaffold-project.mjs --project 651-belmont
//   node scripts/autoboard/scaffold-project.mjs --project 651-belmont --root "D:\\651 Belmont" --dry-run
//
// What it writes into the library root:
//   build_manifest_v2.csv               what `plan --offline` reads
//   Master_Library_Build/_BUILD_LOG.csv the row_id -> folder join match.mjs
//                                       resolves reference photos through
//   Master_Library_Build/<room>/<row>/  one empty folder per item, for photos
//   Tile/tiles/                         required to exist by tiles.mjs; stays
//                                       empty for projects whose tiles are
//                                       real manifest rows (see the project
//                                       definition's _readme)
//   REFERENCE-PHOTOS.md                 per-item checklist of what to drop in
//
// It only ever writes those files and creates directories — photos already in
// place are never touched. Re-run it after adding photos: _BUILD_LOG.csv's
// matched_files and the checklist's counts are rebuilt from what is on disk.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECTS_DIR = path.join(SCRIPT_DIR, "projects");
const BUILD_DIR_NAME = "Master_Library_Build";

// Same set match.mjs resolves images from, so the checklist's "has a photo"
// and the CLI's "has a photo" can never disagree.
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tif", ".tiff"]);

// Folder names are capped so a deep library root stays clear of Windows'
// path limit; the row id in front of the slug is what actually keeps each
// folder unique, so truncation can never collide two items.
const MAX_SLUG_LENGTH = 48;

export function slugify(value, maxLength = MAX_SLUG_LENGTH) {
  const slug = String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.length > maxLength ? slug.slice(0, maxLength).replace(/-+$/, "") : slug;
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvRow(cells) {
  return cells.map(csvCell).join(",");
}

function imagesIn(folder) {
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((name) => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .sort();
}

export async function loadProjectDefinition(project, projectsDir = PROJECTS_DIR) {
  const file = project.endsWith(".json") ? project : path.join(projectsDir, `${project}.json`);
  if (!existsSync(file)) {
    const available = existsSync(projectsDir)
      ? readdirSync(projectsDir).filter((name) => name.endsWith(".json")).map((name) => name.replace(/\.json$/, ""))
      : [];
    throw new Error(
      `No project definition at ${file}.` +
        (available.length ? ` Available projects: ${available.join(", ")}.` : ""),
    );
  }
  const definition = JSON.parse(await readFile(file, "utf8"));
  for (const field of ["id", "name", "unitType", "rooms"]) {
    if (!definition[field]) throw new Error(`${file} is missing required field "${field}".`);
  }
  const seen = new Set();
  for (const room of definition.rooms) {
    if (!room.room) throw new Error(`${file} has a room with no "room" label.`);
    for (const item of room.items ?? []) {
      if (!item.rowId) throw new Error(`${file}: every item needs a rowId (room "${room.room}").`);
      if (seen.has(item.rowId)) throw new Error(`${file}: duplicate rowId "${item.rowId}".`);
      seen.add(item.rowId);
      if (!item.name) throw new Error(`${file}: item ${item.rowId} needs a name.`);
    }
  }
  return definition;
}

// row_id -> the folder its photos live in, relative to the library root.
// Forward slashes: match.mjs splits on either separator, and a forward-slash
// path stays readable in the checklist on Windows too.
export function folderFor(room, item) {
  return `${BUILD_DIR_NAME}/${slugify(room.room)}/${item.rowId}_${slugify(item.name)}`;
}

function manifestCsv(definition) {
  const lines = [csvRow(["row_id", "unit_type", "room_type", "cost_code", "item_name", "sku", "qty", "reference", "status"])];
  for (const room of definition.rooms) {
    for (const item of room.items ?? []) {
      lines.push(csvRow([
        item.rowId,
        definition.unitType,
        room.room,
        item.costCode ?? "",
        item.name,
        item.sku ?? "",
        item.qty ?? 1,
        item.reference ?? "",
        item.status ?? "",
      ]));
    }
  }
  return `${lines.join("\n")}\n`;
}

function buildLogCsv(entries) {
  const lines = [csvRow(["row_id", "sku", "folder", "matched_files"])];
  for (const entry of entries) {
    lines.push(csvRow([entry.rowId, entry.sku, entry.folder, entry.photos.join(";")]));
  }
  return `${lines.join("\n")}\n`;
}

function checklistMarkdown(definition, root, entries) {
  const byRowId = new Map(entries.map((entry) => [entry.rowId, entry]));
  const selected = entries.filter((entry) => entry.status !== "pending");
  const missing = selected.filter((entry) => !entry.photos.length);
  const lines = [
    `# ${definition.name} — reference photo checklist`,
    "",
    `Generated by \`scripts/autoboard/scaffold-project.mjs\` from \`scripts/autoboard/projects/${definition.id}.json\`.`,
    `Source: ${definition.source ?? "project definition"}.`,
    "",
    `Library root: \`${root}\``,
    "",
    "Drop each product's photo into the folder listed for it, then re-run the scaffold so the build log picks it up.",
    "An item with no photo is not a failure: `plan` records it in `gaps.md` and leaves the slot open.",
    "Rows marked **pending** have no product selected yet and are expected to stay empty.",
    "",
    `**${selected.length - missing.length}** of **${selected.length}** selected products have a photo; **${missing.length}** still need one.`,
    "",
  ];
  for (const room of definition.rooms) {
    lines.push(`## ${room.room}${room.identity ? ` — ${room.identity}` : ""}`, "");
    if (room.note) lines.push(`> ${room.note}`, "");
    for (const item of room.items ?? []) {
      const entry = byRowId.get(item.rowId);
      const mark = entry.photos.length ? "x" : " ";
      const status = item.status && item.status !== "preferred" ? ` _(${item.status})_` : "";
      lines.push(`- [${mark}] **${item.name}**${status}${item.sku ? ` · \`${item.sku}\`` : ""}`);
      lines.push(`  - folder: \`${entry.folder}\``);
      if (item.spec) lines.push(`  - spec: ${item.spec}`);
      if (item.substituteFor) lines.push(`  - substitute for: \`${item.substituteFor}\` — a replacement, not an addition`);
      if (item.reference) lines.push(`  - source: ${item.reference}`);
      if (item.photo) lines.push(`  - photo: ${item.photo}`);
      if (entry.photos.length) lines.push(`  - on disk: ${entry.photos.join(", ")}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

export async function scaffoldProject({ definition, root, dryRun = false }) {
  const libraryRoot = path.resolve(root ?? definition.libraryRoot ?? ".");
  const entries = [];
  for (const room of definition.rooms) {
    for (const item of room.items ?? []) {
      const folder = folderFor(room, item);
      const absolute = path.join(libraryRoot, ...folder.split("/"));
      if (!dryRun) mkdirSync(absolute, { recursive: true });
      entries.push({
        rowId: item.rowId,
        sku: item.sku ?? "",
        status: item.status ?? "preferred",
        folder,
        photos: imagesIn(absolute),
      });
    }
  }

  const files = {
    "build_manifest_v2.csv": manifestCsv(definition),
    [`${BUILD_DIR_NAME}/_BUILD_LOG.csv`]: buildLogCsv(entries),
    "REFERENCE-PHOTOS.md": checklistMarkdown(definition, libraryRoot, entries),
  };

  if (!dryRun) {
    // tiles.mjs readdirSync's this unconditionally, so it has to exist even
    // for a project whose tiles are ordinary manifest rows.
    mkdirSync(path.join(libraryRoot, "Tile", "tiles"), { recursive: true });
    for (const [relative, contents] of Object.entries(files)) {
      const absolute = path.join(libraryRoot, ...relative.split("/"));
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(absolute, contents, "utf8");
    }
  }

  const selected = entries.filter((entry) => entry.status !== "pending");
  return {
    libraryRoot,
    dryRun,
    written: Object.keys(files),
    itemCount: entries.length,
    pendingCount: entries.length - selected.length,
    withPhotos: selected.filter((entry) => entry.photos.length).length,
    missingPhotos: selected.filter((entry) => !entry.photos.length).map((entry) => entry.rowId),
    entries,
  };
}

// ---------------------------------------------------------------------------
// Reference photos. A project definition names a product; <project>-images.json
// says which vendor photographs stand for it. The files themselves are never
// committed — they are vendor product photography, fetched into the library
// root for internal design reference only.
// ---------------------------------------------------------------------------

const EXTENSION_BY_TYPE = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/avif": ".avif",
};

export async function loadImageManifest(project, projectsDir = PROJECTS_DIR) {
  const base = project.endsWith(".json") ? project.replace(/\.json$/, "") : path.join(projectsDir, project);
  const file = `${base}-images.json`;
  if (!existsSync(file)) return { images: {} };
  const manifest = JSON.parse(await readFile(file, "utf8"));
  return { images: manifest.images ?? {}, verifiedAt: manifest.verifiedAt, file };
}

// Node's fetch ignores HTTP_PROXY/HTTPS_PROXY unless NODE_USE_ENV_PROXY is set,
// which matters only in sandboxes that require a proxy — a normal workstation
// needs nothing.
async function defaultDownload(url) {
  const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, redirect: "follow" });
  const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim();
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (!contentType.startsWith("image/")) throw new Error(`content-type ${contentType || "unknown"} is not an image`);
  return { buffer: Buffer.from(await response.arrayBuffer()), contentType };
}

// A vendor's best photo of a material sometimes carries styling props — a bowl
// of fruit, a dried stem, a hand holding a sample. The collage prompt forbids
// props ("every visible object must come from a reference image"), so a
// manifest entry may carry a crop that keeps only the material. sharp is
// imported lazily: a project with no crops needs nothing beyond node.
async function cropBuffer(buffer, crop) {
  const { default: sharp } = await import("sharp");
  return sharp(buffer)
    .extract({ left: crop.left, top: crop.top, width: crop.width, height: crop.height })
    .toBuffer();
}

export async function fetchReferenceImages({
  definition,
  manifest,
  root,
  force = false,
  download = defaultDownload,
  log = () => {},
}) {
  const libraryRoot = path.resolve(root ?? definition.libraryRoot ?? ".");
  const summary = { downloaded: 0, skipped: 0, failures: [], drifted: [], withoutImages: [] };
  for (const room of definition.rooms) {
    for (const item of room.items ?? []) {
      if (!item.imageKey) continue;
      const entry = manifest.images?.[item.imageKey];
      const files = entry?.files ?? [];
      if (!files.length) {
        summary.withoutImages.push({ rowId: item.rowId, imageKey: item.imageKey, reason: entry?.note ?? "not in the image manifest" });
        continue;
      }
      const folder = path.join(libraryRoot, ...folderFor(room, item).split("/"));
      mkdirSync(folder, { recursive: true });
      for (const [index, file] of files.entries()) {
        const extension = EXTENSION_BY_TYPE[file.contentType] ?? path.extname(new URL(file.url).pathname) ?? ".jpg";
        const name = `${item.rowId}-${index + 1}-${file.kind ?? "ref"}${extension}`;
        const target = path.join(folder, name);
        if (existsSync(target) && !force) {
          summary.skipped += 1;
          continue;
        }
        try {
          const { buffer } = await download(file.url);
          // The manifest records the hash of the file that was reviewed. A
          // mismatch means the vendor re-published the asset, so the picture
          // in the board may no longer be the one that was checked.
          const digest = createHash("sha256").update(buffer).digest("hex");
          if (file.sha256 && digest !== file.sha256) {
            summary.drifted.push({ rowId: item.rowId, url: file.url, expected: file.sha256, actual: digest });
          }
          const written = file.crop ? await cropBuffer(buffer, file.crop) : buffer;
          writeFileSync(target, written);
          summary.downloaded += 1;
          log(`  ${item.rowId}  ${name}  ${(written.length / 1024).toFixed(0)} KB${file.crop ? " (cropped)" : ""}`);
        } catch (error) {
          summary.failures.push({ rowId: item.rowId, url: file.url, error: error.message });
          log(`  ${item.rowId}  FAILED ${file.url} — ${error.message}`);
        }
      }
    }
  }
  return summary;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--project" || value === "--root") {
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`${value} needs a value.`);
      args[value === "--project" ? "project" : "root"] = next;
      index += 1;
    } else if (value === "--dry-run") {
      args.dryRun = true;
    } else if (value === "--fetch-images") {
      args.fetchImages = true;
    } else if (value === "--force") {
      args.force = true;
    } else if (value === "--help" || value === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/autoboard/scaffold-project.mjs --project <id> [--root <path>]
                                                 [--fetch-images [--force]] [--dry-run]

  --project <id>   A definition under scripts/autoboard/projects/ (e.g. 651-belmont), or a path to one.
  --root <path>    Library root to write into. Defaults to the definition's libraryRoot.
  --fetch-images   Download each item's vendor reference photos from <project>-images.json
                   into its folder, then refresh the build log. Existing files are kept.
  --force          With --fetch-images, re-download photos that are already on disk.
  --dry-run        Report what would be written without creating anything.

Then:
  npm run autoboard -- plan --offline --library-root "<root>"
  npm run autoboard -- review --run <run-id> --port 4791`);
}

export async function runScaffoldCli(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  if (args.help || !args.project) {
    printHelp();
    return args.help ? 0 : 2;
  }
  try {
    const definition = await loadProjectDefinition(args.project);
    // Folders first, then photos, then the manifest/build log — so the build
    // log is written once, already knowing about everything just downloaded.
    if (args.fetchImages && !args.dryRun) {
      await scaffoldProject({ definition, root: args.root });
      const manifest = await loadImageManifest(args.project);
      console.log(`Fetching reference photos${manifest.verifiedAt ? ` (manifest verified ${manifest.verifiedAt})` : ""}:`);
      const fetched = await fetchReferenceImages({
        definition,
        manifest,
        root: args.root,
        force: args.force,
        log: (line) => console.log(line),
      });
      console.log(`\n  downloaded ${fetched.downloaded}, kept ${fetched.skipped} already on disk`);
      for (const missing of fetched.withoutImages) {
        console.log(`  no photo published for ${missing.rowId} (${missing.imageKey}) — ${missing.reason}`);
      }
      for (const drift of fetched.drifted) {
        console.log(`  CHANGED SINCE REVIEW: ${drift.rowId} ${drift.url} — look at it before rendering`);
      }
      for (const failure of fetched.failures) {
        console.log(`  FAILED ${failure.rowId} ${failure.url} — ${failure.error}`);
      }
      console.log("");
    }
    const summary = await scaffoldProject({ definition, root: args.root, dryRun: args.dryRun });
    console.log(`${summary.dryRun ? "Would scaffold" : "Scaffolded"} ${definition.name} into ${summary.libraryRoot}`);
    for (const file of summary.written) console.log(`  ${summary.dryRun ? "would write" : "wrote"} ${file}`);
    console.log(
      `\n${summary.itemCount} item(s): ${summary.withPhotos} with a reference photo, ` +
        `${summary.missingPhotos.length} still needing one, ${summary.pendingCount} with no product selected yet.`,
    );
    if (summary.missingPhotos.length) {
      console.log(`  needs photos: ${summary.missingPhotos.join(", ")}`);
      console.log(`  see ${path.join(summary.libraryRoot, "REFERENCE-PHOTOS.md")}`);
    }
    console.log(`\nNext: npm run autoboard -- plan --offline --library-root "${summary.libraryRoot}"`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) {
  process.exitCode = await runScaffoldCli();
}
