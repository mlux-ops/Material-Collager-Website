"use client";

import { memo } from "react";
import { useWorkbenchStore } from "../store";
import styles from "../workbench.module.css";
import { NodeShell, type WorkbenchNodeProps } from "./shared";

export const Component = memo(function TextNode({ id, data }: WorkbenchNodeProps) {
  const updateParams = useWorkbenchStore((state) => state.updateParams);
  return (
    <NodeShell data={data}>
      <textarea
        className={`${styles.textarea} nodrag nowheel`}
        rows={4}
        placeholder="Describe the change, mood, or instruction…"
        value={data.params.text ?? ""}
        onChange={(event) => updateParams(id, { text: event.target.value })}
      />
    </NodeShell>
  );
});
