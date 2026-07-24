import type { Node } from "@xyflow/react";

// Data kinds carried by connections, color-coded on ports and edges.
export type PortKind = "image" | "text" | "references" | "report" | "mask";

export type NodeKind =
  | "photo"
  | "text"
  | "promptBuilder"
  | "imageGenerate"
  | "imageEdit"
  | "compare"
  | "saveToLibrary"
  | "note";

export type NodeStatus = "idle" | "running" | "done" | "error" | "stale";

export type PortSpec = {
  id: string;
  kind: PortKind;
  label: string;
  // Multi-input ports accept several connections (ordered); single ports
  // replace the existing connection.
  multi?: boolean;
  required?: boolean;
  // Input ports that take more than their declared kind list every accepted
  // kind here (e.g. reference inputs take both "image" and "references").
  // When omitted the port accepts only its own `kind`.
  acceptedKinds?: PortKind[];
};

export function acceptedKindsFor(port: PortSpec): PortKind[] {
  return port.acceptedKinds ?? [port.kind];
}

export type NodeSpec = {
  kind: NodeKind;
  title: string;
  description: string;
  inputs: PortSpec[];
  outputs: PortSpec[];
  // Nodes that call a paid API get a cost badge and run controls.
  paid?: boolean;
};

// One entry inside a references value: an ordered group of cached images
// playing a role (e.g. material, style, context) in downstream generation.
export type ReferenceItem = {
  id: string;
  role: string;
  imageKeys: string[]; // ordered blob-cache keys for this item's images
};

export type ReportItemResult = {
  id: string;
  passed: boolean;
  score: number;
  findings: string[];
};

export type ReportResult = {
  passed: boolean;
  score: number;
  findings: string[];
  recommendation: string;
  items: ReportItemResult[];
};

export type NodeOutputValue =
  | { kind: "image"; url: string; cacheKey: string }
  | { kind: "text"; text: string }
  | { kind: "references"; items: ReferenceItem[]; order: string[] } // order: item ids
  | { kind: "report"; result: ReportResult }
  | { kind: "mask"; cacheKey: string };

export type NodeRun = {
  runId: string;
  signature: string;
  at: number;
  values: NodeOutputValue[][]; // one array per output port, candidates within
  usage?: Record<string, unknown>;
};

export type WorkbenchParams = {
  // photo
  fileName?: string;
  fileFingerprint?: string;
  // text / note
  text?: string;
  // promptBuilder
  domain?: "interior" | "exterior" | "collage";
  lighting?: string;
  styleDirection?: string;
  extraDirection?: string;
  // imageGenerate / imageEdit
  size?: string;
  quality?: "low" | "medium" | "high";
  candidates?: number;
  // saveToLibrary
  filename?: string;
  savedJobId?: string;
  // compare
  split?: number;
};

export type WorkbenchNodeData = {
  kind: NodeKind;
  params: WorkbenchParams;
  status: NodeStatus;
  error?: string;
  runs: NodeRun[];       // newest first, capped
  activeRun: number;     // index into runs shown on the node
  progress?: string;     // short status line while running
  [key: string]: unknown;
};

export type WorkbenchNode = Node<WorkbenchNodeData>;

export const NODE_SPECS: Record<NodeKind, NodeSpec> = {
  photo: {
    kind: "photo",
    title: "Photo",
    description: "Upload an image (render, reference, or site photo).",
    inputs: [],
    outputs: [{ id: "image", kind: "image", label: "Image" }],
  },
  text: {
    kind: "text",
    title: "Text",
    description: "A prompt or instruction fragment.",
    inputs: [],
    outputs: [{ id: "text", kind: "text", label: "Text" }],
  },
  promptBuilder: {
    kind: "promptBuilder",
    title: "Prompt Builder",
    description: "Compose an architectural prompt from presets.",
    inputs: [{ id: "extra", kind: "text", label: "Extra direction" }],
    outputs: [{ id: "text", kind: "text", label: "Prompt" }],
  },
  imageGenerate: {
    kind: "imageGenerate",
    title: "Image Generation",
    description: "Generate an image from a prompt, optionally guided by reference images.",
    inputs: [
      { id: "prompt", kind: "text", label: "Prompt", required: true },
      { id: "references", kind: "image", label: "References", multi: true, acceptedKinds: ["image", "references"] },
    ],
    outputs: [{ id: "image", kind: "image", label: "Image" }],
    paid: true,
  },
  imageEdit: {
    kind: "imageEdit",
    title: "Edit / Material Swap",
    description: "Edit an image with a prompt — swap materials, restyle, relight.",
    inputs: [
      { id: "image", kind: "image", label: "Image", required: true },
      { id: "prompt", kind: "text", label: "Prompt", required: true },
      { id: "references", kind: "image", label: "References", multi: true, acceptedKinds: ["image", "references"] },
    ],
    outputs: [{ id: "image", kind: "image", label: "Image" }],
    paid: true,
  },
  compare: {
    kind: "compare",
    title: "Compare A/B",
    description: "Slide between two images.",
    inputs: [
      { id: "a", kind: "image", label: "A", required: true },
      { id: "b", kind: "image", label: "B", required: true },
    ],
    outputs: [],
  },
  saveToLibrary: {
    kind: "saveToLibrary",
    title: "Save to Library",
    description: "Persist an image to the 30-day library.",
    inputs: [{ id: "image", kind: "image", label: "Image", required: true }],
    outputs: [],
  },
  note: {
    kind: "note",
    title: "Note",
    description: "A sticky note. Not part of execution.",
    inputs: [],
    outputs: [],
  },
};

export const PORT_COLORS: Record<PortKind, string> = {
  image: "#8b5cf6",
  text: "#2563eb",
  references: "#f59e0b", // amber
  report: "#16a34a", // green
  mask: "#7c3aed", // violet, darker than image so the two stay tellable apart
};

export function specFor(kind: NodeKind): NodeSpec {
  return NODE_SPECS[kind];
}

export function defaultParams(kind: NodeKind): WorkbenchParams {
  switch (kind) {
    case "text":
      return { text: "" };
    case "note":
      return { text: "" };
    case "promptBuilder":
      return { domain: "interior", lighting: "soft daylight", styleDirection: "photorealistic, editorial", extraDirection: "" };
    case "imageGenerate":
      return { size: "1536x1024", quality: "medium", candidates: 1 };
    case "imageEdit":
      return { size: "1536x1024", quality: "medium", candidates: 1 };
    case "saveToLibrary":
      return { filename: "workbench-output.png" };
    case "compare":
      return { split: 50 };
    default:
      return {};
  }
}
