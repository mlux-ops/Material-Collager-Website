import {
  MAX_REFERENCE_FILE_BYTES,
  activeItems,
  buildGenerationPrompt,
  buildSummary,
  resolvedOutputFormat,
  resolvedQuality,
  resolvedSize,
  type CollageRequestInput,
  type OutputFormat,
  validateCollageRequest,
} from "@/app/lib/collage";
import {
  OpenAIRequestError,
  combineAbortSignals,
  errorResponse,
  readOpenAIResponse,
  resolveOpenAIKey,
} from "@/app/lib/openai-server";
import {
  DiagnosedGenerationError,
  createImageEdit,
  diagnosticFor,
  referenceContentType,
  safeReferenceFilename,
  validateImagePrompt,
  type AttemptDiagnostic,
  type GenerationDiagnostics,
  type ImageEditRequest,
  type PreparedReference,
} from "@/app/lib/image-edit";
import { persistGenerationOutput, type RenderKind } from "@/app/lib/generation-jobs";

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
    const payload = JSON.parse(payloadText) as CollageRequestInput;
    validateCollageRequest(payload);
    // Finals always render at high quality (see resolvedQuality). The payload
    // is normalized in place so the upstream request, the persisted job and
    // the diagnostics all agree — and the caller is told when their requested
    // tier was upgraded instead of having the change happen silently.
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
    } else if (!diagnosticMode && remoteProductReferences.length === boardReferenceCount) {
      const remoteReferences = payload.layoutReference && payload.layoutReferenceFileId
        ? [{ fileId: payload.layoutReferenceFileId, filename: "approved-draft.png" }, ...remoteProductReferences]
        : remoteProductReferences;
      if (remoteReferences.length !== expectedReferences) {
        throw new Error("The approved draft or one of its full-quality references is no longer available. Upload it again and retry.");
      }
      preparedReferences = await retrieveReferences(apiKey, remoteReferences, attempts, request.signal);
    } else {
      throw new Error("One or more reference images were missing from the generation request.");
    }
    diagnostics.totalReferenceBytes = preparedReferences.reduce((sum, reference) => sum + reference.blob.size, 0);
    diagnostics.largestReferenceBytes = Math.max(...preparedReferences.map((reference) => reference.blob.size), 0);
    diagnostics.references = preparedReferences.map((reference) => ({
      filename: reference.filename,
      bytes: reference.blob.size,
      mimeType: reference.blob.type,
    }));
    const requestedSize = resolvedSize(payload);
    const outputFormat = resolvedOutputFormat(payload);

    const imageRequest: ImageEditRequest = {
      model: "gpt-image-2",
      prompt,
      references: preparedReferences,
      size: requestedSize,
      quality: payload.quality,
      background: "opaque",
      output_format: outputFormat,
      ...(payload.outputCompression !== undefined && outputFormat !== "png"
        ? { output_compression: payload.outputCompression }
        : {}),
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

async function retrieveReferences(
  apiKey: string,
  references: Array<{ fileId: string; filename: string }>,
  diagnostics: AttemptDiagnostic[],
  callerSignal: AbortSignal,
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
        signal: combineAbortSignals(callerSignal, 120_000),
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

function safeOutputFilename(value: string | undefined, format: OutputFormat) {
  const extension = format === "jpeg" ? "jpg" : format;
  const raw = (value?.trim() || "material-collage").replace(/\.(png|jpe?g|webp)$/i, "");
  return `${raw}.${extension}`.replace(/[<>:"/\\|?*]+/g, "_");
}
