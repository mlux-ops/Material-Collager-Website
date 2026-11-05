"use client";

import { memo } from "react";
import { useWorkbenchStore } from "../store";
import styles from "../workbench.module.css";
import type { ExecuteContext } from "../types";
import { CLI_EFFORTS } from "./cliAssistant.manifest";
import { healthHint, runBridge, useBridgeHealth } from "./cliAssistant";
import { PROMPT_EXPERT_MODEL, PROMPT_EXPERT_PERSONA, PROMPT_EXPERT_PROVIDER } from "./promptExpert.manifest";
import { NodeShell, RunFooter, useConnectedImageCount, type WorkbenchNodeProps } from "./shared";

const MODEL_HINT = `${PROMPT_EXPERT_MODEL} via the codex CLI, grounded in the GPT Image 2.6 prompting guide. Default effort is the model's own (low).`;

export const Component = memo(function PromptExpertNode({ id, data }: WorkbenchNodeProps) {
  const updateParams = useWorkbenchStore((state) => state.updateParams);
  const inputImages = useConnectedImageCount(id, ["image"]);
  const health = useBridgeHealth(data.status);
  const run = data.runs[data.activeRun];
  const prompt = run?.values[0]?.find((value) => value.kind === "text");
  const hint = healthHint(health, PROMPT_EXPERT_PROVIDER);
  return (
    <NodeShell data={data} footer={<RunFooter id={id} data={data} inputImages={inputImages} />}>
      <label className={styles.field}>
        <span>Effort</span>
        <select
          className="nodrag"
          value={data.params.effort ?? "default"}
          onChange={(event) => updateParams(id, { effort: event.target.value })}
        >
          {CLI_EFFORTS.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      </label>
      <textarea
        className={`${styles.textarea} nodrag nowheel`}
        rows={3}
        placeholder="Describe the image you want…"
        value={data.params.instruction ?? ""}
        onChange={(event) => updateParams(id, { instruction: event.target.value })}
      />
      <p className={styles.hint}>{MODEL_HINT}</p>
      {hint && <p className={styles.hint}>{hint}</p>}
      {prompt && prompt.kind === "text" && (
        <p className={styles.hint} style={{ whiteSpace: "pre-wrap" }}>{prompt.text}</p>
      )}
    </NodeShell>
  );
});

// Tells the model how many images are wired, so it numbers them Image 1..N
// in the same order the bridge attaches them.
function withImageCount(instruction: string, imageCount: number): string {
  if (imageCount === 0) return `${instruction}\n\nConnected images: none.`;
  const range = imageCount === 1 ? "Image 1" : `Image 1 to Image ${imageCount}`;
  return `${instruction}\n\nConnected images: ${imageCount} (${range}, in wire order).`;
}

export async function execute(ctx: ExecuteContext): Promise<void> {
  const requestedEffort = String(ctx.params.effort ?? "").trim();
  const effort = CLI_EFFORTS.find((entry) => entry === requestedEffort) ?? "default";
  await runBridge(ctx, {
    provider: PROMPT_EXPERT_PROVIDER,
    model: PROMPT_EXPERT_MODEL,
    effort,
    persona: PROMPT_EXPERT_PERSONA,
    progress: "Writing the prompt…",
    finishInstruction: withImageCount,
  });
}
