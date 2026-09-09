import { MAX_REFERENCE_FILE_BYTES, MAX_REFERENCE_IMAGES } from "@/app/lib/collage";
import {
  DiagnosedGenerationError,
  createImageEdit,
  createImageGeneration,
  isRetryableImageError,
  safeReferenceFilename,
  validateEditSize,
  validateImagePrompt,
  type AttemptDiagnostic,
  type GenerationDiagnostics,
  type ImageQuality,
  type PreparedReference,
} from "@/app/lib/image-edit";
import { OpenAIRequestError, errorResponse, resolveOpenAIKey } from "@/app/lib/openai-server";
import {
  SUNBURST_BACKGROUNDS,
  SUNBURST_MODEL,
  SUNBURST_QUALITIES,
  isSunburstModel,
  resolveWireModel,
  type SunburstBackground,
} from "@/app/lib/sunburst";

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
  model?: string;
  background?: SunburstBackground;
  outputFormat?: OutputFormat;
  outputCompression?: number;
  apiKey?: string;
};

type OutputFormat = "png" | "jpeg" | "webp";
const OUTPUT_FORMATS: OutputFormat[] = ["png", "jpeg", "webp"];
const OUTPUT_MIME_TYPES: Record<OutputFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

export async function POST(request: Request) {
  let diagnostics: GenerationDiagnostics | undefined;
  try {
    const incoming = await request.formData();
    const payloadText = incoming.get("payload");
    if (typeof payloadText !== "string") throw new Error("Missing workbench payload.");
    const payload = JSON.parse(payloadText) as WorkbenchEditPayload;

    const prompt = payload.prompt?.trim() || "";
    // The empty-prompt message is node-editor specific; the length limit is
    // the shared rule from image-edit.ts so it can't drift from /api/generate.
    if (!prompt) throw new Error("Connect or enter a prompt before running this node.");
    validateImagePrompt(prompt);
    const size = payload.size || "1536x1024";
    const sizeError = validateEditSize(size);
    if (sizeError) throw new Error(sizeError);
    // The Workbench runs the same model as the rest of the app, so it gets the
    // full Sunburst contract: every quality tier including xhigh and max, an
    // explicit background, and a chosen output format.
    if (payload.model !== undefined && !isSunburstModel(payload.model)) {
      throw new Error(`This node's model "${payload.model}" is no longer supported; Sunburst is the only image model.`);
    }
    const model = SUNBURST_MODEL;
    if (payload.quality !== undefined && !SUNBURST_QUALITIES.includes(payload.quality)) {
      throw new Error("Choose a supported quality.");
    }
    const quality: ImageQuality = payload.quality ?? "medium";
    if (payload.background !== undefined && !SUNBURST_BACKGROUNDS.includes(payload.background)) {
      throw new Error("Choose a supported background.");
    }
    const background: SunburstBackground = payload.background ?? "opaque";
    if (payload.outputFormat !== undefined && !OUTPUT_FORMATS.includes(payload.outputFormat)) {
      throw new Error("Choose a supported output format.");
    }
    const outputFormat: OutputFormat = payload.outputFormat ?? "png";
    // Checked here as well as in image-edit so an impossible pairing is
    // rejected before any upload work, not after.
    if (background === "transparent" && outputFormat === "jpeg") {
      throw new Error("Transparent output requires PNG or WebP; choose a compatible format before generating.");
    }
    if (payload.outputCompression !== undefined
      && (!Number.isInteger(payload.outputCompression) || payload.outputCompression < 0 || payload.outputCompression > 100)) {
      throw new Error("Output compression must be a whole number between 0 and 100.");
    }
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
      model,
      wireModel: resolveWireModel(model),
      transport: "multipart",
      quality,
      background,
      outputFormat,
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
          model,
          prompt,
          references,
          mask: mask instanceof File ? { blob: mask, filename: "mask.png" } : undefined,
          size,
          quality,
          background,
          output_format: outputFormat,
          ...(payload.outputCompression !== undefined && outputFormat !== "png"
            ? { output_compression: payload.outputCompression }
            : {}),
          n,
        }, attempts, request.signal)
      : await createImageGeneration(apiKey, {
          model,
          prompt,
          size,
          quality,
          background,
          output_format: outputFormat,
          ...(payload.outputCompression !== undefined && outputFormat !== "png"
            ? { output_compression: payload.outputCompression }
            : {}),
          n,
        }, attempts, request.signal);

    const images = (result.data.data ?? []).map((entry) => entry.b64_json).filter((value): value is string => Boolean(value));
    if (!images.length) throw new Error("OpenAI did not return image data.");

    return Response.json({
      ok: true,
      images,
      mimeType: OUTPUT_MIME_TYPES[outputFormat],
      size,
      usage: result.data.usage,
      retryable: false,
      diagnostics,
    });
  } catch (error) {
    const diagnosed = error instanceof DiagnosedGenerationError ? error : undefined;
    const rootError = diagnosed?.causeError ?? error;
    const upstream = errorResponse(rootError);
    const base = await upstream.json() as Record<string, unknown>;
    const status = rootError instanceof OpenAIRequestError ? rootError.status : 400;
    // Re-wrapped to attach diagnostics; keep the provider's Retry-After header.
    const retryAfter = upstream.headers.get("Retry-After");
    return Response.json(
      { ...base, retryable: isRetryableImageError(rootError), diagnostics: diagnosed?.diagnostics ?? diagnostics },
      { status: status >= 400 && status < 600 ? status : 500, headers: retryAfter ? { "Retry-After": retryAfter } : undefined },
    );
  }
}
