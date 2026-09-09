import {
  MAX_REFERENCE_FILE_BYTES,
  activeItems,
  buildGenerationPrompt,
  buildSummary,
  resolvedBackground,
  resolvedOutputFormat,
  resolvedQuality,
  resolvedSize,
  type CollageRequestInput,
  type OutputFormat,
  validateCollageRequest,
} from "@/app/lib/collage";
import {
  OpenAIRequestError,
  errorResponse,
  resolveOpenAIKey,
} from "@/app/lib/openai-server";
import {
  DiagnosedGenerationError,
  createImageEdit,
  referenceBytes,
  resolveTransport,
  safeReferenceFilename,
  validateImagePrompt,
  type AttemptDiagnostic,
  type GenerationDiagnostics,
  type ImageEditRequest,
  type PreparedReference,
} from "@/app/lib/image-edit";
import { persistGenerationOutput, type RenderKind } from "@/app/lib/generation-jobs";
import { calculateSunburstUsageCost, resolveWireModel, SUNBURST_MODEL } from "@/app/lib/sunburst";

export const runtime = "edge";

const OUTPUT_MIME_TYPES: Record<OutputFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

export async function POST(request: Request) {
  let diagnostics: GenerationDiagnostics | undefined;
  try {
    const diagnosticMode = new URL(request.url).searchParams.get("diagnostic") === "isolation";
    const incoming = await request.formData();
    const payloadText = incoming.get("payload");
    if (typeof payloadText !== "string") throw new Error("Missing generation payload.");
    const rawPayload = JSON.parse(payloadText) as CollageRequestInput;
    // Missing fields are valid for drafts written before the Sunburst
    // migration. Resolve them before validation so those drafts remain opaque
    // and high-quality by default.
    const payload: CollageRequestInput = {
      ...rawPayload,
      quality: rawPayload.quality ?? "high",
      background: rawPayload.background ?? "opaque",
    };
    validateCollageRequest(payload);
    // Final quality is normalized in place so the upstream request, the
    // persisted job and diagnostics all agree. Explicit xhigh/max survive the
    // Final minimum-quality guard.
    const requestedQuality = payload.quality;
    payload.quality = resolvedQuality(payload);
    const qualityNotice = requestedQuality !== payload.quality
      ? `Final renders always use high quality; the requested "${requestedQuality}" quality was upgraded.`
      : "";
    request.signal.throwIfAborted();

    const items = activeItems(payload);
    const directFiles = incoming.getAll("image[]").filter((value): value is File => value instanceof File);
    for (const file of directFiles) {
      if (!file.type.startsWith("image/")) throw new Error(`Reference ${file.name || "image"} is not an image file.`);
      if (file.size >= MAX_REFERENCE_FILE_BYTES) throw new Error(`Reference ${file.name || "image"} must be under 50 MB.`);
    }
    const boardReferenceCount = items.reduce(
      (total, item) => total + Math.max(item.imageNames?.length ?? 0, item.imageFileIds?.length ?? 0),
      0,
    );
    const requestedDiagnosticCount = Math.max(
      1,
      Math.min(boardReferenceCount, Number(new URL(request.url).searchParams.get("count") || 1)),
    );
    const expectedProductReferences = diagnosticMode ? requestedDiagnosticCount : boardReferenceCount;
    const expectedReferences = expectedProductReferences + (!diagnosticMode && payload.layoutReference ? 1 : 0);

    const apiKey = resolveOpenAIKey(payload.apiKey);
    const prompt = buildGenerationPrompt(payload);
    validateImagePrompt(prompt);
    const attempts: AttemptDiagnostic[] = [];
    diagnostics = {
      model: SUNBURST_MODEL,
      wireModel: resolveWireModel(SUNBURST_MODEL),
      transport: "multipart",
      quality: payload.quality,
      background: resolvedBackground(payload),
      outputFormat: resolvedOutputFormat(payload),
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
    } else if (!diagnosticMode && remoteProductReferences.length === boardReferenceCount) {
      const remoteReferences = payload.layoutReference && payload.layoutReferenceFileId
        ? [{ fileId: payload.layoutReferenceFileId, filename: "approved-draft.png" }, ...remoteProductReferences]
        : remoteProductReferences;
      if (remoteReferences.length !== expectedReferences) {
        throw new Error("The approved draft or one of its full-quality references is no longer available. Upload it again and retry.");
      }
      // These references already live in OpenAI's Files API, so name them by
      // id rather than downloading every one and posting the same bytes back.
      // The old round trip cost a full download plus re-upload of up to 16
      // multi-MB images before generation could even start.
      preparedReferences = remoteReferences.map((reference) => ({
        filename: safeReferenceFilename(reference.filename),
        fileId: reference.fileId,
      }));
    } else {
      throw new Error("One or more reference images were missing from the generation request.");
    }
    // Byte counters stay 0 for the file_id transport: nothing is uploaded, so
    // there are no request bytes to report. `transport` distinguishes that
    // from a genuinely empty multipart request.
    diagnostics.totalReferenceBytes = preparedReferences.reduce((sum, reference) => sum + referenceBytes(reference), 0);
    diagnostics.largestReferenceBytes = Math.max(...preparedReferences.map(referenceBytes), 0);
    diagnostics.references = preparedReferences.map((reference) => ({
      filename: reference.filename,
      bytes: referenceBytes(reference),
      mimeType: reference.blob?.type ?? "",
      ...(reference.fileId ? { fileId: reference.fileId } : {}),
    }));
    const requestedSize = resolvedSize(payload);
    const outputFormat = resolvedOutputFormat(payload);

    const imageRequest: ImageEditRequest = {
      model: SUNBURST_MODEL,
      prompt,
      references: preparedReferences,
      size: requestedSize,
      quality: payload.quality,
      background: resolvedBackground(payload),
      output_format: outputFormat,
      ...(payload.outputCompression !== undefined && outputFormat !== "png"
        ? { output_compression: payload.outputCompression }
        : {}),
      // Opt-in measurement path. Absent unless a caller explicitly asked, so
      // the default request is unchanged from what shipped.
      ...(payload.inputFidelity ? { input_fidelity: payload.inputFidelity } : {}),
    };
    diagnostics.transport = resolveTransport(imageRequest);
    if (payload.inputFidelity) diagnostics.inputFidelity = payload.inputFidelity;
    if (diagnosticMode) {
      const counts = [requestedDiagnosticCount];
      const isolationResults: Array<{ referenceCount: number; outcome: "succeeded" | "failed"; requestId?: string; error?: string }> = [];
      let diagnosticImageBase64: string | undefined;
      for (const count of counts) {
        const before = diagnostics.attempts.length;
        try {
          const testResult = await createImageEdit(apiKey, {
            ...imageRequest,
            prompt: resolvedBackground(payload) === "transparent"
              ? "Create a simple clean material reference board using every supplied image on a transparent background with preserved alpha."
              : "Create a simple clean material reference board using every supplied image.",
            references: preparedReferences.slice(0, count),
            size: "1024x1024",
            quality: "low",
            // The diagnostic isolation render is a throwaway debugging aid,
            // always PNG regardless of what the real render requested.
            output_format: "png",
            output_compression: undefined,
          }, diagnostics.attempts, request.signal);
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
    // One upstream attempt per user action preserves the requested settings
    // without risking a duplicate paid render after an ambiguous failure.
    const { data: imageJson } = await createImageEdit(apiKey, imageRequest, diagnostics.attempts, request.signal);
    const imageBase64 = imageJson.data?.[0]?.b64_json;
    if (!imageBase64) {
      throw new Error("OpenAI did not return image data.");
    }
    const costUsd = calculateSunburstUsageCost(imageJson.usage);

    const renderKind: RenderKind = payload.renderKind
      ?? (payload.outputResolution === "final" ? "final" : "studio");
    let stored: Awaited<ReturnType<typeof persistGenerationOutput>> | null = null;
    let storageNotice = "";
    try {
      stored = await persistGenerationOutput({
        imageBase64,
        filename: safeOutputFilename(payload.outputFilename, outputFormat),
        format: requestedSize,
        prompt,
        payload: payload as unknown as Record<string, unknown>,
        model: SUNBURST_MODEL,
        quality: payload.quality,
        background: resolvedBackground(payload),
        outputFormat,
        usage: imageJson.usage,
        qa: null,
        renderKind,
        collageType: payload.collageType,
      });
    } catch (storageError) {
      storageNotice = `The collage was generated, but could not be added to the six-month history: ${storageError instanceof Error ? storageError.message : "storage unavailable"}`;
    }

    return Response.json({
      ok: true,
      summary: buildSummary(payload),
      prompt,
      imageBase64,
      mimeType: OUTPUT_MIME_TYPES[outputFormat],
      filename: safeOutputFilename(payload.outputFilename, outputFormat),
      usage: imageJson.usage,
      model: SUNBURST_MODEL,
      quality: payload.quality,
      background: resolvedBackground(payload),
      outputFormat,
      costUsd,
      jobId: stored?.id,
      libraryVisible: stored?.libraryVisible ?? false,
      renderKind,
      notice: [qualityNotice, storageNotice].filter(Boolean).join(" ") || undefined,
      diagnostics,
    });
  } catch (error) {
    const diagnosed = error instanceof DiagnosedGenerationError ? error : undefined;
    const rootError = diagnosed?.causeError ?? error;
    const upstream = errorResponse(rootError);
    const base = await upstream.json() as Record<string, unknown>;
    const status = rootError instanceof OpenAIRequestError ? rootError.status : 400;
    // The body is re-wrapped to attach diagnostics; keep the provider's
    // Retry-After header alongside it so HTTP clients see it too.
    const retryAfter = upstream.headers.get("Retry-After");
    return Response.json(
      { ...base, diagnostics: diagnosed?.diagnostics ?? diagnostics },
      { status: status >= 400 && status < 600 ? status : 500, headers: retryAfter ? { "Retry-After": retryAfter } : undefined },
    );
  }
}

function safeOutputFilename(value: string | undefined, format: OutputFormat) {
  const extension = format === "jpeg" ? "jpg" : format;
  const raw = (value?.trim() || "material-collage").replace(/\.(png|jpe?g|webp)$/i, "");
  return `${raw}.${extension}`.replace(/[<>:"/\\|?*]+/g, "_");
}
