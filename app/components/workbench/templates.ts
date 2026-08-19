// Empty-canvas onboarding templates (AC19): three domain presets (interior
// render edit [flagship], exterior render edit, collage create & edit) plus a
// blank option. Each preset clones a small pre-positioned, pre-wired graph
// with placeholder Photo/References nodes -- WorkbenchApp.tsx hands the
// result to the store and calls fitView(). The collage preset reproduces the
// /generator pipeline (References -> Collage Board) as the migration path
// onto the workbench.

import type { Edge } from "@xyflow/react";
import { ITEM_PRESETS, type CollageType } from "@/app/lib/collage";
// S-4: this .ts module only needs the framework-free defaultParams, which
// nodes/manifests.ts re-exports -- importing from nodes/index.ts (the
// browser registry, which pulls in every node's .tsx component) is the
// exact .tsx-rooted trap E3 was written to close, even though it's
// browser-only today and nothing currently breaks from it.
import { defaultParams } from "./nodes/manifests.ts";
import type { NodeKind, ReferenceItem, WorkbenchNode, WorkbenchParams } from "./types";

export type TemplateId = "interiorEdit" | "exteriorEdit" | "collage" | "blank";

export type TemplateDef = {
  id: TemplateId;
  title: string;
  description: string;
  flagship?: boolean;
};

export const TEMPLATES: TemplateDef[] = [
  {
    id: "interiorEdit",
    title: "Interior render edit",
    description: "Restyle a room photo against your material references, then review and correct the result.",
    flagship: true,
  },
  {
    id: "exteriorEdit",
    title: "Exterior render edit",
    description: "Restyle an exterior render and compare it side by side with the original photo.",
  },
  {
    id: "collage",
    title: "Collage create & edit",
    description: "Build an editorial material collage from reference items, then review and correct it.",
  },
  {
    id: "blank",
    title: "Blank canvas",
    description: "Start from nothing and add nodes yourself.",
  },
];

export type TemplateGraph = { nodes: WorkbenchNode[]; edges: Edge[] };

function createId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.().slice(0, 8) ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`}`;
}

function makeNode(kind: NodeKind, position: { x: number; y: number }, overrides: Partial<WorkbenchParams> = {}): WorkbenchNode {
  return {
    id: createId(kind),
    type: kind,
    position,
    data: { kind, params: { ...defaultParams(kind), ...overrides }, status: "idle", runs: [], activeRun: 0 },
  };
}

function makeEdge(source: WorkbenchNode, sourceHandle: string, target: WorkbenchNode, targetHandle: string): Edge {
  return { id: createId("edge"), source: source.id, target: target.id, sourceHandle, targetHandle } as Edge;
}

// Seeds a placeholder References node from the generator's own item presets
// (CollageItemInput + ITEM_PRESETS) -- same shape references.tsx builds when
// the user picks a preset from its own dropdown, just with no images
// uploaded yet (the placeholder the user fills in).
function placeholderReferenceItems(type: CollageType): ReferenceItem[] {
  return ITEM_PRESETS[type].map((preset) => ({ id: preset.id, role: preset.role, required: preset.required, imageKeys: [] }));
}

function interiorEditTemplate(): TemplateGraph {
  const photo = makeNode("photo", { x: 0, y: 0 });
  const prompt = makeNode("promptBuilder", { x: 0, y: 240 }, { domain: "interior" });
  const references = makeNode("references", { x: 0, y: 500 }, { referenceItems: placeholderReferenceItems("kitchen_material_palette") });
  const edit = makeNode("imageEdit", { x: 360, y: 140 });
  const download = makeNode("exportDownload", { x: 720, y: 140 });

  return {
    nodes: [photo, prompt, references, edit, download],
    edges: [
      makeEdge(photo, "image", edit, "image"),
      makeEdge(prompt, "text", edit, "prompt"),
      makeEdge(references, "references", edit, "references"),
      makeEdge(edit, "image", download, "image"),
    ],
  };
}

function exteriorEditTemplate(): TemplateGraph {
  const photo = makeNode("photo", { x: 0, y: 0 });
  const prompt = makeNode("promptBuilder", { x: 0, y: 240 }, { domain: "exterior" });
  const edit = makeNode("imageEdit", { x: 360, y: 120 });
  const compare = makeNode("compare", { x: 720, y: 120 });

  return {
    nodes: [photo, prompt, edit, compare],
    edges: [
      makeEdge(photo, "image", edit, "image"),
      makeEdge(prompt, "text", edit, "prompt"),
      makeEdge(photo, "image", compare, "a"),
      makeEdge(edit, "image", compare, "b"),
    ],
  };
}

function collageTemplate(): TemplateGraph {
  const references = makeNode("references", { x: 0, y: 0 }, { referenceItems: placeholderReferenceItems("kitchen_material_palette") });
  const board = makeNode("collageBoard", { x: 360, y: 60 });
  const download = makeNode("exportDownload", { x: 720, y: 60 });

  return {
    nodes: [references, board, download],
    edges: [
      makeEdge(references, "references", board, "items"),
      makeEdge(board, "image", download, "image"),
    ],
  };
}

// Returns null for "blank" -- picking it just dismisses the gallery onto a
// genuinely empty canvas.
export function instantiateTemplate(id: TemplateId): TemplateGraph | null {
  switch (id) {
    case "interiorEdit": return interiorEditTemplate();
    case "exteriorEdit": return exteriorEditTemplate();
    case "collage": return collageTemplate();
    case "blank": return null;
  }
}
