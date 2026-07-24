"use client";

import { useEdges, useNodes } from "@xyflow/react";
import { memo, useMemo } from "react";
import { readApiResponse } from "@/app/lib/api-client";
import { downscaleForReview, fileToBase64 } from "@/app/lib/image-transport";
import { useWorkbenchStore } from "../store";
import styles from "../workbench.module.css";
import type { ExecuteContext, NodeOutputValue, ReferenceItem, ReportResult, WorkbenchNode } from "../types";
import { fileFromCacheKey, NodeShell, RunFooter, useConnectedImageCount, type WorkbenchNodeProps } from "./shared";

// Maps the node's domain param (shared with promptBuilder) to the accuracy
// review lib's domain strings (app/lib/accuracy-review.ts). Kept local to the
// client bundle so it never imports the server-side review lib's types.
const REVIEW_DOMAIN: Record<string, string> = {
  interior: "interior render",
  exterior: "exterior render",
  collage: "material collage",
};

type ReviewResponse = {
  ok: boolean;
  passed: boolean;
  score: number;
  findings: string[];
  recommendation: string;
  items: Array<{ id: string; passed: boolean; finding: string; box?: [number, number, number, number] }>;
};

function isReferencesValue(value: NodeOutputValue): value is Extract<NodeOutputValue, { kind: "references" }> {
  return value.kind === "references";
}

function orderedReferenceItems(value: Extract<NodeOutputValue, { kind: "references" }>): ReferenceItem[] {
  const byId = new Map(value.items.map((item) => [item.id, item]));
  const orderedIds = value.order.length ? value.order : value.items.map((item) => item.id);
  const seen = new Set<string>();
  const items: ReferenceItem[] = [];
  for (const id of orderedIds) {
    if (seen.has(id)) continue;
    const item = byId.get(id);
    if (!item || !item.imageKeys.length) continue;
    seen.add(id);
    items.push(item);
  }
  return items;
}

export const Component = memo(function AccuracyReviewerNode({ id, data }: WorkbenchNodeProps) {
  const updateParams = useWorkbenchStore((state) => state.updateParams);
  const inputImages = useConnectedImageCount(id, ["image", "references"]);
  const nodes = useNodes<WorkbenchNode>();
  const edges = useEdges();

  const referenceItems = useMemo(() => {
    const edge = edges.find((candidate) => candidate.target === id && candidate.targetHandle === "references");
    if (!edge) return [] as ReferenceItem[];
    const source = nodes.find((candidate) => candidate.id === edge.source);
    const run = source?.data.runs[source.data.activeRun];
    const value = run?.values[0]?.find(isReferencesValue);
    return value ? orderedReferenceItems(value) : [];
  }, [edges, nodes, id]);

  const selectedItemIds = data.params.selectedItemIds ?? [];
  const toggleItem = (itemId: string) => {
    const set = new Set(selectedItemIds);
    if (set.has(itemId)) set.delete(itemId); else set.add(itemId);
    updateParams(id, { selectedItemIds: Array.from(set) });
  };

  const run = data.runs[data.activeRun];
  const report = run?.values[0]?.find((value) => value.kind === "report");
  const reportResult = report && report.kind === "report" ? report.result : undefined;

  return (
    <NodeShell data={data} footer={<RunFooter id={id} data={data} inputImages={inputImages} />}>
      <label className={styles.field}>
        <span>Domain</span>
        <select
          className="nodrag"
          value={data.params.domain ?? "interior"}
          onChange={(event) => updateParams(id, { domain: event.target.value as "interior" | "exterior" | "collage" })}
        >
          <option value="interior">Interior</option>
          <option value="exterior">Exterior</option>
          <option value="collage">Collage</option>
        </select>
      </label>
      {referenceItems.length > 0 && (
        <fieldset className={styles.field}>
          <legend>Score only (optional)</legend>
          {referenceItems.map((item) => (
            <label key={item.id} className={styles.checkboxRow}>
              <input
                className="nodrag"
                type="checkbox"
                checked={selectedItemIds.includes(item.id)}
                onChange={() => toggleItem(item.id)}
              />
              <span>{item.role || item.id}</span>
            </label>
          ))}
        </fieldset>
      )}
      {reportResult ? (
        <div className={styles.hint}>
          <p>{reportResult.passed ? "Passed" : "Findings"} · score {reportResult.score}</p>
          {reportResult.findings.slice(0, 3).map((finding, index) => <p key={index}>{finding}</p>)}
        </div>
      ) : (
        <p className={styles.hint}>Reviews a generated image against its reference items.</p>
      )}
    </NodeShell>
  );
});

// DOM-touching execute wrapper: reads the base image + reference item images
// out of the blob cache, downscales all of them (review is layout/box-
// oriented, not pixel-detail — see app/lib/image-transport.ts), and posts to
// POST /api/workbench/review as JSON.
export const execute = async (ctx: ExecuteContext): Promise<void> => {
  const imageValue = ctx.inputs("image").find((value): value is Extract<NodeOutputValue, { kind: "image" }> => value.kind === "image");
  if (!imageValue) throw new Error("Connect the generated image to review.");

  const referencesValue = ctx.inputs("references").find(isReferencesValue);
  if (!referencesValue) throw new Error("Connect a References node with at least one item to review against.");
  const items = orderedReferenceItems(referencesValue);
  if (!items.length) throw new Error("The connected References node has no uploaded images yet.");

  const selectedItemIds = (ctx.params.selectedItemIds ?? []).filter((itemId) => items.some((item) => item.id === itemId));

  ctx.setProgress("Downscaling images…");
  const reviewedImageFile = fileFromCacheKey(imageValue.cacheKey);
  const imageBase64 = await fileToBase64(await downscaleForReview(reviewedImageFile));

  const references: Array<{ imageBase64: string; mimeType: string }> = [];
  for (const item of items) {
    for (const key of item.imageKeys) {
      const file = fileFromCacheKey(key);
      const downscaled = await downscaleForReview(file);
      references.push({ imageBase64: await fileToBase64(downscaled), mimeType: "image/jpeg" });
    }
  }
  if (references.length > 16) throw new Error("Use no more than 16 reference images in one review.");

  const domain = REVIEW_DOMAIN[String(ctx.params.domain ?? "interior")] ?? "interior render";

  ctx.setProgress("Reviewing…");
  const response = await fetch("/api/workbench/review", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: ctx.signal,
    body: JSON.stringify({
      imageBase64,
      items: items.map((item) => ({ id: item.id, role: item.role, referenceCount: item.imageKeys.length })),
      selectedItemIds,
      references,
      domain,
    }),
  }).then((value) => readApiResponse<ReviewResponse>(value));

  const result: ReportResult = {
    passed: response.passed,
    score: response.score,
    findings: response.findings,
    recommendation: response.recommendation,
    items: response.items.map((item) => ({
      id: item.id,
      passed: item.passed,
      score: response.score,
      findings: item.finding ? [item.finding] : [],
      ...(item.box ? { box: item.box } : {}),
    })),
  };

  ctx.applyRun({
    runId: ctx.createRunId(),
    signature: ctx.signature,
    at: Date.now(),
    values: [[{ kind: "report", result }]],
  });
};
