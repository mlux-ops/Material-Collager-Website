import { activeItems, buildGenerationPrompt, resolvedSize, validateCollageRequest, type CollageRequestInput } from "@/app/lib/collage";
import { cleanupExpiredJobs, ensureJobStorage, publicJob, RETENTION_MS, runtimeStorage, type JobRow } from "@/app/lib/generation-jobs";
import { errorResponse, readOpenAIResponse, resolveOpenAIKey } from "@/app/lib/openai-server";
import { validateImagePrompt } from "@/app/lib/image-edit";

export const runtime = "edge";

type BatchResponse = {
  id: string;
  status: string;
  output_file_id?: string;
  error_file_id?: string;
  errors?: { data?: Array<{ message?: string }> };
};

const COMPLETE_STATUSES = new Set(["completed", "failed", "expired", "cancelled"]);

export async function POST(request: Request) {
  try {
    const body = await request.json() as { payload?: CollageRequestInput };
    if (!body.payload) throw new Error("The final-render request is missing.");
    const payload: CollageRequestInput = {
      ...body.payload,
      apiKey: "",
      quality: "high",
      outputResolution: "final",
      renderKind: "final",
    };
    validateCollageRequest(payload);
    const referenceIds = activeItems(payload).flatMap((item) => item.imageFileIds ?? []);
    const allImageIds = payload.layoutReferenceFileId
      ? [payload.layoutReferenceFileId, ...referenceIds]
      : referenceIds;
    if (allImageIds.length === 0 || allImageIds.length > 16 || allImageIds.some((id) => !/^file[-_]/.test(id))) {
      throw new Error("One or more full-quality final references are unavailable. Upload the references again and retry.");
    }

    const apiKey = resolveOpenAIKey();
    const prompt = buildGenerationPrompt(payload);
    validateImagePrompt(prompt);
    const jobId = crypto.randomUUID();
    const batch = await submitEconomyBatch(apiKey, jobId, prompt, allImageIds, resolvedSize(payload));

    const now = Date.now();
    const DB = await ensureJobStorage();
    await DB.prepare(`INSERT INTO generation_jobs
      (id, mode, status, openai_batch_id, output_key, filename, format, prompt, payload_json, reference_ids_json,
       render_kind, collage_type, library_visible, title, estimated_usd, usage_json, qa_json, error, created_at, updated_at, expires_at)
      VALUES (?, 'economy', ?, ?, NULL, ?, ?, ?, ?, ?, 'final', ?, 1, ?, ?, NULL, NULL, NULL, ?, ?, ?)`)
      .bind(
        jobId,
        batch.status || "validating",
        batch.id,
        finalFilename(payload.outputFilename),
        resolvedSize(payload),
        prompt,
        JSON.stringify(payload),
        JSON.stringify(referenceIds),
        payload.collageType,
        displayTitle(payload.outputFilename, payload.collageType),
        baseEstimate(payload) / 2,
        now,
        now,
        now + RETENTION_MS,
      ).run();
    return Response.json({ ok: true, jobId, status: batch.status, estimatedUsd: baseEstimate(payload) / 2 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function GET() {
  try {
    await cleanupExpiredJobs();
    const DB = await ensureJobStorage();
    const pending = await DB.prepare("SELECT * FROM generation_jobs WHERE mode = 'economy' AND output_key IS NULL AND status NOT IN ('failed', 'expired', 'cancelled') ORDER BY updated_at ASC LIMIT 8")
      .all<JobRow>();
    // Refresh jobs independently: one job with an unreadable batch output must
    // not take down the whole history listing for its six-month lifetime.
    await Promise.allSettled(pending.results.map((row: JobRow) => refreshJob(row)));
    const jobs = await DB.prepare("SELECT * FROM generation_jobs ORDER BY created_at DESC LIMIT 30").all<JobRow>();
    return Response.json({ ok: true, jobs: jobs.results.map(publicJob) });
  } catch (error) {
    return errorResponse(error);
  }
}

async function submitEconomyBatch(apiKey: string, jobId: string, prompt: string, imageFileIds: string[], size: string) {
  const requestLine = JSON.stringify({
    custom_id: jobId,
    method: "POST",
    url: "/v1/images/edits",
    body: {
      model: "gpt-image-2",
      prompt,
      images: imageFileIds.map((fileId) => ({ file_id: fileId })),
      size,
      quality: "high",
      background: "opaque",
      output_format: "png",
    },
  });
  const fileForm = new FormData();
  fileForm.append("purpose", "batch");
  fileForm.append("file", new Blob([`${requestLine}\n`], { type: "application/jsonl" }), `${jobId}.jsonl`);
  const inputFile = await readOpenAIResponse<{ id: string }>(await fetch("https://api.openai.com/v1/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(60_000),
    body: fileForm,
  }));
  return readOpenAIResponse<BatchResponse>(await fetch("https://api.openai.com/v1/batches", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({
      input_file_id: inputFile.id,
      endpoint: "/v1/images/edits",
      completion_window: "24h",
      metadata: { material_collager_job: jobId },
    }),
  }));
}

async function refreshJob(row: JobRow) {
  if (!row.openai_batch_id) return;
  const apiKey = resolveOpenAIKey();
  const batch = await readOpenAIResponse<BatchResponse>(await fetch(`https://api.openai.com/v1/batches/${encodeURIComponent(row.openai_batch_id)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(30_000),
  }));
  const DB = await ensureJobStorage();
  if (!COMPLETE_STATUSES.has(batch.status)) {
    await DB.prepare("UPDATE generation_jobs SET status = ?, updated_at = ? WHERE id = ?")
      .bind(batch.status, Date.now(), row.id).run();
    return;
  }
  if (batch.status !== "completed" || !batch.output_file_id) {
    const error = batch.errors?.data?.map((entry) => entry.message).filter(Boolean).join(" ") || `Economy render ${batch.status}.`;
    // Preserve the requested Final dimensions. A failed batch is terminal;
    // polling history must not silently purchase a smaller replacement.
    await DB.prepare("UPDATE generation_jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?")
      .bind(batch.status, error, Date.now(), row.id).run();
    return;
  }
  // Claim the row before the expensive download + paid QA review so two
  // overlapping polls (multiple tabs) cannot both process the same batch. A
  // stale claim (worker died mid-finalize) becomes reclaimable after 5 minutes.
  const claim = await DB.prepare("UPDATE generation_jobs SET status = 'finalizing', finalize_attempts = finalize_attempts + 1, updated_at = ? WHERE id = ? AND output_key IS NULL AND (status != 'finalizing' OR updated_at < ?)")
    .bind(Date.now(), row.id, Date.now() - 5 * 60 * 1000).run();
  if (!claim.meta.changes) return;
  const failJob = async (message: string) => {
    await DB.prepare("UPDATE generation_jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
      .bind(message, Date.now(), row.id).run();
  };
  // Bound retries: after a few finalize attempts a permanently unreadable
  // output should fail terminally instead of re-downloading and re-running the
  // paid QA review every stale-claim window forever.
  if (row.finalize_attempts + 1 > 3) {
    await failJob("The Economy render could not be finalized after multiple attempts.");
    return;
  }
  try {
    const outputResponse = await fetch(`https://api.openai.com/v1/files/${encodeURIComponent(batch.output_file_id)}/content`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(120_000),
    });
    if (!outputResponse.ok) await readOpenAIResponse<never>(outputResponse);
    const outputText = await outputResponse.text();
    const line = outputText.split(/\r?\n/).find(Boolean);
    if (!line) {
      await failJob("The completed Economy job returned an empty result.");
      return;
    }
    const result = JSON.parse(line) as {
      response?: { status_code?: number; body?: { data?: Array<{ b64_json?: string }>; usage?: Record<string, unknown>; error?: { message?: string } } };
      error?: { message?: string };
    };
    const imageBase64 = result.response?.body?.data?.[0]?.b64_json;
    if (!imageBase64) {
      await failJob(result.response?.body?.error?.message || result.error?.message || "The Economy render completed without an image.");
      return;
    }
    const bytes = Uint8Array.from(atob(imageBase64), (character) => character.charCodeAt(0));
    const outputKey = `generation-outputs/${row.id}.png`;
    const bucket = runtimeStorage().OUTPUTS;
    if (!bucket) throw new Error("Generated-output storage is not configured.");
    await bucket.put(outputKey, bytes, { httpMetadata: { contentType: "image/png" } });
    // Accuracy review is disabled here (see /api/generate for why): it added
    // an extra vision+reasoning call after every batch finished, with no way
    // to cancel it, and could stall a job that had otherwise completed.
    await DB.prepare("UPDATE generation_jobs SET status = 'completed', output_key = ?, usage_json = ?, qa_json = ?, updated_at = ? WHERE id = ?")
      .bind(outputKey, JSON.stringify(result.response?.body?.usage ?? {}), null, Date.now(), row.id).run();
  } catch {
    // Leave the row in 'finalizing'; the stale-claim window retries it, bounded
    // by the finalize_attempts cap above, so a transient failure recovers while
    // a permanent one eventually surfaces as a failed history item.
    return;
  }
}

function baseEstimate(payload: CollageRequestInput) {
  return payload.orientation === "square" ? 0.211 : 0.165;
}

function finalFilename(value?: string) {
  const base = (value || "material-collage.png").replace(/[^a-zA-Z0-9._-]+/g, "-");
  return base.toLowerCase().endsWith(".png") ? base : `${base}.png`;
}

function displayTitle(filename: string | undefined, collageType: string) {
  const clean = finalFilename(filename).replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim();
  const value = clean && clean.toLowerCase() !== "material collage" ? clean : collageType.replaceAll("_", " ");
  return value.replace(/\b\w/g, (letter) => letter.toUpperCase());
}
