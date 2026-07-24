import { MAX_REFERENCE_FILE_BYTES, MAX_REFERENCE_IMAGES, QUALITIES } from "@/app/lib/collage";
import {
  DiagnosedGenerationError,
  createImageEdit,
  createImageGeneration,
  isRetryableImageError,
  safeReferenceFilename,
  validateEditSize,
  type AttemptDiagnostic,
  type GenerationDiagnostics,
  type ImageQuality,
  type PreparedReference,
} from "@/app/lib/image-edit";
import { OpenAIRequestError, errorResponse, resolveOpenAIKey } from "@/app/lib/openai-server";

export const runtime = "edge";

// Generic image generation/edit endpoint for the workbench node editor.
// Unlike /api/generate it takes the finished prompt directly (built by
// upstream nodes), does not run QA, and does not persist — the Save to
// Library node persists explicitly via /api/workbench/save.
type WorkbenchEditPayload = {
  prompt?: string;
  size?: string;
  quality?: ImageQuality;
  n?: number;
  apiKey?: string;
};

export async function POST(request: Request) {
  let diagnostics: GenerationDiagnostics | undefined;
  try {
    const incoming = await request.formData();
    const payloadText = incoming.get("payload");
    if (typeof payloadText !== "string") throw new Error("Missing workbench payload.");
    const payload = JSON.parse(payloadText) as WorkbenchEditPayload;

    const prompt = payload.prompt?.trim() || "";
    if (!prompt) throw new Error("Connect or enter a prompt before running this node.");
    if (prompt.length > 32_000) throw new Error("The prompt exceeds the 32,000 character limit.");
    const size = payload.size || "1536x1024";
    const sizeError = validateEditSize(size);
    if (sizeError) throw new Error(sizeError);
    const quality: ImageQuality = QUALITIES.includes(payload.quality as (typeof QUALITIES)[number])
      ? (payload.quality as ImageQuality)
      : "medium";
    const n = Math.max(1, Math.min(10, Math.round(Number(payload.n) || 1)));

    const imageFiles = incoming.getAll("image[]").filter((value): value is File => value instanceof File);
    if (imageFiles.length > MAX_REFERENCE_IMAGES) {
      throw new Error(`Use no more than ${MAX_REFERENCE_IMAGES} input images per node.`);
    }
    for (const file of imageFiles) {
      if (!file.type.startsWith("image/")) throw new Error(`Input ${file.name || "image"} is not an image file.`);
      if (file.size >= MAX_REFERENCE_FILE_BYTES) throw new Error(`Input ${file.name || "image"} must be under 50 MB.`);
    }
    const mask = incoming.get("mask");
    if (mask !== null && (!(mask instanceof File) || mask.type !== "image/png" || mask.size >= 4 * 1024 * 1024)) {
      throw new Error("The mask must be a PNG under 4 MB.");
    }
    if (mask instanceof File && imageFiles.length === 0) {
      throw new Error("A mask needs at least one input image to apply to.");
    }

    const apiKey = resolveOpenAIKey(payload.apiKey);
    const attempts: AttemptDiagnostic[] = [];
    const references: PreparedReference[] = imageFiles.map((file) => ({
      blob: file,
      filename: safeReferenceFilename(file.name),
    }));
    diagnostics = {
      model: "gpt-image-2",
      transport: "multipart",
      quality,
      referenceCount: references.length,
      totalReferenceBytes: references.reduce((sum, reference) => sum + reference.blob.size, 0),
      largestReferenceBytes: Math.max(...references.map((reference) => reference.blob.size), 0),
      references: references.map((reference) => ({ filename: reference.filename, bytes: reference.blob.size, mimeType: reference.blob.type })),
      attempts,
    };

    // E1 cancellation threading: request.signal aborts when the client fetch
    // to this route is cancelled (the executor's run AbortSignal). Thread it
    // into the upstream OpenAI call so cancel aborts the paid request too.
    const result = references.length
      ? await createImageEdit(apiKey, {
          model: "gpt-image-2",
          prompt,
          references,
          mask: mask instanceof File ? { blob: mask, filename: "mask.png" } : undefined,
          size,
          quality,
          background: "opaque",
          output_format: "png",
          n,
        }, attempts, true, request.signal)
      : await createImageGeneration(apiKey, { prompt, size, quality, n }, attempts, request.signal);

    const images = (result.data.data ?? []).map((entry) => entry.b64_json).filter((value): value is string => Boolean(value));
    if (!images.length) throw new Error("OpenAI did not return image data.");

    return Response.json({
      ok: true,
      images,
      mimeType: "image/png",
      size,
      usage: result.data.usage,
      retryable: false,
      diagnostics,
    });
  } catch (error) {
    const diagnosed = error instanceof DiagnosedGenerationError ? error : undefined;
    const rootError = diagnosed?.causeError ?? error;
    const base = await errorResponse(rootError).json() as Record<string, unknown>;
    const status = rootError instanceof OpenAIRequestError ? rootError.status : 400;
    return Response.json(
      { ...base, retryable: isRetryableImageError(rootError), diagnostics: diagnosed?.diagnostics ?? diagnostics },
      { status: status >= 400 && status < 600 ? status : 500 },
    );
  }
}
