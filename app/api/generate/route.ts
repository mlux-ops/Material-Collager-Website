import {
  MAX_REFERENCE_FILE_BYTES,
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
  missingQaItem,
  reviewGeneratedImage,
  type QaReview,
} from "@/app/lib/accuracy-review";
import {
  OpenAIRequestError,
  errorResponse,
  readOpenAIResponse,
  resolveOpenAIKey,
} from "@/app/lib/openai-server";
import {
  DiagnosedGenerationError,
  createImageEdit,
  diagnosticFor,
  isRetryableImageError,
  referenceContentType,
  safeReferenceFilename,
  type AttemptDiagnostic,
  type GenerationDiagnostics,
  type ImageEditRequest,
  type PreparedReference,
} from "@/app/lib/image-edit";
import { persistGenerationOutput, type RenderKind } from "@/app/lib/generation-jobs";

export const runtime = "edge";

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
    for (const file of directFiles) {
      if (!file.type.startsWith("image/")) throw new Error(`Reference ${file.name || "image"} is not an image file.`);
      if (file.size >= MAX_REFERENCE_FILE_BYTES) throw new Error(`Reference ${file.name || "image"} must be under 50 MB.`);
    }
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
      // The masked "Re-create checked items" repair runs without a wall-clock
      // ceiling. It is explicitly user-initiated on a board they are already
      // iterating on, and a repair that takes longer than the old 300s cap is
      // better finished than aborted — the abort discarded the work and
      // charged for it anyway.
      timeoutMs: selectiveEdit ? null : undefined,
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
      ? await reviewGeneratedImage({
        apiKey,
        imageBase64,
        items: items.map((item) => ({ id: item.id, role: item.role, referenceCount: referenceCount(item) })),
        selectedItemIds: Array.from(selectedIds),
        references: productReferences,
        domain: "material collage",
        // Same reasoning as the edit call above: on a repair, the review is
        // not allowed to time out and take a completed image down with it.
        timeoutMs: selectiveEdit ? null : undefined,
      })
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
      storageNotice = `The collage was generated, but could not be added to the six-month history: ${storageError instanceof Error ? storageError.message : "storage unavailable"}`;
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

async function retrieveReferences(
  apiKey: string,
  references: Array<{ fileId: string; filename: string }>,
  diagnostics: AttemptDiagnostic[],
) {
  // Fetch all references concurrently — serialized multi-MB downloads add
  // many seconds of wall time to a final render before generation starts.
  return Promise.all(references.map(async (reference, index): Promise<PreparedReference> => {
    const startedAt = Date.now();
    let source: Blob;
    let response: Response;
    try {
      response = await fetch(`https://api.openai.com/v1/files/${encodeURIComponent(reference.fileId)}/content`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) await readOpenAIResponse<never>(response);
      source = await response.blob();
      if (!source.size) throw new Error(`Reference ${reference.filename} could not be read.`);
      diagnostics.push({ stage: "reference_fetch", outcome: "succeeded", attempt: index + 1, durationMs: Date.now() - startedAt });
    } catch (error) {
      diagnostics.push(diagnosticFor(error, "reference_fetch", index + 1, Date.now() - startedAt));
      throw error;
    }
    const contentType = referenceContentType(response.headers.get("content-type"), reference.filename);
    return {
      blob: source.type === contentType ? source : source.slice(0, source.size, contentType),
      filename: safeReferenceFilename(reference.filename),
      fileId: reference.fileId,
    };
  }));
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

function standardSizeFor(payload: CollageRequestInput) {
  const orientation = resolvedOrientation(payload);
  if (orientation === "portrait") return "1024x1536";
  if (orientation === "square") return "1024x1024";
  return "1536x1024";
}

function safeOutputFilename(value?: string) {
  const raw = value?.trim() || "material-collage.png";
  const withExtension = raw.toLowerCase().endsWith(".png") ? raw : `${raw}.png`;
  return withExtension.replace(/[<>:"/\\|?*]+/g, "_");
}
