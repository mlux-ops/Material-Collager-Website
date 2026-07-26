"use client";

import { memo } from "react";
import { readApiResponse } from "@/app/lib/api-client";
import {
  activeItems,
  buildGenerationPrompt,
  COLLAGE_TYPES,
  ORIENTATIONS,
  resolvedSize,
  validateCollageRequest,
  type CollageItemInput,
  type CollageRequestInput,
} from "@/app/lib/collage";
import { optimizeReferencesForTransport } from "@/app/lib/image-transport";
import { putBlob } from "../blob-cache";
import { recordUsageCalibration } from "../cost";
import { useWorkbenchStore } from "../store";
import styles from "../workbench.module.css";
import type { ExecuteContext, NodeOutputValue } from "../types";
import { decodeBase64Image, referenceItemsFromValues } from "./generation";
import {
  fileFromCacheKey,
  NodeShell,
  OutputPreview,
  RunFooter,
  useConnectedImageCount,
  type WorkbenchNodeProps,
} from "./shared";

export const Component = memo(function CollageBoardNode({ id, data }: WorkbenchNodeProps) {
  const updateParams = useWorkbenchStore((state) => state.updateParams);
  const inputImages = useConnectedImageCount(id, ["items"]);
  return (
    <NodeShell data={data} footer={<RunFooter id={id} data={data} inputImages={inputImages} />}>
      <label className={styles.field}>
        <span>Collage type</span>
        <select
          className="nodrag"
          value={data.params.collageType ?? "kitchen_material_palette"}
          onChange={(event) => updateParams(id, { collageType: event.target.value })}
        >
          {COLLAGE_TYPES.map((option) => <option key={option} value={option}>{option.replaceAll("_", " ")}</option>)}
        </select>
      </label>
      <label className={styles.field}>
        <span>Orientation</span>
        <select
          className="nodrag"
          value={data.params.orientation ?? "default"}
          onChange={(event) => updateParams(id, { orientation: event.target.value })}
        >
          {ORIENTATIONS.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      </label>
      <label className={styles.field}>
        <span>Quality</span>
        <select
          className="nodrag"
          value={data.params.quality ?? "medium"}
          onChange={(event) => updateParams(id, { quality: event.target.value as "low" | "medium" | "high" })}
        >
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
        </select>
      </label>
      <OutputPreview id={id} data={data} />
    </NodeShell>
  );
});

// Flattens every connected input (in each edge's own order) into one ordered
// CollageItemInput list, reusing the generator's item shape (CollageItemInput
// + buildGenerationPrompt) unchanged. References bundles contribute their
// items; plain image outputs become one-image synthetic items (via the shared
// referenceItemsFromValues normalizer), so a board can be fed straight from
// Photo/Generate nodes without a References node in between.
function itemsFromReferenceValues(values: NodeOutputValue[]): CollageItemInput[] {
  return referenceItemsFromValues(values).map((item) => ({
    id: item.id,
    role: item.role,
    imageKeys: item.imageKeys,
    brand: item.brand,
    name: item.name,
    finish: item.finish,
    notes: item.notes,
    required: item.required,
  }));
}

// DOM-touching execute wrapper: builds a CollageRequestInput from the
// connected References bundles, renders its prompt CLIENT-side via the
// generator's own buildGenerationPrompt, and posts to /api/workbench/edit —
// never /api/generate. QA runs separately via the Accuracy Reviewer node.
export async function execute(ctx: ExecuteContext): Promise<void> {
  const items = itemsFromReferenceValues(ctx.inputs("items"));
  if (!items.length) throw new Error("Connect at least one image or References node with an uploaded item image.");

  const request: CollageRequestInput = {
    collageType: (ctx.params.collageType as CollageRequestInput["collageType"]) || "kitchen_material_palette",
    orientation: (ctx.params.orientation as CollageRequestInput["orientation"]) || "default",
    quality: (ctx.params.quality as CollageRequestInput["quality"]) || "medium",
    outputResolution: ctx.params.outputResolution as CollageRequestInput["outputResolution"],
    items,
  };
  validateCollageRequest(request);

  const prompt = buildGenerationPrompt(request);
  const size = resolvedSize(request);

  const orderedKeys = activeItems(request).flatMap((item) => item.imageKeys ?? []);
  if (!orderedKeys.length) throw new Error("Connected items have no uploaded images.");
  if (orderedKeys.length > 16) throw new Error("A collage can use at most 16 reference images.");

  const files = await optimizeReferencesForTransport(orderedKeys.map(fileFromCacheKey));

  const form = new FormData();
  form.append("payload", JSON.stringify({ prompt, size, quality: request.quality, n: 1 }));
  for (const file of files) form.append("image[]", file, file.name);

  ctx.setProgress("Composing collage…");
  const response = await fetch("/api/workbench/edit", { method: "POST", body: form, signal: ctx.signal })
    .then((value) => readApiResponse<{ ok: boolean; images: string[]; mimeType: string; usage?: Record<string, unknown> }>(value));

  const runId = ctx.createRunId();
  const images: NodeOutputValue[] = response.images.map((base64, index) => {
    const cacheKey = `${ctx.nodeId}:${runId}:${index}`;
    const bytes = decodeBase64Image(base64);
    const cachedUrl = putBlob(cacheKey, new Blob([bytes], { type: response.mimeType || "image/png" }));
    return { kind: "image", url: cachedUrl, cacheKey };
  });
  ctx.applyRun({ runId, signature: ctx.signature, at: Date.now(), values: [images], usage: response.usage });
  recordUsageCalibration(size, request.quality, response.usage, files.length);
}
