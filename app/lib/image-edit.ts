// Shared server-side machinery for calling OpenAI /v1/images/edits with
// Sunburst: multipart transport, single-attempt execution, and
// per-attempt diagnostics. Used by /api/generate (collage pipeline) and
// /api/workbench/* (node editor).

import { OpenAIRequestError, combineAbortSignals, readOpenAIResponse } from "./openai-server.ts";
import {
  LEGACY_IMAGE_MODEL,
  SUNBURST_MODEL,
  resolveWireModel,
  type SunburstBackground,
  type SunburstQuality,
} from "./sunburst.ts";

export type ImageQuality = SunburstQuality;
export type ImageBackground = SunburstBackground;
export type ImageModel = typeof SUNBURST_MODEL | typeof LEGACY_IMAGE_MODEL;

export type OpenAIImageResponse = {
  data?: Array<{ b64_json?: string }>;
  usage?: Record<string, unknown>;
};

/**
 * One reference image, held either as bytes or as an already-uploaded file.
 *
 * A reference that OpenAI already stores needs neither half of the old
 * round trip: `blob` stays undefined and the edit request names the file by id
 * instead of downloading it and posting the same bytes straight back.
 */
export type PreparedReference = {
  // Undefined for a reference that exists only as an uploaded OpenAI file.
  blob?: Blob;
  filename: string;
  // Present when the reference exists as an uploaded OpenAI file. Also lets QA
  // reference it by ID instead of inlining a multi-MB base64 copy.
  fileId?: string;
};

export function referenceBytes(reference: PreparedReference): number {
  return reference.blob?.size ?? 0;
}

export type ImageEditRequest = {
  model: ImageModel;
  prompt: string;
  references: PreparedReference[];
  mask?: PreparedReference;
  size: string;
  quality: ImageQuality;
  background: ImageBackground;
  output_format: "png" | "jpeg" | "webp";
  // 0-100; OpenAI applies this only to jpeg/webp and ignores it for png, so
  // createImageEdit only sends it alongside those two formats.
  output_compression?: number;
  // Number of requested candidates (1-10). Additional candidates consume
  // output tokens; use the returned usage rather than assuming an input discount.
  n?: number;
  // Wall-clock ceiling for one attempt. Undefined uses IMAGE_EDIT_TIMEOUT_MS;
  // NULL disables the timer entirely, for long user-initiated work that must
  // be allowed to finish rather than be killed mid-render. The caller's
  // AbortSignal is still honoured either way, so cancellation is unaffected.
  timeoutMs?: number | null;
};

export type AttemptDiagnostic = {
  stage: "reference_fetch" | "image_edit";
  outcome: "succeeded" | "failed";
  attempt: number;
  durationMs: number;
  size?: string;
  status?: number;
  code?: string;
  requestId?: string;
  // Server-provided wait (from Retry-After) and OpenAI's error `type`, so a
  // caller reading the diagnostics can schedule a retry correctly or tell a
  // user-correctable input error apart from a provider fault.
  retryAfterMs?: number;
  errorType?: string;
  error?: string;
};

export type ImageEditTransport = "multipart" | "file_id";

export type GenerationDiagnostics = {
  model: ImageModel;
  // The exact model id put on the wire. Differs from `model` whenever the
  // stored Sunburst alias resolves to its pinned dated snapshot, so a stored
  // diagnostic records which snapshot actually produced the pixels.
  wireModel?: string;
  transport: ImageEditTransport;
  quality: ImageQuality;
  background?: ImageBackground;
  outputFormat?: "png" | "jpeg" | "webp";
  referenceCount: number;
  totalReferenceBytes: number;
  largestReferenceBytes: number;
  references: Array<{ filename: string; bytes: number; mimeType: string; fileId?: string }>;
  attempts: AttemptDiagnostic[];
};

export class DiagnosedGenerationError extends Error {
  causeError: unknown;
  diagnostics: GenerationDiagnostics;

  constructor(error: unknown, diagnostics: GenerationDiagnostics) {
    super(error instanceof Error ? error.message : "OpenAI image generation failed.");
    this.name = "DiagnosedGenerationError";
    this.causeError = error;
    this.diagnostics = diagnostics;
  }
}

