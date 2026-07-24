/* eslint-disable @next/next/no-img-element */
"use client";

import { useEdges, useNodes } from "@xyflow/react";
import { memo, useMemo } from "react";
import { useWorkbenchStore } from "../store";
import styles from "../workbench.module.css";
import type { WorkbenchNode } from "../types";
import { NodeShell, type WorkbenchNodeProps } from "./shared";

export const Component = memo(function CompareNode({ id, data }: WorkbenchNodeProps) {
  const updateParams = useWorkbenchStore((state) => state.updateParams);
  const nodes = useNodes<WorkbenchNode>();
  const edges = useEdges();
  const [urlA, urlB] = useMemo(() => {
    const pick = (portId: string) => {
      const edge = edges.find((candidate) => candidate.target === id && candidate.targetHandle === portId);
      if (!edge) return undefined;
      const source = nodes.find((candidate) => candidate.id === edge.source);
      const run = source?.data.runs[source.data.activeRun];
      const value = run?.values[0]?.find((entry) => entry.kind === "image");
      return value && value.kind === "image" ? value.url : undefined;
    };
    return [pick("a"), pick("b")];
  }, [edges, nodes, id]);
  const split = data.params.split ?? 50;

  return (
    <NodeShell data={data}>
      {urlA && urlB ? (
        <>
          <figure className={styles.compare}>
            <img src={urlA} alt="A" draggable={false} />
            <img src={urlB} alt="B" draggable={false} style={{ clipPath: `inset(0 0 0 ${split}%)` }} />
            <span className={styles.compareLine} style={{ left: `${split}%` }} />
          </figure>
          <input
            className={`${styles.slider} nodrag`}
            type="range"
            min={0}
            max={100}
            value={split}
            onChange={(event) => updateParams(id, { split: Number(event.target.value) })}
          />
        </>
      ) : (
        <p className={styles.hint}>Connect two images to compare.</p>
      )}
    </NodeShell>
  );
});
