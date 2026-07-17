import { publicJob, setLibraryVisibility } from "@/app/lib/generation-jobs";
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
