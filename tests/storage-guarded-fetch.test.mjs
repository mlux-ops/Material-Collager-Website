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

test("a redirect's body is cancelled before the next hop is requested", async (t) => {
  const events = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    events.push(`fetch ${String(url)}`);
    if (String(url) === "https://a.example/start") {
      return new Response(
        new ReadableStream({ cancel: () => events.push("cancel") }),
        { status: 302, headers: { location: "https://b.example/next" } },
      );
    }
    return new Response("ok", { status: 200 });
  });
  const { response } = await fetchPublic("https://a.example/start", { timeoutMs: 1000 });
  assert.equal(response.status, 200);
  // The order matters: the redirect's body must be released before the next
  // hop is requested, not merely at some point during the whole call.
  assert.deepEqual(events, ["fetch https://a.example/start", "cancel", "fetch https://b.example/next"]);
});

test("one timeout signal spans every hop, not a fresh one per hop", async (t) => {
  const signals = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    signals.push(init.signal);
    if (String(url) === "https://a.example/start") return new Response(null, { status: 302, headers: { location: "https://b.example/next" } });
    return new Response("ok", { status: 200 });
  });
  await fetchPublic("https://a.example/start", { timeoutMs: 1000 });
  assert.equal(signals.length, 2);
  // Guards against both hops simply passing `undefined` (init.signal), which
  // would also satisfy a bare `signals[0] === signals[1]`.
  assert.ok(signals[0] instanceof AbortSignal, "a real AbortSignal must be passed, not undefined");
  assert.equal(signals[0], signals[1], "the same AbortSignal instance must govern every hop");
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

test("a non-redirect 3xx status is returned to the caller, not followed", async (t) => {
  const requested = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    requested.push(String(url));
    // A real Location header on a status fetchPublic must NOT treat as a
    // redirect: following it anyway would be exactly the bug being fixed.
    return new Response(null, { status: 304, headers: { location: "https://should-not-be-followed.example/" } });
  });
  const { response, url } = await fetchPublic("https://vendor.example/photo.jpg", { timeoutMs: 1000 });
  assert.equal(response.status, 304);
  assert.equal(url.toString(), "https://vendor.example/photo.jpg");
  assert.deepEqual(requested, ["https://vendor.example/photo.jpg"]);
});

test("private, trailing-dot and empty-label hostnames are all refused without a request", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls += 1; return new Response("x"); });
  for (const url of [
    "https://[::1]/x.png",
    "https://0.0.0.0/x.png",
    "https://metadata.google.internal/x.png",
    "http://vendor.example/x.png",
    // A trailing dot (bare or percent-encoded) is a no-op in DNS, and the old
    // reference-import regex (a prefix match on ^localhost) refused it; the
    // hostname-set/suffix checks below must not let it back in (R11).
    "https://localhost./x.png",
    "https://localhost%2e/x.png",
    "https://foo.localhost./x.png",
    "https://metadata.google.internal./x.png",
    "https://LOCALHOST./x.png",
    // An empty label is never a valid DNS name, so these must be refused too.
    "https://10.1../x.png",
    "https://localhost../x.png",
  ]) {
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
  assert.equal(counters.reads, 0, "the body must not be pulled at all when Content-Length alone is decisive");
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

// The route imports "@/…" modules; the helper's resolve hook maps the alias.
await import("./helpers/fake-worker-env.mjs");
const { POST: importReference } = await import("../app/api/references/import/route.ts");

test("reference import refuses a redirect to loopback without requesting it (R11)", async (t) => {
  const requested = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requested.push([String(url), init.redirect]);
    return new Response(null, { status: 302, headers: { location: "https://[::1]/secret" } });
  });
  const response = await importReference(new Request("http://localhost/api/references/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ imageUrl: "https://vendor.example/p.jpg" }),
  }));
  // notEqual(status, 200) alone would already pass before the fix too — the
  // mocked 302 has response.ok === false, so the OLD code's `!response.ok`
  // check already threw (never reaching safeRemoteUrl(response.url) at all)
  // — assert the actual refusal instead of merely "not success".
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /not a public host/);
  assert.deepEqual(requested, [["https://vendor.example/p.jpg", "manual"]]);
});

