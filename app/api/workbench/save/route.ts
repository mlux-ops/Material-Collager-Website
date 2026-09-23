import { persistGenerationOutput } from "@/app/lib/generation-jobs";
import { errorResponse } from "@/app/lib/openai-server";
import { sniffImageType } from "@/app/lib/autoboard/image-size";

export const runtime = "edge";

// Persists a workbench node output into the shared six-month history / library
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

    const bytes = new Uint8Array(await image.arrayBuffer());
    // The bytes decide the type, not the caller's filename or Content-Type:
    // persistence derives the R2 content type and the history's format from
    // the extension, so it has to be the real one.
    const type = sniffImageType(bytes);
    if (!type) throw new Error("Only PNG, JPEG or WebP images can be saved to the library.");
    const stored = await persistGenerationOutput({
      imageBase64: base64FromBytes(bytes),
      filename: safeFilename(payload.filename, type),
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

const EXTENSION_FOR_TYPE = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as const;

// Renaming is not transcoding: "board.png" holding JPEG bytes is stored as
// "board.jpg", so its name, MIME type and recorded format all agree.
function safeFilename(value: string | undefined, type: keyof typeof EXTENSION_FOR_TYPE) {
  const stem = (value?.trim() || "workbench-output").replace(/\.(png|jpe?g|webp)$/i, "");
  return `${stem}.${EXTENSION_FOR_TYPE[type]}`.replace(/[<>:"/\\|?*]+/g, "_");
}
