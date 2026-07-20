import {
  activeItems,
  buildGenerationPrompt,
  buildSummary,
  referenceCount,
  resolvedOrientation,
  resolvedSize,
  type CollageRequestInput,
  validateCollageRequest,
} from "@/app/lib/collage";
import {
  OpenAIRequestError,
  errorResponse,
  readOpenAIResponse,
  resolveOpenAIKey,
} from "@/app/lib/openai-server";
import { persistGenerationOutput, type RenderKind } from "@/app/lib/generation-jobs";

export const runtime = "edge";

type OpenAIImageResponse = {
  data?: Array<{ b64_json?: string }>;
  usage?: Record<string, unknown>;
};

type OpenAIResponseOutput = {
  output_text?: string;
  output?: Array<{
    content?: Array<{ text?: string }>;
  }>;
};

type ImageEditRequest = {
  model: "gpt-image-2";
  prompt: string;
  references: PreparedReference[];
  mask?: PreparedReference;
  size: string;
  quality: CollageRequestInput["quality"];
  background: "opaque";
  output_format: "png";
};

type PreparedReference = {
  blob: Blob;
  filename: string;
};

type QaItemReview = {
  id: string;
  passed: boolean;
  finding: string;
  box?: [number, number, number, number];
};

type QaReview = {
  passed: boolean;
  score: number;
  findings: string[];
  recommendation: string;
  items: QaItemReview[];
  reviewFailed?: boolean;
};

