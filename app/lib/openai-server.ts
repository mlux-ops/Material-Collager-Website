export class OpenAIRequestError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "OpenAIRequestError";
    this.status = status;
    this.code = code;
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

  if (raw) {
    try {
      payload = JSON.parse(raw) as typeof payload;
    } catch {
      if (!response.ok) {
        throw new OpenAIRequestError(raw, response.status);
      }
      throw new OpenAIRequestError("OpenAI returned an unreadable response.", 502, "invalid_response");
    }
  }

  if (!response.ok) {
    throw new OpenAIRequestError(
      payload.error?.message || `OpenAI request failed with status ${response.status}.`,
      response.status,
      payload.error?.code,
    );
  }

  return payload as T;
}

export function errorResponse(error: unknown) {
  if (error instanceof OpenAIRequestError) {
    return Response.json(
      { ok: false, error: error.message, code: error.code },
      { status: error.status >= 400 && error.status < 600 ? error.status : 500 },
    );
  }

  return Response.json(
    { ok: false, error: error instanceof Error ? error.message : "Request failed." },
    { status: 400 },
  );
}
