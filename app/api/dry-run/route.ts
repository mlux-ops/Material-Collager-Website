import { buildGenerationPrompt, buildSummary, type CollageRequestInput, validateCollageRequest } from "@/app/lib/collage";

export const runtime = "edge";

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as CollageRequestInput;
    validateCollageRequest(payload);
    return Response.json({
      ok: true,
      summary: buildSummary(payload),
      prompt: buildGenerationPrompt(payload),
    });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "Dry run failed." },
      { status: 400 },
    );
  }
}