type AttemptDiagnostic = {
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

type GenerationDiagnostics = {
  model: "gpt-image-2";
  transport: "multipart";
  quality: CollageRequestInput["quality"];
  referenceCount: number;
  totalReferenceBytes: number;
  largestReferenceBytes: number;
  references: Array<{ filename: string; bytes: number; mimeType: string }>;
  attempts: AttemptDiagnostic[];
};

class DiagnosedGenerationError extends Error {
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

export async function POST(request: Request) {
  let diagnostics: GenerationDiagnostics | undefined;
  try {
    const diagnosticMode = new URL(request.url).searchParams.get("diagnostic") === "isolation";
    const incoming = await request.formData();
    const payloadText = incoming.get("payload");
    if (typeof payloadText !== "string") throw new Error("Missing generation payload.");
    const payload = JSON.parse(payloadText) as CollageRequestInput;
    validateCollageRequest(payload);

    const items = activeItems(payload);
    const directFiles = incoming.getAll("image[]").filter((value): value is File => value instanceof File);
    const selectedIds = new Set(payload.qaSelection?.itemIds ?? []);
    const selectiveEdit = selectedIds.size > 0;
    const boardReferenceCount = items.reduce(
      (total, item) => total + Math.max(item.imageNames?.length ?? 0, item.imageFileIds?.length ?? 0),
      0,
    );
    const selectedReferenceCount = items.reduce(
      (total, item) => selectedIds.has(item.id)
        ? total + Math.max(item.imageNames?.length ?? 0, item.imageFileIds?.length ?? 0)
        : total,
      0,
    );
    const requestedDiagnosticCount = Math.max(
      1,
      Math.min(boardReferenceCount, Number(new URL(request.url).searchParams.get("count") || 1)),
    );
    const expectedProductReferences = diagnosticMode
      ? requestedDiagnosticCount
      : selectiveEdit
        ? selectedReferenceCount
        : boardReferenceCount;
    const expectedReferences = expectedProductReferences + (!diagnosticMode && !selectiveEdit && payload.layoutReference ? 1 : 0);

    const apiKey = resolveOpenAIKey(payload.apiKey);
    const prompt = buildGenerationPrompt(payload);
    const attempts: AttemptDiagnostic[] = [];
    diagnostics = {
      model: "gpt-image-2",
      transport: "multipart",
      quality: payload.quality,
      referenceCount: expectedReferences,
      totalReferenceBytes: 0,
      largestReferenceBytes: 0,
      references: [],
      attempts,
    };
    const remoteProductReferences = items.flatMap((item) =>
      (item.imageFileIds ?? []).map((fileId, index) => ({
        fileId,
        filename: item.imageNames?.[index] || `${item.id}-${index + 1}.png`,
      })),
    );
    let preparedReferences: PreparedReference[];
    if (directFiles.length) {
      if (directFiles.length !== expectedReferences) {
        throw new Error("One or more reference images were missing from the direct generation request.");
      }
      preparedReferences = directFiles.map((file) => ({ blob: file, filename: safeReferenceFilename(file.name) }));
    } else if (!diagnosticMode && !selectiveEdit && remoteProductReferences.length === boardReferenceCount) {
      const remoteReferences = payload.layoutReference && payload.layoutReferenceFileId
        ? [{ fileId: payload.layoutReferenceFileId, filename: "approved-draft.png" }, ...remoteProductReferences]
        : remoteProductReferences;
      if (remoteReferences.length !== expectedReferences) {
        throw new Error("The approved draft or one of its full-quality references is no longer available. Upload it again and retry.");
      }
      preparedReferences = await retrieveReferences(apiKey, remoteReferences, attempts);
    } else {
      throw new Error("One or more reference images were missing from the generation request.");
    }
    const productReferences = payload.layoutReference && !selectiveEdit ? preparedReferences.slice(1) : preparedReferences;
    diagnostics.totalReferenceBytes = preparedReferences.reduce((sum, reference) => sum + reference.blob.size, 0);
    diagnostics.largestReferenceBytes = Math.max(...preparedReferences.map((reference) => reference.blob.size), 0);
    diagnostics.references = preparedReferences.map((reference) => ({
      filename: reference.filename,
      bytes: reference.blob.size,
      mimeType: reference.blob.type,
    }));
    let generationReferences = preparedReferences;
    let editMask: PreparedReference | undefined;
    let requestedSize = resolvedSize(payload);

    if (selectiveEdit) {
      const baseImage = incoming.get("baseImage");
      const mask = incoming.get("mask");
      if (!(baseImage instanceof File) || !baseImage.type.startsWith("image/")) {
        throw new Error("The current collage was missing from the selective QA edit.");
      }
      if (!(mask instanceof File) || mask.type !== "image/png" || mask.size >= 4 * 1024 * 1024) {
        throw new Error("The selective QA mask must be a PNG under 4 MB.");
      }
      const width = Number(payload.qaSelection?.baseWidth);
      const height = Number(payload.qaSelection?.baseHeight);
      if (!validEditDimension(width) || !validEditDimension(height) || width / height < 1 / 3 || width / height > 3) {
        throw new Error("The selective QA edit has unsupported canvas dimensions.");
      }
      if (!preparedReferences.length) throw new Error("Select at least one referenced item to re-render.");
      generationReferences = [
        { blob: baseImage, filename: baseImage.type === "image/jpeg" ? "current-collage.jpg" : "current-collage.png" },
        ...preparedReferences,
      ];
      if (generationReferences.length > 16) {
        throw new Error("This correction selects too many supporting views. Uncheck an item or remove one supporting view.");
      }
      editMask = { blob: mask, filename: "qa-edit-mask.png" };
      requestedSize = `${width}x${height}`;
    }

    const imageRequest: ImageEditRequest = {
      model: "gpt-image-2",
      prompt,
      references: generationReferences,
      mask: editMask,
      size: requestedSize,
      quality: payload.quality,
      background: "opaque",
      output_format: "png",
    };
    if (diagnosticMode) {
      const counts = [requestedDiagnosticCount];
      const isolationResults: Array<{ referenceCount: number; outcome: "succeeded" | "failed"; requestId?: string; error?: string }> = [];
      let diagnosticImageBase64: string | undefined;
      for (const count of counts) {
        const before = diagnostics.attempts.length;
        try {
          const testResult = await createImageEdit(apiKey, {
            ...imageRequest,
            prompt: "Create a simple clean material reference board using every supplied image.",
            references: preparedReferences.slice(0, count),
            size: "1024x1024",
            quality: "low",
          }, diagnostics.attempts, false);
          diagnosticImageBase64 = testResult.data.data?.[0]?.b64_json;
          isolationResults.push({ referenceCount: count, outcome: "succeeded" });
        } catch (error) {
          const root = error instanceof DiagnosedGenerationError ? error.causeError : error;
          isolationResults.push({
            referenceCount: count,
            outcome: "failed",
            requestId: root instanceof OpenAIRequestError ? root.requestId : undefined,
            error: root instanceof Error ? root.message : "Unknown error.",
          });
          break;
        }
        if (diagnostics.attempts.length === before) break;
      }
      return Response.json({
        ok: true,
        diagnosticComplete: true,
        diagnostics,
        isolationResults,
        imageBase64: diagnosticImageBase64,
        mimeType: "image/png",
        filename: "isolation-test.png",
      });
    }
    let imageResult: Awaited<ReturnType<typeof createImageEdit>>;
    let usedStandardFallback = false;
    try {
      imageResult = await createImageEdit(apiKey, imageRequest, diagnostics.attempts);
    } catch (error) {
      const standardSize = standardSizeFor(payload);
      // Selective (masked) edits must keep exact canvas dimensions, so they
      // cannot fall back. Every other render — including Final — downgrades to
      // a model-supported size rather than surfacing the failure, since the
      // requested 2K/Final sizes are not always accepted by the image model.
      if (selectiveEdit || !isRetryableImageError(error) || standardSize === requestedSize) throw error;
      usedStandardFallback = true;
      imageResult = await createImageEdit(apiKey, { ...imageRequest, size: standardSize }, diagnostics.attempts);
    }
    const { data: imageJson, attempts: imageAttempts } = imageResult;
    const imageBase64 = imageJson.data?.[0]?.b64_json;
    if (!imageBase64) {
      throw new Error("OpenAI did not return image data.");
    }

    const reviewed = payload.runQa
      ? await reviewGeneratedImage(apiKey, payload, imageBase64, productReferences, selectedIds)
      : null;
    const qa = reviewed && selectiveEdit
      ? mergeProtectedQa(reviewed, payload, selectedIds)
      : reviewed;
    const renderKind: RenderKind = payload.renderKind
      ?? (payload.outputResolution === "final" ? "final" : selectiveEdit ? "repair" : "studio");
    let stored: Awaited<ReturnType<typeof persistGenerationOutput>> | null = null;
    let storageNotice = "";
    try {
      stored = await persistGenerationOutput({
        imageBase64,
        filename: safeOutputFilename(payload.outputFilename),
        format: usedStandardFallback ? standardSizeFor(payload) : requestedSize,
        prompt,
        payload: payload as unknown as Record<string, unknown>,
        usage: imageJson.usage,
        qa: qa as unknown as Record<string, unknown> | null,
        renderKind,
        collageType: payload.collageType,
        replaceJobId: selectiveEdit ? payload.libraryJobId : undefined,
      });
    } catch (storageError) {
      storageNotice = `The collage was generated, but could not be added to 30-day history: ${storageError instanceof Error ? storageError.message : "storage unavailable"}`;
    }

    return Response.json({
      ok: true,
      summary: buildSummary(payload),
      prompt,
      imageBase64,
      mimeType: "image/png",
      filename: safeOutputFilename(payload.outputFilename),
      qa,
      selectiveEdit,
      usage: imageJson.usage,
      jobId: stored?.id,
      libraryVisible: stored?.libraryVisible ?? false,
      renderKind,
      notice: [usedStandardFallback
        ? `OpenAI could not complete the ${payload.outputResolution === "final" ? "Final" : "Studio 2K"} render at the requested size, so the board was generated at the standard resolution without changing reference fidelity or render quality.`
        : imageAttempts > 1
          ? `OpenAI completed the collage after ${imageAttempts} attempts.`
          : "", storageNotice].filter(Boolean).join(" ") || undefined,
      diagnostics,
    });
  } catch (error) {
    const diagnosed = error instanceof DiagnosedGenerationError ? error : undefined;
    const rootError = diagnosed?.causeError ?? error;
    const base = await errorResponse(rootError).json() as Record<string, unknown>;
    const status = rootError instanceof OpenAIRequestError ? rootError.status : 400;
    return Response.json(
      { ...base, diagnostics: diagnosed?.diagnostics ?? diagnostics },
      { status: status >= 400 && status < 600 ? status : 500 },
    );
  }
}

async function createImageEdit(apiKey: string, body: ImageEditRequest, diagnostics: AttemptDiagnostic[], retry = true) {
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
      // GPT Image 2 uses high-fidelity image inputs automatically and rejects input_fidelity.
      for (const reference of body.references) {
        form.append("image[]", reference.blob, reference.filename);
      }
      if (body.mask) form.append("mask", body.mask.blob, body.mask.filename);

      const response = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
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

async function retrieveReferences(
  apiKey: string,
  references: Array<{ fileId: string; filename: string }>,
  diagnostics: AttemptDiagnostic[],
) {
  const prepared: PreparedReference[] = [];

  for (const reference of references) {
    const startedAt = Date.now();
    let source: Blob;
    let response: Response;
    try {
      response = await fetch(`https://api.openai.com/v1/files/${encodeURIComponent(reference.fileId)}/content`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!response.ok) await readOpenAIResponse<never>(response);
      source = await response.blob();
      if (!source.size) throw new Error(`Reference ${reference.filename} could not be read.`);
      diagnostics.push({ stage: "reference_fetch", outcome: "succeeded", attempt: prepared.length + 1, durationMs: Date.now() - startedAt });
    } catch (error) {
      diagnostics.push(diagnosticFor(error, "reference_fetch", prepared.length + 1, Date.now() - startedAt));
      throw error;
    }
    const contentType = referenceContentType(response.headers.get("content-type"), reference.filename);
    prepared.push({
      blob: source.type === contentType ? source : source.slice(0, source.size, contentType),
      filename: safeReferenceFilename(reference.filename),
    });
  }

  return prepared;
}

function diagnosticFor(error: unknown, stage: AttemptDiagnostic["stage"], attempt: number, durationMs: number, size?: string): AttemptDiagnostic {
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

function referenceContentType(header: string | null, filename: string) {
  if (header?.toLowerCase().startsWith("image/")) return header.split(";")[0].trim();
  const lower = filename.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/png";
}

function safeReferenceFilename(value: string) {
  const safe = value.replace(/[\r\n"\\/]+/g, "_").trim();
  return safe || "reference.png";
}

function validEditDimension(value: number) {
  return Number.isInteger(value) && value >= 256 && value <= 3840 && value % 16 === 0;
}

function mergeProtectedQa(review: QaReview, payload: CollageRequestInput, selectedIds: Set<string>): QaReview {
  const previousById = new Map((payload.qaFeedback?.items ?? []).map((item) => [item.id, item]));
  const reviewedById = new Map(review.items.map((item) => [item.id, item]));
  const items = activeItems(payload).map((item) => {
    const reviewed = reviewedById.get(item.id);
    const previous = previousById.get(item.id);
    if (selectedIds.has(item.id)) return reviewed ?? previous ?? missingQaItem(item.id);
    return previous ?? reviewed ?? missingQaItem(item.id);
  });
  const protectedFailure = items.some((item) => !selectedIds.has(item.id) && !item.passed);
  const score = protectedFailure
    ? Math.min(review.score, Math.max(0, Math.min(100, Number(payload.qaFeedback?.score) || 0)))
    : review.score;
  const findings = items.filter((item) => !item.passed && item.finding).map((item) => `${item.id}: ${item.finding}`);
  return {
    ...review,
    passed: review.passed && score >= 90 && items.every((item) => item.passed),
    score,
    findings: findings.length ? findings : review.findings,
    items,
  };
}

function missingQaItem(id: string): QaItemReview {
  return { id, passed: false, finding: "QA could not reliably locate this item." };
}

function standardSizeFor(payload: CollageRequestInput) {
  const orientation = resolvedOrientation(payload);
  if (orientation === "portrait") return "1024x1536";
  if (orientation === "square") return "1024x1024";
  return "1536x1024";
}

function isRetryableImageError(error: unknown) {
  if (error instanceof DiagnosedGenerationError) return isRetryableImageError(error.causeError);
  if (error instanceof TypeError) return true;
  if (!(error instanceof OpenAIRequestError)) return false;
  if (error.status === 408 || error.status === 409 || error.status >= 500) return true;
  return error.status === 429 && !/quota|billing|credit/i.test(error.message);
}

async function reviewGeneratedImage(
  apiKey: string,
  payload: CollageRequestInput,
  imageBase64: string,
  references: PreparedReference[],
  selectedIds = new Set<string>(),
): Promise<QaReview> {
  const expectedItems = activeItems(payload);
  const referenceItems = selectedIds.size
    ? expectedItems.filter((item) => selectedIds.has(item.id))
    : expectedItems;
  let nextReference = 1;
  const itemMap = referenceItems.map((item) => {
    const count = referenceCount(item);
    const start = nextReference;
    const end = nextReference + count - 1;
    nextReference += count;
    const range = start === end ? `reference ${start}` : `references ${start}-${end}`;
    return `${range} -> ${item.id}: ${item.role}`;
  }).join("\n");
  const content: Array<Record<string, unknown>> = [
    {
      type: "input_text",
      text: `Act as a meticulous architecture-magazine art director and product-reference checker.

The first image is the generated collage. Every following image is an original reference, in the same order used by the reference map below.

${itemMap}

Evaluate:
1. Every requested item is present exactly once and no unrequested material, fixture, appliance, or placeholder was added.
2. Each item preserves recognizable identity, geometry, finish, color, texture, grain, veining, pattern scale, and defining details from its references.
3. The collage is photorealistic, cleanly isolated, pure white, professionally lit, and editorially composed.
4. No item is badly warped, duplicated, mislabeled, recolored, hidden, or replaced by a generic substitute.

${selectedIds.size
  ? `This is an intermediate masked repair. Score only these selected items: ${Array.from(selectedIds).join(", ")}. Unselected pixels will be restored exactly after this review, so do not penalize drift in unselected items. Still locate every item.`
  : "Score the complete collage."}

For every item ID, return an item verdict and a tight bounding box [x, y, width, height] around its visible pixels and contact shadow. Coordinates are integers normalized from 0 to 1000 relative to the collage. Include every ID exactly once. Pass only at 90 or above with no major mismatch in the scored items.`,
    },
    {
      type: "input_image",
      image_url: `data:image/png;base64,${imageBase64}`,
      detail: "original",
    },
  ];

  for (const reference of references) {
    content.push({
      type: "input_image",
      image_url: await blobDataUrl(reference.blob),
      detail: "original",
    });
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.MATERIAL_COLLAGER_QA_MODEL || "gpt-5.6",
      reasoning: { effort: "low" },
      text: {
        format: {
          type: "json_schema",
          name: "collage_accuracy_review",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              passed: { type: "boolean" },
              score: { type: "integer", minimum: 0, maximum: 100 },
              findings: { type: "array", items: { type: "string" }, maxItems: 20 },
              recommendation: { type: "string" },
              items: {
                type: "array",
                minItems: expectedItems.length,
                maxItems: expectedItems.length,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    id: { type: "string" },
                    passed: { type: "boolean" },
                    finding: { type: "string" },
                    box: {
                      type: "array",
                      items: { type: "integer", minimum: 0, maximum: 1000 },
                      minItems: 4,
                      maxItems: 4,
                    },
                  },
                  required: ["id", "passed", "finding", "box"],
                },
              },
            },
            required: ["passed", "score", "findings", "recommendation", "items"],
          },
        },
      },
      input: [{ role: "user", content }],
    }),
  });

  try {
    const json = await readOpenAIResponse<OpenAIResponseOutput>(response);
    const raw = extractOutputText(json);
    const parsed = JSON.parse(raw.replace(/^```json\s*/i, "").replace(/```$/i, "").trim()) as {
      passed?: boolean;
      score?: number;
      findings?: string[] | string;
      recommendation?: string;
      items?: Array<{ id?: unknown; passed?: unknown; finding?: unknown; box?: unknown }>;
    };
    const score = Math.max(0, Math.min(100, Math.round(Number(parsed.score) || 0)));
    const parsedItems = new Map((parsed.items ?? []).map((item) => [String(item.id || ""), item]));
    const items = expectedItems.map((item) => {
      const parsedItem = parsedItems.get(item.id);
      const box = normalizeQaBox(parsedItem?.box);
      return {
        id: item.id,
        passed: Boolean(parsedItem?.passed),
        finding: String(parsedItem?.finding || (box ? "" : "QA could not reliably locate this item.")),
        ...(box ? { box } : {}),
      };
    });
    const scoredItems = selectedIds.size ? items.filter((item) => selectedIds.has(item.id)) : items;
    return {
      passed: Boolean(parsed.passed) && score >= 90 && scoredItems.every((item) => item.passed),
      score,
      findings: Array.isArray(parsed.findings)
        ? parsed.findings.map(String)
        : parsed.findings
          ? [String(parsed.findings)]
          : [],
      recommendation: String(parsed.recommendation || ""),
      items,
      reviewFailed: false,
    };
  } catch (error) {
    return {
      passed: false,
      score: 0,
      findings: [error instanceof Error ? error.message : "Accuracy review failed."],
      recommendation: "Review the collage manually before using it.",
      items: expectedItems.map((item) => missingQaItem(item.id)),
      reviewFailed: true,
    };
  }
}

function normalizeQaBox(value: unknown): [number, number, number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 4) return undefined;
  const numbers = value.map((entry) => Math.max(0, Math.min(1000, Math.round(Number(entry) || 0))));
  const [x, y, rawWidth, rawHeight] = numbers;
  const width = Math.min(rawWidth, 1000 - x);
  const height = Math.min(rawHeight, 1000 - y);
  if (width < 5 || height < 5) return undefined;
  return [x, y, width, height];
}

async function blobDataUrl(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return `data:${blob.type || "image/png"};base64,${btoa(binary)}`;
}

function extractOutputText(response: OpenAIResponseOutput) {
  if (response.output_text) return response.output_text;
  const chunks: string[] = [];
  for (const output of response.output ?? []) {
    for (const part of output.content ?? []) {
      if (part.text) chunks.push(part.text);
    }
  }
  return chunks.join("\n");
}

function safeOutputFilename(value?: string) {
  const raw = value?.trim() || "material-collage.png";
  const withExtension = raw.toLowerCase().endsWith(".png") ? raw : `${raw}.png`;
  return withExtension.replace(/[<>:"/\\|?*]+/g, "_");
}
