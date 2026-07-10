import {
  activeItems,
  buildGenerationPrompt,
  buildSummary,
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
  size: string;
  quality: CollageRequestInput["quality"];
  background: "opaque";
  output_format: "png";
};

type PreparedReference = {
  blob: Blob;
  filename: string;
};

const IMAGE_RETRY_DELAYS_MS = [1500];

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as CollageRequestInput;
    validateCollageRequest(payload);

    const items = activeItems(payload);
    const referenceFileIds = items.flatMap((item) => item.imageFileIds ?? []);
    const expectedReferences = items.reduce(
      (total, item) => total + Math.max(item.imageNames?.length ?? 0, item.imageFileIds?.length ?? 0),
      0,
    );
    if (!referenceFileIds.length || referenceFileIds.length !== expectedReferences) {
      throw new Error("One or more reference images are not ready. Generate again to finish preparing them.");
    }

    const apiKey = resolveOpenAIKey(payload.apiKey);
    const prompt = buildGenerationPrompt(payload);
    const preparedReferences = await retrieveReferences(
      apiKey,
      items.flatMap((item) =>
        (item.imageFileIds ?? []).map((fileId, index) => ({
          fileId,
          filename: item.imageNames?.[index] || `${item.id}-reference-${index + 1}.png`,
        })),
      ),
    );
    const requestedSize = resolvedSize(payload);
    const imageRequest: ImageEditRequest = {
      model: "gpt-image-2",
      prompt,
      references: preparedReferences,
      size: requestedSize,
      quality: payload.quality,
      background: "opaque",
      output_format: "png",
    };
    let imageResult: Awaited<ReturnType<typeof createImageEdit>>;
    let usedStandardFallback = false;
    try {
      imageResult = await createImageEdit(apiKey, imageRequest);
    } catch (error) {
      const standardSize = standardSizeFor(payload);
      if (!isRetryableImageError(error) || standardSize === requestedSize) throw error;
      usedStandardFallback = true;
      imageResult = await createImageEdit(apiKey, { ...imageRequest, size: standardSize });
    }
    const { data: imageJson, attempts } = imageResult;
    const imageBase64 = imageJson.data?.[0]?.b64_json;
    if (!imageBase64) {
      throw new Error("OpenAI did not return image data.");
    }

    const qa = payload.runQa
      ? await reviewGeneratedImage(apiKey, payload, imageBase64, referenceFileIds)
      : null;

    return Response.json({
      ok: true,
      summary: buildSummary(payload),
      prompt,
      imageBase64,
      mimeType: "image/png",
      filename: safeOutputFilename(payload.outputFilename),
      qa,
      usage: imageJson.usage,
      notice: usedStandardFallback
        ? "OpenAI could not complete the Studio 2K render, so the board was generated at the standard resolution without changing reference fidelity or render quality."
        : attempts > 1
          ? `OpenAI completed the collage after ${attempts} attempts.`
          : undefined,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

async function createImageEdit(apiKey: string, body: ImageEditRequest) {
  let lastError: unknown;

  for (let attempt = 0; attempt <= IMAGE_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const form = new FormData();
      form.append("model", body.model);
      form.append("prompt", body.prompt);
      form.append("size", body.size);
      form.append("quality", body.quality);
      form.append("background", body.background);
      form.append("output_format", body.output_format);
      for (const reference of body.references) {
        form.append("image[]", reference.blob, reference.filename);
      }

      const response = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });
      const data = await readOpenAIResponse<OpenAIImageResponse>(response);
      return { data, attempts: attempt + 1 };
    } catch (error) {
      lastError = error;
      if (!isRetryableImageError(error) || attempt === IMAGE_RETRY_DELAYS_MS.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, IMAGE_RETRY_DELAYS_MS[attempt]));
    }
  }

  throw lastError instanceof Error ? lastError : new Error("OpenAI image generation failed.");
}

async function retrieveReferences(
  apiKey: string,
  references: Array<{ fileId: string; filename: string }>,
) {
  const prepared: PreparedReference[] = [];

  for (const reference of references) {
    const response = await fetch(`https://api.openai.com/v1/files/${encodeURIComponent(reference.fileId)}/content`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) await readOpenAIResponse<never>(response);
    const source = await response.blob();
    if (!source.size) throw new Error(`Reference ${reference.filename} could not be read.`);
    const contentType = referenceContentType(response.headers.get("content-type"), reference.filename);
    prepared.push({
      blob: source.type === contentType ? source : source.slice(0, source.size, contentType),
      filename: safeReferenceFilename(reference.filename),
    });
  }

  return prepared;
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

function standardSizeFor(payload: CollageRequestInput) {
  const orientation = resolvedOrientation(payload);
  if (orientation === "portrait") return "1024x1536";
  if (orientation === "square") return "1024x1024";
  return "1536x1024";
}

function isRetryableImageError(error: unknown) {
  if (error instanceof TypeError) return true;
  if (!(error instanceof OpenAIRequestError)) return false;
  if (error.status === 408 || error.status === 409 || error.status >= 500) return true;
  return error.status === 429 && !/quota|billing|credit/i.test(error.message);
}

async function reviewGeneratedImage(
  apiKey: string,
  payload: CollageRequestInput,
  imageBase64: string,
  referenceFileIds: string[],
) {
  const itemMap = activeItems(payload)
    .map((item) => `${item.id}: ${item.role} (${item.imageFileIds?.length ?? 0} reference image(s))`)
    .join("\n");
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

Return JSON only with: passed (boolean), score (integer 0-100), findings (array of concise strings naming item IDs when relevant), recommendation (one concise corrective instruction). Pass only at 90 or above with no major reference mismatch.`,
    },
    {
      type: "input_image",
      image_url: `data:image/png;base64,${imageBase64}`,
      detail: "original",
    },
  ];

  for (const fileId of referenceFileIds) {
    content.push({
      type: "input_image",
      file_id: fileId,
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
    };
    const score = Math.max(0, Math.min(100, Math.round(Number(parsed.score) || 0)));
    return {
      passed: Boolean(parsed.passed) && score >= 90,
      score,
      findings: Array.isArray(parsed.findings)
        ? parsed.findings.map(String)
        : parsed.findings
          ? [String(parsed.findings)]
          : [],
      recommendation: String(parsed.recommendation || ""),
    };
  } catch (error) {
    return {
      passed: false,
      score: 0,
      findings: [error instanceof Error ? error.message : "Accuracy review failed."],
      recommendation: "Review the collage manually before using it.",
    };
  }
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
