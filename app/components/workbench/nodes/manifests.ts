// FRAMEWORK-FREE aggregation of every per-node manifest. This is the module
// the unit tests import under Node's --experimental-strip-types runner, so it
// (and everything it pulls in) must stay free of .tsx/JSX, "@/" path aliases,
// and DOM access at module scope; relative runtime imports carry explicit
// .ts extensions because Node's ESM loader does no extension searching.

import type {
  CostEstimateInput,
  ImportSchema,
  NodeKind,
  NodeManifest,
  NodeOutputValue,
  NodeRun,
  NodeSpec,
  WorkbenchNode,
  WorkbenchParams,
} from "../types";
import { aiAssistantManifest } from "./aiAssistant.manifest.ts";
import { collageBoardManifest } from "./collageBoard.manifest.ts";
import { compareManifest } from "./compare.manifest.ts";
import { cropManifest } from "./crop.manifest.ts";
import { exportDownloadManifest } from "./exportDownload.manifest.ts";
import { imageEditManifest } from "./imageEdit.manifest.ts";
import { imageGenerateManifest } from "./imageGenerate.manifest.ts";
import { imageDescriptionManifest } from "./imageDescription.manifest.ts";
import { libraryPickManifest } from "./libraryPick.manifest.ts";
import { maskedEditManifest } from "./maskedEdit.manifest.ts";
import { noteManifest } from "./note.manifest.ts";
import { patchManifest } from "./patch.manifest.ts";
import { photoManifest } from "./photo.manifest.ts";
import { promptBuilderManifest } from "./promptBuilder.manifest.ts";
import { referenceAnalyzerManifest } from "./referenceAnalyzer.manifest.ts";
import { referenceFinderManifest } from "./referenceFinder.manifest.ts";
import { referencesManifest } from "./references.manifest.ts";
import { relightManifest } from "./relight.manifest.ts";
import { resizeManifest } from "./resize.manifest.ts";
import { saveToLibraryManifest } from "./saveToLibrary.manifest.ts";
import { textManifest } from "./text.manifest.ts";
import { upscalerManifest } from "./upscaler.manifest.ts";
import { variationsManifest } from "./variations.manifest.ts";

// Registration order drives the add-node palette.
export const MANIFESTS: Record<NodeKind, NodeManifest> = {
  photo: photoManifest,
  text: textManifest,
  promptBuilder: promptBuilderManifest,
  imageGenerate: imageGenerateManifest,
  imageEdit: imageEditManifest,
  compare: compareManifest,
  saveToLibrary: saveToLibraryManifest,
  note: noteManifest,
  // Phase 2 node kinds.
  references: referencesManifest,
  referenceAnalyzer: referenceAnalyzerManifest,
  imageDescription: imageDescriptionManifest,
  referenceFinder: referenceFinderManifest,
  libraryPick: libraryPickManifest,
  collageBoard: collageBoardManifest,
  relight: relightManifest,
  variations: variationsManifest,
  maskedEdit: maskedEditManifest,
  upscaler: upscalerManifest,
  aiAssistant: aiAssistantManifest,
  resize: resizeManifest,
  crop: cropManifest,
  patch: patchManifest,
  exportDownload: exportDownloadManifest,
};

export const NODE_KINDS = Object.keys(MANIFESTS) as NodeKind[];

function mapManifests<T>(project: (manifest: NodeManifest) => T): Record<NodeKind, T> {
  const result = {} as Record<NodeKind, T>;
  for (const kind of NODE_KINDS) result[kind] = project(MANIFESTS[kind]);
  return result;
}

export const NODE_SPECS: Record<NodeKind, NodeSpec> = mapManifests((manifest) => manifest.spec);

export function specFor(kind: NodeKind): NodeSpec {
  return NODE_SPECS[kind];
}

// Fresh copy per call so callers never share (or mutate) manifest state.
export function defaultParams(kind: NodeKind): WorkbenchParams {
  return { ...MANIFESTS[kind].defaultParams };
}

// Resolve one declared output port from a run. The direct values array is the
// default contract; a manifest may provide a compatibility adapter when a
// newer output surface can be derived from an older persisted run without a
// paid re-execution (Variations' individual candidate handles).
export function outputValuesFor(node: WorkbenchNode, run: NodeRun, portId: string): NodeOutputValue[] {
  const manifest = MANIFESTS[node.data.kind];
  const portIndex = manifest.spec.outputs.findIndex((port) => port.id === portId);
  if (portIndex < 0) return [];
  const direct = run.values[portIndex];
  if (direct !== undefined) return direct;
  return manifest.resolveOutputValues?.(run, portId) ?? [];
}

export function activeOutputPortsFor(node: WorkbenchNode) {
  const manifest = MANIFESTS[node.data.kind];
  const activeIds = manifest.activeOutputIds?.(node.data.params);
  if (!activeIds) return manifest.spec.outputs;
  const allowed = new Set(activeIds);
  return manifest.spec.outputs.filter((port) => allowed.has(port.id));
}

export const importSchemaMap: Record<NodeKind, ImportSchema> = mapManifests((manifest) => manifest.importSchema);

export const paidMap: Record<NodeKind, boolean> = mapManifests((manifest) => Boolean(manifest.paid ?? manifest.spec.paid));

export const estimateCostMap: Partial<Record<NodeKind, (input: CostEstimateInput) => number | null>> = {};
export const stableParamsMap: Partial<Record<NodeKind, (params: WorkbenchParams) => Partial<WorkbenchParams>>> = {};
export const draftOverrideMap: Partial<Record<NodeKind, (params: WorkbenchParams) => WorkbenchParams>> = {};
// W-4: kinds that opt out of run memoization entirely (Export/Download) --
// runNodes/estimateStaleCost consult this BEFORE the signature cache-hit
// comparison so an unchanged signature never turns a re-run into a no-op.
export const alwaysExecuteMap: Partial<Record<NodeKind, boolean>> = {};
for (const kind of NODE_KINDS) {
  const manifest = MANIFESTS[kind];
  if (manifest.estimateCost) estimateCostMap[kind] = manifest.estimateCost;
  if (manifest.stableParams) stableParamsMap[kind] = manifest.stableParams;
  if (manifest.draftOverride) draftOverrideMap[kind] = manifest.draftOverride;
  if (manifest.alwaysExecute) alwaysExecuteMap[kind] = true;
}

// ---------------------------------------------------------------------------
// Paid-node completeness audit (S27/AC21). Framework-free so the S31
// registry-integrity unit test can import it directly: every manifest marked
// paid (either its own `paid` flag or its spec's) must also declare an
// `estimateCost` -- a paid node silently falling back to "no estimate" would
// make the Run Workflow aggregate and the high-cost confirm guardrail both
// under-count it. Returns an empty array when every paid node is fully wired;
// otherwise one message per offending kind.
// ---------------------------------------------------------------------------
export function auditPaidNodeCoverage(): string[] {
  const issues: string[] = [];
  for (const kind of NODE_KINDS) {
    if (!paidMap[kind]) continue;
    if (!estimateCostMap[kind]) issues.push(`${kind}: paid:true but no estimateCost declared`);
  }
  return issues;
}
