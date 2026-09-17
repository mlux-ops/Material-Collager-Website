// Where a reference photo may come from.
//
// assertFetchableUrl is a server-side SSRF guard: the review board fetches URLs
// that arrive from a Smartsheet cell, which is untrusted input, and a Worker's
// fetch reaches the network from inside the perimeter. extractImageUrls is what
// makes the sheet's reference column useful at all, since it holds product
// pages far more often than images.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_DISCOVERED_IMAGES,
  assertFetchableUrl,
  extractImageUrls,
  isImageContentType,
  isLowResolution,
} from "../app/lib/autoboard/photo-sources.ts";

test("assertFetchableUrl accepts an ordinary vendor URL", () => {
  const url = assertFetchableUrl("https://www.fergusonhome.com/thermador-mc30wp/s1655894");
  assert.equal(url.hostname, "www.fergusonhome.com");
  assert.equal(assertFetchableUrl("  https://images.example.com/a.jpg?v=2  ").pathname, "/a.jpg");
});

test("assertFetchableUrl refuses anything but https", () => {
  for (const bad of [
    "http://example.com/photo.jpg",
    "file:///etc/passwd",
    "data:image/png;base64,iVBORw0KGgo=",
    "ftp://example.com/a.jpg",
    "javascript:alert(1)",
  ]) {
    assert.throws(() => assertFetchableUrl(bad), /Only https URLs/, `should refuse ${bad}`);
  }
});

test("assertFetchableUrl refuses hosts that are not on the public internet", () => {
  const cases = [
    // The cloud metadata endpoint is the reason this guard exists.
    ["https://169.254.169.254/latest/meta-data/", /private address/],
    ["https://metadata.google.internal/computeMetadata/v1/", /not a public host/],
    ["https://localhost/admin", /not a public host/],
    ["https://127.0.0.1:8787/api", /not a public host/],
    ["https://10.0.0.5/internal", /private address/],
    ["https://192.168.1.1/", /private address/],
    ["https://172.16.0.1/", /private address/],
    ["https://172.31.255.254/", /private address/],
    ["https://100.64.0.1/", /private address/],
    ["https://0.0.0.0/", /not a public host/],
    ["https://[::1]/", /not a public host/],
    ["https://db.internal/dump", /not a public host/],
    ["https://printer.local/", /not a public host/],
  ];
  for (const [bad, pattern] of cases) {
    assert.throws(() => assertFetchableUrl(bad), pattern, `should refuse ${bad}`);
  }
});

test("assertFetchableUrl does not refuse public addresses that merely look similar", () => {
  // 172.15 and 172.32 sit outside the private 172.16-172.31 block, and 100.128
  // outside the 100.64-100.127 CGNAT block. An over-broad guard that blocks
  // these silently breaks real vendor CDNs.
  for (const fine of ["https://172.15.0.1/a.jpg", "https://172.32.0.1/a.jpg", "https://100.128.0.1/a.jpg", "https://11.0.0.1/a.jpg"]) {
    assert.doesNotThrow(() => assertFetchableUrl(fine), `should allow ${fine}`);
  }
});

test("assertFetchableUrl reports an empty or unparseable value in words a person can act on", () => {
  assert.throws(() => assertFetchableUrl(""), /Give a URL/);
  assert.throws(() => assertFetchableUrl(null), /Give a URL/);
  assert.throws(() => assertFetchableUrl("not a url"), /is not a URL/);
});

test("isImageContentType reads the type without its parameters", () => {
  assert.equal(isImageContentType("image/jpeg"), true);
  assert.equal(isImageContentType("image/png; charset=binary"), true);
  assert.equal(isImageContentType("IMAGE/WEBP"), true);
  assert.equal(isImageContentType("text/html; charset=utf-8"), false);
  assert.equal(isImageContentType("image/gif"), false);
  assert.equal(isImageContentType(null), false);
});

