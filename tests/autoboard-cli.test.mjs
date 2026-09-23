import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("CLI generate --dry-run counts skipped renders against the variants asked for, not the whole plan", async () => {
  const runId = `run-cli-dryrun-${process.pid}-${Date.now()}`;
  const runDir = path.join(process.cwd(), "autoboard-runs", runId);
  const imagePath = path.join(runDir, "faucet.png");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(imagePath, PNG);
  // Three variants in the plan, one board, and nothing rendered yet.
  writeFileSync(path.join(runDir, "plan.json"), JSON.stringify({
    runId,
    source: "offline-manifest",
    variants: ["A", "B", "C"].map((key) => ({
      key, composition: "editorial", density: "balanced", styling: "materials_only", lighting: "soft_daylight",
    })),
    boards: [{
      id: "dryrun-board",
      title: "Dry Run Board",
      unitType: "Penthouse",
      roomLabel: "Bath 2",
      collageType: "bathroom_fixture_collage",
      items: [{ slotId: "vanity_faucet", role: "vanity faucet", required: true, name: "Croma", brand: "Hansgrohe", images: [imagePath] }],
    }],
  }, null, 2));

  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        "--experimental-strip-types", "scripts/autoboard/cli.mjs", "generate",
        "--run", runId, "--variants", "1", "--dry-run",
      ], { cwd: process.cwd(), env: { ...process.env, OPENAI_API_KEY: "test-key" }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.once("error", reject);
      child.once("close", (status) => resolve({ status, stdout }));
    });
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /DRY RUN — 1 render call\(s\)/);
    // Nothing has ever been rendered for this run, so claiming completed
    // renders would be a lie that hides real work from the operator.
    assert.doesNotMatch(result.stdout, /already completed/);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

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

