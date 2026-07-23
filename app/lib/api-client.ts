// Shared client-side API response envelope for /api/* routes, which all
// return `{ ok: boolean, error?: string, ... }` JSON via errorResponse.

export class ApiResponseError extends Error {
  payload: Record<string, unknown>;

  constructor(message: string, payload: Record<string, unknown>) {
    super(message);
    this.name = "ApiResponseError";
    this.payload = payload;
  }
}

export async function readApiResponse<T extends { ok: boolean; error?: string }>(response: Response): Promise<T> {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const payload = (await response.json()) as T;
    if (!response.ok || !payload.ok) {
      throw new ApiResponseError(
        payload.error || `Request failed with status ${response.status}.`,
        { ...(payload as Record<string, unknown>), status: response.status },
      );
    }
    return payload;
  }

  const text = (await response.text()).trim();
  if (response.status === 413 || /payload too large/i.test(text)) {
    throw new Error("A reference chunk was rejected by the host. The original files are still saved in your draft.");
  }
  throw new Error(text || `Request failed with status ${response.status}.`);
}
