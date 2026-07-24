"use client";

import { memo } from "react";
import { readApiResponse } from "@/app/lib/api-client";
import { useWorkbenchStore } from "../store";
import styles from "../workbench.module.css";
import type { ExecuteContext } from "../types";
import type { ReferenceAnalysis } from "./referenceAnalyzer.manifest";
import { blobFromImageValue, NodeShell, RunFooter, useConnectedImageCount, type WorkbenchNodeProps } from "./shared";

function AnalysisRow({ label, field }: { label: string; field: { value: string; confidence: number } }) {
  if (!field.value) return null;
  return (
    <p className={styles.hint} style={{ margin: 0 }}>
      <strong>{label}:</strong> {field.value} <em>({field.confidence}%)</em>
    </p>
  );
}

export const Component = memo(function ReferenceAnalyzerNode({ id, data }: WorkbenchNodeProps) {
  const updateParams = useWorkbenchStore((state) => state.updateParams);
  const inputImages = useConnectedImageCount(id, ["image"]);
  const analysis = data.runs[data.activeRun]?.usage?.analysis as ReferenceAnalysis | undefined;

  return (
    <NodeShell data={data} footer={<RunFooter id={id} data={data} inputImages={inputImages} />}>
      <label className={styles.field}>
        <span>Item type</span>
        <input
          className="nodrag"
          type="text"
          placeholder="e.g. kitchen faucet"
          value={data.params.itemType ?? ""}
          onChange={(event) => updateParams(id, { itemType: event.target.value })}
        />
      </label>
      {analysis ? (
        <div className={styles.nodeBody} style={{ padding: 0 }}>
          <AnalysisRow label="Type" field={analysis.itemType} />
          <AnalysisRow label="Brand" field={analysis.brand} />
          <AnalysisRow label="Product" field={analysis.product} />
          <AnalysisRow label="Finish" field={analysis.finish} />
          <AnalysisRow label="Notes" field={analysis.notes} />
          {analysis.searchQuery && (
            <p className={styles.hint} style={{ margin: 0 }}><strong>Search query:</strong> {analysis.searchQuery}</p>
          )}
        </div>
      ) : (
        <p className={styles.hint}>Analyzes a reference photo for brand/product/finish.</p>
      )}
    </NodeShell>
  );
});

// DOM-touching execute wrapper: reads the connected image out of the blob
// cache and posts it (unchanged POST /api/references/analyze contract).
export const execute = async (ctx: ExecuteContext): Promise<void> => {
  const images = ctx.inputs("image");
  if (!images.length) throw new Error("Connect an image to analyze.");
  const file = await blobFromImageValue(images[0]);

  const form = new FormData();
  form.append("image", file, file.name);
  form.append("itemType", ctx.params.itemType || "");

  ctx.setProgress("Analyzing…");
  const response = await fetch("/api/references/analyze", { method: "POST", body: form, signal: ctx.signal })
    .then((value) => readApiResponse<{ ok: boolean; error?: string; analysis: ReferenceAnalysis }>(value));

  ctx.applyRun({
    runId: ctx.createRunId(),
    signature: ctx.signature,
    at: Date.now(),
    values: [[{ kind: "text", text: response.analysis.searchQuery }]],
    usage: { analysis: response.analysis },
  });
};
