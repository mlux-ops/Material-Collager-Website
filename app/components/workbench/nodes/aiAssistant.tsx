"use client";

import { memo } from "react";
import { readApiResponse } from "@/app/lib/api-client";
import { fileToBase64 } from "@/app/lib/image-transport";
import { useWorkbenchStore } from "../store";
import styles from "../workbench.module.css";
import type { ExecuteContext, NodeOutputValue } from "../types";
import { AI_ASSISTANT_DEFAULT_MODEL, AI_ASSISTANT_MODELS } from "./aiAssistant.manifest";
import { imageCacheKeysFromValue } from "./generation";
import { fileFromCacheKey, NodeShell, RunFooter, useConnectedImageCount, type WorkbenchNodeProps } from "./shared";

// The node's output is a PLAIN Text value (never dangerouslySetInnerHTML) and
// is otherwise consumed like any other node's Text output — this component
// only reads its own run, never the graph, and cannot add/remove nodes or
// edges or mutate other nodes' params/runs.
export const Component = memo(function AiAssistantNode({ id, data }: WorkbenchNodeProps) {
  const updateParams = useWorkbenchStore((state) => state.updateParams);
  const inputImages = useConnectedImageCount(id, ["image"]);
  const run = data.runs[data.activeRun];
  const answer = run?.values[0]?.find((value) => value.kind === "text");
  return (
    <NodeShell data={data} footer={<RunFooter id={id} data={data} inputImages={inputImages} />}>
      <label className={styles.field}>
        <span>Model</span>
        <select
          className="nodrag"
          value={data.params.model ?? AI_ASSISTANT_DEFAULT_MODEL}
          onChange={(event) => updateParams(id, { model: event.target.value })}
        >
          {AI_ASSISTANT_MODELS.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      </label>
      <textarea
        className={`${styles.textarea} nodrag nowheel`}
        rows={3}
        placeholder="Ask a question…"
        value={data.params.instruction ?? ""}
        onChange={(event) => updateParams(id, { instruction: event.target.value })}
      />
      {answer && answer.kind === "text" && (
        <p className={styles.hint} style={{ whiteSpace: "pre-wrap" }}>{answer.text}</p>
      )}
    </NodeShell>
  );
});

// DOM-touching execute wrapper: reads context text/image inputs out of the
// graph and blob cache, then calls the thin server-owned-system-prompt proxy
// at POST /api/workbench/assist. The model is validated against the client
// allowlist before sending, but the route is the sole enforcement point.
export const execute = async (ctx: ExecuteContext): Promise<void> => {
  const instruction = (ctx.params.instruction ?? "").trim();
  if (!instruction) throw new Error("Enter an instruction for the assistant.");

  const requestedModel = String(ctx.params.model ?? "").trim();
  const model = AI_ASSISTANT_MODELS.find((entry) => entry === requestedModel) ?? AI_ASSISTANT_DEFAULT_MODEL;

  const contextText = ctx.inputs("text")
    .filter((value): value is Extract<NodeOutputValue, { kind: "text" }> => value.kind === "text")
    .map((value) => value.text)
    .filter(Boolean)
    .join("\n\n");
  const combinedInstruction = contextText ? `${instruction}\n\nContext:\n${contextText}` : instruction;

  const imageKeys = ctx.inputs("image").flatMap(imageCacheKeysFromValue);
  if (imageKeys.length > 16) throw new Error("Connect at most 16 images to the assistant.");
  const images = await Promise.all(imageKeys.map(async (key) => {
    const file = fileFromCacheKey(key);
    return { imageBase64: await fileToBase64(file), mimeType: file.type || "image/png" };
  }));

  ctx.setProgress("Asking…");
  const response = await fetch("/api/workbench/assist", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: ctx.signal,
    body: JSON.stringify({ model, instruction: combinedInstruction, images }),
  }).then((value) => readApiResponse<{ ok: boolean; text: string }>(value));

  ctx.applyRun({
    runId: ctx.createRunId(),
    signature: ctx.signature,
    at: Date.now(),
    values: [[{ kind: "text", text: response.text }]],
  });
};
