"use client";

import { useEdges, useNodes } from "@xyflow/react";
import { memo, useCallback, useMemo, useState } from "react";
import { putBlob } from "../blob-cache";
import { activeRunOf } from "../signature";
import { useWorkbenchStore } from "../store";
import styles from "../workbench.module.css";
import type { ExecuteContext, MaskShape, WorkbenchNode } from "../types";
import {
  canvasToBlob,
  loadInputImage,
  MaskModal,
  shapesAlphaCanvas,
  shapesBounds,
  shapesFromParams,
} from "./maskedEdit";
import { outputValuesFor, specFor } from "./manifests";
import {
  channelCorrection,
  clampPatchFeather,
  featherRadiusPx,
  PATCH_COLOR_MATCH_MIN_SAMPLES,
  PATCH_FEATHER_DEFAULT,
  PATCH_FEATHER_MAX,
  PATCH_FEATHER_MIN,
  resolvePatchFit,
  type PatchFit,
} from "./patch.manifest";
import { NodeShell, OutputPreview, RunFooter, useConnectedImageCount, type WorkbenchNodeProps } from "./shared";

// Resolve the image currently on one input port, for the mask-drawing surface.
// Mirrors maskedEdit's inputImageUrl lookup; execute() re-reads through
// ctx.inputs() regardless, so this only affects what the modal draws over.
function useConnectedImageUrl(id: string, portId: string): string | undefined {
  const edges = useEdges();
  const nodes = useNodes<WorkbenchNode>();
  return useMemo(() => {
    const edge = edges.find((candidate) => candidate.target === id && candidate.targetHandle === portId);
    if (!edge) return undefined;
    const source = nodes.find((candidate) => candidate.id === edge.source);
    const run = source ? activeRunOf(source) : undefined;
    const fallbackPort = source ? specFor(source.data.kind).outputs[0]?.id ?? "" : "";
    const value = source && run
      ? outputValuesFor(source, run, edge.sourceHandle ?? fallbackPort).find((entry) => entry.kind === "image")
      : undefined;
    return value && value.kind === "image" ? value.url : undefined;
  }, [edges, nodes, id, portId]);
}

export const Component = memo(function PatchNode({ id, data }: WorkbenchNodeProps) {
  const updateParams = useWorkbenchStore((state) => state.updateParams);
  const inputImages = useConnectedImageCount(id, ["base", "patch"]);
  const baseUrl = useConnectedImageUrl(id, "base");
  const [modalOpen, setModalOpen] = useState(false);

  const existingShapes = shapesFromParams(data.params);
  const fit = (data.params.patchFit ?? "auto") as PatchFit;

  const applyRegion = useCallback((shapes: MaskShape[]) => {
    setModalOpen(false);
    if (!shapes.length) return;
    const json = JSON.stringify(shapes);
    if (json.length > 39_000) {
      window.alert("The region is too detailed to save. Use fewer or simpler strokes.");
      return;
    }
    const [x, y, width, height] = shapesBounds(shapes);
    updateParams(id, {
      maskShapes: json,
      maskRegionX: x,
      maskRegionY: y,
      maskRegionWidth: width,
      maskRegionHeight: height,
    });
  }, [id, updateParams]);

  return (
    <NodeShell data={data} footer={<RunFooter id={id} data={data} inputImages={inputImages} />}>
      <p className={styles.hint}>
        Grafts the Edited image into the Original inside the drawn region. Everything outside stays bit-identical.
      </p>
      <button type="button" className="nodrag" onClick={() => setModalOpen(true)} disabled={!baseUrl}>
        {existingShapes ? "Edit region…" : "Draw region…"}
      </button>
      {!baseUrl && <p className={styles.hint}>Connect and run the Original input to draw the region.</p>}
      <label className={styles.field}>
        <span>Edited image is</span>
        <select
          className="nodrag"
          value={fit}
          onChange={(event) => updateParams(id, { patchFit: event.target.value as PatchFit })}
        >
          <option value="auto">Auto-detect</option>
          <option value="aligned">A full frame (same framing as the original)</option>
          <option value="region">A crop of the region only</option>
        </select>
      </label>
      <label className={styles.field}>
        <span>Feather (% of short edge)</span>
        <input
          className="nodrag"
          type="number"
          min={PATCH_FEATHER_MIN}
          max={PATCH_FEATHER_MAX}
          step={0.1}
          value={data.params.patchFeather ?? PATCH_FEATHER_DEFAULT}
          onChange={(event) => updateParams(id, { patchFeather: Number(event.target.value) })}
          onBlur={(event) => updateParams(id, { patchFeather: clampPatchFeather(event.target.value) })}
        />
      </label>
      <label className={styles.inlineToggle}>
        <input
          className="nodrag"
          type="checkbox"
          checked={data.params.patchColorMatch ?? true}
          onChange={(event) => updateParams(id, { patchColorMatch: event.target.checked })}
        />
        <span>Match colour to surroundings</span>
      </label>
      <p className={styles.hint}>
        Colour matching measures the exposure and white-balance drift in a ring just outside the region — where both
        images show the same content — and corrects the patch by it. Turn it off when the edit is meant to change the
        overall tone of the region.
      </p>
      <OutputPreview id={id} data={data} />
      {modalOpen && baseUrl && (
        <MaskModal
          imageUrl={baseUrl}
          initialShapes={existingShapes}
          pixelExact
          onCancel={() => setModalOpen(false)}
          onApply={applyRegion}
        />
      )}
    </NodeShell>
  );
});

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

