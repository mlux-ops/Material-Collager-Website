import { createBlankProject, createProject, createProjectFromRows, listProjects } from "@/app/lib/autoboard-projects";
import { jsonError, readJsonBody, requireSheetId, requireStringList } from "@/app/lib/autoboard-http";

export const runtime = "edge";

export async function GET() {
  try {
    return Response.json({ ok: true, projects: await listProjects() });
  } catch (error) {
    return jsonError(error, 500);
  }
}

export async function POST(request: Request) {
  try {
    const body = await readJsonBody<{
      name?: unknown;
      sheetId?: unknown;
      unitTypes?: unknown;
      rooms?: unknown;
      rows?: unknown;
      source?: unknown;
      blank?: unknown;
    }>(request);

    // Nothing in it yet: rows are added by hand afterwards.
    if (body.blank === true) {
      const blank = await createBlankProject({ name: String(body.name ?? "").trim() });
      return Response.json({ ok: true, project: blank }, { status: 201 });
    }

    // Rows supplied directly: a tracked project definition, which has no
    // Smartsheet of its own. See scripts/autoboard/seed-web-project.mjs.
    if (body.rows !== undefined) {
      const imported = await createProjectFromRows({
        name: String(body.name ?? "").trim(),
        rows: body.rows as unknown[],
        source: body.source === undefined ? undefined : String(body.source),
      });
      return Response.json({ ok: true, project: imported }, { status: 201 });
    }

    const project = await createProject({
      name: String(body.name ?? "").trim(),
      sheetId: requireSheetId(body.sheetId),
      filter: {
        unitTypes: requireStringList(body.unitTypes, "unitTypes"),
        rooms: requireStringList(body.rooms, "rooms"),
      },
    });
    return Response.json({ ok: true, project }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
