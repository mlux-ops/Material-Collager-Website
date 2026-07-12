import { activeItems, buildGenerationPrompt, referenceCount, resolvedSize, validateCollageRequest, type CollageRequestInput } from "@/app/lib/collage";
import { cleanupExpiredJobs, ensureJobStorage, publicJob, runtimeStorage } from "@/app/lib/generation-jobs";
import { errorResponse, readOpenAIResponse, resolveOpenAIKey } from "@/app/lib/openai-server";

export const runtime = "edge";

type BatchResponse = {
  id: string;
  status: string;
  output_file_id?: string;
  error_file_id?: string;
  errors?: { data?: Array<{ message?: string }> };
};

type JobRow = {
  id: string;
  mode: "economy" | "immediate";
  status: string;
  openai_batch_id: string | null;
  output_key: string | null;
  filename: string;
  format: string;
  estimated_usd: number | null;
  usage_json: string | null;
  qa_json: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
  payload_json: string;
  reference_ids_json: string;
};

const COMPLETE_STATUSES = new Set(["completed", "failed", "expired", "cancelled"]);
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export async function POST(request: Request) {
  try {
    const body = await request.json() as { payload?: CollageRequestInput };
    if (!body.payload) throw new Error("The final-render request is missing.");
    const payload: CollageRequestInput = {
      ...body.payload,
      apiKey: "",
      quality: "high",
      outputResolution: "final",
      runQa: true,
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
    const jobId = crypto.randomUUID();
    const requestLine = JSON.stringify({
      custom_id: jobId,
      method: "POST",
      url: "/v1/images/edits",
      body: {
        model: "gpt-image-2",
        prompt,
        images: allImageIds.map((fileId) => ({ file_id: fileId })),
        size: resolvedSize(payload),
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
      body: fileForm,
    }));
    const batch = await readOpenAIResponse<BatchResponse>(await fetch("https://api.openai.com/v1/batches", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        input_file_id: inputFile.id,
        endpoint: "/v1/images/edits",
        completion_window: "24h",
        metadata: { material_collager_job: jobId },
      }),
    }));

    const now = Date.now();
    const DB = await ensureJobStorage();
    await DB.prepare(`INSERT INTO generation_jobs
      (id, mode, status, openai_batch_id, output_key, filename, format, prompt, payload_json, reference_ids_json, estimated_usd, usage_json, qa_json, error, created_at, updated_at, expires_at)
      VALUES (?, 'economy', ?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`)
      .bind(
        jobId,
        batch.status || "validating",
        batch.id,
        finalFilename(payload.outputFilename),
        resolvedSize(payload),
        prompt,
        JSON.stringify(payload),
        JSON.stringify(referenceIds),
        baseEstimate(payload) / 2,
        now,
        now,
        now + THIRTY_DAYS_MS,
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
    const pending = await DB.prepare("SELECT * FROM generation_jobs WHERE mode = 'economy' AND output_key IS NULL AND status NOT IN ('failed', 'expired', 'cancelled') ORDER BY created_at DESC LIMIT 8")
      .all<JobRow>();
    for (const row of pending.results) await refreshJob(row);
    const jobs = await DB.prepare("SELECT * FROM generation_jobs ORDER BY created_at DESC LIMIT 30").all<JobRow>();
    return Response.json({ ok: true, jobs: jobs.results.map(publicJob) });
  } catch (error) {
    return errorResponse(error);
  }
}

