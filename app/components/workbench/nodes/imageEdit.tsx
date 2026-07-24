"use client";

import { memo } from "react";
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
  const inputImages = useConnectedImageCount(id, ["image", "references"]);
  return (
    <NodeShell data={data} footer={<RunFooter id={id} data={data} inputImages={inputImages} />}>
      <GenerationSettings id={id} data={data} />
      <OutputPreview id={id} data={data} />
    </NodeShell>
  );
});

// DOM-touching execute wrapper (blob cache, object URLs, reference transport)
// composing the manifest's pure request/response core; requires the base
// image input on top of the shared generation flow.
export const execute = (ctx: ExecuteContext): Promise<void> => executeGeneration(ctx, { requireBaseImage: true });
