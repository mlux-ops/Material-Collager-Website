import { env } from "cloudflare:workers";

import { errorResponse } from "@/app/lib/openai-server";

export const runtime = "edge";

// Pixel-exact inpainting endpoint for the Masked Edit node's mask-conditioned
// engines. Unlike /api/workbench/edit (gpt-image-2, mask-as-guidance), both
// backends here repaint ONLY white mask pixels and reproduce everything else
// from the input. The client still composites the result over the
// full-resolution original (app/lib/selective-edit.ts), so protected pixels
// stay bit-identical.
//
// - "workers-ai" (default): SD 1.5 inpainting via the AI binding. Free on the
//   Workers AI tier; strong at removal/context fill, weak prompt adherence.
// - "flux-fill": FLUX.1 Fill [pro] via the Black Forest Labs API (~$0.05 per
//   image, BFL_API_KEY secret). Async submit + poll; strong prompt adherence.
//
// Requests are Access-gated at the Worker entry like every other route.
const INPAINT_MODEL = "@cf/runwayml/stable-diffusion-v1-5-inpainting";
const FLUX_FILL_ENDPOINT = "https://api.bfl.ai/v1/flux-pro-1.0-fill";
const FLUX_POLL_INTERVAL_MS = 1_000;
const FLUX_POLL_TIMEOUT_MS = 120_000;

// SD 1.5 model bounds (schema: width/height 256-2048; the client sends
// multiple-of-8 dimensions downscaled to each engine's sweet spot).
const MIN_DIMENSION = 256;
const MAX_DIMENSION = 2048;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_MASK_BYTES = 4 * 1024 * 1024;

// FLUX Fill prompt-adherence bounds from the BFL schema. We deliberately
// default below BFL's own 60: at that strength Fill renders the prompt's most
// concept-dense noun as a literal object, so a "fill this patch with the
// surrounding material" edit comes back as a newly invented fixture instead of
// a surface that blends in. The client mirrors this default
// (maskedEdit.manifest.ts); validation here is independent, like the
// dimensions, so a hand-rolled payload can't push an out-of-range value at BFL.
const FLUX_GUIDANCE_MIN = 1.5;
const FLUX_GUIDANCE_MAX = 100;
const FLUX_GUIDANCE_DEFAULT = 30;
const FLUX_SEED_MAX = 4_294_967_295;

type AiBinding = {
  run(model: string, inputs: Record<string, unknown>): Promise<ReadableStream<Uint8Array> | { image?: string }>;
};

type InpaintPayload = {
  engine?: "workers-ai" | "flux-fill";
  prompt?: string;
  width?: number;
  height?: number;
  // flux-fill only (see FLUX_GUIDANCE_* below).
  guidance?: number;
  seed?: number;
};

type FluxSubmitResponse = { id?: string; polling_url?: string };
type FluxPollResponse = { status?: string; result?: { sample?: string } };

function validatedDimension(value: unknown, label: string): number {
  const dimension = Math.round(Number(value));
  if (!Number.isFinite(dimension) || dimension < MIN_DIMENSION || dimension > MAX_DIMENSION) {
    throw new Error(`The ${label} must be between ${MIN_DIMENSION} and ${MAX_DIMENSION} pixels.`);
  }
  return dimension - (dimension % 8);
}

// Out-of-range or non-numeric guidance falls back to the default rather than
// erroring: it is a quality dial, not a correctness constraint.
function validatedGuidance(value: unknown): number {
  const guidance = Number(value);
  if (!Number.isFinite(guidance)) return FLUX_GUIDANCE_DEFAULT;
  return Math.min(FLUX_GUIDANCE_MAX, Math.max(FLUX_GUIDANCE_MIN, guidance));
}

// undefined = let BFL pick a fresh seed. 0 is a valid seed, so absence must be
// distinguished from zero rather than falsy-checked.
function validatedSeed(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const seed = Math.floor(Number(value));
  if (!Number.isFinite(seed) || seed < 0) return undefined;
  return Math.min(FLUX_SEED_MAX, seed);
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

// Submit to BFL and poll until the render is ready, then pull the image from
// the signed result URL (valid 10 minutes — we fetch immediately). The
// request signal threads through so cancelling the node run stops the polling
// (the BFL task itself finishes server-side; there is no cancel API).
async function runFluxFill(
  prompt: string,
  imageBase64: string,
  maskBase64: string,
  guidance: number,
  seed: number | undefined,
  signal: AbortSignal,
): Promise<string> {
  const apiKey = process.env.BFL_API_KEY?.trim();
  if (!apiKey) throw new Error("The FLUX engine needs the BFL_API_KEY secret (wrangler secret put BFL_API_KEY).");

  const submit = await fetch(FLUX_FILL_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", "x-key": apiKey },
    body: JSON.stringify({
      prompt,
      image: imageBase64,
      mask: maskBase64,
      guidance,
      ...(seed === undefined ? {} : { seed }),
      output_format: "png",
      safety_tolerance: 2,
    }),
    signal,
  });
  if (!submit.ok) {
    const detail = (await submit.text()).slice(0, 300);
    throw new Error(`FLUX submit failed (${submit.status}): ${detail || "no detail"}`);
  }
  const task = await submit.json() as FluxSubmitResponse;
  if (!task.polling_url) throw new Error("FLUX did not return a polling URL.");

  const deadline = Date.now() + FLUX_POLL_TIMEOUT_MS;
  for (;;) {
    if (signal.aborted) throw new Error("The FLUX request was cancelled.");
    if (Date.now() > deadline) throw new Error("FLUX timed out after 120s. Try again.");
    await new Promise((resolve) => setTimeout(resolve, FLUX_POLL_INTERVAL_MS));

    const poll = await fetch(task.polling_url, { headers: { "x-key": apiKey }, signal });
    if (!poll.ok) throw new Error(`FLUX polling failed (${poll.status}).`);
    const state = await poll.json() as FluxPollResponse;
    const status = state.status || "";
    if (status === "Pending") continue;
    if (status === "Ready") {
      const sampleUrl = state.result?.sample;
      if (!sampleUrl) throw new Error("FLUX reported Ready without an image URL.");
      const image = await fetch(sampleUrl, { signal });
      if (!image.ok) throw new Error(`Could not download the FLUX result (${image.status}).`);
      return bytesToBase64(new Uint8Array(await image.arrayBuffer()));
    }
    if (/moderated/i.test(status)) {
      throw new Error("FLUX moderated this request. Adjust the prompt or region and try again.");
    }
    throw new Error(`FLUX request ${status || "failed"}. Try again.`);
  }
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

    if (payload.engine === "flux-fill") {
      // BFL's Fill API takes base64 image+mask (same white-= repaint
      // convention as SD inpainting) and preserves the input dimensions, so
      // width/height are validation-only here.
      const guidance = validatedGuidance(payload.guidance);
      const seed = validatedSeed(payload.seed);
      const imageBase64 = await runFluxFill(
        prompt,
        bytesToBase64(new Uint8Array(await image.arrayBuffer())),
        bytesToBase64(new Uint8Array(await mask.arrayBuffer())),
        guidance,
        seed,
        request.signal,
      );
      return Response.json({
        ok: true,
        images: [imageBase64],
        mimeType: "image/png",
        size: `${width}x${height}`,
        retryable: false,
        diagnostics: { model: "flux-pro-1.0-fill", transport: "bfl-api", width, height, guidance, seed },
      });
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
