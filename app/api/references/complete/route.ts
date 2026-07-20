import { errorResponse, readOpenAIResponse, resolveOpenAIKey } from "@/app/lib/openai-server";

export const runtime = "edge";

type CompletedUpload = {
  id: string;
  status: string;
  file?: {
    id: string;
  };
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      apiKey?: string;
      uploadId?: string;
      partIds?: string[];
    };

    if (!body.uploadId || !/^upload_[A-Za-z0-9_-]+$/.test(body.uploadId)) {
      throw new Error("Reference upload ID is invalid.");
    }
    if (!Array.isArray(body.partIds) || body.partIds.length === 0 || body.partIds.some((id) => typeof id !== "string")) {
      throw new Error("Reference upload parts are incomplete.");
    }

    const apiKey = resolveOpenAIKey(body.apiKey);
    const response = await fetch(
      `https://api.openai.com/v1/uploads/${encodeURIComponent(body.uploadId)}/complete`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ part_ids: body.partIds }),
        signal: AbortSignal.timeout(60_000),
      },
    );
    const completed = await readOpenAIResponse<CompletedUpload>(response);
    if (!completed.file?.id) {
      throw new Error("OpenAI completed the upload without returning a usable file.");
    }

    return Response.json({ ok: true, fileId: completed.file.id });
  } catch (error) {
    return errorResponse(error);
  }
}
