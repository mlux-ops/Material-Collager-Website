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
