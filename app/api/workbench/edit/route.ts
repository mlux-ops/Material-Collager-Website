import { MAX_REFERENCE_FILE_BYTES, MAX_REFERENCE_IMAGES } from "@/app/lib/collage";
import {
  DiagnosedGenerationError,
  MARKUP_MAX_BYTES,
  createImageEdit,
  createImageGeneration,
  gifFrameParamsError,
  isRetryableImageError,
  roundFrameDuration,
  safeReferenceFilename,
  validateEditSize,
  validateGifSize,
  validateImagePrompt,
  type AttemptDiagnostic,
  type GenerationDiagnostics,
  type GenerationOutputFormat,
  type ImageQuality,
  type PreparedReference,
} from "@/app/lib/image-edit";
import { OpenAIRequestError, errorResponse, resolveOpenAIKey } from "@/app/lib/openai-server";
import {
  SUNBURST_BACKGROUNDS,
  SUNBURST_COMPLEXITIES,
  SUNBURST_MODEL,
  SUNBURST_QUALITIES,
  TEST_MODEL_2_5,
  isSunburstComplexity,
  isSunburstModel,
  modelSupports,
  resolveWireModel,
  type SunburstBackground,
  type SunburstComplexity,
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
  // 2.6 only, sent only when present (absent keeps the API default, "high").
  complexity?: SunburstComplexity;
  // Animated GIF output only.
  frameCount?: number;
  frameDurationMs?: number;
  apiKey?: string;
};

