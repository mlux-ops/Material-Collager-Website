import {
  QA_DEFAULT_MODEL,
  buildQaRequestBody,
  buildQaResult,
  parseQaModelJson,
  validateQaRequest,
} from "@/app/lib/qa";
import {
  OpenAIRequestError,
  combineAbortSignals,
  errorResponse,
  readOpenAIResponse,
  resolveOpenAIKey,
} from "@/app/lib/openai-server";
import { updateGenerationQa } from "@/app/lib/generation-jobs";

export const runtime = "edge";

// Shape of the parts of a Responses API payload this route reads. The
// Responses API's structured-output text is delivered as one or more
// `output_text` content parts on `message` items in `output`; some SDKs also
// surface a convenience `output_text` string field on the top-level response,
// which is used here when present.
type ResponsesApiPayload = {
  output_text?: string;
  output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
  usage?: Record<string, unknown>;
};

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const { items, output, referencesByItem } = validateQaRequest(body);
    const apiKey = resolveOpenAIKey(typeof body.apiKey === "string" ? body.apiKey : undefined);
    const model = typeof body.model === "string" && body.model.trim()
      ? body.model.trim()
      : (process.env.QA_MODEL || QA_DEFAULT_MODEL);
    const jobId = typeof body.jobId === "string" && body.jobId.trim() ? body.jobId.trim() : undefined;

    const requestBody = buildQaRequestBody({ model, items, output, referencesByItem });
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: combineAbortSignals(request.signal, 120_000),
    });
    const json = await readOpenAIResponse<ResponsesApiPayload>(response);

    const rawText = outputTextFrom(json);
    if (!rawText) {
      throw new OpenAIRequestError("QA model returned no output text to parse.", 502, "empty_output");
    }
    const parsedModelJson = parseQaModelJson(rawText);
    const qa = buildQaResult(model, parsedModelJson);

    let persisted: boolean | undefined;
    let notice: string | undefined;
    if (jobId) {
      try {
        persisted = await updateGenerationQa(jobId, qa);
        if (!persisted) notice = "No matching generation job was found to attach this QA result to.";
      } catch (error) {
        persisted = false;
        notice = `QA completed, but could not be saved to the job history: ${error instanceof Error ? error.message : "storage unavailable"}`;
      }
    }

    return Response.json({
      ok: true,
      qa,
      usage: json.usage,
      ...(persisted !== undefined ? { persisted } : {}),
      ...(notice ? { notice } : {}),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

function outputTextFrom(json: ResponsesApiPayload): string | undefined {
  if (typeof json.output_text === "string" && json.output_text) return json.output_text;
  const texts: string[] = [];
  for (const item of json.output ?? []) {
    if (item.type !== "message") continue;
    for (const part of item.content ?? []) {
      if (part.type === "output_text" && typeof part.text === "string") texts.push(part.text);
    }
  }
  return texts.length ? texts.join("") : undefined;
}
