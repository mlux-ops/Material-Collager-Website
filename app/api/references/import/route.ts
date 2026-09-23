import { fetchPublic, readCapped } from "@/app/lib/guarded-fetch";
import { errorResponse } from "@/app/lib/openai-server";

export const runtime = "edge";

const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export async function POST(request: Request) {
  try {
    const body = await request.json() as { imageUrl?: string };
    // fetchPublic validates the URL and every redirect hop before requesting
    // it (https only, no private, loopback or metadata hosts).
    const { response } = await fetchPublic(body.imageUrl ?? "", {
      headers: { Accept: "image/png,image/jpeg,image/webp" },
      timeoutMs: 15_000,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("The suggested image could not be downloaded.");
    }
    const contentType = (response.headers.get("content-type") || "").split(";")[0].trim();
    if (!IMAGE_TYPES.has(contentType)) {
      await response.body?.cancel();
      throw new Error("The suggested source did not return a supported image.");
    }
    const bytes = await readCapped(response, MAX_IMPORT_BYTES, { tooLarge: "The suggested image is too large." });
    if (!bytes.byteLength) throw new Error("The suggested image is empty.");
    return new Response(bytes, { headers: { "Content-Type": contentType, "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
