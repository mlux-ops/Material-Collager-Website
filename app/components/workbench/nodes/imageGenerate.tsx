"use client";

import { memo } from "react";
import styles from "../workbench.module.css";
import type { ExecuteContext } from "../types";
import {
  executeGeneration,
  GenerationSettings,
  NodeShell,
  OutputPreview,
  RunFooter,
  useConnectedImageCount,
  type WorkbenchNodeProps,
} from "./shared";

export const Component = memo(function ImageGenerateNode({ id, data }: WorkbenchNodeProps) {
  const inputImages = useConnectedImageCount(id, ["image", "references"]);
  return (
    <NodeShell data={data} footer={<RunFooter id={id} data={data} inputImages={inputImages} />}>
      <GenerationSettings id={id} data={data} inputPortId="image" />
      <p className={styles.hint}>
        Optional Image input: choose “Match input image” to render at its exact size (a Crop’s output, for example); it is also sent first, at full quality, as the lead reference.
      </p>
      <OutputPreview id={id} data={data} />
    </NodeShell>
  );
});

// DOM-touching execute wrapper (blob cache, object URLs, reference transport)
// composing the manifest's pure request/response core.
export const execute = (ctx: ExecuteContext): Promise<void> => executeGeneration(ctx, { requireBaseImage: false });
