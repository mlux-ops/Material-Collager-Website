import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { createFakeD1, createFakeR2, installWorkerEnv } from "./helpers/fake-worker-env.mjs";

const OUTPUTS = createFakeR2();
installWorkerEnv({ DB: createFakeD1(), OUTPUTS });
const { MAX_PHOTO_BYTES, ingestPhotoFromUrl, ingestUploadedPhoto } = await import("../app/lib/autoboard-photos.ts");

test("a sheet URL that redirects to the metadata endpoint is refused before that hop is requested (R11)", async (t) => {
  const requested = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requested.push([String(url), init.redirect]);
    return new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest/meta-data/" } });
  });
  await assert.rejects(ingestPhotoFromUrl("p", "row-1", "https://vendor.example/faucet.jpg"), /private address/);
  assert.deepEqual(requested, [["https://vendor.example/faucet.jpg", "manual"]]);
});

test("a public image URL is still collected and stored", async (t) => {
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#808080" } }).png().toBuffer();
  t.mock.method(globalThis, "fetch", async () => new Response(png, { headers: { "content-type": "image/png" } }));
  const before = OUTPUTS.puts.length;
  const photo = await ingestPhotoFromUrl("p-ok", "row-1", "https://vendor.example/faucet.png");
  assert.ok(photo);
  assert.equal(OUTPUTS.puts.length, before + 1);
});

test("an oversized base64 upload is refused before it is decoded (R10)", async (t) => {
  const decode = t.mock.method(globalThis, "atob");
  const tooBig = "A".repeat(Math.ceil(((MAX_PHOTO_BYTES + 4) * 4) / 3));
  await assert.rejects(ingestUploadedPhoto("p", "row-1", { mimeType: "image/png", dataBase64: tooBig }), /must be under/);
  assert.equal(decode.mock.callCount(), 0);
});
