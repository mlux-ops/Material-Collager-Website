// Uploads a local file to OpenAI through the app's own chunked-upload proxy
// (POST /api/references/start -> /api/references/part [x1+] -> /api/references/complete),
// returning a durable OpenAI file id. The economy (Batch API) endpoint needs
// this — batch requests reference images by file id in a JSONL request line,
// they can't carry raw multipart bytes the way /api/generate does.

import { readFile } from "node:fs/promises";
import path from "node:path";

const MAX_PART_BYTES = 5 * 1024 * 1024;
const MIME_BY_EXTENSION = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

async function postJson(baseUrl, route, body, headers) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => null);
  if (!response.ok || !json?.ok) {
    throw new Error(json?.error ?? json?.message ?? `HTTP ${response.status} from ${route}`);
  }
  return json;
}

export async function uploadFileToOpenAI(baseUrl, headers, filePath, apiKey) {
  const bytes = await readFile(filePath);
  const mimeType = MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? "image/png";
  const started = await postJson(
    baseUrl,
    "/api/references/start",
    { apiKey, filename: path.basename(filePath), bytes: bytes.length, mimeType },
    headers,
  );

  const partIds = [];
  for (let offset = 0; offset < bytes.length; offset += MAX_PART_BYTES) {
    const chunk = bytes.subarray(offset, offset + MAX_PART_BYTES);
    const form = new FormData();
    form.append("apiKey", apiKey ?? "");
    form.append("uploadId", started.uploadId);
    form.append("data", new Blob([chunk], { type: mimeType }), "reference.part");
    const response = await fetch(`${baseUrl}/api/references/part`, { method: "POST", headers, body: form });
    const json = await response.json().catch(() => null);
    if (!response.ok || !json?.ok) throw new Error(json?.error ?? `HTTP ${response.status} from /api/references/part`);
    partIds.push(json.partId);
  }

  const completed = await postJson(
    baseUrl,
    "/api/references/complete",
    { apiKey, uploadId: started.uploadId, partIds },
    headers,
  );
  return completed.fileId;
}
