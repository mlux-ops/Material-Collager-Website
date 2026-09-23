import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { createFakeD1, createFakeR2, installWorkerEnv } from "./helpers/fake-worker-env.mjs";

let failJobInsert = false;
const DB = createFakeD1({
  beforeStatement: (_kind, sql) => {
    if (failJobInsert && /^\s*INSERT INTO generation_jobs/i.test(sql)) throw new Error("D1 unavailable");
  },
});
const OUTPUTS = createFakeR2();
installWorkerEnv({ DB, OUTPUTS });
const { POST } = await import("../app/api/workbench/save/route.ts");

// The exact request both Workbench callers send (saveToLibrary.tsx and
// auto-save-final.ts): no model, quality or background anywhere.
async function save(bytes, { type = "image/png", filename } = {}) {
  const form = new FormData();
  form.append("payload", JSON.stringify({ filename, prompt: "Workbench output", format: "workbench", workflow: "test graph" }));
  form.append("image", new File([bytes], "upload", { type }));
  return POST(new Request("http://localhost/api/workbench/save", { method: "POST", body: form }));
}

const png = await sharp({ create: { width: 4, height: 4, channels: 4, background: "#808080" } }).png().toBuffer();

test("Save to Library stores a Workbench output that carries no generation metadata (R04)", async () => {
  const response = await save(png, { filename: "board.png" });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  const row = await DB.prepare("SELECT model, quality, background, output_key FROM generation_jobs WHERE id = ?").bind(body.jobId).first();
  assert.deepEqual({ model: row.model, quality: row.quality, background: row.background }, { model: null, quality: null, background: null });
  assert.ok(OUTPUTS.objects.has(row.output_key));
});

test("a history row that fails to insert takes its new R2 object with it", async () => {
  const before = OUTPUTS.objects.size;
  failJobInsert = true;
  const response = await save(png, { filename: "doomed.png" });
  failJobInsert = false;
  assert.notEqual(response.status, 200);
  assert.equal(OUTPUTS.objects.size, before);
});

test("JPEG and WebP outputs keep their real type in R2 and in the history record (R12)", async () => {
  for (const [format, mime, extension] of [["jpeg", "image/jpeg", "jpg"], ["webp", "image/webp", "webp"]]) {
    const bytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#808080" } })[format]().toBuffer();
    const response = await save(bytes, { type: mime, filename: "board.png" });
    assert.equal(response.status, 200, `${format} save failed`);
    const { jobId } = await response.json();
    const row = await DB.prepare("SELECT output_key, output_format, filename FROM generation_jobs WHERE id = ?").bind(jobId).first();
    assert.match(row.output_key, new RegExp(`\\.${extension}$`));
    assert.equal(row.output_format, extension);
    assert.equal(row.filename, `board.${extension}`);
    assert.equal(OUTPUTS.objects.get(row.output_key).httpMetadata.contentType, mime);
  }
});

test("bytes that are not PNG, JPEG or WebP are refused before anything is stored", async () => {
  const before = OUTPUTS.puts.length;
  const response = await save(new TextEncoder().encode("GIF89a not really an image"), { type: "image/gif" });
  assert.notEqual(response.status, 200);
  assert.equal(OUTPUTS.puts.length, before);
});
