// FRAMEWORK-FREE core of the Multi-Run node: settings, chunk planning, resume,
// failure classification and the concurrent chunk runner. No DOM, React,
// "@/" alias or node: builtins, and explicit .ts extensions on runtime
// imports, so tests/*.test.mjs import it directly and drive it with a stubbed
// fetch and a fake clock. The DOM work (blob cache, object URLs, reference
// transport) lives in multiRun.tsx and is injected here as callbacks.

import type { NodeOutputValue, NodeRun, WorkbenchParams } from "../types";
import { ApiResponseError, readApiResponse } from "../../../lib/api-client.ts";
import { buildGenerationPayload, type GenerationPayload } from "./generation.ts";
import type { IpmLimiter } from "./ipm-limiter.ts";

export const MULTI_RUN_FORMATS = ["png", "webp"] as const;
export const MULTI_RUN_TOTAL_MAX = 150;
export const MULTI_RUN_TOTAL_DEFAULT = 20;
// The Images API takes n up to 10 per call.
export const MULTI_RUN_PER_CALL_MAX = 10;
export const MULTI_RUN_PER_CALL_DEFAULT = 10;
// The account's images-per-minute limit.
export const MULTI_RUN_IPM_MAX = 150;
export const MULTI_RUN_IPM_DEFAULT = 150;
// A non-quota 429 is retried at most this many times per chunk.
export const MULTI_RUN_MAX_RETRIES = 3;
// Used when a retryable 429 carries no Retry-After: 2 s, 4 s, 8 s.
const FALLBACK_RETRY_MS = 2_000;

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, number));
}

export type MultiRunSettings = { total: number; perCall: number; ipm: number };

// The node's effective settings. perCall is also clamped to the cap: a chunk
// larger than the images-per-minute cap could never be admitted.
export function multiRunSettings(params: WorkbenchParams): MultiRunSettings {
  const total = clampInteger(params.total, 1, MULTI_RUN_TOTAL_MAX, MULTI_RUN_TOTAL_DEFAULT);
  const ipm = clampInteger(params.ipm, 1, MULTI_RUN_IPM_MAX, MULTI_RUN_IPM_DEFAULT);
  const perCall = Math.min(ipm, clampInteger(params.perCall, 1, MULTI_RUN_PER_CALL_MAX, MULTI_RUN_PER_CALL_DEFAULT));
  return { total, perCall, ipm };
}

// The /api/workbench/edit payload shared by every chunk (each chunk sets its
// own n). Raster PNG or WebP only: anything else, JPEG included, falls back
// to PNG, and SVG/GIF are never offered.
export function multiRunPayload(params: WorkbenchParams, promptValues: NodeOutputValue[]): GenerationPayload {
  const outputFormat = params.outputFormat === "webp" ? "webp" : "png";
  return buildGenerationPayload({ ...params, outputFormat }, promptValues);
}

// One API call: `n` images, written to candidate indices [offset, offset + n)
// relative to the press's first new index. Offsets are fixed at planning time,
// so chunks finishing in any order can never collide on a cache key.
export type PlannedChunk = { index: number; offset: number; n: number };

// ceil(count / perCall) calls, each carrying n = min(perCall, remaining).
// References are billed once per call, so a press is only split into n=1
// calls when perCall is 1.
export function planChunks(count: number, perCall: number): PlannedChunk[] {
  const size = Math.max(1, Math.floor(perCall));
  const chunks: PlannedChunk[] = [];
  for (let offset = 0; offset < count; offset += size) {
    chunks.push({ index: chunks.length, offset, n: Math.min(size, count - offset) });
  }
  return chunks;
}

// What a press must still render. A run produced under the SAME signature
// (same prompt, references, settings and total) that holds fewer images than
// the total is resumed: only the remainder is rendered and merged into it.
// Anything else starts from nothing.
export function resumeStateFor(
  run: NodeRun | undefined,
  signature: string,
  total: number,
): { base: NodeRun | undefined; existing: NodeOutputValue[]; remaining: number } {
  if (!run || run.signature !== signature) return { base: undefined, existing: [], remaining: total };
  const existing = run.values[0] ?? [];
  return { base: run, existing, remaining: Math.max(0, total - existing.length) };
}

