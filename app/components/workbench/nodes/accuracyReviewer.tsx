"use client";

import { useEdges, useNodes } from "@xyflow/react";
import { memo, useMemo } from "react";
import { readApiResponse } from "@/app/lib/api-client";
import { MAX_REFERENCE_IMAGES } from "@/app/lib/collage";
import { downscaleForReview, fileToBase64 } from "@/app/lib/image-transport";
import { useWorkbenchStore } from "../store";
import styles from "../workbench.module.css";
import type { ExecuteContext, NodeOutputValue, ReportResult, WorkbenchNode } from "../types";
import { referenceItemsFromValues } from "./generation";
import { specFor } from "./manifests";
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

// The references port is multi and accepts plain images alongside References
// bundles — referenceItemsFromValues (shared with Collage Board) flattens the
// mixed inputs into one ordered item list, synthesizing a one-image item per
// plain image output.

export const Component = memo(function AccuracyReviewerNode({ id, data }: WorkbenchNodeProps) {
  const updateParams = useWorkbenchStore((state) => state.updateParams);
  const inputImages = useConnectedImageCount(id, ["image", "references"]);
  const nodes = useNodes<WorkbenchNode>();
  const edges = useEdges();

  const referenceItems = useMemo(() => {
    // Mirror the executor's input gathering (executor.ts inputValues): every
    // edge into the references port in edge order, resolving each edge's
    // source output port and taking its FIRST candidate — so the "Score
    // only" checkboxes always list exactly what a run would review against.
    const values: NodeOutputValue[] = [];
    for (const edge of edges) {
      if (edge.target !== id || edge.targetHandle !== "references") continue;
      const source = nodes.find((candidate) => candidate.id === edge.source);
      if (!source) continue;
      const run = source.data.runs[source.data.activeRun];
      if (!run) continue;
      const outputs = specFor(source.data.kind).outputs;
      const portIndex = outputs.findIndex((port) => port.id === edge.sourceHandle);
      const first = (run.values[portIndex >= 0 ? portIndex : 0] ?? [])[0];
      if (first) values.push(first);
    }
    return referenceItemsFromValues(values);
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

  const items = referenceItemsFromValues(ctx.inputs("references"));
  if (!items.length) throw new Error("Connect at least one image or References node to review against.");

  const selectedItemIds = (ctx.params.selectedItemIds ?? []).filter((itemId) => items.some((item) => item.id === itemId));

  ctx.setProgress("Downscaling images…");
  const reviewedImageFile = fileFromCacheKey(imageValue.cacheKey);
  const imageBase64 = await fileToBase64(await downscaleForReview(reviewedImageFile));

  // issue-1: the canonical contract (app/lib/accuracy-review.ts's
  // reviewGeneratedImage + app/api/workbench/review/route.ts's validation)
  // is that `references` carries images for ONLY the reviewed subset: both
  // build `reviewedItems`/`referenceItems` as `selectedIds.size ? items
  // .filter(item => selectedIds.has(item.id)) : items` (board order,
  // filtered to selected -- never reordered by selectedItemIds' own order),
  // and require `references.length` to equal exactly the SUM of THAT
  // subset's referenceCounts. `items` (the full board list) still goes to
  // the server unchanged -- the route needs the complete list for its
  // schema's minItems/maxItems -- only the actual reference IMAGE BYTES are
  // scoped to the reviewed subset.
  const selectedIdSet = new Set(selectedItemIds);
  const reviewedItems = selectedIdSet.size ? items.filter((item) => selectedIdSet.has(item.id)) : items;

  const references: Array<{ imageBase64: string; mimeType: string }> = [];
  for (const item of reviewedItems) {
    for (const key of item.imageKeys) {
      const file = fileFromCacheKey(key);
      const downscaled = await downscaleForReview(file);
      references.push({ imageBase64: await fileToBase64(downscaled), mimeType: "image/jpeg" });
    }
  }
  // N-11: import the SAME constant the route enforces its (now
  // subset-scoped) cap with, rather than a hardcoded literal that could
  // silently drift from it.
  if (references.length > MAX_REFERENCE_IMAGES) {
    throw new Error(`Use no more than ${MAX_REFERENCE_IMAGES} reference images in one review.`);
  }

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
