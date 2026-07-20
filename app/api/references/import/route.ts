import { errorResponse } from "@/app/lib/openai-server";

export const runtime = "edge";

const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

export async function POST(request: Request) {
  try {
    const body = await request.json() as { imageUrl?: string };
    const url = safeRemoteUrl(body.imageUrl);
    const response = await fetch(url, {
      headers: { Accept: "image/png,image/jpeg,image/webp" },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error("The suggested image could not be downloaded.");
    // Redirects are followed, so the landing URL must pass the same host
    // restrictions as the requested one.
    safeRemoteUrl(response.url);
    const contentType = (response.headers.get("content-type") || "").split(";")[0].trim();
    if (!new Set(["image/png", "image/jpeg", "image/webp"]).has(contentType)) {
      throw new Error("The suggested source did not return a supported image.");
    }
    if (Number(response.headers.get("content-length") || 0) >= MAX_IMPORT_BYTES) {
      throw new Error("The suggested image is too large.");
    }
    const bytes = await readCapped(response.body, MAX_IMPORT_BYTES);
    if (!bytes.byteLength) throw new Error("The suggested image is empty.");
    return new Response(bytes, { headers: { "Content-Type": contentType, "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

// Reads at most `limit` bytes; aborts the download instead of buffering an
// arbitrarily large body just to reject it (servers can omit Content-Length).
async function readCapped(body: ReadableStream<Uint8Array> | null, limit: number) {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total >= limit) {
      await reader.cancel();
      throw new Error("The suggested image is too large.");
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

function safeRemoteUrl(value?: string) {
  const url = new URL(value || "");
  if (url.protocol !== "https:" || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(url.hostname)) {
    throw new Error("The suggested image URL is not allowed.");
  }
  return url.toString();
}
