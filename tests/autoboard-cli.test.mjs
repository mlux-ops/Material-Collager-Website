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

// batch-status asks for /api/economy?ids=…, so the fakes route on the path.
function pathOf(request) {
  return new URL(request.url, "http://127.0.0.1").pathname;
}

function runBatchStatus(runId, baseUrl) {
  return runCli(["batch-status", "--run", runId, ...(baseUrl ? ["--base-url", baseUrl] : [])]);
}

function runCli(args, env = {}) {
  return spawnCli(args, env).finished;
}

function spawnCli(args, env = {}) {
  const child = spawn(process.execPath, ["--experimental-strip-types", "scripts/autoboard/cli.mjs", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const finished = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
  return { child, finished };
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
    if (pathOf(request) === "/api/economy") {
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
    if (pathOf(request) !== "/api/economy") {
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
    if (pathOf(request) !== "/api/economy") {
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
    if (pathOf(request) !== "/api/economy") {
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

// A history entry shaped the way publicJob (app/lib/generation-jobs.ts) shapes one.
function economyJob(id, status) {
  return {
    id, status, updatedAt: Date.now(), error: null,
    libraryVisible: false, model: null, quality: null, background: "opaque", outputFormat: "png", usage: null, costUsd: null,
  };
}

function writeStatusRun(runId, economy) {
  const runDir = path.join(process.cwd(), "autoboard-runs", runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(path.join(runDir, "plan.json"), JSON.stringify({ runId, source: "offline-manifest", variants: [], boards: [] }, null, 2));
  writeFileSync(path.join(runDir, "results.json"), JSON.stringify({ candidates: {}, finals: {}, economy }, null, 2));
  return runDir;
}

function readEconomy(runDir) {
  return JSON.parse(readFileSync(path.join(runDir, "results.json"), "utf8")).economy;
}

test("CLI batch-status checks each job on the server it was submitted to when --base-url is left off", async () => {
  const runId = `run-cli-batch-status-servers-${process.pid}-${Date.now()}`;
  const asked = {};
  const serveOnly = (jobId) => createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/api/economy") {
      (asked[jobId] ??= []).push(url.searchParams.get("ids"));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true, jobs: [], tracked: [economyJob(jobId, "completed")] }));
      return;
    }
    if (url.pathname === `/api/economy/output/${jobId}`) {
      response.writeHead(200, { "Content-Type": "image/png" });
      response.end(PNG);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const first = serveOnly("job-1");
  const second = serveOnly("job-2");
  await listen(first);
  await listen(second);
  const runDir = writeStatusRun(runId, {
    "board--A": { jobId: "job-1", status: "in_progress", baseUrl: `http://127.0.0.1:${first.address().port}` },
    "board--B": { jobId: "job-2", status: "in_progress", baseUrl: `http://127.0.0.1:${second.address().port}` },
  });

  try {
    const result = await runBatchStatus(runId);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const economy = readEconomy(runDir);
    for (const variantId of ["board--A", "board--B"]) {
      assert.ok(economy[variantId].savedPath && existsSync(economy[variantId].savedPath), `${variantId}'s output should have been saved`);
    }
    assert.deepEqual(asked, { "job-1": ["job-1"], "job-2": ["job-2"] }, "each server is asked about its own job only");
  } finally {
    await close(first);
    await close(second);
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("CLI batch-status looks tracked jobs up by id, so one pushed out of the history listing is still saved", async () => {
  const runId = `run-cli-batch-status-lookup-${process.pid}-${Date.now()}`;
  const runDir = writeStatusRun(runId, { "board--A": { jobId: "job-old", status: "in_progress" } });
  const asked = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/api/economy") {
      asked.push(url.searchParams.get("ids"));
      // The listing is the newest 30 rows of every render kind, and newer
      // drafts have pushed job-old out of it.
      const body = { ok: true, jobs: [economyJob("draft-1", "completed")] };
      if (url.searchParams.has("ids")) {
        body.tracked = url.searchParams.get("ids").split(",").includes("job-old") ? [economyJob("job-old", "completed")] : [];
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
      return;
    }
    if (url.pathname === "/api/economy/output/job-old") {
      response.writeHead(200, { "Content-Type": "image/png" });
      response.end(PNG);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await listen(server);

  try {
    const result = await runBatchStatus(runId, `http://127.0.0.1:${server.address().port}`);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const entry = readEconomy(runDir)["board--A"];
    assert.equal(entry.status, "completed");
    assert.ok(entry.savedPath && existsSync(entry.savedPath), "job-old's output should have been saved");
    assert.deepEqual(asked, ["job-old"]);
  } finally {
    await close(server);
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("CLI batch-status doesn't call a job expired when the server can't look jobs up by id", async () => {
  const runId = `run-cli-batch-status-no-lookup-${process.pid}-${Date.now()}`;
  const runDir = writeStatusRun(runId, { "board--A": { jobId: "job-old", status: "in_progress" } });
  // A server that predates id lookups ignores ?ids= and answers with the
  // listing alone, which job-old has fallen out of while still pending.
  const server = createServer((request, response) => {
    if (pathOf(request) !== "/api/economy") {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true, jobs: [economyJob("draft-1", "completed")] }));
  });
  await listen(server);

  try {
    const result = await runBatchStatus(runId, `http://127.0.0.1:${server.address().port}`);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /may have expired/);
    assert.match(result.stdout, /can't look jobs up by id/);
    assert.match(result.stdout, /don't resubmit/i);
    assert.equal(readEconomy(runDir)["board--A"].status, "in_progress");
  } finally {
    await close(server);
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("CLI batch-status names a job's own server when an explicit --base-url doesn't have it", async () => {
  const runId = `run-cli-batch-status-elsewhere-${process.pid}-${Date.now()}`;
  // Recorded against a server that is never contacted: --base-url overrides it.
  const runDir = writeStatusRun(runId, { "board--A": { jobId: "job-a", status: "in_progress", baseUrl: "http://127.0.0.1:9" } });
  const server = createServer((request, response) => {
    if (pathOf(request) !== "/api/economy") {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true, jobs: [], tracked: [] }));
  });
  await listen(server);

  try {
    const result = await runBatchStatus(runId, `http://127.0.0.1:${server.address().port}`);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /job-a not found on http:\/\/127\.0\.0\.1:\d+.*submitted to http:\/\/127\.0\.0\.1:9\b/);
    assert.doesNotMatch(result.stdout, /may have expired/);
  } finally {
    await close(server);
    rmSync(runDir, { recursive: true, force: true });
  }
});

// One board with two variants, each with a rendered draft: enough to pass
// batch-finalize's review gate (no notes.json, no saved render options).
function writeBatchFinalizeRun(runId, economy) {
  const runDir = path.join(process.cwd(), "autoboard-runs", runId);
  const imagePath = path.join(runDir, "faucet.png");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(imagePath, PNG);
  const candidates = {};
  for (const key of ["A", "B"]) {
    const savedPath = path.join(runDir, `draft-${key}.png`);
    writeFileSync(savedPath, PNG);
    candidates[`batch-board--${key}`] = { status: "ok", savedPath };
  }
  writeFileSync(path.join(runDir, "plan.json"), JSON.stringify({
    runId,
    source: "offline-manifest",
    variants: ["A", "B"].map((key) => ({
      key, composition: "editorial", density: "balanced", styling: "materials_only", lighting: "soft_daylight",
    })),
    boards: [{
      id: "batch-board",
      title: "Batch Board",
      unitType: "Penthouse",
      roomLabel: "Bath 2",
      collageType: "bathroom_fixture_collage",
      items: [{ slotId: "vanity_faucet", role: "vanity faucet", required: true, name: "Croma", brand: "Hansgrohe", images: [imagePath] }],
    }],
  }, null, 2));
  writeFileSync(path.join(runDir, "results.json"), JSON.stringify({ candidates, finals: {}, economy }, null, 2));
  return runDir;
}

// The app routes batch-finalize calls: the chunked reference upload, then
// POST /api/economy. Every submission is counted — each one is a paid batch.
// answerSubmission(response, count) replaces the default accepted answer.
async function startBatchSubmitServer({ answerSubmission } = {}) {
  const calls = { uploads: 0, submissions: 0 };
  const server = createServer((request, response) => {
    request.resume();
    request.once("end", () => {
      const reply = (body) => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(body));
      };
      const pathname = pathOf(request);
      if (pathname === "/api/references/start") {
        calls.uploads += 1;
        reply({ ok: true, uploadId: `upload-${calls.uploads}` });
      } else if (pathname === "/api/references/part") {
        reply({ ok: true, partId: "part-1" });
      } else if (pathname === "/api/references/complete") {
        reply({ ok: true, fileId: `file-${calls.uploads}` });
      } else if (pathname === "/api/economy" && request.method === "POST") {
        calls.submissions += 1;
        if (answerSubmission) answerSubmission(response, calls.submissions);
        else reply({ ok: true, jobId: `job-new-${calls.submissions}`, status: "validating" });
      } else {
        response.writeHead(404);
        response.end();
      }
    });
  });
  await listen(server);
  return { server, calls, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

// batch-finalize forwards OPENAI_API_KEY when it has one. None is needed
// here, and blanking it keeps a key from the parent shell away from the fake.
const WITHOUT_OPENAI_KEY = { OPENAI_API_KEY: "" };

test("CLI batch-finalize skips a variant already submitted, resubmits a failed one, and keeps the failed job's id", async () => {
  const runId = `run-cli-batch-finalize-skip-${process.pid}-${Date.now()}`;
  const { server, calls, baseUrl } = await startBatchSubmitServer();
  const runDir = writeBatchFinalizeRun(runId, {
    "batch-board--A": { jobId: "job-a1", status: "in_progress", baseUrl },
    "batch-board--B": { jobId: "job-b1", status: "failed", error: "Economy render failed." },
  });

  try {
    // The natural move after one variant failed: the same variant list again.
    const result = await runCli(["batch-finalize", "--run", runId, "batch-board--A", "batch-board--B", "--base-url", baseUrl], WITHOUT_OPENAI_KEY);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(calls.submissions, 1, "only the failed variant may buy another batch");
    assert.equal(calls.uploads, 2, "nothing is uploaded for a skipped variant (B: its draft and one product image)");
    assert.match(result.stdout, /skipping batch-board--A: .*job-a1/);
    const economy = readEconomy(runDir);
    assert.equal(economy["batch-board--A"].jobId, "job-a1");
    assert.equal(economy["batch-board--B"].jobId, "job-new-1");
    assert.equal(economy["batch-board--B"].baseUrl, baseUrl);
    assert.deepEqual(economy["batch-board--B"].previousSubmissions.map((entry) => entry.jobId), ["job-b1"]);
  } finally {
    await close(server);
    rmSync(runDir, { recursive: true, force: true });
  }
});

// The finalize-cap failure (refreshJob in app/api/economy/route.ts): the batch
// completed and was billed; only saving its output here failed. Rows capped
// before that message named the batch still carry the older wording.
for (const [label, error] of [
  ["current", "Batch batch_1 completed at OpenAI, but its output could not be saved here after 3 attempts. Do not resubmit — it is already paid for."],
  ["older", "The Economy render could not be finalized after multiple attempts."],
]) {
  test(`CLI batch-finalize won't resubmit a failed job whose error (${label} wording) says its batch already completed`, async () => {
    const runId = `run-cli-batch-finalize-paid-${label}-${process.pid}-${Date.now()}`;
    const { server, calls, baseUrl } = await startBatchSubmitServer();
    const runDir = writeBatchFinalizeRun(runId, { "batch-board--A": { jobId: "job-a1", status: "failed", error } });

    try {
      const result = await runCli(["batch-finalize", "--run", runId, "batch-board--A", "--base-url", baseUrl], WITHOUT_OPENAI_KEY);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(calls.submissions, 0);
      assert.match(result.stdout, /skipping batch-board--A: .*job-a1/);
    } finally {
      await close(server);
      rmSync(runDir, { recursive: true, force: true });
    }
  });
}

test("CLI batch-finalize --resubmit buys another batch for a submitted variant, and --force alone doesn't", async () => {
  const runId = `run-cli-batch-finalize-resubmit-${process.pid}-${Date.now()}`;
  const { server, calls, baseUrl } = await startBatchSubmitServer();
  const runDir = writeBatchFinalizeRun(runId, { "batch-board--A": { jobId: "job-a1", status: "in_progress", baseUrl } });

  try {
    // --force overrides the stale-draft check; it is not a resubmit.
    const forced = await runCli(["batch-finalize", "--run", runId, "batch-board--A", "--base-url", baseUrl, "--force"], WITHOUT_OPENAI_KEY);
    assert.equal(forced.status, 0, forced.stdout + forced.stderr);
    assert.equal(calls.submissions, 0);

    // --resubmit names what it buys, so it needs no separate variant list,
    // and a variant named twice is still one variant: one batch, not two.
    const resubmitted = await runCli(
      ["batch-finalize", "--run", runId, "--base-url", baseUrl, "--resubmit", "batch-board--A", "--resubmit", "batch-board--A"],
      WITHOUT_OPENAI_KEY,
    );
    assert.equal(resubmitted.status, 0, resubmitted.stdout + resubmitted.stderr);
    assert.equal(calls.submissions, 1);
    const entry = readEconomy(runDir)["batch-board--A"];
    assert.equal(entry.jobId, "job-new-1");
    assert.deepEqual(entry.previousSubmissions.map((previous) => previous.jobId), ["job-a1"]);
  } finally {
    await close(server);
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("CLI batch-finalize --resubmit buys only the variants it names, not the rest of the command line", async () => {
  const runId = `run-cli-batch-finalize-resubmit-scope-${process.pid}-${Date.now()}`;
  const { server, calls, baseUrl } = await startBatchSubmitServer();
  const runDir = writeBatchFinalizeRun(runId, {
    "batch-board--A": { jobId: "job-a1", status: "in_progress", baseUrl },
    // Kept as possibly bought after its submission timed out; since checked on
    // OpenAI's Batches page and found not to exist.
    "batch-board--B": {
      jobId: "job-b1",
      status: "failed",
      error: "Submission did not complete (The operation timed out.). Before resubmitting, check OpenAI's Batches page for metadata material_collager_job = job-b1.",
    },
  });

  try {
    // The command that skipped both, with --resubmit added for the one checked.
    const result = await runCli(
      ["batch-finalize", "--run", runId, "batch-board--A", "batch-board--B", "--base-url", baseUrl, "--resubmit", "batch-board--B"],
      WITHOUT_OPENAI_KEY,
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(calls.submissions, 1, "only the named variant may buy another batch");
    assert.match(result.stdout, /skipping batch-board--A: .*--resubmit batch-board--A\b/);
    const economy = readEconomy(runDir);
    assert.equal(economy["batch-board--A"].jobId, "job-a1");
    assert.equal(economy["batch-board--A"].previousSubmissions, undefined);
    assert.equal(economy["batch-board--B"].jobId, "job-new-1");
    assert.deepEqual(economy["batch-board--B"].previousSubmissions.map((entry) => entry.jobId), ["job-b1"]);
  } finally {
    await close(server);
    rmSync(runDir, { recursive: true, force: true });
  }
});

function answerWith(status, body) {
  return (response) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  };
}

// The server's own answers when the batch call may have gone through (see
// POST in app/api/economy/route.ts): the job exists, and a batch may too.
for (const [label, error] of [
  ["may have bought", "Submission did not complete (The operation timed out.). Before resubmitting, check OpenAI's Batches page for metadata material_collager_job = job-maybe."],
  ["bought but couldn't record", "Batch batch_9 was created for job job-maybe but could not be recorded (D1 unavailable). Do not resubmit — check OpenAI's Batches page for metadata material_collager_job = job-maybe."],
]) {
  test(`CLI batch-finalize records a submission the server ${label}, and a re-run won't buy it again`, async () => {
    const runId = `run-cli-batch-finalize-unconfirmed-${label.replace(/\W+/g, "-")}-${process.pid}-${Date.now()}`;
    const { server, calls, baseUrl } = await startBatchSubmitServer({ answerSubmission: answerWith(400, { ok: false, error }) });
    const runDir = writeBatchFinalizeRun(runId, {});
    const args = ["batch-finalize", "--run", runId, "batch-board--A", "--base-url", baseUrl];

    try {
      const first = await runCli(args, WITHOUT_OPENAI_KEY);
      assert.notEqual(first.status, 0, first.stdout + first.stderr);
      const entry = readEconomy(runDir)["batch-board--A"];
      assert.ok(entry, "the submission must be on record");
      assert.equal(entry.status, "failed");
      assert.equal(entry.jobId, "job-maybe", "the job the server named is kept, so batch-status can follow it");
      assert.equal(entry.error, error);

      const second = await runCli(args, WITHOUT_OPENAI_KEY);
      assert.equal(second.status, 0, second.stdout + second.stderr);
      assert.equal(calls.submissions, 1, "the re-run must not buy the batch again");
      assert.match(second.stdout, /skipping batch-board--A: .*job-maybe/);
    } finally {
      await close(server);
      rmSync(runDir, { recursive: true, force: true });
    }
  });
}

test("CLI batch-finalize treats a submission that got no answer as possibly bought", async () => {
  const runId = `run-cli-batch-finalize-no-answer-${process.pid}-${Date.now()}`;
  // The connection drops before any answer; the server may still have bought the batch.
  const { server, calls, baseUrl } = await startBatchSubmitServer({ answerSubmission: (response) => response.socket.destroy() });
  const runDir = writeBatchFinalizeRun(runId, {});
  const args = ["batch-finalize", "--run", runId, "batch-board--A", "--base-url", baseUrl];

  try {
    const first = await runCli(args, WITHOUT_OPENAI_KEY);
    assert.notEqual(first.status, 0, first.stdout + first.stderr);
    const entry = readEconomy(runDir)["batch-board--A"];
    assert.ok(entry, "the submission must be on record");
    assert.equal(entry.status, "failed");
    assert.equal(entry.jobId, null);
    assert.match(entry.error, /before resubmitting/i);

    const second = await runCli(args, WITHOUT_OPENAI_KEY);
    assert.equal(second.status, 0, second.stdout + second.stderr);
    assert.equal(calls.submissions, 1, "the re-run must not buy the batch again");
    assert.match(second.stdout, /skipping batch-board--A: .*never confirmed a job/);
  } finally {
    await close(server);
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("CLI batch-finalize records a submission before sending it, so one cut off mid-request isn't bought again", async () => {
  const runId = `run-cli-batch-finalize-killed-${process.pid}-${Date.now()}`;
  let submissionArrived;
  const arrived = new Promise((resolve) => { submissionArrived = resolve; });
  // Never answered: the CLI is killed while it waits, as closing the terminal would.
  const { server, calls, baseUrl } = await startBatchSubmitServer({ answerSubmission: () => submissionArrived() });
  const runDir = writeBatchFinalizeRun(runId, {});
  const args = ["batch-finalize", "--run", runId, "batch-board--A", "--base-url", baseUrl];

  try {
    const { child, finished } = spawnCli(args, WITHOUT_OPENAI_KEY);
    await arrived;
    child.kill();
    await finished;
    const entry = readEconomy(runDir)["batch-board--A"];
    assert.ok(entry, "the submission must be on record before the request goes out");
    assert.equal(entry.status, "submitting");
    assert.equal(entry.jobId, null);

    const second = await runCli(args, WITHOUT_OPENAI_KEY);
    assert.equal(second.status, 0, second.stdout + second.stderr);
    assert.equal(calls.submissions, 1, "the re-run must not buy the batch again");
  } finally {
    await close(server);
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("CLI batch-finalize lets a submission the server refused outright be retried, keeping the earlier job's id", async () => {
  const runId = `run-cli-batch-finalize-refused-${process.pid}-${Date.now()}`;
  // A validation error comes back before the server records a job or calls
  // OpenAI, so nothing was bought; the retry is answered normally.
  const refused = answerWith(400, { ok: false, error: "One or more full-quality final references are unavailable. Upload the references again and retry." });
  const accepted = answerWith(200, { ok: true, jobId: "job-new-2", status: "validating" });
  const { server, calls, baseUrl } = await startBatchSubmitServer({
    answerSubmission: (response, count) => (count === 1 ? refused : accepted)(response),
  });
  const previous = { jobId: "job-b1", status: "failed", error: "Economy render failed." };
  const runDir = writeBatchFinalizeRun(runId, { "batch-board--B": previous });
  const args = ["batch-finalize", "--run", runId, "batch-board--B", "--base-url", baseUrl];

  try {
    const first = await runCli(args, WITHOUT_OPENAI_KEY);
    assert.notEqual(first.status, 0, first.stdout + first.stderr);
    assert.deepEqual(readEconomy(runDir)["batch-board--B"], previous, "a refusal leaves the earlier record as it was");

    const second = await runCli(args, WITHOUT_OPENAI_KEY);
    assert.equal(second.status, 0, second.stdout + second.stderr);
    assert.equal(calls.submissions, 2);
    const entry = readEconomy(runDir)["batch-board--B"];
    assert.equal(entry.jobId, "job-new-2");
    assert.deepEqual(entry.previousSubmissions.map((earlier) => earlier.jobId), ["job-b1"]);
  } finally {
    await close(server);
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("CLI batch-status reports a submission that never confirmed a job instead of looking it up", async () => {
  const runId = `run-cli-batch-status-unconfirmed-${process.pid}-${Date.now()}`;
  const runDir = writeStatusRun(runId, {
    "board--A": {
      jobId: null,
      status: "failed",
      error: "The request ended without an answer. Check the app's history and OpenAI's Batches page before resubmitting.",
    },
    "board--B": { jobId: "job-2", status: "in_progress" },
  });
  const asked = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname !== "/api/economy") {
      response.writeHead(404);
      response.end();
      return;
    }
    asked.push(url.searchParams.get("ids"));
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true, jobs: [], tracked: [economyJob("job-2", "in_progress")] }));
  });
  await listen(server);

  try {
    const result = await runBatchStatus(runId, `http://127.0.0.1:${server.address().port}`);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(asked, ["job-2"]);
    assert.match(result.stdout, /board--A: .*never confirmed a job/);
    assert.doesNotMatch(result.stdout, /job null/);
  } finally {
    await close(server);
    rmSync(runDir, { recursive: true, force: true });
  }
});
