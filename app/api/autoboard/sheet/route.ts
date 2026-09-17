import { previewBoards, sheetFacets } from "@/app/lib/autoboard/preview";
import { readSheet } from "@/app/lib/autoboard-projects";
import { jsonError, readJsonBody, requireSheetId, requireStringList } from "@/app/lib/autoboard-http";

export const runtime = "edge";

/**
 * Reads a Smartsheet and reports what is in it, without storing anything.
 *
 * This is the sheet picker's whole job: show the unit types and rooms the sheet
 * actually contains, and — once a subsection is chosen — how many slots that
 * subsection would fill, so a person can see a choice is right before
 * committing to a project.
 */
export async function POST(request: Request) {
  try {
    const body = await readJsonBody<{ sheetId?: unknown; unitTypes?: unknown; rooms?: unknown }>(request);
    const sheetId = requireSheetId(body.sheetId);
    const filter = {
      unitTypes: requireStringList(body.unitTypes, "unitTypes"),
      rooms: requireStringList(body.rooms, "rooms"),
    };
    const { rows, allRows, gaps, source } = await readSheet(sheetId, filter);
    return Response.json({
      ok: true,
      source,
      sheetId,
      // Facets come from the WHOLE sheet, not the filtered slice: a picker that
      // narrowed its own options as you chose would strand you.
      facets: sheetFacets(allRows),
      totalRowCount: allRows.length,
      selectedRowCount: rows.length,
      preview: previewBoards(rows),
      gaps,
    });
  } catch (error) {
    return jsonError(error);
  }
}
