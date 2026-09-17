import { saveBoardState } from "@/app/lib/autoboard-board-state";
import { jsonError, readJsonBody } from "@/app/lib/autoboard-http";

export const runtime = "edge";

type Context = { params: Promise<{ id: string; boardId: string }> };

/**
 * A reviewer's decisions about one board: the board instruction, a note per
 * slot, which slot anchors the composition, and the render options.
 *
 * A PATCH, not a replacement — the UI saves one field at a time, and a write
 * that blanked the others would lose the notes on every keystroke elsewhere.
 */
export async function PATCH(request: Request, context: Context) {
  try {
    const { id, boardId } = await context.params;
    const body = await readJsonBody<{
      instruction?: unknown;
      heroItemId?: unknown;
      quality?: unknown;
      background?: unknown;
      notes?: unknown;
    }>(request);
    return Response.json({ ok: true, state: await saveBoardState(id, boardId, body) });
  } catch (error) {
    return jsonError(error);
  }
}
