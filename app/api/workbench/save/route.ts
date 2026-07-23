import { persistGenerationOutput } from "@/app/lib/generation-jobs";
import { errorResponse } from "@/app/lib/openai-server";

export const runtime = "edge";

// Persists a workbench node output into the shared 30-day history / library
// (D1 + R2), the same storage the generator's renders use. renderKind "final"
// makes it library-visible.
type WorkbenchSavePayload = {
  filename?: string;
  prompt?: string;
  format?: string;
  workflow?: string;
};

export async function POST(request: Request) {
  try {
    const incoming = await request.formData();
    const payloadText = incoming.get("payload");
    if (typeof payloadText !== "string") throw new Error("Missing save payload.");
    const payload = JSON.parse(payloadText) as WorkbenchSavePayload;

    const image = incoming.get("image");
    if (!(image instanceof File) || !image.type.startsWith("image/")) {
      throw new Error("Connect an image output to save.");
    }
    if (image.size >= 50 * 1024 * 1024) throw new Error("The image must be under 50 MB.");

    const stored = await persistGenerationOutput({
      imageBase64: base64FromBytes(new Uint8Array(await image.arrayBuffer())),
      filename: safeFilename(payload.filename),
      format: (payload.format || "").slice(0, 32) || "workbench",
      prompt: (payload.prompt || "Workbench output").slice(0, 32_000),
      payload: { source: "workbench", workflow: payload.workflow || "untitled" },
      renderKind: "final",
      collageType: "workbench",
    });

    return Response.json({ ok: true, jobId: stored.id, libraryVisible: stored.libraryVisible });
  } catch (error) {
    return errorResponse(error);
  }
}

function base64FromBytes(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function safeFilename(value?: string) {
  const raw = value?.trim() || "workbench-output.png";
  const withExtension = raw.toLowerCase().endsWith(".png") ? raw : `${raw}.png`;
  return withExtension.replace(/[<>:"/\\|?*]+/g, "_");
}
