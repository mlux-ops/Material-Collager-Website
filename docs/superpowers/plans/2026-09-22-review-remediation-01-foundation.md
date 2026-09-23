# Review Remediation — Phase 0: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every later phase a trustworthy baseline and a strict storage test harness, and make the release path run the checks.

**Architecture:** Three tasks, one work package (WP-0).
1. Restore a reproducible install and record the baseline numbers.
2. Build `tests/helpers/fake-worker-env.mjs`: a D1 double over `node:sqlite` that is strict where D1 is strict (undefined binds throw; `batch()` is a transaction), a Map-backed R2 double, and the module hooks that let app code importing `cloudflare:workers` and `@/…` run under `node --test`.
3. Add a no-new-errors typecheck gate and a `verify` job that `deploy` depends on.

**Tech Stack:** Node `node:sqlite`, `module.registerHooks`, `node:test`; GitHub Actions.

**Inherits:** every rule in `2026-09-22-review-remediation-00-overview.md → Global Constraints`.

**Model routing:** Tasks 0.1 and 0.3 → Haiku 4.5. Task 0.2 → Sonnet 5. No Opus review needed; Task 0.2's self-test is the proof.

## Global Constraints

- Node ≥ 22.15 is required for anything importing the new helper (`module.registerHooks`); CI uses Node 22, local is v24.
- No new npm dependencies. `node:sqlite` needs no flag on Node ≥ 22.13.
- App modules that import `cloudflare:workers` must be loaded with a **dynamic** `await import(...)` **after** the helper is imported. Static imports are resolved at link time, before the helper's hooks are registered.
- New storage test files are named `tests/storage-*.test.mjs` and run with `npm run test:storage`. Autoboard storage tests keep the `autoboard-` prefix so `npm run test:autoboard` picks them up.
- Commands are bash (Git Bash on Windows).
- Do not delete, move or modify `./Material-Collager-Website/` (an untracked nested clone).

## File Structure

| File | Responsibility |
|---|---|
| `tests/helpers/fake-worker-env.mjs` (new) | `installWorkerEnv`, `createFakeD1`, `createFakeR2`; registers the `cloudflare:workers` and `@/` resolve hooks |
| `tests/storage-fake-worker-env.test.mjs` (new) | Proves the doubles behave like D1/R2 where it matters |
| `package.json` (modify) | Adds `test:storage` |
| `scripts/typecheck-baseline.mjs` (new) | Runs `tsc --noEmit`; fails if the error count exceeds the recorded baseline |
| `scripts/typecheck-baseline.json` (new) | `{ "errors": N }`, the pre-existing debt measured in Task 0.1 |
| `.github/workflows/deploy.yml` (modify) | `verify` job (lint, tests, typecheck gate); `deploy` needs it and is skipped on pull requests |
| `.test-work/baseline/` (local, git-ignored) | Baseline logs and `SUMMARY.md` |

---

### Task 0.1: Restore the install and record baselines

**Files:**
- Create (local only, git-ignored via `.test-work/`): `.test-work/baseline/{typecheck,tests,lint}.txt`, `.test-work/baseline/SUMMARY.md`

**Interfaces:**
- Produces: the typecheck error count `N` that Task 0.3 writes into `scripts/typecheck-baseline.json`, and the test/lint baseline every later phase compares against.

- [ ] **Step 1: Pre-flight: the nested clone must be out of the tree**

Run: `git -C "E:/Games/Claude/Material-Collager-Website" status --short`

Expected: no output, or only lines unrelated to `Material-Collager-Website/`.

If `?? Material-Collager-Website/` is listed, **stop and ask the user** to move that folder outside the repository. Explain the reason: tsconfig's `"include": ["**/*.ts", …]` and `eslint .` both scan it, so every baseline number would count a second copy of the app. Do not move or delete it yourself. Resume when `git status --short` no longer lists it.

- [ ] **Step 2: Reinstall from the lockfile**

Run: `npm ci`

Expected: exit 0. Then confirm the missing type package arrived:

Run: `ls node_modules/@cloudflare/workers-types/index.d.ts`

Expected: the path is printed. It was absent before, which is what caused the review's `TS2688`.

- [ ] **Step 3: Record the typecheck baseline**

Run:
```bash
mkdir -p .test-work/baseline
npm run typecheck > .test-work/baseline/typecheck.txt 2>&1; echo "exit $?"
grep -c "error TS" .test-work/baseline/typecheck.txt
```
Expected: a non-zero exit and a count. `CLAUDE.md` says 14 errors pre-date this tree; record whatever the real number is as `N`. If any error mentions `TS2688`, the install is still incomplete: go back to Step 2.

