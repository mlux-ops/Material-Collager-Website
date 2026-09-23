import assert from "node:assert/strict";
import test from "node:test";
import { isStaleSubmitting, staleSubmittingGuidance, SUBMITTING_STALE_MS } from "../app/lib/economy-submission-status.ts";

test("a fresh submitting row is not stale", () => {
  const now = Date.now();
  assert.equal(isStaleSubmitting("submitting", now, now), false);
  assert.equal(isStaleSubmitting("submitting", now - 1000, now), false);
});

test("a submitting row past the threshold is stale; right at the threshold is not yet", () => {
  const now = Date.now();
  assert.equal(isStaleSubmitting("submitting", now - SUBMITTING_STALE_MS - 1, now), true);
  assert.equal(isStaleSubmitting("submitting", now - SUBMITTING_STALE_MS, now), false);
});

test("only a submitting row is ever stale, whatever its age", () => {
  const now = Date.now();
  const ancient = now - SUBMITTING_STALE_MS * 10;
  assert.equal(isStaleSubmitting("in_progress", ancient, now), false);
  assert.equal(isStaleSubmitting("failed", ancient, now), false);
  assert.equal(isStaleSubmitting("validating", ancient, now), false);
});

test("the guidance names the job id so it can be found on OpenAI's Batches page", () => {
  const message = staleSubmittingGuidance("job-123");
  assert.match(message, /material_collager_job = job-123/);
  assert.match(message, /resubmit/i);
});
