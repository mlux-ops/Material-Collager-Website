import { deleteRender, setRenderStatus } from "@/app/lib/autoboard-renders";
import { jsonError, readJsonBody } from "@/app/lib/autoboard-http";

export const runtime = "edge";

type Context = { params: Promise<{ renderId: string }> };

export async function PATCH(request: Request, context: Context) {
  try {
    const { renderId } = await context.params;
    const body = await readJsonBody<{ status?: unknown }>(request);
    const render = await setRenderStatus(renderId, body.status);
    return render
      ? Response.json({ ok: true, render })
      : Response.json({ ok: false, error: "No such render." }, { status: 404 });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(_request: Request, context: Context) {
  try {
    const { renderId } = await context.params;
    return (await deleteRender(renderId))
      ? Response.json({ ok: true })
      : Response.json({ ok: false, error: "No such render." }, { status: 404 });
  } catch (error) {
    return jsonError(error, 500);
  }
}