// ---------------------------------------------------------------------------
// Page extraction
// ---------------------------------------------------------------------------

test("extractImageUrls reads Open Graph, Twitter and image_src, in that order", () => {
  const html = `
    <html><head>
      <link rel="image_src" href="/img/legacy.jpg">
      <meta name="twitter:image" content="https://cdn.example.com/twitter.jpg">
      <meta property="og:image" content="https://cdn.example.com/hero.jpg">
    </head><body></body></html>`;
  assert.deepEqual(extractImageUrls(html, "https://www.example.com/product/123"), [
    "https://cdn.example.com/hero.jpg",
    "https://cdn.example.com/twitter.jpg",
    "https://www.example.com/img/legacy.jpg",
  ]);
});

test("extractImageUrls survives the attribute orders and quoting real pages use", () => {
  const html = `
    <meta content='https://cdn.example.com/single.jpg' property='og:image' />
    <meta content=https://cdn.example.com/bare.jpg name=twitter:image>
    <META PROPERTY="OG:IMAGE:SECURE_URL" CONTENT="https://cdn.example.com/secure.jpg">`;
  assert.deepEqual(extractImageUrls(html, "https://www.example.com/p"), [
    "https://cdn.example.com/single.jpg",
    "https://cdn.example.com/secure.jpg",
    "https://cdn.example.com/bare.jpg",
  ]);
});

test("extractImageUrls resolves relative urls against the page and decodes entities", () => {
  const html = `
    <meta property="og:image" content="/img/hero.jpg">
    <meta name="twitter:image" content="https://cdn.example.com/a.jpg?w=1200&amp;h=800">`;
  assert.deepEqual(extractImageUrls(html, "https://www.example.com/catalog/product/123?x=1"), [
    "https://www.example.com/img/hero.jpg",
    "https://cdn.example.com/a.jpg?w=1200&h=800",
  ]);
});

test("extractImageUrls drops duplicates, junk, and anything the guard would refuse", () => {
  const html = `
    <meta property="og:image" content="https://cdn.example.com/hero.jpg">
    <meta property="og:image:url" content="https://cdn.example.com/hero.jpg">
    <meta name="twitter:image" content="">
    <meta property="og:image" content="product image coming soon">
    <meta property="og:image" content="http://cdn.example.com/insecure.jpg">
    <meta property="og:image" content="https://169.254.169.254/latest/meta-data/">
    <meta property="og:title" content="https://cdn.example.com/not-an-image-tag.jpg">`;
  assert.deepEqual(extractImageUrls(html, "https://www.example.com/p"), ["https://cdn.example.com/hero.jpg"]);
});

test("extractImageUrls caps how many it hands back", () => {
  const html = Array.from({ length: 20 }, (_, i) => `<meta property="og:image" content="https://cdn.example.com/${i}.jpg">`).join("\n");
  const urls = extractImageUrls(html, "https://www.example.com/p");
  assert.equal(urls.length, MAX_DISCOVERED_IMAGES);
  assert.equal(urls[0], "https://cdn.example.com/0.jpg");
});

test("extractImageUrls returns nothing for a page that declares no image", () => {
  assert.deepEqual(extractImageUrls("<html><body><img src='/chrome/logo.png'></body></html>", "https://www.example.com/p"), []);
  assert.deepEqual(extractImageUrls("", "https://www.example.com/p"), []);
});

// ---------------------------------------------------------------------------
// Resolution flag
// ---------------------------------------------------------------------------

test("isLowResolution flags a thin strip as well as a small photo", () => {
  assert.equal(isLowResolution(1200, 1200), false);
  assert.equal(isLowResolution(600, 600), false);
  assert.equal(isLowResolution(599, 1200), true); // short edge fails
  assert.equal(isLowResolution(400, 400), true);
  // A thin strip clears any long-edge floor while being a far worse reference
  // than a small square photo, which is why both edges are checked.
  assert.equal(isLowResolution(122, 1200), true);
});
