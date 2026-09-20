import {
  buildProjectBoards,
  deleteProject,
  getProject,
  refreshProject,
  renameProject,
} from "@/app/lib/autoboard-projects";
import { jsonError, readJsonBody } from "@/app/lib/autoboard-http";

export const runtime = "edge";

type Context = { params: Promise<{ id: string }> };

function notFound() {
  return Response.json({ ok: false, error: "No such project." }, { status: 404 });
}

export async function GET(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const project = await getProject(id);
    if (!project) return notFound();
    // The built boards ride along with the project: they are derived from the
    // selected photos, so caching them would just be a second thing to keep in
    // step with the grid.
    const built = await buildProjectBoards(project);
    return Response.json({ ok: true, project, built });
  } catch (error) {
    return jsonError(error, 500);
  }
}

/** `{ action: "refresh" }` re-reads the sheet; `{ name }` renames. */
export async function PATCH(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const body = await readJsonBody<{ action?: unknown; name?: unknown }>(request);

    if (body.action === "refresh") {
      const project = await refreshProject(id);
      return project ? Response.json({ ok: true, project }) : notFound();
    }
    if (typeof body.name === "string") {
      if (!(await renameProject(id, body.name))) return notFound();
      return Response.json({ ok: true, project: await getProject(id) });
    }
    throw new Error('Send { action: "refresh" } or { name: "..." }.');
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    return (await deleteProject(id)) ? Response.json({ ok: true }) : notFound();
  } catch (error) {
    return jsonError(error, 500);
  }
}
