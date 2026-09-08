# Review Board Render Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the whole autoboard workflow — draft, pick, note, confirm, final — from the local review board, with a live render panel beside every board.

**Architecture:** Extract the render pipeline out of `scripts/autoboard/cli.mjs` into `lib/access.mjs` (Cloudflare Access credentials), `lib/render.mjs` (payload builders, Worker POST, result recording, job execution) and `lib/render-queue.mjs` (sequential in-memory queue with cancel). The review server owns one queue per run and exposes JSON endpoints; the page polls status and renders a panel per board. The CLI keeps every command but calls the same library functions.

**Tech Stack:** Node 24 (`node --experimental-strip-types`), `node:test`, `node:http`, `sharp` (already a dependency, via `lib/transport.mjs`), no framework, no new dependencies.

Spec: `docs/superpowers/specs/2026-09-07-review-board-render-workflow-design.md` (condensed per the 2026-09-07 decision: no QA checkbox, in-memory queue, no held/resume; lightbox kept).

## Global Constraints

- Drafts render at quality `low`, resolution `standard`; confirm at `medium` / `standard`; final at `high` / `final` with `renderKind: "final"`. Variants keep `soft_daylight` + `materials_only` (never change `DEFAULT_VARIANTS`).
- The review board never runs automated QA. The CLI's opt-in `--qa` flag is untouched.
- One render at a time across all boards. Nothing auto-retries a failed paid render.
- Access tokens and the OpenAI key must never appear in logs, status payloads or test output.
- `scripts/autoboard/lib/review-page.mjs` is one template literal containing the client script: **no backticks and no escaped double quotes inside the embedded JS, including comments.** Run `node --check scripts/autoboard/lib/review-page.mjs` after every edit of that file.
- Every render call in tests is mocked (`t.mock.method(globalThis, "fetch", …)`); no test may hit the network or the deployed Worker.
- Never run `generate`/`redraft`/`confirm`/`finalize` against a real server during implementation except the single manual check in Task 6, and only with the user's go-ahead.
- Commit after every task with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` as the last line of the message.
- Test command for this area: `npm run test:autoboard`. Full suite: `node --experimental-strip-types --test tests/*.test.mjs`.

## Decisions fixed by this plan

- **Board instruction delivery.** `CollageRequestInput` (app/lib/collage.ts) has no board-level notes field, only per-item `notes`. The board instruction is appended to the **hero item's** notes as `Board instruction: <text>` (the hero is `orderedBoardItems(board)[0]`, always first in the payload). A request-level field in the app is a follow-up needing a deploy; not done here.
- **Per-item notes** live on plan items as `item.note`. `notes.json` is imported once when the server opens a run (only into items whose `note` is `undefined`), then ignored.
- **Render files:** `boards/<boardId>/drafts/<id>.png`, `boards/<boardId>/confirmed/<id>.png`, `boards/<boardId>/finals/<id>.png` under the run dir. Picking a draft also copies it to the legacy `boards/<boardId>/<variantKey>.png` and mirrors it into `results.candidates["<boardId>--<variantKey>"]` so the CLI's `confirm`/`finalize` still work.
- **Queue is in memory only.** A server restart starts with an empty queue; render *records* are in `results.json` and survive. An expired Access session fails that one job with the login hint; the next click re-resolves credentials before enqueuing.
- **Approximate costs** (USD per image, labelled `~$`): draft 0.016, confirm 0.04, final 0.19.

## File Structure

| File | Responsibility |
|---|---|
| `scripts/autoboard/lib/access.mjs` (new) | `.dev.vars`/env lookup, `loadOpenAIKey`, Access credential candidates, `resolveAccessHeaders(baseUrl)` (moved from cli.mjs, no module-global state) |
| `scripts/autoboard/lib/render.mjs` (new) | `selectionHash`, cost table, `boardForRender`, payload builders, `postGeneration`, `renders` record helpers, `pickDraft`, `approveConfirmed`, `runRenderJob` |
| `scripts/autoboard/lib/render-queue.mjs` (new) | `RenderQueue` — FIFO, progress, cancel |
| `scripts/autoboard/cli.mjs` (modify) | Import from the libs; delete moved code; `review` gains `--base-url` |
| `scripts/autoboard/lib/review-server.mjs` (modify) | notes.json import, render endpoints, queue wiring, render image serving |
| `scripts/autoboard/lib/review-page.mjs` (modify) | per-item note field, render panel, status polling, lightbox |
| `tests/autoboard-access.test.mjs`, `tests/autoboard-render.test.mjs`, `tests/autoboard-render-queue.test.mjs` (new); `tests/autoboard-review.test.mjs` (modify); `tests/autoboard-page.test.mjs` (new) | Tests |

---

### Task 1: `lib/access.mjs` — credentials and Access resolution without globals

**Files:**
- Create: `scripts/autoboard/lib/access.mjs`
- Test: `tests/autoboard-access.test.mjs`

**Interfaces (produces):**
- `localVar(name, { env = process.env, devVars = DEV_VARS } = {}) → string | undefined`
- `loadOpenAIKey() → string | undefined`
- `cloudflaredToken(baseUrl, { execFile = execFileSync } = {}) → string | undefined`
- `accessHeaderCandidates(baseUrl, { env, devVars, tokenLookup = cloudflaredToken } = {}) → Array<{ label, headers }>`
- `class AccessError extends Error { code: "access-rejected" | "unreachable"; status?: number }`
- `accessLoginHint(baseUrl) → string`
- `isAccessRejection(status) → boolean` (302 or 403)
- `resolveAccessHeaders(baseUrl, { fetchImpl = fetch, attempts = 10, sleepMs = 3000, log = () => {}, env, devVars, tokenLookup } = {}) → Promise<{ headers, label }>` — throws `AccessError`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/autoboard-access.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AccessError,
  accessHeaderCandidates,
  isAccessRejection,
  localVar,
  resolveAccessHeaders,
} from "../scripts/autoboard/lib/access.mjs";

test("localVar prefers the environment over .dev.vars and ignores blanks", () => {
  assert.equal(localVar("X", { env: { X: "env" }, devVars: { X: "file" } }), "env");
  assert.equal(localVar("X", { env: { X: "" }, devVars: { X: "file" } }), "file");
  assert.equal(localVar("X", { env: {}, devVars: {} }), undefined);
});

test("accessHeaderCandidates orders service token, user JWT, cloudflared session, then none", () => {
  const candidates = accessHeaderCandidates("https://app.example.workers.dev", {
    env: { CF_ACCESS_CLIENT_ID: "id", CF_ACCESS_CLIENT_SECRET: "secret", CF_ACCESS_TOKEN: "jwt" },
    devVars: {},
    tokenLookup: () => "a.b.c",
  });
  assert.deepEqual(candidates.map((c) => c.label), [
    "Access service token", "CF_ACCESS_TOKEN", "cloudflared session", "no Access credentials",
  ]);
  assert.deepEqual(candidates[2].headers, { "cf-access-token": "a.b.c" });
  assert.deepEqual(candidates[3].headers, {});
});

test("accessHeaderCandidates skips the cloudflared lookup for localhost", () => {
  let called = false;
  const candidates = accessHeaderCandidates("http://localhost:3000", {
    env: {}, devVars: {}, tokenLookup: () => { called = true; return "a.b.c"; },
  });
  assert.equal(called, false);
  assert.deepEqual(candidates.map((c) => c.label), ["no Access credentials"]);
});

test("isAccessRejection recognises the two Access failure statuses only", () => {
  assert.equal(isAccessRejection(302), true);
  assert.equal(isAccessRejection(403), true);
  assert.equal(isAccessRejection(401), false);
  assert.equal(isAccessRejection(200), false);
});

test("resolveAccessHeaders locks in the first credential the server accepts", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(init.headers);
    return new Response("", { status: init.headers["cf-access-token"] ? 200 : 302 });
  };
  const result = await resolveAccessHeaders("https://app.example.workers.dev", {
    fetchImpl, env: {}, devVars: {}, tokenLookup: () => "a.b.c", sleepMs: 0,
  });
  assert.deepEqual(result, { headers: { "cf-access-token": "a.b.c" }, label: "cloudflared session" });
  assert.equal(seen.length, 1);
});

test("resolveAccessHeaders throws access-rejected when every credential is refused", async () => {
  const fetchImpl = async () => new Response("", { status: 403 });
  await assert.rejects(
    resolveAccessHeaders("https://app.example.workers.dev", { fetchImpl, env: {}, devVars: {}, tokenLookup: () => undefined, sleepMs: 0 }),
    (error) => error instanceof AccessError && error.code === "access-rejected" && error.status === 403 && /cloudflared access login/.test(error.message),
  );
});

test("resolveAccessHeaders throws unreachable after the attempts run out", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new TypeError("fetch failed"); };
  await assert.rejects(
    resolveAccessHeaders("http://localhost:3000", { fetchImpl, env: {}, devVars: {}, attempts: 2, sleepMs: 0 }),
    (error) => error instanceof AccessError && error.code === "unreachable",
  );
  assert.equal(calls, 2);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --experimental-strip-types --test tests/autoboard-access.test.mjs`
Expected: FAIL — `Cannot find module '.../lib/access.mjs'`.

- [ ] **Step 3: Write `lib/access.mjs`**

```js
// scripts/autoboard/lib/access.mjs
// Credentials for talking to a deployed --base-url behind Cloudflare Access,
// plus the OpenAI key lookup the CLI forwards to a local dev server. Moved
// out of cli.mjs so the review server can use the same logic; nothing here
// keeps module-global state — callers hold the resolved headers.
//
// Secrets resolve from the shell env first, then the repo's git-ignored
// .dev.vars. Commented lines and blank values are ignored. Never logged.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const DEV_VARS = (() => {
  try {
    const vars = {};
    for (const line of readFileSync(".dev.vars", "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/);
      if (match) vars[match[1]] = match[2].trim();
    }
    return vars;
  } catch {
    return {};
  }
})();

export function localVar(name, { env = process.env, devVars = DEV_VARS } = {}) {
  return env[name] || devVars[name] || undefined;
}

export function loadOpenAIKey() {
  return localVar("OPENAI_API_KEY");
}

const CLOUDFLARED_CANDIDATES = [
  "cloudflared",
  "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe",
  "C:\\Program Files\\cloudflared\\cloudflared.exe",
];

export function cloudflaredToken(baseUrl, { execFile = execFileSync } = {}) {
  for (const executable of CLOUDFLARED_CANDIDATES) {
    try {
      const token = execFile(executable, ["access", "token", `-app=${baseUrl}`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 15_000,
      }).trim();
      if (token.split(".").length === 3) return token;
    } catch {
      // executable missing or no cached session for this app; try the next one
    }
  }
  return undefined;
}

// Tried in order; the first one Access accepts is locked in for the run:
//   CF_ACCESS_CLIENT_ID + CF_ACCESS_CLIENT_SECRET  (an Access service token)
//   CF_ACCESS_TOKEN                                 (an explicit user JWT)
//   cloudflared's cached session                    (`cloudflared access login <url>`)
export function accessHeaderCandidates(baseUrl, { env = process.env, devVars = DEV_VARS, tokenLookup = cloudflaredToken } = {}) {
  const candidates = [];
  const clientId = localVar("CF_ACCESS_CLIENT_ID", { env, devVars });
  const clientSecret = localVar("CF_ACCESS_CLIENT_SECRET", { env, devVars });
  if (clientId && clientSecret) {
    candidates.push({
      label: "Access service token",
      headers: { "CF-Access-Client-Id": clientId, "CF-Access-Client-Secret": clientSecret },
    });
  }
  const userToken = localVar("CF_ACCESS_TOKEN", { env, devVars });
  if (userToken) candidates.push({ label: "CF_ACCESS_TOKEN", headers: { "cf-access-token": userToken } });
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)/i.test(baseUrl)) {
    const sessionToken = tokenLookup(baseUrl);
    if (sessionToken) {
      candidates.push({ label: "cloudflared session", headers: { "cf-access-token": sessionToken } });
    }
  }
  candidates.push({ label: "no Access credentials", headers: {} });
  return candidates;
}

// Access signals rejection with a 302 to the team login page or a 403 from
// the worker's own JWT check.
export function isAccessRejection(status) {
  return status === 302 || status === 403;
}

export class AccessError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = "AccessError";
    this.code = code;
    this.status = status;
  }
}

export function accessLoginHint(baseUrl) {
  return `Run \`cloudflared access login ${baseUrl}\` to refresh the session, or fix the service token in .dev.vars.`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function resolveAccessHeaders(
  baseUrl,
  { fetchImpl = fetch, attempts = 10, sleepMs = 3000, log = () => {}, env, devVars, tokenLookup } = {},
) {
  const candidates = accessHeaderCandidates(baseUrl, { env, devVars, tokenLookup });
  let rejectedStatus;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let reachable = false;
    for (const candidate of candidates) {
      let response;
      try {
        response = await fetchImpl(`${baseUrl}/api/library`, {
          headers: candidate.headers,
          redirect: "manual",
          signal: AbortSignal.timeout(8000),
        });
      } catch {
        continue; // server not reachable (yet)
      }
      reachable = true;
      if (isAccessRejection(response.status)) {
        rejectedStatus = response.status;
        continue;
      }
      if (Object.keys(candidate.headers).length) log(`  authenticated via ${candidate.label}`);
      return { headers: candidate.headers, label: candidate.label };
    }
    if (reachable) break; // reachable but every credential was rejected
    if (attempt === 1) log(`  waiting for ${baseUrl} ...`);
    if (attempt < attempts) await sleep(sleepMs);
  }
  if (rejectedStatus) {
    throw new AccessError(
      `${baseUrl} rejected every Access credential (HTTP ${rejectedStatus}). ${accessLoginHint(baseUrl)}`,
      "access-rejected",
      rejectedStatus,
    );
  }
  throw new AccessError(
    `No server responded at ${baseUrl}. Start it with \`npm run dev\` (or pass --base-url).`,
    "unreachable",
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --experimental-strip-types --test tests/autoboard-access.test.mjs`
Expected: `ℹ pass 7`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add scripts/autoboard/lib/access.mjs tests/autoboard-access.test.mjs
git commit -m "autoboard: extract Access credential resolution into lib/access.mjs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `lib/render.mjs` — payload builders, Worker POST, recording, job execution

**Files:**
- Create: `scripts/autoboard/lib/render.mjs`
- Test: `tests/autoboard-render.test.mjs`

**Interfaces:**
- Consumes: `boardPayload`, `boardReferenceFiles`, `orderedBoardItems` from `./variants.mjs`; `validateCollageRequest` from `../../app/lib/collage.ts`; `prepareReferenceForUpload` from `./transport.mjs`; `AccessError`, `isAccessRejection`, `accessLoginHint` from `./access.mjs`.
- Produces:
  - `COST_PER_IMAGE = { draft: 0.016, confirm: 0.04, final: 0.19 }`; `estimateCost(kind, count = 1) → number`; `formatCost(amount) → "~$0.05"`
  - `selectionHash(board, instruction = "") → string` (sha1 hex)
  - `boardForRender(board, instruction = "") → board copy` (items carry `notes` from `item.note`; hero gets `Board instruction: …`)
  - `buildDraftPayload(board, variant, { apiKey, instruction, quality = "low", outputResolution = "standard" } = {}) → { payload, files }`
  - `buildConfirmPayload(board, variant, sourcePath, { apiKey, instruction, quality = "medium", outputResolution = "standard" } = {})`
  - `buildFinalPayload(board, variant, sourcePath, { apiKey, instruction, quality = "high" } = {})`
  - `postGeneration(baseUrl, payload, files, { accessHeaders = {}, signal } = {}) → Promise<json>` — throws `Error` with `.status/.code/.retryAfterMs/.diagnostics`; `AccessError("access-rejected")` on 302/403.
  - `ensureRenders(results, boardId)`, `nextRenderId(renders, "d"|"c"|"f")`, `renderFilePath(runDir, boardId, kind, id)`, `saveRenderImage(runDir, boardId, kind, id, imageBase64) → run-relative path`
  - `recordDraft / recordConfirmed / recordFinal(results, boardId, record) → record`
  - `pickDraft(results, runDir, boardId, draftId, { appliedNotes = {} } = {}) → draft`; `approveConfirmed(results, boardId, confirmedId | null)`; `renderSource(results, boardId) → { kind, record } | null`
  - `runRenderJob(job, ctx)` — `job = { jobId, boardId, kind, variant?, count?, instructionSnapshot, selectionHash }`, `ctx = { plan, results, runDir, baseUrl, accessHeaders, apiKey, signal, onProgress(text), persist() }`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/autoboard-render.test.mjs
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { AccessError } from "../scripts/autoboard/lib/access.mjs";
import {
  approveConfirmed,
  boardForRender,
  buildConfirmPayload,
  buildDraftPayload,
  buildFinalPayload,
  ensureRenders,
  estimateCost,
  formatCost,
  nextRenderId,
  pickDraft,
  postGeneration,
  recordConfirmed,
  recordDraft,
  renderSource,
  runRenderJob,
  saveRenderImage,
  selectionHash,
} from "../scripts/autoboard/lib/render.mjs";
import { DEFAULT_VARIANTS } from "../scripts/autoboard/lib/variants.mjs";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const A = DEFAULT_VARIANTS[0];

function board(overrides = {}) {
  return {
    id: "penthouse-bath-2-fixture",
    title: "Penthouse Bath 2 Fixture Collage",
    unitType: "Penthouse",
    roomLabel: "Bath 2",
    collageType: "bathroom_fixture_collage",
    items: [
      { slotId: "vanity_faucet", role: "vanity faucet", required: true, name: "Croma Select S", brand: "Hansgrohe", notes: "", images: ["E:/lib/faucet.png"] },
      { slotId: "main_tile", role: "main tile", required: true, name: "Green Terrazzo", brand: "", notes: "", images: ["E:/lib/tile.png"], note: "keep the terrazzo chips visible" },
    ],
    ...overrides,
  };
}

function scratchRun() {
  const runDir = mkdtempSync(path.join(tmpdir(), "autoboard-render-"));
  const lib = path.join(runDir, "lib");
  mkdirSync(lib, { recursive: true });
  writeFileSync(path.join(lib, "faucet.png"), PNG);
  writeFileSync(path.join(lib, "tile.png"), PNG);
  const plan = {
    runId: "run-test",
    variants: DEFAULT_VARIANTS,
    boards: [board({ items: [
      { slotId: "vanity_faucet", role: "vanity faucet", required: true, name: "Croma", brand: "Hansgrohe", notes: "", images: [path.join(lib, "faucet.png")] },
      { slotId: "main_tile", role: "main tile", required: true, name: "Terrazzo", brand: "", notes: "", images: [path.join(lib, "tile.png")] },
    ] })],
  };
  return { runDir, plan, results: { candidates: {}, finals: {} } };
}

test("estimateCost and formatCost use the constant table and label approximations", () => {
  assert.equal(estimateCost("draft", 3), 0.048);
  assert.equal(estimateCost("confirm"), 0.04);
  assert.equal(estimateCost("final"), 0.19);
  assert.equal(formatCost(0.048), "~$0.05");
  assert.throws(() => estimateCost("bogus"), /Unknown render kind/);
});

test("selectionHash is stable for the same selection and changes with images, notes or instruction", () => {
  const base = selectionHash(board());
  assert.equal(selectionHash(board()), base);
  assert.match(base, /^[0-9a-f]{40}$/);
  const swapped = board();
  swapped.items[0].images = ["E:/lib/other-faucet.png"];
  assert.notEqual(selectionHash(swapped), base);
  const noted = board();
  noted.items[0].note = "no mirroring";
  assert.notEqual(selectionHash(noted), base);
  assert.notEqual(selectionHash(board(), "more breathing room"), base);
  const relabelled = board();
  relabelled.items[0].overriddenAt = "2026-09-07T00:00:00Z";
  relabelled.title = "Renamed";
  assert.equal(selectionHash(relabelled), base);
});

test("boardForRender turns item.note into model notes and pins the board instruction on the hero item", () => {
  const prepared = boardForRender(board(), "more breathing room");
  const faucet = prepared.items.find((item) => item.slotId === "vanity_faucet");
  const tile = prepared.items.find((item) => item.slotId === "main_tile");
  assert.equal(faucet.notes, "Board instruction: more breathing room");
  assert.equal(tile.notes, "keep the terrazzo chips visible");
  assert.equal(board().items[0].notes, "");
});

test("boardForRender joins an existing item note and the instruction on the hero", () => {
  const source = board();
  source.items[0].note = "do not mirror";
  assert.equal(boardForRender(source, "tile lower-left").items[0].notes, "do not mirror Board instruction: tile lower-left");
});

test("buildDraftPayload renders low/standard studio drafts with reference files in item order", () => {
  const { payload, files } = buildDraftPayload(board(), A, { apiKey: "k", instruction: "airy" });
  assert.equal(payload.quality, "low");
  assert.equal(payload.outputResolution, "standard");
  assert.equal(payload.renderKind, "studio");
  assert.equal(payload.layoutReference, undefined);
  assert.equal(payload.apiKey, "k");
  assert.deepEqual(payload.items.map((item) => item.id), ["vanity_faucet", "main_tile"]);
  assert.equal(payload.items[0].notes, "Board instruction: airy");
  assert.deepEqual(files.map((file) => file.name), ["vanity_faucet--faucet.png", "main_tile--tile.png"]);
});

test("buildConfirmPayload is medium quality with the source draft first as the approved-draft layout reference", () => {
  const { payload, files } = buildConfirmPayload(board(), A, "E:/run/boards/b/drafts/d-0001.png", {});
  assert.equal(payload.quality, "medium");
  assert.equal(payload.outputResolution, "standard");
  assert.equal(payload.renderKind, "studio");
  assert.equal(payload.layoutReference, true);
  assert.equal(payload.layoutReferenceMode, "approved-draft");
  assert.deepEqual(files[0], { path: "E:/run/boards/b/drafts/d-0001.png", name: "approved-draft.png" });
  assert.equal(files.length, 3);
});

test("buildFinalPayload is high/final with the source render as layout reference", () => {
  const { payload, files } = buildFinalPayload(board(), A, "E:/run/boards/b/confirmed/c-0001.png", {});
  assert.equal(payload.quality, "high");
  assert.equal(payload.outputResolution, "final");
  assert.equal(payload.renderKind, "final");
  assert.equal(payload.layoutReference, true);
  assert.equal(files[0].name, "approved-draft.png");
});

test("payload builders reject a board the app would refuse", () => {
  assert.throws(() => buildDraftPayload(board({ items: [] }), A), /item/i);
});

test("postGeneration posts multipart with Access headers and returns the JSON body", async (t) => {
  let received;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    received = { url, headers: init.headers, images: init.body.getAll("image[]").length };
    return Response.json({ ok: true, imageBase64: PNG.toString("base64"), mimeType: "image/png", jobId: "job-1" });
  });
  const { runDir } = scratchRun();
  const json = await postGeneration("https://w.example", { collageType: "x" }, [{ path: path.join(runDir, "lib", "faucet.png"), name: "vanity_faucet--faucet.png" }], { accessHeaders: { "cf-access-token": "t" } });
  assert.equal(received.url, "https://w.example/api/generate");
  assert.equal(received.headers["cf-access-token"], "t");
  assert.equal(received.images, 1);
  assert.equal(json.jobId, "job-1");
  assert.equal(json.resizedReferenceCount, 0);
  rmSync(runDir, { recursive: true, force: true });
});

test("postGeneration turns an Access 302/403 into AccessError and surfaces Worker error fields", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("", { status: 302 }));
  await assert.rejects(postGeneration("https://w.example", {}, []), (error) => error instanceof AccessError && error.code === "access-rejected");
  t.mock.method(globalThis, "fetch", async () => Response.json({ ok: false, error: "Busy", code: "rate_limited", retryAfterMs: 120000, diagnostics: { attempts: [] } }, { status: 429 }));
  await assert.rejects(postGeneration("https://w.example", {}, []), (error) => error.status === 429 && error.retryAfterMs === 120000 && error.code === "rate_limited" && Array.isArray(error.diagnostics.attempts));
});

test("postGeneration honours an AbortSignal", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url, init) => { init.signal.throwIfAborted(); return Response.json({ ok: true }); });
  await assert.rejects(postGeneration("https://w.example", {}, [], { signal: AbortSignal.abort() }), (error) => error.name === "AbortError");
});

test("ensureRenders creates the per-board record once and nextRenderId zero-pads per kind", () => {
  const results = { candidates: {}, finals: {} };
  const renders = ensureRenders(results, "b");
  assert.deepEqual(renders, { instruction: "", pickedDraftId: null, approvedConfirmedId: null, drafts: [], confirmed: [], finals: [] });
  assert.equal(ensureRenders(results, "b"), renders);
  assert.equal(nextRenderId(renders, "d"), "d-0001");
  renders.drafts.push({ id: "d-0001" }, { id: "d-0002" });
  assert.equal(nextRenderId(renders, "d"), "d-0003");
  assert.equal(nextRenderId(renders, "c"), "c-0001");
});

test("saveRenderImage writes under boards/<board>/<kind dir> and returns a run-relative forward-slash path", async () => {
  const { runDir } = scratchRun();
  assert.equal(await saveRenderImage(runDir, "b", "draft", "d-0001", PNG.toString("base64")), "boards/b/drafts/d-0001.png");
  assert.ok(existsSync(path.join(runDir, "boards", "b", "drafts", "d-0001.png")));
  assert.equal(await saveRenderImage(runDir, "b", "confirm", "c-0001", PNG.toString("base64")), "boards/b/confirmed/c-0001.png");
  assert.equal(await saveRenderImage(runDir, "b", "final", "f-0001", PNG.toString("base64")), "boards/b/finals/f-0001.png");
  rmSync(runDir, { recursive: true, force: true });
});

test("recordDraft bumps the revision only when the selection hash changes", () => {
  const results = { candidates: {}, finals: {} };
  const rec = (variant, hash, index) => recordDraft(results, "b", { variant, index, path: "p", jobId: "j", durationMs: 1, selectionHash: hash, instruction: "", itemNotes: {} });
  const first = rec("A", "h1", 1);
  const second = rec("A", "h1", 2);
  const third = rec("B", "h2", 1);
  assert.equal(first.id, "d-0001");
  assert.equal(first.revision, 1);
  assert.equal(second.revision, 1);
  assert.equal(third.revision, 2);
  assert.ok(third.createdAt);
});

test("pickDraft mirrors the draft into the legacy candidate and copies the PNG to boards/<board>/<variant>.png", async () => {
  const { runDir, results } = scratchRun();
  const boardId = "penthouse-bath-2-fixture";
  const rel = await saveRenderImage(runDir, boardId, "draft", "d-0001", PNG.toString("base64"));
  recordDraft(results, boardId, { variant: "A", index: 1, path: rel, jobId: "j1", durationMs: 1, selectionHash: "h", instruction: "", itemNotes: {} });
  const picked = pickDraft(results, runDir, boardId, "d-0001", { appliedNotes: { main_tile: "x" } });
  assert.equal(picked.id, "d-0001");
  assert.equal(results.renders[boardId].pickedDraftId, "d-0001");
  const candidate = results.candidates[`${boardId}--A`];
  assert.equal(candidate.status, "ok");
  assert.equal(candidate.renderKind, "studio");
  assert.equal(candidate.jobId, "j1");
  assert.deepEqual(candidate.appliedNotes, { main_tile: "x" });
  assert.equal(candidate.savedPath, path.join(runDir, "boards", boardId, "A.png"));
  assert.ok(existsSync(candidate.savedPath));
  assert.throws(() => pickDraft(results, runDir, boardId, "d-9999"), (error) => error.status === 404);
  rmSync(runDir, { recursive: true, force: true });
});

test("renderSource prefers an approved confirmed render over the picked draft", () => {
  const results = { candidates: {}, finals: {} };
  assert.equal(renderSource(results, "b"), null);
  recordDraft(results, "b", { variant: "A", index: 1, path: "p1", jobId: "j", durationMs: 1, selectionHash: "h", instruction: "", itemNotes: {} });
  ensureRenders(results, "b").pickedDraftId = "d-0001";
  assert.equal(renderSource(results, "b").kind, "draft");
  recordConfirmed(results, "b", { variant: "A", fromDraftId: "d-0001", path: "p2", jobId: "j2", durationMs: 1, selectionHash: "h", instruction: "", itemNotes: {} });
  approveConfirmed(results, "b", "c-0001");
  assert.equal(renderSource(results, "b").kind, "confirm");
  approveConfirmed(results, "b", null);
  assert.equal(renderSource(results, "b").kind, "draft");
  assert.throws(() => approveConfirmed(results, "b", "c-0042"), (error) => error.status === 404);
});

test("runRenderJob renders N drafts sequentially, reporting progress and recording each as it lands", async (t) => {
  const { runDir, plan, results } = scratchRun();
  const boardId = plan.boards[0].id;
  const qualities = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    qualities.push(JSON.parse(init.body.get("payload")).quality);
    return Response.json({ ok: true, imageBase64: PNG.toString("base64"), mimeType: "image/png", jobId: `job-${qualities.length}` });
  });
  const progress = [];
  let persisted = 0;
  await runRenderJob(
    { jobId: "q1", boardId, kind: "draft", variant: "A", count: 2, instructionSnapshot: "airy", selectionHash: "h" },
    { plan, results, runDir, baseUrl: "https://w.example", accessHeaders: {}, apiKey: undefined, signal: new AbortController().signal, onProgress: (text) => progress.push(text), persist: async () => { persisted++; } },
  );
  assert.deepEqual(qualities, ["low", "low"]);
  assert.deepEqual(progress, ["1/2", "2/2"]);
  assert.equal(results.renders[boardId].drafts.length, 2);
  assert.equal(results.renders[boardId].drafts[1].instruction, "airy");
  assert.equal(persisted, 2);
  rmSync(runDir, { recursive: true, force: true });
});

test("runRenderJob confirm and final use the current source render and mirror into the legacy records", async (t) => {
  const { runDir, plan, results } = scratchRun();
  const boardId = plan.boards[0].id;
  const rel = await saveRenderImage(runDir, boardId, "draft", "d-0001", PNG.toString("base64"));
  recordDraft(results, boardId, { variant: "A", index: 1, path: rel, jobId: "j1", durationMs: 1, selectionHash: "h", instruction: "", itemNotes: {} });
  pickDraft(results, runDir, boardId, "d-0001");
  const seen = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const payload = JSON.parse(init.body.get("payload"));
    seen.push([payload.quality, payload.renderKind, init.body.getAll("image[]")[0].name]);
    return Response.json({ ok: true, imageBase64: PNG.toString("base64"), mimeType: "image/png", jobId: `job-${seen.length}`, libraryVisible: payload.renderKind === "final" });
  });
  const ctx = { plan, results, runDir, baseUrl: "https://w.example", accessHeaders: {}, signal: new AbortController().signal, onProgress: () => {}, persist: async () => {} };
  await runRenderJob({ jobId: "q2", boardId, kind: "confirm", instructionSnapshot: "", selectionHash: "h" }, ctx);
  assert.equal(results.renders[boardId].confirmed.length, 1);
  assert.ok(results.candidates[`${boardId}--A`].confirmedAt);
  approveConfirmed(results, boardId, "c-0001");
  await runRenderJob({ jobId: "q3", boardId, kind: "final", instructionSnapshot: "", selectionHash: "h" }, ctx);
  assert.deepEqual(seen, [["medium", "studio", "approved-draft.png"], ["high", "final", "approved-draft.png"]]);
  assert.equal(results.renders[boardId].finals[0].fromRenderId, "c-0001");
  assert.equal(results.renders[boardId].finals[0].libraryJobId, "job-2");
  assert.equal(results.finals[`${boardId}--A`].jobId, "job-2");
  rmSync(runDir, { recursive: true, force: true });
});

test("runRenderJob rejects confirm/final without a source and final with a stale source", async () => {
  const { runDir, plan, results } = scratchRun();
  const boardId = plan.boards[0].id;
  const ctx = { plan, results, runDir, baseUrl: "https://w.example", accessHeaders: {}, signal: new AbortController().signal, onProgress: () => {}, persist: async () => {} };
  await assert.rejects(runRenderJob({ jobId: "q", boardId, kind: "confirm", selectionHash: "h" }, ctx), /pick a draft/i);
  recordDraft(results, boardId, { variant: "A", index: 1, path: "x", jobId: "j", durationMs: 1, selectionHash: "old", instruction: "", itemNotes: {} });
  ensureRenders(results, boardId).pickedDraftId = "d-0001";
  await assert.rejects(runRenderJob({ jobId: "q", boardId, kind: "final", selectionHash: "new" }, ctx), /stale/i);
  rmSync(runDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --experimental-strip-types --test tests/autoboard-render.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `lib/render.mjs`**

```js
// scripts/autoboard/lib/render.mjs
// The render pipeline shared by the CLI (generate/redraft/confirm/finalize)
// and the review server's render queue: build the exact payload the app's
// /api/generate expects, post it, save the PNG, record the result.

import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { validateCollageRequest } from "../../app/lib/collage.ts";
import { AccessError, accessLoginHint, isAccessRejection } from "./access.mjs";
import { prepareReferenceForUpload } from "./transport.mjs";
import { boardPayload, boardReferenceFiles, orderedBoardItems } from "./variants.mjs";

// Approximate USD per image. Constants, labelled "~$" in the UI.
export const COST_PER_IMAGE = { draft: 0.016, confirm: 0.04, final: 0.19 };

export function estimateCost(kind, count = 1) {
  const unit = COST_PER_IMAGE[kind];
  if (unit === undefined) throw new Error(`Unknown render kind "${kind}".`);
  return Math.round(unit * count * 1000) / 1000;
}

export function formatCost(amount) {
  return `~$${amount.toFixed(2)}`;
}

// Hash of everything the model actually sees for this board: which images
// fill each slot, each slot's note, and the board instruction. Used for
// stale detection and revision bumps. Bookkeeping fields (overriddenAt,
// title, provenance, imageMeta) deliberately excluded.
export function selectionHash(board, instruction = "") {
  const material = {
    instruction: String(instruction ?? "").trim(),
    items: orderedBoardItems(board).map((item) => [item.slotId, item.images ?? [], String(item.note ?? "").trim()]),
  };
  return createHash("sha1").update(JSON.stringify(material)).digest("hex");
}

// The collage request has no board-level notes field (app/lib/collage.ts),
// only per-item notes, so the board instruction rides on the hero item —
// the first item in payload order — prefixed so the model can tell it apart
// from that item's own note. Returns a copy; never mutates the plan board.
export function boardForRender(board, instruction = "") {
  const heroSlotId = orderedBoardItems(board)[0]?.slotId;
  const cleanInstruction = String(instruction ?? "").trim();
  return {
    ...board,
    items: board.items.map((item) => {
      const parts = [String(item.note ?? "").trim()];
      if (cleanInstruction && item.slotId === heroSlotId) parts.push(`Board instruction: ${cleanInstruction}`);
      return { ...item, notes: parts.filter(Boolean).join(" ") };
    }),
  };
}

function finish(payload, files) {
  validateCollageRequest(payload);
  return { payload, files };
}

export function buildDraftPayload(board, variant, { apiKey, instruction, quality = "low", outputResolution = "standard" } = {}) {
  const prepared = boardForRender(board, instruction);
  return finish(boardPayload(prepared, variant, { quality, outputResolution, renderKind: "studio", apiKey }), boardReferenceFiles(prepared));
}

// The source render must be the FIRST multipart image; product references
// follow in item order (see app/api/generate/route.ts).
export function buildConfirmPayload(board, variant, sourcePath, { apiKey, instruction, quality = "medium", outputResolution = "standard" } = {}) {
  const prepared = boardForRender(board, instruction);
  const payload = boardPayload(prepared, variant, { quality, outputResolution, renderKind: "studio", layoutReference: true, apiKey });
  return finish(payload, [{ path: sourcePath, name: "approved-draft.png" }, ...boardReferenceFiles(prepared)]);
}

export function buildFinalPayload(board, variant, sourcePath, { apiKey, instruction, quality = "high" } = {}) {
  const prepared = boardForRender(board, instruction);
  const payload = boardPayload(prepared, variant, { quality, outputResolution: "final", renderKind: "final", layoutReference: true, apiKey });
  return finish(payload, [{ path: sourcePath, name: "approved-draft.png" }, ...boardReferenceFiles(prepared)]);
}

// ---------------------------------------------------------------------------
// Worker call. Library photos run 8 KB-3.7 MB / up to 4000 px, while the
// app's own browser upload path caps the long edge at 2048 — bring this path
// to parity instead of shipping raw bytes (transport.mjs).
// ---------------------------------------------------------------------------

export async function postGeneration(baseUrl, payload, files, { accessHeaders = {}, signal } = {}) {
  const form = new FormData();
  form.append("payload", JSON.stringify(payload));
  let resizedReferenceCount = 0;
  for (const file of files) {
    signal?.throwIfAborted();
    const prepared = await prepareReferenceForUpload(file.path);
    if (prepared.resized) resizedReferenceCount++;
    // Only the extension may change — the caller's "slotId--basename" stem is preserved.
    const stem = file.name.slice(0, file.name.length - path.extname(file.name).length);
    form.append("image[]", new Blob([prepared.bytes], { type: prepared.mime }), `${stem}${path.extname(prepared.filename)}`);
  }
  const response = await fetch(`${baseUrl}/api/generate`, { method: "POST", body: form, headers: accessHeaders, redirect: "manual", signal });
  if (isAccessRejection(response.status)) {
    throw new AccessError(
      `Cloudflare Access rejected the render request (HTTP ${response.status}) — the session may have expired. ${accessLoginHint(baseUrl)}`,
      "access-rejected",
      response.status,
    );
  }
  let json;
  try {
    json = await response.json();
  } catch {
    throw Object.assign(new Error(`Non-JSON response (HTTP ${response.status}) from ${baseUrl}/api/generate`), { status: response.status });
  }
  if (!response.ok || !json.ok) {
    throw Object.assign(new Error(json.error ?? json.message ?? `HTTP ${response.status}`), {
      status: response.status,
      code: json.code,
      retryAfterMs: typeof json.retryAfterMs === "number" ? json.retryAfterMs : undefined,
      diagnostics: json.diagnostics,
    });
  }
  json.resizedReferenceCount = resizedReferenceCount;
  return json;
}

// ---------------------------------------------------------------------------
// results.json `renders` records
// ---------------------------------------------------------------------------

export function ensureRenders(results, boardId) {
  results.renders ??= {};
  results.renders[boardId] ??= { instruction: "", pickedDraftId: null, approvedConfirmedId: null, drafts: [], confirmed: [], finals: [] };
  return results.renders[boardId];
}

const LIST_FOR_PREFIX = { d: "drafts", c: "confirmed", f: "finals" };
const DIR_FOR_KIND = { draft: "drafts", confirm: "confirmed", final: "finals" };

export function nextRenderId(renders, prefix) {
  return `${prefix}-${String(renders[LIST_FOR_PREFIX[prefix]].length + 1).padStart(4, "0")}`;
}

export function renderFilePath(runDir, boardId, kind, id) {
  return path.join(runDir, "boards", boardId, DIR_FOR_KIND[kind], `${id}.png`);
}

export async function saveRenderImage(runDir, boardId, kind, id, imageBase64) {
  const filePath = renderFilePath(runDir, boardId, kind, id);
  mkdirSync(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, Buffer.from(imageBase64, "base64"));
  return path.relative(runDir, filePath).split(path.sep).join("/");
}

function currentRevision(renders, hash) {
  const latest = renders.drafts.at(-1);
  if (!latest) return 1;
  return latest.selectionHash === hash ? latest.revision : latest.revision + 1;
}

export function recordDraft(results, boardId, record) {
  const renders = ensureRenders(results, boardId);
  const draft = { id: nextRenderId(renders, "d"), revision: currentRevision(renders, record.selectionHash), createdAt: new Date().toISOString(), ...record };
  renders.drafts.push(draft);
  return draft;
}

export function recordConfirmed(results, boardId, record) {
  const renders = ensureRenders(results, boardId);
  const confirmed = { id: nextRenderId(renders, "c"), createdAt: new Date().toISOString(), ...record };
  renders.confirmed.push(confirmed);
  return confirmed;
}

export function recordFinal(results, boardId, record) {
  const renders = ensureRenders(results, boardId);
  const final = { id: nextRenderId(renders, "f"), createdAt: new Date().toISOString(), ...record };
  renders.finals.push(final);
  return final;
}

function findRender(renders, list, id) {
  const record = renders[list].find((entry) => entry.id === id);
  if (!record) throw Object.assign(new Error(`No ${list} render "${id}".`), { status: 404 });
  return record;
}

// Picking mirrors the draft into the legacy candidate slot and the legacy
// file name so the CLI's confirm/finalize keep working on the same picture.
export function pickDraft(results, runDir, boardId, draftId, { appliedNotes = {} } = {}) {
  const renders = ensureRenders(results, boardId);
  const draft = findRender(renders, "drafts", draftId);
  renders.pickedDraftId = draftId;
  const legacyPath = path.join(runDir, "boards", boardId, `${draft.variant}.png`);
  const source = path.join(runDir, draft.path);
  if (source !== legacyPath) {
    mkdirSync(path.dirname(legacyPath), { recursive: true });
    copyFileSync(source, legacyPath);
  }
  results.candidates ??= {};
  const key = `${boardId}--${draft.variant}`;
  results.candidates[key] = {
    ...(results.candidates[key] ?? {}),
    status: "ok",
    savedPath: legacyPath,
    mimeType: "image/png",
    jobId: draft.jobId ?? null,
    renderKind: "studio",
    revision: draft.revision,
    appliedNotes,
    completedAt: draft.createdAt,
    durationMs: draft.durationMs,
    pickedDraftId: draftId,
  };
  return draft;
}

export function approveConfirmed(results, boardId, confirmedId) {
  const renders = ensureRenders(results, boardId);
  if (confirmedId !== null) findRender(renders, "confirmed", confirmedId);
  renders.approvedConfirmedId = confirmedId;
}

// Approved confirmed render wins as the layout source; otherwise the picked draft.
export function renderSource(results, boardId) {
  const renders = ensureRenders(results, boardId);
  if (renders.approvedConfirmedId) return { kind: "confirm", record: findRender(renders, "confirmed", renders.approvedConfirmedId) };
  if (renders.pickedDraftId) return { kind: "draft", record: findRender(renders, "drafts", renders.pickedDraftId) };
  return null;
}

// ---------------------------------------------------------------------------
// Job execution — one queue job = one board action (N drafts, or one confirm,
// or one final). Progress text is what the panel's status line shows.
// ---------------------------------------------------------------------------

function itemNotesOf(board) {
  return Object.fromEntries(board.items.filter((item) => String(item.note ?? "").trim()).map((item) => [item.slotId, String(item.note).trim()]));
}

export async function runRenderJob(job, ctx) {
  const { plan, results, runDir } = ctx;
  const board = plan.boards.find((entry) => entry.id === job.boardId);
  if (!board) throw Object.assign(new Error(`Unknown board "${job.boardId}".`), { status: 404 });
  const instruction = job.instructionSnapshot ?? ensureRenders(results, board.id).instruction ?? "";
  const itemNotes = itemNotesOf(board);
  const post = (payload, files) => postGeneration(ctx.baseUrl, payload, files, { accessHeaders: ctx.accessHeaders, signal: ctx.signal });
  const common = { selectionHash: job.selectionHash, instruction, itemNotes };

  if (job.kind === "draft") {
    const variant = plan.variants.find((entry) => entry.key === job.variant);
    if (!variant) throw Object.assign(new Error(`Unknown variant "${job.variant}".`), { status: 400 });
    const count = Math.max(1, Math.min(10, Number(job.count) || 1));
    const { payload, files } = buildDraftPayload(board, variant, { apiKey: ctx.apiKey, instruction });
    for (let index = 1; index <= count; index++) {
      ctx.signal?.throwIfAborted();
      const startedAt = Date.now();
      const json = await post(payload, files);
      const id = nextRenderId(ensureRenders(results, board.id), "d");
      const rel = await saveRenderImage(runDir, board.id, "draft", id, json.imageBase64);
      recordDraft(results, board.id, { variant: variant.key, index, path: rel, jobId: json.jobId ?? null, durationMs: Date.now() - startedAt, ...common });
      await ctx.persist();
      ctx.onProgress(`${index}/${count}`);
    }
    return;
  }

  const source = renderSource(results, board.id);
  if (!source) throw Object.assign(new Error("Pick a draft (or approve a confirmed render) before rendering this step."), { status: 400 });
  if (job.kind === "final" && source.record.selectionHash !== job.selectionHash) {
    throw Object.assign(new Error("The picked render is stale — the board's selection changed since it was rendered. Draft again first."), { status: 409 });
  }
  const variant = plan.variants.find((entry) => entry.key === source.record.variant);
  const sourcePath = path.join(runDir, source.record.path);
  const startedAt = Date.now();

  if (job.kind === "confirm") {
    const { payload, files } = buildConfirmPayload(board, variant, sourcePath, { apiKey: ctx.apiKey, instruction });
    const json = await post(payload, files);
    const id = nextRenderId(ensureRenders(results, board.id), "c");
    const rel = await saveRenderImage(runDir, board.id, "confirm", id, json.imageBase64);
    recordConfirmed(results, board.id, { variant: variant.key, fromDraftId: source.record.id, path: rel, jobId: json.jobId ?? null, durationMs: Date.now() - startedAt, ...common });
    const candidate = results.candidates?.[`${board.id}--${variant.key}`];
    if (candidate) Object.assign(candidate, { confirmedAt: new Date().toISOString(), quality: "medium" });
    await ctx.persist();
    ctx.onProgress("1/1");
    return;
  }

  if (job.kind === "final") {
    const { payload, files } = buildFinalPayload(board, variant, sourcePath, { apiKey: ctx.apiKey, instruction });
    const json = await post(payload, files);
    const id = nextRenderId(ensureRenders(results, board.id), "f");
    const rel = await saveRenderImage(runDir, board.id, "final", id, json.imageBase64);
    recordFinal(results, board.id, { variant: variant.key, fromRenderId: source.record.id, path: rel, jobId: json.jobId ?? null, libraryJobId: json.jobId ?? null, libraryVisible: json.libraryVisible ?? false, durationMs: Date.now() - startedAt, ...common });
    results.finals ??= {};
    results.finals[`${board.id}--${variant.key}`] = { jobId: json.jobId ?? null, savedPath: path.join(runDir, rel), libraryVisible: json.libraryVisible ?? false, notice: json.notice ?? null, appliedNoteSlotIds: Object.keys(itemNotes), completedAt: new Date().toISOString() };
    await ctx.persist();
    ctx.onProgress("1/1");
    return;
  }

  throw Object.assign(new Error(`Unknown render kind "${job.kind}".`), { status: 400 });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --experimental-strip-types --test tests/autoboard-render.test.mjs`
Expected: `ℹ pass 19`, `ℹ fail 0`. If "rejects a board the app would refuse" fails on the message, read what `validateCollageRequest` throws for zero items and match that text — do not loosen to `/./`.

- [ ] **Step 5: Commit**

```bash
git add scripts/autoboard/lib/render.mjs tests/autoboard-render.test.mjs
git commit -m "autoboard: add shared render pipeline (payloads, Worker POST, records, jobs)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `lib/render-queue.mjs` — sequential in-memory queue with cancel

**Files:**
- Create: `scripts/autoboard/lib/render-queue.mjs`
- Test: `tests/autoboard-render-queue.test.mjs`

**Interfaces (produces) — `class RenderQueue`:**
- `constructor({ execute })` — `execute(job, { signal, onProgress })` returns a Promise.
- `enqueue(fields) → { jobId, position }` — fields `{ boardId, kind, variant?, count?, instructionSnapshot, selectionHash }`; `position` is 1-based among queued+running.
- `cancel(jobId) → boolean`
- `snapshot() → Array<{ jobId, boardId, kind, variant, count, state, progress, error, createdAt, startedAt, finishedAt }>` with `state ∈ queued | running | done | failed | cancelled`.
- `idle → Promise<void>`

- [ ] **Step 1: Write the failing tests**

```js
// tests/autoboard-render-queue.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { RenderQueue } from "../scripts/autoboard/lib/render-queue.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));

function controllable() {
  const started = [];
  const resolvers = new Map();
  const execute = (job, { signal, onProgress }) => new Promise((resolve, reject) => {
    started.push(job.jobId);
    resolvers.set(job.jobId, { resolve, reject, onProgress });
    signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")));
  });
  return { execute, started, resolvers };
}

test("jobs run strictly one at a time in enqueue order", async () => {
  const { execute, started, resolvers } = controllable();
  const queue = new RenderQueue({ execute });
  const a = queue.enqueue({ boardId: "a", kind: "draft", variant: "A", count: 2 });
  const b = queue.enqueue({ boardId: "b", kind: "confirm" });
  assert.deepEqual([a.position, b.position], [1, 2]);
  await tick();
  assert.deepEqual(started, [a.jobId]);
  resolvers.get(a.jobId).onProgress("1/2");
  assert.equal(queue.snapshot()[0].progress, "1/2");
  resolvers.get(a.jobId).resolve();
  await tick(); await tick();
  assert.deepEqual(started, [a.jobId, b.jobId]);
  assert.equal(queue.snapshot()[0].state, "done");
  resolvers.get(b.jobId).resolve();
  await queue.idle;
  assert.equal(queue.snapshot()[1].state, "done");
});

test("a failure records the error fields and the queue moves on", async () => {
  const { execute, resolvers } = controllable();
  const queue = new RenderQueue({ execute });
  const a = queue.enqueue({ boardId: "a", kind: "draft", variant: "A", count: 1 });
  const b = queue.enqueue({ boardId: "b", kind: "draft", variant: "A", count: 1 });
  await tick();
  resolvers.get(a.jobId).reject(Object.assign(new Error("Busy"), { status: 429, retryAfterMs: 120000, code: "rate_limited" }));
  await tick(); await tick();
  const [ja, jb] = queue.snapshot();
  assert.equal(ja.state, "failed");
  assert.equal(ja.error.message, "Busy");
  assert.equal(ja.error.status, 429);
  assert.equal(ja.error.code, "rate_limited");
  assert.equal(ja.error.retryAfterMs, 120000);
  assert.equal(jb.state, "running");
  resolvers.get(b.jobId).resolve();
  await queue.idle;
});

test("cancel removes a queued job and aborts a running one, keeping its progress", async () => {
  const { execute, resolvers } = controllable();
  const queue = new RenderQueue({ execute });
  const a = queue.enqueue({ boardId: "a", kind: "draft", variant: "A", count: 3 });
  const b = queue.enqueue({ boardId: "b", kind: "draft", variant: "A", count: 1 });
  await tick();
  assert.equal(queue.cancel(b.jobId), true);
  assert.equal(queue.snapshot()[1].state, "cancelled");
  resolvers.get(a.jobId).onProgress("2/3");
  assert.equal(queue.cancel(a.jobId), true);
  await tick(); await tick();
  assert.equal(queue.snapshot()[0].state, "cancelled");
  assert.equal(queue.snapshot()[0].progress, "2/3");
  assert.equal(queue.cancel("nope"), false);
  assert.equal(queue.cancel(a.jobId), false);
  await queue.idle;
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --experimental-strip-types --test tests/autoboard-render-queue.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `lib/render-queue.mjs`**

```js
// scripts/autoboard/lib/render-queue.mjs
// In-memory FIFO for paid render jobs. Strictly one job runs at a time
// across every board; the review UI polls snapshot(). Nothing here retries:
// a failed job stays failed with its error, and the queue moves on. State
// lives only for the server's lifetime — render RECORDS are persisted by the
// job itself (results.json), so a restart loses nothing but the list.

import { randomUUID } from "node:crypto";

export class RenderQueue {
  #execute;
  #jobs = [];
  #controllers = new Map();
  #running = false;
  #idleResolvers = [];

  constructor({ execute }) {
    this.#execute = execute;
  }

  get idle() {
    if (!this.#running && !this.#jobs.some((job) => job.state === "queued")) return Promise.resolve();
    return new Promise((resolve) => this.#idleResolvers.push(resolve));
  }

  enqueue(fields) {
    const job = {
      jobId: `q-${randomUUID().slice(0, 8)}`,
      boardId: fields.boardId,
      kind: fields.kind,
      variant: fields.variant ?? null,
      count: fields.count ?? null,
      instructionSnapshot: fields.instructionSnapshot ?? "",
      selectionHash: fields.selectionHash ?? null,
      state: "queued",
      progress: null,
      error: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
    };
    this.#jobs.push(job);
    const position = this.#jobs.filter((entry) => entry.state === "queued" || entry.state === "running").length;
    queueMicrotask(() => this.#kick());
    return { jobId: job.jobId, position };
  }

  cancel(jobId) {
    const job = this.#jobs.find((entry) => entry.jobId === jobId);
    if (!job) return false;
    if (job.state === "queued") {
      job.state = "cancelled";
      job.finishedAt = new Date().toISOString();
      return true;
    }
    if (job.state === "running") {
      this.#controllers.get(jobId)?.abort(Object.assign(new Error("Cancelled by user."), { name: "AbortError" }));
      return true;
    }
    return false;
  }

  snapshot() {
    return this.#jobs.map((job) => ({ ...job }));
  }

  async #kick() {
    if (this.#running) return;
    const job = this.#jobs.find((entry) => entry.state === "queued");
    if (!job) {
      for (const resolve of this.#idleResolvers.splice(0)) resolve();
      return;
    }
    this.#running = true;
    const controller = new AbortController();
    this.#controllers.set(job.jobId, controller);
    job.state = "running";
    job.startedAt = new Date().toISOString();
    try {
      await this.#execute(job, { signal: controller.signal, onProgress: (text) => { job.progress = text; } });
      job.state = "done";
    } catch (error) {
      if (controller.signal.aborted) {
        job.state = "cancelled";
      } else {
        job.state = "failed";
        job.error = { message: error?.message ?? String(error), status: error?.status, code: error?.code, retryAfterMs: error?.retryAfterMs };
      }
    } finally {
      job.finishedAt = new Date().toISOString();
      this.#controllers.delete(job.jobId);
      this.#running = false;
      queueMicrotask(() => this.#kick());
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --experimental-strip-types --test tests/autoboard-render-queue.test.mjs`
Expected: `ℹ pass 3`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add scripts/autoboard/lib/render-queue.mjs tests/autoboard-render-queue.test.mjs
git commit -m "autoboard: add sequential in-memory RenderQueue with cancel

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Point the CLI at the shared library

**Files:**
- Modify: `scripts/autoboard/cli.mjs`

**Interfaces:** consumes `loadOpenAIKey`, `resolveAccessHeaders` from `./lib/access.mjs`; `postGeneration` from `./lib/render.mjs`.

- [ ] **Step 1: Replace the moved code**

1. Delete `import { execFileSync } from "node:child_process";`. Check `grep -n readFileSync scripts/autoboard/cli.mjs` — if the only use was `DEV_VARS`, drop `readFileSync` from the `node:fs` import too.
2. Delete from the comment `// Secrets and tokens resolve from the shell env first` through the end of `waitForServer` (removes `DEV_VARS`, `localVar`, `loadOpenAIKey`, `CLOUDFLARED_CANDIDATES`, `cloudflaredToken`, `accessHeaderCandidates`, `let activeAccessHeaders = {}`, `waitForServer`).
3. Delete the whole `postGeneration` function.
4. Add imports:

```js
import { loadOpenAIKey, resolveAccessHeaders } from "./lib/access.mjs";
import { postGeneration as postGenerationShared } from "./lib/render.mjs";
```

5. Where `waitForServer` was:

```js
// The credential set resolveAccessHeaders locked in for this run.
let activeAccessHeaders = {};

async function waitForServer(baseUrl) {
  const resolved = await resolveAccessHeaders(baseUrl, { log: (line) => console.log(line) });
  activeAccessHeaders = resolved.headers;
}

function postGeneration(baseUrl, payload, files) {
  return postGenerationShared(baseUrl, payload, files, { accessHeaders: activeAccessHeaders });
}
```

6. Replace `commandReview`:

```js
async function commandReview(values) {
  if (!values.run) throw new Error("Pass --run <run-id>.");
  const runDir = runDirFor(values.run);
  const planPath = path.join(runDir, "plan.json");
  if (!existsSync(planPath)) throw new Error(`${planPath} does not exist. Run \`plan\` first.`);
  const port = Number(values.port) || 4790;
  // Renders from the board go to the deployed Worker by default (it holds
  // the OpenAI key); pass --base-url http://localhost:3000 for a local dev
  // server, in which case OPENAI_API_KEY must be available locally.
  const baseUrl = (values["base-url"] ?? "https://material-collager.mlux-db1.workers.dev").replace(/\/+$/, "");
  await startReviewServer({ runDir, planPath, port, renderReviewPage, baseUrl, apiKey: loadOpenAIKey() });
  console.log(`Review UI running at http://127.0.0.1:${port} — open it in a browser.`);
  console.log(`Renders from the board go to ${baseUrl}. Changes save directly into plan.json / results.json. Press Ctrl+C to stop.`);
}
```

7. In `usage()`, replace the `review` entry:

```
  autoboard review   --run <run-id> [--port <n>] [--base-url <url>]
                     Local review board: pick items, draft, pick a draft, add
                     notes, confirm, final — renders go to --base-url
                     (default: the deployed Worker).
```

- [ ] **Step 2: Verify**

Run: `grep -nE "cloudflaredToken|accessHeaderCandidates|DEV_VARS|localVar\(" scripts/autoboard/cli.mjs` → no output.
Run: `node --check scripts/autoboard/cli.mjs` → no output.
Run: `npm run test:autoboard` → all passing (116 + 7 + 19 + 3 = 145).
Run: `npm run --silent autoboard -- generate --run run-20260906-033528 --boards penthouse-bath-4-fixture --dry-run --force` → `DRY RUN — 3 render call(s) …`, three lines, no QA line.

- [ ] **Step 3: Commit**

```bash
git add scripts/autoboard/cli.mjs
git commit -m "autoboard: CLI uses lib/access.mjs and lib/render.mjs; review takes --base-url

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Review server — notes import, render endpoints, queue wiring

**Files:**
- Modify: `scripts/autoboard/lib/review-server.mjs`
- Test: `tests/autoboard-review.test.mjs` (append)

**Interfaces:**
- `startReviewServer({ runDir, planPath, port, renderReviewPage, baseUrl = "http://localhost:3000", apiKey, resolveAccess = resolveAccessHeaders, executeJob = runRenderJob })` — new optional params; existing callers unaffected.
- Endpoints: `POST /api/instruction {boardId, instruction}`, `POST /api/item-note {boardId, slotId, note}`, `POST /api/pick-draft {boardId, draftId}`, `POST /api/approve-confirmed {boardId, confirmedId|null}`, `GET /render-image?path=<run-relative>`, `POST /api/render {boardId, kind, variant?, count?} → {jobId, position}`, `GET /api/render-status → {accessError, baseUrl, queue, renders, costs, selectionHashes}`, `POST /api/render-cancel {jobId} → {cancelled}`.
- `renders[boardId]` in status = the `results.renders` record with each draft/confirmed/final gaining `stale: boolean` and `url: "/render-image?path=…"`.
- Access resolution: at startup, and again on every `POST /api/render` while the last attempt failed (so a re-login is picked up by the next click).

- [ ] **Step 1: Write the failing tests (append to `tests/autoboard-review.test.mjs`)**

```js
import { ensureRenders, recordDraft } from "../scripts/autoboard/lib/render.mjs";

const PNG_BYTES = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

// Scratch run for the render endpoints: temp run dir, one-board plan.json,
// offline manifest + empty _BUILD_LOG.csv so startReviewServer's library
// load succeeds without touching the real library.
async function startScratchServer(extra = {}) {
  const runDir = mkdtempSync(path.join(tmpdir(), "autoboard-review-render-"));
  const libraryRoot = path.join(runDir, "library");
  mkdirSync(path.join(libraryRoot, "Tile", "tiles"), { recursive: true });
  writeFileSync(path.join(libraryRoot, "_BUILD_LOG.csv"), "row_id,sku,matched_files\n");
  writeFileSync(path.join(libraryRoot, "build_manifest_v2.csv"), "row_id,unit_type,room_type,cost_code,item_name,sku,qty,reference\n1,Penthouse,Bath 2,11 45 Plumbing,Hansgrohe Croma,S1,1,\n");
  const photo = path.join(libraryRoot, "faucet.png");
  writeFileSync(photo, PNG_BYTES);
  const boardId = "penthouse-bath-2-fixture";
  const plan = {
    runId: "run-test", source: "offline-manifest", libraryRoot,
    variants: [{ key: "A", composition: "editorial", density: "balanced", styling: "materials_only", lighting: "soft_daylight" }],
    boards: [{
      id: boardId, title: "Penthouse Bath 2 Fixture Collage", unitType: "Penthouse", roomLabel: "Bath 2", collageType: "bathroom_fixture_collage",
      items: [{ slotId: "vanity_faucet", role: "vanity faucet", required: true, rowId: "1", sku: "S1", brand: "Hansgrohe", name: "Croma", notes: "", images: [photo], imageMeta: [] }],
    }],
  };
  const planPath = path.join(runDir, "plan.json");
  writeFileSync(planPath, JSON.stringify(plan, null, 2));
  if (extra.notesJson) {
    mkdirSync(path.join(runDir, "boards", boardId), { recursive: true });
    writeFileSync(path.join(runDir, "boards", boardId, "notes.json"), JSON.stringify(extra.notesJson));
  }
  if (extra.results) writeFileSync(path.join(runDir, "results.json"), JSON.stringify(extra.results));
  const server = await startReviewServer({
    runDir, planPath, port: 0, renderReviewPage: () => "<html></html>",
    baseUrl: "https://w.example",
    resolveAccess: extra.resolveAccess ?? (async () => ({ headers: { "cf-access-token": "t" }, label: "test" })),
    executeJob: extra.executeJob ?? (async () => {}),
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (route, body) => { const r = await fetch(base + route, { method: "POST", body: JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };
  const get = async (route) => { const r = await fetch(base + route); const ct = r.headers.get("content-type") || ""; return { status: r.status, json: ct.includes("json") ? await r.json() : null, raw: r }; };
  const close = () => new Promise((resolve) => server.close(resolve));
  const results = () => JSON.parse(readFileSync(path.join(runDir, "results.json"), "utf8"));
  const planNow = () => JSON.parse(readFileSync(planPath, "utf8"));
  const cleanup = async () => { await close(); rmSync(runDir, { recursive: true, force: true }); };
  return { runDir, boardId, post, get, results, planNow, cleanup };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

test("server imports notes.json into item.note once and lets the UI clear it", async () => {
  const s = await startScratchServer({ notesJson: { items: [{ slotId: "vanity_faucet", note: "keep the handle" }] } });
  try {
    assert.equal(s.planNow().boards[0].items[0].note, "keep the handle");
    const r = await s.post("/api/item-note", { boardId: s.boardId, slotId: "vanity_faucet", note: "" });
    assert.equal(r.status, 200);
    assert.equal(s.planNow().boards[0].items[0].note, "");
  } finally { await s.cleanup(); }
});

test("POST /api/instruction and /api/item-note persist and validate", async () => {
  const s = await startScratchServer();
  try {
    let r = await s.post("/api/instruction", { boardId: s.boardId, instruction: "  more air  " });
    assert.equal(r.status, 200);
    assert.equal(s.results().renders[s.boardId].instruction, "more air");
    r = await s.post("/api/item-note", { boardId: s.boardId, slotId: "nope", note: "x" });
    assert.equal(r.status, 404);
    r = await s.post("/api/instruction", { boardId: s.boardId, instruction: "x".repeat(2001) });
    assert.equal(r.status, 400);
  } finally { await s.cleanup(); }
});

test("pick-draft, approve-confirmed and render-image work; path escapes are refused", async () => {
  const results = { candidates: {}, finals: {} };
  recordDraft(results, "penthouse-bath-2-fixture", { variant: "A", index: 1, path: "boards/penthouse-bath-2-fixture/drafts/d-0001.png", jobId: "j", durationMs: 1, selectionHash: "h", instruction: "", itemNotes: {} });
  const s = await startScratchServer({ results });
  try {
    mkdirSync(path.join(s.runDir, "boards", s.boardId, "drafts"), { recursive: true });
    writeFileSync(path.join(s.runDir, "boards", s.boardId, "drafts", "d-0001.png"), PNG_BYTES);
    let r = await s.post("/api/pick-draft", { boardId: s.boardId, draftId: "d-0001" });
    assert.equal(r.status, 200);
    assert.equal(s.results().renders[s.boardId].pickedDraftId, "d-0001");
    assert.equal(s.results().candidates[`${s.boardId}--A`].status, "ok");
    r = await s.post("/api/approve-confirmed", { boardId: s.boardId, confirmedId: "c-0009" });
    assert.equal(r.status, 404);
    r = await s.post("/api/approve-confirmed", { boardId: s.boardId, confirmedId: null });
    assert.equal(r.status, 200);
    const img = await s.get("/render-image?path=" + encodeURIComponent(`boards/${s.boardId}/drafts/d-0001.png`));
    assert.equal(img.status, 200);
    assert.equal(img.raw.headers.get("content-type"), "image/png");
    assert.equal((await s.get("/render-image?path=" + encodeURIComponent("../plan.json"))).status, 404);
  } finally { await s.cleanup(); }
});

test("POST /api/render validates and enqueues; status exposes queue, stale flags, costs", async () => {
  const calls = [];
  let release;
  const executeJob = (job, ctx) => new Promise((resolve) => { calls.push({ job, ctx }); release = resolve; ctx.onProgress("1/2"); });
  const s = await startScratchServer({ executeJob });
  try {
    assert.equal((await s.post("/api/render", { boardId: s.boardId, kind: "draft", variant: "Z", count: 2 })).status, 400);
    assert.equal((await s.post("/api/render", { boardId: s.boardId, kind: "draft", variant: "A", count: 11 })).status, 400);
    assert.equal((await s.post("/api/render", { boardId: s.boardId, kind: "confirm" })).status, 400);
    const r = await s.post("/api/render", { boardId: s.boardId, kind: "draft", variant: "A", count: 2 });
    assert.equal(r.status, 200);
    assert.equal(r.json.position, 1);
    await settle();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].job.kind, "draft");
    assert.equal(calls[0].ctx.baseUrl, "https://w.example");
    assert.deepEqual(calls[0].ctx.accessHeaders, { "cf-access-token": "t" });
    const status = (await s.get("/api/render-status")).json;
    assert.equal(status.accessError, null);
    assert.equal(status.queue[0].state, "running");
    assert.equal(status.queue[0].progress, "1/2");
    assert.equal(status.costs.draft, 0.016);
    assert.match(status.selectionHashes[s.boardId], /^[0-9a-f]{40}$/);
    release();
    await settle();
    assert.equal((await s.get("/api/render-status")).json.queue[0].state, "done");
  } finally { await s.cleanup(); }
});

test("render-status marks drafts stale when the selection hash moved, and cancel works", async () => {
  const results = { candidates: {}, finals: {} };
  recordDraft(results, "penthouse-bath-2-fixture", { variant: "A", index: 1, path: "boards/penthouse-bath-2-fixture/drafts/d-0001.png", jobId: "j", durationMs: 1, selectionHash: "old", instruction: "", itemNotes: {} });
  let release;
  const s = await startScratchServer({ results, executeJob: () => new Promise((resolve) => { release = resolve; }) });
  try {
    const draft = (await s.get("/api/render-status")).json.renders[s.boardId].drafts[0];
    assert.equal(draft.stale, true);
    assert.equal(draft.url, "/render-image?path=" + encodeURIComponent(`boards/${s.boardId}/drafts/d-0001.png`));
    await s.post("/api/render", { boardId: s.boardId, kind: "draft", variant: "A", count: 1 });
    const b = await s.post("/api/render", { boardId: s.boardId, kind: "draft", variant: "A", count: 1 });
    assert.equal(b.json.position, 2);
    assert.deepEqual((await s.post("/api/render-cancel", { jobId: b.json.jobId })).json, { cancelled: true });
    release();
    await settle();
    assert.deepEqual((await s.get("/api/render-status")).json.queue.map((job) => job.state), ["done", "cancelled"]);
  } finally { await s.cleanup(); }
});

test("an expired Access session is reported in status and re-resolved on the next render click", async () => {
  let attempts = 0;
  const resolveAccess = async () => {
    attempts++;
    if (attempts === 1) throw Object.assign(new Error("rejected — run cloudflared access login"), { code: "access-rejected", status: 302 });
    return { headers: { "cf-access-token": "fresh" }, label: "test" };
  };
  const seen = [];
  const s = await startScratchServer({ resolveAccess, executeJob: async (job, ctx) => { seen.push(ctx.accessHeaders); } });
  try {
    assert.match((await s.get("/api/render-status")).json.accessError, /rejected/);
    const r = await s.post("/api/render", { boardId: s.boardId, kind: "draft", variant: "A", count: 1 });
    assert.equal(r.status, 200);
    await settle();
    assert.equal((await s.get("/api/render-status")).json.accessError, null);
    assert.deepEqual(seen, [{ "cf-access-token": "fresh" }]);
    assert.equal(attempts, 2);
  } finally { await s.cleanup(); }
});
```

If the file does not already import `mkdtempSync`, `mkdirSync`, `readFileSync`, `rmSync`, `writeFileSync` from `node:fs`, `tmpdir` from `node:os` and `path`, add them (it does — see its first lines).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --experimental-strip-types --test tests/autoboard-review.test.mjs`
Expected: the six new tests FAIL.

- [ ] **Step 3: Implement**

Imports to add in `review-server.mjs`:

```js
import { readNoteOverrides } from "./notes.mjs";
import { resolveAccessHeaders } from "./access.mjs";
import { COST_PER_IMAGE, approveConfirmed, ensureRenders, pickDraft, runRenderJob, selectionHash } from "./render.mjs";
import { RenderQueue } from "./render-queue.mjs";
```

New signature and state (replace the first line of the function body):

```js
export async function startReviewServer({
  runDir, planPath, port, renderReviewPage,
  baseUrl = "http://localhost:3000", apiKey,
  resolveAccess = resolveAccessHeaders, executeJob = runRenderJob,
}) {
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  const resultsPath = path.join(runDir, "results.json");
  const results = existsSync(resultsPath) ? JSON.parse(await readFile(resultsPath, "utf8")) : { candidates: {}, finals: {} };
  results.renders ??= {};
  async function persistResults() {
    await writeFile(resultsPath, JSON.stringify(results, null, 2), "utf8");
  }
```

After `persistPlan` is defined, add the one-time notes import:

```js
  // One-time import of the legacy per-board notes.json into item.note. Only
  // items that have never had a note (undefined) are filled, so clearing a
  // note in the UI sticks across restarts.
  let importedNotes = false;
  for (const board of plan.boards) {
    const overrides = readNoteOverrides(runDir, board.id);
    for (const item of board.items) {
      if (item.note === undefined) {
        item.note = overrides.get(item.slotId) ?? "";
        importedNotes = true;
      }
    }
  }
  if (importedNotes) await persistPlan();

  // Access credentials: resolved once at startup and again on the next
  // render click after a failure, so a fresh `cloudflared access login` is
  // picked up without restarting the server. Headers never leave this closure.
  let access = { headers: {}, error: null };
  async function refreshAccess() {
    try {
      const resolved = await resolveAccess(baseUrl);
      access = { headers: resolved.headers, error: null };
    } catch (error) {
      access = { headers: {}, error: error.message };
    }
  }
  await refreshAccess();

  const queue = new RenderQueue({
    execute: (job, { signal, onProgress }) => executeJob(job, {
      plan, results, runDir, baseUrl, apiKey,
      accessHeaders: access.headers,
      signal, onProgress, persist: persistResults,
    }),
  });

  const boardsRoot = path.resolve(runDir, "boards");
  function renderImagePath(relative) {
    if (typeof relative !== "string" || !relative) return null;
    const resolved = path.resolve(runDir, relative);
    if (!resolved.startsWith(boardsRoot + path.sep)) return null;
    return existsSync(resolved) ? resolved : null;
  }

  const MAX_TEXT_CHARS = 2000;
  function cleanText(value, label) {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    if (text.length > MAX_TEXT_CHARS) throw Object.assign(new Error(`${label} must be under ${MAX_TEXT_CHARS} characters.`), { status: 400 });
    return text;
  }
  function findItem(board, slotId) {
    const item = board.items.find((entry) => entry.slotId === slotId);
    if (!item) throw Object.assign(new Error(`Board "${board.id}" has no slot "${slotId}".`), { status: 404 });
    return item;
  }

  const VARIANT_KEYS = new Set(plan.variants.map((variant) => variant.key));
  function validateRenderRequest({ boardId, kind, variant, count }) {
    const board = findBoard(boardId);
    if (!["draft", "confirm", "final"].includes(kind)) throw Object.assign(new Error(`Unknown render kind "${kind}".`), { status: 400 });
    const record = ensureRenders(results, board.id);
    if (kind === "draft") {
      if (!VARIANT_KEYS.has(variant)) throw Object.assign(new Error(`Pick a variant: ${[...VARIANT_KEYS].join(", ")}.`), { status: 400 });
      const n = Number(count);
      if (!Number.isInteger(n) || n < 1 || n > 10) throw Object.assign(new Error("Count must be a whole number from 1 to 10."), { status: 400 });
      return board;
    }
    const source = record.approvedConfirmedId
      ? record.confirmed.find((entry) => entry.id === record.approvedConfirmedId)
      : record.drafts.find((entry) => entry.id === record.pickedDraftId);
    if (!source) throw Object.assign(new Error("Pick a draft (or approve a confirmed render) first."), { status: 400 });
    if (kind === "final" && source.selectionHash !== selectionHash(board, record.instruction)) {
      throw Object.assign(new Error("The picked render is stale — the selection changed since it was rendered. Draft again first."), { status: 409 });
    }
    return board;
  }

  function renderStatus() {
    const renders = {};
    const selectionHashes = {};
    for (const board of plan.boards) {
      const record = ensureRenders(results, board.id);
      const currentHash = selectionHash(board, record.instruction);
      selectionHashes[board.id] = currentHash;
      const decorate = (entry) => ({ ...entry, stale: entry.selectionHash !== currentHash, url: `/render-image?path=${encodeURIComponent(entry.path)}` });
      renders[board.id] = { ...record, drafts: record.drafts.map(decorate), confirmed: record.confirmed.map(decorate), finals: record.finals.map(decorate) };
    }
    return { accessError: access.error, baseUrl, queue: queue.snapshot(), renders, costs: COST_PER_IMAGE, selectionHashes };
  }
```

Routes (inside the handler, before the final 404):

```js
      if (request.method === "GET" && url.pathname === "/render-image") {
        const filePath = renderImagePath(url.searchParams.get("path"));
        if (!filePath) { response.writeHead(404); response.end("Not found"); return; }
        response.writeHead(200, { "Content-Type": IMAGE_MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream", "Cache-Control": "private, max-age=3600" });
        createReadStream(filePath).pipe(response);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/render-status") {
        sendJson(response, 200, renderStatus());
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/instruction") {
        const { boardId, instruction } = JSON.parse(await readBody(request));
        const board = findBoard(boardId);
        ensureRenders(results, board.id).instruction = cleanText(instruction, "The board instruction");
        await persistResults();
        sendJson(response, 200, { instruction: ensureRenders(results, board.id).instruction });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/item-note") {
        const { boardId, slotId, note } = JSON.parse(await readBody(request));
        const board = findBoard(boardId);
        const item = findItem(board, slotId);
        item.note = cleanText(note, "An item note");
        await persistPlan();
        sendJson(response, 200, { item: serializeItem(item) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/pick-draft") {
        const { boardId, draftId } = JSON.parse(await readBody(request));
        const board = findBoard(boardId);
        const draft = pickDraft(results, runDir, board.id, draftId, { appliedNotes: Object.fromEntries(readNoteOverrides(runDir, board.id)) });
        await persistResults();
        sendJson(response, 200, { pickedDraftId: draft.id });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/approve-confirmed") {
        const { boardId, confirmedId } = JSON.parse(await readBody(request));
        const board = findBoard(boardId);
        approveConfirmed(results, board.id, confirmedId ?? null);
        await persistResults();
        sendJson(response, 200, { approvedConfirmedId: ensureRenders(results, board.id).approvedConfirmedId });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/render") {
        const body = JSON.parse(await readBody(request));
        const board = validateRenderRequest(body);
        if (access.error) await refreshAccess();
        const record = ensureRenders(results, board.id);
        const { jobId, position } = queue.enqueue({
          boardId: board.id, kind: body.kind, variant: body.variant ?? null,
          count: body.kind === "draft" ? Number(body.count) : null,
          instructionSnapshot: record.instruction, selectionHash: selectionHash(board, record.instruction),
        });
        sendJson(response, 200, { jobId, position, accessError: access.error });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/render-cancel") {
        const { jobId } = JSON.parse(await readBody(request));
        sendJson(response, 200, { cancelled: queue.cancel(jobId) });
        return;
      }
```

Check the handler's `catch` maps `error.status` to the HTTP status (`grep -n "error.status" scripts/autoboard/lib/review-server.mjs` — it already does for existing endpoints).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:autoboard`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add scripts/autoboard/lib/review-server.mjs tests/autoboard-review.test.mjs
git commit -m "autoboard review server: notes import, render queue endpoints, render images

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Review page — item note field, render panel, polling, lightbox

**Files:**
- Modify: `scripts/autoboard/lib/review-page.mjs`
- Test: `tests/autoboard-page.test.mjs` (new)

Remember: **no backticks and no `\"` inside the embedded script** — build strings with `+` and plain quotes only.

- [ ] **Step 1: Write the failing smoke test**

```js
// tests/autoboard-page.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import { renderReviewPage } from "../scripts/autoboard/lib/review-page.mjs";

test("review page parses as a whole file and contains the render panel wiring", () => {
  execFileSync(process.execPath, ["--check", "scripts/autoboard/lib/review-page.mjs"], { stdio: "pipe" });
  const html = renderReviewPage();
  for (const marker of ["render-panel", "/api/render-status", "/api/render-cancel", "/api/pick-draft", "/api/approve-confirmed", "/api/instruction", "/api/item-note", "id=\"lightbox\"", "data-action=\"draft\""]) {
    assert.ok(html.includes(marker), "page is missing " + marker);
  }
  const script = html.slice(html.indexOf("<script>"), html.indexOf("</script>"));
  assert.equal(script.includes("`"), false, "a backtick inside the embedded script would truncate the page");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --test tests/autoboard-page.test.mjs`
Expected: FAIL — `page is missing render-panel`.

- [ ] **Step 3: CSS** (append inside `<style>` after the `#status.show` rule)

```css
  .board-grid { display: grid; grid-template-columns: minmax(0, 3fr) minmax(320px, 2fr); gap: 1.25rem; align-items: start; }
  @media (max-width: 1000px) { .board-grid { grid-template-columns: 1fr; } }
  .slot-card textarea.note { width: 100%; margin-top: 0.4rem; font-size: 0.72rem; padding: 0.3rem; border: 1px solid var(--line); border-radius: 4px; resize: vertical; min-height: 2.2em; font-family: inherit; }
  .render-panel { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 0.8rem; position: sticky; top: 7rem; }
  .render-panel h3 { margin: 0 0 0.5rem; font-size: 0.8rem; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); }
  .render-controls { display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: center; margin-bottom: 0.5rem; }
  .variant-toggle button { padding: 0.25rem 0.55rem; }
  .variant-toggle button.active { background: var(--accent); color: #fff; border-color: var(--accent); }
  .render-controls input[type="number"] { width: 3.2rem; font-size: 0.75rem; padding: 0.25rem; border: 1px solid var(--line); border-radius: 4px; }
  .render-status { font-size: 0.75rem; color: var(--muted); min-height: 1.2em; margin-bottom: 0.6rem; }
  .render-status.error { color: var(--danger); }
  .render-strip h4 { margin: 0.6rem 0 0.3rem; font-size: 0.72rem; color: var(--muted); }
  .thumbs { display: flex; flex-wrap: wrap; gap: 0.45rem; }
  .thumb { position: relative; width: 120px; border: 2px solid var(--line); border-radius: 6px; overflow: hidden; background: #eee; }
  .thumb.picked { border-color: var(--accent); }
  .thumb img { width: 100%; height: 80px; object-fit: cover; display: block; cursor: zoom-in; }
  .thumb .badge { position: absolute; top: 3px; left: 3px; font-size: 0.62rem; background: rgba(0,0,0,0.65); color: #fff; padding: 0.05rem 0.3rem; border-radius: 3px; pointer-events: none; }
  .thumb .stale { position: absolute; top: 62px; left: 0; right: 0; font-size: 0.6rem; background: rgba(90,90,90,0.85); color: #fff; text-align: center; pointer-events: none; }
  .thumb .thumb-actions { display: flex; gap: 0.2rem; padding: 0.2rem; background: #fff; }
  .thumb .thumb-actions button, .thumb .thumb-actions a { font-size: 0.62rem; padding: 0.1rem 0.3rem; flex: 1; text-align: center; text-decoration: none; color: var(--ink); border: 1px solid var(--line); border-radius: 4px; background: #f5f5f2; }
  .thumb .thumb-actions button.on { background: var(--accent); color: #fff; border-color: var(--accent); }
  details.earlier summary { font-size: 0.72rem; color: var(--muted); cursor: pointer; margin-top: 0.4rem; }
  .render-panel textarea.instruction { width: 100%; margin-top: 0.6rem; font-size: 0.75rem; padding: 0.35rem; border: 1px solid var(--line); border-radius: 4px; resize: vertical; min-height: 2.4em; font-family: inherit; }
  .render-actions { display: flex; gap: 0.4rem; margin-top: 0.5rem; }
  .render-actions button[disabled] { opacity: 0.45; cursor: not-allowed; }
  #queue-badge { font-size: 0.72rem; color: var(--accent); margin-left: 0.6rem; font-weight: normal; }
  #lightbox { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.85); z-index: 30; align-items: center; justify-content: center; flex-direction: column; gap: 0.5rem; }
  #lightbox img { max-width: 94vw; max-height: 86vh; object-fit: contain; }
  #lightbox .caption { color: #fff; font-size: 0.8rem; }
```

- [ ] **Step 4: Markup**

Change the header `<h1>`:

```html
  <h1 id="run-title">Autoboard Review <span id="queue-badge"></span></h1>
```

Before `<div id="status"></div>`:

```html
<div id="lightbox"><img id="lightbox-img" alt=""><div class="caption" id="lightbox-caption"></div></div>
```

- [ ] **Step 5: Client state and panel** (inside `<script>`, after `let activeSlotId = null;`)

```js
let renderStatus = { accessError: null, baseUrl: "", queue: [], renders: {}, costs: { draft: 0, confirm: 0, final: 0 }, selectionHashes: {} };
let lastRenderJson = "";
const panelPrefs = {}; // boardId -> { variant, count }
let lightboxList = [];
let lightboxIndex = 0;

function money(kind, count) {
  return "~$" + (renderStatus.costs[kind] * (count || 1)).toFixed(2);
}

function prefsFor(boardId) {
  if (!panelPrefs[boardId]) panelPrefs[boardId] = { variant: "A", count: 3 };
  return panelPrefs[boardId];
}

function emptyRenders() {
  return { instruction: "", pickedDraftId: null, approvedConfirmedId: null, drafts: [], confirmed: [], finals: [] };
}

function boardJobs(boardId) {
  return renderStatus.queue.filter((job) => job.boardId === boardId);
}

function activeJob(boardId) {
  return boardJobs(boardId).find((job) => job.state === "running" || job.state === "queued") || null;
}

function statusLine(boardId) {
  const job = activeJob(boardId);
  if (job && job.state === "queued") {
    const ahead = renderStatus.queue.filter((entry) => (entry.state === "running" || entry.state === "queued") && entry.createdAt < job.createdAt).length;
    return { text: "queued (" + ahead + " ahead)", error: false };
  }
  if (job && job.state === "running") {
    const seconds = Math.max(0, Math.round((Date.now() - new Date(job.startedAt).getTime()) / 1000));
    return { text: "rendering " + job.kind + (job.progress ? " " + job.progress : "") + " \\u00b7 " + seconds + "s", error: false };
  }
  if (renderStatus.accessError) return { text: "Access session expired \\u2014 run: cloudflared access login " + renderStatus.baseUrl + " \\u2014 then click again", error: true };
  const last = boardJobs(boardId).slice(-1)[0];
  if (!last) return { text: "", error: false };
  if (last.state === "failed") {
    let text = "failed: " + (last.error && last.error.message ? last.error.message : "unknown error");
    if (last.error && last.error.retryAfterMs) {
      const wait = Math.ceil((new Date(last.finishedAt).getTime() + last.error.retryAfterMs - Date.now()) / 1000);
      if (wait > 0) text += " (retry after " + wait + "s)";
    }
    return { text: text, error: true };
  }
  if (last.state === "cancelled") return { text: "cancelled" + (last.progress ? " after " + last.progress : ""), error: false };
  if (last.state === "done") return { text: "done " + new Date(last.finishedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), error: false };
  return { text: "", error: false };
}

function renderThumb(board, entry, kind) {
  const record = renderStatus.renders[board.id] || emptyRenders();
  const hasNotes = Boolean(entry.instruction) || Object.keys(entry.itemNotes || {}).length > 0;
  const img = el("img", { src: entry.url, alt: entry.id, "data-action": "lightbox", "data-board": board.id, "data-kind": kind, "data-id": entry.id });
  const children = [img, el("span", { className: "badge", text: entry.variant + (kind === "draft" ? " " + entry.index : "") + (hasNotes ? " \\ud83d\\udcac" : "") })];
  if (entry.stale) children.push(el("span", { className: "stale", text: "stale" }));
  const actions = el("div", { className: "thumb-actions" });
  if (kind === "draft") {
    const picked = record.pickedDraftId === entry.id;
    actions.appendChild(el("button", { className: picked ? "on" : "", "data-action": "pick-draft", "data-board": board.id, "data-id": entry.id, text: picked ? "\\u2713 picked" : "pick" }));
  } else if (kind === "confirm") {
    const approved = record.approvedConfirmedId === entry.id;
    actions.appendChild(el("button", { className: approved ? "on" : "", "data-action": "approve", "data-board": board.id, "data-id": approved ? "" : entry.id, text: approved ? "\\u2713 approved" : "approve" }));
  } else if (entry.libraryJobId) {
    actions.appendChild(el("a", { href: renderStatus.baseUrl + "/library?job=" + encodeURIComponent(entry.libraryJobId), target: "_blank", rel: "noopener", text: "Library \\u2197" }));
  }
  const thumb = el("div", { className: "thumb" + (kind === "draft" && record.pickedDraftId === entry.id ? " picked" : ""), title: entry.instruction || "" }, children);
  thumb.appendChild(actions);
  return thumb;
}

function renderDraftStrip(board) {
  const record = renderStatus.renders[board.id] || emptyRenders();
  const drafts = record.drafts;
  const wrap = el("div", { className: "render-strip" });
  if (!drafts.length) { wrap.appendChild(el("h4", { text: "Drafts \\u2014 none yet" })); return wrap; }
  const latestRevision = drafts[drafts.length - 1].revision;
  const current = drafts.filter((entry) => entry.revision === latestRevision);
  const earlier = drafts.filter((entry) => entry.revision !== latestRevision).reverse();
  wrap.appendChild(el("h4", { text: "Drafts (rev " + latestRevision + ")" }));
  wrap.appendChild(el("div", { className: "thumbs" }, current.map((entry) => renderThumb(board, entry, "draft"))));
  if (earlier.length) {
    wrap.appendChild(el("details", { className: "earlier" }, [
      el("summary", { text: "earlier drafts (" + earlier.length + ")" }),
      el("div", { className: "thumbs" }, earlier.map((entry) => renderThumb(board, entry, "draft"))),
    ]));
  }
  return wrap;
}

function renderStrip(board, list, kind, label) {
  const wrap = el("div", { className: "render-strip" });
  wrap.appendChild(el("h4", { text: label + (list.length ? "" : " \\u2014 none yet") }));
  if (list.length) wrap.appendChild(el("div", { className: "thumbs" }, list.map((entry) => renderThumb(board, entry, kind))));
  return wrap;
}

function renderPanel(board) {
  const record = renderStatus.renders[board.id] || emptyRenders();
  const prefs = prefsFor(board.id);
  const job = activeJob(board.id);
  const panel = el("div", { className: "render-panel", "data-board": board.id });
  panel.appendChild(el("h3", { text: "Render" }));

  const toggle = el("span", { className: "variant-toggle" }, ["A", "B", "C"].map((key) =>
    el("button", { className: prefs.variant === key ? "active" : "", "data-action": "variant", "data-board": board.id, "data-variant": key, text: key })));
  const count = el("input", { type: "number", min: "1", max: "10", value: String(prefs.count), "data-action": "count", "data-board": board.id, title: "How many drafts of this variant" });
  const draftButton = el("button", { "data-action": "draft", "data-board": board.id, text: "Draft \\u00d7" + prefs.count + " \\u00b7 " + money("draft", prefs.count) });
  const controls = el("div", { className: "render-controls" }, [toggle, count, draftButton]);
  if (job) controls.appendChild(el("button", { "data-action": "cancel", "data-board": board.id, "data-job": job.jobId, text: "\\u23f9 cancel" }));
  panel.appendChild(controls);

  const line = statusLine(board.id);
  panel.appendChild(el("div", { className: "render-status" + (line.error ? " error" : ""), text: line.text }));

  panel.appendChild(renderDraftStrip(board));

  const instruction = el("textarea", { className: "instruction", placeholder: "Board instruction for the next render (e.g. more breathing room, tile lower-left)", "data-action": "instruction", "data-board": board.id });
  instruction.value = record.instruction || "";
  panel.appendChild(instruction);

  const hash = renderStatus.selectionHashes[board.id];
  const picked = record.drafts.find((entry) => entry.id === record.pickedDraftId) || null;
  const approved = record.confirmed.find((entry) => entry.id === record.approvedConfirmedId) || null;
  const source = approved || picked;
  const confirmButton = el("button", { "data-action": "confirm", "data-board": board.id, text: "Confirm \\u25b6 medium \\u00b7 " + money("confirm", 1) });
  if (!picked) { confirmButton.disabled = true; confirmButton.title = "Pick a draft first"; }
  const finalButton = el("button", { "data-action": "final", "data-board": board.id, text: "Final \\u25b6 high \\u2192 Library \\u00b7 " + money("final", 1) });
  if (!source) { finalButton.disabled = true; finalButton.title = "Pick a draft or approve a confirmed render first"; }
  else if (source.selectionHash !== hash) { finalButton.disabled = true; finalButton.title = "The picked render is stale: the selection changed since it was rendered. Draft again first."; }
  panel.appendChild(el("div", { className: "render-actions" }, [confirmButton, finalButton]));

  panel.appendChild(renderStrip(board, record.confirmed, "confirm", "Confirmed"));
  panel.appendChild(renderStrip(board, record.finals, "final", "Final"));
  return panel;
}
```

- [ ] **Step 6: Restructure `renderBoard`; add the note field to slot cards**

Replace `renderBoard`:

```js
function renderBoard(board) {
  const slots = el("div", { className: "slots" });
  board.items.forEach((item) => slots.appendChild(renderSlotCard(board, item)));
  const left = el("div", { className: "board-left" }, [renderHeroControl(board), slots, renderAddSlotPanel(board)]);
  const right = el("div", { className: "board-right" }, [renderPanel(board)]);
  return el("section", { className: "board", id: "board-" + board.id }, [
    el("h2", { text: board.title }),
    el("div", { className: "meta", text: board.collageType + " \\u00b7 " + board.items.length + " slot(s)" }),
    el("div", { className: "board-grid" }, [left, right]),
  ]);
}
```

In `renderSlotCard`, right after `body.appendChild(actions);`:

```js
  const note = el("textarea", { className: "note", placeholder: "Note for this item (used by the next render)", "data-action": "item-note", "data-board": board.id, "data-slot": item.slotId });
  note.value = item.note || "";
  body.appendChild(note);
```

- [ ] **Step 7: Polling, actions and lightbox** (append immediately before the final `loadPlan();` line, then change that line as shown at the end)

```js
async function postJson(route, body) {
  const response = await fetch(route, { method: "POST", body: JSON.stringify(body) });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error || ("HTTP " + response.status));
  return json;
}

function refreshPanel(boardId) {
  const board = plan.boards.find((entry) => entry.id === boardId);
  const existing = document.querySelector('.render-panel[data-board="' + boardId + '"]');
  if (!board || !existing) return;
  // Never yank the textarea out from under the user while they type.
  const active = document.activeElement;
  if (active && active.tagName === "TEXTAREA" && existing.contains(active)) return;
  existing.replaceWith(renderPanel(board));
}

function refreshQueueBadge() {
  const running = renderStatus.queue.find((job) => job.state === "running");
  const queued = renderStatus.queue.filter((job) => job.state === "queued").length;
  document.getElementById("queue-badge").textContent = running
    ? "Rendering: " + running.boardId + (queued ? " \\u00b7 " + queued + " queued" : "")
    : (queued ? queued + " queued" : "");
}

function applyRenderStatus(json) {
  const text = JSON.stringify(json);
  const changed = text !== lastRenderJson;
  lastRenderJson = text;
  renderStatus = json;
  refreshQueueBadge();
  plan.boards.forEach((board) => {
    const job = activeJob(board.id);
    if (changed || (job && job.state === "running")) refreshPanel(board.id);
  });
}

async function pollOnce() {
  const response = await fetch("/api/render-status");
  applyRenderStatus(await response.json());
}

async function pollRenderStatus() {
  try { await pollOnce(); } catch (error) { /* server unreachable mid-poll; next tick retries */ }
  const busy = renderStatus.queue.some((job) => job.state === "running" || job.state === "queued");
  setTimeout(pollRenderStatus, busy ? 2000 : 15000);
}