- [ ] **Step 4: Record the test baseline**

Run:
```bash
node --experimental-strip-types --test --test-reporter=spec tests/*.test.mjs > .test-work/baseline/tests.txt 2>&1; echo "exit $?"
tail -n 12 .test-work/baseline/tests.txt
```
Expected: exit 0 and a summary block with `# tests`, `# pass`, `# fail 0`. Record the counts. `CLAUDE.md` says 466 and the review says 719, so note which is right. If anything fails, record the failing test names. Do not fix them in this task; report them to the orchestrator.

- [ ] **Step 5: Record the lint baseline**

Run:
```bash
npm run lint > .test-work/baseline/lint.txt 2>&1; echo "exit $?"
tail -n 3 .test-work/baseline/lint.txt
```
Expected: exit 0 and a problems summary (the review saw 0 errors and 24 warnings, some from the nested clone). Record the counts.

- [ ] **Step 6: Write the summary**

Create `.test-work/baseline/SUMMARY.md`:
```markdown
# Baseline — <date>, HEAD <git rev-parse --short HEAD>

- Node: <node --version>
- Typecheck: N = <count> errors (TS2688 absent: yes)
- Tests: <pass>/<total> pass, <fail> fail
- Lint: <errors> errors, <warnings> warnings
- Notes: <anything unexpected>
```
Nothing tracked changed, so there is nothing to commit.

---

### Task 0.2: Strict Worker-binding doubles for tests

**Files:**
- Create: `tests/helpers/fake-worker-env.mjs`
- Create: `tests/storage-fake-worker-env.test.mjs`
- Modify: `package.json` (scripts)

**Interfaces:**
- Produces, used by Phases 1–2:
  - `installWorkerEnv(bindings: Record<string, unknown>): object` replaces the bindings every `cloudflare:workers` importer sees (for example `installWorkerEnv({ DB, OUTPUTS })`).
  - `createFakeD1(hooks?: { beforeStatement?(kind: "run"|"all"|"first"|"batch", sql: string, args: unknown[]): void | Promise<void>; onBatchStatement?(sql: string, args: unknown[], index: number): void }): D1-like` returns `{ sqlite, prepare(sql), batch(statements), exec(sql) }`. `prepare(sql).bind(...args)` returns `{ run(), all(), first(column?) }`.
  - `createFakeR2(): R2-like` returns `{ objects: Map, puts: Array<{ key, bytes, httpMetadata, customMetadata }>, put, get, head, delete }`.
  - A side effect of importing the helper: `cloudflare:workers` resolves to `export const env = globalThis.__fakeWorkerEnv`, and `@/x/y` resolves to `<repo>/x/y.ts` (or the given extension).

- [ ] **Step 1: Write the failing self-test**