const { POST: findMatches } = await import("../app/api/references/matches/route.ts");
// Placeholder, not a real key.
const NOT_A_REAL_KEY = ["placeholder", "only"].join("-");

test("match discovery's image check goes through the guard, not a raw fetch (R11)", async (t) => {
  const requested = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const href = String(url);
    requested.push([href, init?.redirect]);
    if (href === "https://api.openai.com/v1/responses") {
      return Response.json({
        output_text: JSON.stringify({
          candidates: [{
            title: "Test widget",
            pageUrl: "https://vendor.example/product",
            imageUrl: "https://vendor.example/product.jpg",
            sourceLabel: "Vendor",
            official: true,
            confidence: 90,
            reason: "test",
          }],
        }),
      });
    }
    return new Response("img", { status: 200, headers: { "content-type": "image/jpeg" } });
  });
  const response = await findMatches(new Request("http://localhost/api/references/matches", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "Test widget", apiKey: NOT_A_REAL_KEY }),
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.candidates[0].imageUrl, "https://vendor.example/product.jpg");
  // A revert of isRemoteImage/discoverProductImage to a raw `fetch(..., { redirect:
  // "follow" })` would still pass every assertion above; this is the one that
  // would catch it.
  const imageCall = requested.find(([href]) => href === "https://vendor.example/product.jpg");
  assert.ok(imageCall, "expected a fetch of the candidate's image URL");
  assert.equal(imageCall[1], "manual", "isRemoteImage must go through fetchPublic, not a raw follow-fetch");
});

test("discoverProductImage's page fetch goes through the guard, and safeHttps drops a loopback pageUrl before any request (R11)", async (t) => {
  const requested = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const href = String(url);
    requested.push([href, init?.redirect]);
    if (href === "https://api.openai.com/v1/responses") {
      return Response.json({
        output_text: JSON.stringify({
          candidates: [
            {
              // No usable imageUrl of its own: hydrateCandidateImage must fall
              // through to discoverProductImage, which reads the page's own
              // og:image — the one path the round-1 test never exercised.
              title: "Page-derived widget",
              pageUrl: "https://vendor.example/page",
              imageUrl: "",
              sourceLabel: "Vendor",
              official: false,
              confidence: 50,
              reason: "test",
            },
            {
              // safeHttps must neutralize this before normalizeCandidate's
              // result even reaches the pageUrl filter — it must never be
              // fetched, loopback-via-trailing-dot or otherwise.
              title: "Loopback attempt",
              pageUrl: "https://localhost./p",
              imageUrl: "",
              sourceLabel: "Vendor",
              official: false,
              confidence: 50,
              reason: "test",
            },
            {
              // The pre-guard regex (a prefix match on hostname) refused
              // "localhost" but never handled an IPv6 literal at all, so this
              // one is what actually distinguishes safeHttps from that regex:
              // a revert would let it survive into the response below.
              title: "IPv6 loopback attempt",
              pageUrl: "https://[::1]/p",
              imageUrl: "",
              sourceLabel: "Vendor",
              official: false,
              confidence: 50,
              reason: "test",
            },
          ],
        }),
      });
    }
    if (href === "https://vendor.example/page") {
      return new Response(
        '<html><head><meta property="og:image" content="https://vendor.example/hero.jpg"></head></html>',
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }
    if (href === "https://vendor.example/hero.jpg") {
      return new Response("img", { status: 200, headers: { "content-type": "image/jpeg" } });
    }
    return new Response("not found", { status: 404 });
  });
  const response = await findMatches(new Request("http://localhost/api/references/matches", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "Test widget", apiKey: NOT_A_REAL_KEY }),
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  // The loopback candidate never survives normalizeCandidate + the pageUrl
  // filter, so only the page-derived one comes back.
  assert.equal(body.candidates.length, 1);
  assert.equal(body.candidates[0].imageUrl, "https://vendor.example/hero.jpg");
  const pageCall = requested.find(([href]) => href === "https://vendor.example/page");
  assert.ok(pageCall, "expected a fetch of the candidate's pageUrl");
  assert.equal(pageCall[1], "manual", "discoverProductImage must go through fetchPublic, not a raw follow-fetch");
  assert.ok(
    !requested.some(([href]) => href.includes("localhost") || href.includes("[::1]")),
    "a pageUrl safeHttps rejects must never be requested at all",
  );
});
