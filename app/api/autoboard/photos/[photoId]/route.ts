import { deletePhoto, getPhotoObject, setPhotoStatus } from "@/app/lib/autoboard-photos";
import { jsonError, readJsonBody } from "@/app/lib/autoboard-http";

export const runtime = "edge";

type Context = { params: Promise<{ photoId: string }> };

/** Serves the stored bytes. Private caching only — this is client material. */
export async function GET(_request: Request, context: Context) {
  try {
    const { photoId } = await context.params;
    const found = await getPhotoObject(photoId);
    if (!found) return new Response("No such photo.", { status: 404 });
    return new Response(found.object.body, {
      headers: {
        "Content-Type": found.contentType,
        "Cache-Control": "private, max-age=300",
        // Vendor product photography collected for internal design reference.
        "X-Robots-Tag": "noindex, noimageindex",
      },
    });
  } catch (error) {
    return new Response(error instanceof Error ? error.message : "Photo unavailable.", { status: 500 });
  }
}

export async function PATCH(request: Request, context: Context) {
  try {
    const { photoId } = await context.params;
    const body = await readJsonBody<{ status?: unknown }>(request);
    const photo = await setPhotoStatus(photoId, body.status);
    return photo
      ? Response.json({ ok: true, photo })
      : Response.json({ ok: false, error: "No such photo." }, { status: 404 });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(_request: Request, context: Context) {
  try {
    const { photoId } = await context.params;
    return (await deletePhoto(photoId))
      ? Response.json({ ok: true })
      : Response.json({ ok: false, error: "No such photo." }, { status: 404 });
  } catch (error) {
    return jsonError(error, 500);
  }
}
