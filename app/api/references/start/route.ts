import { MAX_REFERENCE_FILE_BYTES } from "@/app/lib/collage";
import { errorResponse, readOpenAIResponse, resolveOpenAIKey } from "@/app/lib/openai-server";

export const runtime = "edge";

const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

type UploadResponse = {
  id: string;
  expires_at?: number;
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      apiKey?: string;
      filename?: string;
      bytes?: number;
      mimeType?: string;
    };

    const filename = body.filename?.trim() || "reference-image";
    const bytes = Number(body.bytes);
    const mimeType = body.mimeType?.trim().toLowerCase() || "";

    if (!Number.isSafeInteger(bytes) || bytes <= 0) {
      throw new Error("Reference image size is invalid.");
    }
    if (bytes >= MAX_REFERENCE_FILE_BYTES) {
      throw new Error("Each reference image must be under 50 MB for the image model.");
    }
    if (!ALLOWED_IMAGE_TYPES.has(mimeType)) {
      throw new Error("Reference images must be PNG, JPEG, or WebP files.");
    }

    const apiKey = resolveOpenAIKey(body.apiKey);
    const response = await fetch("https://api.openai.com/v1/uploads", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        purpose: "vision",
        filename,
        bytes,
        mime_type: mimeType,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const upload = await readOpenAIResponse<UploadResponse>(response);

    return Response.json({ ok: true, uploadId: upload.id, expiresAt: upload.expires_at });
  } catch (error) {
    return errorResponse(error);
  }
}
