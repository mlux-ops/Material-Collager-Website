// Local bridge between the workbench's Claude CLI / Codex CLI nodes and the
// `claude` and `codex` CLIs on this computer, so those nodes run on the
// signed-in Claude and ChatGPT subscriptions rather than API keys.
//
//   npm run cli-bridge [-- --port 4795 --allow-origin https://example.dev]
//
// Listens on 127.0.0.1 only. Each provider is enabled only when its CLI is
// signed in to a subscription (checked at startup with the same env and flags
// the runs use) — a CLI that would bill an API key stays off. Runs get no
// tools: Claude with --tools "", Codex with its shell and every other tool
// feature disabled. See docs/cli-bridge.md.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  BridgeError,
  claudeArgs,
  claudeStdin,
  claudeUsesSubscription,
  codexArgs,
  codexPrompt,
  codexUsesChatGpt,
  DEFAULT_ALLOWED_ORIGINS,
  DEFAULT_PORT,
  imageExtension,
  inspectClaudeEvent,
  isAllowedHost,
  isAllowedOrigin,
  MAX_BODY_BYTES,
  resolveExecutable,
  scrubEnv,
  validateRunPayload,
} from "./lib.mjs";

const RUN_TIMEOUT_MS = 5 * 60 * 1000;
const STATUS_TIMEOUT_MS = 30 * 1000;
const MAX_CONCURRENT_RUNS = 2;
const MAX_ERROR_DETAIL_CHARS = 600;

const { values } = parseArgs({
  options: {
    port: { type: "string" },
    "allow-origin": { type: "string", multiple: true },
  },
});
const port = Number(values.port ?? DEFAULT_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`Invalid --port: ${values.port}`);
  process.exit(1);
}
const allowedOrigins = [...DEFAULT_ALLOWED_ORIGINS, ...(values["allow-origin"] ?? [])];
const childEnv = scrubEnv(process.env);

// Every spawn starts in a fresh, empty temp directory so no project's
// CLAUDE.md, AGENTS.md or .claude/ settings load into the run.
async function withWorkDir(task) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mc-cli-bridge-"));
  try {
    return await task(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function findBinary(name, override) {
  if (override) return existsSync(override) ? override : null;
  return resolveExecutable(name, {
    platform: process.platform,
    pathEnv: process.env.PATH ?? process.env.Path,
    exists: existsSync,
    readFile: (file) => readFileSync(file, "utf8"),
  });
}

// Spawns without a shell; resolves with stdout/stderr and the exit code. The
// signal kills the child (request aborted or timed out); onStdoutLine lets a
// caller kill it early from what it reads.
function runChild(bin, args, { cwd, stdin, signal, timeoutMs, onStdoutLine }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env: childEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let pending = "";
    let killedFor = null;
    const kill = (reason) => {
      if (killedFor) return;
      killedFor = reason;
      child.kill();
    };
    const timer = setTimeout(() => kill("timed out"), timeoutMs);
    const onAbort = () => kill("cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (!onStdoutLine) return;
      pending += chunk;
      let newline;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (!line) continue;
        const stop = onStdoutLine(line);
        if (stop) kill(stop);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr, killedFor });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(stdin ?? "");
  });
}

function tail(text) {
  const trimmed = text.trim();
  return trimmed.length > MAX_ERROR_DETAIL_CHARS ? `…${trimmed.slice(-MAX_ERROR_DETAIL_CHARS)}` : trimmed;
}

const providers = {
  claude: { bin: null, available: false, reason: "not checked" },
  codex: { bin: null, available: false, reason: "not checked" },
};

async function checkClaude() {
  const bin = findBinary("claude", process.env.CLAUDE_BIN);
  if (!bin) return { bin, available: false, reason: "claude CLI not found on PATH (set CLAUDE_BIN)" };
  const result = await withWorkDir((dir) => runChild(bin, ["--setting-sources", "project", "auth", "status", "--json"], { cwd: dir, timeoutMs: STATUS_TIMEOUT_MS }));
  if (!claudeUsesSubscription(result.stdout)) {
    return { bin, available: false, reason: "claude is not signed in to a Claude subscription (run `claude` and use /login)" };
  }
  return { bin, available: true };
}

async function checkCodex() {
  const bin = findBinary("codex", process.env.CODEX_BIN);
  if (!bin) return { bin, available: false, reason: "codex CLI not found on PATH (set CODEX_BIN)" };
  const result = await withWorkDir((dir) => runChild(bin, ["login", "status"], { cwd: dir, timeoutMs: STATUS_TIMEOUT_MS }));
  if (!codexUsesChatGpt(`${result.stdout}\n${result.stderr}`)) {
    return { bin, available: false, reason: "codex is not signed in with ChatGPT (run `codex login`)" };
  }
  return { bin, available: true };
}

async function runClaude({ model, effort, instruction, images }, signal) {
  let subscriptionChecked = false;
  let refusedSource = null;
  const outcome = await withWorkDir((dir) => runChild(providers.claude.bin, claudeArgs(model, effort), {
    cwd: dir,
    stdin: claudeStdin(instruction, images),
    signal,
    timeoutMs: RUN_TIMEOUT_MS,
    // Fail closed: the init event arrives before the model call, so an API
    // key that slipped through is caught before it is billed.
    onStdoutLine: (line) => {
      const event = inspectClaudeEvent(line);
      if (event?.kind !== "init" || subscriptionChecked) return null;
      subscriptionChecked = true;
      if (event.subscription) return null;
      refusedSource = event.apiKeySource;
      return "not on subscription";
    },
  }));
  if (refusedSource) throw new BridgeError(503, `Claude CLI would bill an API key (${refusedSource}), not your subscription — refused.`);
  if (outcome.killedFor) throw new BridgeError(outcome.killedFor === "cancelled" ? 499 : 504, `Claude CLI ${outcome.killedFor}.`);
  const result = outcome.stdout.split("\n").map(inspectClaudeEvent).find((event) => event?.kind === "result");
  if (!subscriptionChecked) throw new BridgeError(502, `Claude CLI did not start: ${tail(outcome.stderr || outcome.stdout)}`);
  if (!result) throw new BridgeError(502, `Claude CLI returned no answer: ${tail(outcome.stderr)}`);
  if (result.isError) throw new BridgeError(502, `Claude CLI: ${tail(result.text)}`);
  return result.text;
}

