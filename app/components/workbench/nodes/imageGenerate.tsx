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
  const inputImages = useConnectedImageCount(id, ["references"]);
  return (
    <NodeShell data={data} footer={<RunFooter id={id} data={data} inputImages={inputImages} />}>
      <GenerationSettings id={id} data={data} inputPortId="size" />
      <p className={styles.hint}>
        Size input: connect an image (a Crop’s output, for example) and choose “Match input image” to render at its exact pixel size. It is never sent to the model. Image Reference inputs guide the render and are billed as input images.
      </p>
      <OutputPreview id={id} data={data} />
    </NodeShell>
  );
});

// DOM-touching execute wrapper (blob cache, object URLs, reference transport)
// composing the manifest's pure request/response core.
export const execute = (ctx: ExecuteContext): Promise<void> => executeGeneration(ctx, { requireBaseImage: false });