Create `tests/storage-fake-worker-env.test.mjs`:
```js
import assert from "node:assert/strict";
import test from "node:test";
import { createFakeD1, createFakeR2, installWorkerEnv } from "./helpers/fake-worker-env.mjs";

test("the fake D1 rejects an undefined bind the way D1 does, and stores null", async () => {
  const DB = createFakeD1();
  await DB.exec("CREATE TABLE t (a TEXT)");
  await assert.rejects(DB.prepare("INSERT INTO t (a) VALUES (?)").bind(undefined).run(), /D1_TYPE_ERROR/);
  await DB.prepare("INSERT INTO t (a) VALUES (?)").bind(null).run();
  assert.deepEqual(await DB.prepare("SELECT a FROM t").first(), { a: null });
});

test("the fake D1 converts booleans to 0/1 like D1", async () => {
  const DB = createFakeD1();
  await DB.exec("CREATE TABLE t (flag INTEGER)");
  await DB.prepare("INSERT INTO t (flag) VALUES (?)").bind(true).run();
  assert.equal(await DB.prepare("SELECT flag FROM t").first("flag"), 1);
});

test("a statement that fails inside a batch rolls the whole batch back", async () => {
  const DB = createFakeD1({ onBatchStatement: (_sql, _args, index) => { if (index === 1) throw new Error("injected"); } });
  await DB.exec("CREATE TABLE t (a INTEGER)");
  await assert.rejects(
    DB.batch([DB.prepare("INSERT INTO t (a) VALUES (?)").bind(1), DB.prepare("INSERT INTO t (a) VALUES (?)").bind(2)]),
    /injected/,
  );
  assert.equal(await DB.prepare("SELECT COUNT(*) AS n FROM t").first("n"), 0);
});

test("beforeStatement can hold one request while another completes", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const order = [];
  const DB = createFakeD1({ beforeStatement: async (_kind, sql) => { if (sql.includes("'slow'")) await gate; } });
  await DB.exec("CREATE TABLE t (a TEXT)");
  const slow = DB.prepare("INSERT INTO t (a) VALUES ('slow')").run().then(() => order.push("slow"));
  await DB.prepare("INSERT INTO t (a) VALUES ('fast')").run().then(() => order.push("fast"));
  release();
  await slow;
  assert.deepEqual(order, ["fast", "slow"]);
});

test("the fake R2 keeps bytes and metadata per key and records every put", async () => {
  const bucket = createFakeR2();
  await bucket.put("k", new Uint8Array([1, 2, 3]), { httpMetadata: { contentType: "image/png" } });
  const object = await bucket.get("k");
  assert.deepEqual(new Uint8Array(await object.arrayBuffer()), new Uint8Array([1, 2, 3]));
  assert.equal(object.httpMetadata.contentType, "image/png");
  assert.equal(bucket.puts.length, 1);
  await bucket.delete("k");
  assert.equal(await bucket.get("k"), null);
});

test("app code importing cloudflare:workers sees the installed bindings", async () => {
  const DB = createFakeD1();
  installWorkerEnv({ DB });
  const { env } = await import("cloudflare:workers");
  assert.equal(env.DB, DB);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --experimental-strip-types --test tests/storage-fake-worker-env.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `./helpers/fake-worker-env.mjs`.

- [ ] **Step 3: Write the helper**

Create `tests/helpers/fake-worker-env.mjs`:
```js
// Test doubles for the Worker bindings the app reaches through
// `import { env } from "cloudflare:workers"`, so modules that own D1/R2 storage
// run for real under `node --test` instead of being stubbed out wholesale.
//
// The D1 double is strict where D1 is strict. Binding `undefined` throws
// ("D1_TYPE_ERROR") instead of quietly storing NULL, since that difference is
// exactly how a route can pass every permissive fake and fail on the real
// binding. `batch()` is a transaction: every statement commits or none does,
// which is D1's contract too.
//
// Importing this file registers resolve hooks for `cloudflare:workers` and the
// `@/` alias. App modules must then be loaded with a DYNAMIC import: static
// imports are resolved at link time, before this module's body has run.
// Requires Node >= 22.15 (module.registerHooks), like tests/image-routes.test.mjs.

import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";

const env = (globalThis.__fakeWorkerEnv ??= {});

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") {
      return { shortCircuit: true, url: "data:text/javascript,export const env = globalThis.__fakeWorkerEnv;" };
    }
    if (specifier.startsWith("@/")) {
      const target = specifier.slice(2);
      const withExtension = /\.[cm]?[jt]sx?$/.test(target) ? target : `${target}.ts`;
      return next(new URL(`../../${withExtension}`, import.meta.url).href, context);
    }
    return next(specifier, context);
  },
});

/** Replaces the bindings every `cloudflare:workers` importer sees. */
export function installWorkerEnv(bindings) {
  for (const key of Object.keys(env)) delete env[key];
  Object.assign(env, bindings);
  return env;
}

