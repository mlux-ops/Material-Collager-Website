import {
  buildGenerationPrompt,
  buildSummary,
  resolvedSize,
  type CollageRequestInput,
  validateCollageRequest,
} from "@/app/lib/collage";

export const runtime = "edge";

type OpenAIImageResponse = {
  data?: Array<{ b64_json?: string }>;
  error?: { message?: string; code?: string };
};

type OpenAIResponseOutput = {
  output_text?: string;
  output?: Array<{
    content?: Array<{ text?: string }>;
  }>;
};

export async function POST(request: Request) {
  try {
    const incoming = await request.formData();
    const payloadText = incoming.get("payload");
    if (typeof payloadText !== "string") {
      throw new Error("Missing generation payload.");
    }

    const payload = JSON.parse(payloadText) as CollageRequestInput;
    const filesByKey = new Map<string, File>();
    for (const [key, value] of incoming.entries()) {
      if (key.startsWith("file:") && value instanceof File) {
        filesByKey.set(key.slice(5), value);
      }
    }

    validateCollageRequest(payload, filesByKey);

    const apiKey = payload.apiKey?.trim() || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is not configured.");
    }

    const prompt = buildGenerationPrompt(payload);
    const openaiForm = new FormData();
    openaiForm.append("model", "gpt-image-2");
    openaiForm.append("prompt", prompt);
    openaiForm.append("size", resolvedSize(payload));
    openaiForm.append("quality", payload.quality);
    openaiForm.append("background", "opaque");
    openaiForm.append("output_format", "png");

    const referenceFiles: File[] = [];
    for (const item of payload.items) {
      for (const key of item.imageKeys ?? []) {
        const file = filesByKey.get(key);
        if (file) {
          referenceFiles.push(file);
          openaiForm.append("image[]", file, file.name);
        }
      }
    }

    const imageResponse = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: openaiForm,
    });

    const imageJson = (await imageResponse.json()) as OpenAIImageResponse;
    if (!imageResponse.ok) {
      throw new Error(imageJson.error?.message || "OpenAI image generation failed.");
    }

    const imageBase64 = imageJson.data?.[0]?.b64_json;
    if (!imageBase64) {
      throw new Error("OpenAI did not return image data.");
    }

    let qa: { passed: boolean; findings: string[]; recommendation: string; raw: string } | null = null;
    if (payload.runQa) {
      qa = await reviewGeneratedImage(apiKey, payload, imageBase64, referenceFiles);
    }

    return Response.json({
      ok: true,
      summary: buildSummary(payload),
      prompt,
      imageBase64,
      mimeType: "image/png",
      filename: safeOutputFilename(payload.outputFilename),
      qa,
    });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "Generation failed." },
      { status: 400 },
    );
  }
}

async function reviewGeneratedImage(
  apiKey: string,
  payload: CollageRequestInput,
  imageBase64: string,
  referenceFiles: File[],
) {
  const content: Array<Record<string, unknown>> = [
    {
      type: "input_text",
      text: `The first image is the generated collage. The following images are the original references. Evaluate reference match, pure white background, organic flat-lay composition, no labels/text, and no unrequested items. Collage type: ${payload.collageType}. Return compact JSON with keys passed, findings, recommendation.`,
    },
    {
      type: "input_image",
      image_url: `data:image/png;base64,${imageBase64}`,
    },
  ];

  for (const file of referenceFiles) {
    const base64 = await fileToBase64(file);
    content.push({
      type: "input_image",
      image_url: `data:${file.type || "image/png"};base64,${base64}`,
    });
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.MATERIAL_COLLAGER_QA_MODEL || "gpt-5.5",
      input: [{ role: "user", content }],
    }),
  });

  const json = (await response.json()) as OpenAIResponseOutput & { error?: { message?: string } };
  if (!response.ok) {
    return {
      passed: false,
      findings: [json.error?.message || "QA review failed."],
      recommendation: "Review the generated collage manually.",
      raw: "",
    };
  }

  const raw = extractOutputText(json);
  try {
    const parsed = JSON.parse(raw.replace(/^```json\s*/i, "").replace(/```$/i, "").trim()) as {
      passed?: boolean;
      findings?: string[] | string;
      recommendation?: string;
    };
    return {
      passed: Boolean(parsed.passed),
      findings: Array.isArray(parsed.findings)
        ? parsed.findings.map(String)
        : parsed.findings
          ? [String(parsed.findings)]
          : [],
      recommendation: String(parsed.recommendation || ""),
      raw,
    };
  } catch {
    return {
      passed: false,
      findings: ["QA response was not valid JSON."],
      recommendation: "Review the generated collage manually.",
      raw,
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

async function fileToBase64(file: File) {
  const buffer = await file.arrayBuffer();
  return Buffer.from(buffer).toString("base64");
}

function safeOutputFilename(value?: string) {
  const raw = value?.trim() || "material-collage.png";
  const withExtension = raw.toLowerCase().endsWith(".png") ? raw : `${raw}.png`;
  return withExtension.replace(/[<>:"/\\|?*]+/g, "_");
}

