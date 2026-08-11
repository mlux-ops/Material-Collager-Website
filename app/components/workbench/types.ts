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
  | "note"
  // Phase 2 node kinds (scaffolded; see nodes/<kind>.manifest.ts for specs).
  | "references"
  | "referenceAnalyzer"
  | "imageDescription"
  | "referenceFinder"
  | "libraryPick"
  | "collageBoard"
  | "relight"
  | "variations"
  | "maskedEdit"
  | "upscaler"
  | "accuracyReviewer"
  | "qaCorrection"
  | "aiAssistant"
  | "resize"
  | "crop"
  | "exportDownload";

export type NodeStatus = "idle" | "running" | "done" | "error" | "stale" | "needs-selection";

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
  // For a required port that can ALSO be satisfied by a param value instead
  // of an incoming edge (e.g. Reference Finder's "query" port: its own
  // matchQuery override needs no upstream connection at all --
  // referenceFinder.manifest.ts). unmetRequiredInputs/useMissingRequiredInputs
  // treat the port as satisfied when this predicate returns true, even with
  // nothing connected -- so a working alternate satisfaction path never
  // forces dropping `required` (which would lose the disabled-Run
  // protection when neither the override nor a connection is present).
  satisfiedByParams?: (params: WorkbenchParams) => boolean;
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
// Mirrors CollageItemInput (app/lib/collage.ts) so a References node's output
// items can drive buildGenerationPrompt/ITEM_PRESETS downstream unchanged.
export type ReferenceItem = {
  id: string;
  role: string;
  brand?: string;
  name?: string;
  finish?: string;
  notes?: string;
  required?: boolean;
  imageKeys: string[]; // ordered blob-cache keys for this item's images
};

// A single candidate returned by POST /api/references/matches.
export type ReferenceMatchCandidate = {
  title: string;
  pageUrl: string;
  imageUrl: string;
  sourceLabel: string;
  official: boolean;
  confidence: number;
  reason: string;
};

// Reference Finder's paused "needs selection" state (AC5): captured when the
// executor halts after a successful matches call, and consumed when the user
// picks a candidate to resume the run at resumeTargets.
export type PendingReferenceSelection = {
  query: string;
  candidates: ReferenceMatchCandidate[];
  resumeTargets: string[]; // the original run() target ids to resume after import
  signature: string; // the signature captured for this node at pause time
};

export type ReportItemResult = {
  id: string;
  passed: boolean;
  score: number;
  findings: string[];
  // Normalized [x, y, width, height] (0-1000) bounding box for this item, when
  // the reviewer could locate it. Drives the QA Correction node's mask via
  // app/lib/selective-edit.ts; absent means the item could not be located.
  box?: [number, number, number, number];
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

// Masked Edit mask geometry. Coordinates are normalized 0-1000 against the
// image width (x) and height (y) — the NormalizedBox convention. Polygon and
// brush points are flat [x0, y0, x1, y1, ...] arrays to keep the serialized
// maskShapes param compact; brush radius is normalized against width.
export type MaskShape =
  | { kind: "rect"; x: number; y: number; width: number; height: number }
  | { kind: "polygon"; points: number[] }
  | { kind: "brush"; points: number[]; radius: number };

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
  // collageBoard
  collageType?: string;
  orientation?: string;
  outputResolution?: string;
  // referenceAnalyzer
  itemType?: string;
  // references
  referenceItems?: ReferenceItem[];
  // referenceFinder
  matchQuery?: string;
  // libraryPick
  selectedLibraryId?: string;
  // variations
  n?: number;
  separateOutputs?: boolean;
  // maskedEdit — maskShapes is the source of truth: a JSON-serialized
  // MaskShape[] (rects, polygons, brush strokes; coordinates normalized
  // 0-1000 like NormalizedBox). maskRegion* is the derived union bounding
  // box, kept for import compatibility and pre-shapes graphs (which carry
  // only the rectangle). maskCacheKey caches the rendered PNG mask blob
  // (persisted via persistBlobKeys); its key embeds a shape-content hash so
  // mask edits change the memoization signature. engine picks the backend:
  // gpt-image-2 (guidance mask, paid), Workers AI SD 1.5 inpainting
  // (pixel-exact mask, free tier), or FLUX.1 Fill [pro] (pixel-exact mask,
  // ~$0.05/image via the BFL API).
  engine?: "gpt-image" | "workers-ai" | "flux-fill";
  // FLUX Fill tuning (flux-fill engine only). fluxGuidance is BFL's
  // prompt-adherence dial: high values render the prompt literally, which for
  // a material/texture fill makes the model invent an assertive object rather
  // than blending into its surroundings. We default below BFL's own 60 --
  // see FLUX_FILL_GUIDANCE_DEFAULT. fluxSeed left undefined = random per run.
  fluxGuidance?: number;
  fluxSeed?: number;
  referenceInstruction?: string;
  maskShapes?: string;
  maskCacheKey?: string;
  maskRegionX?: number;
  maskRegionY?: number;
  maskRegionWidth?: number;
  maskRegionHeight?: number;
  // accuracyReviewer / qaCorrection
  selectedItemIds?: string[];
  // aiAssistant
  instruction?: string;
  model?: string;
  // resize
  targetWidth?: number;
  targetHeight?: number;
  // crop
  cropX?: number;
  cropY?: number;
  cropWidth?: number;
  cropHeight?: number;
  // exportDownload
  exportFormat?: "png" | "jpeg";
};