// Default wall-clock ceiling for ONE upstream attempt. A caller can override
// it per request, including disabling it outright — see ImageEditRequest.
export const IMAGE_EDIT_TIMEOUT_MS = 300_000;

/**
 * Pick the transport for one edit request.
 *
 * `file_id` needs every reference to be an uploaded file and no bytes-only
 * mask, since the endpoint takes one form or the other, never a mix. Anything
 * else falls back to multipart, which always works.
 */
export function resolveTransport(body: ImageEditRequest): ImageEditTransport {
  if (body.references.length === 0) return "multipart";
  if (!body.references.every((reference) => reference.fileId && !reference.blob)) return "multipart";
  if (body.mask && !body.mask.fileId) return "multipart";
  return "file_id";
}

function buildEditForm(body: ImageEditRequest, wireModel: string) {
  const form = new FormData();
  form.append("model", wireModel);
  form.append("prompt", body.prompt);
  form.append("size", body.size);
  form.append("quality", body.quality);
  form.append("background", body.background);
  form.append("output_format", body.output_format);
  if (body.output_compression !== undefined && (body.output_format === "jpeg" || body.output_format === "webp")) {
    form.append("output_compression", String(body.output_compression));
  }
  if (body.n && body.n > 1) form.append("n", String(body.n));
  for (const reference of body.references) {
    if (!reference.blob) {
      // resolveTransport only selects multipart when at least one reference
      // lacks bytes, so reaching here means the caller mixed forms.
      throw new Error(`Reference ${reference.filename} has no image data to upload.`);
    }
    form.append("image[]", reference.blob, reference.filename);
  }
  if (body.mask?.blob) form.append("mask", body.mask.blob, body.mask.filename);
  return form;
}

export async function createImageEdit(
  apiKey: string,
  body: ImageEditRequest,
  diagnostics: AttemptDiagnostic[],
  callerSignal?: AbortSignal,
) {
  validateImagePrompt(body.prompt);
  if (body.background === "transparent" && body.output_format === "jpeg") {
    throw new Error("Transparent output requires PNG or WebP; choose a compatible format before generating.");
  }
  const startedAt = Date.now();
  const wireModel = resolveWireModel(body.model);
  // No input_fidelity anywhere: every model this app uses rejects it. See
  // SUNBURST_SUPPORTS_INPUT_FIDELITY.
  // Declared outside the try so the failure diagnostics below can report what
  // was actually attempted.
  const transport: ImageEditTransport = resolveTransport(body);
  try {
    callerSignal?.throwIfAborted();

    // Every reference OpenAI already stores can be named by id instead of
    // shipped as bytes. That drops a download and a re-upload of the same
    // multi-MB images per render and keeps the request far below the 32 MB
    // body cap. It does NOT buy the cached image-input rate: /v1/images/edits
    // exposes no cache parameter, so any caching there is implicit and
    // unsteerable. Mixing the two forms in one request is not supported, so a
    // single bytes-only reference sends the whole set as multipart.
    const response = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: transport === "file_id"
        ? { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }
        : { Authorization: `Bearer ${apiKey}` },
      body: transport === "file_id"
        ? JSON.stringify({
          model: wireModel,
          prompt: body.prompt,
          images: body.references.map((reference) => ({ file_id: reference.fileId })),
          size: body.size,
          quality: body.quality,
          background: body.background,
          output_format: body.output_format,
          ...(body.output_compression !== undefined && body.output_format !== "png"
            ? { output_compression: body.output_compression }
            : {}),
          ...(body.n && body.n > 1 ? { n: body.n } : {}),
          ...(body.mask?.fileId ? { mask: { file_id: body.mask.fileId } } : {}),
        })
        : buildEditForm(body, wireModel),
      // E1 cancellation threading: combine the caller's AbortSignal (aborted
      // when the client fetch to /api/workbench/edit is cancelled) with the
      // per-attempt timeout, so BOTH a client cancel and the timeout abort
      // this upstream OpenAI call. A null body.timeoutMs drops only the
      // timer — the caller's cancel still lands.
      signal: combineAbortSignals(
        callerSignal,
        body.timeoutMs === null ? undefined : body.timeoutMs ?? IMAGE_EDIT_TIMEOUT_MS,
      ),
    });
    const data = await readOpenAIResponse<OpenAIImageResponse>(response, {
      label: "image.edit",
      model: body.model,
    });
    diagnostics.push({ stage: "image_edit", outcome: "succeeded", attempt: 1, durationMs: Date.now() - startedAt, size: body.size });
    return { data };
  } catch (error) {
    diagnostics.push(diagnosticFor(error, "image_edit", 1, Date.now() - startedAt, body.size));
    // A failed provider request may have reached the service. Surface it to
    // the caller instead of silently charging for a duplicate render.
    throw new DiagnosedGenerationError(error, {
      model: body.model,
      wireModel,
      // A file_id request carries no bytes, so the byte counters below are 0
      // by construction. `transport` is what tells the two cases apart.
      transport,
      quality: body.quality,
      background: body.background,
      outputFormat: body.output_format,
      referenceCount: body.references.length,
      totalReferenceBytes: body.references.reduce((sum, reference) => sum + referenceBytes(reference), 0),
      largestReferenceBytes: Math.max(...body.references.map(referenceBytes), 0),
      references: body.references.map((reference) => ({
        filename: reference.filename,
        bytes: referenceBytes(reference),
        mimeType: reference.blob?.type ?? "",
        ...(reference.fileId ? { fileId: reference.fileId } : {}),
      })),
      attempts: diagnostics,
    });
  }
}

