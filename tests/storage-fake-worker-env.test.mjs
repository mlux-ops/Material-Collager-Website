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
