"use client";

import { memo } from "react";
import { useWorkbenchStore } from "../store";
import styles from "../workbench.module.css";
import type { WorkbenchNodeProps } from "./shared";

export const Component = memo(function NoteNode({ id, data }: WorkbenchNodeProps) {
  const updateParams = useWorkbenchStore((state) => state.updateParams);
  return (
    <div className={styles.note}>
      <textarea
        className={`${styles.noteText} nodrag nowheel`}
        rows={4}
        placeholder="Note…"
        value={data.params.text ?? ""}
        onChange={(event) => updateParams(id, { text: event.target.value })}
      />
    </div>
  );
});
