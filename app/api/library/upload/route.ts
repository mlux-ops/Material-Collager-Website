import { persistGenerationOutput } from "@/app/lib/generation-jobs";
import { errorResponse } from "@/app/lib/openai-server";
import { readImageSizeFromBytes, sniffImageType } from "@/app/lib/autoboard/image-size";
import { displaySize, LIBRARY_UPLOAD_MAX_BYTES, safeFilename } from "@/app/lib/image-upload";

export const runtime = "edge";

// One image per request, from the Library's upload page (/library/upload),
// into the same D1 + R2 store the renders use. Uploads are kept permanently:
// cleanupExpiredJobs never sweeps them, unlike a render's six months.
//
// Multipart fields: `image` (the file) and an optional `title`.

const MAX_TITLE_CHARS = 120;

function stemOf(name: string) {
  return name.replace(/\.[^.]+$/, "").trim();
}

export async function POST(request: Request) {
  try {
    const incoming = await request.formData();
    const image = incoming.get("image");
    if (!(image instanceof File)) throw new Error("Attach an image to upload.");
    if (image.size === 0) throw new Error("The file is empty.");
    if (image.size > LIBRARY_UPLOAD_MAX_BYTES) {
      throw new Error(`The image is larger than ${LIBRARY_UPLOAD_MAX_BYTES / (1024 * 1024)} MB.`);
    }

    const bytes = new Uint8Array(await image.arrayBuffer());
    // The bytes decide the type, never the browser's Content-Type or the name:
    // persistence derives the R2 content type from the stored extension.
    const type = sniffImageType(bytes);
    if (!type) throw new Error("Only PNG, JPEG or WebP images can be uploaded to the library.");
    // sniffImageType calls anything opening FF D8 a JPEG; a file whose header
    // carries no readable size is not an image the library can show.
    const headerSize = readImageSizeFromBytes(bytes);
    if (!headerSize || headerSize.width <= 0 || headerSize.height <= 0) {
      throw new Error("The image's dimensions could not be read.");
    }
    // A phone JPEG stores sensor-order pixels plus an EXIF rotation; record
    // the size the browser actually draws, so the aspect ratio matches.
    const size = type === "image/jpeg" ? displaySize(headerSize, bytes) : headerSize;

    const originalName = (image.name || "").slice(0, 255);
    const requestedTitle = incoming.get("title");
    const title = ((typeof requestedTitle === "string" ? requestedTitle.trim() : "") || stemOf(originalName) || "Uploaded image")
      .slice(0, MAX_TITLE_CHARS);

    const stored = await persistGenerationOutput({
      // Raw bytes, not base64: no extra full-size copies of a 25 MB file.
      imageBytes: bytes,
      filename: safeFilename(stemOf(originalName).slice(0, MAX_TITLE_CHARS), type, "upload"),
      format: "upload",
      prompt: "Uploaded image",
      payload: { source: "upload", originalName, width: size.width, height: size.height },
      renderKind: "final",
      collageType: "upload",
      retention: "permanent",
      title,
    });

    return Response.json({
      ok: true,
      item: {
        ...stored,
        imageUrl: `/api/library/${encodeURIComponent(stored.id)}/image`,
        aspectRatio: size.width / size.height,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
