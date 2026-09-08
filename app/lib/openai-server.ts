export class OpenAIRequestError extends Error {
  status: number;
  code?: string;
  requestId?: string;
  retryAfterMs?: number;
  errorType?: string;

  constructor(message: string, status: number, code?: string, requestId?: string) {
    super(message);
    this.name = "OpenAIRequestError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

// Combines an optional caller cancellation signal (e.g. request.signal, which
// aborts when the client fetch is cancelled) with an optional hard timeout, so
// a client cancel aborts the paid upstream call while the timeout is
// preserved. Filters out missing inputs: with only a caller signal it returns
// that signal, with only a timeout it returns the timeout signal, and an
// already-aborted caller yields an already-aborted result via AbortSignal.any.
export function combineAbortSignals(callerSignal?: AbortSignal | null, timeoutMs?: number): AbortSignal {
  const signals: AbortSignal[] = [];
  if (callerSignal) signals.push(callerSignal);
  if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    signals.push(AbortSignal.timeout(timeoutMs));
  }
  if (signals.length === 1) return signals[0];
  if (signals.length === 0) return new AbortController().signal;
  return AbortSignal.any(signals);
}

export function resolveOpenAIKey(provided?: string) {
  const apiKey = provided?.trim() || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new OpenAIRequestError("Add an OpenAI API key in Settings before generating.", 401, "missing_api_key");
  }
  return apiKey;
}

export type OpenAIUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

// OpenAI reports prompt-cache hits inside the usage block, but nests them
// differently per endpoint: the Responses API uses input_tokens_details, Chat
// Completions uses prompt_tokens_details. Read both so a single extractor
// covers every call site. Endpoints with no usage block at all (uploads,
// files, batches) yield undefined rather than a zeroed record, so they are
// omitted from the metrics instead of diluting the hit rate with fake zeroes.
export function extractOpenAIUsage(payload: unknown): OpenAIUsage | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const usage = (payload as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return undefined;

  const record = usage as Record<string, unknown>;
  const inputTokens = numberOr(record.input_tokens ?? record.prompt_tokens, NaN);
  const outputTokens = numberOr(record.output_tokens ?? record.completion_tokens, NaN);
  if (!Number.isFinite(inputTokens) && !Number.isFinite(outputTokens)) return undefined;

  const details = (record.input_tokens_details ?? record.prompt_tokens_details) as
    | Record<string, unknown>
    | undefined;
  const cachedInputTokens =
    details && typeof details === "object" ? numberOr(details.cached_tokens, 0) : 0;

  return {
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    cachedInputTokens,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
  };
}

// input_tokens is inclusive of cached tokens, so the hit rate is cached/input.
export function cacheHitRate(usage: OpenAIUsage): number {
  if (usage.inputTokens <= 0) return 0;
  return usage.cachedInputTokens / usage.inputTokens;
}

// Emitted to Workers Logs (observability is enabled in wrangler.jsonc) as a
// single greppable line per paid call. Deliberately not dev-gated: the point
// is production hit rates, which cannot be measured locally.
export function logOpenAIUsage(usage: OpenAIUsage, context?: { label?: string; model?: string }): void {
  const percent = (cacheHitRate(usage) * 100).toFixed(1);
  console.info(
    `[openai-usage] label=${context?.label ?? "unknown"} model=${context?.model ?? "unknown"} ` +
      `input=${usage.inputTokens} cached=${usage.cachedInputTokens} hit=${percent}% output=${usage.outputTokens}`,
  );
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export async function readOpenAIResponse<T>(
  response: Response,
  context?: { label?: string; model?: string },
): Promise<T> {
  const raw = await response.text();
  let payload: { error?: { message?: string; code?: string; type?: string } } & Record<string, unknown> = {};
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
    const error = new OpenAIRequestError(
      message,
      response.status,
      payload.error?.code,
      headerRequestId || requestIdFrom(message),
    );
    error.errorType = payload.error?.type;
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter) {
      const seconds = Number(retryAfter);
      const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
      if (Number.isFinite(delay)) error.retryAfterMs = Math.max(0, delay);
    }
    throw error;
  }

  const usage = extractOpenAIUsage(payload);
  if (usage) logOpenAIUsage(usage, context);

  return payload as T;
}

export function errorResponse(error: unknown) {
  if (error instanceof OpenAIRequestError) {
    const displayError =
      error.requestId && !error.message.includes(error.requestId)
        ? `${error.message} (Request ID: ${error.requestId})`
        : error.message;
    // Forward the provider's Retry-After (as both a JSON field and the
    // standard header) and its error type, so clients — the generator UI and
    // the autoboard CLI — can wait the right amount before trying again and
    // can tell a user-correctable input error from a provider fault.
    const headers = new Headers();
    if (error.retryAfterMs !== undefined) headers.set("Retry-After", String(Math.ceil(error.retryAfterMs / 1000)));
    return Response.json(
      {
        ok: false,
        error: displayError,
        code: error.code,
        requestId: error.requestId,
        ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
        ...(error.errorType ? { errorType: error.errorType } : {}),
      },
      { status: error.status >= 400 && error.status < 600 ? error.status : 500, headers },
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
