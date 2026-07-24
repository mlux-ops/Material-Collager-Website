/**
 * Cloudflare Access JWT validation — defense-in-depth behind the Access proxy.
 *
 * When Cloudflare Access is enabled on the workers.dev domain, every request
 * that passed the Access login carries a signed JWT (`Cf-Access-Jwt-Assertion`
 * header, mirrored in the `CF_Authorization` cookie). Verifying it here
 * guarantees requests cannot reach the app except through Access, even if the
 * Access application is later misconfigured or a new route bypasses it.
 * Setup: docs/DEPLOYING.md ("Cloudflare Access" section).
 */

export interface AccessEnv {
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
}

export interface AccessJwtPayload {
  aud?: string | string[];
  iss?: string;
  exp?: number;
  nbf?: number;
  email?: string;
}

export type VerifyResult =
  | { ok: true; payload: AccessJwtPayload }
  | { ok: false; reason: string };

export interface VerifyOptions {
  /** Expected audience tag of the Access application. */
  aud: string;
  /** Expected issuer, e.g. "https://team.cloudflareaccess.com". */
  issuer: string;
  /** Resolves the RSA public key for a JWT `kid`; injectable for tests. */
  getKey: (kid: string) => Promise<CryptoKey | undefined>;
  /** Current time in seconds since epoch; injectable for tests. */
  nowSeconds?: number;
}

// Access rotates signing keys; tolerate this much clock skew on exp/nbf.
const CLOCK_SKEW_SECONDS = 60;

function decodeBase64Url(segment: string): Uint8Array | null {
  try {
    const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function decodeJsonSegment(segment: string): Record<string, unknown> | null {
  const bytes = decodeBase64Url(segment);
  if (!bytes) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export async function verifyAccessJwt(token: string, options: VerifyOptions): Promise<VerifyResult> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed token" };
  const [headerSegment, payloadSegment, signatureSegment] = parts;

  const header = decodeJsonSegment(headerSegment);
  if (!header) return { ok: false, reason: "malformed header" };
  // Pin the algorithm Access uses; accepting the header's word for it enables
  // algorithm-confusion downgrades ("none", HS256-with-public-key).
  if (header.alg !== "RS256") return { ok: false, reason: "unexpected algorithm" };
  if (typeof header.kid !== "string" || header.kid.length === 0) {
    return { ok: false, reason: "missing kid" };
  }

  const key = await options.getKey(header.kid);
  if (!key) return { ok: false, reason: "unknown signing key" };

  const signature = decodeBase64Url(signatureSegment);
  if (!signature) return { ok: false, reason: "malformed signature" };
  const signedBytes = new TextEncoder().encode(`${headerSegment}.${payloadSegment}`);
  const signatureValid = await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    signature.buffer as ArrayBuffer,
    signedBytes,
  );
  if (!signatureValid) return { ok: false, reason: "invalid signature" };

  const payload = decodeJsonSegment(payloadSegment) as AccessJwtPayload | null;
  if (!payload) return { ok: false, reason: "malformed payload" };

  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || now > payload.exp + CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: "token expired" };
  }
  if (typeof payload.nbf === "number" && now < payload.nbf - CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: "token not yet valid" };
  }
  if (payload.iss !== options.issuer) return { ok: false, reason: "issuer mismatch" };

  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(options.aud)) return { ok: false, reason: "audience mismatch" };

  return { ok: true, payload };
}

export function getAccessToken(request: Request): string | null {
  const headerToken = request.headers.get("Cf-Access-Jwt-Assertion");
  if (headerToken) return headerToken;
  const cookies = request.headers.get("Cookie");
  if (!cookies) return null;
  for (const pair of cookies.split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1) continue;
    if (pair.slice(0, separator).trim() === "CF_Authorization") {
      return pair.slice(separator + 1).trim() || null;
    }
  }
  return null;
}

interface JwksCache {
  byKid: Map<string, CryptoKey>;
  fetchedAtMs: number;
}

const JWKS_TTL_MS = 60 * 60 * 1000;
const JWKS_RETRY_INTERVAL_MS = 60 * 1000;
let jwksCache: JwksCache | null = null;

async function fetchJwks(teamDomain: string): Promise<JwksCache> {
  const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error(`Access JWKS fetch failed: HTTP ${response.status}`);
  const body = (await response.json()) as { keys?: Array<JsonWebKey & { kid?: string }> };
  const byKid = new Map<string, CryptoKey>();
  for (const jwk of body.keys ?? []) {
    if (jwk.kty !== "RSA" || typeof jwk.kid !== "string") continue;
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    byKid.set(jwk.kid, key);
  }
  return { byKid, fetchedAtMs: Date.now() };
}

async function getAccessSigningKey(teamDomain: string, kid: string): Promise<CryptoKey | undefined> {
  const age = jwksCache ? Date.now() - jwksCache.fetchedAtMs : Infinity;
  const cachedKey = jwksCache?.byKid.get(kid);
  if (cachedKey && age < JWKS_TTL_MS) return cachedKey;
  // Unknown kid usually means key rotation; refetch, but not more than once
  // per minute so a forged kid cannot turn every request into a JWKS fetch.
  if (age < JWKS_RETRY_INTERVAL_MS) return cachedKey;
  jwksCache = await fetchJwks(teamDomain);
  return jwksCache.byKid.get(kid);
}

function forbidden(): Response {
  return new Response("Forbidden", { status: 403 });
}

/**
 * Returns a 403 response when the request lacks a valid Access JWT, or null
 * when the request may proceed. Enforcement is enabled by configuring both
 * CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD (wrangler.jsonc "vars"); local dev
 * has no Access proxy in front, so both stay unset there and requests pass.
 */
export async function enforceAccessJwt(request: Request, env: AccessEnv): Promise<Response | null> {
  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN;
  const aud = env.CF_ACCESS_AUD;
  if (!teamDomain && !aud) return null;
  if (!teamDomain || !aud) {
    // Half-configured enforcement is a deployment mistake; fail closed rather
    // than silently serving the app unprotected.
    console.error("Access enforcement misconfigured: CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD must both be set");
    return forbidden();
  }

  const token = getAccessToken(request);
  if (!token) {
    console.warn("Access enforcement rejected request: no Access JWT present");
    return forbidden();
  }

  let result: VerifyResult;
  try {
    result = await verifyAccessJwt(token, {
      aud,
      issuer: `https://${teamDomain}`,
      getKey: (kid) => getAccessSigningKey(teamDomain, kid),
    });
  } catch (error) {
    // JWKS fetch failure: fail closed. Access itself is still in front; this
    // path only triggers when Cloudflare's certs endpoint is unreachable.
    console.error("Access enforcement error while verifying JWT", error);
    return forbidden();
  }
  if (!result.ok) {
    console.warn(`Access enforcement rejected request: ${result.reason}`);
    return forbidden();
  }
  return null;
}
