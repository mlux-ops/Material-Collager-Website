import { addProjectRow, projectRowForm } from "@/app/lib/autoboard-projects";
import { jsonError, readJsonBody } from "@/app/lib/autoboard-http";

export const runtime = "edge";

type Context = { params: Promise<{ id: string }> };

function notFound() {
  return Response.json({ ok: false, error: "No such project." }, { status: 404 });
}

/** The form for adding a row: one field per sheet column, or the manual set. */
export async function GET(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const form = await projectRowForm(id);
    return form ? Response.json({ ok: true, form }) : notFound();
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * `{ values }`, keyed by the form's field keys. With a sheet behind the project
 * the row is written into the sheet and the project re-read; without one it is
 * stored as a manual row. Either way the response carries the updated project
 * and where the row went.
 */
export async function POST(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const body = await readJsonBody<{ values?: unknown }>(request);
    if (!body.values || typeof body.values !== "object" || Array.isArray(body.values)) {
      throw new Error("Send { values: { <field key>: <value> } }.");
    }
    const result = await addProjectRow(id, body.values as Record<string, unknown>);
    return result ? Response.json({ ok: true, ...result }, { status: 201 }) : notFound();
  } catch (error) {
    return jsonError(error);
  }
}