// The first unused candidate index: cache keys end in `:<index>` (the same
// convention Variations' grid sorts by), so new images continue after the
// highest index already in the run.
export function nextCandidateIndex(values: NodeOutputValue[]): number {
  let next = 0;
  for (const value of values) {
    if (value.kind !== "image") continue;
    const index = Number(value.cacheKey.split(":").at(-1));
    if (Number.isInteger(index) && index >= next) next = index + 1;
  }
  return next;
}

export type MultiRunTotals = {
  requests: number;
  images: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
};

export function emptyTotals(): MultiRunTotals {
  return { requests: 0, images: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0 };
}

// Running totals across every call that came back. They are stored nested
// under `multiRun` on purpose: the executor's applyRun teaches the shared
// output-token table from a run's TOP-LEVEL output_tokens, which must stay a
// single render's figure, never the sum of a whole burst.
export function addUsage(totals: MultiRunTotals, usage: unknown, images: number): MultiRunTotals {
  const record = usage && typeof usage === "object" ? (usage as Record<string, unknown>) : {};
  const read = (key: string) => (typeof record[key] === "number" && Number.isFinite(record[key]) ? (record[key] as number) : 0);
  return {
    requests: totals.requests + 1,
    images: totals.images + images,
    input_tokens: totals.input_tokens + read("input_tokens"),
    output_tokens: totals.output_tokens + read("output_tokens"),
    total_tokens: totals.total_tokens + read("total_tokens"),
  };
}

export function totalsOf(run: NodeRun | undefined): MultiRunTotals {
  const stored = run?.usage?.multiRun;
  if (!stored || typeof stored !== "object") return emptyTotals();
  const record = stored as Record<string, unknown>;
  const read = (key: string) => (typeof record[key] === "number" ? (record[key] as number) : 0);
  return {
    requests: read("requests"),
    images: read("images"),
    input_tokens: read("input_tokens"),
    output_tokens: read("output_tokens"),
    total_tokens: read("total_tokens"),
  };
}

// The run a press applies, or null when nothing new came back (an empty
// apply would only replace a good run with the same thing, or fake a result).
// `runId` is the caller's choice: the resumed run's own id when it is still
// the node's newest run (store.applyRun then replaces it in place, so
// downstream nodes reading the unchanged selected image are not invalidated),
// otherwise a fresh one.
export function buildMultiRunRun(options: {
  runId: string;
  signature: string;
  existing: NodeOutputValue[];
  added: NodeOutputValue[];
  total: number;
  totals: MultiRunTotals;
  at: number;
}): NodeRun | null {
  if (!options.added.length) return null;
  const added = [...options.added].sort((a, b) => nextCandidateIndex([a]) - nextCandidateIndex([b]));
  return {
    runId: options.runId,
    signature: options.signature,
    at: options.at,
    values: [[...options.existing, ...added]],
    usage: { multiRun: { ...options.totals } },
    target: options.total,
  };
}

// ---------------------------------------------------------------------------
// Failure policy (paid calls, fail-closed).
// ---------------------------------------------------------------------------

export type ChunkVerdict =
  | { kind: "abort" }
  | { kind: "retry"; waitMs: number }
  | { kind: "stop"; reason: string };

// How one failed call is handled.
// - The user's abort is an abort.
// - A 429 the route marked `retryable` is retried after its Retry-After. The
//   route sets `retryable` from isRetryableImageError (app/lib/image-edit.ts)
//   on the provider's own error, which is false for quota, billing and credit
//   429s; the browser only sees the JSON envelope, so the route's verdict is
//   what is read here. The provider rejected that request, so it was not
//   billed and repeating it is safe.
// - Everything else stops the press: a quota/billing 429, any other status
//   (a 5xx included -- the route may have been answered after OpenAI
//   accepted the render), and a network TypeError, where the request may
//   already have been accepted and billed and the browser cannot tell.
export function classifyChunkError(error: unknown, signal: AbortSignal, attempt: number): ChunkVerdict {
  if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return { kind: "abort" };
  if (error instanceof ApiResponseError) {
    const status = error.payload.status;
    if (status === 429 && error.payload.retryable === true) {
      const retryAfter = error.payload.retryAfterMs;
      const waitMs = typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter >= 0
        ? retryAfter
        : FALLBACK_RETRY_MS * 2 ** attempt;
      return { kind: "retry", waitMs };
    }
    if (status === 429) return { kind: "stop", reason: `the OpenAI quota or billing limit was reached (${error.message})` };
    return { kind: "stop", reason: error.message };
  }
  if (error instanceof TypeError) {
    return { kind: "stop", reason: "a request failed on the network; it may still have been billed, so it was not retried" };
  }
  return { kind: "stop", reason: error instanceof Error ? error.message : "a request failed" };
}

