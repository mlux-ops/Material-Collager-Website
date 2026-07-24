// Shared server-side machinery for calling OpenAI /v1/images/edits with
// gpt-image-2: multipart transport, retry on transient failures, and
// per-attempt diagnostics. Used by /api/generate (collage pipeline) and
// /api/workbench/* (node editor).

import { OpenAIRequestError, combineAbortSignals, readOpenAIResponse } from "./openai-server.ts";

export type ImageQuality = "low" | "medium" | "high" | "auto";

export type OpenAIImageResponse = {
  data?: Array<{ b64_json?: string }>;
  usage?: Record<string, unknown>;
};

export type PreparedReference = {
  blob: Blob;
  filename: string;
  // Present when the reference also exists as an uploaded OpenAI file (the
  // legacy full-quality path); lets QA reference it by ID instead of inlining
  // a multi-MB base64 copy into the review request.
  fileId?: string;
};

export type ImageEditRequest = {
  model: "gpt-image-2";
  prompt: string;
  references: PreparedReference[];
  mask?: PreparedReference;
  size: string;
  quality: ImageQuality;
  background: "opaque";
  output_format: "png";
  // Number of candidates to generate in one call (1-10). Input tokens are
  // charged once per request, so n>1 beats n separate calls.
  n?: number;
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
  error?: string;
};

export type GenerationDiagnostics = {
  model: "gpt-image-2";
  transport: "multipart";
  quality: ImageQuality;
  referenceCount: number;
  totalReferenceBytes: number;
  largestReferenceBytes: number;
  references: Array<{ filename: string; bytes: number; mimeType: string }>;
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

const IMAGE_RETRY_DELAYS_MS = [1500];

export async function createImageEdit(
  apiKey: string,
  body: ImageEditRequest,
  diagnostics: AttemptDiagnostic[],
  retry = true,
  callerSignal?: AbortSignal,
) {
  let lastError: unknown;
  const retryDelays = retry ? IMAGE_RETRY_DELAYS_MS : [];

  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    const startedAt = Date.now();
    try {
      const form = new FormData();
      form.append("model", body.model);
      form.append("prompt", body.prompt);
      form.append("size", body.size);
      form.append("quality", body.quality);
      form.append("background", body.background);
      form.append("output_format", body.output_format);
      if (body.n && body.n > 1) form.append("n", String(body.n));
      // GPT Image 2 uses high-fidelity image inputs automatically and rejects input_fidelity.
      for (const reference of body.references) {
        form.append("image[]", reference.blob, reference.filename);
      }
      if (body.mask) form.append("mask", body.mask.blob, body.mask.filename);

      const response = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        // E1 cancellation threading: combine the caller's AbortSignal (aborted
        // when the client fetch to /api/workbench/edit is cancelled) with the
        // 300s hard timeout, so BOTH a client cancel and the timeout abort
        // this upstream OpenAI call.
        signal: combineAbortSignals(callerSignal, 300_000),
      });
      const data = await readOpenAIResponse<OpenAIImageResponse>(response);
      diagnostics.push({ stage: "image_edit", outcome: "succeeded", attempt: attempt + 1, durationMs: Date.now() - startedAt, size: body.size });
      return { data, attempts: attempt + 1 };
    } catch (error) {
      diagnostics.push(diagnosticFor(error, "image_edit", attempt + 1, Date.now() - startedAt, body.size));
      lastError = error;
      if (!isRetryableImageError(error) || attempt === retryDelays.length) {
        throw new DiagnosedGenerationError(error, {
          model: body.model,
          transport: "multipart",
          quality: body.quality,
          referenceCount: body.references.length,
          totalReferenceBytes: body.references.reduce((sum, reference) => sum + reference.blob.size, 0),
          largestReferenceBytes: Math.max(...body.references.map((reference) => reference.blob.size), 0),
          references: body.references.map((reference) => ({ filename: reference.filename, bytes: reference.blob.size, mimeType: reference.blob.type })),
          attempts: diagnostics,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));
    }
  }

  throw lastError instanceof Error ? lastError : new Error("OpenAI image generation failed.");
}

// Pure text-to-image (no input images) uses /v1/images/generations with a
// JSON body instead of multipart edits.
export async function createImageGeneration(
  apiKey: string,
  body: { prompt: string; size: string; quality: ImageQuality; n?: number },
  diagnostics: AttemptDiagnostic[],
  callerSignal?: AbortSignal,
) {
  const startedAt = Date.now();
  try {
    const response = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-image-2",
        prompt: body.prompt,
        size: body.size,
        quality: body.quality,
        output_format: "png",
        ...(body.n && body.n > 1 ? { n: body.n } : {}),
      }),
      // E1 cancellation threading — see createImageEdit above.
      signal: combineAbortSignals(callerSignal, 300_000),
    });
    const data = await readOpenAIResponse<OpenAIImageResponse>(response);
    diagnostics.push({ stage: "image_edit", outcome: "succeeded", attempt: 1, durationMs: Date.now() - startedAt, size: body.size });
    return { data, attempts: 1 };
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

export function isRetryableImageError(error: unknown): boolean {
  if (error instanceof DiagnosedGenerationError) return isRetryableImageError(error.causeError);
  if (error instanceof TypeError) return true;
  if (!(error instanceof OpenAIRequestError)) return false;
  if (error.status === 408 || error.status === 409 || error.status >= 500) return true;
  return error.status === 429 && !/quota|billing|credit/i.test(error.message);
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

// Conforms arbitrary dimensions to the same gpt-image-2 constraints
// validateEditSize checks (divisible by 16, aspect 1:3-3:1, longest edge
// <=3840, total pixels 655,360-8,294,400). Used by zero-token client nodes
// (Resize/Crop) so a downstream edit node's input always passes
// validateEditSize without a wasted paid round trip. Pure math — no DOM/
// canvas access — so it runs equally well in the browser (Resize/Crop) or on
// the server.
export function clampToValidEditSize(rawWidth: number, rawHeight: number): { width: number; height: number } {
  const roundTo16 = (value: number) => Math.max(16, Math.round(value / 16) * 16);

  let width = roundTo16(rawWidth || 16);
  let height = roundTo16(rawHeight || 16);

  // A few passes converge aspect/longest-edge/pixel-count clamps back onto a
  // multiple of 16 (each clamp can nudge the other constraints slightly).
  for (let pass = 0; pass < 6; pass += 1) {
    if (validateEditSize(`${width}x${height}`) === null) break;

    if (width / height > 3) width = roundTo16(height * 3);
    else if (height / width > 3) height = roundTo16(width * 3);

    const longest = Math.max(width, height);
    if (longest > 3840) {
      const scale = 3840 / longest;
      width = roundTo16(width * scale);
      height = roundTo16(height * scale);
    }

    const pixels = width * height;
    if (pixels > 8_294_400) {
      const scale = Math.sqrt(8_294_400 / pixels);
      width = roundTo16(width * scale);
      height = roundTo16(height * scale);
    } else if (pixels < 655_360) {
      const scale = Math.sqrt(655_360 / pixels);
      width = roundTo16(width * scale);
      height = roundTo16(height * scale);
    }
  }

  return { width, height };
}
