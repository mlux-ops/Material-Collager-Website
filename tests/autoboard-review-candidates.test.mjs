import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const SCRIPT = fileURLToPath(new URL("../scripts/autoboard/review-candidates.mjs", import.meta.url));

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8cfc0c0c0c40000000704fe07b3ee7e0000000049454e44ae426082",
  "hex",
);

// A candidates list holds URLs nobody has looked at yet — the step before one
// is reviewed into a project's image manifest — so its downloads go through the
// same guard as the scaffold's. Spawned for real because the script does its
// work at import, and against a real server so a request cannot go unnoticed.
test("review-candidates refuses a candidate that is not public https, and never requests it", async (t) => {
  let requests = 0;
  const server = http.createServer((request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "image/png" });
    response.end(PNG);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const dir = mkdtempSync(path.join(os.tmpdir(), "autoboard-review-candidates-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const candidates = path.join(dir, "candidates.json");
  const url = `http://127.0.0.1:${server.address().port}/vanity.png`;
  writeFileSync(candidates, JSON.stringify({ vanity: { images: [{ url, kind: "face" }] } }));
  await promisify(execFile)(process.execPath, ["--experimental-strip-types", SCRIPT, candidates, "--out", dir]);

  const report = JSON.parse(readFileSync(path.join(dir, "candidates-verified.json"), "utf8"));
  assert.equal(requests, 0);
  assert.match(report.vanity.images[0].error, /https/);
});
