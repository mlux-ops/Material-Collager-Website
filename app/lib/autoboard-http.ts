// Shared request/response handling for the review board's API routes.

export function jsonError(error: unknown, status = 400) {
  const message = error instanceof Error ? error.message : "The review board request failed.";
  return Response.json({ ok: false, error: message }, { status });
}

// Same CSRF defense the CLI's review server uses: a form post or an <img> can
// set neither this header nor a JSON body, so requiring it keeps a cross-origin
// page from driving these endpoints through an authenticated browser session.
export function requireJsonRequest(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Error("This endpoint requires Content-Type: application/json.");
  }
}

export async function readJsonBody<T>(request: Request): Promise<T> {
  requireJsonRequest(request);
  try {
    return (await request.json()) as T;
  } catch {
    throw new Error("Request body was not valid JSON.");
  }
}

// Smartsheet sheet ids are numeric strings. Validating the shape here keeps a
// typo from becoming a confusing upstream 404, and keeps anything else from
// reaching the URL the loader builds.
export function requireSheetId(value: unknown): string {
  const sheetId = String(value ?? "").trim();
  if (!/^\d{6,25}$/.test(sheetId)) {
    throw new Error("Give a Smartsheet sheet id — the numeric id from the sheet's Properties panel.");
  }
  return sheetId;
}

export function requireStringList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${field} must be an array of strings.`);
  }
  return value as string[];
}
