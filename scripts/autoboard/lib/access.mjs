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