async function refreshJob(row: JobRow) {
  if (!row.openai_batch_id) return;
  const apiKey = resolveOpenAIKey();
  const batch = await readOpenAIResponse<BatchResponse>(await fetch(`https://api.openai.com/v1/batches/${encodeURIComponent(row.openai_batch_id)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  }));
  const DB = await ensureJobStorage();
  if (!COMPLETE_STATUSES.has(batch.status)) {
    await DB.prepare("UPDATE generation_jobs SET status = ?, updated_at = ? WHERE id = ?")
      .bind(batch.status, Date.now(), row.id).run();
    return;
  }
  if (batch.status !== "completed" || !batch.output_file_id) {
    const error = batch.errors?.data?.map((entry) => entry.message).filter(Boolean).join(" ") || `Economy render ${batch.status}.`;
    await DB.prepare("UPDATE generation_jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?")
      .bind(batch.status, error, Date.now(), row.id).run();
    return;
  }
  const outputResponse = await fetch(`https://api.openai.com/v1/files/${encodeURIComponent(batch.output_file_id)}/content`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!outputResponse.ok) await readOpenAIResponse<never>(outputResponse);
  const outputText = await outputResponse.text();
  const line = outputText.split(/\r?\n/).find(Boolean);
  if (!line) throw new Error("The completed Economy job returned an empty result.");
  const result = JSON.parse(line) as {
    response?: { status_code?: number; body?: { data?: Array<{ b64_json?: string }>; usage?: Record<string, unknown>; error?: { message?: string } } };
    error?: { message?: string };
  };
  const imageBase64 = result.response?.body?.data?.[0]?.b64_json;
  if (!imageBase64) {
    const message = result.response?.body?.error?.message || result.error?.message || "The Economy render completed without an image.";
    await DB.prepare("UPDATE generation_jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
      .bind(message, Date.now(), row.id).run();
    return;
  }
  const bytes = Uint8Array.from(atob(imageBase64), (character) => character.charCodeAt(0));
  const outputKey = `generation-outputs/${row.id}.png`;
  const bucket = runtimeStorage().OUTPUTS;
  if (!bucket) throw new Error("Generated-output storage is not configured.");
  await bucket.put(outputKey, bytes, { httpMetadata: { contentType: "image/png" } });
  const payload = JSON.parse(row.payload_json) as CollageRequestInput;
  const referenceIds = JSON.parse(row.reference_ids_json) as string[];
  let qa: Record<string, unknown> | null = null;
  try {
    qa = await reviewEconomyResult(apiKey, payload, imageBase64, referenceIds);
  } catch (error) {
    qa = { reviewFailed: true, passed: false, score: 0, findings: [], recommendation: error instanceof Error ? error.message : "Accuracy review failed.", items: [] };
  }
  await DB.prepare("UPDATE generation_jobs SET status = 'completed', output_key = ?, usage_json = ?, qa_json = ?, updated_at = ? WHERE id = ?")
    .bind(outputKey, JSON.stringify(result.response?.body?.usage ?? {}), JSON.stringify(qa), Date.now(), row.id).run();
}

async function reviewEconomyResult(apiKey: string, payload: CollageRequestInput, imageBase64: string, referenceIds: string[]) {
  const items = activeItems(payload);
  let next = 1;
  const map = items.map((item) => {
    const count = referenceCount(item);
    const range = count === 1 ? `reference ${next}` : `references ${next}-${next + count - 1}`;
    next += count;
    return `${range} -> ${item.id}: ${item.role}`;
  }).join("\n");
  const content: Array<Record<string, unknown>> = [{
    type: "input_text",
    text: `Review the generated material collage against every original product reference.\n${map}\nScore product identity, geometry, finish, color, material texture, completeness, duplicates, and editorial polish. Return every item ID exactly once. Pass only at 90 or above.`,
  }, { type: "input_image", image_url: `data:image/png;base64,${imageBase64}`, detail: "original" }];
  for (const fileId of referenceIds) content.push({ type: "input_image", file_id: fileId, detail: "original" });
  const response = await readOpenAIResponse<{ output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> }>(await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.MATERIAL_COLLAGER_QA_MODEL || "gpt-5.6-terra",
      reasoning: { effort: "low" },
      text: { format: { type: "json_schema", name: "collage_accuracy_review", strict: true, schema: qaSchema() } },
      input: [{ role: "user", content }],
    }),
  }));
  const text = response.output_text || response.output?.flatMap((entry) => entry.content ?? []).map((entry) => entry.text || "").join("");
  if (!text) throw new Error("Accuracy review returned no result.");
  return JSON.parse(text) as Record<string, unknown>;
}

function qaSchema() {
  return {
    type: "object", additionalProperties: false,
    properties: {
      passed: { type: "boolean" }, score: { type: "integer", minimum: 0, maximum: 100 },
      findings: { type: "array", items: { type: "string" } }, recommendation: { type: "string" },
      items: { type: "array", items: { type: "object", additionalProperties: false, properties: {
        id: { type: "string" }, passed: { type: "boolean" }, finding: { type: "string" },
        box: { type: "array", items: { type: "integer", minimum: 0, maximum: 1000 }, minItems: 4, maxItems: 4 },
      }, required: ["id", "passed", "finding", "box"] } },
    }, required: ["passed", "score", "findings", "recommendation", "items"],
  };
}

function baseEstimate(payload: CollageRequestInput) {
  return payload.orientation === "square" ? 0.211 : 0.165;
}

function finalFilename(value?: string) {
  const base = (value || "material-collage.png").replace(/[^a-zA-Z0-9._-]+/g, "-");
  return base.toLowerCase().endsWith(".png") ? base : `${base}.png`;
}
