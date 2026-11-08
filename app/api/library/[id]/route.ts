import { deleteLibraryUpload, publicJob, setLibraryVisibility } from "@/app/lib/generation-jobs";
import { errorResponse } from "@/app/lib/openai-server";

export const runtime = "edge";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    if (!id || id.length > 100) throw new Error("The Library item is invalid.");
    const body = await request.json() as { visible?: boolean };
    if (typeof body.visible !== "boolean") throw new Error("Choose whether this output belongs in the Library.");
    const row = await setLibraryVisibility(id, body.visible);
    if (!row) return Response.json({ ok: false, error: "The generated output was not found." }, { status: 404 });
    return Response.json({ ok: true, item: publicJob(row) });
  } catch (error) {
    return errorResponse(error);
  }
}

// Deletes an image uploaded through /library/upload (row and R2 object).
// Renders cannot be deleted here.
export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    if (!id || id.length > 100) throw new Error("The Library item is invalid.");
    const outcome = await deleteLibraryUpload(id);
    if (outcome === "not_found") {
      return Response.json({ ok: false, error: "The Library item was not found." }, { status: 404 });
    }
    if (outcome === "not_upload") {
      return Response.json(
        { ok: false, error: "Only uploaded images can be deleted. Generated renders stay in the Library." },
        { status: 403 },
      );
    }
    return Response.json({ ok: true, id });
  } catch (error) {
    return errorResponse(error);
  }
}
