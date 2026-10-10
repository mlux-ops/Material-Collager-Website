"use client";

import { useEdges } from "@xyflow/react";
import { memo } from "react";
import { useWorkbenchStore } from "../store";
import styles from "../workbench.module.css";
import { NodeShell, useConnectedText, type WorkbenchNodeProps } from "./shared";

export const Component = memo(function TextNode({ id, data }: WorkbenchNodeProps) {
  const updateParams = useWorkbenchStore((state) => state.updateParams);
  const incoming = useConnectedText(id, "text");
  // Wired, not just "has a value yet": typing into a node whose upstream has
  // not run must still count as an edit, or the first run would overwrite it.
  const connected = useEdges().some((edge) => edge.target === id && edge.targetHandle === "text");
  const edited = data.params.textEdited === true;
  // Incoming text is shown live until the user types over it; after that their
  // own version is kept and a reset puts the incoming text back.
  const showIncoming = incoming !== undefined && !edited;
  return (
    <NodeShell data={data}>
      <textarea
        className={`${styles.textarea} nodrag nowheel`}
        rows={4}
        placeholder="Describe the change, mood, or instruction…"
        value={showIncoming ? incoming : data.params.text ?? ""}
        onChange={(event) => updateParams(id, { text: event.target.value, textEdited: connected })}
      />
      {connected && edited && (
        <button
          type="button"
          className={`nodrag ${styles.smallButton}`}
          onClick={() => updateParams(id, { textEdited: false })}
        >
          Reset to incoming text
        </button>
      )}
    </NodeShell>
  );
});
