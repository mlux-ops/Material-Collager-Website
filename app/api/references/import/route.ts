import { errorResponse } from "@/app/lib/openai-server";

export const runtime = "edge";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { imageUrl?: string };
    const url = safeRemoteUrl(body.imageUrl);
    const response = await fetch(url, { headers: { Accept: "image/png,image/jpeg,image/webp" } });
    if (!response.ok) throw new Error("The suggested image could not be downloaded.");
    const contentType = (response.headers.get("content-type") || "").split(";")[0].trim();
    if (!new Set(["image/png", "image/jpeg", "image/webp"]).has(contentType)) {
      throw new Error("The suggested source did not return a supported image.");
    }
    const bytes = await response.arrayBuffer();
    if (!bytes.byteLength || bytes.byteLength >= 10 * 1024 * 1024) throw new Error("The suggested image is empty or too large.");
    return new Response(bytes, { headers: { "Content-Type": contentType, "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

function safeRemoteUrl(value?: string) {
  const url = new URL(value || "");
  if (url.protocol !== "https:" || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(url.hostname)) {
    throw new Error("The suggested image URL is not allowed.");
  }
  return url.toString();
}
