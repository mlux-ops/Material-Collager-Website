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

// Same edit-shaped request as imageEdit (image + prompt over
// /api/workbench/edit); the prompt itself carries the relighting-specific
// instruction, so the node reuses generation.ts's pure core unchanged.
export const Component = memo(function RelightNode({ id, data }: WorkbenchNodeProps) {
  const inputImages = useConnectedImageCount(id, ["image"]);
  return (
    <NodeShell data={data} footer={<RunFooter id={id} data={data} inputImages={inputImages} />}>
      <GenerationSettings id={id} data={data} />
      <OutputPreview id={id} data={data} />
    </NodeShell>
  );
});

// DOM-touching execute wrapper composing the shared generation execute core;
// requires the base image input like imageEdit.
export const execute = (ctx: ExecuteContext): Promise<void> => executeGeneration(ctx, { requireBaseImage: true });