// D1's own conversions: booleans become 0/1, ArrayBuffers become blobs, and
// undefined is refused outright.
function toSqlValue(value, index, sql) {
  if (value === undefined) {
    throw new Error(
      `D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined' (parameter ${index + 1} of: ${sql.trim().slice(0, 80)})`,
    );
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return value;
}

const READS = /^\s*(select|with|pragma|explain)\b/i;

/**
 * A D1Database over an in-memory SQLite.
 *
 * hooks.beforeStatement(kind, sql, args) runs (and may await or throw) before
 * every prepared-statement call and once per batch: the seam a test uses to
 * hold one request mid-flight while another completes.
 * hooks.onBatchStatement(sql, args, index) runs synchronously inside a batch's
 * transaction; throwing from it rolls the whole batch back.
 */
export function createFakeD1(hooks = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const values = (sql, args) => args.map((value, index) => toSqlValue(value, index, sql));
  const execute = (sql, args) => {
    const bound = values(sql, args);
    const statement = sqlite.prepare(sql);
    if (READS.test(sql)) {
      return { success: true, results: statement.all(...bound).map((row) => ({ ...row })), meta: { changes: 0 } };
    }
    const out = statement.run(...bound);
    return { success: true, results: [], meta: { changes: Number(out.changes), last_row_id: Number(out.lastInsertRowid) } };
  };
  const prepared = (sql, args = []) => ({
    sql,
    args,
    bind: (...next) => prepared(sql, next),
    async run() {
      await hooks.beforeStatement?.("run", sql, args);
      return execute(sql, args);
    },
    async all() {
      await hooks.beforeStatement?.("all", sql, args);
      return { success: true, results: sqlite.prepare(sql).all(...values(sql, args)).map((row) => ({ ...row })), meta: {} };
    },
    async first(column) {
      await hooks.beforeStatement?.("first", sql, args);
      const row = sqlite.prepare(sql).get(...values(sql, args));
      if (!row) return null;
      return column ? (row[column] ?? null) : { ...row };
    },
  });
  return {
    sqlite,
    prepare: (sql) => prepared(sql),
    async batch(statements) {
      await hooks.beforeStatement?.("batch", statements.map((entry) => entry.sql).join(";\n"), []);
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((entry, index) => {
          hooks.onBatchStatement?.(entry.sql, entry.args, index);
          return execute(entry.sql, entry.args);
        });
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    async exec(sql) {
      sqlite.exec(sql);
      return { count: 1, duration: 0 };
    },
  };
}

/** An R2Bucket over a Map. `puts` records every write so a test can assert on it. */
export function createFakeR2() {
  const objects = new Map();
  const puts = [];
  const toBytes = async (value) => {
    if (value instanceof Uint8Array) return new Uint8Array(value);
    if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
    if (typeof value === "string") return new TextEncoder().encode(value);
    return new Uint8Array(await new Response(value).arrayBuffer());
  };
  const describe = (key, entry) => ({
    key,
    size: entry.bytes.byteLength,
    httpMetadata: entry.httpMetadata,
    customMetadata: entry.customMetadata,
  });
  return {
    objects,
    puts,
    async put(key, value, options = {}) {
      const entry = { bytes: await toBytes(value), httpMetadata: options.httpMetadata ?? {}, customMetadata: options.customMetadata ?? {} };
      objects.set(key, entry);
      puts.push({ key, ...entry });
      return describe(key, entry);
    },
    async get(key) {
      const entry = objects.get(key);
      if (!entry) return null;
      return {
        ...describe(key, entry),
        body: new Blob([entry.bytes]).stream(),
        arrayBuffer: async () => entry.bytes.slice().buffer,
        text: async () => new TextDecoder().decode(entry.bytes),
      };
    },
    async head(key) {
      const entry = objects.get(key);
      return entry ? describe(key, entry) : null;
    },
    async delete(keys) {
      for (const key of [keys].flat()) objects.delete(key);
    },
  };
}
```

- [ ] **Step 4: Add the suite script**

In `package.json` `"scripts"`, add this line directly after `"test:autoboard"`:
```json
    "test:storage": "node --experimental-strip-types --test tests/storage-*.test.mjs",
```

- [ ] **Step 5: Run the self-test to verify it passes**

Run: `npm run test:storage`

Expected: PASS, 6 tests, 0 failures. An `ExperimentalWarning` for SQLite on stderr is expected and harmless.

- [ ] **Step 6: Confirm the full suite is unaffected**

Run: `node --experimental-strip-types --test --test-reporter=dot tests/*.test.mjs`

Expected: the Task 0.1 pass count + 6, 0 failures.

- [ ] **Step 7: Commit**

```bash
git add tests/helpers/fake-worker-env.mjs tests/storage-fake-worker-env.test.mjs package.json
git commit -m "test: add strict D1/R2 doubles for storage tests

node:sqlite-backed D1 fake that rejects undefined binds and runs batch()
as a transaction, a Map-backed R2 fake, and resolve hooks for
cloudflare:workers and the @/ alias. Used by the remediation phases.

Co-Authored-By: <model trailer>"
```

---

### Task 0.3: Typecheck gate and a verify job before deploy

**Files:**
- Create: `scripts/typecheck-baseline.mjs`
- Create: `scripts/typecheck-baseline.json`
- Modify: `.github/workflows/deploy.yml`

**Interfaces:**
- Consumes: `N` from Task 0.1 Step 3.
- Produces: `node scripts/typecheck-baseline.mjs` exits 0 when `tsc` reports at most `N` errors and 1 otherwise. Every later phase uses it as the typecheck gate.

- [ ] **Step 1: Write the baseline file**

Create `scripts/typecheck-baseline.json`, replacing `14` with the real `N` from Task 0.1:
```json
{ "errors": 14 }
```

- [ ] **Step 2: Write the gate script**

Create `scripts/typecheck-baseline.mjs`:
```js
// `npm run typecheck` is not pass/fail: errors that pre-date the review sit in
// the tree (see CLAUDE.md). This makes it one anyway: fail when tsc reports more
// errors than the recorded baseline, so a change can pay the debt down (then
// lower the number in typecheck-baseline.json) but never add to it.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const { errors: allowed } = JSON.parse(readFileSync(new URL("./typecheck-baseline.json", import.meta.url), "utf8"));
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const run = spawnSync(process.execPath, [tsc, "--noEmit"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
const count = (output.match(/error TS\d+/g) ?? []).length;
console.log(`tsc: ${count} error(s); baseline allows ${allowed}.`);
if (count > allowed) {
  console.log(output);
  process.exit(1);
}
```

- [ ] **Step 3: Verify the gate passes at baseline and fails above it**

Run: `node scripts/typecheck-baseline.mjs; echo "exit $?"`

Expected: `tsc: N error(s); baseline allows N.` then `exit 0`.

Then temporarily set `"errors"` to `N - 1` in the JSON file.

Run: `node scripts/typecheck-baseline.mjs > /dev/null; echo "exit $?"`

Expected: `exit 1`. Restore the JSON to `N`.

- [ ] **Step 4: Add the verify job**

Replace the top of `.github/workflows/deploy.yml`, from `name:` through the line `    runs-on: ubuntu-latest` of the `deploy` job, with:
```yaml
name: Deploy to Cloudflare

on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch: {}

jobs:
  # Runs on every pull request and before every deploy. A red test, a lint
  # error or a NEW type error stops the deploy; pre-existing type errors are
  # allowed up to scripts/typecheck-baseline.json.
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Lint
        run: npm run lint

      - name: Tests
        run: npm run test:transitions

      - name: Typecheck (no new errors)
        run: node scripts/typecheck-baseline.mjs

  deploy:
    needs: verify
    if: github.event_name != 'pull_request'
    # Moved here from the workflow level so pull-request verify runs never
    # queue behind (or hold up) a production deploy.
    concurrency:
      group: deploy-production
      cancel-in-progress: false
    runs-on: ubuntu-latest
```
Delete the old workflow-level `concurrency:` block (the three lines `concurrency:`, `  group: deploy-production`, `  cancel-in-progress: false`). Leave everything from `    steps:` in the `deploy` job unchanged.

- [ ] **Step 5: Validate the YAML locally**

Run: `node -e "const t=require('fs').readFileSync('.github/workflows/deploy.yml','utf8'); for (const k of ['verify:','needs: verify','pull_request:','scripts/typecheck-baseline.mjs']) if(!t.includes(k)) {console.error('missing',k); process.exit(1)} console.log('ok')"`

Expected: `ok`.

- [ ] **Step 6: Commit**

```bash
git add scripts/typecheck-baseline.mjs scripts/typecheck-baseline.json .github/workflows/deploy.yml
git commit -m "ci: verify lint, tests and typecheck before deploying

deploy.yml built and deployed without running any check. A verify job
now runs lint, the full node:test suite and a no-new-errors typecheck
gate on pull requests and before every deploy.

Co-Authored-By: <model trailer>"
```

- [ ] **Step 7: Linux dry run (needs the user's go-ahead to push)**

The suite has only been run on Windows. Ask the user before pushing a branch. With approval, push a branch and open a draft PR; the `pull_request` trigger runs `verify` without deploying. If a test fails only on Linux, fix it in this task and don't loosen the gate. If the user declines, record "Linux dry run pending" in `.test-work/baseline/SUMMARY.md`.

---

## Phase 0 exit criteria

- `npm run test:storage` passes (6 tests).
- `node --experimental-strip-types --test --test-reporter=dot tests/*.test.mjs` passes with baseline + 6 tests.
- `node scripts/typecheck-baseline.mjs` exits 0.
- `.test-work/baseline/SUMMARY.md` exists with real numbers.
- `CLAUDE.md` is **not** edited in this phase. The test-count correction lands in the Phase 4 docs task, together with the other documentation changes.
