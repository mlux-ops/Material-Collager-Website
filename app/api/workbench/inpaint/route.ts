import { env } from "cloudflare:workers";

import { errorResponse } from "@/app/lib/openai-server";

export const runtime = "edge";

// Pixel-exact inpainting endpoint for the Masked Edit node's "workers-ai"
// engine. Unlike /api/workbench/edit (gpt-image-2, mask-as-guidance), this
// runs Workers AI's mask-conditioned Stable Diffusion inpainting: only white
// mask pixels are repainted, everything else is reproduced from the input.
// The client still composites the result over the full-resolution original
// (app/lib/selective-edit.ts), so protected pixels stay bit-identical.
//
// Free on the Workers AI tier (no per-image OpenAI spend); requests are
// Access-gated at the Worker entry like every other route.
const INPAINT_MODEL = "@cf/runwayml/stable-diffusion-v1-5-inpainting";

// SD 1.5 model bounds (schema: width/height 256-2048; the client sends
// multiple-of-8 dimensions downscaled to the model's sweet spot).
const MIN_DIMENSION = 256;
const MAX_DIMENSION = 2048;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_MASK_BYTES = 4 * 1024 * 1024;

type AiBinding = {
  run(model: string, inputs: Record<string, unknown>): Promise<ReadableStream<Uint8Array> | { image?: string }>;
};

type InpaintPayload = {
  prompt?: string;
  width?: number;
  height?: number;
};

function validatedDimension(value: unknown, label: string): number {
  const dimension = Math.round(Number(value));
  if (!Number.isFinite(dimension) || dimension < MIN_DIMENSION || dimension > MAX_DIMENSION) {
    throw new Error(`The ${label} must be between ${MIN_DIMENSION} and ${MAX_DIMENSION} pixels.`);
  }
  return dimension - (dimension % 8);
}

// btoa over a chunked binary string: String.fromCharCode(...bytes) on a whole
// megabyte-scale image would blow the argument limit.
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export async function POST(request: Request) {
  try {
    const incoming = await request.formData();
    const payloadText = incoming.get("payload");
    if (typeof payloadText !== "string") throw new Error("Missing inpaint payload.");
    const payload = JSON.parse(payloadText) as InpaintPayload;

    const prompt = payload.prompt?.trim() || "";
    if (!prompt) throw new Error("Connect or enter a prompt before running this node.");
    // SD 1.5's CLIP encoder truncates past ~77 tokens on its own; this cap
    // only guards against absurd payloads, not model limits.
    if (prompt.length > 32_000) throw new Error("The prompt exceeds the 32,000 character limit.");
    const width = validatedDimension(payload.width, "width");
    const height = validatedDimension(payload.height, "height");

    const image = incoming.get("image");
    if (!(image instanceof File) || !image.type.startsWith("image/") || image.size >= MAX_IMAGE_BYTES) {
      throw new Error("The input image must be an image file under 8 MB.");
    }
    const mask = incoming.get("mask");
    if (!(mask instanceof File) || mask.type !== "image/png" || mask.size >= MAX_MASK_BYTES) {
      throw new Error("The mask must be a PNG under 4 MB.");
    }

    const ai = (env as unknown as { AI?: AiBinding }).AI;
    if (!ai) throw new Error("Workers AI is not configured for this deployment (missing the `ai` binding).");

    // Model schema: `image`/`mask` are the raw file bytes as uint8 arrays;
    // white mask pixels mark the region to repaint. strength 1 = fully
    // repaint inside the mask; num_steps is capped at 20 by the platform.
    const result = await ai.run(INPAINT_MODEL, {
      prompt,
      image: [...new Uint8Array(await image.arrayBuffer())],
      mask: [...new Uint8Array(await mask.arrayBuffer())],
      width,
      height,
      num_steps: 20,
      strength: 1,
      guidance: 7.5,
    });

    // The binding returns a binary PNG ReadableStream today; tolerate a
    // base64 object shape too in case the schema shifts (docs mark it beta).
    let imageBase64: string;
    if (result instanceof ReadableStream) {
      const bytes = new Uint8Array(await new Response(result).arrayBuffer());
      if (!bytes.length) throw new Error("Workers AI returned an empty image.");
      imageBase64 = bytesToBase64(bytes);
    } else if (result && typeof result.image === "string" && result.image) {
      imageBase64 = result.image;
    } else {
      throw new Error("Workers AI did not return image data.");
    }

    return Response.json({
      ok: true,
      images: [imageBase64],
      mimeType: "image/png",
      size: `${width}x${height}`,
      retryable: false,
      diagnostics: { model: INPAINT_MODEL, transport: "binding", width, height },
    });
  } catch (error) {
    const base = await errorResponse(error).json() as Record<string, unknown>;
    // Workers AI capacity errors (3040) come and go within seconds.
    const retryable = error instanceof Error && /capacity|3040|try again/i.test(error.message);
    return Response.json({ ...base, retryable }, { status: 400 });
  }
}
