// QA client: talks to the app's POST /api/qa endpoint (another agent's route,
// added alongside this) which asks a vision model whether a rendered collage
// actually matches the reference photos it was built from. Wired into the CLI
// in cli.mjs — this module only builds requests, sends them, and formats the
// response; it never decides whether QA runs at all (that's cli.mjs's job,
// including the "never fail a render" guarantee).

import { readFile } from "node:fs/promises";

import sharp from "sharp";

// Downscales (never upscales — same fit:"inside"/withoutEnlargement approach
// as transport.mjs's prepareReferenceForUpload) and re-encodes as JPEG so the
// QA request stays small: rendered outputs go in at 1536 long edge, reference
// photos at 1024 (see buildQaRequest below).
export async function prepareQaImage(filePathOrBuffer, { maxLongEdge = 1024, jpegQuality = 72 } = {}) {
  const bytes = Buffer.isBuffer(filePathOrBuffer) ? filePathOrBuffer : await readFile(filePathOrBuffer);
  const { data } = await sharp(bytes)
    .resize(maxLongEdge, maxLongEdge, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: jpegQuality })
    .toBuffer({ resolveWithObject: true });
  return { imageBase64: data.toString("base64"), mimeType: "image/jpeg" };
}

// payload.items and referenceFiles come from the same boardPayload/
// boardReferenceFiles call (variants.mjs), in the same item order, so each
// item's reference photos are a contiguous run of `item.imageNames.length`
// entries in referenceFiles — the QA request only wants the first of those
// per item, not every angle/close-up a slot might carry.
export async function buildQaRequest({ payload, referenceFiles, outputPath, jobId }) {
  const output = await prepareQaImage(outputPath, { maxLongEdge: 1536 });

  const items = [];
  const references = [];
  let fileIndex = 0;
  for (const item of payload.items) {
    const imageCount = item.imageNames?.length ?? 0;
    const firstFile = referenceFiles[fileIndex];
    fileIndex += imageCount;

    const qaItem = { id: item.id, role: item.role };
    if (item.name !== undefined) qaItem.name = item.name;
    if (item.brand !== undefined) qaItem.brand = item.brand;
    if (item.notes !== undefined) qaItem.notes = item.notes;
    items.push(qaItem);

    if (firstFile) {
      const reference = await prepareQaImage(firstFile.path, { maxLongEdge: 1024 });
      references.push({ itemId: item.id, imageBase64: reference.imageBase64, mimeType: reference.mimeType });
    }
  }

  const request = { output, references, items };
  if (jobId !== undefined) request.jobId = jobId;
  return request;
}

// POSTs to <baseUrl>/api/qa and returns the parsed `{ ok: true, qa, ... }`
// body, or throws an Error with `.status` set. Mirrors postGeneration's
// (cli.mjs) handling of a deployed --base-url behind Cloudflare Access: a 302
// or 403 means Access rejected the request, not the QA endpoint itself. A 404
// (endpoint not deployed yet) and any other non-ok/non-JSON response surface
// the same way, via `.status`, so the caller can treat "not deployed" and
// "server error" identically — QA is never allowed to block a render either
// way (see cli.mjs's runQaForCandidate).
export async function runQa(baseUrl, headers, request) {
  const response = await fetch(`${baseUrl}/api/qa`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(request),
    redirect: "manual",
  });
  if (response.status === 302 || response.status === 403) {
    throw Object.assign(
      new Error(`Cloudflare Access rejected the QA request (HTTP ${response.status}) — the session may have expired.`),
      { status: response.status },
    );
  }
  let json;
  try {
    json = await response.json();
  } catch {
    throw Object.assign(new Error(`Non-JSON response (HTTP ${response.status}) from ${baseUrl}/api/qa`), {
      status: response.status,
    });
  }
  if (!response.ok || !json.ok) {
    throw Object.assign(new Error(json.error ?? json.message ?? `HTTP ${response.status}`), {
      status: response.status,
    });
  }
  return json;
}

// Human-readable per-item issue phrases. The server owns flagCount and the
// decision of what counts as a flag; this just renders whatever its
// structured per-item fields already say went wrong.
function describeItem(item) {
  const parts = [];
  if (item.present === false) parts.push("missing");
  if (typeof item.count === "number" && item.count !== 1) parts.push(`count ${item.count}`);
  if (item.finishMatch === "mismatch") parts.push("finish mismatch");
  else if (item.finishMatch === "unclear") parts.push("finish unclear");
  if (item.scaleOk === false) parts.push("scale off");
  for (const issue of item.issues ?? []) parts.push(issue);
  return parts;
}

// One short console line for a QA result: "QA: clean" or
// "QA: 2 flags — shower_head: count 2; main_tile: finish mismatch".
export function formatQaLine(qa) {
  if (!qa?.flagCount) return "QA: clean";
  const segments = [];
  for (const item of qa.items ?? []) {
    const parts = describeItem(item);
    if (parts.length) segments.push(`${item.id}: ${parts.join(", ")}`);
  }
  if (qa.extraObjects?.length) segments.push(`extra: ${qa.extraObjects.join(", ")}`);
  return `QA: ${qa.flagCount} flag${qa.flagCount === 1 ? "" : "s"} — ${segments.join("; ")}`;
}
