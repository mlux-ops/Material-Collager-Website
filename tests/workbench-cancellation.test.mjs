import assert from "node:assert/strict";
import test from "node:test";

import { createImageEdit, createImageGeneration } from "../app/lib/image-edit.ts";
import { reviewGeneratedImage } from "../app/lib/accuracy-review.ts";
import { combineAbortSignals } from "../app/lib/openai-server.ts";

// E1 cancellation threading: mock global fetch and assert that a caller abort
// propagates into the upstream OpenAI fetch's signal for every paid path —
// edit, generation, review, and (via combineAbortSignals directly) assist.

// Not a real credential — a placeholder string these mocked-fetch tests pass
// through as the apiKey parameter; no network call is ever actually made.
const NOT_A_REAL_API_KEY = ["unit", "test", "mock", "no-network-call"].join("-");

function withMockedFetch(handler, run) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return Promise.resolve(run()).finally(() => {
    globalThis.fetch = original;
  });
}

function pngBlob() {
  return new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" });
}

test("combineAbortSignals: an already-aborted caller signal yields an already-aborted combined signal", () => {
  const controller = new AbortController();
  controller.abort();
  const combined = combineAbortSignals(controller.signal, 60_000);
  assert.equal(combined.aborted, true);
});

test("combineAbortSignals: aborting the caller signal after combining also aborts the combined signal (used by /api/workbench/assist)", async () => {
  const controller = new AbortController();
  const combined = combineAbortSignals(controller.signal, 60_000);
  assert.equal(combined.aborted, false);
  controller.abort();
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.equal(combined.aborted, true);
});

test("combineAbortSignals: with only a caller signal (no timeout) it returns that exact signal", () => {
  const controller = new AbortController();
  assert.equal(combineAbortSignals(controller.signal), controller.signal);
});

test("combineAbortSignals: with neither caller nor timeout it returns a signal that never spontaneously aborts", () => {
  const combined = combineAbortSignals(undefined, undefined);
  assert.equal(combined.aborted, false);
});

test("createImageEdit (image-edit path): the caller's AbortSignal is threaded into the upstream fetch to api.openai.com/v1/images/edits", async () => {
  let observedSignal;
  await withMockedFetch(
    async (_url, init) => {
      observedSignal = init.signal;
      return new Response(JSON.stringify({ data: [{ b64_json: "AA==" }] }), { status: 200 });
    },
    async () => {
      const controller = new AbortController();
      await createImageEdit(
        NOT_A_REAL_API_KEY,
        { model: "gpt-image-2", prompt: "p", references: [{ blob: pngBlob(), filename: "a.png" }], size: "1024x1024", quality: "medium", background: "opaque", output_format: "png" },
        [],
        false,
        controller.signal,
      );
    },
  );
  assert.ok(observedSignal instanceof AbortSignal);
  assert.equal(observedSignal.aborted, false);
});

test("createImageEdit: a caller abort during the in-flight upstream call aborts that fetch's signal", async () => {
  let observedSignal;
  let fetchStarted;
  const started = new Promise((resolve) => { fetchStarted = resolve; });
  const callerController = new AbortController();

  const runPromise = withMockedFetch(
    async (_url, init) => {
      observedSignal = init.signal;
      fetchStarted();
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    },
    async () => createImageEdit(
      NOT_A_REAL_API_KEY,
      { model: "gpt-image-2", prompt: "p", references: [{ blob: pngBlob(), filename: "a.png" }], size: "1024x1024", quality: "medium", background: "opaque", output_format: "png" },
      [],
      false,
      callerController.signal,
    ),
  );

  await started;
  callerController.abort();
  await assert.rejects(runPromise);
  assert.equal(observedSignal.aborted, true);
});

test("createImageGeneration (generation path): the caller's AbortSignal is threaded into the upstream fetch to api.openai.com/v1/images/generations", async () => {
  const callerController = new AbortController();
  let observedSignal;
  const runPromise = withMockedFetch(
    async (_url, init) => {
      observedSignal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    },
    async () => createImageGeneration(NOT_A_REAL_API_KEY, { prompt: "p", size: "1024x1024", quality: "medium" }, [], callerController.signal),
  );
  callerController.abort();
  await assert.rejects(runPromise);
  assert.equal(observedSignal.aborted, true);
});

test("reviewGeneratedImage (accuracy-review path): the caller's AbortSignal is threaded into the upstream fetch to api.openai.com/v1/responses", async () => {
  const callerController = new AbortController();
  let observedSignal;
  // reviewGeneratedImage awaits an async blob-to-data-URL conversion before
  // it ever calls fetch, so the caller abort below can legitimately land
  // BEFORE fetch is invoked — the mock must reject immediately for an
  // already-aborted signal, not only listen for a future 'abort' event.
  const runPromise = withMockedFetch(
    async (_url, init) => {
      observedSignal = init.signal;
      if (init.signal.aborted) throw new DOMException("aborted", "AbortError");
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    },
    async () => reviewGeneratedImage({
      apiKey: NOT_A_REAL_API_KEY,
      imageBase64: "AA==",
      items: [{ id: "a", role: "wood", referenceCount: 1 }],
      selectedItemIds: [],
      references: [{ blob: pngBlob() }],
      domain: "material collage",
      signal: callerController.signal,
    }),
  );
  callerController.abort();
  // reviewGeneratedImage only wraps response PARSING in its try/catch (the
  // fetch call itself is outside it), so an aborted upstream fetch rejects
  // the whole call rather than resolving to a { reviewFailed: true } report.
  // The point of this test is that the abort reaches the upstream fetch at
  // all, so assert on the observed signal, not on how the rejection surfaces.
  await assert.rejects(runPromise);
  assert.equal(observedSignal.aborted, true);
});