function runBatchStatus(runId, baseUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--experimental-strip-types", "scripts/autoboard/cli.mjs", "batch-status",
      "--run", runId, "--base-url", baseUrl,
    ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("CLI batch-status keeps polling until every tracked job is confirmed, not just until nothing changes", async () => {
  const runId = `run-cli-batch-status-fair-${process.pid}-${Date.now()}`;
  const runDir = path.join(process.cwd(), "autoboard-runs", runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(path.join(runDir, "plan.json"), JSON.stringify({ runId, source: "offline-manifest", variants: [], boards: [] }, null, 2));
  // Five tracked jobs, oldest (job-a) to newest (job-e). /api/economy only
  // ever refreshes the two globally oldest non-terminal jobs per call (see
  // the `pending` LIMIT in app/api/economy/route.ts), so with five tracked
  // jobs a round can leave job-e completely untouched while STILL reporting
  // "in_progress" for everyone — identical status text to the round before,
  // even though different jobs were actually checked. Only on round 3 does
  // job-e become the two oldest and finally get checked, where it completes.
  const now = Date.now();
  const ids = ["job-a", "job-b", "job-c", "job-d", "job-e"];
  writeFileSync(path.join(runDir, "results.json"), JSON.stringify({
    candidates: {},
    finals: {},
    economy: Object.fromEntries(ids.map((id, index) => [
      `board--${String.fromCharCode(65 + index)}`, { jobId: id, status: "in_progress" },
    ])),
  }, null, 2));
  // A full minute apart, not a second: the CLI's settlement baseline comes
  // from the first response's Date header minus a 1s margin (see cli.mjs),
  // and Node's own auto-generated Date header can itself read up to ~1s
  // stale relative to Date.now() (it is cached and refreshed roughly once a
  // second) — spacing this tight would make an untouched job's age
  // indistinguishable from that combined slop and flake.
  const state = new Map(ids.map((id, index) => [id, { status: "in_progress", updatedAt: now - (ids.length - index) * 60_000 }]));
  const PNG = Buffer.from(
    "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8cfc0c0c0c40000000704fe07b3ee7e0000000049454e44ae426082",
    "hex",
  );

  const server = createServer((request, response) => {
    if (request.url === "/api/economy") {
      // Mirrors the real `pending` query: refresh only the two rows with the
      // oldest updatedAt among the non-terminal ones, and give them a fresh
      // updatedAt — exactly what the round-1 fairness bump does even when a
      // check fails, and what a real refresh does when it succeeds.
      const nonTerminal = [...state.entries()].filter(([, job]) => job.status !== "completed" && job.status !== "failed");
      nonTerminal.sort((a, b) => a[1].updatedAt - b[1].updatedAt);
      for (const [id, job] of nonTerminal.slice(0, 2)) {
        if (id === "job-e") job.status = "completed";
        job.updatedAt = Date.now();
      }
      const jobs = [...state.entries()].map(([id, job]) => ({
        id, status: job.status, updatedAt: job.updatedAt, error: null,
        libraryVisible: false, model: null, quality: null, background: "opaque", outputFormat: "png", usage: null, costUsd: null,
      }));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true, jobs }));
      return;
    }
    if (request.url === "/api/economy/output/job-e") {
      response.writeHead(200, { "Content-Type": "image/png" });
      response.end(PNG);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await listen(server);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const result = await runBatchStatus(runId, baseUrl);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const results = JSON.parse(readFileSync(path.join(runDir, "results.json"), "utf8"));
    const savedEntry = Object.values(results.economy).find((entry) => entry.jobId === "job-e");
    assert.equal(savedEntry.status, "completed");
    assert.ok(savedEntry.savedPath, "job-e's output should have been downloaded and saved");
    assert.ok(existsSync(savedEntry.savedPath));
  } finally {
    await close(server);
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("CLI batch-status keeps what it already learned if a later GET fails, rather than discarding the run", async () => {
  const runId = `run-cli-batch-status-flaky-${process.pid}-${Date.now()}`;
  const runDir = path.join(process.cwd(), "autoboard-runs", runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(path.join(runDir, "plan.json"), JSON.stringify({ runId, source: "offline-manifest", variants: [], boards: [] }, null, 2));
  writeFileSync(path.join(runDir, "results.json"), JSON.stringify({
    candidates: {},
    finals: {},
    economy: { "board--A": { jobId: "job-a", status: "in_progress" } },
  }, null, 2));

  // The first round succeeds but leaves job-a still running (its updatedAt
  // predates the CLI's own start, so it does not count as settled); every
  // round after that answers 500. The command must still exit cleanly using
  // what round 1 already learned, instead of throwing that data away.
  let requestCount = 0;
  const server = createServer((request, response) => {
    if (request.url !== "/api/economy") {
      response.writeHead(404);
      response.end();
      return;
    }
    requestCount += 1;
    if (requestCount === 1) {
      const jobs = [{
        id: "job-a", status: "in_progress", updatedAt: Date.now() - 60_000, error: null,
        libraryVisible: false, model: null, quality: null, background: "opaque", outputFormat: "png", usage: null, costUsd: null,
      }];
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true, jobs }));
      return;
    }
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: false, error: "Internal error" }));
  });
  await listen(server);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const result = await runBatchStatus(runId, baseUrl);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(requestCount > 1, `expected batch-status to retry past the first round, saw ${requestCount} request(s)`);
    assert.match(result.stdout, /status check failed/);
    const results = JSON.parse(readFileSync(path.join(runDir, "results.json"), "utf8"));
    assert.equal(results.economy["board--A"].status, "in_progress");
  } finally {
    await close(server);
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("CLI batch-status fails loudly if no round ever succeeds, instead of reporting every job as expired", async () => {
  const runId = `run-cli-batch-status-down-${process.pid}-${Date.now()}`;
  const runDir = path.join(process.cwd(), "autoboard-runs", runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(path.join(runDir, "plan.json"), JSON.stringify({ runId, source: "offline-manifest", variants: [], boards: [] }, null, 2));
  writeFileSync(path.join(runDir, "results.json"), JSON.stringify({
    candidates: {},
    finals: {},
    economy: { "board--A": { jobId: "job-a", status: "in_progress" } },
  }, null, 2));

  // Every /api/economy call fails (an Access rejection or a D1 outage would
  // look like this). With no successful round, jobsById stays empty, and
  // reporting every tracked job as "not found (may have expired)" reads as
  // "the jobs are gone" — inviting a paid resubmit. The command must instead
  // surface the real failure and exit non-zero, as it did before this loop
  // could repeat at all.
  const server = createServer((request, response) => {
    if (request.url !== "/api/economy") {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: false, error: "Internal error" }));
  });
  await listen(server);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const result = await runBatchStatus(runId, baseUrl);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /not found \(may have expired/);
    assert.match(result.stdout + result.stderr, /Internal error/);
  } finally {
    await close(server);
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("CLI batch-status's cap-exhaustion path prints the still-unconfirmed jobs", async () => {
  const runId = `run-cli-batch-status-cap-${process.pid}-${Date.now()}`;
  const runDir = path.join(process.cwd(), "autoboard-runs", runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(path.join(runDir, "plan.json"), JSON.stringify({ runId, source: "offline-manifest", variants: [], boards: [] }, null, 2));
  writeFileSync(path.join(runDir, "results.json"), JSON.stringify({
    candidates: {},
    finals: {},
    economy: { "board--A": { jobId: "job-a", status: "in_progress" } },
  }, null, 2));

  // A single tracked job whose updatedAt the fake server never advances: it
  // can never look "checked this run", so the loop can only ever stop by
  // hitting the cap (the minimum, 4, since there is only ever one
  // non-terminal job in the response).
  const server = createServer((request, response) => {
    if (request.url !== "/api/economy") {
      response.writeHead(404);
      response.end();
      return;
    }
    const jobs = [{
      id: "job-a", status: "in_progress", updatedAt: Date.now() - 60_000, error: null,
      libraryVisible: false, model: null, quality: null, background: "opaque", outputFormat: "png", usage: null, costUsd: null,
    }];
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true, jobs }));
  });
  await listen(server);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const result = await runBatchStatus(runId, baseUrl);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /stopped after 4 rounds with 1 job\(s\) not yet confirmed: board--A/);
  } finally {
    await close(server);
    rmSync(runDir, { recursive: true, force: true });
  }
});