function openLightbox(boardId, kind, id) {
  const record = renderStatus.renders[boardId] || emptyRenders();
  const list = kind === "draft" ? record.drafts : kind === "confirm" ? record.confirmed : record.finals;
  lightboxList = list.map((entry) => ({ url: entry.url, caption: boardId + " \\u00b7 " + kind + " " + entry.id + " \\u00b7 variant " + entry.variant + (entry.instruction ? " \\u00b7 " + entry.instruction : "") }));
  lightboxIndex = Math.max(0, list.findIndex((entry) => entry.id === id));
  showLightbox();
}

function showLightbox() {
  const item = lightboxList[lightboxIndex];
  if (!item) return;
  document.getElementById("lightbox-img").src = item.url;
  document.getElementById("lightbox-caption").textContent = item.caption + "  (" + (lightboxIndex + 1) + "/" + lightboxList.length + ")";
  document.getElementById("lightbox").style.display = "flex";
}

function closeLightbox() { document.getElementById("lightbox").style.display = "none"; }

document.addEventListener("keydown", (event) => {
  if (document.getElementById("lightbox").style.display !== "flex") return;
  if (event.key === "Escape") closeLightbox();
  if (event.key === "ArrowRight" && lightboxIndex < lightboxList.length - 1) { lightboxIndex++; showLightbox(); }
  if (event.key === "ArrowLeft" && lightboxIndex > 0) { lightboxIndex--; showLightbox(); }
});

