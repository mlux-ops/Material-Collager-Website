import type { CostEstimateInput, NodeManifest, ReferenceMatchCandidate } from "../types";

// Flat per-call estimate for a single web-search/match call — NOT the
// generation-image estimator. The subsequent import fetch is a client
// download, not a billed call.
const FINDER_CALL_USD = 0.02;

export function estimateFinderCost(_input: CostEstimateInput): number | null {
  return FINDER_CALL_USD;
}

type MatchesResponse = { ok: boolean; error?: string; candidates?: ReferenceMatchCandidate[] };

// Human-in-the-loop node: POST /api/references/matches returns candidates,
// the executor halts in a "needs selection" state (downstream idle, not
// run) via ctx.setAwaitingSelection — see executor.ts's post-execute status
// check. Picking a candidate (referenceFinder.tsx) POSTs
// /api/references/import (RAW image bytes, not a JSON envelope) into the blob
// cache and resumes the paused run. NO draftOverride (W5): matching has no
// cheaper draft variant.
//
// This execute is a plain JSON call (no image transport), so it stays
// framework-free here rather than moving to a .tsx DOM wrapper — nothing it
// does touches the DOM or blob cache; only the candidate-pick handler in
// referenceFinder.tsx does.
export const referenceFinderManifest: NodeManifest = {
  kind: "referenceFinder",
  spec: {
    kind: "referenceFinder",
    title: "Reference Finder",
    description: "Search the web for a matching product image and import your pick.",
    inputs: [{ id: "query", kind: "text", label: "Query", required: true }],
    outputs: [{ id: "image", kind: "image", label: "Image" }],
    paid: true,
  },
  defaultParams: { matchQuery: "" },
  importSchema: {
    paramKeys: {
      matchQuery: { type: "string", optional: true, maxLength: 400 },
    },
    sourceBlobKeys: [],
  },
  estimateCost: estimateFinderCost,
  paid: true,
  execute: async (ctx) => {
    const upstream = ctx.inputs("query").map((value) => (value.kind === "text" ? value.text : "")).filter(Boolean);
    const query = (ctx.params.matchQuery?.trim() || upstream.join(" ").trim());
    if (!query) throw new Error("Connect a search query (e.g. from Reference Analyzer) first.");

    ctx.setProgress("Searching…");
    const response = await fetch("/api/references/matches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, itemType: ctx.params.itemType }),
      signal: ctx.signal,
    });
    const payload = (await response.json()) as MatchesResponse;
    if (!response.ok || !payload.ok) throw new Error(payload.error || "Could not search for matching references.");

    ctx.setAwaitingSelection({ query, candidates: payload.candidates ?? [] });
  },
};
