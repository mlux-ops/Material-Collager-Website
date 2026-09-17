import { buildProjectBoards, getProject } from "@/app/lib/autoboard-projects";
import { listRenders, renderBoardDraft } from "@/app/lib/autoboard-renders";
import { DEFAULT_VARIANTS } from "@/app/lib/autoboard/variants";
import { jsonError, readJsonBody } from "@/app/lib/autoboard-http";

export const runtime = "edge";

type Context = { params: Promise<{ id: string; boardId: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const { id, boardId } = await context.params;
    const renders = (await listRenders(id)).filter((render) => render.boardId === boardId);
    return Response.json({ ok: true, renders });
  } catch (error) {
    return jsonError(error, 500);
  }
}

/**
 * Renders one draft. This SPENDS MONEY — it is a POST with no batching and no
 * retry, one press to one image, so a mistaken double-click costs one draft
 * rather than a set.
 */
export async function POST(request: Request, context: Context) {
  try {
    const { id, boardId } = await context.params;
    const body = await readJsonBody<{ variant?: unknown }>(request);

    const project = await getProject(id);
    if (!project) return Response.json({ ok: false, error: "No such project." }, { status: 404 });
    const built = await buildProjectBoards(project);
    const board = built.boards.find((entry) => entry.id === boardId);
    if (!board) return Response.json({ ok: false, error: "No such board in this project." }, { status: 404 });

    const variantKey = String(body.variant ?? DEFAULT_VARIANTS[0].key);
    const variant = DEFAULT_VARIANTS.find((entry) => entry.key === variantKey);
    if (!variant) throw new Error(`Variant "${variantKey}" is not one of ${DEFAULT_VARIANTS.map((v) => v.key).join(", ")}.`);

    const render = await renderBoardDraft(id, board, board.state.instruction, {
      variant,
      origin: new URL(request.url).origin,
    });
    return Response.json({ ok: true, render }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