document.addEventListener("click", async (event) => {
  if (event.target.id === "lightbox" || event.target.id === "lightbox-img" || event.target.id === "lightbox-caption") { closeLightbox(); return; }
  const node = event.target.closest("[data-action]");
  if (!node) return;
  const action = node.getAttribute("data-action");
  const boardId = node.getAttribute("data-board");
  try {
    if (action === "variant") { prefsFor(boardId).variant = node.getAttribute("data-variant"); refreshPanel(boardId); }
    else if (action === "draft") {
      const prefs = prefsFor(boardId);
      const json = await postJson("/api/render", { boardId: boardId, kind: "draft", variant: prefs.variant, count: prefs.count });
      showStatus(json.accessError ? json.accessError : "Queued " + prefs.count + " draft(s) of " + prefs.variant, Boolean(json.accessError));
      await pollOnce();
    }
    else if (action === "confirm") { await postJson("/api/render", { boardId: boardId, kind: "confirm" }); showStatus("Queued confirm render"); await pollOnce(); }
    else if (action === "final") {
      const record = renderStatus.renders[boardId] || emptyRenders();
      const source = record.approvedConfirmedId ? "confirmed " + record.approvedConfirmedId : "draft " + record.pickedDraftId;
      if (!window.confirm("Render final at high quality, " + money("final", 1) + ", from " + source + "? It will appear in the site Library.")) return;
      await postJson("/api/render", { boardId: boardId, kind: "final" });
      showStatus("Queued final render");
      await pollOnce();
    }
    else if (action === "cancel") { await postJson("/api/render-cancel", { jobId: node.getAttribute("data-job") }); await pollOnce(); }
    else if (action === "pick-draft") { await postJson("/api/pick-draft", { boardId: boardId, draftId: node.getAttribute("data-id") }); await pollOnce(); }
    else if (action === "approve") { const id = node.getAttribute("data-id"); await postJson("/api/approve-confirmed", { boardId: boardId, confirmedId: id || null }); await pollOnce(); }
    else if (action === "lightbox") { openLightbox(boardId, node.getAttribute("data-kind"), node.getAttribute("data-id")); }
  } catch (error) {
    showStatus(error.message, true);
  }
});

