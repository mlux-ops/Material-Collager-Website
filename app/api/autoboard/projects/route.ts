import { createProject, listProjects } from "@/app/lib/autoboard-projects";
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
    }>(request);
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