type OutputFormat = GenerationOutputFormat;
const OUTPUT_FORMATS: OutputFormat[] = ["png", "jpeg", "webp", "svg", "gif"];
const OUTPUT_MIME_TYPES: Record<OutputFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  svg: "image/svg+xml",
  gif: "image/gif",
};
// The edit endpoint neither accepts SVG nor documents GIF as an input, so
// either one is refused here rather than spent on.
const REFUSED_INPUT_TYPES = new Set(["image/svg+xml", "image/gif"]);

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
    if (payload.outputFormat !== undefined && !OUTPUT_FORMATS.includes(payload.outputFormat)) {
      throw new Error("Choose a supported output format.");
    }
    const outputFormat: OutputFormat = payload.outputFormat ?? "png";
    const vectorOrAnimated = outputFormat === "svg" || outputFormat === "gif";
    const size = payload.size || (outputFormat === "gif" ? "512x512" : "1536x1024");
    // A GIF has its own size rule: no per-image pixel floor (OpenAI's own
    // example is 512x512); the frames x pixels budget is enforced upstream.
    const sizeError = outputFormat === "gif" ? validateGifSize(size) : validateEditSize(size);
    if (sizeError) throw new Error(sizeError);
    // The Workbench runs the same model as the rest of the app, so it gets the
    // full Sunburst contract: every quality tier including xhigh and max, an
    // explicit background, and a chosen output format.
    // The Test node sends TEST_MODEL_2_5 (the dated 2.5 snapshot) and is the
    // only caller rendered on 2.5. A stale tab or saved workflow may still send
    // another 2.5 Sunburst id (the bare alias); that is accepted and rendered
    // as the current Sunburst. Anything that is not a Sunburst id
    // (gpt-image-2, Flare, garbage) is refused before spending.
    if (payload.model !== undefined && !isSunburstModel(payload.model)) {
      throw new Error(`This node's model "${payload.model}" is no longer supported; ${SUNBURST_MODEL} is the only image model.`);
    }
    const model = payload.model === TEST_MODEL_2_5 ? TEST_MODEL_2_5 : SUNBURST_MODEL;
    if (payload.quality !== undefined && !SUNBURST_QUALITIES.includes(payload.quality)) {
      throw new Error("Choose a supported quality.");
    }
    const quality: ImageQuality = payload.quality ?? "medium";
    if (payload.background !== undefined && !SUNBURST_BACKGROUNDS.includes(payload.background)) {
      throw new Error("Choose a supported background.");
    }
    const background: SunburstBackground = payload.background ?? "opaque";
    // 2.6-only features are refused for the Test node's 2.5 snapshot before
    // anything is uploaded or spent.
    if (payload.complexity !== undefined && !isSunburstComplexity(payload.complexity)) {
      throw new Error(`Choose a supported complexity: ${SUNBURST_COMPLEXITIES.join(", ")}.`);
    }
    if (payload.complexity !== undefined && !modelSupports(model, "complexity")) {
      throw new Error(`Complexity is a GPT Image 2.6 setting; ${TEST_MODEL_2_5} does not take it.`);
    }
    const complexity = payload.complexity;
    if (vectorOrAnimated && !modelSupports(model, outputFormat)) {
      throw new Error(`${outputFormat.toUpperCase()} output is a GPT Image 2.6 feature; ${TEST_MODEL_2_5} does not offer it.`);
    }
    if (!vectorOrAnimated && (payload.frameCount !== undefined || payload.frameDurationMs !== undefined)) {
      throw new Error("Frame count and frame duration apply only to GIF output.");
    }
    const frameError = outputFormat === "gif" ? gifFrameParamsError(payload.frameCount, payload.frameDurationMs) : null;
    if (frameError) throw new Error(frameError);
    const frameCount = outputFormat === "gif" ? payload.frameCount : undefined;
    const frameDurationMs = outputFormat === "gif" && payload.frameDurationMs !== undefined
      ? roundFrameDuration(payload.frameDurationMs)
      : undefined;
    // Checked here as well as in image-edit so an impossible pairing is
    // rejected before any upload work, not after.
    if (background === "transparent" && outputFormat === "jpeg") {
      throw new Error("Transparent output requires PNG or WebP; choose a compatible format before generating.");
    }
    if (payload.outputCompression !== undefined
      && (!Number.isInteger(payload.outputCompression) || payload.outputCompression < 0 || payload.outputCompression > 100)) {
      throw new Error("Output compression must be a whole number between 0 and 100.");
    }
    // SVG output is always a single image (OpenAI: n must be 1).
    const n = outputFormat === "svg" ? 1 : Math.max(1, Math.min(10, Math.round(Number(payload.n) || 1)));

    const imageFiles = incoming.getAll("image[]").filter((value): value is File => value instanceof File);
    if (imageFiles.length > MAX_REFERENCE_IMAGES) {
      throw new Error(`Use no more than ${MAX_REFERENCE_IMAGES} input images per node.`);
    }
    for (const file of imageFiles) {
      if (!file.type.startsWith("image/")) throw new Error(`Input ${file.name || "image"} is not an image file.`);
      if (REFUSED_INPUT_TYPES.has(file.type)) {
        throw new Error(`Input ${file.name || "image"} is ${file.type === "image/gif" ? "a GIF" : "an SVG"}, which the image model cannot take as an input. Render it as PNG or WebP instead.`);
      }
      if (file.size >= MAX_REFERENCE_FILE_BYTES) throw new Error(`Input ${file.name || "image"} must be under 50 MB.`);
    }
    if (vectorOrAnimated && imageFiles.length) {
      throw new Error("SVG and GIF output are text-to-image only; disconnect the input images or choose PNG, JPEG or WebP.");
    }
    const mask = incoming.get("mask");
    if (mask !== null && (!(mask instanceof File) || mask.type !== "image/png" || mask.size >= 4 * 1024 * 1024)) {
      throw new Error("The mask must be a PNG under 4 MB.");
    }
    if (mask instanceof File && imageFiles.length === 0) {
      throw new Error("A mask needs at least one input image to apply to.");
    }
    // Markup: a transparent PNG annotation layer over the FIRST input image.
    // Its width/height must equal that image's; the edge runtime cannot check
    // that without decoding both, so the Image Edit node checks dimensions
    // and transparency in the browser before upload.
    const markup = incoming.get("markup");
    if (markup !== null && (!(markup instanceof File) || markup.type !== "image/png" || markup.size > MARKUP_MAX_BYTES)) {
      throw new Error("The markup layer must be a transparent PNG no larger than 50 MB.");
    }
    if (markup instanceof File && imageFiles.length === 0) {
      throw new Error("Markup needs an input image to annotate.");
    }
    if (markup instanceof File && mask !== null) {
      throw new Error("Markup and a mask cannot be combined; send one or the other.");
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
      ...(complexity !== undefined ? { complexity } : {}),
      ...(frameCount !== undefined ? { frameCount } : {}),
      ...(frameDurationMs !== undefined ? { frameDurationMs } : {}),
      ...(markup instanceof File ? { markup: true } : {}),
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
          markup: markup instanceof File ? { blob: markup, filename: "markup.png" } : undefined,
          size,
          quality,
          background,
          // vectorOrAnimated with input images was refused above.
          output_format: outputFormat as "png" | "jpeg" | "webp",
          ...(complexity !== undefined ? { complexity } : {}),
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
          ...(complexity !== undefined ? { complexity } : {}),
          ...(frameCount !== undefined ? { frame_count: frameCount } : {}),
          ...(frameDurationMs !== undefined ? { frame_duration_ms: frameDurationMs } : {}),
          ...(payload.outputCompression !== undefined && outputFormat !== "png" && !vectorOrAnimated
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