type Rect = { x: number; y: number; width: number; height: number };

// Minimum radius of the ring the colour statistics are read from, so the
// measurement stays possible independently of the composite's feather.
const COLOR_RING_MIN_PX = 12;

// The band of pixels the colour-match statistics are read from: the region's
// bounding box grown by the feather, clamped to the canvas. Sampling this
// instead of the whole frame keeps getImageData off multi-megapixel buffers.
function sampleRect(shapes: MaskShape[], width: number, height: number, pad: number): Rect {
  const [nx, ny, nw, nh] = shapesBounds(shapes);
  const x = Math.max(0, Math.floor((nx / 1000) * width) - pad);
  const y = Math.max(0, Math.floor((ny / 1000) * height) - pad);
  const right = Math.min(width, Math.ceil(((nx + nw) / 1000) * width) + pad);
  const bottom = Math.min(height, Math.ceil(((ny + nh) / 1000) * height) + pad);
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

function canvasOf(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("This browser cannot composite the patch.");
  return [canvas, context];
}

// Per-channel gain/offset that maps the patch's colour statistics onto the
// base's, measured ONLY where both images show the same content: outside the
// hard region but within the feather band (blurred alpha present, hard alpha
// absent). Any difference there is drift the model introduced globally, so
// correcting by it makes the seam vanish. Returns null when the ring is too
// small to measure -- a "region" crop that does not extend past the mask, most
// commonly -- so the caller can composite uncorrected rather than guess.
function measureColorCorrection(
  base: CanvasRenderingContext2D,
  patch: CanvasRenderingContext2D,
  hard: CanvasRenderingContext2D,
  blurred: CanvasRenderingContext2D,
  rect: Rect,
): ReturnType<typeof channelCorrection>[] | null {
  const baseData = base.getImageData(rect.x, rect.y, rect.width, rect.height).data;
  const patchData = patch.getImageData(rect.x, rect.y, rect.width, rect.height).data;
  const hardData = hard.getImageData(rect.x, rect.y, rect.width, rect.height).data;
  const blurredData = blurred.getImageData(rect.x, rect.y, rect.width, rect.height).data;

  const baseSum = [0, 0, 0];
  const baseSquares = [0, 0, 0];
  const patchSum = [0, 0, 0];
  const patchSquares = [0, 0, 0];
  let samples = 0;

  for (let index = 0; index < hardData.length; index += 4) {
    // Outside the drawn shape, inside the feather's reach, and actually
    // covered by the patch image (alpha) -- otherwise there is nothing to
    // compare against.
    if (hardData[index + 3] > 8) continue;
    if (blurredData[index + 3] < 20) continue;
    if (patchData[index + 3] < 250) continue;
    for (let channel = 0; channel < 3; channel += 1) {
      const b = baseData[index + channel];
      const p = patchData[index + channel];
      baseSum[channel] += b;
      baseSquares[channel] += b * b;
      patchSum[channel] += p;
      patchSquares[channel] += p * p;
    }
    samples += 1;
  }

  if (samples < PATCH_COLOR_MATCH_MIN_SAMPLES) return null;

  return [0, 1, 2].map((channel) => {
    const baseMean = baseSum[channel] / samples;
    const patchMean = patchSum[channel] / samples;
    // Variance via E[x^2] - E[x]^2, floored at 0 against float error.
    const baseStd = Math.sqrt(Math.max(0, baseSquares[channel] / samples - baseMean * baseMean));
    const patchStd = Math.sqrt(Math.max(0, patchSquares[channel] / samples - patchMean * patchMean));
    return channelCorrection(baseMean, baseStd, patchMean, patchStd);
  });
}

function applyColorCorrection(
  context: CanvasRenderingContext2D,
  rect: Rect,
  corrections: ReturnType<typeof channelCorrection>[],
): void {
  const image = context.getImageData(rect.x, rect.y, rect.width, rect.height);
  const { data } = image;
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] === 0) continue;
    for (let channel = 0; channel < 3; channel += 1) {
      const { gain, offset } = corrections[channel];
      data[index + channel] = Math.min(255, Math.max(0, Math.round(data[index + channel] * gain + offset)));
    }
  }
  context.putImageData(image, rect.x, rect.y);
}

