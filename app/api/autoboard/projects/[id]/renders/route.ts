import { listRenders } from "@/app/lib/autoboard-renders";
import { jsonError } from "@/app/lib/autoboard-http";

export const runtime = "edge";

/** Every render in the project, so the boards view loads them in one request. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    return Response.json({ ok: true, renders: await listRenders(id) });
  } catch (error) {
    return jsonError(error, 500);
  }
}
