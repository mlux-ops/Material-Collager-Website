import { saveBoardState } from "@/app/lib/autoboard-board-state";
import { setProjectBoardExcluded } from "@/app/lib/autoboard-projects";
import { jsonError, readJsonBody } from "@/app/lib/autoboard-http";

export const runtime = "edge";

type Context = { params: Promise<{ id: string; boardId: string }> };

function notFound() {
  return Response.json({ ok: false, error: "No such project." }, { status: 404 });
}

/**
 * A reviewer's decisions about one board: the board instruction, a note per
 * slot, which slot anchors the composition, the render options — or, with
 * `{ excluded: true }`, that the board is removed from the project entirely
 * (restored by `false`). Removal is handled separately from the state
 * fields: it lives in a different table (autoboard-row-edits.ts, alongside
 * row removals) than board state does, so restoring a board brings its
 * instruction and notes back exactly as they were left.
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
      excluded?: unknown;
    }>(request);
    if (body.excluded !== undefined) {
      const project = await setProjectBoardExcluded(id, boardId, body.excluded === true);
      if (!project) return notFound();
      return Response.json({ ok: true, project });
    }
    return Response.json({ ok: true, state: await saveBoardState(id, boardId, body) });
  } catch (error) {
    return jsonError(error);
  }
}
