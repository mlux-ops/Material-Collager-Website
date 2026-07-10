import {
  activeItems,
  buildGenerationPrompt,
  buildSummary,
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
  images: Array<{ file_id: string }>;
  size: string;
  quality: CollageRequestInput["quality"];
  background: "opaque";
  output_format: "png";
};

const IMAGE_RETRY_DELAYS_MS = [1200, 3000];

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as CollageRequestInput;
    validateCollageRequest(payload);

    const referenceFileIds = activeItems(payload).flatMap((item) => item.imageFileIds ?? []);
    const expectedReferences = activeItems(payload).reduce(
      (total, item) => total + Math.max(item.imageNames?.length ?? 0, item.imageFileIds?.length ?? 0),
      0,
    );
    if (!referenceFileIds.length || referenceFileIds.length !== expectedReferences) {
      throw new Error("One or more reference images are not ready. Generate again to finish preparing them.");
    }

    const apiKey = resolveOpenAIKey(payload.apiKey);
    const prompt = buildGenerationPrompt(payload);
    const imageRequest: ImageEditRequest = {
      model: "gpt-image-2",
      prompt,
      images: referenceFileIds.map((fileId) => ({ file_id: fileId })),
      size: resolvedSize(payload),
      quality: payload.quality,
      background: "opaque",
      output_format: "png",
    };
    const { data: imageJson, attempts } = await createImageEdit(apiKey, imageRequest);
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
      notice: attempts > 1 ? `OpenAI completed the collage after ${attempts} attempts.` : undefined,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

async function createImageEdit(apiKey: string, body: ImageEditRequest) {
  let lastError: unknown;

  for (let attempt = 0; attempt <= IMAGE_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const response = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
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
