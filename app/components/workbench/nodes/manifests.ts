// FRAMEWORK-FREE aggregation of every per-node manifest. This is the module
// the unit tests import under Node's --experimental-strip-types runner, so it
// (and everything it pulls in) must stay free of .tsx/JSX, "@/" path aliases,
// and DOM access at module scope; relative runtime imports carry explicit
// .ts extensions because Node's ESM loader does no extension searching.

import type { CostEstimateInput, ImportSchema, NodeKind, NodeManifest, NodeSpec, WorkbenchParams } from "../types";
import { compareManifest } from "./compare.manifest.ts";
import { imageEditManifest } from "./imageEdit.manifest.ts";
import { imageGenerateManifest } from "./imageGenerate.manifest.ts";
import { noteManifest } from "./note.manifest.ts";
import { photoManifest } from "./photo.manifest.ts";
import { promptBuilderManifest } from "./promptBuilder.manifest.ts";
import { saveToLibraryManifest } from "./saveToLibrary.manifest.ts";
import { textManifest } from "./text.manifest.ts";

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

export const importSchemaMap: Record<NodeKind, ImportSchema> = mapManifests((manifest) => manifest.importSchema);

export const paidMap: Record<NodeKind, boolean> = mapManifests((manifest) => Boolean(manifest.paid ?? manifest.spec.paid));

export const estimateCostMap: Partial<Record<NodeKind, (input: CostEstimateInput) => number | null>> = {};
export const stableParamsMap: Partial<Record<NodeKind, (params: WorkbenchParams) => Partial<WorkbenchParams>>> = {};
export const draftOverrideMap: Partial<Record<NodeKind, (params: WorkbenchParams) => WorkbenchParams>> = {};
for (const kind of NODE_KINDS) {
  const manifest = MANIFESTS[kind];
  if (manifest.estimateCost) estimateCostMap[kind] = manifest.estimateCost;
  if (manifest.stableParams) stableParamsMap[kind] = manifest.stableParams;
  if (manifest.draftOverride) draftOverrideMap[kind] = manifest.draftOverride;
}
