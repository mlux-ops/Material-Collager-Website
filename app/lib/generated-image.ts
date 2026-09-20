// Decodes /api/generate's JSON envelope into storable bytes.
//
// The route answers { ok, summary, prompt, imageBase64, mimeType, costUsd, ... }
// — the same shape the generator page reads via response.imageBase64 — not raw
// image bytes in the body. Kept dependency-free (no cloudflare:workers, no D1,
// no R2) so this exact parsing step has a fast, direct test: autoboard-renders.ts
// once read the whole response body as the image itself, which stored the JSON
// text into R2 under a ".png" key — every render then showed as a broken image,
// since the "PNG" it served was really the JSON that happens to CONTAIN a PNG.

export type GeneratedImageResponse = {
  imageBase64?: string;
  mimeType?: string;
  costUsd?: number;
};

export type DecodedGeneratedImage = {
  bytes: Uint8Array;
  contentType: string;
  costUsd: number | null;
};

export function decodeGeneratedImage(response: GeneratedImageResponse): DecodedGeneratedImage {
  if (!response.imageBase64) throw new Error("The render came back empty.");
  return {
    bytes: Uint8Array.from(atob(response.imageBase64), (character) => character.charCodeAt(0)),
    contentType: response.mimeType || "image/png",
    costUsd: Number.isFinite(response.costUsd) && (response.costUsd as number) > 0 ? (response.costUsd as number) : null,
  };
}