// Pure text-to-image (no input images) uses /v1/images/generations with a
// JSON body instead of multipart edits.
export async function createImageGeneration(
  apiKey: string,
  body: {
    prompt: string;
    size: string;
    quality: ImageQuality;
    n?: number;
    model?: ImageModel;
    background?: ImageBackground;
    output_format?: "png" | "jpeg" | "webp";
    output_compression?: number;
  },
  diagnostics: AttemptDiagnostic[],
  callerSignal?: AbortSignal,
) {
  validateImagePrompt(body.prompt);
  // Callers name their model; the legacy default only covers an omitted one.
  const model = body.model ?? LEGACY_IMAGE_MODEL;
  const background = body.background ?? "opaque";
  const outputFormat = body.output_format ?? "png";
  if (background === "transparent" && outputFormat === "jpeg") {
    throw new Error("Transparent output requires PNG or WebP; choose a compatible format before generating.");
  }
  const startedAt = Date.now();
  try {
    callerSignal?.throwIfAborted();
    const response = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: resolveWireModel(model),
        prompt: body.prompt,
        size: body.size,
        quality: body.quality,
        output_format: outputFormat,
        ...(body.output_compression !== undefined && outputFormat !== "png"
          ? { output_compression: body.output_compression }
          : {}),
        background,
        ...(body.n && body.n > 1 ? { n: body.n } : {}),
      }),
      // E1 cancellation threading — see createImageEdit above.
      signal: combineAbortSignals(callerSignal, 300_000),
    });
    const data = await readOpenAIResponse<OpenAIImageResponse>(response, {
      label: "image.generate",
        model,
    });
    diagnostics.push({ stage: "image_edit", outcome: "succeeded", attempt: 1, durationMs: Date.now() - startedAt, size: body.size });
    return { data };
  } catch (error) {
    diagnostics.push(diagnosticFor(error, "image_edit", 1, Date.now() - startedAt, body.size));
    throw error;
  }
}

export function diagnosticFor(error: unknown, stage: AttemptDiagnostic["stage"], attempt: number, durationMs: number, size?: string): AttemptDiagnostic {
  const openAIError = error instanceof OpenAIRequestError ? error : undefined;
  return {
    stage,
    outcome: "failed",
    attempt,
    durationMs,
    size,
    status: openAIError?.status,
    code: openAIError?.code,
    requestId: openAIError?.requestId,
    retryAfterMs: openAIError?.retryAfterMs,
    errorType: openAIError?.errorType,
    error: error instanceof Error ? error.message.slice(0, 500) : "Unknown error.",
  };
}

