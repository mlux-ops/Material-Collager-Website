"use client";

import { memo } from "react";
import { TEST_MODEL_2_5 } from "@/app/lib/sunburst";
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

export const Component = memo(function TestNode({ id, data }: WorkbenchNodeProps) {
  const inputImages = useConnectedImageCount(id, ["references"]);
  return (
    <NodeShell data={data} footer={<RunFooter id={id} data={data} inputImages={inputImages} />}>
      {/* No Complexity control: it is a 2.6 setting the 2.5 snapshot does not take. */}
      <GenerationSettings id={id} data={data} inputPortId="size" showComplexity={false} />
      <p className={styles.hint}>
        Renders on {TEST_MODEL_2_5}, the previous model, not 2.6. Size input: connect an image and choose “Match input image” to render at its exact pixel size; it is never sent to the model. Image Reference inputs guide the render and are billed as input images.
      </p>
      <OutputPreview id={id} data={data} />
    </NodeShell>
  );
});

export const execute = (ctx: ExecuteContext): Promise<void> =>
  executeGeneration(ctx, { requireBaseImage: false, model: TEST_MODEL_2_5 });
