"use client";

import { useEdges, useNodes } from "@xyflow/react";
import { memo, useMemo } from "react";
import { useWorkbenchStore } from "../store";
import styles from "../workbench.module.css";
import type { WorkbenchNode } from "../types";
import { NodeShell, ThumbnailImage, type WorkbenchNodeProps } from "./shared";

export const Component = memo(function CompareNode({ id, data }: WorkbenchNodeProps) {
  const updateParams = useWorkbenchStore((state) => state.updateParams);
  const nodes = useNodes<WorkbenchNode>();
  const edges = useEdges();
  // N-8: Compare was the one card preview issue-4 (round 3) did not convert
  // -- it read value.url (the full-resolution object URL) and rendered TWO
  // raw <img> elements at once, which is the worst case for AC20's "node
  // cards never hold a full-res bitmap" clause (Compare is by definition
  // wired to two image outputs, typically the largest artifacts on the
  // canvas). The split-slider clip-path is a percentage operation, so
  // swapping to cacheKey-driven thumbnails changes nothing about the maths.
  const [keyA, keyB] = useMemo(() => {
    const pick = (portId: string) => {
      const edge = edges.find((candidate) => candidate.target === id && candidate.targetHandle === portId);
      if (!edge) return undefined;
      const source = nodes.find((candidate) => candidate.id === edge.source);
      const run = source?.data.runs[source.data.activeRun];
      const value = run?.values[0]?.find((entry) => entry.kind === "image");
      return value && value.kind === "image" ? value.cacheKey : undefined;
    };
    return [pick("a"), pick("b")];
  }, [edges, nodes, id]);
  const split = data.params.split ?? 50;

  return (
    <NodeShell data={data}>
      {keyA && keyB ? (
        <>
          <figure className={styles.compare}>
            <ThumbnailImage cacheKey={keyA} alt="A" width={256} height={192} />
            <ThumbnailImage
              cacheKey={keyB}
              alt="B"
              width={256}
              height={192}
              className={styles.compareOverlay}
              style={{ clipPath: `inset(0 0 0 ${split}%)` }}
            />
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