// Composite the patch into the base through the drawn shapes. The feathered
// blend layer is clipped by the hard shape mask, so no patched pixel can leak
// outside the region no matter how wide the feather is -- the same guarantee
// Masked Edit's own compositor makes.
export async function patchImages(
  baseUrl: string,
  patchUrl: string,
  shapes: MaskShape[],
  options: { fit: PatchFit; featherPercent: number; colorMatch: boolean },
): Promise<{ blob: Blob; fit: "aligned" | "region"; colorMatched: boolean }> {
  const [baseImage, patchImage] = await Promise.all([loadInputImage(baseUrl), loadInputImage(patchUrl)]);
  const width = baseImage.naturalWidth;
  const height = baseImage.naturalHeight;
  if (!width || !height) throw new Error("The Original image has no readable dimensions.");

  const [nx, ny, nw, nh] = shapesBounds(shapes);
  const region = {
    x: (nx / 1000) * width,
    y: (ny / 1000) * height,
    width: Math.max(1, (nw / 1000) * width),
    height: Math.max(1, (nh / 1000) * height),
  };
  const fit = resolvePatchFit(
    options.fit,
    patchImage.naturalWidth / Math.max(1, patchImage.naturalHeight),
    width / height,
    region.width / region.height,
  );

  const [baseCanvas, baseContext] = canvasOf(width, height);
  baseContext.drawImage(baseImage, 0, 0);

  // The patch laid out in the base's coordinate space: stretched over the whole
  // frame when aligned, or drawn into the region's bounding box when it is a
  // crop of just that area.
  const [patchLayer, patchContext] = canvasOf(width, height);
  patchContext.imageSmoothingQuality = "high";
  if (fit === "region") {
    patchContext.drawImage(patchImage, region.x, region.y, region.width, region.height);
  } else {
    patchContext.drawImage(patchImage, 0, 0, width, height);
  }

  const feather = featherRadiusPx(options.featherPercent, width, height);
  const hard = shapesAlphaCanvas(shapes, width, height);
  // Only the readable context is needed here — the colour-match ring tests the
  // hard shape's alpha per pixel; compositing draws from `hard` directly.
  const [, hardContext] = canvasOf(width, height);
  hardContext.drawImage(hard, 0, 0);

  // Blurred alpha, then clipped back to the hard shape: fades the patch in
  // across a band just inside the boundary while leaving everything beyond it
  // untouched.
  const [blend, blendContext] = canvasOf(width, height);
  if (feather > 0) blendContext.filter = `blur(${feather}px)`;
  blendContext.drawImage(hard, 0, 0);
  blendContext.filter = "none";

  let colorMatched = false;
  if (options.colorMatch) {
    // The measurement ring is deliberately NOT the composite's feather band:
    // at feather 0 the blend layer equals the hard shape exactly, leaving no
    // outside pixels to measure, and colour matching would switch itself off
    // precisely when someone asked for a hard edge. Blur a separate copy at a
    // fixed minimum so the ring always exists.
    const ringRadius = Math.max(feather, COLOR_RING_MIN_PX);
    const [, ringContext] = canvasOf(width, height);
    ringContext.filter = `blur(${ringRadius}px)`;
    ringContext.drawImage(hard, 0, 0);
    ringContext.filter = "none";

    const rect = sampleRect(shapes, width, height, ringRadius * 2);
    const corrections = measureColorCorrection(baseContext, patchContext, hardContext, ringContext, rect);
    if (corrections) {
      // Correct the whole patch layer inside the sampled band; only masked
      // pixels survive compositing, and they all fall within it.
      applyColorCorrection(patchContext, rect, corrections);
      colorMatched = true;
    }
  }

  blendContext.globalCompositeOperation = "destination-in";
  blendContext.drawImage(hard, 0, 0);

  patchContext.globalCompositeOperation = "destination-in";
  patchContext.drawImage(blend, 0, 0);

  baseContext.drawImage(patchLayer, 0, 0);
  return { blob: await canvasToBlob(baseCanvas), fit, colorMatched };
}

// DOM-touching execute wrapper. Canvas only — no network request, no cost.
export async function execute(ctx: ExecuteContext): Promise<void> {
  const base = ctx.inputs("base")[0];
  if (!base || base.kind !== "image") throw new Error("Connect the Original image first.");
  const patch = ctx.inputs("patch")[0];
  if (!patch || patch.kind !== "image") throw new Error("Connect the Edited image first.");

  const shapes = shapesFromParams(ctx.params);
  if (!shapes) throw new Error("Draw the region to patch first.");

  ctx.setProgress("Patching region…");
  const { blob, fit, colorMatched } = await patchImages(base.url, patch.url, shapes, {
    fit: (ctx.params.patchFit ?? "auto") as PatchFit,
    featherPercent: clampPatchFeather(ctx.params.patchFeather),
    colorMatch: ctx.params.patchColorMatch ?? true,
  });

  const runId = ctx.createRunId();
  const cacheKey = `${ctx.nodeId}:${runId}:0`;
  const url = putBlob(cacheKey, blob);
  ctx.setProgress(colorMatched ? `Patched (${fit}, colour-matched)` : `Patched (${fit})`);
  ctx.applyRun({
    runId,
    signature: ctx.signature,
    at: Date.now(),
    values: [[{ kind: "image", url, cacheKey }]],
  });
}
