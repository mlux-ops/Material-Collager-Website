import assert from "node:assert/strict";
import test from "node:test";

import { getAccessToken, verifyAccessJwt } from "../worker/access.ts";

const KID = "test-key-1";
const AUD = "aud-tag-material-collager";
const ISSUER = "https://shb-studio.cloudflareaccess.com";
const NOW = 1_753_200_000;

const { publicKey, privateKey } = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  false,
  ["sign", "verify"],
);
const { privateKey: strangerPrivateKey } = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  false,
  ["sign", "verify"],
);

function encodeSegment(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

async function signToken({ header, payload, key = privateKey }) {
  const signedPart = `${encodeSegment(header)}.${encodeSegment(payload)}`;
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    new TextEncoder().encode(signedPart),
  );
  return `${signedPart}.${Buffer.from(signature).toString("base64url")}`;
}

function validPayload(overrides = {}) {
  return {
    aud: [AUD],
    iss: ISSUER,
    exp: NOW + 3600,
    nbf: NOW - 60,
    email: "teammate@shb.studio",
    ...overrides,
  };
}

const verifyOptions = {
  aud: AUD,
  issuer: ISSUER,
  getKey: async (kid) => (kid === KID ? publicKey : undefined),
  nowSeconds: NOW,
};

test("valid Access JWT verifies and exposes the payload", async () => {
  const token = await signToken({ header: { alg: "RS256", kid: KID }, payload: validPayload() });
  const result = await verifyAccessJwt(token, verifyOptions);
  assert.equal(result.ok, true);
  assert.equal(result.payload.email, "teammate@shb.studio");
});

test("string aud claim matching the expected audience verifies", async () => {
  const token = await signToken({ header: { alg: "RS256", kid: KID }, payload: validPayload({ aud: AUD }) });
  const result = await verifyAccessJwt(token, verifyOptions);
  assert.equal(result.ok, true);
});

test("expired token is rejected", async () => {
  const token = await signToken({ header: { alg: "RS256", kid: KID }, payload: validPayload({ exp: NOW - 3600 }) });
  const result = await verifyAccessJwt(token, verifyOptions);
  assert.deepEqual(result, { ok: false, reason: "token expired" });
});

test("token missing exp is rejected", async () => {
  const token = await signToken({ header: { alg: "RS256", kid: KID }, payload: validPayload({ exp: undefined }) });
  const result = await verifyAccessJwt(token, verifyOptions);
  assert.deepEqual(result, { ok: false, reason: "token expired" });
});

test("token not yet valid (future nbf) is rejected", async () => {
  const token = await signToken({ header: { alg: "RS256", kid: KID }, payload: validPayload({ nbf: NOW + 3600 }) });
  const result = await verifyAccessJwt(token, verifyOptions);
  assert.deepEqual(result, { ok: false, reason: "token not yet valid" });
});

test("audience mismatch is rejected", async () => {
  const token = await signToken({ header: { alg: "RS256", kid: KID }, payload: validPayload({ aud: ["some-other-app"] }) });
  const result = await verifyAccessJwt(token, verifyOptions);
  assert.deepEqual(result, { ok: false, reason: "audience mismatch" });
});

test("issuer mismatch is rejected", async () => {
  const token = await signToken({
    header: { alg: "RS256", kid: KID },
    payload: validPayload({ iss: "https://attacker.cloudflareaccess.com" }),
  });
  const result = await verifyAccessJwt(token, verifyOptions);
  assert.deepEqual(result, { ok: false, reason: "issuer mismatch" });
});

test("alg none is rejected before any signature handling", async () => {
  const token = `${encodeSegment({ alg: "none", kid: KID })}.${encodeSegment(validPayload())}.`;
  const result = await verifyAccessJwt(token, verifyOptions);
  assert.deepEqual(result, { ok: false, reason: "unexpected algorithm" });
});

test("HS256 downgrade is rejected (algorithm confusion)", async () => {
  const token = await signToken({ header: { alg: "HS256", kid: KID }, payload: validPayload() });
  const result = await verifyAccessJwt(token, verifyOptions);
  assert.deepEqual(result, { ok: false, reason: "unexpected algorithm" });
});

test("token signed by a different key is rejected", async () => {
  const token = await signToken({
    header: { alg: "RS256", kid: KID },
    payload: validPayload(),
    key: strangerPrivateKey,
  });
  const result = await verifyAccessJwt(token, verifyOptions);
  assert.deepEqual(result, { ok: false, reason: "invalid signature" });
});

test("tampered payload is rejected", async () => {
  const token = await signToken({ header: { alg: "RS256", kid: KID }, payload: validPayload() });
  const [header, , signature] = token.split(".");
  const forged = `${header}.${encodeSegment(validPayload({ email: "intruder@evil.example" }))}.${signature}`;
  const result = await verifyAccessJwt(forged, verifyOptions);
  assert.deepEqual(result, { ok: false, reason: "invalid signature" });
});

test("unknown kid is rejected", async () => {
  const token = await signToken({ header: { alg: "RS256", kid: "rotated-away" }, payload: validPayload() });
  const result = await verifyAccessJwt(token, verifyOptions);
  assert.deepEqual(result, { ok: false, reason: "unknown signing key" });
});

test("malformed tokens are rejected without throwing", async () => {
  for (const garbage of ["", "a.b", "not-a-jwt", "!!.??.##", `${encodeSegment([1, 2])}.x.y`]) {
    const result = await verifyAccessJwt(garbage, verifyOptions);
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(garbage)}`);
  }
});

test("getAccessToken prefers the Access header over cookies", () => {
  const request = new Request("https://app.example", {
    headers: { "Cf-Access-Jwt-Assertion": "header-token", Cookie: "CF_Authorization=cookie-token" },
  });
  assert.equal(getAccessToken(request), "header-token");
});

test("getAccessToken falls back to the CF_Authorization cookie", () => {
  const request = new Request("https://app.example", {
    headers: { Cookie: "theme=dark; CF_Authorization=cookie-token; other=1" },
  });
  assert.equal(getAccessToken(request), "cookie-token");
});

test("getAccessToken returns null when no credential is present", () => {
  assert.equal(getAccessToken(new Request("https://app.example")), null);
  assert.equal(getAccessToken(new Request("https://app.example", { headers: { Cookie: "theme=dark" } })), null);
});