export function referenceContentType(header: string | null, filename: string) {
  if (header?.toLowerCase().startsWith("image/")) return header.split(";")[0].trim();
  const lower = filename.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/png";
}

export function safeReferenceFilename(value: string) {
  const safe = value.replace(/[\r\n"\\/]+/g, "_").trim();
  return safe || "reference.png";
}

// "Retryable" here means "safe to submit the SAME paid render again", not
// merely "transient". A failure is only safe to repeat when the provider
// demonstrably rejected the request (409 conflict, 5xx, or a non-quota 429);
// a raw network error (TypeError from fetch) is deliberately NOT retryable
// because the request body may already have been accepted and billed — the
// caller cannot tell, so it must not automatically repeat it.
export function isRetryableImageError(error: unknown): boolean {
  if (error instanceof DiagnosedGenerationError) return isRetryableImageError(error.causeError);
  if (!(error instanceof OpenAIRequestError)) return false;
  if (error.errorType === "image_generation_user_error" || /quota|billing|credit|moderation_blocked/i.test(error.code ?? "")) return false;
  if (error.status === 409 || error.status >= 500) return true;
  return error.status === 429 && !/quota|billing|credit/i.test(error.message);
}

export function validateImagePrompt(prompt: string) {
  if (!prompt.trim()) throw new Error("Enter an image prompt before generating.");
  if (prompt.length > 32_000) throw new Error("The prompt exceeds the 32,000 character limit. Shorten the item notes or prompt and retry.");
}

// gpt-image-2 size constraints: dimensions divisible by 16, aspect between
// 1:3 and 3:1, longest edge <= 3840, total pixels 655,360 - 8,294,400.
export function validateEditSize(size: string): string | null {
  const match = /^(\d{2,4})x(\d{2,4})$/.exec(size);
  if (!match) return "Size must look like 1536x1024.";
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width % 16 !== 0 || height % 16 !== 0) return "Width and height must be divisible by 16.";
  if (Math.max(width, height) > 3840) return "The longest edge cannot exceed 3840 pixels.";
  const aspect = width / height;
  if (aspect < 1 / 3 || aspect > 3) return "Aspect ratio must be between 1:3 and 3:1.";
  const pixels = width * height;
  if (pixels < 655_360) return "Total pixels must be at least 655,360 (e.g. 1024x640).";
  if (pixels > 8_294_400) return "Total pixels cannot exceed 8,294,400 (3840x2160).";
  return null;
}

const EDIT_SIZE_FLOOR_PIXELS = 655_360;
const EDIT_SIZE_CEILING_PIXELS = 8_294_400;
const EDIT_SIZE_MAX_EDGE = 3840;
const EDIT_SIZE_UNIT = 16;

// Deterministic constraint solve shared by clampToValidEditSize and
// smallestValidEditSize below (not an iterative rescale, which could return
// an INVALID size for extreme raw ratios — e.g. the old clampToValidEditSize
// clamped 20x1000 to 464x1408, which still fails the 1:3 aspect bound,
// because scaling both dimensions by a common factor to fix the pixel-count
// floor and then independently rounding each to the nearest 16 can nudge the
// ratio back past 3:1, and the two constraints could oscillate against each
// other indefinitely for such inputs). Given an ASPECT already clamped into
// [1/3,3] and a PIXEL-COUNT target already clamped into [floor,ceiling]:
//   1. Solve the real-valued size at that aspect + pixel count, then
//      re-clamp the longest edge by scaling BOTH dimensions by the same
//      factor (preserves the ratio exactly; provably cannot push the pixel
//      count below the floor — the smallest possible post-cap pixel count,
//      at the most extreme allowed aspect of 3:1, is 3840^2/3 ≈ 4.9 MP, well
//      above the 655,360 floor).
//   2. Move onto the 16-pixel grid, then run a small BOUNDED, strictly
//      monotonic correction walk (never rescaling both dimensions together,
//      only ever nudging ONE dimension by one grid step in the direction
//      that fixes the SPECIFIC violation) to absorb any rounding drift —
//      this cannot oscillate the way the old rescale-based loop could,
//      because each step only ever moves a single constraint's violation
//      strictly toward zero.
function solveEditSize(aspect: number, targetPixels: number): { width: number; height: number } {
  let h = Math.sqrt(targetPixels / aspect);
  let w = aspect * h;

  const longest = Math.max(w, h);
  if (longest > EDIT_SIZE_MAX_EDGE) {
    const scale = EDIT_SIZE_MAX_EDGE / longest;
    w *= scale;
    h *= scale;
  }

  let width = Math.max(EDIT_SIZE_UNIT, Math.round(w / EDIT_SIZE_UNIT) * EDIT_SIZE_UNIT);
  let height = Math.max(EDIT_SIZE_UNIT, Math.round(h / EDIT_SIZE_UNIT) * EDIT_SIZE_UNIT);

  // Defensive, bounded correction pass for rounding drift (empirically never
  // needs more than 2-3 steps; the guard is generous headroom, not an
  // expected iteration count).
  for (let guard = 0; guard < 64 && validateEditSize(`${width}x${height}`) !== null; guard += 1) {
    if (width / height > 3) {
      width -= EDIT_SIZE_UNIT;
    } else if (height / width > 3) {
      height -= EDIT_SIZE_UNIT;
    } else if (Math.max(width, height) > EDIT_SIZE_MAX_EDGE) {
      if (width >= height) width -= EDIT_SIZE_UNIT;
      else height -= EDIT_SIZE_UNIT;
    } else if (width * height > EDIT_SIZE_CEILING_PIXELS) {
      if (width >= height) width -= EDIT_SIZE_UNIT;
      else height -= EDIT_SIZE_UNIT;
    } else if (width * height < EDIT_SIZE_FLOOR_PIXELS) {
      if (width <= height) width += EDIT_SIZE_UNIT;
      else height += EDIT_SIZE_UNIT;
    } else {
      break; // validateEditSize disagreed for an unanticipated reason; stop rather than loop forever.
    }
    width = Math.max(EDIT_SIZE_UNIT, width);
    height = Math.max(EDIT_SIZE_UNIT, height);
  }

  return { width, height };
}

// Conforms arbitrary dimensions to the same gpt-image-2 constraints
// validateEditSize checks (divisible by 16, aspect 1:3-3:1, longest edge
// <=3840, total pixels 655,360-8,294,400). Used by zero-token client nodes
// (Resize/Crop) so a downstream edit node's input always passes
// validateEditSize without a wasted paid round trip. Pure math — no DOM/
// canvas access — so it runs equally well in the browser (Resize/Crop) or on
// the server. Clamps the TARGET aspect ratio into [1/3,3] first (the
// constraint most likely to be impossible to satisfy at the raw ratio), then
// picks a target pixel count within [floor,ceiling] preferring the raw pixel
// count when already in range, then hands both to solveEditSize.
export function clampToValidEditSize(rawWidth: number, rawHeight: number): { width: number; height: number } {
  const rawW = Math.max(1, rawWidth || 1);
  const rawH = Math.max(1, rawHeight || 1);
  const aspect = Math.min(3, Math.max(1 / 3, rawW / rawH));
  const targetPixels = Math.min(EDIT_SIZE_CEILING_PIXELS, Math.max(EDIT_SIZE_FLOOR_PIXELS, rawW * rawH));
  return solveEditSize(aspect, targetPixels);
}

// The SMALLEST valid gpt-image-2 size at the given (width, height)'s aspect
// ratio — i.e. solveEditSize pinned to the pixel-count FLOOR rather than a
// clamp of the raw pixel count. Used by Draft mode's small-size half
// (generation.ts's generationDraftOverride, AC22/issue-3): every draft-
// capable node's effective size shrinks to genuinely small, including the
// Upscaler, whose selected target can be as large as 3840x2160 — draft mode
// must not leave that unchanged.
export function smallestValidEditSize(width: number, height: number): { width: number; height: number } {
  const aspect = Math.min(3, Math.max(1 / 3, Math.max(1, width || 1) / Math.max(1, height || 1)));
  return solveEditSize(aspect, EDIT_SIZE_FLOOR_PIXELS);
}
