"use client";

import { memo } from "react";
import { readApiResponse } from "@/app/lib/api-client";
import { fileToBase64 } from "@/app/lib/image-transport";
import { useWorkbenchStore } from "../store";
import styles from "../workbench.module.css";
import type { ExecuteContext } from "../types";
import { AI_ASSISTANT_DEFAULT_MODEL, AI_ASSISTANT_MODELS } from "./aiAssistant.manifest";
import { IMAGE_DESCRIPTION_INSTRUCTION } from "./imageDescription.manifest";
import {
  blobFromImageValue,
  NodeShell,
  RunFooter,
  useConnectedImageCount,
  type WorkbenchNodeProps,
} from "./shared";

export const Component = memo(function ImageDescriptionNode({ id, data }: WorkbenchNodeProps) {
  const updateParams = useWorkbenchStore((state) => state.updateParams);
  const updateTextOutput = useWorkbenchStore((state) => state.updateTextOutput);
  const inputImages = useConnectedImageCount(id, ["image"]);
  const description = data.runs[data.activeRun]?.values[0]?.find((value) => value.kind === "text");

  return (
    <NodeShell data={data} footer={<RunFooter id={id} data={data} inputImages={inputImages} />}>
      <label className={styles.field}>
        <span>Vision model</span>
        <select
          className="nodrag"
          value={data.params.model ?? AI_ASSISTANT_DEFAULT_MODEL}
          onChange={(event) => updateParams(id, { model: event.target.value })}
        >
          {AI_ASSISTANT_MODELS.map((model) => <option key={model} value={model}>{model}</option>)}
        </select>
      </label>
      <label className={styles.field}>
        <span>Editable description</span>
        <textarea
          className={`${styles.textarea} nodrag nowheel`}
          rows={8}
          placeholder="Run the node to describe the connected image."
          value={description?.kind === "text" ? description.text : ""}
          disabled={!description}
          onChange={(event) => updateTextOutput(id, "description", event.target.value)}
        />
      </label>
      <p className={styles.hint}>Focused on lighting, materiality, and organization. Edit the result before connecting it downstream.</p>
    </NodeShell>
  );
});

export async function execute(ctx: ExecuteContext): Promise<void> {
  const image = ctx.inputs("image")[0];
  if (!image || image.kind !== "image") throw new Error("Connect an image to describe.");

  const file = await blobFromImageValue(image);
  const requestedModel = String(ctx.params.model ?? "").trim();
  const model = AI_ASSISTANT_MODELS.find((entry) => entry === requestedModel) ?? AI_ASSISTANT_DEFAULT_MODEL;

  ctx.setProgress("Describing image…");
  const response = await fetch("/api/workbench/assist", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: ctx.signal,
    body: JSON.stringify({
      model,
      instruction: IMAGE_DESCRIPTION_INSTRUCTION,
      images: [{ imageBase64: await fileToBase64(file), mimeType: file.type || "image/png" }],
    }),
  }).then((value) => readApiResponse<{ ok: boolean; text: string }>(value));

  ctx.applyRun({
    runId: ctx.createRunId(),
    signature: ctx.signature,
    at: Date.now(),
    values: [[{ kind: "text", text: response.text }]],
    usage: { model },
  });
}
