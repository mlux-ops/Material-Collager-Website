import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { test } from "node:test";
import path from "node:path";

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8cfc0c0c0c40000000704fe07b3ee7e0000000049454e44ae426082",
  "hex",
);

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test("CLI generate records a single failed request as an error with diagnostics and permits manual rerun", async () => {
  const runId = `run-cli-failure-${process.pid}-${Date.now()}`;
  const runDir = path.join(process.cwd(), "autoboard-runs", runId);
  const imagePath = path.join(runDir, "faucet.png");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(imagePath, PNG);
  writeFileSync(path.join(runDir, "plan.json"), JSON.stringify({
    runId,
    source: "offline-manifest",
    variants: [{ key: "A", composition: "editorial", density: "balanced", styling: "materials_only", lighting: "soft_daylight" }],
    boards: [{
      id: "cli-failure-board",
      title: "CLI Failure Board",
      unitType: "Penthouse",
      roomLabel: "Bath 2",
      collageType: "bathroom_fixture_collage",
      items: [{ slotId: "vanity_faucet", role: "vanity faucet", required: true, name: "Croma", brand: "Hansgrohe", images: [imagePath] }],
    }],
  }, null, 2));

  let requestCount = 0;
  const server = createServer((request, response) => {
    if (request.url !== "/api/generate") {
      response.writeHead(404);
      response.end();
      return;
    }
    requestCount++;
    request.resume();
    request.once("end", () => {
      response.writeHead(429, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        ok: false,
        error: "Busy",
        code: "rate_limited",
        retryAfterMs: 120000,
        diagnostics: { attempts: [{ stage: "upstream", outcome: "ambiguous" }] },
      }));
    });
  });
  await listen(server);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const runCli = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--experimental-strip-types", "scripts/autoboard/cli.mjs", "generate",
      "--run", runId, "--boards", "cli-failure-board", "--variants", "1", "--base-url", baseUrl,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, OPENAI_API_KEY: "test-key" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });

  try {
    const first = await runCli();
    assert.equal(first.status, 1, first.stdout + first.stderr);
    const firstResults = JSON.parse(readFileSync(path.join(runDir, "results.json"), "utf8"));
    const candidate = firstResults.candidates["cli-failure-board--A"];
    assert.equal(requestCount, 1);
    assert.equal(candidate.status, "error");
    assert.equal(candidate.httpStatus, 429);
    assert.equal(candidate.code, "rate_limited");
    assert.equal(candidate.retryAfterMs, 120000);
    assert.deepEqual(candidate.diagnostics, { attempts: [{ stage: "upstream", outcome: "ambiguous" }] });
    assert.match(first.stdout, /HTTP 429/);
    assert.match(first.stdout, /diagnostics/);

    // A second explicit CLI invocation is the manual rerun; no retry is
    // hidden inside the first failed command.
    const second = await runCli();
    assert.equal(second.status, 1, second.stdout + second.stderr);
    assert.equal(requestCount, 2);
  } finally {
    await close(server);
    rmSync(runDir, { recursive: true, force: true });
  }
});