async function runCodex({ model, effort, instruction, images }, signal) {
  return withWorkDir(async (dir) => {
    const imagePaths = [];
    for (const [index, image] of images.entries()) {
      const file = path.join(dir, `image-${index + 1}.${imageExtension(image.mimeType)}`);
      await writeFile(file, Buffer.from(image.data, "base64"));
      imagePaths.push(file);
    }
    const outFile = path.join(dir, "answer.txt");
    const outcome = await runChild(providers.codex.bin, codexArgs({ model, effort, workDir: dir, imagePaths, outFile }), {
      cwd: dir,
      stdin: codexPrompt(instruction),
      signal,
      timeoutMs: RUN_TIMEOUT_MS,
    });
    if (outcome.killedFor) throw new BridgeError(outcome.killedFor === "cancelled" ? 499 : 504, `Codex CLI ${outcome.killedFor}.`);
    if (outcome.code !== 0) throw new BridgeError(502, `Codex CLI failed: ${tail(outcome.stderr || outcome.stdout)}`);
    const answer = await readFile(outFile, "utf8").catch(() => "");
    if (!answer.trim()) throw new BridgeError(502, "Codex CLI returned no answer.");
    return answer.trim();
  });
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    // Past the cap, keep draining instead of destroying the socket, so the
    // browser gets the 413 rather than a dropped connection that reads as
    // "helper not running".
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    request.on("end", () => {
      if (size > MAX_BODY_BYTES) reject(new BridgeError(413, "The images are too large for one request."));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", reject);
  });
}

function send(response, status, body) {
  if (response.writableEnded || response.destroyed) return;
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

let activeRuns = 0;

const server = createServer(async (request, response) => {
  if (!isAllowedHost(request.headers.host, port)) {
    send(response, 403, { ok: false, error: "Host not allowed." });
    return;
  }
  // Browsers always send Origin on cross-origin requests; a request without
  // one comes from a local process, which could run the CLI itself anyway.
  const origin = request.headers.origin;
  if (origin !== undefined) {
    if (!isAllowedOrigin(origin, allowedOrigins)) {
      send(response, 403, { ok: false, error: "Origin not allowed." });
      return;
    }
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }

  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);

  if (request.method === "OPTIONS") {
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    response.setHeader("Access-Control-Max-Age", "600");
    // Chrome's Private Network Access preflight for a public page (the
    // deployed site) reaching loopback.
    if (request.headers["access-control-request-private-network"] === "true") {
      response.setHeader("Access-Control-Allow-Private-Network", "true");
    }
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.method === "GET" && url.pathname === "/health") {
    send(response, 200, {
      ok: true,
      providers: Object.fromEntries(Object.entries(providers).map(([name, state]) => [
        name,
        state.available ? { available: true } : { available: false, reason: state.reason },
      ])),
    });
    return;
  }

  if (request.method !== "POST" || url.pathname !== "/run") {
    send(response, 404, { ok: false, error: "Not found." });
    return;
  }

  const started = Date.now();
  let provider = "?";
  // Aborts the child when the browser cancels the node run or disconnects.
  const controller = new AbortController();
  response.on("close", () => {
    if (!response.writableEnded) controller.abort();
  });
  try {
    // A JSON content type forces a CORS preflight, so no page can fire this
    // as a "simple" cross-site request.
    if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      throw new BridgeError(415, "Content-Type must be application/json.");
    }
    let body;
    try {
      body = JSON.parse(await readBody(request));
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError(400, "Request body is not valid JSON.");
    }
    const payload = validateRunPayload(body);
    provider = payload.provider;
    const state = providers[payload.provider];
    if (!state.available) throw new BridgeError(503, `${payload.provider} is unavailable: ${state.reason}`);
    if (activeRuns >= MAX_CONCURRENT_RUNS) throw new BridgeError(429, "The CLI helper is busy — try again when a run finishes.");
    activeRuns += 1;
    try {
      const text = payload.provider === "claude"
        ? await runClaude(payload, controller.signal)
        : await runCodex(payload, controller.signal);
      send(response, 200, { ok: true, text });
      console.log(`${new Date().toISOString()} ${provider} ok ${Date.now() - started}ms`);
    } finally {
      activeRuns -= 1;
    }
  } catch (error) {
    const status = error instanceof BridgeError ? error.status : 500;
    const message = error instanceof Error ? error.message : String(error);
    send(response, status, { ok: false, error: message });
    console.log(`${new Date().toISOString()} ${provider} ${status} ${Date.now() - started}ms ${message}`);
  }
});

const [claude, codex] = await Promise.all([checkClaude(), checkCodex()]);
providers.claude = claude;
providers.codex = codex;
for (const [name, state] of Object.entries(providers)) {
  console.log(`${name}: ${state.available ? `ready (${state.bin})` : `unavailable — ${state.reason}`}`);
}

server.listen(port, "127.0.0.1", () => {
  console.log(`CLI bridge listening on http://127.0.0.1:${port}`);
  console.log(`Allowed origins: ${allowedOrigins.join(", ")}`);
});
