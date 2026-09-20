import { setProjectRowExcluded, setProjectRowPin } from "@/app/lib/autoboard-projects";
import { jsonError, readJsonBody } from "@/app/lib/autoboard-http";

export const runtime = "edge";

type Context = { params: Promise<{ id: string; rowId: string }> };

function notFound() {
  return Response.json({ ok: false, error: "No such project." }, { status: 404 });
}

/**
 * One row's edits. `{ excluded: true }` removes it from every board (and
 * `false` restores it); `{ pin: { collageType, slotId } }` places it on a slot,
 * `{ pin: null }` lets the rules decide again. Both may be sent together.
 */
export async function PATCH(request: Request, context: Context) {
  try {
    const { id, rowId } = await context.params;
    const body = await readJsonBody<{ excluded?: unknown; pin?: unknown }>(request);
    if (body.excluded === undefined && body.pin === undefined) {
      throw new Error("Send { excluded: true | false } and/or { pin: { collageType, slotId } | null }.");
    }
    let project = null;
    if (body.pin !== undefined) {
      project = await setProjectRowPin(id, rowId, body.pin);
      if (!project) return notFound();
    }
    if (body.excluded !== undefined) {
      project = await setProjectRowExcluded(id, rowId, body.excluded === true);
      if (!project) return notFound();
    }
    return Response.json({ ok: true, project });
  } catch (error) {
    return jsonError(error);
  }
}
