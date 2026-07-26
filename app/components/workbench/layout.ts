// Canvas geometry helpers: the "Tidy graph" auto-layout and the drag-time
// alignment guides. Framework-free math over WorkbenchNode positions — no
// layout library dependency; the graph is a small DAG (connectionIsValid
// refuses cycles), so longest-path layering + barycenter ordering is enough.

import type { Edge } from "@xyflow/react";
import type { WorkbenchNode } from "./types";

const GRID = 22;
// Node cards are 232 wide; 232 + 120 gap = 352 = 16 grid cells, so tidied
// columns land exactly on the same snap grid dragging uses.
const COLUMN_STRIDE = 352;
const ROW_GAP = 44;
const FALLBACK_HEIGHT = 220;

const snap = (value: number) => Math.round(value / GRID) * GRID;

// Layered left-to-right layout: a node's column is its longest path from a
// source; rows within a column are ordered by the mean Y of already-placed
// predecessors (falling back to the node's current Y, so the user's rough
// vertical arrangement survives), then stacked and vertically centered.
export function tidyLayout(nodes: WorkbenchNode[], edges: Edge[]): Array<{ id: string; position: { x: number; y: number } }> {
  if (nodes.length < 2) return [];
  const layer = new Map<string, number>(nodes.map((node) => [node.id, 0]));
  // Longest-path relaxation; the graph is acyclic so this settles within
  // |nodes| passes (guarded anyway).
  let guard = nodes.length + 1;
  let changed = true;
  while (changed && guard-- > 0) {
    changed = false;
    for (const edge of edges) {
      if (!layer.has(edge.source) || !layer.has(edge.target)) continue;
      const next = (layer.get(edge.source) ?? 0) + 1;
      if (next > (layer.get(edge.target) ?? 0)) {
        layer.set(edge.target, next);
        changed = true;
      }
    }
  }

  const incoming = new Map<string, string[]>();
  for (const edge of edges) {
    const list = incoming.get(edge.target) ?? [];
    list.push(edge.source);
    incoming.set(edge.target, list);
  }

  const byLayer = new Map<number, WorkbenchNode[]>();
  for (const node of nodes) {
    const index = layer.get(node.id) ?? 0;
    const group = byLayer.get(index) ?? [];
    group.push(node);
    byLayer.set(index, group);
  }

  const placedY = new Map<string, number>();
  const result: Array<{ id: string; position: { x: number; y: number } }> = [];
  for (const index of [...byLayer.keys()].sort((a, b) => a - b)) {
    const group = byLayer.get(index)!;
    const score = (node: WorkbenchNode) => {
      const sources = (incoming.get(node.id) ?? []).map((id) => placedY.get(id)).filter((y): y is number => y !== undefined);
      if (!sources.length) return node.position.y;
      return sources.reduce((sum, y) => sum + y, 0) / sources.length;
    };
    const ordered = group
      .map((node) => ({ node, score: score(node), height: node.measured?.height ?? FALLBACK_HEIGHT }))
      .sort((a, b) => a.score - b.score);
    const totalHeight = ordered.reduce((sum, entry) => sum + entry.height, 0) + ROW_GAP * (ordered.length - 1);
    let cursor = -totalHeight / 2;
    for (const entry of ordered) {
      const position = { x: snap(index * COLUMN_STRIDE), y: snap(cursor) };
      placedY.set(entry.node.id, position.y);
      result.push({ id: entry.node.id, position });
      cursor += entry.height + ROW_GAP;
    }
  }
  return result;
}

export type HelperLines = { vertical?: number; horizontal?: number };

type NodeBox = { x: number; y: number; width: number; height: number };

// Alignment guides for a drag in progress: compare the moving card's
// left/center/right (and top/middle/bottom) against every other card; within
// `threshold` flow units the position snaps to exact alignment and the guide
// coordinate is returned for rendering. Runs per drag frame over every node —
// fine at workbench scale (tens of cards).
export function computeHelperLines(
  moving: NodeBox,
  others: NodeBox[],
  threshold = 6,
): { snapX?: number; snapY?: number; lines: HelperLines } {
  const lines: HelperLines = {};
  let snapX: number | undefined;
  let snapY: number | undefined;
  let bestX = threshold;
  let bestY = threshold;

  for (const other of others) {
    const xPairs: Array<[number, number]> = [
      [other.x, moving.x],
      [other.x + other.width / 2, moving.x + moving.width / 2],
      [other.x + other.width, moving.x + moving.width],
      [other.x, moving.x + moving.width],
      [other.x + other.width, moving.x],
    ];
    for (const [guide, edge] of xPairs) {
      const distance = Math.abs(guide - edge);
      if (distance < bestX) {
        bestX = distance;
        snapX = moving.x + (guide - edge);
        lines.vertical = guide;
      }
    }
    const yPairs: Array<[number, number]> = [
      [other.y, moving.y],
      [other.y + other.height / 2, moving.y + moving.height / 2],
      [other.y + other.height, moving.y + moving.height],
      [other.y, moving.y + moving.height],
      [other.y + other.height, moving.y],
    ];
    for (const [guide, edge] of yPairs) {
      const distance = Math.abs(guide - edge);
      if (distance < bestY) {
        bestY = distance;
        snapY = moving.y + (guide - edge);
        lines.horizontal = guide;
      }
    }
  }
  return { snapX, snapY, lines };
}
