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

export const PORT_COLORS: Record<PortKind, string> = {
  image: "#8b5cf6",
  text: "#2563eb",
  references: "#f59e0b", // amber
  report: "#16a34a", // green
  mask: "#7c3aed", // violet, darker than image so the two stay tellable apart
};

// ---------------------------------------------------------------------------
// Node-manifest registry types (framework-free — see nodes/manifests.ts).
// ---------------------------------------------------------------------------

// Import-validation rule for one param key: listed keys are checked against
// their declared type/enum/caps; keys not listed at all are rejected.
export type ImportParamRule =
  | { type: "string"; optional?: boolean; maxLength?: number }
  | { type: "number"; optional?: boolean; min?: number; max?: number; integer?: boolean }
  | { type: "boolean"; optional?: boolean }
  | { type: "enum"; optional?: boolean; values: readonly string[] };

// Registry-owned, authoritative import-validation metadata for one node kind.
export type ImportSchema = {
  // The exact allowed param keys: optional params are permitted, unknown keys
  // rejected, and each key carries its type/enum/caps.
  paramKeys: Record<string, ImportParamRule>;
  // Param fields that hold uploaded-image blob-cache keys.
  sourceBlobKeys: string[];
};

// Execution context the executor hands to a node's execute function.
export type ExecuteContext = {
  nodeId: string;
  node: WorkbenchNode; // live snapshot at dispatch time
  params: WorkbenchParams; // effective params (draft override applied when draft mode is on)
  signature: string; // memoization key the produced run must carry
  signal: AbortSignal;
  inputs: (portId: string) => NodeOutputValue[]; // ordered upstream values on one input port
  createRunId: () => string;
  applyRun: (run: NodeRun) => void;
  setProgress: (message: string) => void; // short status line while running
};

export type NodeExecute = (ctx: ExecuteContext) => Promise<void>;

export type CostEstimateInput = { params: WorkbenchParams; inputImages: number };

export type NodeManifest = {
  kind: NodeKind;
  spec: NodeSpec;
  defaultParams: WorkbenchParams;
  importSchema: ImportSchema;
  // Framework-free execute core (pure request-building + response-mapping
  // only). Nodes whose execution needs DOM work (canvas/blob URLs/transport)
  // omit this and export a DOM-touching wrapper from their .tsx module
  // instead, composing the pure helpers their manifest module exports.
  execute?: NodeExecute;
  // Per-node cost estimator, so non-generation paid nodes are never forced
  // into the generation-shaped estimator.
  estimateCost?: (input: CostEstimateInput) => number | null;
  // Signature-relevant subset of params. Omitted = every param is stable.
  // This replaces the executor's old hardcoded savedJobId/split denylist.
  stableParams?: (params: WorkbenchParams) => Partial<WorkbenchParams>;
  // Nodes that call a paid API get a cost badge and run controls.
  paid?: boolean;
  // OPTIONAL draft capability: declared ONLY by nodes whose draft mode
  // changes the effective request (quality/size). Nodes without a cheaper
  // variant omit it so the draft toggle never perturbs their signature.
  draftOverride?: (params: WorkbenchParams) => WorkbenchParams;
};

// NODE_SPECS/specFor/defaultParams are reconstructed from the per-node
// manifest registry; re-exported here so existing imports keep working.
export { NODE_SPECS, defaultParams, specFor } from "./nodes/manifests";
