"use client";

import { memo } from "react";
import { useWorkbenchStore } from "../store";
import styles from "../workbench.module.css";
import { NodeShell, type WorkbenchNodeProps } from "./shared";

export const Component = memo(function PromptBuilderNode({ id, data }: WorkbenchNodeProps) {
  const updateParams = useWorkbenchStore((state) => state.updateParams);
  return (
    <NodeShell data={data}>
      <label className={styles.field}>
        <span>Domain</span>
        <select className="nodrag" value={data.params.domain} onChange={(event) => updateParams(id, { domain: event.target.value as "interior" | "exterior" | "collage" })}>
          <option value="interior">Interior render</option>
          <option value="exterior">Exterior render</option>
          <option value="collage">Material collage</option>
        </select>
      </label>
      <label className={styles.field}>
        <span>Lighting</span>
        <input className="nodrag" type="text" value={data.params.lighting ?? ""} onChange={(event) => updateParams(id, { lighting: event.target.value })} placeholder="soft daylight, golden hour…" />
      </label>
      <label className={styles.field}>
        <span>Style</span>
        <input className="nodrag" type="text" value={data.params.styleDirection ?? ""} onChange={(event) => updateParams(id, { styleDirection: event.target.value })} placeholder="photorealistic, editorial…" />
      </label>
      <label className={styles.field}>
        <span>Direction</span>
        <textarea className={`${styles.textarea} nodrag nowheel`} rows={2} value={data.params.extraDirection ?? ""} onChange={(event) => updateParams(id, { extraDirection: event.target.value })} placeholder="Optional extra art direction…" />
      </label>
    </NodeShell>
  );
});
