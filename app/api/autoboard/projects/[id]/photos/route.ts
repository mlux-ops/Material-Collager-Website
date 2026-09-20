import {
  discoverPhotoUrls,
  ingestPhotoFromUrl,
  ingestUploadedPhoto,
  listProjectPhotos,
} from "@/app/lib/autoboard-photos";
import { jsonError, readJsonBody } from "@/app/lib/autoboard-http";

export const runtime = "edge";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    return Response.json({ ok: true, photos: await listProjectPhotos(id) });
  } catch (error) {
    return jsonError(error, 500);
  }
}

/**
 * Three shapes, because a reference arrives three ways:
 *
 * - `{ action: "discover", url }` — what a URL offers. The sheet's reference
 *   column usually holds a product PAGE, so this reports the images that page
 *   declares about itself rather than storing its HTML as a photo.
 * - `{ rowId, url }` — fetch and store that image.
 * - `{ rowId, mimeType, dataBase64 }` — store an uploaded one.
 */
export async function POST(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const body = await readJsonBody<{
      action?: unknown;
      rowId?: unknown;
      url?: unknown;
      mimeType?: unknown;
      dataBase64?: unknown;
    }>(request);

    if (body.action === "discover") {
      return Response.json({ ok: true, ...(await discoverPhotoUrls(body.url)) });
    }

    const rowId = String(body.rowId ?? "").trim();
    if (!rowId) throw new Error("Which row is this photo for? Send a rowId.");

    const photo = body.url
      ? await ingestPhotoFromUrl(id, rowId, body.url)
      : await ingestUploadedPhoto(id, rowId, body);
    return Response.json({ ok: true, photo }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
