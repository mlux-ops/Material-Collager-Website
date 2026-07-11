import { errorResponse, readOpenAIResponse, resolveOpenAIKey } from "@/app/lib/openai-server";

export const runtime = "edge";

type ResponsesOutput = {
  output_text?: string;
  output?: Array<{ content?: Array<{ text?: string }> }>;
};

export async function POST(request: Request) {
  try {
    const body = await request.json() as { apiKey?: string; query?: string; itemType?: string };
    const query = body.query?.trim();
    if (!query) throw new Error("Analyze the primary image before finding matches.");
    const apiKey = resolveOpenAIKey(body.apiKey);
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.MATERIAL_COLLAGER_MATCH_MODEL || "gpt-5.4-mini",
        reasoning: { effort: "low" },
        tools: [{ type: "web_search" }],
        text: {
          format: {
            type: "json_schema",
            name: "reference_matches",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                candidates: {
                  type: "array",
                  maxItems: 4,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      title: { type: "string" },
                      pageUrl: { type: "string" },
                      imageUrl: { type: "string" },
                      sourceLabel: { type: "string" },
                      official: { type: "boolean" },
                      confidence: { type: "integer", minimum: 0, maximum: 100 },
                      reason: { type: "string" },
                    },
                    required: ["title", "pageUrl", "imageUrl", "sourceLabel", "official", "confidence", "reason"],
                  },
                },
              },
              required: ["candidates"],
            },
          },
        },
        input: `Find up to four likely matching references for this interior product or material: ${query}.
Item type: ${body.itemType || "unknown"}.
Prioritize official manufacturer product pages and technical documents, then reputable retailers. Do not claim an exact match without model, SKU, or strong manufacturer evidence.
Inspect the confirmed page's Open Graph or JSON-LD product-image metadata when available. Use a direct product image URL only when the page exposes one; otherwise leave imageUrl empty.`,
      }),
    });
    const json = await readOpenAIResponse<ResponsesOutput>(response);
    const parsed = JSON.parse(extractOutputText(json).replace(/^```json\s*/i, "").replace(/```$/i, "").trim()) as {
      candidates?: Array<Record<string, unknown>>;
    };
    const normalized = (parsed.candidates ?? [])
      .slice(0, 4)
      .map(normalizeCandidate)
      .filter((candidate) => candidate.pageUrl)
      .sort((left, right) => Number(right.official) - Number(left.official) || right.confidence - left.confidence);
    const candidates = await Promise.all(normalized.map(hydrateCandidateImage));
    return Response.json({ ok: true, candidates });
  } catch (error) {
    return errorResponse(error);
  }
}

function extractOutputText(response: ResponsesOutput) {
  if (response.output_text) return response.output_text;
  return (response.output ?? []).flatMap((output) => output.content ?? []).map((part) => part.text || "").join("\n");
}

function safeHttps(value: unknown) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(url.hostname)) return "";
    return url.toString();
  } catch {
    return "";
  }
}

function normalizeCandidate(value: Record<string, unknown>) {
  return {
    title: String(value.title || "Possible match").trim(),
    pageUrl: safeHttps(value.pageUrl),
    imageUrl: safeHttps(value.imageUrl),
    sourceLabel: String(value.sourceLabel || "Web source").trim(),
    official: Boolean(value.official),
    confidence: Math.max(0, Math.min(100, Math.round(Number(value.confidence) || 0))),
    reason: String(value.reason || "").trim(),
  };
}

async function hydrateCandidateImage(candidate: ReturnType<typeof normalizeCandidate>) {
  if (candidate.imageUrl && await isRemoteImage(candidate.imageUrl)) return candidate;
  const discovered = await discoverProductImage(candidate.pageUrl);
  return { ...candidate, imageUrl: discovered && await isRemoteImage(discovered) ? discovered : "" };
}

async function isRemoteImage(url: string) {
  try {
    const response = await fetch(url, {
      headers: { Accept: "image/png,image/jpeg,image/webp", Range: "bytes=0-0" },
      redirect: "follow",
    });
    const finalUrl = safeHttps(response.url);
    const contentType = (response.headers.get("content-type") || "").split(";")[0].trim();
    await response.body?.cancel();
    return Boolean(finalUrl && response.ok && ["image/png", "image/jpeg", "image/webp"].includes(contentType));
  } catch {
    return false;
  }
}

async function discoverProductImage(pageUrl: string) {
  try {
    const response = await fetch(pageUrl, {
      headers: { Accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
    });
    if (!response.ok || !safeHttps(response.url)) return "";
    const contentType = response.headers.get("content-type") || "";
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (!contentType.includes("text/html") || contentLength > 5 * 1024 * 1024) return "";
    const html = await response.text();
    const metadataImage = extractOpenGraphImage(html) || extractJsonLdImage(html);
    return metadataImage ? safeHttps(new URL(metadataImage, response.url).toString()) : "";
  } catch {
    return "";
  }
}

function extractOpenGraphImage(html: string) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attributes = Object.fromEntries(Array.from(tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g), (match) => [
      match[1].toLowerCase(),
      (match[2] || match[3] || match[4] || "").replaceAll("&amp;", "&"),
    ]));
    const property = (attributes.property || attributes.name || "").toLowerCase();
    if (["og:image", "og:image:secure_url", "twitter:image"].includes(property) && attributes.content) return attributes.content;
  }
  return "";
}

function extractJsonLdImage(html: string) {
  const scripts = html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of scripts) {
    try {
      const image = findImageValue(JSON.parse(match[1]));
      if (image) return image;
    } catch {
      // Ignore malformed metadata and continue to the next JSON-LD block.
    }
  }
  return "";
}

function findImageValue(value: unknown): string {
  if (!value) return "";
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findImageValue(entry);
      if (found) return found;
    }
    return "";
  }
  if (typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  const image = record.image;
  if (typeof image === "string") return image;
  if (image && typeof image === "object") {
    const imageRecord = image as Record<string, unknown>;
    if (typeof imageRecord.contentUrl === "string") return imageRecord.contentUrl;
    if (typeof imageRecord.url === "string") return imageRecord.url;
  }
  for (const entry of Object.values(record)) {
    const found = findImageValue(entry);
    if (found) return found;
  }
  return "";
}
