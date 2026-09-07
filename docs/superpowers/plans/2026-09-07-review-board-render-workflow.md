# Review Board Render Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the whole autoboard workflow — draft, pick, note, confirm, final — from the local review board, with a live render panel beside every board.

**Architecture:** Extract the render pipeline out of `scripts/autoboard/cli.mjs` into `lib/access.mjs` (Cloudflare Access credentials), `lib/render.mjs` (payload builders, Worker POST, result recording, job execution) and `lib/render-queue.mjs` (sequential in-process queue with cancel/hold/resume). The review server owns one queue per run and exposes JSON endpoints; the page polls status and renders a panel per board. The CLI keeps every command but calls the same library functions.

**Tech Stack:** Node 24 (`node --experimental-strip-types`), `node:test`, `node:http`, `sharp` (already a dependency, via `lib/transport.mjs`), no framework, no new dependencies.

Spec: `docs/superpowers/specs/2026-09-07-review-board-render-workflow-design.md`.

## Global Constraints

- Drafts render at quality `low`, resolution `standard`; confirm at `medium` / `standard`; final at `high` / `final` with `renderKind: "final"`. Variants keep `soft_daylight` + `materials_only` (never change `DEFAULT_VARIANTS`).
- Automated QA is **opt-in** (`--qa` flag / panel checkbox, default off). Never enable it by default.
- One render at a time across all boards. Nothing auto-retries a failed paid render.
- Access tokens and the OpenAI key must never appear in logs, status payloads or test output.
- `scripts/autoboard/lib/review-page.mjs` is one template literal containing the client script: **no backticks and no escaped double quotes inside the embedded JS, including comments.** Run `node --check scripts/autoboard/lib/review-page.mjs` after every edit of that file.
- Every render call in tests is mocked (`t.mock.method(globalThis, "fetch", …)`); no test may hit the network or the deployed Worker.
- Never run `generate`/`redraft`/`confirm`/`finalize` against a real server during implementation except the single manual check in Task 9, and only with the user's go-ahead.
- Commit after every task with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` as the last line of the message.
- Test command for this area: `npm run test:autoboard` (runs `tests/autoboard-*.test.mjs`). Full suite: `node --experimental-strip-types --test tests/*.test.mjs`.

## Decisions fixed by this plan

- **Board instruction delivery.** `CollageRequestInput` (app/lib/collage.ts) has no board-level notes field, only per-item `notes`. The board instruction is therefore appended to the **hero item's** notes as `Board instruction: <text>` (the hero is `orderedBoardItems(board)[0]`, always first in the payload). Adding a request-level field to the app is a follow-up that needs a deploy; do not do it here.
- **Per-item notes** live on plan items as `item.note` (string, may be empty). `notes.json` is imported once when the server opens a run (only into items whose `note` is `undefined`), then ignored.
- **Render files:** `boards/<boardId>/drafts/<id>.png`, `boards/<boardId>/confirmed/<id>.png`, `boards/<boardId>/finals/<id>.png` under the run dir. Picking a draft also copies it to the legacy `boards/<boardId>/<variantKey>.png` and mirrors it into `results.candidates["<boardId>--<variantKey>"]` so the CLI's `finalize` still works.
- **Approximate costs** (USD per image, labelled `~$`): draft 0.016, confirm 0.04, final 0.19. Constants only.

## File Structure

| File | Responsibility |
|---|---|
| `scripts/autoboard/lib/access.mjs` (new) | `.dev.vars`/env lookup, `loadOpenAIKey`, Cloudflare Access credential candidates, `resolveAccessHeaders(baseUrl)` (moved from cli.mjs, no module-global state) |
| `scripts/autoboard/lib/render.mjs` (new) | `selectionHash`, cost table, `boardForRender`, `buildDraftPayload`/`buildConfirmPayload`/`buildFinalPayload`, `postGeneration`, `ensureRenders`, `saveRenderImage`, `recordDraft`/`recordConfirmed`/`recordFinal`, `pickDraft`, `approveConfirmed`, `runRenderJob` |
| `scripts/autoboard/lib/render-queue.mjs` (new) | `RenderQueue` — FIFO, progress, cancel, hold/resume, persistence hook, interrupted-on-restart |
| `scripts/autoboard/cli.mjs` (modify) | Import from `access.mjs`/`render.mjs`; delete the moved code; `review` gains `--base-url` default to the deployed Worker |
| `scripts/autoboard/lib/review-server.mjs` (modify) | notes.json import, new endpoints, queue wiring, render image serving |
| `scripts/autoboard/lib/review-page.mjs` (modify) | per-item note field, render panel, status polling, lightbox |
| `tests/autoboard-access.test.mjs` (new), `tests/autoboard-render.test.mjs` (new), `tests/autoboard-render-queue.test.mjs` (new), `tests/autoboard-review.test.mjs` (modify), `tests/autoboard-page.test.mjs` (new) | Tests |

---

### Task 1: `lib/access.mjs` — credentials and Access resolution without globals

**Files:**
- Create: `scripts/autoboard/lib/access.mjs`
- Test: `tests/autoboard-access.test.mjs`

**Interfaces:**
- Produces:
  - `localVar(name, { env = process.env, devVars = DEV_VARS } = {}) → string | undefined`
  - `loadOpenAIKey() → string | undefined`
  - `cloudflaredToken(baseUrl, { execFile = execFileSync } = {}) → string | undefined`
  - `accessHeaderCandidates(baseUrl, { env, devVars, tokenLookup = cloudflaredToken } = {}) → Array<{ label, headers }>`
  - `class AccessError extends Error { code: "access-rejected" | "unreachable"; status?: number }`
  - `resolveAccessHeaders(baseUrl, { fetchImpl = fetch, attempts = 10, sleepMs = 3000, log = () => {}, tokenLookup } = {}) → Promise<{ headers, label }>` — throws `AccessError`.
  - `isAccessRejection(status) → boolean` (302 or 403)

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

### Task 2: `lib/render.mjs` — hashing, costs and payload builders (pure)

**Files:**
- Create: `scripts/autoboard/lib/render.mjs`
- Test: `tests/autoboard-render.test.mjs`

**Interfaces:**
- Consumes: `boardPayload`, `boardReferenceFiles`, `orderedBoardItems` from `./variants.mjs`; `validateCollageRequest` from `../../app/lib/collage.ts`.
- Produces:
  - `COST_PER_IMAGE = { draft: 0.016, confirm: 0.04, final: 0.19 }`
  - `estimateCost(kind, count = 1) → number`; `formatCost(amount) → "~$0.05"`
  - `selectionHash(board, instruction = "") → string` (sha1 hex)
  - `boardForRender(board, instruction = "") → board copy whose items carry \`notes\` built from \`item.note\` (+ hero gets "Board instruction: …")`
  - `buildDraftPayload(board, variant, { apiKey, instruction, quality = "low", outputResolution = "standard" } = {}) → { payload, files }`
  - `buildConfirmPayload(board, variant, sourcePath, { apiKey, instruction, quality = "medium", outputResolution = "standard" } = {}) → { payload, files }`
  - `buildFinalPayload(board, variant, sourcePath, { apiKey, instruction, quality = "high" } = {}) → { payload, files }`

- [ ] **Step 1: Write the failing tests**

```js
// tests/autoboard-render.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  boardForRender,
  buildConfirmPayload,
  buildDraftPayload,
  buildFinalPayload,
  estimateCost,
  formatCost,
  selectionHash,
} from "../scripts/autoboard/lib/render.mjs";
import { DEFAULT_VARIANTS } from "../scripts/autoboard/lib/variants.mjs";

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
const A = DEFAULT_VARIANTS[0];

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
  // Fields the model never sees do not affect the hash.
  const relabelled = board();
  relabelled.items[0].overriddenAt = "2026-09-07T00:00:00Z";
  relabelled.title = "Renamed";
  assert.equal(selectionHash(relabelled), base);
});

test("boardForRender turns item.note into model notes and pins the board instruction on the hero item", () => {
  const prepared = boardForRender(board(), "more breathing room");
  const faucet = prepared.items.find((item) => item.slotId === "vanity_faucet"); // hero for bathroom_fixture_collage
  const tile = prepared.items.find((item) => item.slotId === "main_tile");
  assert.equal(faucet.notes, "Board instruction: more breathing room");
  assert.equal(tile.notes, "keep the terrazzo chips visible");
  // The input board is not mutated.
  assert.equal(board().items[0].notes, "");
});

test("boardForRender joins an existing item note and the instruction on the hero", () => {
  const source = board();
  source.items[0].note = "do not mirror";
  const prepared = boardForRender(source, "tile lower-left");
  assert.equal(prepared.items[0].notes, "do not mirror Board instruction: tile lower-left");
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

test("buildConfirmPayload is medium quality and puts the source draft first as the approved-draft layout reference", () => {
  const { payload, files } = buildConfirmPayload(board(), A, "E:/run/boards/b/drafts/d-0001.png", {});
  assert.equal(payload.quality, "medium");
  assert.equal(payload.outputResolution, "standard");
  assert.equal(payload.renderKind, "studio");
  assert.equal(payload.layoutReference, true);
  assert.equal(payload.layoutReferenceMode, "approved-draft");
  assert.deepEqual(files[0], { path: "E:/run/boards/b/drafts/d-0001.png", name: "approved-draft.png" });
  assert.equal(files.length, 3);
});

test("buildFinalPayload is high/final, library-visible, with the source render as layout reference", () => {
  const { payload, files } = buildFinalPayload(board(), A, "E:/run/boards/b/confirmed/c-0001.png", {});
  assert.equal(payload.quality, "high");
  assert.equal(payload.outputResolution, "final");
  assert.equal(payload.renderKind, "final");
  assert.equal(payload.layoutReference, true);
  assert.equal(files[0].name, "approved-draft.png");
});

test("payload builders reject a board the app would refuse", () => {
  const empty = board({ items: [] });
  assert.throws(() => buildDraftPayload(empty, A), /at least|item/i);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --experimental-strip-types --test tests/autoboard-render.test.mjs`
Expected: FAIL — `Cannot find module '.../lib/render.mjs'`.

- [ ] **Step 3: Write the pure half of `lib/render.mjs`**

```js
// scripts/autoboard/lib/render.mjs
// The render pipeline shared by the CLI (generate/redraft/confirm/finalize)
// and the review server's render queue: build the exact payload the app's
// /api/generate expects, post it, save the PNG, record the result. Pure
// functions except postGeneration/saveRenderImage/runRenderJob.

import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { validateCollageRequest } from "../../app/lib/collage.ts";
import { isAccessRejection, AccessError, accessLoginHint } from "./access.mjs";
import { boardPayload, boardReferenceFiles, orderedBoardItems } from "./variants.mjs";
import { prepareReferenceForUpload } from "./transport.mjs";
import { buildQaRequest, runQa } from "./qa-client.mjs";

// Approximate USD per image. Constants, clearly labelled "~$" in the UI; no
// live pricing lookup.
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
  const ordered = orderedBoardItems(board);
  const heroSlotId = ordered[0]?.slotId;
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
  const payload = boardPayload(prepared, variant, { quality, outputResolution, renderKind: "studio", apiKey });
  return finish(payload, boardReferenceFiles(prepared));
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
```

(The imports of `copyFileSync`, `mkdirSync`, `writeFile`, `path`, `isAccessRejection`, `AccessError`, `accessLoginHint`, `prepareReferenceForUpload`, `buildQaRequest`, `runQa` are used by Task 3; leave them in place now so Task 3 only appends.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --experimental-strip-types --test tests/autoboard-render.test.mjs`
Expected: `ℹ pass 8`, `ℹ fail 0`. If the "rejects an empty board" test fails on the message, read the message `validateCollageRequest` throws for zero items and adjust the regex to match it — do not loosen to `/./`.

- [ ] **Step 5: Commit**

```bash
git add scripts/autoboard/lib/render.mjs tests/autoboard-render.test.mjs
git commit -m "autoboard: add render payload builders, selection hash and cost table

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `lib/render.mjs` — Worker POST, saving, recording, job execution

**Files:**
- Modify: `scripts/autoboard/lib/render.mjs` (append)
- Test: `tests/autoboard-render.test.mjs` (append)

**Interfaces:**
- Produces:
  - `postGeneration(baseUrl, payload, files, { accessHeaders = {}, signal } = {}) → Promise<json>` — throws `Error` with `.status`, `.retryAfterMs`, `.code`, `.diagnostics`; throws `AccessError("access-rejected")` on 302/403.
  - `ensureRenders(results, boardId) → { instruction, pickedDraftId, approvedConfirmedId, drafts, confirmed, finals }`
  - `nextRenderId(renders, prefix) → "d-0001"` (prefix `d`/`c`/`f`)
  - `renderFilePath(runDir, boardId, kind, id) → absolute path` (kind: `"draft"|"confirm"|"final"` → dir `drafts|confirmed|finals`)
  - `saveRenderImage(runDir, boardId, kind, id, imageBase64) → Promise<relativePath>` (relative to runDir, forward slashes)
  - `recordDraft(results, boardId, { variant, path, jobId, durationMs, selectionHash, instruction, itemNotes, qa, index }) → draft`
  - `recordConfirmed(results, boardId, record) → record`; `recordFinal(results, boardId, record) → record`
  - `pickDraft(results, runDir, boardId, draftId, { appliedNotes = {} } = {}) → draft` (mirrors into `candidates`, copies PNG to legacy path)
  - `approveConfirmed(results, boardId, confirmedId | null)`
  - `renderSource(results, boardId) → { kind: "confirm"|"draft", record } | null` (approved confirmed wins, else picked draft)
  - `runRenderJob(job, ctx) → Promise<void>` where `job = { jobId, boardId, kind, variant?, count?, qa?, instructionSnapshot, selectionHash }` and `ctx = { plan, results, runDir, baseUrl, accessHeaders, apiKey, signal, onProgress(text), persist() }`.

- [ ] **Step 1: Write the failing tests (append to `tests/autoboard-render.test.mjs`)**

```js
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  approveConfirmed,
  ensureRenders,
  nextRenderId,
  pickDraft,
  postGeneration,
  recordConfirmed,
  recordDraft,
  renderSource,
  runRenderJob,
  saveRenderImage,
} from "../scripts/autoboard/lib/render.mjs";
import { AccessError } from "../scripts/autoboard/lib/access.mjs";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

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

test("postGeneration posts multipart with Access headers and returns the JSON body", async (t) => {
  let received;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    received = { url, headers: init.headers, payload: JSON.parse(init.body.get("payload")), images: init.body.getAll("image[]").length };
    return Response.json({ ok: true, imageBase64: PNG.toString("base64"), mimeType: "image/png", jobId: "job-1" });
  });
  const { runDir } = scratchRun();
  const json = await postGeneration("https://w.example", { collageType: "x" }, [{ path: path.join(runDir, "lib", "faucet.png"), name: "vanity_faucet--faucet.png" }], { accessHeaders: { "cf-access-token": "t" } });
  assert.equal(received.url, "https://w.example/api/generate");
  assert.equal(received.headers["cf-access-token"], "t");
  assert.equal(received.images, 1);
  assert.equal(json.jobId, "job-1");
  assert.equal(json.resizedReferenceCount, 0);
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

test("ensureRenders creates the per-board record once and nextRenderId zero-pads across kinds", () => {
  const results = { candidates: {}, finals: {} };
  const renders = ensureRenders(results, "b");
  assert.deepEqual(renders, { instruction: "", pickedDraftId: null, approvedConfirmedId: null, drafts: [], confirmed: [], finals: [] });
  assert.equal(ensureRenders(results, "b"), renders);
  assert.equal(nextRenderId(renders, "d"), "d-0001");
  renders.drafts.push({ id: "d-0001" }, { id: "d-0002" });
  assert.equal(nextRenderId(renders, "d"), "d-0003");
  assert.equal(nextRenderId(renders, "c"), "c-0001");
});

test("saveRenderImage writes under boards/<board>/<kind>s and returns a run-relative forward-slash path", async () => {
  const { runDir } = scratchRun();
  const rel = await saveRenderImage(runDir, "b", "draft", "d-0001", PNG.toString("base64"));
  assert.equal(rel, "boards/b/drafts/d-0001.png");
  assert.ok(existsSync(path.join(runDir, "boards", "b", "drafts", "d-0001.png")));
  assert.equal(await saveRenderImage(runDir, "b", "confirm", "c-0001", PNG.toString("base64")), "boards/b/confirmed/c-0001.png");
  assert.equal(await saveRenderImage(runDir, "b", "final", "f-0001", PNG.toString("base64")), "boards/b/finals/f-0001.png");
  rmSync(runDir, { recursive: true, force: true });
});

test("recordDraft bumps the revision only when the selection hash changes and numbers drafts within a batch", () => {
  const results = { candidates: {}, finals: {} };
  const first = recordDraft(results, "b", { variant: "A", path: "boards/b/drafts/d-0001.png", jobId: "j1", durationMs: 1, selectionHash: "h1", instruction: "", itemNotes: {}, qa: null, index: 1 });
  const second = recordDraft(results, "b", { variant: "A", path: "boards/b/drafts/d-0002.png", jobId: "j2", durationMs: 1, selectionHash: "h1", instruction: "", itemNotes: {}, qa: null, index: 2 });
  const third = recordDraft(results, "b", { variant: "B", path: "boards/b/drafts/d-0003.png", jobId: "j3", durationMs: 1, selectionHash: "h2", instruction: "", itemNotes: {}, qa: null, index: 1 });
  assert.equal(first.id, "d-0001");
  assert.equal(first.revision, 1);
  assert.equal(second.revision, 1);
  assert.equal(third.revision, 2);
  assert.ok(third.createdAt);
});

test("pickDraft mirrors the draft into the legacy candidate and copies the PNG to boards/<board>/<variant>.png", async () => {
  const { runDir, results } = scratchRun();
  const rel = await saveRenderImage(runDir, "penthouse-bath-2-fixture", "draft", "d-0001", PNG.toString("base64"));
  recordDraft(results, "penthouse-bath-2-fixture", { variant: "A", path: rel, jobId: "j1", durationMs: 1, selectionHash: "h", instruction: "", itemNotes: {}, qa: null, index: 1 });
  const picked = pickDraft(results, runDir, "penthouse-bath-2-fixture", "d-0001", { appliedNotes: { main_tile: "x" } });
  assert.equal(picked.id, "d-0001");
  assert.equal(results.renders["penthouse-bath-2-fixture"].pickedDraftId, "d-0001");
  const candidate = results.candidates["penthouse-bath-2-fixture--A"];
  assert.equal(candidate.status, "ok");
  assert.equal(candidate.renderKind, "studio");
  assert.equal(candidate.jobId, "j1");
  assert.deepEqual(candidate.appliedNotes, { main_tile: "x" });
  assert.equal(candidate.savedPath, path.join(runDir, "boards", "penthouse-bath-2-fixture", "A.png"));
  assert.ok(existsSync(candidate.savedPath));
  assert.throws(() => pickDraft(results, runDir, "penthouse-bath-2-fixture", "d-9999"), (error) => error.status === 404);
  rmSync(runDir, { recursive: true, force: true });
});

test("renderSource prefers an approved confirmed render over the picked draft", () => {
  const results = { candidates: {}, finals: {} };
  assert.equal(renderSource(results, "b"), null);
  recordDraft(results, "b", { variant: "A", path: "p1", jobId: "j", durationMs: 1, selectionHash: "h", instruction: "", itemNotes: {}, qa: null, index: 1 });
  ensureRenders(results, "b").pickedDraftId = "d-0001";
  assert.equal(renderSource(results, "b").kind, "draft");
  recordConfirmed(results, "b", { variant: "A", fromDraftId: "d-0001", path: "p2", jobId: "j2", durationMs: 1, selectionHash: "h", instruction: "", itemNotes: {}, qa: null });
  approveConfirmed(results, "b", "c-0001");
  assert.equal(renderSource(results, "b").kind, "confirm");
  approveConfirmed(results, "b", null);
  assert.equal(renderSource(results, "b").kind, "draft");
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
    { jobId: "q1", boardId, kind: "draft", variant: "A", count: 2, qa: false, instructionSnapshot: "airy", selectionHash: "h" },
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
  recordDraft(results, boardId, { variant: "A", path: rel, jobId: "j1", durationMs: 1, selectionHash: "h", instruction: "", itemNotes: {}, qa: null, index: 1 });
  pickDraft(results, runDir, boardId, "d-0001");
  const seen = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const payload = JSON.parse(init.body.get("payload"));
    seen.push({ quality: payload.quality, renderKind: payload.renderKind, first: init.body.getAll("image[]")[0].name });
    return Response.json({ ok: true, imageBase64: PNG.toString("base64"), mimeType: "image/png", jobId: `job-${seen.length}`, libraryVisible: payload.renderKind === "final" });
  });
  const ctx = { plan, results, runDir, baseUrl: "https://w.example", accessHeaders: {}, signal: new AbortController().signal, onProgress: () => {}, persist: async () => {} };
  await runRenderJob({ jobId: "q2", boardId, kind: "confirm", instructionSnapshot: "", selectionHash: "h" }, ctx);
  assert.equal(results.renders[boardId].confirmed.length, 1);
  assert.equal(results.candidates[`${boardId}--A`].confirmedAt !== undefined, true);
  approveConfirmed(results, boardId, "c-0001");
  await runRenderJob({ jobId: "q3", boardId, kind: "final", instructionSnapshot: "", selectionHash: "h" }, ctx);
  assert.deepEqual(seen.map((s) => [s.quality, s.renderKind, s.first]), [["medium", "studio", "approved-draft.png"], ["high", "final", "approved-draft.png"]]);
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
  recordDraft(results, boardId, { variant: "A", path: "x", jobId: "j", durationMs: 1, selectionHash: "old", instruction: "", itemNotes: {}, qa: null, index: 1 });
  ensureRenders(results, boardId).pickedDraftId = "d-0001";
  await assert.rejects(runRenderJob({ jobId: "q", boardId, kind: "final", selectionHash: "new" }, ctx), /stale/i);
  rmSync(runDir, { recursive: true, force: true });
});
```

Add `import { mkdirSync } from "node:fs";` alongside the other fs imports at the top of the test file (merge into the existing `node:fs` import).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --experimental-strip-types --test tests/autoboard-render.test.mjs`
Expected: FAIL — `postGeneration` etc. are not exported.

- [ ] **Step 3: Append the impure half to `lib/render.mjs`**

```js
// ---------------------------------------------------------------------------
// Worker call
// ---------------------------------------------------------------------------

// Library photos run 8 KB-3.7 MB / up to 4000 px, while the app's own browser
// upload path already caps the long edge at 2048 — bring this path to parity
// instead of shipping raw bytes (transport.mjs).
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
  const response = await fetch(`${baseUrl}/api/generate`, {
    method: "POST",
    body: form,
    headers: accessHeaders,
    redirect: "manual",
    signal,
  });
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

export function nextRenderId(renders, prefix) {
  const list = renders[LIST_FOR_PREFIX[prefix]];
  return `${prefix}-${String(list.length + 1).padStart(4, "0")}`;
}

const DIR_FOR_KIND = { draft: "drafts", confirm: "confirmed", final: "finals" };

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
  const draft = {
    id: nextRenderId(renders, "d"),
    revision: currentRevision(renders, record.selectionHash),
    createdAt: new Date().toISOString(),
    ...record,
  };
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
  results.candidates[`${boardId}--${draft.variant}`] = {
    ...(results.candidates[`${boardId}--${draft.variant}`] ?? {}),
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

async function optionalQa({ job, ctx, payload, referenceFiles, savedPath, jobId }) {
  if (!job.qa) return null;
  try {
    const request = await buildQaRequest({ payload, referenceFiles, outputPath: savedPath, jobId });
    const { qa } = await runQa(ctx.baseUrl, ctx.accessHeaders, request);
    return { model: qa.model, checkedAt: qa.checkedAt, flagCount: qa.flagCount, summary: qa.summary, items: qa.items, extraObjects: qa.extraObjects };
  } catch {
    return null; // QA must never fail a render
  }
}

export async function runRenderJob(job, ctx) {
  const { plan, results, runDir } = ctx;
  const board = plan.boards.find((entry) => entry.id === job.boardId);
  if (!board) throw Object.assign(new Error(`Unknown board "${job.boardId}".`), { status: 404 });
  const instruction = job.instructionSnapshot ?? ensureRenders(results, board.id).instruction ?? "";
  const itemNotes = itemNotesOf(board);
  const post = (payload, files) => postGeneration(ctx.baseUrl, payload, files, { accessHeaders: ctx.accessHeaders, signal: ctx.signal });

  if (job.kind === "draft") {
    const variant = plan.variants.find((entry) => entry.key === job.variant);
    if (!variant) throw Object.assign(new Error(`Unknown variant "${job.variant}".`), { status: 400 });
    const count = Math.max(1, Math.min(10, Number(job.count) || 1));
    const { payload, files } = buildDraftPayload(board, variant, { apiKey: ctx.apiKey, instruction });
    for (let index = 1; index <= count; index++) {
      ctx.signal?.throwIfAborted();
      const startedAt = Date.now();
      const json = await post(payload, files);
      const renders = ensureRenders(results, board.id);
      const id = nextRenderId(renders, "d");
      const rel = await saveRenderImage(runDir, board.id, "draft", id, json.imageBase64);
      const qa = await optionalQa({ job, ctx, payload, referenceFiles: files, savedPath: path.join(runDir, rel), jobId: json.jobId });
      recordDraft(results, board.id, { variant: variant.key, index, path: rel, jobId: json.jobId ?? null, durationMs: Date.now() - startedAt, selectionHash: job.selectionHash, instruction, itemNotes, qa });
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
    const renders = ensureRenders(results, board.id);
    const id = nextRenderId(renders, "c");
    const rel = await saveRenderImage(runDir, board.id, "confirm", id, json.imageBase64);
    const qa = await optionalQa({ job, ctx, payload, referenceFiles: files.slice(1), savedPath: path.join(runDir, rel), jobId: json.jobId });
    recordConfirmed(results, board.id, { variant: variant.key, fromDraftId: source.record.id, path: rel, jobId: json.jobId ?? null, durationMs: Date.now() - startedAt, selectionHash: job.selectionHash, instruction, itemNotes, qa });
    const candidate = results.candidates?.[`${board.id}--${variant.key}`];
    if (candidate) Object.assign(candidate, { confirmedAt: new Date().toISOString(), quality: "medium" });
    await ctx.persist();
    ctx.onProgress("1/1");
    return;
  }

  if (job.kind === "final") {
    const { payload, files } = buildFinalPayload(board, variant, sourcePath, { apiKey: ctx.apiKey, instruction });
    const json = await post(payload, files);
    const renders = ensureRenders(results, board.id);
    const id = nextRenderId(renders, "f");
    const rel = await saveRenderImage(runDir, board.id, "final", id, json.imageBase64);
    recordFinal(results, board.id, { variant: variant.key, fromRenderId: source.record.id, path: rel, jobId: json.jobId ?? null, libraryJobId: json.jobId ?? null, libraryVisible: json.libraryVisible ?? false, durationMs: Date.now() - startedAt, selectionHash: job.selectionHash, instruction, itemNotes });
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
Expected: `ℹ pass 19`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add scripts/autoboard/lib/render.mjs tests/autoboard-render.test.mjs
git commit -m "autoboard: add Worker POST, render recording and job execution to lib/render.mjs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `lib/render-queue.mjs` — sequential queue with cancel, hold, resume

**Files:**
- Create: `scripts/autoboard/lib/render-queue.mjs`
- Test: `tests/autoboard-render-queue.test.mjs`

**Interfaces:**
- Produces `class RenderQueue`:
  - `constructor({ execute, persist = async () => {}, initial = [] })` — `execute(job, { signal, onProgress })` returns a Promise; `initial` is the persisted `queue` array (jobs found `running` become `interrupted`).
  - `enqueue(fields) → { jobId, position }` — fields: `{ boardId, kind, variant?, count?, qa?, instructionSnapshot, selectionHash }`; `position` is 1-based among not-yet-finished jobs.
  - `cancel(jobId) → boolean`
  - `hold(message)` / `resume()`; `accessError → string | null`
  - `snapshot() → { accessError, jobs }` where each job is `{ jobId, boardId, kind, variant, count, qa, state, progress, error, createdAt, startedAt, finishedAt }` and `state ∈ queued | running | done | failed | cancelled | held | interrupted`.
  - `idle → Promise<void>` resolving when nothing is queued or running (tests use it).

- [ ] **Step 1: Write the failing tests**

```js
// tests/autoboard-render-queue.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { RenderQueue } from "../scripts/autoboard/lib/render-queue.mjs";
import { AccessError } from "../scripts/autoboard/lib/access.mjs";

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
  assert.equal(queue.snapshot().jobs[0].progress, "1/2");
  resolvers.get(a.jobId).resolve();
  await tick(); await tick();
  assert.deepEqual(started, [a.jobId, b.jobId]);
  assert.equal(queue.snapshot().jobs[0].state, "done");
  resolvers.get(b.jobId).resolve();
  await queue.idle;
  assert.equal(queue.snapshot().jobs[1].state, "done");
});

test("a failure records the error and the queue moves on", async () => {
  const { execute, resolvers } = controllable();
  const queue = new RenderQueue({ execute });
  const a = queue.enqueue({ boardId: "a", kind: "draft", variant: "A", count: 1 });
  const b = queue.enqueue({ boardId: "b", kind: "draft", variant: "A", count: 1 });
  await tick();
  resolvers.get(a.jobId).reject(Object.assign(new Error("Busy"), { status: 429, retryAfterMs: 120000, code: "rate_limited" }));
  await tick(); await tick();
  const [ja, jb] = queue.snapshot().jobs;
  assert.equal(ja.state, "failed");
  assert.deepEqual(ja.error, { message: "Busy", status: 429, code: "rate_limited", retryAfterMs: 120000 });
  assert.equal(jb.state, "running");
  resolvers.get(b.jobId).resolve();
  await queue.idle;
});

test("cancel removes a queued job and aborts a running one", async () => {
  const { execute, resolvers } = controllable();
  const queue = new RenderQueue({ execute });
  const a = queue.enqueue({ boardId: "a", kind: "draft", variant: "A", count: 3 });
  const b = queue.enqueue({ boardId: "b", kind: "draft", variant: "A", count: 1 });
  await tick();
  assert.equal(queue.cancel(b.jobId), true);
  assert.equal(queue.snapshot().jobs[1].state, "cancelled");
  resolvers.get(a.jobId).onProgress("2/3");
  assert.equal(queue.cancel(a.jobId), true);
  await tick(); await tick();
  assert.equal(queue.snapshot().jobs[0].state, "cancelled");
  assert.equal(queue.snapshot().jobs[0].progress, "2/3");
  assert.equal(queue.cancel("nope"), false);
  await queue.idle;
});

test("an Access rejection holds the rest of the queue until resume", async () => {
  const { execute, started, resolvers } = controllable();
  const queue = new RenderQueue({ execute });
  const a = queue.enqueue({ boardId: "a", kind: "draft", variant: "A", count: 1 });
  const b = queue.enqueue({ boardId: "b", kind: "draft", variant: "A", count: 1 });
  await tick();
  resolvers.get(a.jobId).reject(new AccessError("expired", "access-rejected", 302));
  await tick(); await tick();
  assert.equal(queue.snapshot().jobs[0].state, "failed");
  assert.equal(queue.snapshot().jobs[1].state, "held");
  assert.match(queue.snapshot().accessError, /expired/);
  assert.deepEqual(started, [a.jobId]);
  queue.resume();
  await tick();
  assert.equal(queue.snapshot().accessError, null);
  assert.deepEqual(started, [a.jobId, b.jobId]);
  resolvers.get(b.jobId).resolve();
  await queue.idle;
});

test("restoring persisted state marks running jobs interrupted and keeps queued ones", async () => {
  const { execute, started } = controllable();
  const queue = new RenderQueue({ execute, initial: [
    { jobId: "q-1", boardId: "a", kind: "draft", state: "running", progress: "1/3" },
    { jobId: "q-2", boardId: "b", kind: "draft", state: "done" },
    { jobId: "q-3", boardId: "c", kind: "confirm", state: "queued" },
  ] });
  await tick();
  const states = Object.fromEntries(queue.snapshot().jobs.map((job) => [job.jobId, job.state]));
  assert.equal(states["q-1"], "interrupted");
  assert.equal(states["q-2"], "done");
  assert.equal(states["q-3"], "running");
  assert.deepEqual(started, ["q-3"]);
});

test("persist is called on every state change with the serialisable job list", async () => {
  const { execute, resolvers } = controllable();
  const writes = [];
  const queue = new RenderQueue({ execute, persist: async (jobs) => { writes.push(JSON.parse(JSON.stringify(jobs)).map((j) => j.state)); } });
  const a = queue.enqueue({ boardId: "a", kind: "draft", variant: "A", count: 1 });
  await tick();
  resolvers.get(a.jobId).resolve();
  await queue.idle;
  assert.deepEqual(writes.at(0), ["queued"]);
  assert.deepEqual(writes.at(-1), ["done"]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --experimental-strip-types --test tests/autoboard-render-queue.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `lib/render-queue.mjs`**

```js
// scripts/autoboard/lib/render-queue.mjs
// In-process FIFO for paid render jobs. Strictly one job runs at a time
// across every board; the review UI polls snapshot(). Nothing here retries:
// a failed job stays failed with its error, and the queue moves on. An
// Access rejection (expired cloudflared session) holds everything that is
// still queued until the user re-logs-in and presses Resume.

import { randomUUID } from "node:crypto";

const OPEN_STATES = new Set(["queued", "running", "held"]);

export class RenderQueue {
  #execute;
  #persist;
  #jobs = [];
  #controllers = new Map();
  #running = false;
  #accessError = null;
  #idleResolvers = [];

  constructor({ execute, persist = async () => {}, initial = [] }) {
    this.#execute = execute;
    this.#persist = persist;
    for (const job of initial) {
      const restored = { ...job };
      if (restored.state === "running") {
        restored.state = "interrupted";
        restored.finishedAt = new Date().toISOString();
        restored.error = { message: "The review server restarted while this render was in flight; it was not re-run." };
      }
      this.#jobs.push(restored);
    }
    if (this.#jobs.some((job) => job.state === "held")) {
      this.#accessError = "Access credentials were rejected before the restart — press Resume after logging in.";
    }
    queueMicrotask(() => this.#kick());
  }

  get accessError() { return this.#accessError; }

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
      qa: Boolean(fields.qa),
      instructionSnapshot: fields.instructionSnapshot ?? "",
      selectionHash: fields.selectionHash ?? null,
      state: this.#accessError ? "held" : "queued",
      progress: null,
      error: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
    };
    this.#jobs.push(job);
    const position = this.#jobs.filter((entry) => OPEN_STATES.has(entry.state)).length;
    this.#save();
    queueMicrotask(() => this.#kick());
    return { jobId: job.jobId, position };
  }

  cancel(jobId) {
    const job = this.#jobs.find((entry) => entry.jobId === jobId);
    if (!job) return false;
    if (job.state === "queued" || job.state === "held") {
      job.state = "cancelled";
      job.finishedAt = new Date().toISOString();
      this.#save();
      return true;
    }
    if (job.state === "running") {
      this.#controllers.get(jobId)?.abort(Object.assign(new Error("Cancelled by user."), { name: "AbortError" }));
      return true;
    }
    return false;
  }

  hold(message) {
    this.#accessError = message;
    for (const job of this.#jobs) if (job.state === "queued") job.state = "held";
    this.#save();
  }

  resume() {
    this.#accessError = null;
    for (const job of this.#jobs) if (job.state === "held") job.state = "queued";
    this.#save();
    queueMicrotask(() => this.#kick());
  }

  snapshot() {
    return {
      accessError: this.#accessError,
      jobs: this.#jobs.map((job) => ({ ...job })),
    };
  }

  #save() {
    // Persist failures must never break the queue; the UI still has the in-memory state.
    Promise.resolve(this.#persist(this.#jobs.map((job) => ({ ...job })))).catch(() => {});
  }

  async #kick() {
    if (this.#running || this.#accessError) return;
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
    this.#save();
    try {
      await this.#execute(job, {
        signal: controller.signal,
        onProgress: (text) => { job.progress = text; this.#save(); },
      });
      job.state = "done";
    } catch (error) {
      if (controller.signal.aborted) {
        job.state = "cancelled";
      } else if (error?.code === "access-rejected") {
        job.state = "failed";
        job.error = { message: error.message, status: error.status, code: error.code };
        this.#accessError = error.message;
        for (const entry of this.#jobs) if (entry.state === "queued") entry.state = "held";
      } else {
        job.state = "failed";
        job.error = {
          message: error?.message ?? String(error),
          status: error?.status,
          code: error?.code,
          retryAfterMs: error?.retryAfterMs,
        };
      }
    } finally {
      job.finishedAt = new Date().toISOString();
      this.#controllers.delete(job.jobId);
      this.#running = false;
      this.#save();
      queueMicrotask(() => this.#kick());
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --experimental-strip-types --test tests/autoboard-render-queue.test.mjs`
Expected: `ℹ pass 6`, `ℹ fail 0`. If the "failure records the error" test's `deepEqual` complains about `undefined` keys, keep the implementation and change the assertion to compare `message/status/code/retryAfterMs` individually — `deepEqual` treats an explicit `undefined` property as present.

- [ ] **Step 5: Commit**

```bash
git add scripts/autoboard/lib/render-queue.mjs tests/autoboard-render-queue.test.mjs
git commit -m "autoboard: add sequential RenderQueue with cancel, hold and resume

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Point the CLI at the shared library

**Files:**
- Modify: `scripts/autoboard/cli.mjs`
- Test: existing suite; dry-run smoke.

**Interfaces:**
- Consumes: `loadOpenAIKey`, `resolveAccessHeaders` from `./lib/access.mjs`; `postGeneration` from `./lib/render.mjs`.

- [ ] **Step 1: Replace the moved code**

In `scripts/autoboard/cli.mjs`:

1. Delete `import { execFileSync } from "node:child_process";` and the `readFileSync` import if no longer used elsewhere (it is used by `DEV_VARS` only — check with `grep -n readFileSync scripts/autoboard/cli.mjs`; keep `mkdirSync, existsSync`).
2. Delete lines from `// Secrets and tokens resolve from the shell env first` through the end of `waitForServer` (the `DEV_VARS`, `localVar`, `loadOpenAIKey`, `CLOUDFLARED_CANDIDATES`, `cloudflaredToken`, `accessHeaderCandidates`, `let activeAccessHeaders = {}`, `waitForServer` definitions).
3. Delete the whole `postGeneration` function.
4. Add imports:

```js
import { loadOpenAIKey, resolveAccessHeaders } from "./lib/access.mjs";
import { postGeneration as postGenerationShared } from "./lib/render.mjs";
```

5. Add, where `waitForServer` used to be:

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

6. In `commandReview`, default the base URL and pass it through:

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

7. In `usage()`, extend the `review` line:

```
  autoboard review   --run <run-id> [--port <n>] [--base-url <url>]
                     Local review board. Renders started from the board go
                     to --base-url (default: the deployed Worker).
```

- [ ] **Step 2: Verify nothing else referenced the removed symbols**

Run: `grep -nE "cloudflaredToken|accessHeaderCandidates|DEV_VARS|localVar\(" scripts/autoboard/cli.mjs`
Expected: no output. Then `node --check scripts/autoboard/cli.mjs` → no output.

- [ ] **Step 3: Run the test suite and a dry-run**

Run: `npm run test:autoboard`
Expected: all passing (116 existing + 7 + 19 + 6 = 148).

Run: `npm run --silent autoboard -- generate --run run-20260906-033528 --boards penthouse-bath-4-fixture --dry-run --force`
Expected: `DRY RUN — 3 render call(s) would be made against http://localhost:3000:` followed by three lines, no QA line.

- [ ] **Step 4: Commit**

```bash
git add scripts/autoboard/cli.mjs
git commit -m "autoboard: CLI uses lib/access.mjs and lib/render.mjs; review takes --base-url

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Review server — notes import, instruction/note/pick/approve endpoints

**Files:**
- Modify: `scripts/autoboard/lib/review-server.mjs`
- Test: `tests/autoboard-review.test.mjs` (append)

**Interfaces:**
- `startReviewServer({ runDir, planPath, port, renderReviewPage, baseUrl = "http://localhost:3000", apiKey, resolveAccess = resolveAccessHeaders, executeJob = runRenderJob })` — new optional params; existing callers unaffected.
- New endpoints from this task: `POST /api/instruction`, `POST /api/item-note`, `POST /api/pick-draft`, `POST /api/approve-confirmed`, `GET /render-image?path=<run-relative>`.
- `results.json` is loaded once at startup into `results` and written by `persistResults()`.

- [ ] **Step 1: Write the failing tests (append to `tests/autoboard-review.test.mjs`)**

Look at the existing server test near line 490–560 for the scratch-run scaffold (`mkdtempSync`, `plan.json`, `_BUILD_LOG.csv`, `startReviewServer({ runDir, planPath, port: 0, renderReviewPage: () => "<html></html>" })`). Add a helper reusing the same pattern, then:

```js
import { ensureRenders, recordDraft } from "../scripts/autoboard/lib/render.mjs";

async function startScratchServer(extra = {}) {
  // Same scaffold as the existing "POST /api/replace-image" test: temp run
  // dir, minimal plan.json with one board, empty _BUILD_LOG.csv library.
  const runDir = mkdtempSync(path.join(tmpdir(), "autoboard-review-render-"));
  const libraryRoot = path.join(runDir, "library");
  mkdirSync(path.join(libraryRoot, "Tile", "tiles"), { recursive: true });
  writeFileSync(path.join(libraryRoot, "_BUILD_LOG.csv"), "row_id,sku,matched_files\n");
  const photo = path.join(libraryRoot, "faucet.png");
  writeFileSync(photo, PNG_BYTES);
  const plan = {
    runId: "run-test", source: "offline-manifest", libraryRoot,
    variants: [{ key: "A", composition: "editorial", density: "balanced", styling: "materials_only", lighting: "soft_daylight" }],
    boards: [{
      id: "penthouse-bath-2-fixture", title: "Penthouse Bath 2 Fixture Collage", unitType: "Penthouse", roomLabel: "Bath 2", collageType: "bathroom_fixture_collage",
      items: [{ slotId: "vanity_faucet", role: "vanity faucet", required: true, rowId: "1", sku: "S1", brand: "Hansgrohe", name: "Croma", notes: "", images: [photo], imageMeta: [] }],
    }],
  };
  writeFileSync(path.join(libraryRoot, "build_manifest_v2.csv"), "row_id,unit_type,room_type,cost_code,item_name,sku,qty,reference\n1,Penthouse,Bath 2,11 45 Plumbing,Hansgrohe Croma,S1,1,\n");
  const planPath = path.join(runDir, "plan.json");
  writeFileSync(planPath, JSON.stringify(plan, null, 2));
  if (extra.notesJson) {
    mkdirSync(path.join(runDir, "boards", "penthouse-bath-2-fixture"), { recursive: true });
    writeFileSync(path.join(runDir, "boards", "penthouse-bath-2-fixture", "notes.json"), JSON.stringify(extra.notesJson));
  }
  if (extra.results) writeFileSync(path.join(runDir, "results.json"), JSON.stringify(extra.results));
  const server = await startReviewServer({
    runDir, planPath, port: 0, renderReviewPage: () => "<html></html>",
    baseUrl: "https://w.example", resolveAccess: extra.resolveAccess ?? (async () => ({ headers: { "cf-access-token": "t" }, label: "test" })),
    executeJob: extra.executeJob,
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const post = async (route, body) => { const r = await fetch(baseUrl + route, { method: "POST", body: JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };
  const get = async (route) => { const r = await fetch(baseUrl + route); return { status: r.status, json: r.headers.get("content-type")?.includes("json") ? await r.json() : null, raw: r }; };
  const close = () => new Promise((resolve) => server.close(resolve));
  const results = () => JSON.parse(readFileSync(path.join(runDir, "results.json"), "utf8"));
  const planNow = () => JSON.parse(readFileSync(planPath, "utf8"));
  return { runDir, baseUrl, post, get, close, results, planNow };
}

const PNG_BYTES = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

test("server imports notes.json into item.note once and never overwrites an existing note", async () => {
  const s = await startScratchServer({ notesJson: { items: [{ slotId: "vanity_faucet", note: "keep the handle" }] } });
  try {
    assert.equal(s.planNow().boards[0].items[0].note, "keep the handle");
    const r = await s.post("/api/item-note", { boardId: "penthouse-bath-2-fixture", slotId: "vanity_faucet", note: "" });
    assert.equal(r.status, 200);
    assert.equal(s.planNow().boards[0].items[0].note, "");
  } finally { await s.close(); rmSync(s.runDir, { recursive: true, force: true }); }
});

test("POST /api/instruction and /api/item-note persist and validate", async () => {
  const s = await startScratchServer();
  try {
    let r = await s.post("/api/instruction", { boardId: "penthouse-bath-2-fixture", instruction: "  more air  " });
    assert.equal(r.status, 200);
    assert.equal(s.results().renders["penthouse-bath-2-fixture"].instruction, "more air");
    r = await s.post("/api/item-note", { boardId: "penthouse-bath-2-fixture", slotId: "nope", note: "x" });
    assert.equal(r.status, 404);
    r = await s.post("/api/instruction", { boardId: "penthouse-bath-2-fixture", instruction: "x".repeat(2001) });
    assert.equal(r.status, 400);
  } finally { await s.close(); rmSync(s.runDir, { recursive: true, force: true }); }
});

test("POST /api/pick-draft and /api/approve-confirmed update renders and the legacy candidate", async () => {
  const results = { candidates: {}, finals: {} };
  ensureRenders(results, "penthouse-bath-2-fixture");
  recordDraft(results, "penthouse-bath-2-fixture", { variant: "A", path: "boards/penthouse-bath-2-fixture/drafts/d-0001.png", jobId: "j", durationMs: 1, selectionHash: "h", instruction: "", itemNotes: {}, qa: null, index: 1 });
  const s = await startScratchServer({ results });
  try {
    mkdirSync(path.join(s.runDir, "boards", "penthouse-bath-2-fixture", "drafts"), { recursive: true });
    writeFileSync(path.join(s.runDir, "boards", "penthouse-bath-2-fixture", "drafts", "d-0001.png"), PNG_BYTES);
    let r = await s.post("/api/pick-draft", { boardId: "penthouse-bath-2-fixture", draftId: "d-0001" });
    assert.equal(r.status, 200);
    assert.equal(s.results().renders["penthouse-bath-2-fixture"].pickedDraftId, "d-0001");
    assert.equal(s.results().candidates["penthouse-bath-2-fixture--A"].status, "ok");
    r = await s.post("/api/approve-confirmed", { boardId: "penthouse-bath-2-fixture", confirmedId: "c-0009" });
    assert.equal(r.status, 404);
    r = await s.post("/api/approve-confirmed", { boardId: "penthouse-bath-2-fixture", confirmedId: null });
    assert.equal(r.status, 200);
    const img = await s.get("/render-image?path=" + encodeURIComponent("boards/penthouse-bath-2-fixture/drafts/d-0001.png"));
    assert.equal(img.status, 200);
    assert.equal(img.raw.headers.get("content-type"), "image/png");
    const escape = await s.get("/render-image?path=" + encodeURIComponent("../plan.json"));
    assert.equal(escape.status, 404);
  } finally { await s.close(); rmSync(s.runDir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --experimental-strip-types --test tests/autoboard-review.test.mjs`
Expected: the three new tests FAIL (404 or missing endpoints).

- [ ] **Step 3: Implement in `review-server.mjs`**

Add imports:

```js
import { existsSync as fileExists } from "node:fs"; // only if existsSync is not already imported (it is — skip)
import { readNoteOverrides } from "./notes.mjs";
import { resolveAccessHeaders } from "./access.mjs";
import { approveConfirmed, ensureRenders, pickDraft, runRenderJob } from "./render.mjs";
import { RenderQueue } from "./render-queue.mjs";
```

Change the signature and add state right after `const plan = …`:

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
  results.queue ??= [];

  async function persistResults() {
    await writeFile(resultsPath, JSON.stringify(results, null, 2), "utf8");
  }

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
```

After `persistPlan` is defined, add `if (importedNotes) await persistPlan();`.

Add a helper next to `isAllowedPath`:

```js
  const boardsRoot = path.resolve(runDir, "boards");
  function renderImagePath(relative) {
    if (typeof relative !== "string" || !relative) return null;
    const resolved = path.resolve(runDir, relative);
    if (!resolved.startsWith(boardsRoot + path.sep)) return null;
    return existsSync(resolved) ? resolved : null;
  }
  const MAX_INSTRUCTION_CHARS = 2000;
  function cleanText(value, label) {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    if (text.length > MAX_INSTRUCTION_CHARS) throw Object.assign(new Error(`${label} must be under ${MAX_INSTRUCTION_CHARS} characters.`), { status: 400 });
    return text;
  }
  function findItem(board, slotId) {
    const item = board.items.find((entry) => entry.slotId === slotId);
    if (!item) throw Object.assign(new Error(`Board "${board.id}" has no slot "${slotId}".`), { status: 404 });
    return item;
  }
```

Add the routes inside the request handler (before the final 404):

```js
      if (request.method === "GET" && url.pathname === "/render-image") {
        const filePath = renderImagePath(url.searchParams.get("path"));
        if (!filePath) { response.writeHead(404); response.end("Not found"); return; }
        response.writeHead(200, { "Content-Type": IMAGE_MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream", "Cache-Control": "private, max-age=3600" });
        createReadStream(filePath).pipe(response);
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
        const appliedNotes = Object.fromEntries(readNoteOverrides(runDir, board.id));
        const draft = pickDraft(results, runDir, board.id, draftId, { appliedNotes });
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
```

Make sure the existing catch-all error handler maps `error.status` to the response status (it already does for the other endpoints — verify with `grep -n "error.status" scripts/autoboard/lib/review-server.mjs`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --experimental-strip-types --test tests/autoboard-review.test.mjs`
Expected: all passing including the 3 new tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/autoboard/lib/review-server.mjs tests/autoboard-review.test.mjs
git commit -m "autoboard review server: notes import, instruction/note/pick/approve endpoints, render images

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Review server — queue wiring: `/api/render`, status, cancel, resume

**Files:**
- Modify: `scripts/autoboard/lib/review-server.mjs`
- Test: `tests/autoboard-review.test.mjs` (append)

**Interfaces:**
- `POST /api/render { boardId, kind, variant?, count?, qa? } → { jobId, position }`
- `GET /api/render-status → { accessError, baseUrl, queue, renders, costs, selectionHashes }` where `renders[boardId]` is the `results.renders` record with each draft/confirmed/final gaining `stale: boolean` and `url: "/render-image?path=…"`, `costs = { draft, confirm, final }` per image, and `selectionHashes[boardId]` is the current hash.
- `POST /api/render-cancel { jobId } → { cancelled: boolean }`
- `POST /api/render-resume → { accessError }`

- [ ] **Step 1: Write the failing tests (append)**

```js
test("POST /api/render validates and enqueues; status exposes queue, stale flags and costs", async () => {
  const calls = [];
  let release;
  const executeJob = (job, ctx) => new Promise((resolve) => { calls.push({ job, ctx }); release = resolve; ctx.onProgress("1/2"); });
  const s = await startScratchServer({ executeJob });
  try {
    let r = await s.post("/api/render", { boardId: "penthouse-bath-2-fixture", kind: "draft", variant: "Z", count: 2 });
    assert.equal(r.status, 400);
    r = await s.post("/api/render", { boardId: "penthouse-bath-2-fixture", kind: "draft", variant: "A", count: 11 });
    assert.equal(r.status, 400);
    r = await s.post("/api/render", { boardId: "penthouse-bath-2-fixture", kind: "confirm" });
    assert.equal(r.status, 400); // nothing picked
    r = await s.post("/api/render", { boardId: "penthouse-bath-2-fixture", kind: "draft", variant: "A", count: 2 });
    assert.equal(r.status, 200);
    assert.equal(r.json.position, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].job.kind, "draft");
    assert.equal(calls[0].ctx.baseUrl, "https://w.example");
    assert.deepEqual(calls[0].ctx.accessHeaders, { "cf-access-token": "t" });
    const status = await s.get("/api/render-status");
    assert.equal(status.json.accessError, null);
    assert.equal(status.json.queue[0].state, "running");
    assert.equal(status.json.queue[0].progress, "1/2");
    assert.equal(status.json.costs.draft, 0.016);
    assert.match(status.json.selectionHashes["penthouse-bath-2-fixture"], /^[0-9a-f]{40}$/);
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await s.get("/api/render-status")).json.queue[0].state, "done");
  } finally { await s.close(); rmSync(s.runDir, { recursive: true, force: true }); }
});

test("render-status marks drafts stale when the selection hash moved, and cancel works", async () => {
  const results = { candidates: {}, finals: {} };
  recordDraft(results, "penthouse-bath-2-fixture", { variant: "A", path: "boards/penthouse-bath-2-fixture/drafts/d-0001.png", jobId: "j", durationMs: 1, selectionHash: "old", instruction: "", itemNotes: {}, qa: null, index: 1 });
  let release;
  const executeJob = () => new Promise((resolve) => { release = resolve; });
  const s = await startScratchServer({ results, executeJob });
  try {
    const status = await s.get("/api/render-status");
    const draft = status.json.renders["penthouse-bath-2-fixture"].drafts[0];
    assert.equal(draft.stale, true);
    assert.equal(draft.url, "/render-image?path=" + encodeURIComponent("boards/penthouse-bath-2-fixture/drafts/d-0001.png"));
    const a = await s.post("/api/render", { boardId: "penthouse-bath-2-fixture", kind: "draft", variant: "A", count: 1 });
    const b = await s.post("/api/render", { boardId: "penthouse-bath-2-fixture", kind: "draft", variant: "A", count: 1 });
    assert.equal(b.json.position, 2);
    const cancelled = await s.post("/api/render-cancel", { jobId: b.json.jobId });
    assert.deepEqual(cancelled.json, { cancelled: true });
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const states = (await s.get("/api/render-status")).json.queue.map((job) => job.state);
    assert.deepEqual(states, ["done", "cancelled"]);
  } finally { await s.close(); rmSync(s.runDir, { recursive: true, force: true }); }
});

test("an expired Access session is reported at startup and cleared by resume", async () => {
  let attempts = 0;
  const resolveAccess = async () => {
    attempts++;
    if (attempts === 1) throw Object.assign(new Error("rejected"), { code: "access-rejected", status: 302 });
    return { headers: { "cf-access-token": "fresh" }, label: "test" };
  };
  const s = await startScratchServer({ resolveAccess, executeJob: async () => {} });
  try {
    let status = await s.get("/api/render-status");
    assert.match(status.json.accessError, /rejected/);
    const r = await s.post("/api/render", { boardId: "penthouse-bath-2-fixture", kind: "draft", variant: "A", count: 1 });
    assert.equal(r.status, 200);
    assert.equal((await s.get("/api/render-status")).json.queue[0].state, "held");
    const resumed = await s.post("/api/render-resume", {});
    assert.equal(resumed.json.accessError, null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    status = await s.get("/api/render-status");
    assert.equal(status.json.queue[0].state, "done");
  } finally { await s.close(); rmSync(s.runDir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --experimental-strip-types --test tests/autoboard-review.test.mjs`
Expected: the three new tests FAIL.

- [ ] **Step 3: Implement**

Add import: `import { COST_PER_IMAGE, selectionHash } from "./render.mjs";` (merge into the existing `./render.mjs` import).

After the notes import block in `startReviewServer`, add the Access state and the queue:

```js
  // Access credentials are resolved once; an expired cloudflared session
  // becomes a visible accessError instead of a per-click failure.
  let access = { headers: {}, error: null };
  async function refreshAccess() {
    try {
      const resolved = await resolveAccess(baseUrl);
      access = { headers: resolved.headers, error: null };
    } catch (error) {
      access = { headers: {}, error: error.message };
    }
    return access;
  }
  await refreshAccess();

  const queue = new RenderQueue({
    initial: results.queue,
    persist: async (jobs) => { results.queue = jobs; await persistResults(); },
    execute: (job, { signal, onProgress }) => executeJob(job, {
      plan, results, runDir, baseUrl, apiKey,
      accessHeaders: access.headers,
      signal, onProgress,
      persist: persistResults,
    }),
  });
  if (access.error) queue.hold(access.error);

  const VARIANT_KEYS = new Set(plan.variants.map((variant) => variant.key));
  function validateRenderRequest({ boardId, kind, variant, count }) {
    const board = findBoard(boardId);
    if (!["draft", "confirm", "final"].includes(kind)) throw Object.assign(new Error(`Unknown render kind "${kind}".`), { status: 400 });
    if (kind === "draft") {
      if (!VARIANT_KEYS.has(variant)) throw Object.assign(new Error(`Pick a variant: ${[...VARIANT_KEYS].join(", ")}.`), { status: 400 });
      const n = Number(count);
      if (!Number.isInteger(n) || n < 1 || n > 10) throw Object.assign(new Error("Count must be a whole number from 1 to 10."), { status: 400 });
    } else {
      const renders = ensureRenders(results, board.id);
      const hasSource = renders.approvedConfirmedId || renders.pickedDraftId;
      if (!hasSource) throw Object.assign(new Error("Pick a draft (or approve a confirmed render) first."), { status: 400 });
      if (kind === "final") {
        const source = renders.approvedConfirmedId
          ? renders.confirmed.find((entry) => entry.id === renders.approvedConfirmedId)
          : renders.drafts.find((entry) => entry.id === renders.pickedDraftId);
        if (source?.selectionHash !== selectionHash(board, renders.instruction)) {
          throw Object.assign(new Error("The picked render is stale — the selection changed since it was rendered. Draft again first."), { status: 409 });
        }
      }
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
    return { accessError: queue.accessError, baseUrl, queue: queue.snapshot().jobs, renders, costs: COST_PER_IMAGE, selectionHashes };
  }
```

Routes:

```js
      if (request.method === "GET" && url.pathname === "/api/render-status") {
        sendJson(response, 200, renderStatus());
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/render") {
        const body = JSON.parse(await readBody(request));
        const board = validateRenderRequest(body);
        const record = ensureRenders(results, board.id);
        const { jobId, position } = queue.enqueue({
          boardId: board.id, kind: body.kind, variant: body.variant ?? null,
          count: body.kind === "draft" ? Number(body.count) : null, qa: Boolean(body.qa),
          instructionSnapshot: record.instruction, selectionHash: selectionHash(board, record.instruction),
        });
        sendJson(response, 200, { jobId, position });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/render-cancel") {
        const { jobId } = JSON.parse(await readBody(request));
        sendJson(response, 200, { cancelled: queue.cancel(jobId) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/render-resume") {
        await refreshAccess();
        if (access.error) queue.hold(access.error); else queue.resume();
        sendJson(response, 200, { accessError: queue.accessError });
        return;
      }
```

Note the closure: `execute` reads `access.headers` at call time, so a resume with fresh headers is picked up by later jobs.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:autoboard`
Expected: all passing. If the "expired Access" test sees state `queued` instead of `held`, make sure `queue.hold(access.error)` runs right after construction (before any enqueue).

- [ ] **Step 5: Commit**

```bash
git add scripts/autoboard/lib/review-server.mjs tests/autoboard-review.test.mjs
git commit -m "autoboard review server: render queue endpoints (render, status, cancel, resume)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Review page — item note field, render panel, polling, lightbox

**Files:**
- Modify: `scripts/autoboard/lib/review-page.mjs`
- Test: `tests/autoboard-page.test.mjs` (new)

**Interfaces:**
- Consumes every endpoint from Tasks 6–7 exactly as specified.
- Board section layout: `section.board` gets a two-column `.board-grid` (`.board-left` = hero control + slots + add-slot; `.board-right` = `.render-panel`).

Remember: **no backticks and no `\"` inside the embedded script** — build strings with `+` and single/double quotes only.

- [ ] **Step 1: Write the failing smoke test**

```js
// tests/autoboard-page.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import { renderReviewPage } from "../scripts/autoboard/lib/review-page.mjs";

test("review page parses as a whole file (template-literal safety) and contains the render panel", () => {
  execFileSync(process.execPath, ["--check", "scripts/autoboard/lib/review-page.mjs"], { stdio: "pipe" });
  const html = renderReviewPage();
  for (const marker of ["render-panel", "/api/render-status", "/api/render-cancel", "/api/pick-draft", "/api/approve-confirmed", "/api/instruction", "/api/item-note", "lightbox", "data-action=\"draft\""]) {
    assert.ok(html.includes(marker), `page is missing ${marker}`);
  }
  // The embedded script must not contain a stray backtick (it would have
  // closed the outer template literal at author time).
  const script = html.slice(html.indexOf("<script>"), html.indexOf("</script>"));
  assert.equal(script.includes("`"), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --test tests/autoboard-page.test.mjs`
Expected: FAIL — `page is missing render-panel`.

- [ ] **Step 3: Add CSS** (inside the `<style>` block, after the `#status.show` rule)

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
  .render-controls label { font-size: 0.72rem; display: flex; align-items: center; gap: 0.25rem; }
  .render-status { font-size: 0.75rem; color: var(--muted); min-height: 1.2em; margin-bottom: 0.6rem; }
  .render-status.error { color: var(--danger); }
  .render-strip h4 { margin: 0.6rem 0 0.3rem; font-size: 0.72rem; color: var(--muted); }
  .thumbs { display: flex; flex-wrap: wrap; gap: 0.45rem; }
  .thumb { position: relative; width: 120px; border: 2px solid var(--line); border-radius: 6px; overflow: hidden; background: #eee; cursor: zoom-in; }
  .thumb.picked { border-color: var(--accent); }
  .thumb img { width: 100%; height: 80px; object-fit: cover; display: block; }
  .thumb .badge { position: absolute; top: 3px; left: 3px; font-size: 0.62rem; background: rgba(0,0,0,0.65); color: #fff; padding: 0.05rem 0.3rem; border-radius: 3px; }
  .thumb .stale { position: absolute; bottom: 0; left: 0; right: 0; font-size: 0.6rem; background: rgba(90,90,90,0.85); color: #fff; text-align: center; }
  .thumb .thumb-actions { display: flex; gap: 0.2rem; padding: 0.2rem; background: #fff; }
  .thumb .thumb-actions button { font-size: 0.62rem; padding: 0.1rem 0.3rem; flex: 1; }
  .thumb .thumb-actions button.on { background: var(--accent); color: #fff; border-color: var(--accent); }
  details.earlier summary { font-size: 0.72rem; color: var(--muted); cursor: pointer; margin-top: 0.4rem; }
  .render-panel textarea.instruction { width: 100%; margin-top: 0.6rem; font-size: 0.75rem; padding: 0.35rem; border: 1px solid var(--line); border-radius: 4px; resize: vertical; min-height: 2.4em; font-family: inherit; }
  .render-actions { display: flex; gap: 0.4rem; margin-top: 0.5rem; }
  .render-actions button[disabled] { opacity: 0.45; cursor: not-allowed; }
  #queue-badge { font-size: 0.72rem; color: var(--accent); margin-left: 0.6rem; }
  #lightbox { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.85); z-index: 30; align-items: center; justify-content: center; flex-direction: column; gap: 0.5rem; }
  #lightbox img { max-width: 94vw; max-height: 86vh; object-fit: contain; }
  #lightbox .caption { color: #fff; font-size: 0.8rem; }
```

- [ ] **Step 4: Add markup**

In `<header>`, change the `<h1>` line to:

```html
  <h1 id="run-title">Autoboard Review <span id="queue-badge"></span></h1>
```

Before `<div id="status"></div>` add:

```html
<div id="lightbox"><img id="lightbox-img" alt=""><div class="caption" id="lightbox-caption"></div></div>
```

- [ ] **Step 5: Add client state and the panel** (inside the `<script>`)

After `let activeSlotId = null;` add:

```js
let renderStatus = { accessError: null, queue: [], renders: {}, costs: { draft: 0, confirm: 0, final: 0 }, selectionHashes: {} };
let lastRenderJson = "";
const panelPrefs = {}; // boardId -> { variant, count, qa }
let lightboxList = [];
let lightboxIndex = 0;

function money(kind, count) {
  return "~$" + (renderStatus.costs[kind] * (count || 1)).toFixed(2);
}

function prefsFor(boardId) {
  if (!panelPrefs[boardId]) panelPrefs[boardId] = { variant: "A", count: 3, qa: false };
  return panelPrefs[boardId];
}

function boardJobs(boardId) {
  return renderStatus.queue.filter((job) => job.boardId === boardId);
}

function activeJob(boardId) {
  return boardJobs(boardId).find((job) => job.state === "running" || job.state === "queued" || job.state === "held") || null;
}

function statusLine(boardId) {
  const job = activeJob(boardId);
  if (renderStatus.accessError && (!job || job.state === "held")) return { text: "Access session expired - run cloudflared access login " + renderStatus.baseUrl, error: true, resume: true };
  if (job && job.state === "queued") {
    const ahead = renderStatus.queue.filter((entry) => (entry.state === "running" || entry.state === "queued") && entry.createdAt < job.createdAt).length;
    return { text: "queued (" + ahead + " ahead)", error: false };
  }
  if (job && job.state === "running") {
    const seconds = Math.round((Date.now() - new Date(job.startedAt).getTime()) / 1000);
    return { text: "rendering " + job.kind + (job.progress ? " " + job.progress : "") + " \\u00b7 " + seconds + "s", error: false };
  }
  const last = boardJobs(boardId).slice(-1)[0];
  if (!last) return { text: "", error: false };
  if (last.state === "failed") {
    let text = "failed: " + (last.error && last.error.message ? last.error.message : "unknown error");
    if (last.error && last.error.retryAfterMs) {
      const wait = Math.max(0, Math.ceil((new Date(last.finishedAt).getTime() + last.error.retryAfterMs - Date.now()) / 1000));
      if (wait > 0) text += " (retry after " + wait + "s)";
    }
    return { text: text, error: true };
  }
  if (last.state === "cancelled") return { text: "cancelled" + (last.progress ? " after " + last.progress : ""), error: false };
  if (last.state === "interrupted") return { text: "interrupted (server restarted)", error: true };
  if (last.state === "done") return { text: "done " + new Date(last.finishedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), error: false };
  return { text: "", error: false };
}

function renderThumb(board, entry, kind) {
  const record = renderStatus.renders[board.id];
  const img = el("img", { src: entry.url, alt: entry.id, "data-action": "lightbox", "data-board": board.id, "data-kind": kind, "data-id": entry.id });
  const children = [img, el("span", { className: "badge", text: entry.variant + (kind === "draft" ? " " + entry.index : "") + (entry.instruction || Object.keys(entry.itemNotes || {}).length ? " \\ud83d\\udcac" : "") })];
  if (entry.stale) children.push(el("span", { className: "stale", text: "stale" }));
  const actions = el("div", { className: "thumb-actions" });
  if (kind === "draft") {
    const picked = record.pickedDraftId === entry.id;
    actions.appendChild(el("button", { className: picked ? "on" : "", "data-action": "pick-draft", "data-board": board.id, "data-id": entry.id, text: picked ? "\\u2713 picked" : "pick" }));
  } else if (kind === "confirm") {
    const approved = record.approvedConfirmedId === entry.id;
    actions.appendChild(el("button", { className: approved ? "on" : "", "data-action": "approve", "data-board": board.id, "data-id": approved ? "" : entry.id, text: approved ? "\\u2713 approved" : "approve" }));
  } else if (entry.libraryJobId) {
    actions.appendChild(el("a", { href: renderStatus.baseUrl + "/library?job=" + encodeURIComponent(entry.libraryJobId), target: "_blank", rel: "noopener", text: "\\ud83d\\udd17 Library" }));
  }
  const thumb = el("div", { className: "thumb" + (kind === "draft" && record.pickedDraftId === entry.id ? " picked" : ""), title: entry.instruction || "" }, children);
  thumb.appendChild(actions);
  return thumb;
}

function renderDraftStrip(board) {
  const record = renderStatus.renders[board.id];
  const drafts = record.drafts.slice();
  const wrap = el("div", { className: "render-strip" });
  if (!drafts.length) { wrap.appendChild(el("h4", { text: "Drafts \\u2014 none yet" })); return wrap; }
  const latestRevision = drafts[drafts.length - 1].revision;
  const current = drafts.filter((entry) => entry.revision === latestRevision);
  const earlier = drafts.filter((entry) => entry.revision !== latestRevision);
  wrap.appendChild(el("h4", { text: "Drafts (rev " + latestRevision + ")" }));
  wrap.appendChild(el("div", { className: "thumbs" }, current.map((entry) => renderThumb(board, entry, "draft"))));
  if (earlier.length) {
    const details = el("details", { className: "earlier" }, [
      el("summary", { text: "earlier drafts (" + earlier.length + ")" }),
      el("div", { className: "thumbs" }, earlier.reverse().map((entry) => renderThumb(board, entry, "draft"))),
    ]);
    wrap.appendChild(details);
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
  const record = renderStatus.renders[board.id] || { instruction: "", pickedDraftId: null, approvedConfirmedId: null, drafts: [], confirmed: [], finals: [] };
  const prefs = prefsFor(board.id);
  const job = activeJob(board.id);
  const panel = el("div", { className: "render-panel", "data-board": board.id });
  panel.appendChild(el("h3", { text: "Render" }));

  const toggle = el("span", { className: "variant-toggle" }, ["A", "B", "C"].map((key) =>
    el("button", { className: prefs.variant === key ? "active" : "", "data-action": "variant", "data-board": board.id, "data-variant": key, text: key })));
  const count = el("input", { type: "number", min: "1", max: "10", value: String(prefs.count), "data-action": "count", "data-board": board.id });
  const draftButton = el("button", { "data-action": "draft", "data-board": board.id, text: "Draft \\u00d7" + prefs.count + " \\u00b7 " + money("draft", prefs.count) });
  const qaLabel = el("label", {}, [el("input", { type: "checkbox", "data-action": "qa", "data-board": board.id }), el("span", { text: "QA" })]);
  qaLabel.firstChild.checked = prefs.qa;
  const controls = el("div", { className: "render-controls" }, [toggle, count, draftButton, qaLabel]);
  if (job) controls.appendChild(el("button", { "data-action": "cancel", "data-board": board.id, "data-job": job.jobId, text: "\\u23f9 cancel" }));
  panel.appendChild(controls);

  const line = statusLine(board.id);
  const status = el("div", { className: "render-status" + (line.error ? " error" : ""), text: line.text });
  if (line.resume) status.appendChild(el("button", { "data-action": "resume", text: "Resume" }));
  panel.appendChild(status);

  panel.appendChild(renderDraftStrip(board));

  const instruction = el("textarea", { className: "instruction", placeholder: "Board instruction for the next confirm/final (e.g. more breathing room, tile lower-left)", "data-action": "instruction", "data-board": board.id });
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
  else if (source.selectionHash !== hash) { finalButton.disabled = true; finalButton.title = "The picked render is stale - the selection changed since it was rendered. Draft again first."; }
  panel.appendChild(el("div", { className: "render-actions" }, [confirmButton, finalButton]));

  panel.appendChild(renderStrip(board, record.confirmed, "confirm", "Confirmed"));
  panel.appendChild(renderStrip(board, record.finals, "final", "Final"));
  return panel;
}
```

- [ ] **Step 6: Restructure `renderBoard` and add the note field to slot cards**

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

In `renderSlotCard`, after `body.appendChild(actions);` add:

```js
  const note = el("textarea", { className: "note", placeholder: "Note for this item (used by the next render)", "data-action": "item-note", "data-board": board.id, "data-slot": item.slotId });
  note.value = item.note || "";
  body.appendChild(note);
```

- [ ] **Step 7: Polling, actions and lightbox** (append before `loadPlan();`)

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
  if (board && existing) existing.replaceWith(renderPanel(board));
}

function refreshQueueBadge() {
  const running = renderStatus.queue.find((job) => job.state === "running");
  const queued = renderStatus.queue.filter((job) => job.state === "queued").length;
  const badge = document.getElementById("queue-badge");
  badge.textContent = running ? "Rendering: " + running.boardId + (queued ? " \\u00b7 " + queued + " queued" : "") : (queued ? queued + " queued" : "");
}

async function pollRenderStatus() {
  try {
    const response = await fetch("/api/render-status");
    const json = await response.json();
    const text = JSON.stringify(json);
    const changed = text !== lastRenderJson;
    lastRenderJson = text;
    renderStatus = json;
    refreshQueueBadge();
    // Re-render only panels whose data changed; a running timer still needs
    // its seconds counter refreshed.
    plan.boards.forEach((board) => {
      const job = activeJob(board.id);
      if (changed || (job && job.state === "running")) {
        const active = document.activeElement;
        if (active && active.closest && active.closest('.render-panel[data-board="' + board.id + '"]') && active.tagName === "TEXTAREA") return;
        refreshPanel(board.id);
      }
    });
  } catch (error) {
    // Server unreachable mid-poll: keep the last state; the next tick retries.
  }
  const busy = renderStatus.queue.some((job) => job.state === "running" || job.state === "queued");
  setTimeout(pollRenderStatus, busy ? 2000 : 15000);
}

function openLightbox(boardId, kind, id) {
  const record = renderStatus.renders[boardId];
  const list = kind === "draft" ? record.drafts : kind === "confirm" ? record.confirmed : record.finals;
  lightboxList = list.map((entry) => ({ url: entry.url, caption: boardId + " \\u00b7 " + kind + " " + entry.id + " \\u00b7 variant " + entry.variant + (entry.instruction ? " \\u00b7 " + entry.instruction : "") }));
  lightboxIndex = Math.max(0, list.findIndex((entry) => entry.id === id));
  showLightbox();
}

function showLightbox() {
  const box = document.getElementById("lightbox");
  const item = lightboxList[lightboxIndex];
  if (!item) return;
  document.getElementById("lightbox-img").src = item.url;
  document.getElementById("lightbox-caption").textContent = item.caption + "  (" + (lightboxIndex + 1) + "/" + lightboxList.length + ")";
  box.style.display = "flex";
}

function closeLightbox() { document.getElementById("lightbox").style.display = "none"; }

document.addEventListener("keydown", (event) => {
  if (document.getElementById("lightbox").style.display !== "flex") return;
  if (event.key === "Escape") closeLightbox();
  if (event.key === "ArrowRight" && lightboxIndex < lightboxList.length - 1) { lightboxIndex++; showLightbox(); }
  if (event.key === "ArrowLeft" && lightboxIndex > 0) { lightboxIndex--; showLightbox(); }
});

document.addEventListener("click", async (event) => {
  if (event.target.id === "lightbox" || event.target.id === "lightbox-img") { closeLightbox(); return; }
  const node = event.target.closest("[data-action]");
  if (!node) return;
  const action = node.getAttribute("data-action");
  const boardId = node.getAttribute("data-board");
  try {
    if (action === "variant") { prefsFor(boardId).variant = node.getAttribute("data-variant"); refreshPanel(boardId); }
    else if (action === "draft") {
      const prefs = prefsFor(boardId);
      await postJson("/api/render", { boardId: boardId, kind: "draft", variant: prefs.variant, count: prefs.count, qa: prefs.qa });
      showStatus("Queued " + prefs.count + " draft(s) of " + prefs.variant + " for " + boardId);
      await pollOnce();
    }
    else if (action === "confirm") { await postJson("/api/render", { boardId: boardId, kind: "confirm", qa: prefsFor(boardId).qa }); showStatus("Queued confirm render for " + boardId); await pollOnce(); }
    else if (action === "final") {
      const record = renderStatus.renders[boardId];
      const source = record.approvedConfirmedId ? "confirmed " + record.approvedConfirmedId : "draft " + record.pickedDraftId;
      if (!window.confirm("Render final at high quality, " + money("final", 1) + ", from " + source + "? It will appear in the site Library.")) return;
      await postJson("/api/render", { boardId: boardId, kind: "final" });
      showStatus("Queued final render for " + boardId);
      await pollOnce();
    }
    else if (action === "cancel") { await postJson("/api/render-cancel", { jobId: node.getAttribute("data-job") }); await pollOnce(); }
    else if (action === "resume") { await postJson("/api/render-resume", {}); await pollOnce(); }
    else if (action === "pick-draft") { await postJson("/api/pick-draft", { boardId: boardId, draftId: node.getAttribute("data-id") }); await pollOnce(); }
    else if (action === "approve") { const id = node.getAttribute("data-id"); await postJson("/api/approve-confirmed", { boardId: boardId, confirmedId: id || null }); await pollOnce(); }
    else if (action === "lightbox") { openLightbox(boardId, node.getAttribute("data-kind"), node.getAttribute("data-id")); }
  } catch (error) {
    showStatus(error.message, true);
  }
});

document.addEventListener("change", (event) => {
  const node = event.target.closest("[data-action]");
  if (!node) return;
  const action = node.getAttribute("data-action");
  const boardId = node.getAttribute("data-board");
  if (action === "count") { const n = Math.max(1, Math.min(10, Number(node.value) || 1)); prefsFor(boardId).count = n; refreshPanel(boardId); }
  if (action === "qa") { prefsFor(boardId).qa = node.checked; }
});

document.addEventListener("focusout", async (event) => {
  const node = event.target;
  if (!node || !node.getAttribute) return;
  const action = node.getAttribute("data-action");
  const boardId = node.getAttribute("data-board");
  try {
    if (action === "instruction") {
      const json = await postJson("/api/instruction", { boardId: boardId, instruction: node.value });
      if (renderStatus.renders[boardId]) renderStatus.renders[boardId].instruction = json.instruction;
      await pollOnce();
    }
    if (action === "item-note") {
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

async function pollOnce() {
  const response = await fetch("/api/render-status");
  renderStatus = await response.json();
  lastRenderJson = JSON.stringify(renderStatus);
  refreshQueueBadge();
  plan.boards.forEach((board) => refreshPanel(board.id));
}
```

Then change the last lines so the status poll starts after the plan is loaded:

```js
loadPlan().then(() => pollRenderStatus());
```

(`loadPlan` must `return` nothing async-unsafe; it is already `async`, so `.then` works.)

The existing click handler at the bottom of the file handles `change`/`reset`/`remove-slot`/`.option`/modal. The new handler only reacts to `[data-action]` values it knows; the two coexist. Make sure the new handler is added **after** the existing one and that the existing one's `[data-action="change"]` etc. remain untouched.

- [ ] **Step 8: Whole-file syntax check and test**

Run: `node --check scripts/autoboard/lib/review-page.mjs`
Expected: no output. If it reports an unexpected token, a backtick or `\"` crept into the embedded script — find it with `grep -n '\`' scripts/autoboard/lib/review-page.mjs` (only the two template delimiters should appear) and remove it.

Run: `node --experimental-strip-types --test tests/autoboard-page.test.mjs`
Expected: `ℹ pass 1`.

Run: `npm run test:autoboard`
Expected: all passing.

- [ ] **Step 9: Browser check against a scratch run (no paid renders)**

Start the review server against the current run with a **local** base URL that has no server, so any accidental click fails harmlessly at Access resolution:

```bash
npm run autoboard -- review --run run-20260906-033528 --port 4199 --base-url http://localhost:9 
```

Open `http://127.0.0.1:4199` (use the Browser pane): confirm every board shows the render panel to the right of its slots, the status line shows the "No server responded" access error with a Resume button, the draft strips are empty (the legacy CLI drafts are not in `renders`), the instruction textarea saves on blur (check `results.json`), and slot-card note fields save on blur (check `plan.json`). Stop the server (Ctrl+C / kill the process).

- [ ] **Step 10: Commit**

```bash
git add scripts/autoboard/lib/review-page.mjs tests/autoboard-page.test.mjs
git commit -m "autoboard review page: render panel with drafts/confirmed/final strips, notes, polling, lightbox

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: End-to-end check with one real draft, docs, memory

**Files:**
- Modify: `scripts/autoboard/cli.mjs` (usage text only, if anything is out of date)
- Modify: `C:\Users\cowey\.claude\projects\E--Games-Claude-Material-Collager-Website\memory\wieland-autoboard-pipeline.md` (append how the review board renders now work)

- [ ] **Step 1: Ask the user for a go-ahead for exactly one paid low-quality draft.** Do not proceed without it.

- [ ] **Step 2: Refresh Access if needed**

```bash
"C:\Program Files (x86)\cloudflared\cloudflared.exe" access login https://material-collager.mlux-db1.workers.dev
```

- [ ] **Step 3: Start the server against the deployed Worker and render one draft from the panel**

```bash
npm run autoboard -- review --run run-20260906-033528 --port 4173
```

In the browser: on **Penthouse Bath 4 / Triplex Bath 3**, set variant A, count 1, click Draft. Expected within ~30 s: status line goes `queued (0 ahead)` → `rendering draft 1/1 · Ns` → `done HH:MM`; a thumbnail appears under "Drafts (rev 1)"; `results.json` gains `renders["penthouse-bath-4-fixture"].drafts[0]` and `queue[0].state === "done"`; the PNG exists at `autoboard-runs/run-20260906-033528/boards/penthouse-bath-4-fixture/drafts/d-0001.png`. Click **pick** → `candidates["penthouse-bath-4-fixture--A"]` is updated and `boards/penthouse-bath-4-fixture/A.png` is overwritten with the picked draft. Do **not** run Confirm or Final in this check.

- [ ] **Step 4: Confirm the CLI still agrees**

```bash
npm run --silent autoboard -- confirm --run run-20260906-033528 penthouse-bath-4-fixture--A --dry-run
```

Expected: one confirm render listed for revision 1 → 2, no errors, no QA line.

- [ ] **Step 5: Update memory**

Append to `wieland-autoboard-pipeline.md`:

```
**Review board renders (2026-09-07):** `npm run autoboard -- review --run <id>` now drives the whole workflow from http://127.0.0.1:<port>: per-board render panel (variant A/B/C × count drafts at low/standard, pick, Confirm at medium, Final at high → Library), one server-side queue (`lib/render-queue.mjs`), shared pipeline in `lib/render.mjs`, Access via `lib/access.mjs`. Default --base-url is the deployed Worker. Render records live in results.json `renders[boardId]` (drafts/confirmed/finals with selectionHash for stale detection); picking a draft mirrors it into the legacy `candidates` slot so CLI confirm/finalize keep working. Per-item notes are `item.note` in plan.json (notes.json is imported once, then ignored). QA is opt-in via the panel checkbox.
```

- [ ] **Step 6: Commit**

```bash
git add scripts/autoboard/cli.mjs
git commit -m "autoboard: review usage text for board-driven renders

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

(If `cli.mjs` had no changes, skip the commit.)

---

## Self-review against the spec

- Prompt input both per-item and board-level → Task 6 endpoints, Task 8 fields, Task 2 `boardForRender`. ✔
- Variant A/B/C × free count 1–10 → Task 7 validation, Task 3 `runRenderJob`, Task 8 controls. ✔
- Confirm optional; Final from picked draft or approved confirmed → Task 3 `renderSource`, Task 7 validation, Task 8 button enabling. ✔
- Single queue, live status, cancel, held/resume, interrupted on restart → Task 4, Task 7. ✔
- Draft history kept with collapsed earlier revisions → Task 3 revisions, Task 8 `renderDraftStrip`. ✔
- Cost guard only on Final; approximate labels → Task 2 table, Task 8 `window.confirm` on final only. ✔
- Stale guard on Final only → Task 3, Task 7, Task 8. ✔
- QA opt-in → Task 3 `optionalQa`, Task 8 checkbox default off. ✔
- CLI compatibility → Task 3 `pickDraft` mirror, Task 5 refactor, Task 9 dry-run check. ✔
- No tokens in payloads/logs → `renderStatus()` never includes `access.headers`; `resolveAccessHeaders` logs labels only. ✔
- Spec deviation recorded: board instruction rides on the hero item (no request-level field). Noted under "Decisions fixed by this plan".