export type ChunkResponse = { ok: boolean; error?: string; images: string[]; mimeType: string; usage?: Record<string, unknown> };

export type RunChunksDeps = {
  fetchImpl: typeof fetch;
  // A fresh request body for one call of n images, built from the references
  // prepared once per press.
  buildForm: (n: number) => FormData;
  limiter: IpmLimiter;
  ipm: number;
  // The user's cancel. It stops anything not yet sent (calls waiting in the
  // limiter or for a retry) but deliberately NOT calls already sent: the
  // Worker does not forward a client disconnect to OpenAI
  // (enable_request_signal is off), so a sent call is rendered and billed
  // regardless, and aborting the browser's fetch would only throw the paid
  // images away for the next press to buy again.
  signal: AbortSignal;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  // Records one call's images. Called synchronously as each call returns, so
  // everything paid for is held by the caller even if the press later stops.
  onChunk: (chunk: PlannedChunk, response: ChunkResponse) => void;
  onProgress?: (delivered: number) => void;
  // Called once, on cancel, with how many calls are still out.
  onCancelWait?: (inFlight: number) => void;
  maxRetries?: number;
  endpoint?: string;
};

export type RunChunksOutcome = { aborted: boolean; stopReason?: string; delivered: number };

// Runs every chunk concurrently, each admitted by the shared images-per-minute
// limiter before it is sent. The first failure that must not be retried stops
// the press, and so does cancel: no new call launches (chunks still queued in
// the limiter leave without sending, and a chunk admitted but not yet sent
// gives its slots back), while calls already in flight are allowed to finish
// so what they paid for is recorded. Settles only once every chunk has.
export async function runChunks(chunks: PlannedChunk[], deps: RunChunksDeps): Promise<RunChunksOutcome> {
  const stop = new AbortController();
  const gate = AbortSignal.any([deps.signal, stop.signal]);
  const maxRetries = deps.maxRetries ?? MULTI_RUN_MAX_RETRIES;
  const endpoint = deps.endpoint ?? "/api/workbench/edit";
  let stopReason: string | undefined;
  let delivered = 0;
  let inFlight = 0;
  const onCancel = () => deps.onCancelWait?.(inFlight);
  deps.signal.addEventListener("abort", onCancel, { once: true });

  const halt = (reason: string) => {
    if (stopReason === undefined) stopReason = reason;
    stop.abort();
  };

  const runOne = async (chunk: PlannedChunk) => {
    for (let attempt = 0; ; attempt += 1) {
      let release: () => void;
      try {
        release = await deps.limiter.acquire(chunk.n, deps.ipm, gate);
      } catch (error) {
        if (error instanceof RangeError) halt(error.message);
        return; // stopped or cancelled while queued: nothing was sent
      }
      if (gate.aborted) {
        release();
        return;
      }
      inFlight += 1;
      try {
        // No signal: see RunChunksDeps.signal.
        const response = await deps
          .fetchImpl(endpoint, { method: "POST", body: deps.buildForm(chunk.n) })
          .then((value) => readApiResponse<ChunkResponse>(value))
          .finally(() => {
            inFlight -= 1;
          });
        deps.onChunk(chunk, response);
        delivered += response.images.length;
        deps.onProgress?.(delivered);
        return;
      } catch (error) {
        const verdict = classifyChunkError(error, deps.signal, attempt);
        if (verdict.kind === "abort") return;
        if (verdict.kind === "retry") {
          if (attempt >= maxRetries) {
            halt(`OpenAI kept rate-limiting the requests (${maxRetries} retries)`);
            return;
          }
          try {
            await deps.sleep(verdict.waitMs, gate);
          } catch {
            return;
          }
          continue;
        }
        halt(verdict.reason);
        return;
      }
    }
  };

  await Promise.allSettled(chunks.map(runOne));
  deps.signal.removeEventListener("abort", onCancel);
  return { aborted: deps.signal.aborted, stopReason, delivered };
}

// The error a press throws when it kept some images but not all of them.
export function partialRunMessage(saved: number, total: number, reason: string): string {
  const remaining = Math.max(0, total - saved);
  return `Saved ${saved} of ${total} images; stopped because ${reason}. Press Run to render only the remaining ${remaining}.`;
}
