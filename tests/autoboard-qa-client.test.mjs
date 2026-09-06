import assert from "node:assert/strict";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import sharp from "sharp";

import { buildQaRequest, formatQaLine, prepareQaImage, runQa } from "../scripts/autoboard/lib/qa-client.mjs";

async function withTempRoot(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "autoboard-qa-test-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// Drains the request body before responding — otherwise the client can see a
// connection reset instead of the intended status/body on some platforms.
function respondJson(req, res, status, body) {
  req.resume();
  req.on("end", () => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
}

async function withServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("prepareQaImage downsizes a 3000x2000 PNG to a 1024 long-edge JPEG", async () => {
  const bytes = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: "#ffffff" } }).png().toBuffer();
  const result = await prepareQaImage(bytes, { maxLongEdge: 1024 });
  assert.equal(result.mimeType, "image/jpeg");
  const metadata = await sharp(Buffer.from(result.imageBase64, "base64")).metadata();
  assert.equal(metadata.format, "jpeg");
  assert.equal(Math.max(metadata.width, metadata.height), 1024);
  assert.equal(metadata.width, 1024);
  assert.equal(metadata.height, Math.round((2000 / 3000) * 1024));
});

test("prepareQaImage never upscales a 300x300 source", async () => {
  const bytes = await sharp({ create: { width: 300, height: 300, channels: 3, background: "#000000" } }).png().toBuffer();
  const result = await prepareQaImage(bytes, { maxLongEdge: 1024 });
  const metadata = await sharp(Buffer.from(result.imageBase64, "base64")).metadata();
  assert.equal(metadata.format, "jpeg");
  assert.equal(metadata.width, 300);
  assert.equal(metadata.height, 300);
});

test("prepareQaImage also accepts a file path, not just a Buffer", async () => {
  await withTempRoot(async (root) => {
    const filePath = path.join(root, "source.png");
    const bytes = await sharp({ create: { width: 500, height: 500, channels: 3, background: "#336699" } }).png().toBuffer();
    await writeFile(filePath, bytes);
    const result = await prepareQaImage(filePath, { maxLongEdge: 256 });
    const metadata = await sharp(Buffer.from(result.imageBase64, "base64")).metadata();
    assert.equal(metadata.width, 256);
    assert.equal(metadata.height, 256);
  });
});

test("buildQaRequest maps each item to its FIRST reference file, in item order, when an item owns two images", async () => {
  await withTempRoot(async (root) => {
    const tiny = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#abcdef" } }).jpeg().toBuffer();
    const outputPath = path.join(root, "output.png");
    const mainTileA = path.join(root, "main_tile--a1.jpg");
    const mainTileB = path.join(root, "main_tile--a2.jpg");
    const showerHead = path.join(root, "shower_head--b1.jpg");
    await Promise.all([outputPath, mainTileA, mainTileB, showerHead].map((filePath) => writeFile(filePath, tiny)));

    const payload = {
      items: [
        {
          id: "main_tile", role: "main bathroom tile", brand: "Elm Surfaces", name: "Cortar Bone",
          notes: undefined, imageNames: ["main_tile--a1.jpg", "main_tile--a2.jpg"],
        },
        {
          id: "shower_head", role: "shower head", brand: undefined, name: "Brizo Odin",
          notes: "matte black", imageNames: ["shower_head--b1.jpg"],
        },
      ],
    };
    const referenceFiles = [
      { path: mainTileA, name: "main_tile--a1.jpg" },
      { path: mainTileB, name: "main_tile--a2.jpg" },
      { path: showerHead, name: "shower_head--b1.jpg" },
    ];

    const request = await buildQaRequest({ payload, referenceFiles, outputPath, jobId: "job-123" });
    assert.equal(request.jobId, "job-123");
    assert.equal(request.output.mimeType, "image/jpeg");
    assert.ok(request.output.imageBase64.length > 0);

    // Exactly one reference per item, in item order — the SECOND main_tile
    // file is never sent.
    assert.equal(request.references.length, 2);
    assert.equal(request.references[0].itemId, "main_tile");
    assert.equal(request.references[1].itemId, "shower_head");

    // Only defined fields land in `items`, and undefined ones are dropped
    // rather than sent as explicit nulls/undefined.
    assert.deepEqual(request.items, [
      { id: "main_tile", role: "main bathroom tile", brand: "Elm Surfaces", name: "Cortar Bone" },
      { id: "shower_head", role: "shower head", name: "Brizo Odin", notes: "matte black" },
    ]);
  });
});

test("formatQaLine reports a clean result", () => {
  assert.equal(formatQaLine({ model: "m", checkedAt: "t", items: [], extraObjects: [], summary: "", flagCount: 0 }), "QA: clean");
});

test("formatQaLine summarizes flagged items in the documented format", () => {
  const qa = {
    model: "m",
    checkedAt: "t",
    items: [
      { id: "shower_head", present: true, count: 2, finishMatch: "match", scaleOk: true, issues: [] },
      { id: "main_tile", present: true, count: 1, finishMatch: "mismatch", scaleOk: true, issues: [] },
    ],
    extraObjects: [],
    summary: "Two issues found.",
    flagCount: 2,
  };
  assert.equal(formatQaLine(qa), "QA: 2 flags — shower_head: count 2; main_tile: finish mismatch");
});

test("formatQaLine folds in extraObjects and a singular flag count", () => {
  const qa = {
    items: [{ id: "main_tile", present: true, count: 1, finishMatch: "match", scaleOk: true, issues: [] }],
    extraObjects: ["a stray candle"],
    flagCount: 1,
  };
  assert.equal(formatQaLine(qa), "QA: 1 flag — extra: a stray candle");
});

test("runQa returns the parsed body on a 200 response", async () => {
  await withServer(
    (req, res) => respondJson(req, res, 200, {
      ok: true,
      qa: { model: "gpt-x", checkedAt: "2026-09-05T00:00:00.000Z", items: [], extraObjects: [], summary: "fine", flagCount: 0 },
    }),
    async (baseUrl) => {
      const result = await runQa(baseUrl, { "x-test": "1" }, { output: {}, references: [], items: [] });
      assert.equal(result.ok, true);
      assert.equal(result.qa.summary, "fine");
    },
  );
});

test("runQa throws with .status 404 when the endpoint isn't deployed yet", async () => {
  await withServer(
    (req, res) => respondJson(req, res, 404, { ok: false, error: "not found" }),
    async (baseUrl) => {
      await assert.rejects(
        () => runQa(baseUrl, {}, { output: {}, references: [], items: [] }),
        (error) => error.status === 404,
      );
    },
  );
});

test("runQa throws with .status 500 on a server error", async () => {
  await withServer(
    (req, res) => respondJson(req, res, 500, { ok: false, error: "boom" }),
    async (baseUrl) => {
      await assert.rejects(
        () => runQa(baseUrl, {}, { output: {}, references: [], items: [] }),
        (error) => error.status === 500,
      );
    },
  );
});
