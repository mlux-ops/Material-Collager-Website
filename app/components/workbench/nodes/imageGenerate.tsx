"use client";

import { memo } from "react";
import styles from "../workbench.module.css";
import type { ExecuteContext } from "../types";
import { IMAGE_GENERATE_FORMATS } from "./generation";
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
      <GenerationSettings id={id} data={data} inputPortId="size" formats={IMAGE_GENERATE_FORMATS} />
      <p className={styles.hint}>
        Size input: connect an image (a Crop’s output, for example) and choose “Match input image” to render at its exact pixel size. It is never sent to the model. Image Reference inputs guide the render and are billed as input images.
      </p>
      <OutputPreview id={id} data={data} />
    </NodeShell>
  );
});

// DOM-touching execute wrapper (blob cache, object URLs, reference transport)
// composing the manifest's pure request/response core. The only node allowed
// to request SVG or animated GIF output (text-to-image on 2.6).
export const execute = (ctx: ExecuteContext): Promise<void> =>
  executeGeneration(ctx, { requireBaseImage: false, allowVectorAndAnimated: true });