export type WorkbenchNodeData = {
  kind: NodeKind;
  params: WorkbenchParams;
  status: NodeStatus;
  error?: string;
  runs: NodeRun[];       // newest first, capped
  activeRun: number;     // index into runs shown on the node
  progress?: string;     // short status line while running
  // Present only while status is "needs-selection" (Reference Finder, AC5).
  pendingSelection?: PendingReferenceSelection;
  // Output pinning (AC15): index into `runs` the user has locked in as this
  // node's permanent output. Undefined/null means unpinned. A pinned node's
  // executor entry is honored BEFORE the signature check (signature.ts's
  // isPinned/activeRunOf) -- it never re-runs or re-bills even when its own
  // params or an ancestor changed, and it is exempt from the persistence
  // byte-budget's oldest-unpinned eviction (persistence.ts). Always rendered
  // as a visible badge (NodeShell) -- pinning is never silent.
  pinnedOutput?: number | null;
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
// "referenceItemList" is the one generic, kind-agnostic structural rule
// (rather than a hand-maintained per-kind exception): it describes a
// ReferenceItem[]-shaped param field, letting the strict import validator
// (export-import.ts) sanitize + cap it and remap its nested imageKeys through
// the same blob-key-ownership check every other blob-bearing field gets,
// without export-import.ts ever special-casing a specific node kind.
export type ImportParamRule =
  | { type: "string"; optional?: boolean; maxLength?: number }
  | { type: "number"; optional?: boolean; min?: number; max?: number; integer?: boolean }
  | { type: "boolean"; optional?: boolean }
  | { type: "enum"; optional?: boolean; values: readonly string[] }
  // A plain string[] field (e.g. accuracyReviewer's selectedItemIds, S-5):
  // non-string/oversized entries are dropped, the list is capped at
  // maxItems -- the generic, kind-agnostic sibling of referenceItemList for
  // fields that carry no nested images/blob keys to remap.
  | { type: "stringList"; optional?: boolean; maxItems?: number; maxLength?: number }
  | { type: "referenceItemList"; optional?: boolean; maxItems?: number; maxImagesPerItem?: number };

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
  // Human-in-the-loop pause (AC5, Reference Finder only): halts the current
  // run in a "needs selection" status instead of applying a run. Downstream
  // nodes stay idle until the user picks a candidate and resumes.
  setAwaitingSelection: (payload: { query: string; candidates: ReferenceMatchCandidate[] }) => void;
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
  // OPTIONAL split-blob persistence declaration (see persistence.ts): pure
  // function returning the fully-qualified blob-cache keys (e.g.
  // `${nodeId}:src`) this node instance currently owns uploaded-image bytes
  // under, given its id and effective params. Any node that owns uploaded
  // images (Photo source, References items, ...) declares this so its blobs
  // survive reload via the generic split-blob pattern -- persistence.ts
  // itself stays free of any per-kind gating.
  persistBlobKeys?: (nodeId: string, params: WorkbenchParams) => string[];
  // OPTIONAL opt-out of run memoization entirely (W-4): a terminal
  // side-effect node (e.g. Export/Download) whose execute performs an action
  // that must repeat identically every time it's scheduled, rather than
  // being treated as a cacheable computation. runNodes/estimateStaleCost
  // check this BEFORE the signature cache-hit comparison (mirroring how
  // isPinned is checked first) so an unchanged signature never silently
  // short-circuits it into a no-op.
  alwaysExecute?: boolean;
  // OPTIONAL compatibility/output adapter. Most nodes store one values array
  // per declared output port directly on the run. A node whose output surface
  // expands without re-running (Variations' opt-in per-candidate handles)
  // can resolve a declared port from an older aggregate-only run here.
  resolveOutputValues?: (run: NodeRun, portId: string) => NodeOutputValue[];
  // OPTIONAL visible/active output subset. Every port remains declared for
  // import and edge validation, but presentation-only modes may expose only
  // a subset at a time (Variations' aggregate vs individual handles).
  activeOutputIds?: (params: WorkbenchParams) => string[];
};

// NODE_SPECS/specFor/defaultParams are reconstructed from the per-node
// manifest registry; re-exported here so existing imports keep working. The
// explicit .ts extension is required (not merely stylistic): this is a real
// (value) re-export, so it needs to resolve under Node's
// --experimental-strip-types loader for any framework-free module that
// imports a VALUE (not just a type) from this file -- e.g. acceptedKindsFor
// below, which export-import.ts's validator imports at runtime.
export { NODE_SPECS, defaultParams, specFor } from "./nodes/manifests.ts";