document.addEventListener("change", (event) => {
  const node = event.target.closest("[data-action]");
  if (!node || node.getAttribute("data-action") !== "count") return;
  const boardId = node.getAttribute("data-board");
  prefsFor(boardId).count = Math.max(1, Math.min(10, Number(node.value) || 1));
  refreshPanel(boardId);
});

document.addEventListener("focusout", async (event) => {
  const node = event.target;
  if (!node || !node.getAttribute) return;
  const action = node.getAttribute("data-action");
  const boardId = node.getAttribute("data-board");
  try {
    if (action === "instruction") {
      await postJson("/api/instruction", { boardId: boardId, instruction: node.value });
      await pollOnce();
    } else if (action === "item-note") {
      const json = await postJson("/api/item-note", { boardId: boardId, slotId: node.getAttribute("data-slot"), note: node.value });
      const board = plan.boards.find((entry) => entry.id === boardId);
      const index = board.items.findIndex((entry) => entry.slotId === json.item.slotId);
      board.items[index] = json.item;
      await pollOnce();
    }
  } catch (error) {
    showStatus(error.message, true);
  }
});
```

Change the last statement of the script from `loadPlan();` to:

```js
loadPlan().then(() => pollRenderStatus());
```

The pre-existing click handler (change/reset/remove-slot/.option/modal) stays as is; the new one only handles the `data-action` values listed above.

- [ ] **Step 8: Whole-file syntax check and tests**

Run: `node --check scripts/autoboard/lib/review-page.mjs` → no output. If it fails, a backtick or `\"` is inside the script: `grep -n '\`' scripts/autoboard/lib/review-page.mjs` must list only the two template delimiters.
Run: `node --experimental-strip-types --test tests/autoboard-page.test.mjs` → `ℹ pass 1`.
Run: `npm run test:autoboard` → all passing.

