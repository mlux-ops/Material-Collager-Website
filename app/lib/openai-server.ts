export class OpenAIRequestError extends Error {
  status: number;
  code?: string;
  requestId?: string;

  constructor(message: string, status: number, code?: string, requestId?: string) {
    super(message);
    this.name = "OpenAIRequestError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export function resolveOpenAIKey(provided?: string) {
  const apiKey = provided?.trim() || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new OpenAIRequestError("Add an OpenAI API key in Settings before generating.", 401, "missing_api_key");
  }
  return apiKey;
}

export async function readOpenAIResponse<T>(response: Response): Promise<T> {
  const raw = await response.text();
  let payload: { error?: { message?: string; code?: string } } & Record<string, unknown> = {};
  const headerRequestId = response.headers.get("x-request-id") || undefined;

  if (raw) {
    try {
      payload = JSON.parse(raw) as typeof payload;
    } catch {
      if (!response.ok) {
        throw new OpenAIRequestError(raw, response.status, undefined, headerRequestId || requestIdFrom(raw));
      }
      throw new OpenAIRequestError("OpenAI returned an unreadable response.", 502, "invalid_response");
    }
  }

  if (!response.ok) {
    const message = payload.error?.message || `OpenAI request failed with status ${response.status}.`;
    throw new OpenAIRequestError(
      message,
      response.status,
      payload.error?.code,
      headerRequestId || requestIdFrom(message),
    );
  }

  return payload as T;
}

export function errorResponse(error: unknown) {
  if (error instanceof OpenAIRequestError) {
    const displayError =
      error.requestId && !error.message.includes(error.requestId)
        ? `${error.message} (Request ID: ${error.requestId})`
        : error.message;
    return Response.json(
      { ok: false, error: displayError, code: error.code, requestId: error.requestId },
      { status: error.status >= 400 && error.status < 600 ? error.status : 500 },
    );
  }

  return Response.json(
    { ok: false, error: error instanceof Error ? error.message : "Request failed." },
    { status: 400 },
  );
}

function requestIdFrom(value: string) {
  return value.match(/\breq_[A-Za-z0-9]+\b/)?.[0];
}
