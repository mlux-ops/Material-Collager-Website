import { errorResponse, readOpenAIResponse, resolveOpenAIKey } from "@/app/lib/openai-server";

export const runtime = "edge";

const MAX_PART_BYTES = 5 * 1024 * 1024;

type PartResponse = {
  id: string;
};

export async function POST(request: Request) {
  try {
    const incoming = await request.formData();
    const providedApiKey = incoming.get("apiKey");
    const uploadId = incoming.get("uploadId");
    const chunk = incoming.get("data");

    if (typeof uploadId !== "string" || !/^upload_[A-Za-z0-9_-]+$/.test(uploadId)) {
      throw new Error("Reference upload ID is invalid.");
    }
    if (!(chunk instanceof File) || chunk.size <= 0) {
      throw new Error("Reference upload part is missing.");
    }
    if (chunk.size > MAX_PART_BYTES) {
      throw new Error("Reference upload part is too large.");
    }

    const apiKey = resolveOpenAIKey(typeof providedApiKey === "string" ? providedApiKey : undefined);
    const outgoing = new FormData();
    outgoing.append("data", chunk, chunk.name || "reference.part");

    const response = await fetch(`https://api.openai.com/v1/uploads/${encodeURIComponent(uploadId)}/parts`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: outgoing,
      signal: AbortSignal.timeout(120_000),
    });
    const part = await readOpenAIResponse<PartResponse>(response);

    return Response.json({ ok: true, partId: part.id });
  } catch (error) {
    return errorResponse(error);
  }
}
