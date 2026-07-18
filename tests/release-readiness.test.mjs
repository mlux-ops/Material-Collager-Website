import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createReleaseQaRun } from "../scripts/create-release-qa-run.mjs";
import { validateRightsManifest } from "../scripts/validate-release-collage-rights.mjs";
import { validateLibrary, validateLibraryPayload } from "../scripts/validate-release-library.mjs";

const now = Date.parse("2026-07-13T12:00:00Z");

function libraryItem(index, overrides = {}) {
  return {
    id: `record-${index}`,
    mode: "immediate",
    status: "completed",
    openaiBatchId: null,
    outputKey: `generation-outputs/record-${index}.png`,
    filename: `record-${index}.png`,
    format: "png",
    renderKind: "final",
    collageType: "bathroom_fixture_collage",
    libraryVisible: true,
    title: `Record ${index}`,
    estimatedUsd: null,
    usage: null,
    qa: null,
    error: null,
    createdAt: now - index * 1000,
    updatedAt: now - index * 500,
    expiresAt: now + 7 * 24 * 60 * 60 * 1000,
    imageUrl: `/api/library/record-${index}/image`,
    ...overrides,
  };
}

function approvedCollage(index, overrides = {}) {
  return {
    assetKey: `release-collage-${String(index).padStart(2, "0")}`,
    title: `Release collage ${index}`,
    approvedForPublicPreview: true,
    approvedForDownload: true,
    rightsBasis: "owned",
    approvedBy: "Release owner",
    approvedAt: "2026-07-13T12:00:00Z",
    sourceAssets: [{ description: `Source package ${index}`, rightsBasis: "owned" }],
    notes: "",
    ...overrides,
  };
}

async function startLibraryServer(items) {
  const server = http.createServer((request, response) => {
    if (request.url === "/api/library") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, items }));
      return;
    }
    if (/^\/api\/library\/record-\d+\/image$/.test(request.url || "")) {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

test("default rights manifest can be prepared empty but does not pass release mode", () => {
  const manifest = { version: 1, collages: [] };
  assert.equal(validateRightsManifest(manifest).ok, true);
  const release = validateRightsManifest(manifest, { release: true });
  assert.equal(release.ok, false);
  assert.ok(release.issues.some((item) => item.code === "release.minimum_collages"));
});

test("eight fully approved rights entries pass release mode", () => {
  const result = validateRightsManifest({
    version: 1,
    collages: Array.from({ length: 8 }, (_, index) => approvedCollage(index + 1)),
  }, { release: true });
  assert.equal(result.ok, true);
  assert.equal(result.collageCount, 8);
});

test("rights validation rejects duplicates and missing download approval", () => {
  const result = validateRightsManifest({
    version: 1,
    collages: [
      approvedCollage(1),
      approvedCollage(2, { assetKey: "release-collage-01", approvedForDownload: false }),
    ],
  }, { release: true });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((item) => item.code === "collage.asset_key_duplicate"));
  assert.ok(result.issues.some((item) => item.code === "release.download_not_approved"));
});

test("Library payload validation enforces final, visible, unexpired records", () => {
  const result = validateLibraryPayload({
    ok: true,
    items: [
      libraryItem(1),
      libraryItem(2, { renderKind: "draft" }),
      libraryItem(3, { expiresAt: now - 1 }),
    ],
  }, { now });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((item) => item.code === "record.render_kind"));
  assert.ok(result.issues.some((item) => item.code === "record.expired"));
});

test("release Library validator checks eight records and their image responses", async () => {
  const server = await startLibraryServer(Array.from({ length: 8 }, (_, index) => libraryItem(index + 1)));
  try {
    const result = await validateLibrary({ baseUrl: server.baseUrl, release: true, now });
    assert.equal(result.ok, true);
    assert.equal(result.summary.recordCount, 8);
    assert.equal(result.summary.previewPasses, 8);
  } finally {
    await server.close();
  }
});

test("release QA scaffolding creates dated templates outside tracked source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "material-collager-qa-"));
  try {
    const templates = path.join(root, "artifacts", "release-qa", "templates");
    await mkdir(templates, { recursive: true });
    for (const file of ["iphone-safari-checklist.md", "android-checklist.md", "console-and-context-recovery.md"]) {
      await writeFile(path.join(templates, file), `# ${file}\n`, "utf8");
    }
    const target = await createReleaseQaRun({
      date: "2026-07-13",
      commit: "c1be186",
      baseUrl: "https://review.example.test",
      rootDir: root,
    });
    const candidate = JSON.parse(await readFile(path.join(target, "release-candidate.json"), "utf8"));
    assert.equal(candidate.releaseCandidateCommit, "c1be186");
    assert.equal(candidate.productionResourcesUsed, false);
    assert.match(await readFile(path.join(target, "iphone-safari-checklist.md"), "utf8"), /iphone-safari/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Inter is self-hosted globally and Scene Lab no longer declares the temporary font", async () => {
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
  const globals = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const scene = await readFile(new URL("../app/scene-lab/scene-lab.module.css", import.meta.url), "utf8");
  assert.match(layout, /next\/font\/local/);
  assert.match(layout, /InterVariable\.woff2/);
  assert.match(layout, /InterVariable-Italic\.woff2/);
  assert.doesNotMatch(layout, /Geist/);
  assert.match(globals, /var\(--font-inter\)/);
  assert.doesNotMatch(globals, /font-geist/);
  assert.match(scene, /var\(--font-inter\)/);
  assert.doesNotMatch(scene, /font-family:\s*Arial/);
});

test("Library storage queries only expose final completed records", async () => {
  const source = await readFile(new URL("../app/lib/generation-jobs.ts", import.meta.url), "utf8");
  assert.match(source, /render_kind = 'final'/);
  assert.match(source, /library_visible = \?, title = \?/);
});
