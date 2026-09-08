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