- [ ] **Step 9: Browser check without paid renders**

Start against a base URL with nothing listening so any click fails harmlessly at Access resolution:

```bash
npm run autoboard -- review --run run-20260906-033528 --port 4199 --base-url http://localhost:9
```

Open `http://127.0.0.1:4199` in the Browser pane. Verify: each board shows the panel right of its slots; the status line shows the "No server responded" message; draft strips read "none yet" (legacy CLI drafts are not in `renders`); typing a board instruction and blurring writes `renders[boardId].instruction` into `results.json`; typing a slot note and blurring writes `item.note` into `plan.json`; the count field and A/B/C toggle update the Draft button label. Stop the server.

- [ ] **Step 10: Commit**

```bash
git add scripts/autoboard/lib/review-page.mjs tests/autoboard-page.test.mjs
git commit -m "autoboard review page: render panel (drafts/confirmed/final), notes, polling, lightbox

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: End-to-end check with one real draft, memory note

- [ ] **Step 1: Ask the user for a go-ahead for exactly one paid low-quality draft.** Do not proceed without it.

- [ ] **Step 2: Refresh Access if needed**

```bash
"C:\Program Files (x86)\cloudflared\cloudflared.exe" access login https://material-collager.mlux-db1.workers.dev
```

- [ ] **Step 3: Start the server against the deployed Worker and render one draft from the panel**

```bash
npm run autoboard -- review --run run-20260906-033528 --port 4173
```

On **Penthouse Bath 4 / Triplex Bath 3**: variant A, count 1, Draft. Expected within ~30 s: `queued (0 ahead)` → `rendering draft 1/1 · Ns` → `done HH:MM`; a thumbnail under "Drafts (rev 1)"; `results.json` gains `renders["penthouse-bath-4-fixture"].drafts[0]`; the PNG exists at `autoboard-runs/run-20260906-033528/boards/penthouse-bath-4-fixture/drafts/d-0001.png`. Click **pick** → `candidates["penthouse-bath-4-fixture--A"]` updates and `boards/penthouse-bath-4-fixture/A.png` is overwritten. Open the lightbox on the thumbnail; Esc closes it. Do **not** run Confirm or Final here.

- [ ] **Step 4: Confirm the CLI still agrees**

```bash
npm run --silent autoboard -- confirm --run run-20260906-033528 penthouse-bath-4-fixture--A --dry-run
```

Expected: one confirm render listed for revision 1 → 2, no errors.

- [ ] **Step 5: Update memory** — append to `C:\Users\cowey\.claude\projects\E--Games-Claude-Material-Collager-Website\memory\wieland-autoboard-pipeline.md`:

```
**Review board renders (2026-09-07):** `npm run autoboard -- review --run <id>` now drives the whole workflow from http://127.0.0.1:<port>: per-board render panel (variant A/B/C × count drafts at low/standard, pick, Confirm at medium, Final at high → Library), one in-memory server-side queue (`lib/render-queue.mjs`), shared pipeline in `lib/render.mjs`, Access via `lib/access.mjs`. Default --base-url is the deployed Worker. Render records live in results.json `renders[boardId]` (drafts/confirmed/finals with selectionHash for stale detection); picking a draft mirrors it into the legacy `candidates` slot so CLI confirm/finalize keep working. Per-item notes are `item.note` in plan.json (notes.json imported once, then ignored); the board instruction rides on the hero item's notes. The board never runs QA.
```

---

## Self-review against the spec (condensed)

- Prompt input both per-item and board-level → Task 5 endpoints, Task 6 fields, Task 2 `boardForRender`. ✔
- Variant A/B/C × count 1–10 → Task 5 validation, Task 2 `runRenderJob`, Task 6 controls. ✔
- Confirm optional; Final from picked draft or approved confirmed → Task 2 `renderSource`, Task 5 validation, Task 6 button enabling. ✔
- Single queue, live status, cancel → Task 3, Task 5, Task 6. (Held/resume and persistence removed by decision; expired Access → visible error, re-resolved on next click.) ✔
- Draft history with collapsed earlier revisions → Task 2 revisions, Task 6 `renderDraftStrip`. ✔
- Cost guard only on Final → Task 6 `window.confirm`. ✔
- Stale guard on Final only → Task 2, Task 5, Task 6. ✔
- No QA in the board (decision) → nothing calls `/api/qa`; CLI `--qa` untouched. ✔
- Lightbox kept → Task 6. ✔
- CLI compatibility → Task 2 `pickDraft` mirror, Task 4, Task 7 dry-run. ✔
- No tokens in payloads/logs → `renderStatus()` never includes `access.headers`. ✔
