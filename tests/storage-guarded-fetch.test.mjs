import assert from "node:assert/strict";
import test from "node:test";
import { MAX_REDIRECTS, fetchPublic, readCapped } from "../app/lib/guarded-fetch.ts";

test("a redirect to a private host is refused before it is requested (R11)", async (t) => {
  const requested = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requested.push({ url: String(url), redirect: init.redirect });
    return new Response(null, { status: 302, headers: { location: "https://127.0.0.1/admin" } });
  });
  // 127.0.0.1 is in photo-sources.ts's explicit BLOCKED_HOSTNAMES set, so
  // assertFetchableUrl refuses it as "not a public host" rather than via the
  // isPrivateIpv4 "private address" branch; both are the same guard refusing
  // the same hop, so either wording satisfies this check.
  await assert.rejects(fetchPublic("https://vendor.example/photo.jpg", { timeoutMs: 1000 }), /private address|not a public host/);
  assert.deepEqual(requested, [{ url: "https://vendor.example/photo.jpg", redirect: "manual" }]);
});

test("public redirects are followed hop by hop, resolving relative locations", async (t) => {
  const requested = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    requested.push(String(url));
    if (String(url) === "https://a.example/start") return new Response(null, { status: 301, headers: { location: "https://b.example/next" } });
    if (String(url) === "https://b.example/next") return new Response(null, { status: 302, headers: { location: "/final.jpg" } });
    return new Response("ok", { status: 200, headers: { "content-type": "image/jpeg" } });
  });
  const { response, url } = await fetchPublic("https://a.example/start", { timeoutMs: 1000 });
  assert.equal(response.status, 200);
  assert.equal(url.toString(), "https://b.example/final.jpg");
  assert.deepEqual(requested, ["https://a.example/start", "https://b.example/next", "https://b.example/final.jpg"]);
});

test("a redirect chain longer than the cap is refused", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return new Response(null, { status: 302, headers: { location: `https://hop${calls}.example/` } });
  });
  await assert.rejects(fetchPublic("https://start.example/", { timeoutMs: 1000 }), /redirected more than/);
  assert.equal(calls, MAX_REDIRECTS + 1);
});

test("hosts the old reference-import regex let through are refused without a request", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls += 1; return new Response("x"); });
  for (const url of ["https://[::1]/x.png", "https://0.0.0.0/x.png", "https://metadata.google.internal/x.png", "http://vendor.example/x.png"]) {
    await assert.rejects(fetchPublic(url, { timeoutMs: 1000 }), Error, url);
  }
  assert.equal(calls, 0);
});

// A body the test controls chunk by chunk; highWaterMark 0 so nothing is
// pulled before the reader asks.
function stream(chunks, counters) {
  return new ReadableStream({
    pull(controller) {
      if (counters.reads >= chunks.length) return controller.close();
      controller.enqueue(chunks[counters.reads]);
      counters.reads += 1;
    },
    cancel() {
      counters.cancelled = true;
    },
  }, { highWaterMark: 0 });
}

test("an oversized body with no Content-Length is cancelled as soon as it passes the cap (R10)", async () => {
  const counters = { reads: 0, cancelled: false };
  const mib = new Uint8Array(1024 * 1024);
  await assert.rejects(readCapped(new Response(stream([mib, mib, mib, mib], counters)), 2 * 1024 * 1024 - 1), /over the size limit/);
  assert.equal(counters.cancelled, true);
  assert.ok(counters.reads < 4, `read ${counters.reads} of 4 chunks`);
});

test("a declared Content-Length over the cap is refused without reading the body", async () => {
  const counters = { reads: 0, cancelled: false };
  const response = new Response(stream([new Uint8Array(10)], counters), { headers: { "content-length": String(10 * 1024 * 1024) } });
  await assert.rejects(readCapped(response, 1024, { tooLarge: "too big" }), /too big/);
  assert.equal(counters.cancelled, true);
});

test("a Content-Length that understates the body does not let it through", async () => {
  const counters = { reads: 0, cancelled: false };
  const chunk = new Uint8Array(1024);
  const response = new Response(stream([chunk, chunk, chunk], counters), { headers: { "content-length": "10" } });
  await assert.rejects(readCapped(response, 2048), /over the size limit/);
});

test("truncate mode keeps the first bytes of an oversized page and stops reading", async () => {
  const counters = { reads: 0, cancelled: false };
  const response = new Response(stream([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])], counters));
  assert.deepEqual(await readCapped(response, 4, { onOverflow: "truncate" }), new Uint8Array([1, 2, 3, 4]));
  assert.equal(counters.cancelled, true);
});

test("a body under the cap is returned whole", async () => {
  assert.deepEqual(await readCapped(new Response(new Uint8Array([7, 8, 9])), 3), new Uint8Array([7, 8, 9]));
});
