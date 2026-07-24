// BROWSER registry: composes the framework-free manifests with each node's
// React component and (where needed) its DOM-touching execute wrapper. Unit
// tests must import ./manifests directly instead — this module pulls in .tsx.

import type { NodeExecute, NodeKind } from "../types";
import { MANIFESTS, NODE_KINDS } from "./manifests";
import { Component as CompareComponent } from "./compare";
import { Component as ImageEditComponent, execute as imageEditExecute } from "./imageEdit";
import { Component as ImageGenerateComponent, execute as imageGenerateExecute } from "./imageGenerate";
import { Component as NoteComponent } from "./note";
import { Component as PhotoComponent } from "./photo";
import { Component as PromptBuilderComponent } from "./promptBuilder";
import { Component as SaveToLibraryComponent, execute as saveToLibraryExecute } from "./saveToLibrary";
import { Component as TextComponent } from "./text";

export const NODE_TYPES = {
  photo: PhotoComponent,
  text: TextComponent,
  promptBuilder: PromptBuilderComponent,
  imageGenerate: ImageGenerateComponent,
  imageEdit: ImageEditComponent,
  compare: CompareComponent,
  saveToLibrary: SaveToLibraryComponent,
  note: NoteComponent,
};

// DOM-touching execute wrappers exported by the .tsx modules. Each wrapper
// composes its manifest's pure request/response core.
const DOM_EXECUTES: Partial<Record<NodeKind, NodeExecute>> = {
  imageGenerate: imageGenerateExecute,
  imageEdit: imageEditExecute,
  saveToLibrary: saveToLibraryExecute,
};

// Full execute map: a node's DOM wrapper wins; otherwise the manifest's
// framework-free execute runs directly. Kinds with neither (compare, note)
// have no entry and are not executable.
export const executeMap: Partial<Record<NodeKind, NodeExecute>> = {};
for (const kind of NODE_KINDS) {
  const execute = DOM_EXECUTES[kind] ?? MANIFESTS[kind].execute;
  if (execute) executeMap[kind] = execute;
}

// The single predicate replacing the old note/compare skip lists.
export function isExecutable(kind: NodeKind): boolean {
  return executeMap[kind] !== undefined;
}

// Re-exports so the registry is a one-stop import site for browser modules.
export {
  defaultParams,
  draftOverrideMap,
  estimateCostMap,
  importSchemaMap,
  MANIFESTS,
  NODE_KINDS,
  NODE_SPECS,
  paidMap,
  specFor,
  stableParamsMap,
} from "./manifests";
