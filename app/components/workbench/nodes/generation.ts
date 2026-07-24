// Framework-free pure core shared by the imageGenerate/imageEdit manifests
// and their DOM-side execute wrappers: request building and response mapping
// only. This module must stay importable by Node's --experimental-strip-types
// test runner, so runtime imports carry explicit .ts extensions and nothing
// here touches the DOM at module scope.

import { estimateRunUsd } from "../cost.ts";
import type { CostEstimateInput, ImportParamRule, NodeOutputValue, WorkbenchParams } from "../types";

export const GENERATION_SIZES = ["1024x1024", "1536x1024", "1024x1536", "2048x2048", "2560x1440"] as const;
export const GENERATION_QUALITIES = ["low", "medium", "high"] as const;

// Import-validation rules shared by both generation-shaped nodes.
export const GENERATION_PARAM_RULES = {
  size: { type: "enum", optional: true, values: GENERATION_SIZES },
  quality: { type: "enum", optional: true, values: GENERATION_QUALITIES },
  candidates: { type: "number", optional: true, integer: true, min: 1, max: 4 },
} satisfies Record<string, ImportParamRule>;

export type GenerationPayload = { prompt: string; size: string; quality: string; n: number };

export function promptTextsFrom(values: NodeOutputValue[]): string[] {
  return values.map((value) => (value.kind === "text" ? value.text : "")).filter(Boolean);
}

// Pure request-building core: validates the prompt inputs and shapes the
// /api/workbench/edit payload from the node's (effective) params.
export function buildGenerationPayload(params: WorkbenchParams, promptValues: NodeOutputValue[]): GenerationPayload {
  const promptParts = promptTextsFrom(promptValues);
  if (!promptParts.length) throw new Error("Connect a prompt (Text or Prompt Builder) first.");
  return {
    prompt: promptParts.join("\n"),
    size: params.size || "1536x1024",
    quality: params.quality || "medium",
    n: params.candidates || 1,
  };
}

// Pure response-mapping core: one base64 payload entry to raw bytes.
export function decodeBase64Image(base64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

// Ordered blob-cache keys behind one upstream value: an image passes its own
// cacheKey through; a references value expands to its items' imageKeys,
// following the value's `order` (item ids). Other kinds carry no image data.
export function imageCacheKeysFromValue(value: NodeOutputValue): string[] {
  if (value.kind === "image") return [value.cacheKey];
  if (value.kind === "references") {
    const byId = new Map(value.items.map((item) => [item.id, item]));
    const orderedIds = value.order.length ? value.order : value.items.map((item) => item.id);
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const id of orderedIds) {
      const item = byId.get(id);
      if (!item || seen.has(id)) continue;
      seen.add(id);
      keys.push(...item.imageKeys);
    }
    return keys;
  }
  return [];
}

export function estimateGenerationCost({ params, inputImages }: CostEstimateInput): number | null {
  return estimateRunUsd({
    size: params.size || "1536x1024",
    quality: params.quality || "medium",
    candidates: params.candidates || 1,
    inputImages,
  });
}

// Draft mode's cheaper variant: same request shape, lowest quality tier.
export function generationDraftOverride(params: WorkbenchParams): WorkbenchParams {
  return { ...params, quality: "low" };
}
