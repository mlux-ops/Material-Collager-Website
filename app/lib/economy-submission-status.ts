// A 'submitting' row means the paid batch call (POST in app/api/economy/route.ts)
// was in flight when something interrupted it: the tab closed or Cancel was
// pressed and Cloudflare cancelled the request's outstanding work, or the
// row's own success/failure UPDATE afterward itself failed. Nothing then ever
// moves the row out of 'submitting' — it is excluded from the poller by
// design (see the `pending` query in GET), because a row still genuinely in
// flight has no batch id yet to check. So a row old enough to be certain the
// request already ended one way or another is read as failed instead of
// left pending forever.
//
// The POST handler's own worst case — the two 60s upstream timeouts in
// submitEconomyBatch, back to back — is well under this, so this threshold
// never mistakes a submission that is still genuinely in flight.
export const SUBMITTING_STALE_MS = 5 * 60 * 1000;

export function isStaleSubmitting(status: string, updatedAt: number, now: number = Date.now()): boolean {
  return status === "submitting" && now - updatedAt > SUBMITTING_STALE_MS;
}

// The row itself is left as it is (only a reader's view of it changes): this
// is applied in publicJob, so both the generator page's history drawer and
// the autoboard CLI's batch-status see the same corrected status and error.
export function staleSubmittingGuidance(jobId: string): string {
  const minutes = Math.round(SUBMITTING_STALE_MS / 60_000);
  return `This submission has not reported back in over ${minutes} minutes and is being treated as failed. A batch may still have been created — check OpenAI's Batches page for metadata material_collager_job = ${jobId} before resubmitting.`;
}
