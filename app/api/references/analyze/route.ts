import { errorResponse, readOpenAIResponse, resolveOpenAIKey } from "@/app/lib/openai-server";

export const runtime = "edge";

type ResponsesOutput = {
  output_text?: string;
  output?: Array<{ content?: Array<{ text?: string }> }>;
};

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const image = form.get("image");
    const itemType = String(form.get("itemType") || "").trim();
    const apiKey = resolveOpenAIKey(String(form.get("apiKey") || ""));
    if (!(image instanceof File) || !image.type.startsWith("image/")) {
      throw new Error("Add a primary image before analyzing this item.");
    }

    const imageUrl = await fileDataUrl(image);
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.MATERIAL_COLLAGER_ANALYSIS_MODEL || "gpt-5-mini",
        reasoning: { effort: "low" },
        text: {
          format: {
            type: "json_schema",
            name: "reference_analysis",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                itemType: analysisFieldSchema(),
                brand: analysisFieldSchema(),
                product: analysisFieldSchema(),
                finish: analysisFieldSchema(),
                notes: analysisFieldSchema(),
                searchQuery: { type: "string" },
              },
              required: ["itemType", "brand", "product", "finish", "notes", "searchQuery"],
            },
          },
        },
        input: [{
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Analyze this primary product or material reference for an interior-design finish board.
Current item type: ${itemType || "unknown"}.

Return JSON only with this shape:
{
  "itemType": {"value": "", "confidence": 0},
  "brand": {"value": "", "confidence": 0},
  "product": {"value": "", "confidence": 0},
  "finish": {"value": "", "confidence": 0},
  "notes": {"value": "", "confidence": 0},
  "searchQuery": ""
}

Confidence is an integer 0-100. Do not invent an exact brand, model, SKU, collection, or finish name when it is not visibly supported. Keep notes limited to useful generation guidance visible in the image, such as geometry, material character, or the view that must be preserved. Build searchQuery for an official manufacturer search using only supported clues.`,
            },
            { type: "input_image", image_url: imageUrl, detail: "high" },
          ],
        }],
      }),
    });
    const json = await readOpenAIResponse<ResponsesOutput>(response);
    const parsed = parseJson(extractOutputText(json)) as Record<string, unknown>;
    return Response.json({ ok: true, analysis: normalizeAnalysis(parsed) });
  } catch (error) {
    return errorResponse(error);
  }
}

async function fileDataUrl(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return `data:${file.type};base64,${btoa(binary)}`;
}

function extractOutputText(response: ResponsesOutput) {
  if (response.output_text) return response.output_text;
  return (response.output ?? []).flatMap((output) => output.content ?? []).map((part) => part.text || "").join("\n");
}

function parseJson(value: string) {
  return JSON.parse(value.replace(/^```json\s*/i, "").replace(/```$/i, "").trim());
}

function analysisFieldSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      value: { type: "string" },
      confidence: { type: "integer", minimum: 0, maximum: 100 },
    },
    required: ["value", "confidence"],
  };
}

function normalizeAnalysis(value: Record<string, unknown>) {
  const field = (key: string) => {
    const raw = value[key] as { value?: unknown; confidence?: unknown } | undefined;
    return {
      value: String(raw?.value || "").trim(),
      confidence: Math.max(0, Math.min(100, Math.round(Number(raw?.confidence) || 0))),
    };
  };
  return {
    itemType: field("itemType"),
    brand: field("brand"),
    product: field("product"),
    finish: field("finish"),
    notes: field("notes"),
    searchQuery: String(value.searchQuery || "").trim(),
  };
}
