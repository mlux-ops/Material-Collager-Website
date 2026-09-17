// Minimal TypeSafe System One client for the experiments in this directory.
// Contract per https://docs.typesafe.ai/api.md:
//   POST https://api.typesafe.ai/v1/systemone
//   { state, model, questions: { <id>: { type, instructions, criteria } } }
//   -> { model, answers: { <id>: Answer }, usage: { input_tokens, output_tokens } }
//
// The key is read from TYPESAFE_API_KEY, or from the repo's git-ignored
// .dev.vars, which is where this project already keeps local secrets. A key
// held only as a Cloudflare Worker secret is NOT readable here: Worker secrets
// are write-only, so `wrangler secret list` returns names without values.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const MODEL = "jev-latest";

export function loadApiKey({ cwd = process.cwd() } = {}) {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY.trim();
  const devVars = path.join(cwd, ".dev.vars");
  if (existsSync(devVars)) {
    for (const line of readFileSync(devVars, "utf8").split(/\r?\n/)) {
      const match = /^\s*TYPESAFE_API_KEY\s*=\s*(.+)$/.exec(line);
      if (match) return match[1].trim().replace(/^["']|["']$/g, "");
    }
  }
  throw new Error(
    "No TYPESAFE_API_KEY. Set it in the environment or add TYPESAFE_API_KEY=... to the git-ignored .dev.vars. " +
      "A key stored only as a Cloudflare Worker secret cannot be read back — it is readable solely as env.TYPESAFE_API_KEY inside a deployed Worker.",
  );
}

// 429/529 are the documented retryable statuses.
const RETRYABLE = new Set([429, 529]);

export async function ask({ state, questions, apiKey, model = MODEL, attempts = 4, fetchImpl = fetch }) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const startedAt = Date.now();
    let response;
    try {
      response = await fetchImpl(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ state, model, questions }),
      });
    } catch (error) {
      lastError = error;
      await sleep(2 ** attempt * 1000);
      continue;
    }
    const latencyMs = Date.now() - startedAt;
    if (response.ok) {
      const json = await response.json();
      return { ...json, latencyMs };
    }
    const body = await response.text().catch(() => "");
    lastError = new Error(`HTTP ${response.status} — ${body.slice(0, 400)}`);
    // 401 and 422 are our fault; retrying cannot fix them.
    if (!RETRYABLE.has(response.status)) throw lastError;
    await sleep(2 ** attempt * 1000);
  }
  throw lastError;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
