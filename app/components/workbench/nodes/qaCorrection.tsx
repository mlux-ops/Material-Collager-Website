"use client";

import { useEdges, useNodes } from "@xyflow/react";
import { memo, useMemo } from "react";
import { readApiResponse } from "@/app/lib/api-client";
import { base64ImageToObjectUrl, optimizeReferencesForTransport } from "@/app/lib/image-transport";
import { compositeSelectiveEdit, createSelectiveEditAssets, type QaResult } from "@/app/lib/selective-edit";
import { putBlob } from "../blob-cache";
import styles from "../workbench.module.css";
import type { ExecuteContext, NodeOutputValue, WorkbenchNode } from "../types";
import { fileFromCacheKey, GenerationSettings, NodeShell, OutputPreview, RunFooter, useConnectedImageCount, type WorkbenchNodeProps } from "./shared";
import { imageCacheKeysFromValue } from "./generation";

function isReportValue(value: NodeOutputValue): value is Extract<NodeOutputValue, { kind: "report" }> {
  return value.kind === "report";
}

export const Component = memo(function QaCorrectionNode({ id, data }: WorkbenchNodeProps) {
  const inputImages = useConnectedImageCount(id, ["image", "references"]);
  const nodes = useNodes<WorkbenchNode>();
  const edges = useEdges();

  const failedItemIds = useMemo(() => {
    const edge = edges.find((candidate) => candidate.target === id && candidate.targetHandle === "report");
    if (!edge) return [] as string[];
    const source = nodes.find((candidate) => candidate.id === edge.source);
    const run = source?.data.runs[source.data.activeRun];
    const report = run?.values[0]?.find(isReportValue);
    if (!report) return [];
    return report.result.items.filter((item) => !item.passed).map((item) => item.id);
  }, [edges, nodes, id]);

  return (
    <NodeShell data={data} footer={<RunFooter id={id} data={data} inputImages={inputImages} />}>
      <p className={styles.hint}>
        {failedItemIds.length
          ? `Will correct: ${failedItemIds.join(", ")}`
          : "Connect an Accuracy Reviewer report with at least one failed item."}
      </p>
      <GenerationSettings id={id} data={data} />
      <OutputPreview id={id} data={data} />
    </NodeShell>
  );
});

// DOM-touching execute wrapper: builds the mask from the report's boxes via
// app/lib/selective-edit.ts, posts the masked-repair edit to
// POST /api/workbench/edit, and composites the protected pixels back
// client-side. Reviewer -> QA Correction is an unrolled linear chain
// (connectionIsValid rejects cycles) — no auto-loop happens here.
export const execute = async (ctx: ExecuteContext): Promise<void> => {
  const reportValue = ctx.inputs("report").find(isReportValue);
  if (!reportValue) throw new Error("Connect an Accuracy Reviewer report first.");
  const imageValue = ctx.inputs("image").find((value): value is Extract<NodeOutputValue, { kind: "image" }> => value.kind === "image");
  if (!imageValue) throw new Error("Connect the image to correct.");

  const failedItemIds = reportValue.result.items.filter((item) => !item.passed).map((item) => item.id);
  if (!failedItemIds.length) throw new Error("The connected report has no failed items to correct.");
  const missingBox = reportValue.result.items.some((item) => failedItemIds.includes(item.id) && !item.box);
  if (missingBox) throw new Error("The report could not locate every failed item. Re-run the reviewer first.");

  const feedback: QaResult = {
    passed: reportValue.result.passed,
    score: reportValue.result.score,
    findings: reportValue.result.findings,
    recommendation: reportValue.result.recommendation,
    items: reportValue.result.items.map((item) => ({
      id: item.id,
      passed: item.passed,
      finding: item.findings[0] ?? "",
      box: item.box,
    })),
  };

  ctx.setProgress("Building mask…");
  const assets = await createSelectiveEditAssets({
    feedback,
    itemIds: failedItemIds,
    sourceDataUrl: imageValue.url,
  });

  const files: File[] = [assets.baseFile];
  const references = ctx.inputs("references");
  if (references.length) {
    const rawReferences = references.flatMap(imageCacheKeysFromValue).map(fileFromCacheKey);
    files.push(...(await optimizeReferencesForTransport(rawReferences)));
  }
  if (files.length > 16) throw new Error("A node can send at most 16 images.");

  const findingLines = reportValue.result.items
    .filter((item) => failedItemIds.includes(item.id))
    .map((item) => item.findings[0])
    .filter(Boolean);
  const prompt = [
    "Selectively correct only the flagged items described below; leave every other pixel exactly as it is.",
    ...findingLines,
  ].join("\n");

  const payload = {
    prompt,
    size: ctx.params.size || "1536x1024",
    quality: ctx.params.quality || "medium",
    n: 1,
  };

  const form = new FormData();
  form.append("payload", JSON.stringify(payload));
  for (const file of files) form.append("image[]", file, file.name);
  form.append("mask", assets.maskFile, assets.maskFile.name);

  ctx.setProgress("Correcting…");
  const response = await fetch("/api/workbench/edit", { method: "POST", body: form, signal: ctx.signal })
    .then((value) => readApiResponse<{ ok: boolean; images: string[]; mimeType: string; usage?: Record<string, unknown> }>(value));
  const editedBase64 = response.images[0];
  if (!editedBase64) throw new Error("The correction did not return an image.");
  const editedUrl = base64ImageToObjectUrl(editedBase64, response.mimeType || "image/png");

  ctx.setProgress("Compositing…");
  let compositedUrl: string;
  try {
    compositedUrl = await compositeSelectiveEdit(imageValue.url, editedUrl, assets.boxes, assets.protectedBoxes);
  } finally {
    URL.revokeObjectURL(editedUrl);
  }

  const runId = ctx.createRunId();
  const cacheKey = `${ctx.nodeId}:${runId}:0`;
  const compositedBlob = await fetch(compositedUrl).then((value) => value.blob());
  const cachedUrl = putBlob(cacheKey, compositedBlob);
  URL.revokeObjectURL(compositedUrl);

  ctx.applyRun({
    runId,
    signature: ctx.signature,
    at: Date.now(),
    values: [[{ kind: "image", url: cachedUrl, cacheKey }]],
    usage: response.usage,
  });
};
