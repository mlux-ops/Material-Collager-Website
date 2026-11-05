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

export const Component = memo(function ImageEditNode({ id, data }: WorkbenchNodeProps) {
  const inputImages = useConnectedImageCount(id, ["image", "references", "markup"]);
  return (
    <NodeShell data={data} footer={<RunFooter id={id} data={data} inputImages={inputImages} />}>
      <GenerationSettings id={id} data={data} inputPortId="image" />
      <p className={styles.hint}>
        Markup input (optional): a transparent PNG exactly the size of Image, with a circle or arrows drawn where the change goes. In the prompt, say what to change inside the mark and to remove the mark from the result, e.g. “Recolor the vase inside the red circle to matte black. Remove the red circle.” It can’t be combined with a mask.
      </p>
      <OutputPreview id={id} data={data} />
    </NodeShell>
  );
});

// DOM-touching execute wrapper (blob cache, object URLs, reference transport)
// composing the manifest's pure request/response core; requires the base
// image input on top of the shared generation flow, plus the optional Markup
// layer (sent as the edit's `markup` file after a browser-side size and
// transparency check).
export const execute = (ctx: ExecuteContext): Promise<void> =>
  executeGeneration(ctx, { requireBaseImage: true, markup: true });
