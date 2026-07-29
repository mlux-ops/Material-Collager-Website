// BROWSER registry: composes the framework-free manifests with each node's
// React component and (where needed) its DOM-touching execute wrapper. Unit
// tests must import ./manifests directly instead — this module pulls in .tsx.

import type { NodeExecute, NodeKind } from "../types";
import { MANIFESTS, NODE_KINDS } from "./manifests";
import { Component as AccuracyReviewerComponent, execute as accuracyReviewerExecute } from "./accuracyReviewer";
import { Component as AiAssistantComponent, execute as aiAssistantExecute } from "./aiAssistant";
import { Component as CollageBoardComponent, execute as collageBoardExecute } from "./collageBoard";
import { Component as CompareComponent } from "./compare";
import { Component as CropComponent, execute as cropExecute } from "./crop";
import { Component as ExportDownloadComponent, execute as exportDownloadExecute } from "./exportDownload";
import { Component as ImageEditComponent, execute as imageEditExecute } from "./imageEdit";
import { Component as ImageDescriptionComponent, execute as imageDescriptionExecute } from "./imageDescription";
import { Component as ImageGenerateComponent, execute as imageGenerateExecute } from "./imageGenerate";
import { Component as LibraryPickComponent, execute as libraryPickExecute } from "./libraryPick";
import { Component as MaskedEditComponent, execute as maskedEditExecute } from "./maskedEdit";
import { Component as NoteComponent } from "./note";
import { Component as PhotoComponent } from "./photo";
import { Component as PromptBuilderComponent } from "./promptBuilder";
import { Component as QaCorrectionComponent, execute as qaCorrectionExecute } from "./qaCorrection";
import { Component as ReferenceAnalyzerComponent, execute as referenceAnalyzerExecute } from "./referenceAnalyzer";
import { Component as ReferenceFinderComponent } from "./referenceFinder";
import { Component as ReferencesComponent } from "./references";
import { Component as RelightComponent, execute as relightExecute } from "./relight";
import { Component as ResizeComponent, execute as resizeExecute } from "./resize";
import { Component as SaveToLibraryComponent, execute as saveToLibraryExecute } from "./saveToLibrary";
import { Component as TextComponent } from "./text";
import { Component as UpscalerComponent, execute as upscalerExecute } from "./upscaler";
import { Component as VariationsComponent, execute as variationsExecute } from "./variations";

export const NODE_TYPES = {
  photo: PhotoComponent,
  text: TextComponent,
  promptBuilder: PromptBuilderComponent,
  imageGenerate: ImageGenerateComponent,
  imageEdit: ImageEditComponent,
  compare: CompareComponent,
  saveToLibrary: SaveToLibraryComponent,
  note: NoteComponent,
  // Phase 2 node kinds.
  references: ReferencesComponent,
  referenceAnalyzer: ReferenceAnalyzerComponent,
  imageDescription: ImageDescriptionComponent,
  referenceFinder: ReferenceFinderComponent,
  libraryPick: LibraryPickComponent,
  collageBoard: CollageBoardComponent,
  relight: RelightComponent,
  variations: VariationsComponent,
  maskedEdit: MaskedEditComponent,
  upscaler: UpscalerComponent,
  accuracyReviewer: AccuracyReviewerComponent,
  qaCorrection: QaCorrectionComponent,
  aiAssistant: AiAssistantComponent,
  resize: ResizeComponent,
  crop: CropComponent,
  exportDownload: ExportDownloadComponent,
};

// DOM-touching execute wrappers exported by the .tsx modules. Each wrapper
// composes its manifest's pure request/response core.
const DOM_EXECUTES: Partial<Record<NodeKind, NodeExecute>> = {
  imageGenerate: imageGenerateExecute,
  imageEdit: imageEditExecute,
  saveToLibrary: saveToLibraryExecute,
  referenceAnalyzer: referenceAnalyzerExecute,
  imageDescription: imageDescriptionExecute,
  libraryPick: libraryPickExecute,
  resize: resizeExecute,
  crop: cropExecute,
  exportDownload: exportDownloadExecute,
  accuracyReviewer: accuracyReviewerExecute,
  qaCorrection: qaCorrectionExecute,
  aiAssistant: aiAssistantExecute,
  collageBoard: collageBoardExecute,
  relight: relightExecute,
  variations: variationsExecute,
  maskedEdit: maskedEditExecute,
  upscaler: upscalerExecute,
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
  alwaysExecuteMap,
  auditPaidNodeCoverage,
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
