/* eslint-disable @next/next/no-img-element */
"use client";

import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { DropdownSelect } from "../components/DropdownSelect";
import { DitherReveal } from "../components/DitherReveal";
import { WorkingField } from "../components/WorkingField";
import { RenderClock, RenderClockRule, RenderClockTime, useRenderClock } from "../components/RenderClock";
import { renderClockKey } from "@/app/lib/render-clock";
import { CostFigure, CostSplit, CostStack, costHostClassName, costRowNeighbourClassName } from "../components/CostEstimate";
import { collageRenderCostBasis, estimateCollageRenderCost } from "@/app/lib/collage-cost";
import { describeCostEstimate, formatCostSplit, recordUsageCalibration } from "@/app/lib/image-cost";
import { ReceiptStamp, receiptAnnouncement } from "../components/ReceiptStamp";
import type { RenderReceiptInput } from "@/app/lib/render-receipt";
import {
  acceptsFileDrag,
  developClassName,
  developHandlers,
  dropLabel,
  markDeveloping,
  slotDropClassName,
  useSlotDropTargets,
} from "../components/SlotDrop";
import { CompareStage } from "../components/CompareStage";
import { ReferenceLoupe } from "../components/ReferenceLoupe";
import { RakingLight } from "../components/raking-light/RakingLight";
import { usePrintInLater } from "../hooks/usePrintInLater";
import { printInClass } from "@/app/lib/print-in";
import { SiteNavigation } from "../components/SiteNavigation";
import { RouteReady } from "../components/RouteReady";
import {
  COLLAGE_TYPES,
  COMPOSITIONS,
  SUNBURST_BACKGROUNDS,
  DENSITIES,
  ITEM_PRESETS,
  LIGHTING_OPTIONS,
  MAX_REFERENCE_FILE_BYTES,
  MAX_REFERENCE_IMAGES,
  ORIENTATIONS,
  OUTPUT_RESOLUTIONS,
  QUALITIES,
  STYLING_OPTIONS,
  labelFor,
  resolvedOrientation,
  resolvedSize,
  slugify,
  validateCollageRequest,
  type CollageItemInput,
  type CollageRequestInput,
  type CollageType,
  type Composition,
  type Background,
  type Density,
  type LightingOption,
  type Orientation,
  type OutputResolution,
  type Quality,
  type StylingOption,
} from "@/app/lib/collage";
import { SUNBURST_MODEL } from "@/app/lib/sunburst";
import { ApiResponseError, readApiResponse } from "@/app/lib/api-client";
import {
  DIRECT_REQUEST_REFERENCE_BUDGET,
  FINAL_LAYOUT_REFERENCE_BUDGET,
  FINAL_REQUEST_BODY_BUDGET,
  LAYOUT_MASTER_TRANSPORT_BUDGET,
  base64ImageToObjectUrl,
  compressedReferenceCount,
  dataUrlFile,
  fileFingerprint,
  formatBytes,
  optimizeReferenceForTransport,
  optimizeReferencesForTransport,
} from "@/app/lib/image-transport";

type UiReference = {
  uiKey: string;
  file: File;
  preview: string;
  primary?: boolean;
  sourceUrl?: string;
  sourceLabel?: string;
  provenance?: "upload" | "investigation" | "sample";
};

type AnalysisField = { value: string; confidence: number };
type ReferenceAnalysis = {
  itemType: AnalysisField;
  brand: AnalysisField;
  product: AnalysisField;
  finish: AnalysisField;
  notes: AnalysisField;
  searchQuery: string;
};

type ReferenceCandidate = {
  title: string;
  pageUrl: string;
  imageUrl: string;
  sourceLabel: string;
  official: boolean;
  confidence: number;
  reason: string;
};

type UiItem = Omit<CollageItemInput, "imageKeys" | "imageNames"> & {
  uiKey: string;
  references: UiReference[];
  analysis?: ReferenceAnalysis;
  analysisStatus?: "idle" | "analyzing" | "ready" | "error";
  matchStatus?: "idle" | "searching" | "ready" | "error";
  candidates?: ReferenceCandidate[];
};

type DraftReference = Omit<UiReference, "preview">;

// The uploaded layout master, held in memory with its own object-URL preview.
type LayoutMasterState = { uiKey: string; name: string; file: File; preview: string };

// Persisted draft references keep only a pointer (fileKey) to the blob, which
// is stored under its own IndexedDB key. This lets a metadata-only change
// (editing a note, toggling a setting) rewrite the small record without
// re-serializing every full-quality reference image.
type PersistedReference = Omit<DraftReference, "file"> & { fileKey: string };
type PersistedItem = Omit<DraftItem, "references" | "files"> & { references: PersistedReference[] };
type StoredDraft = Omit<SavedDraft, "items" | "layoutMaster"> & {
  format: "split";
  items: PersistedItem[];
  // The layout master's blob lives under its own key like any reference blob,
  // so a metadata-only save does not rewrite it.
  layoutMaster?: { uiKey: string; name: string; fileKey: string };
};

type DraftItem = Omit<CollageItemInput, "imageKeys" | "imageNames"> & {
  uiKey?: string;
  references?: DraftReference[];
  files?: File[];
  analysis?: ReferenceAnalysis;
};

type SavedDraft = {
  version?: number;
  collageType: CollageType;
  orientation: Orientation;
  quality: Quality;
  background?: Background;
  outputResolution?: OutputResolution;
  composition?: Composition;
  density?: Density;
  styling?: StylingOption;
  lighting?: LightingOption;
  heroItemId?: string;
  outputFilename: string;
  // A previous collage the user supplied as the definitive layout. Absent on
  // boards that use the art-direction composition/spacing settings instead.
  layoutMaster?: { uiKey: string; name: string; file: File };
  items: DraftItem[];
  savedAt: number;
};

type GenerateResponse = {
  ok: boolean;
  error?: string;
  code?: string;
  summary?: string;
  prompt?: string;
  imageBase64?: string;
  mimeType?: string;
  filename?: string;
  notice?: string;
  jobId?: string;
  libraryVisible?: boolean;
  renderKind?: "draft" | "studio" | "final";
  diagnostics?: GenerationDiagnostics;
  diagnosticComplete?: boolean;
  isolationResults?: Array<{ referenceCount: number; outcome: "succeeded" | "failed"; requestId?: string; error?: string }>;
  model?: string;
  quality?: string;
  background?: Background;
  outputFormat?: string;
  costUsd?: number | null;
  // OpenAI's usage block, passed through by the route; read only to calibrate
  // the paid buttons' estimates (recordUsageCalibration).
  usage?: Record<string, unknown>;
};

type GenerationJob = {
  id: string;
  mode: string;
  status: string;
  filename: string;
  format: string;
  renderKind: "draft" | "studio" | "final";
  collageType: string;
  libraryVisible: boolean;
  title: string;
  estimatedUsd: number | null;
  costUsd: number | null;
  model: string | null;
  quality: string | null;
  background: string | null;
  outputFormat: string | null;
  usage: Record<string, unknown> | null;
  error: string | null;
  createdAt: number;
};

// The final render accepts the same orientations as the draft; "default" is a
// board-level shorthand that is already resolved by the time a draft exists.
type FinalFormat = Exclude<Orientation, "default">;

const FINAL_FORMATS: FinalFormat[] = ["landscape", "portrait", "square"];

// Read the label off resolvedSize's "final" branch so the switch can never
// advertise a canvas different from the one the request asks for.
function finalSizeFor(format: FinalFormat, collageType: CollageType) {
  return resolvedSize({ collageType, orientation: format, quality: "high", outputResolution: "final", items: [] });
}

// What a Quick Draft forces over the board's settings. generate()'s
// renderPayload sends exactly this, and the Quick Draft cost estimate prices
// exactly this, so the two cannot drift apart.
const QUICK_DRAFT_OVERRIDES = { quality: "low", outputResolution: "standard" } as const satisfies Partial<CollageRequestInput>;

// A Final keeps an explicit xhigh/max and otherwise runs at high. Shared by
// finalizeDraft and the Final button's cost estimate.
function finalRenderQuality(quality: Quality): Quality {
  return quality === "xhigh" || quality === "max" ? quality : "high";
}

// Joins activity-log messages with a blank line between them. Line breaks
// can collapse (and a screen reader reads straight through them), so a part
// that does not already end a sentence gets a full stop: "Generation failed:
// Stubbed failure. Draft failed after 0:02, low quality." Empty parts drop.
function joinLogSentences(parts: Array<string | null | undefined | false>): string {
  const kept = parts.map((part) => (part ? part.trim() : "")).filter(Boolean);
  return kept
    .map((part, index) => (index < kept.length - 1 && !/[.!?…]["'”’)\]]*$/.test(part) ? `${part}.` : part))
    .join("\n\n");
}

type ResultState = {
  dataUrl: string;
  filename: string;
  kind: "draft" | "studio" | "final";
  jobId?: string;
  libraryVisible: boolean;
  /**
   * The isolation test's output: shown on its own, never compared against
   * the board render, and never kept as the "previous" image a later render
   * is compared with.
   */
  diagnostic?: boolean;
};

type GenerationDiagnostics = {
  model: string;
  transport: string;
  quality: string;
  background?: string;
  outputFormat?: string;
  referenceCount: number;
  totalReferenceBytes: number;
  largestReferenceBytes: number;
  references: Array<{ filename: string; bytes: number; mimeType: string }>;
  attempts: Array<{
    stage: string;
    outcome: string;
    attempt: number;
    durationMs: number;
    size?: string;
    status?: number;
    code?: string;
    requestId?: string;
    error?: string;
  }>;
};

const DRAFT_DB_NAME = "material-collager-drafts";
const DRAFT_STORE_NAME = "drafts";
const CURRENT_DRAFT_KEY = "current";
const BLOB_KEY_PREFIX = "blob:";
const blobKey = (fileKey: string) => `${BLOB_KEY_PREFIX}${fileKey}`;

function createUiKey() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function createReference(file: File, metadata?: Partial<UiReference>): UiReference {
  return {
    uiKey: createUiKey(),
    file,
    preview: URL.createObjectURL(file),
    primary: false,
    provenance: "upload",
    ...metadata,
  };
}

// The visible text is the field's <label>; the help button sits beside it,
// not inside it (a <label> may hold only its own control), and the help text
// is the input's description.
function FieldLabel({ text, help, htmlFor }: { text: string; help: string; htmlFor: string }) {
  return (
    <span className="field-label">
      <label htmlFor={htmlFor}>{text}</label>
      <span className="help-wrap">
        <button type="button" className="help-button" aria-label={`${text}: ${help}`}>?</button>
        <span className="field-help" role="tooltip" id={`${htmlFor}-help`}>{help}</span>
      </span>
    </span>
  );
}

function resolvedItemId(item: UiItem, index: number) {
  return item.id || slugify(item.role || `item_${index + 1}`);
}

function openDraftDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DRAFT_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DRAFT_STORE_NAME)) {
        db.createObjectStore(DRAFT_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open saved drafts."));
  });
}

async function readSavedDraft() {
  const db = await openDraftDatabase();
  return new Promise<SavedDraft | null>((resolve, reject) => {
    const transaction = db.transaction(DRAFT_STORE_NAME, "readonly");
    const store = transaction.objectStore(DRAFT_STORE_NAME);
    const metaRequest = store.get(CURRENT_DRAFT_KEY);
    const blobRequests: Array<{ fileKey: string; request: IDBRequest }> = [];
    metaRequest.onsuccess = () => {
      const record = metaRequest.result as (StoredDraft & { format?: string }) | undefined;
      if (record?.format !== "split") return;
      // Issue the blob reads within this same transaction so it stays open.
      for (const item of record.items) {
        for (const reference of item.references) {
          blobRequests.push({ fileKey: reference.fileKey, request: store.get(blobKey(reference.fileKey)) });
        }
      }
      if (record.layoutMaster) {
        blobRequests.push({ fileKey: record.layoutMaster.fileKey, request: store.get(blobKey(record.layoutMaster.fileKey)) });
      }
    };
    transaction.oncomplete = () => {
      db.close();
      const record = metaRequest.result as (SavedDraft & { format?: string }) | undefined;
      if (!record) return resolve(null);
      // Legacy drafts stored the File inline on each reference — return as-is.
      if (record.format !== "split") return resolve(record as SavedDraft);
      const blobs = new Map<string, File>();
      for (const { fileKey, request } of blobRequests) {
        const file = request.result as File | undefined;
        if (file) blobs.set(fileKey, file);
      }
      const stored = record as unknown as StoredDraft;
      const items = stored.items.map((item) => ({
        ...item,
        references: item.references
          .filter((reference) => blobs.has(reference.fileKey))
          .map(({ fileKey, ...reference }) => ({ ...reference, file: blobs.get(fileKey)! })),
      }));
      // A layout master whose blob went missing is dropped rather than
      // restored half-formed; the board then falls back to its composition
      // and spacing settings.
      const layoutBlob = stored.layoutMaster ? blobs.get(stored.layoutMaster.fileKey) : undefined;
      const layoutMaster = stored.layoutMaster && layoutBlob
        ? { uiKey: stored.layoutMaster.uiKey, name: stored.layoutMaster.name, file: layoutBlob }
        : undefined;
      resolve({ ...stored, items, layoutMaster } as unknown as SavedDraft);
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error || new Error("Could not read saved draft."));
    };
  });
}

async function writeSavedDraft(draft: SavedDraft) {
  const db = await openDraftDatabase();
  const blobsByKey = new Map<string, File>();
  const { layoutMaster, ...draftWithoutLayout } = draft;
  let storedLayoutMaster: StoredDraft["layoutMaster"];
  if (layoutMaster) {
    // Namespaced so a layout master and a reference can never collide on key.
    const fileKey = `layout-${layoutMaster.uiKey}`;
    blobsByKey.set(fileKey, layoutMaster.file);
    storedLayoutMaster = { uiKey: layoutMaster.uiKey, name: layoutMaster.name, fileKey };
  }
  const stored: StoredDraft = {
    ...draftWithoutLayout,
    format: "split",
    layoutMaster: storedLayoutMaster,
    items: draft.items.map((item) => {
      const { files: _legacyFiles, references = [], ...rest } = item;
      return {
        ...rest,
        references: references.map((reference) => {
          // Key the blob by the reference's unique uiKey, not the file
          // fingerprint: two genuinely different files can share
          // name/size/lastModified/type, and a fingerprint key would merge
          // them so both restore to the same image.
          const fileKey = reference.uiKey;
          blobsByKey.set(fileKey, reference.file);
          const { file: _file, ...meta } = reference;
          return { ...meta, fileKey };
        }),
      };
    }),
  };
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(DRAFT_STORE_NAME, "readwrite");
    const store = transaction.objectStore(DRAFT_STORE_NAME);
    store.put(stored, CURRENT_DRAFT_KEY);
    const keysRequest = store.getAllKeys();
    keysRequest.onsuccess = () => {
      const existing = new Set((keysRequest.result as IDBValidKey[]).map(String));
      const needed = new Set<string>();
      // Write each blob only if it isn't already stored — the expensive part.
      for (const [fileKey, file] of blobsByKey) {
        const key = blobKey(fileKey);
        needed.add(key);
        if (!existing.has(key)) store.put(file, key);
      }
      // Drop blobs no longer referenced by the current board.
      for (const key of existing) {
        if (key.startsWith(BLOB_KEY_PREFIX) && !needed.has(key)) store.delete(key);
      }
    };
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error || new Error("Could not save draft."));
    };
  });
}

async function removeSavedDraft() {
  const db = await openDraftDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(DRAFT_STORE_NAME, "readwrite");
    // Clear the metadata record and every stored blob, not just the record.
    transaction.objectStore(DRAFT_STORE_NAME).clear();
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error || new Error("Could not clear saved draft."));
    };
  });
}

function presetItems(type: CollageType): UiItem[] {
  return ITEM_PRESETS[type].map((item) => ({
    ...item,
    uiKey: createUiKey(),
    brand: "",
    name: "",
    finish: "",
    notes: "",
    references: [],
  }));
}

export default function Home() {
  const [collageType, setCollageType] = useState<CollageType>("bathroom_fixture_collage");
  const [orientation, setOrientation] = useState<Orientation>("default");
  const [quality, setQuality] = useState<Quality>("high");
  const [background, setBackground] = useState<Background>("opaque");
  const [outputResolution, setOutputResolution] = useState<OutputResolution>("studio");
  const [composition, setComposition] = useState<Composition>("editorial");
  const [density, setDensity] = useState<Density>("balanced");
  const [styling, setStyling] = useState<StylingOption>("botanical_linen");
  const [lighting, setLighting] = useState<LightingOption>("soft_daylight");
  const [heroItemId, setHeroItemId] = useState("");
  const [outputFilename, setOutputFilename] = useState("material-collage.png");
  const [layoutMaster, setLayoutMaster] = useState<LayoutMasterState | null>(null);
  const layoutPreviewRef = useRef<string | null>(null);
  const apiKey = "";
  const [items, setItems] = useState<UiItem[]>(() => presetItems("bathroom_fixture_collage"));
  // The item cards' label/input ids come from useId, not item.uiKey: uiKey is
  // random, so the server-rendered HTML and the first client render would
  // disagree and React would report a hydration mismatch. useId matches on
  // both sides, and the card's index keeps each card's ids unique.
  const fieldIdPrefix = useId();
  const itemFieldId = (index: number) => `${fieldIdPrefix}-item${index}`;
  const [panelText, setPanelText] = useState("Board ready.");
  const [diagnostics, setDiagnostics] = useState<GenerationDiagnostics | null>(null);
  const [promptPreview, setPromptPreview] = useState("");
  const [isWorking, setIsWorking] = useState(false);
  // The render API returns one finished image with no progress stream, so the
  // dither holds while working and then resolves once, driven from here.
  const [revealProgress, setRevealProgress] = useState(1);
  // Presentation only: which result's reveal has finished, for the one-shot
  // completion sweep (.result-stage.is-lifted). No render path touches this.
  // - Cleared on the rising edge of isWorking (adjusting state during render,
  //   not in an effect), so a working cycle that ends WITHOUT a new result --
  //   cancel or failure -- can't re-add the class over the old
  //   image when isWorking drops.
  // - sweptResultRef makes it once per result: that old image re-reveals and
  //   settles again after such a cycle, and must not sweep a second time.
  const [liftedFor, setLiftedFor] = useState<string | null>(null);
  const [liftWasWorking, setLiftWasWorking] = useState(isWorking);
  if (isWorking !== liftWasWorking) {
    setLiftWasWorking(isWorking);
    if (isWorking) setLiftedFor(null);
  }
  const sweptResultRef = useRef<string | null>(null);
  // Presentation only: reference thumbnails on screen when they first appear
  // dissolve on load; the rest print in as their strip scrolls into view
  // (effects.css, mc-print-later / .mc-print-scope).
  const itemsListRef = useRef<HTMLDivElement | null>(null);
  const referencePrintLater = usePrintInLater(
    itemsListRef,
    items.map((item) => item.references.map((reference) => reference.uiKey).join(",")).join("|"),
  );

  const [workingStage, setWorkingStage] = useState("");
  const [overallProgress, setOverallProgress] = useState(0);
  // Elapsed time of the paid render in flight (app/components/RenderClock.tsx).
  // Separate from isWorking: the prompt review (dryRun) also sets isWorking
  // but is not a render, so it shows no clock and records nothing.
  // renderClock.lastElapsedMs holds the duration of the render that last
  // finished successfully.
  const renderClock = useRenderClock();
  // The receipt of the render that last landed or failed (ReceiptStamp.tsx),
  // pinned to the stage's bottom edge. Null until a render ends, so nothing
  // renders on the server. `id` changes per receipt and keys the stamp, which
  // replays its arrival on mount. Cleared when a render starts and whenever
  // the result is cleared (board reset, type change, draft restore).
  const [lastReceipt, setLastReceipt] = useState<{ id: number; input: RenderReceiptInput } | null>(null);
  const receiptIdRef = useRef(0);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [result, setResult] = useState<ResultState | null>(null);
  // Which result's compare wipe, and which receipt's arrival, have already
  // played. The stage hides both while working, so whatever is still set
  // when work starts (a prompt review, a Final that is then cancelled or
  // fails) has been on screen; marking it on that rising edge (adjusting
  // state during render, not in an effect) makes its re-mount settled -- no
  // second wipe, dither-in or count-up. Marked only while unmounted, so a
  // stage on screen never sees its playArrival flip (CompareStage would
  // snap a drag made during the wipe back to rest). A newly landed result
  // or receipt has a new identity and arrives once.
  const [compareSettledFor, setCompareSettledFor] = useState<string | null>(null);
  const [settledReceiptId, setSettledReceiptId] = useState<number | null>(null);
  const [arrivalWasWorking, setArrivalWasWorking] = useState(isWorking);
  if (isWorking !== arrivalWasWorking) {
    setArrivalWasWorking(isWorking);
    if (isWorking && result && compareSettledFor !== result.dataUrl) setCompareSettledFor(result.dataUrl);
    if (isWorking && lastReceipt && settledReceiptId !== lastReceipt.id) setSettledReceiptId(lastReceipt.id);
  }
  const resultUrlRef = useRef<string | null>(null);
  // The result image a new render displaced, shown under it by CompareStage.
  // The ref owns the blob URL (revoked only when a newer previous displaces
  // it, when the result is cleared, and on unmount); the state drives render.
  const previousUrlRef = useRef<string | null>(null);
  const [previousResultUrl, setPreviousResultUrl] = useState<string | null>(null);
  const replacePreviousUrl = (url: string | null) => {
    if (previousUrlRef.current && previousUrlRef.current !== url) URL.revokeObjectURL(previousUrlRef.current);
    previousUrlRef.current = url;
    setPreviousResultUrl(url);
  };
  // Store the generated image as an object URL, not a multi-MB base64 string
  // held in React state and diffed into DOM attributes on every re-render.
  // A new result keeps the outgoing one as the "previous" image; clearing
  // (next === null) revokes both and drops the receipt.
  // True while the image resultUrlRef owns is an isolation-test output
  // (ResultState.diagnostic). Such an image is revoked when displaced, never
  // kept as the previous one, so the last real render stays the comparison.
  const resultIsDiagnosticRef = useRef(false);
  const commitResult = (next: ResultState | null) => {
    const outgoing = resultUrlRef.current;
    if (!next) {
      replacePreviousUrl(null);
      if (outgoing) URL.revokeObjectURL(outgoing);
      resultUrlRef.current = null;
      setLastReceipt(null);
    } else if (outgoing && outgoing !== next.dataUrl) {
      if (resultIsDiagnosticRef.current) URL.revokeObjectURL(outgoing);
      else replacePreviousUrl(outgoing);
      resultUrlRef.current = null;
    }
    if (next?.dataUrl.startsWith("blob:")) resultUrlRef.current = next.dataUrl;
    resultIsDiagnosticRef.current = Boolean(next?.diagnostic);
    setResult(next);
    if (next) {
      // Hold the new image as ink for a beat, then let the dither resolve it.
      setRevealProgress(0);
      window.setTimeout(() => setRevealProgress(1), 80);
    }
  };
  // generate() empties the stage while it renders (no Download or Finalize
  // for the image being replaced). Unlike commitResult(null), the outgoing
  // image is kept as the previous one, so the new render can be compared
  // against it when it lands. A failed or cancelled render leaves it held
  // (not displayed) until it is displaced, cleared or the page unmounts.
  const setAsideResultForCompare = () => {
    const outgoing = resultUrlRef.current;
    if (outgoing) {
      // An isolation-test image is dropped, not compared against: the
      // previous real render (if any) stays the comparison.
      if (resultIsDiagnosticRef.current) URL.revokeObjectURL(outgoing);
      else replacePreviousUrl(outgoing);
      resultUrlRef.current = null;
    }
    resultIsDiagnosticRef.current = false;
    setResult(null);
    setLastReceipt(null);
  };
  // Shows a render's receipt on the stage and returns the sentence the
  // activity log announces for it (once, with the completion message).
  const landReceipt = (input: RenderReceiptInput): string => {
    receiptIdRef.current += 1;
    setLastReceipt({ id: receiptIdRef.current, input });
    return receiptAnnouncement(input);
  };
  const [finalFormat, setFinalFormat] = useState<FinalFormat>("landscape");
  const [jobs, setJobs] = useState<GenerationJob[]>([]);
  const hasLoadedDraft = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  // Token per item so a slower analyze response for a superseded reference
  // can't overwrite the fields of whatever is primary now.
  const analyzeTokens = useRef<Map<string, number>>(new Map());
  const analysisCache = useRef<Map<string, ReferenceAnalysis>>(new Map());

  const totalReferences = useMemo(
    () => items.reduce((total, item) => total + item.references.length, 0),
    [items],
  );
  const totalReferenceBytes = useMemo(
    () => items.reduce((total, item) => total + item.references.reduce((sum, ref) => sum + ref.file.size, 0), 0),
    [items],
  );
  const hasFiles = totalReferences > 0;
  // Whole-card drop targets for the reference tray (SlotDrop.tsx). A full
  // board still takes the drop (addReferences then shows its limit message);
  // it is only never shown armed.
  const slotDrop = useSlotDropTargets();
  const canAccept = totalReferences < (layoutMaster ? MAX_REFERENCE_IMAGES - 1 : MAX_REFERENCE_IMAGES);
  const heroOptions = useMemo(() => items.filter((item) => item.references.length > 0), [items]);
  const [previewWidth, previewHeight] = resolvedSize({ collageType, orientation, quality, outputResolution, items: [] })
    .split("x")
    .map(Number);

  // Bumped after a render's usage is recorded, so the estimates below re-read
  // the calibration that render just taught (it lives in localStorage, which
  // no other dependency here tracks).
  const [costCalibrationRevision, setCostCalibrationRevision] = useState(0);
  // Live estimates for the three paid buttons (app/lib/collage-cost.ts). Each
  // basis -- canvas, quality, images uploaded -- is built from the same
  // settings and overrides its action sends, and is what that action records
  // calibration against once the render succeeds. breakdown is null when the
  // estimator has no honest figure (xhigh/max/auto), shown as "usage-based".
  const renderCostEstimates = useMemo(() => {
    const board: CollageRequestInput = { collageType, orientation, quality, outputResolution, items: [] };
    // generate() uploads the layout master ahead of the references, for the
    // studio render and the quick draft alike.
    const boardImages = totalReferences + (layoutMaster ? 1 : 0);
    const studio = collageRenderCostBasis({ ...board, renderKind: "studio" }, boardImages);
    const draft = collageRenderCostBasis({ ...board, ...QUICK_DRAFT_OVERRIDES, renderKind: "draft" }, boardImages);
    // finalizeDraft uploads the approved draft as Image 1 plus every product
    // reference; the board's layout master is not sent with a Final.
    const final = collageRenderCostBasis(
      { ...board, orientation: finalFormat, quality: finalRenderQuality(quality), outputResolution: "final", renderKind: "final" },
      totalReferences + 1,
    );
    return {
      calibrationRevision: costCalibrationRevision,
      studio: { basis: studio, breakdown: estimateCollageRenderCost(studio) },
      draft: { basis: draft, breakdown: estimateCollageRenderCost(draft) },
      final: { basis: final, breakdown: estimateCollageRenderCost(final) },
    };
  }, [collageType, orientation, quality, outputResolution, finalFormat, totalReferences, layoutMaster, costCalibrationRevision]);

  useEffect(() => {
    let cancelled = false;
    void navigator.storage?.persist?.();
    readSavedDraft()
      .then((draft) => {
        if (cancelled) return;
        if (draft) {
          restoreDraft(draft);
          setPanelText(`Draft restored from ${new Date(draft.savedAt).toLocaleString()}.`);
          setLastSavedAt(draft.savedAt);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setPanelText(`Draft storage is unavailable: ${error instanceof Error ? error.message : "Could not read draft."}`);
        }
      })
      .finally(() => {
        if (!cancelled) hasLoadedDraft.current = true;
      });

    return () => {
      cancelled = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // Every job is written terminal by the request that rendered it, so one
    // load (plus the refresh after each render) keeps History current.
    void refreshJobs();
  }, []);

  useEffect(() => () => {
    if (resultUrlRef.current) URL.revokeObjectURL(resultUrlRef.current);
    if (previousUrlRef.current) URL.revokeObjectURL(previousUrlRef.current);
  }, []);

  useEffect(() => {
    if (!hasLoadedDraft.current) return;
    const timeout = window.setTimeout(() => {
      void saveDraft(false);
    }, 900);
    return () => window.clearTimeout(timeout);
  }, [ // eslint-disable-line react-hooks/exhaustive-deps
    collageType,
    orientation,
    quality,
    background,
    outputResolution,
    composition,
    density,
    styling,
    lighting,
    heroItemId,
    outputFilename,
    layoutMaster,
    items,
  ]);

  // The layout master's preview is the one object URL not owned by an item, so
  // it needs its own unmount cleanup.
  useEffect(() => () => {
    if (layoutPreviewRef.current) URL.revokeObjectURL(layoutPreviewRef.current);
  }, []);

  function revokeItemPreviews(currentItems: UiItem[]) {
    for (const item of currentItems) {
      for (const reference of item.references) URL.revokeObjectURL(reference.preview);
    }
  }

  // Single entry point for setting/replacing/clearing the layout master, so the
  // previous preview URL is always revoked exactly once.
  function applyLayoutMaster(next: { uiKey: string; name: string; file: File } | null) {
    if (layoutPreviewRef.current) URL.revokeObjectURL(layoutPreviewRef.current);
    if (!next) {
      layoutPreviewRef.current = null;
      setLayoutMaster(null);
      return;
    }
    const preview = URL.createObjectURL(next.file);
    layoutPreviewRef.current = preview;
    setLayoutMaster({ ...next, preview });
  }

  function chooseLayoutMaster(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setPanelText("The layout reference must be an image file.");
      return;
    }
    if (file.size >= MAX_REFERENCE_FILE_BYTES) {
      setPanelText(`The layout reference must be under ${formatBytes(MAX_REFERENCE_FILE_BYTES)}.`);
      return;
    }
    applyLayoutMaster({ uiKey: createUiKey(), name: file.name, file });
    setPanelText("Layout reference set. Composition and spacing now follow this collage instead of the art-direction presets.");
  }

  function changeType(nextType: CollageType) {
    if (hasFiles && !window.confirm("Change board type and remove the references currently on this board?")) return;
    revokeItemPreviews(items);
    setItems(presetItems(nextType));
    setCollageType(nextType);
    setOrientation("default");
    setStyling(nextType === "appliance_collage" ? "materials_only" : "botanical_linen");
    setHeroItemId("");
    commitResult(null);
    setDiagnostics(null);
    setPromptPreview("");
    setPanelText("Board ready.");
  }

  function resetPreset() {
    if (hasFiles && !window.confirm("Reset this board and remove its current references?")) return;
    revokeItemPreviews(items);
    setItems(presetItems(collageType));
    setHeroItemId("");
    commitResult(null);
    setPromptPreview("");
    setPanelText("Preset reset.");
  }

  function updateItem(itemKey: string, patch: Partial<UiItem>) {
    setItems((current) => current.map((item) => (item.uiKey === itemKey ? { ...item, ...patch } : item)));
  }

  function applyAnalysisSuggestion(itemKey: string, field: "role" | "brand" | "name" | "finish" | "notes", value: string) {
    setItems((current) => current.map((item) => {
      if (item.uiKey !== itemKey || item[field]?.trim()) return item;
      return { ...item, [field]: value };
    }));
  }

  function applyAnalysis(itemKey: string, token: number, analysis: ReferenceAnalysis, roleForMessage: string) {
    if (analyzeTokens.current.get(itemKey) !== token) return;
    setItems((current) => current.map((item) => item.uiKey === itemKey ? {
      ...item,
      role: item.role.trim() || (analysis.itemType.confidence >= 70 ? analysis.itemType.value : ""),
      brand: item.brand?.trim() ? item.brand : (analysis.brand.confidence >= 70 ? analysis.brand.value : ""),
      name: item.name?.trim() ? item.name : (analysis.product.confidence >= 70 ? analysis.product.value : ""),
      finish: item.finish?.trim() ? item.finish : (analysis.finish.confidence >= 70 ? analysis.finish.value : ""),
      notes: item.notes?.trim() ? item.notes : (analysis.notes.confidence >= 70 ? analysis.notes.value : ""),
      analysis,
      analysisStatus: "ready",
    } : item));
    setPanelText(`Reference analyzed for ${roleForMessage || "this item"}. Review the suggested details before generating.`);
  }

  async function analyzePrimaryReference(itemKey: string, file: File) {
    const currentItem = items.find((item) => item.uiKey === itemKey);
    if (!currentItem) return;
    const token = (analyzeTokens.current.get(itemKey) ?? 0) + 1;
    analyzeTokens.current.set(itemKey, token);
    const cached = analysisCache.current.get(fileFingerprint(file));
    if (cached) {
      updateItem(itemKey, { candidates: [], matchStatus: "idle" });
      applyAnalysis(itemKey, token, cached, currentItem.role);
      return;
    }
    updateItem(itemKey, { analysisStatus: "analyzing", candidates: [], matchStatus: "idle" });
    try {
      const optimized = await optimizeReferenceForTransport(file, 450 * 1024);
      const form = new FormData();
      form.append("apiKey", apiKey);
      form.append("itemType", currentItem.role);
      form.append("image", optimized, optimized.name);
      const response = await fetch("/api/references/analyze", { method: "POST", body: form })
        .then((value) => readApiResponse<{ ok: boolean; error?: string; analysis: ReferenceAnalysis }>(value));
      analysisCache.current.set(fileFingerprint(file), response.analysis);
      applyAnalysis(itemKey, token, response.analysis, currentItem.role);
    } catch (error) {
      // Only report failure if this is still the item's latest request.
      if (analyzeTokens.current.get(itemKey) !== token) return;
      updateItem(itemKey, { analysisStatus: "error" });
      setPanelText(`Reference analysis failed: ${error instanceof Error ? error.message : "Could not analyze image."}`);
    }
  }

  async function findReferenceMatches(itemKey: string) {
    const item = items.find((candidate) => candidate.uiKey === itemKey);
    if (!item?.analysis?.searchQuery) return;
    updateItem(itemKey, { matchStatus: "searching", candidates: [] });
    try {
      const response = await fetch("/api/references/matches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey, query: item.analysis.searchQuery, itemType: item.role }),
      }).then((value) => readApiResponse<{ ok: boolean; error?: string; candidates: ReferenceCandidate[] }>(value));
      updateItem(itemKey, { matchStatus: "ready", candidates: response.candidates });
      setPanelText(response.candidates.length ? "Possible references found. Review each source before adding it." : "No reliable matching references were found.");
    } catch (error) {
      updateItem(itemKey, { matchStatus: "error" });
      setPanelText(`Reference search failed: ${error instanceof Error ? error.message : "Could not search references."}`);
    }
  }

  async function acceptReferenceCandidate(itemKey: string, candidate: ReferenceCandidate) {
    if (!candidate.imageUrl) return;
    if (totalReferences >= MAX_REFERENCE_IMAGES) {
      setPanelText(`This board can use up to ${MAX_REFERENCE_IMAGES} reference images. Remove one before adding this suggestion.`);
      return;
    }
    try {
      const response = await fetch("/api/references/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrl: candidate.imageUrl }),
      });
      if (!response.ok) {
        const payload = await response.json() as { error?: string };
        throw new Error(payload.error || "Could not import suggested image.");
      }
      const blob = await response.blob();
      const extension = blob.type === "image/png" ? "png" : blob.type === "image/webp" ? "webp" : "jpg";
      const file = new File([blob], `${slugify(candidate.title)}.${extension}`, { type: blob.type, lastModified: Date.now() });
      setItems((current) => current.map((item) => item.uiKey === itemKey ? {
        ...item,
        references: [...item.references, createReference(file, {
          sourceUrl: candidate.pageUrl,
          sourceLabel: candidate.sourceLabel,
          provenance: "investigation",
        })],
        candidates: item.candidates?.filter((entry) => entry.pageUrl !== candidate.pageUrl),
      } : item));
      setPanelText(`${candidate.title} added as a supporting reference.`);
    } catch (error) {
      setPanelText(`Suggested reference could not be added: ${error instanceof Error ? error.message : "Import failed."}`);
    }
  }

  function addItem() {
    setItems((current) => [
      ...current,
      {
        id: `item_${current.length + 1}`,
        role: "",
        brand: "",
        name: "",
        finish: "",
        notes: "",
        required: true,
        uiKey: createUiKey(),
        references: [],
      },
    ]);
  }

  function removeItem(itemKey: string) {
    const item = items.find((candidate) => candidate.uiKey === itemKey);
    if (!item) return;
    if (item.references.length > 0 && !window.confirm(`Remove ${item.id || item.role} and its reference images?`)) return;
    for (const reference of item.references) URL.revokeObjectURL(reference.preview);
    setItems((current) => current.filter((candidate) => candidate.uiKey !== itemKey));
    if (heroItemId === item.id) setHeroItemId("");
  }

  function addReferences(itemKey: string, fileList: FileList | File[] | null) {
    const files = Array.from(fileList ?? []);
    if (!files.length) return;
    if (totalReferences + files.length > MAX_REFERENCE_IMAGES) {
      setPanelText(`This board can use up to ${MAX_REFERENCE_IMAGES} reference images. Remove a reference before adding this batch.`);
      return;
    }
    const invalid = files.find(
      (file) => !["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size >= MAX_REFERENCE_FILE_BYTES,
    );
    if (invalid) {
      setPanelText(`${invalid.name} must be a PNG, JPEG, or WebP image under 50 MB.`);
      return;
    }

    const currentItem = items.find((item) => item.uiKey === itemKey);
    const isPrimaryUpload = !currentItem?.references.length;
    setItems((current) =>
      current.map((item) =>
        item.uiKey === itemKey
          ? {
              ...item,
              references: [...item.references, ...files.map((file, index) => createReference(file, {
                primary: isPrimaryUpload && index === 0,
              }))],
            }
          : item,
      ),
    );
    setPanelText(`${files.length} reference image${files.length === 1 ? "" : "s"} added.`);
    if (isPrimaryUpload) void analyzePrimaryReference(itemKey, files[0]);
  }

  function replaceReference(itemKey: string, referenceKey: string, fileList: FileList | null) {
    const file = fileList?.[0];
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size >= MAX_REFERENCE_FILE_BYTES) {
      setPanelText(`${file.name} must be a PNG, JPEG, or WebP image under 50 MB.`);
      return;
    }
    const item = items.find((candidate) => candidate.uiKey === itemKey);
    const existing = item?.references.find((reference) => reference.uiKey === referenceKey);
    if (!existing) return;
    URL.revokeObjectURL(existing.preview);
    const replacement = createReference(file, { primary: existing.primary, provenance: "upload" });
    setItems((current) => current.map((candidate) => candidate.uiKey === itemKey ? {
      ...candidate,
      references: candidate.references.map((reference) => reference.uiKey === referenceKey ? replacement : reference),
    } : candidate));
    if (existing.primary || item?.references[0]?.uiKey === referenceKey) void analyzePrimaryReference(itemKey, file);
  }

  function removeReference(itemKey: string, referenceKey: string) {
    const item = items.find((candidate) => candidate.uiKey === itemKey);
    if (item?.id === heroItemId && item.references.length === 1) setHeroItemId("");
    const removedPrimary = item?.references[0]?.uiKey === referenceKey;
    const nextPrimary = removedPrimary ? item?.references.find((reference) => reference.uiKey !== referenceKey) : undefined;
    setItems((current) =>
      current.map((item) => {
        if (item.uiKey !== itemKey) return item;
        const reference = item.references.find((candidate) => candidate.uiKey === referenceKey);
        if (reference) URL.revokeObjectURL(reference.preview);
        const references = item.references.filter((candidate) => candidate.uiKey !== referenceKey);
        return {
          ...item,
          references: references.map((candidate, index) => ({ ...candidate, primary: index === 0 })),
          ...(references.length ? {} : { analysis: undefined, analysisStatus: "idle" as const, candidates: [], matchStatus: "idle" as const }),
        };
      }),
    );
    if (nextPrimary) void analyzePrimaryReference(itemKey, nextPrimary.file);
  }

  function makePrimary(itemKey: string, referenceKey: string) {
    const selectedFile = items
      .find((item) => item.uiKey === itemKey)
      ?.references.find((reference) => reference.uiKey === referenceKey)?.file;
    setItems((current) =>
      current.map((item) => {
        if (item.uiKey !== itemKey) return item;
        const selected = item.references.find((reference) => reference.uiKey === referenceKey);
        if (!selected) return item;
        return {
          ...item,
          references: [
            { ...selected, primary: true },
            ...item.references.filter((reference) => reference.uiKey !== referenceKey).map((reference) => ({ ...reference, primary: false })),
          ],
        };
      }),
    );
    if (selectedFile) void analyzePrimaryReference(itemKey, selectedFile);
  }

  function makeDraft(): SavedDraft {
    return {
      version: 2,
      collageType,
      orientation,
      quality,
      background,
      outputResolution,
      composition,
      density,
      styling,
      lighting,
      heroItemId,
      outputFilename,
      layoutMaster: layoutMaster
        ? { uiKey: layoutMaster.uiKey, name: layoutMaster.name, file: layoutMaster.file }
        : undefined,
      savedAt: Date.now(),
      items: items.map((item) => ({
        id: item.id,
        role: item.role,
        brand: item.brand,
        name: item.name,
        finish: item.finish,
        notes: item.notes,
        required: item.required,
        uiKey: item.uiKey,
        analysis: item.analysis,
        references: item.references.map((reference) => ({
          uiKey: reference.uiKey,
          file: reference.file,
          primary: reference.primary,
          sourceUrl: reference.sourceUrl,
          sourceLabel: reference.sourceLabel,
          provenance: reference.provenance,
        })),
      })),
    };
  }

  function restoreDraft(draft: SavedDraft) {
    // Build the next items (allocating object URLs) once, outside the state
    // updater — React can invoke an updater more than once, which would leak a
    // duplicate object URL per reference.
    revokeItemPreviews(items);
    const nextItems: UiItem[] = draft.items.map((item) => {
      const savedReferences: DraftReference[] = item.references?.length
        ? item.references
        : (item.files ?? []).map((file) => ({ uiKey: createUiKey(), file, primary: false, provenance: "upload" }));
      return {
        id: item.id,
        role: item.role,
        brand: item.brand ?? "",
        name: item.name ?? "",
        finish: item.finish ?? "",
        notes: item.notes ?? "",
        required: item.required,
        uiKey: item.uiKey || createUiKey(),
        analysis: item.analysis,
        analysisStatus: item.analysis ? "ready" : "idle",
        references: savedReferences
          .sort((left, right) => Number(Boolean(right.primary)) - Number(Boolean(left.primary)))
          .map((reference, index) => ({
            ...reference,
            primary: index === 0,
            uiKey: reference.uiKey || createUiKey(),
            preview: URL.createObjectURL(reference.file),
          })),
      };
    });
    setItems(nextItems);
    setCollageType(draft.collageType);
    setOrientation(draft.orientation);
    setQuality(draft.quality ?? "high");
    setBackground(draft.background ?? "opaque");
    setOutputResolution(draft.outputResolution ?? "studio");
    setComposition(draft.composition ?? "editorial");
    setDensity(draft.density ?? "balanced");
    setStyling(draft.collageType === "appliance_collage" ? "materials_only" : (draft.styling ?? "botanical_linen"));
    setLighting(draft.lighting ?? "soft_daylight");
    setHeroItemId(draft.heroItemId ?? "");
    setOutputFilename(draft.outputFilename);
    applyLayoutMaster(draft.layoutMaster ?? null);
    commitResult(null);
    setPromptPreview("");
  }

  async function saveDraft(showMessage: boolean) {
    try {
      const draft = makeDraft();
      await writeSavedDraft(draft);
      setLastSavedAt(draft.savedAt);
      if (showMessage) setPanelText("Draft saved with its full-quality reference images in this browser.");
    } catch (error) {
      setPanelText(`Draft save failed: ${error instanceof Error ? error.message : "Browser storage is full."}`);
    }
  }

  async function restoreSavedDraft() {
    try {
      const draft = await readSavedDraft();
      if (!draft) {
        setPanelText("No saved draft was found in this browser.");
        return;
      }
      restoreDraft(draft);
      setLastSavedAt(draft.savedAt);
      setPanelText(`Draft restored from ${new Date(draft.savedAt).toLocaleString()}.`);
    } catch (error) {
      setPanelText(`Draft restore failed: ${error instanceof Error ? error.message : "Could not restore draft."}`);
    }
  }

  async function clearSavedDraft() {
    try {
      await removeSavedDraft();
      setLastSavedAt(null);
      setPanelText("Saved browser draft deleted. The current board is unchanged.");
    } catch (error) {
      setPanelText(`Draft deletion failed: ${error instanceof Error ? error.message : "Could not delete draft."}`);
    }
  }

  function makePayload(includeApiKey: boolean): CollageRequestInput {
    return {
      collageType,
      orientation,
      quality,
      background,
      outputResolution,
      composition,
      density,
      styling: collageType === "appliance_collage" ? "materials_only" : styling,
      lighting,
      heroItemId: heroItemId || undefined,
      outputFilename,
      apiKey: includeApiKey ? apiKey : "",
      // A board-level layout master rides along as Image 1 on every render it
      // applies to. finalizeDraft overrides both fields, because there the
      // approved draft is the layout authority (and it was itself composed
      // under this master, so the arrangement carries through).
      ...(layoutMaster ? { layoutReference: true, layoutReferenceMode: "uploaded-collage" as const } : {}),
      items: items.map((item, index) => ({
        id: resolvedItemId(item, index),
        role: item.role,
        brand: item.brand,
        name: item.name,
        finish: item.finish,
        notes: item.notes,
        required: item.required,
        imageNames: item.references.map((reference) => reference.file.name),
      })),
    };
  }

  async function refreshJobs() {
    try {
      const response = await fetch("/api/jobs", { cache: "no-store" })
        .then((value) => readApiResponse<{ ok: boolean; error?: string; jobs: GenerationJob[] }>(value));
      setJobs(response.jobs);
    } catch {
      // History remains optional in local development before storage bindings exist.
    }
  }

  async function saveResultToLibrary() {
    if (!result?.jobId) return;
    try {
      const response = await fetch(`/api/library/${encodeURIComponent(result.jobId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visible: true }),
      }).then((value) => readApiResponse<{ ok: boolean; error?: string }>(value));
      if (response.ok) {
        setResult((current) => current ? { ...current, libraryVisible: true } : current);
        setPanelText("Saved to Library. This output will remain available for 6 months.");
        await refreshJobs();
      }
    } catch (error) {
      setPanelText(`Library save failed: ${error instanceof Error ? error.message : "Unknown error."}`);
    }
  }

  async function finalizeDraft() {
    if (!result) return;
    if (totalReferences > 15) {
      setPanelText("Final rendering can use the approved draft plus up to 15 product references. Remove one supporting view and retry.");
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setIsWorking(true);
    setOverallProgress(0);
    setLastReceipt(null);
    let transportFilesForReport: File[] | undefined;
    // Set immediately before the fetch: an error thrown earlier (validation,
    // optimisation, the size check) never left the browser and lands no
    // failure receipt. The parsed response is kept so a failure after a
    // billed reply (no image) still carries the cost it reported.
    let sent = false;
    let finalResponse: GenerateResponse | undefined;
    const finalQuality: Quality = finalRenderQuality(quality);
    renderClock.start(renderClockKey("generator", "final", finalQuality));
    // renderClock.startedAt is React state, still stale inside this closure;
    // the failure receipt measures from this local copy of the start instead.
    const renderStartedAt = Date.now();
    try {
      const layoutFile = await dataUrlFile(result.dataUrl, "approved-draft.png");

      // Immediate Final sends the approved draft plus the product references
      // directly as multipart, exactly like the Studio render, so it never
      // touches the OpenAI Uploads API (which returns 500 in this hosting
      // environment). The draft is sent first so the server treats it as the
      // layout reference.
      const payload: CollageRequestInput = {
        ...makePayload(false),
        orientation: finalFormat,
        quality: finalQuality,
        outputResolution: "final",
        layoutReference: true,
        // Image 1 is the approved draft here, never the board's uploaded
        // layout master — pin the mode so makePayload's value cannot leak in.
        layoutReferenceMode: "approved-draft",
        renderKind: "final",
      };
      validateCollageRequest(payload);
      const productFiles = items.flatMap((item) => item.references.map((reference) => reference.file));
      // The originals cannot go up untouched. The approved draft PNG alone is
      // several MB, and the edge runtime rejects the whole body past 32 MB
      // with a 413 BEFORE the route runs — which surfaced to the user as "a
      // reference chunk was rejected by the host" with no server diagnostics
      // at all. So budget the body here: the draft keeps a reserved slice and
      // the references divide what is left. The budget sits just under the
      // ceiling, so references stay near-original — this guards the 413, it
      // does not trade away the fidelity Final exists for.
      setWorkingStage("Optimizing references for the final render");
      const layoutTransport = await optimizeReferenceForTransport(layoutFile, FINAL_LAYOUT_REFERENCE_BUDGET);
      const referenceBudget = Math.max(
        DIRECT_REQUEST_REFERENCE_BUDGET,
        FINAL_REQUEST_BODY_BUDGET - layoutTransport.size,
      );
      const transportFiles = await optimizeReferencesForTransport(productFiles, referenceBudget);
      transportFilesForReport = transportFiles;
      // The floor above, and compressReferenceForTransport's best-effort
      // contract (it returns its smallest attempt if it cannot reach the
      // target), both mean the assembled body can in principle still exceed
      // the ceiling. Measure it rather than assume: a checked failure naming
      // the real number beats the host's opaque 413, which is what sent this bug to the wrong stage in the first place.
      const bodyBytes = layoutTransport.size + transportFiles.reduce((sum, file) => sum + file.size, 0);
      if (bodyBytes > FINAL_REQUEST_BODY_BUDGET) {
        throw new Error(
          `The final render payload is ${formatBytes(bodyBytes)} after optimization, over the ${formatBytes(FINAL_REQUEST_BODY_BUDGET)} this host accepts in one request. Remove a supporting view and retry.`,
        );
      }
      setWorkingStage("Rendering final at maximum quality");
      const form = new FormData();
      form.append("payload", JSON.stringify(payload));
      form.append("image[]", layoutTransport, layoutTransport.name);
      for (const file of transportFiles) form.append("image[]", file, file.name);
      setOverallProgress(100);
      sent = true;
      const response = await fetch("/api/generate", { method: "POST", signal: controller.signal, body: form })
        .then((value) => readApiResponse<GenerateResponse>(value));
      finalResponse = response;
      if (!response.imageBase64) throw new Error("Final rendering completed without an image.");
      const dataUrl = base64ImageToObjectUrl(response.imageBase64, response.mimeType || "image/png");
      commitResult({
        dataUrl,
        filename: response.filename || outputFilename,
        kind: "final",
        jobId: response.jobId,
        libraryVisible: response.libraryVisible ?? true,
      });
      // Success: record the render's duration before the job-list refresh
      // below, so the bookkeeping is not counted as render time.
      const finalElapsedMs = renderClock.finish();
      // Teach the Final button's estimate what this render really cost: the
      // approved draft plus every product reference went up.
      const finalCostBasis = collageRenderCostBasis(payload, transportFiles.length + 1);
      recordUsageCalibration(finalCostBasis.size, finalCostBasis.quality, response.usage, finalCostBasis.inputImages);
      setCostCalibrationRevision((revision) => revision + 1);
      setPromptPreview(response.prompt || "");
      setDiagnostics(response.diagnostics ?? null);
      // Only assert the max resolution when the server did not fall back; a
      // notice means it downgraded, so show that instead of a false size.
      const finalSizeLabel = finalSizeFor(finalFormat, collageType);
      const hasCost = typeof response.costUsd === "number" && Number.isFinite(response.costUsd);
      // The receipt's announcement replaces the old "Usage cost" sentence;
      // it carries the cost whenever the route returned one.
      const receiptMessage = landReceipt({
        kind: "final",
        quality: finalCostBasis.quality,
        elapsedMs: finalElapsedMs,
        references: finalCostBasis.inputImages,
        costUsd: response.costUsd,
      });
      const costMessage = hasCost
        ? receiptMessage
        : `${receiptMessage} Generation cost unavailable because completed usage was not returned.`;
      // Only claim full quality when every product reference went out untouched.
      const compressed = compressedReferenceCount(productFiles, transportFiles);
      const referenceNote = compressed === 0
        ? "Full-quality product references were used."
        : `${compressed} of ${productFiles.length} product references were compressed to fit this request's size limit, so their finest detail and any transparency may be reduced.`;
      setPanelText(joinLogSentences([
        `Final ${finalFormat} render complete${response.notice ? "" : ` at ${finalSizeLabel}`}. ${referenceNote}`,
        costMessage,
        response.notice,
      ]));
      await refreshJobs();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setPanelText("Final rendering cancelled. Your draft and references are unchanged.");
      } else {
        // Surface the failed request's diagnostics so Troubleshooting shows the
        // failing stage instead of stale data from the previous draft render.
        if (error instanceof ApiResponseError && error.payload.diagnostics) {
          setDiagnostics(error.payload.diagnostics as GenerationDiagnostics);
        } else {
          // A host-level rejection (a 413 on an oversized body) never reaches
          // the route, so there are no server diagnostics to show. Without
          // this branch the panel kept displaying the last SUCCESSFUL draft,
          // which reads as "the model succeeded" on a render that never left
          // the browser.
          const failurePayload = error instanceof ApiResponseError ? error.payload : {};
          const sent = transportFilesForReport
            ?? items.flatMap((item) => item.references.map((reference) => reference.file));
          setDiagnostics({
            model: SUNBURST_MODEL,
            transport: "multipart",
            quality: finalQuality,
            background,
            outputFormat: "png",
            referenceCount: sent.length,
            totalReferenceBytes: sent.reduce((sum, file) => sum + file.size, 0),
            largestReferenceBytes: Math.max(...sent.map((file) => file.size), 0),
            references: sent.map((file) => ({
              filename: file.name,
              bytes: file.size,
              mimeType: file.type || "unknown",
            })),
            attempts: [{
              stage: "image_edit",
              outcome: "failed",
              attempt: 1,
              durationMs: 0,
              status: typeof failurePayload.status === "number" ? failurePayload.status : undefined,
              code: typeof failurePayload.code === "string" ? failurePayload.code : undefined,
              requestId: typeof failurePayload.requestId === "string" ? failurePayload.requestId : undefined,
              error: `Final render: ${error instanceof Error ? error.message : "Unknown error."}`,
            }],
          });
        }
        // Only a request that left the browser gets a failure receipt.
        const failureCost = finalResponse?.costUsd;
        const failureMessage = sent
          ? landReceipt({
              kind: "final",
              quality: finalQuality,
              elapsedMs: Date.now() - renderStartedAt,
              failed: true,
              ...(typeof failureCost === "number" && Number.isFinite(failureCost) ? { costUsd: failureCost } : {}),
            })
          : "";
        setPanelText(joinLogSentences([
          `Final rendering failed: ${error instanceof Error ? error.message : "Unknown error."}`,
          failureMessage,
        ]));
      }
    } finally {
      // Cancel or failure: stop without recording (a no-op after finish()).
      renderClock.stop();
      setIsWorking(false);
      setWorkingStage("");
      abortRef.current = null;
    }
  }

  async function dryRun() {
    const controller = new AbortController();
    abortRef.current = controller;
    setIsWorking(true);
    setWorkingStage("Reviewing board");
    try {
      const payload = makePayload(false);
      validateCollageRequest(payload);
      const response = await fetch("/api/dry-run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify(payload),
      }).then((value) =>
        readApiResponse<{ ok: boolean; error?: string; summary?: string; prompt?: string }>(value),
      );
      setPromptPreview(response.prompt || "");
      setPanelText(response.summary || "Board prompt is ready.");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setPanelText("Board review cancelled.");
      } else {
        setPanelText(`Review failed: ${error instanceof Error ? error.message : "Could not review board."}`);
      }
    } finally {
      setIsWorking(false);
      setWorkingStage("");
      abortRef.current = null;
    }
  }

  async function generate(diagnosticMode = false, diagnosticCount = 1, renderPreset?: "draft") {
    const controller = new AbortController();
    abortRef.current = controller;
    setIsWorking(true);
    // Empties the stage as commitResult(null) did, but keeps the outgoing
    // image as the previous one for CompareStage, and drops the old receipt.
    // The isolation test is a diagnostic, not a board render: it leaves the
    // board render (and its receipt) in place, so a failed or cancelled test
    // returns to it and nothing is set aside for a comparison.
    if (!diagnosticMode) setAsideResultForCompare();
    setPromptPreview("");
    setOverallProgress(0);
    setWorkingStage(renderPreset === "draft" ? "Preparing quick draft" : "Checking references");
    let transportFilesForReport: File[] | null = null;
    // Set immediately before the fetch, as in finalizeDraft: a pre-flight
    // error lands no failure receipt, and a failure after a billed reply
    // keeps the cost that reply reported.
    let sent = false;
    let renderResponse: GenerateResponse | undefined;
    // Each kind of render learns its own typical duration: a quick draft is
    // always low quality, and the isolation test (a deliberately minimal
    // request, run at low quality) keys by its reference count so it never
    // skews the studio or draft figures.
    renderClock.start(
      diagnosticMode
        ? renderClockKey("generator", `isolation-${diagnosticCount}`, "low")
        : renderPreset === "draft"
          ? renderClockKey("generator", "draft", "low")
          : renderClockKey("generator", "studio", quality),
    );
    // renderClock.startedAt is React state, still stale inside this closure;
    // the failure receipt measures from this local copy of the start instead.
    const renderStartedAt = Date.now();
    const receiptKind = renderPreset === "draft" ? "draft" : "studio";

    try {
      // The isolation test deliberately sends a bare minimum request, and the
      // server counts its expected images without a layout slot, so the layout
      // master is withheld there rather than throwing a count mismatch.
      const sendLayoutMaster = Boolean(layoutMaster) && !diagnosticMode;
      const renderPayload = (payload: CollageRequestInput): CollageRequestInput => ({
        ...payload,
        ...(renderPreset === "draft" ? QUICK_DRAFT_OVERRIDES : {}),
        ...(sendLayoutMaster ? {} : { layoutReference: undefined, layoutReferenceMode: undefined }),
        renderKind: renderPreset === "draft" ? "draft" : "studio",
      });
      const validationPayload = renderPayload(makePayload(false));
      validateCollageRequest(validationPayload);
      const references = items.flatMap((item, index) =>
        item.references.map((reference) => ({ itemKey: item.uiKey, itemId: resolvedItemId(item, index), reference })),
      );
      setOverallProgress(100);
      setWorkingStage("Composing collage");
      const payload = renderPayload(makePayload(true));
      const form = new FormData();
      form.append("payload", JSON.stringify(payload));
      const referencesToSend = diagnosticMode ? references.slice(0, diagnosticCount) : references;
      setWorkingStage(sendLayoutMaster ? "Optimizing the layout reference and references" : "Optimizing references for direct generation");
      const transportFiles = await optimizeReferencesForTransport(
        referencesToSend.map((entry) => entry.reference.file),
        DIRECT_REQUEST_REFERENCE_BUDGET,
      );
      transportFilesForReport = transportFiles;
      // Image order is the contract: the server treats the first image as the
      // layout reference whenever payload.layoutReference is set, and the
      // prompt's REFERENCE MAP numbers the items from 2 onward to match.
      if (sendLayoutMaster && layoutMaster) {
        const layoutTransport = await optimizeReferenceForTransport(layoutMaster.file, LAYOUT_MASTER_TRANSPORT_BUDGET);
        form.append("image[]", layoutTransport, layoutTransport.name);
      }
      for (const file of transportFiles) form.append("image[]", file, file.name);
      setWorkingStage("Composing collage");
      sent = true;
      const response = await fetch(diagnosticMode ? `/api/generate?diagnostic=isolation&count=${diagnosticCount}` : "/api/generate", {
        method: "POST",
        signal: controller.signal,
        body: form,
      }).then((value) => readApiResponse<GenerateResponse>(value));
      renderResponse = response;

      if (diagnosticMode && response.diagnosticComplete) {
        renderClock.finish();
        setDiagnostics(response.diagnostics ?? null);
        if (response.imageBase64) {
          // Shown on its own (no comparison, no receipt); the board render it
          // displaces stays the previous image for the next real render.
          setLastReceipt(null);
          commitResult({
            dataUrl: base64ImageToObjectUrl(response.imageBase64, response.mimeType || "image/png"),
            filename: response.filename || "isolation-test.png",
            kind: "studio",
            libraryVisible: false,
            diagnostic: true,
          });
        }
        const resultText = (response.isolationResults ?? [])
          .map((entry) => `${entry.referenceCount} reference${entry.referenceCount === 1 ? "" : "s"}: ${entry.outcome}`)
          .join("\n");
        setPanelText(`Isolation test complete.\n${resultText}${diagnosticCount < totalReferences ? `\nNext: test ${Math.min(diagnosticCount === 1 ? 5 : totalReferences, totalReferences)} references.` : ""}`);
        await saveDraft(false);
        return;
      }

      if (!response.imageBase64) throw new Error("Generation completed without an image.");
      const dataUrl = base64ImageToObjectUrl(response.imageBase64, response.mimeType || "image/png");
      commitResult({
        dataUrl,
        filename: response.filename || outputFilename || "material-collage.png",
        kind: renderPreset === "draft" ? "draft" : "studio",
        jobId: response.jobId,
        libraryVisible: response.libraryVisible ?? false,
        // An isolation reply without diagnosticComplete still lands here; it
        // stays a diagnostic image (never compared, never the previous one).
        diagnostic: diagnosticMode,
      });
      // Success: record before saveDraft below, which is bookkeeping, not render.
      const renderElapsedMs = renderClock.finish();
      // Teach the studio / quick draft estimate what this render really cost,
      // counting every image that went up (the layout master included).
      const renderCostBasis = collageRenderCostBasis(payload, transportFiles.length + (sendLayoutMaster ? 1 : 0));
      recordUsageCalibration(renderCostBasis.size, renderCostBasis.quality, response.usage, renderCostBasis.inputImages);
      setCostCalibrationRevision((revision) => revision + 1);
      setPromptPreview(response.prompt || "");
      // Start the final-render switch on the shape the approved draft was
      // actually composed in, so finalizing a portrait draft doesn't silently
      // re-crop it to landscape.
      if (renderPreset === "draft") setFinalFormat(resolvedOrientation(payload));
      // The isolation test is a diagnostic, not a board render: no receipt,
      // and the board render's receipt does not stay under its image.
      if (diagnosticMode) setLastReceipt(null);
      const receiptMessage = diagnosticMode
        ? ""
        : landReceipt({
            kind: receiptKind,
            quality: renderCostBasis.quality,
            elapsedMs: renderElapsedMs,
            references: renderCostBasis.inputImages,
            costUsd: response.costUsd,
          });
      setPanelText(joinLogSentences([
        renderPreset === "draft" ? "Draft ready. Review the composition, then render the final below." : response.summary || "Collage generated.",
        receiptMessage,
        response.notice,
      ]));
      setDiagnostics(response.diagnostics ?? null);
      await saveDraft(false);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setPanelText("Generation cancelled. Your board and references are still saved.");
      } else {
        if (error instanceof ApiResponseError && error.payload.diagnostics) {
          setDiagnostics(error.payload.diagnostics as GenerationDiagnostics);
        } else {
          const payload = error instanceof ApiResponseError ? error.payload : {};
          setDiagnostics({
            model: SUNBURST_MODEL,
            transport: "multipart",
            quality: diagnosticMode ? "low" : quality,
            background,
            outputFormat: "png",
            referenceCount: transportFilesForReport?.length
              ?? (diagnosticMode ? Math.min(diagnosticCount, totalReferences) : totalReferences),
            totalReferenceBytes: transportFilesForReport?.reduce((sum, file) => sum + file.size, 0) ?? totalReferenceBytes,
            largestReferenceBytes: Math.max(
              ...(transportFilesForReport?.map((file) => file.size)
                ?? items.flatMap((item) => item.references.map((reference) => reference.file.size))),
              0,
            ),
            references: transportFilesForReport
              ? transportFilesForReport.map((file) => ({
                  filename: file.name,
                  bytes: file.size,
                  mimeType: file.type || "unknown",
                }))
              : items.flatMap((item) => item.references.map((reference) => ({
                  filename: reference.file.name,
                  bytes: reference.file.size,
                  mimeType: reference.file.type || "unknown",
                }))),
            attempts: [{
              stage: "image_edit",
              outcome: "failed",
              attempt: 1,
              durationMs: 0,
              status: typeof payload.status === "number" ? payload.status : undefined,
              code: typeof payload.code === "string" ? payload.code : undefined,
              requestId: typeof payload.requestId === "string" ? payload.requestId : undefined,
              error: `${diagnosticMode ? "Isolation test" : "Generation"}: ${error instanceof Error ? error.message : "Unknown error."}`,
            }],
          });
        }
        // Only a request that left the browser gets a failure receipt.
        const failureCost = renderResponse?.costUsd;
        const failureMessage = diagnosticMode || !sent
          ? ""
          : landReceipt({
              kind: receiptKind,
              quality: renderPreset === "draft" ? QUICK_DRAFT_OVERRIDES.quality : quality,
              elapsedMs: Date.now() - renderStartedAt,
              failed: true,
              ...(typeof failureCost === "number" && Number.isFinite(failureCost) ? { costUsd: failureCost } : {}),
            });
        setPanelText(joinLogSentences([
          `${diagnosticMode ? "Isolation test" : "Generation"} failed: ${error instanceof Error ? error.message : "Unknown error."}`,
          failureMessage,
        ]));
      }
    } finally {
      // Cancel or failure: stop without recording (a no-op after finish()).
      renderClock.stop();
      setIsWorking(false);
      setWorkingStage("");
      abortRef.current = null;
    }
  }

  function cancelWork() {
    abortRef.current?.abort();
  }

  // A landed result over a previous one arrives as a compare split
  // (CompareStage) instead of the dither reveal. An isolation-test image is
  // a diagnostic and is never compared.
  const showCompare = Boolean(result && previousResultUrl && !result.diagnostic);
  // finish() ends the clock before post-render bookkeeping (draft save,
  // job-list refresh); until isWorking clears, the readouts hold that
  // render's final time, still, instead of dropping to a bare WORKING.
  const heldRun = isWorking && renderClock.startedAt === null ? renderClock.finished : null;
  const clockStartedAt = renderClock.startedAt ?? heldRun?.startedAt ?? null;
  const clockTypicalMs = renderClock.startedAt !== null ? renderClock.typicalMs : heldRun?.typicalMs ?? null;
  const clockFrozenMs = heldRun?.elapsedMs;

  return (
    <main className="app-shell generator-shell">
      <RouteReady path="/generator" />
      <SiteNavigation
        active="generator"
        className="generator-navigation"
        right={
          <div className="generator-status" aria-label="Board reference summary">
            <span>{totalReferences}/{MAX_REFERENCE_IMAGES} references</span>
            <span>{formatBytes(totalReferenceBytes)}</span>
            <span>{lastSavedAt ? "Draft saved" : "Local draft"}</span>
          </div>
        }
      />

      <div className="workbench">
        <section className="builder-surface">
          <div className="controls-surface">
          <div className="surface-heading">
            <div>
              <p className="section-kicker">01</p>
              <h2>Board setup</h2>
            </div>
            <div className="surface-actions">
              <button type="button" className="quiet-button" onClick={() => void saveDraft(true)}>
                Save draft
              </button>
              <button type="button" className="quiet-button" onClick={resetPreset}>
                Reset
              </button>
            </div>
          </div>

          <div className="control-grid setup-controls">
            <label className="wide-field">
              <span>Board type</span>
              <DropdownSelect
                value={collageType}
                onChange={(next) => changeType(next as CollageType)}
                options={COLLAGE_TYPES.map((type) => ({ value: type, label: labelFor(type) }))}
              />
            </label>
            <label>
              <span>Orientation</span>
              <DropdownSelect
                value={orientation}
                onChange={(next) => setOrientation(next as Orientation)}
                options={ORIENTATIONS.map((option) => ({ value: option, label: labelFor(option) }))}
              />
            </label>
            <label>
              <span>Resolution</span>
              <DropdownSelect
                value={outputResolution}
                onChange={(next) => setOutputResolution(next as OutputResolution)}
                options={OUTPUT_RESOLUTIONS.map((option) => ({
                  value: option,
                  label: option === "studio" ? "Studio 2K" : option === "final" ? "Final maximum" : "Standard",
                }))}
              />
            </label>
            <label className="wide-field">
              <span>Render quality</span>
              <DropdownSelect
                value={quality}
                onChange={(next) => setQuality(next as Quality)}
                options={QUALITIES.map((option) => ({ value: option, label: labelFor(option) }))}
              />
            </label>
            <label>
              <span>Background</span>
              <DropdownSelect
                value={background}
                onChange={(next) => setBackground(next as Background)}
                options={SUNBURST_BACKGROUNDS.map((option) => ({
                  value: option,
                  label: option === "transparent" ? "Transparent" : "Solid white",
                }))}
              />
            </label>
          </div>

          <div className="surface-divider" />

          <div className="surface-heading compact-heading">
            <div>
              <p className="section-kicker">02</p>
              <h2>Art direction</h2>
            </div>
          </div>
          <div className="control-grid art-controls">
            <label>
              <span>Composition</span>
              <DropdownSelect
                value={composition}
                onChange={(next) => setComposition(next as Composition)}
                disabled={Boolean(layoutMaster)}
                options={COMPOSITIONS.map((option) => ({ value: option, label: labelFor(option) }))}
              />
            </label>
            <label>
              <span>Spacing</span>
              <DropdownSelect
                value={density}
                onChange={(next) => setDensity(next as Density)}
                disabled={Boolean(layoutMaster)}
                options={DENSITIES.map((option) => ({ value: option, label: labelFor(option) }))}
              />
            </label>
            <label>
              <span>Lighting</span>
              <DropdownSelect
                value={lighting}
                onChange={(next) => setLighting(next as LightingOption)}
                options={LIGHTING_OPTIONS.map((option) => ({ value: option, label: labelFor(option) }))}
              />
            </label>
            <label>
              <span>Styling</span>
              <DropdownSelect
                value={collageType === "appliance_collage" ? "materials_only" : styling}
                onChange={(next) => setStyling(next as StylingOption)}
                disabled={collageType === "appliance_collage"}
                options={STYLING_OPTIONS.map((option) => ({ value: option, label: labelFor(option) }))}
              />
            </label>
            <label className="wide-field">
              <span>Hero item</span>
              <DropdownSelect
                value={heroItemId}
                onChange={setHeroItemId}
                options={[
                  { value: "", label: "Automatic" },
                  ...heroOptions.map((item) => ({ value: item.id, label: item.id || item.role })),
                ]}
              />
            </label>
          </div>

          <section className="layout-master">
            <div className="layout-master-heading">
              <div>
                <span>Layout reference</span>
                <strong>{layoutMaster ? "Following your uploaded collage" : "Using the settings above"}</strong>
              </div>
              {layoutMaster && <span className="status-pill ready">Active</span>}
            </div>
            {layoutMaster ? (
              <div className="layout-master-active">
                <img src={layoutMaster.preview} alt="Uploaded layout reference" />
                <div className="layout-master-detail">
                  <p>{layoutMaster.name}</p>
                  <small>
                    Placement, scale hierarchy, overlap, and spacing are taken from this collage. Its
                    products are ignored — only the items in your reference tray are rendered.
                  </small>
                  <div className="layout-master-actions">
                    <label className="layout-master-replace">
                      Replace
                      <input
                        type="file"
                        accept="image/*"
                        onChange={(event) => {
                          chooseLayoutMaster(event.target.files?.[0]);
                          event.target.value = "";
                        }}
                      />
                    </label>
                    <button type="button" className="danger" onClick={() => {
                      applyLayoutMaster(null);
                      setPanelText("Layout reference removed. Composition and spacing follow the art-direction settings again.");
                    }}>
                      Remove
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <label
                className="layout-master-drop"
                // Its file input is display: none, so a dropped file never
                // reached it; the page now refuses stray file drops
                // (SlotDrop.tsx), so this box claims its own and passes the
                // file to the same chooser the picker uses. Like the cards,
                // it takes only files from outside the page, never an image
                // dragged off the page itself.
                onDragOver={(event) => {
                  if (!acceptsFileDrag(event.dataTransfer)) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "copy";
                }}
                onDrop={(event) => {
                  if (!acceptsFileDrag(event.dataTransfer)) return;
                  event.preventDefault();
                  chooseLayoutMaster(event.dataTransfer.files[0]);
                }}
              >
                <span>Upload a previous collage</span>
                <small>Its layout and organization become the sole source of truth for the next render.</small>
                <input
                  type="file"
                  accept="image/*"
                  onChange={(event) => {
                    chooseLayoutMaster(event.target.files?.[0]);
                    event.target.value = "";
                  }}
                />
              </label>
            )}
          </section>

          <details className="settings-drawer">
            <summary>Studio settings</summary>
            <div className="control-grid settings-controls">
              <label>
                <span>Output file name</span>
                <input value={outputFilename} onChange={(event) => setOutputFilename(event.target.value)} />
              </label>
            </div>
            <div className="drawer-actions">
              <button type="button" onClick={() => void restoreSavedDraft()}>Restore saved draft</button>
              <button type="button" className="danger" onClick={() => void clearSavedDraft()}>Delete saved draft</button>
            </div>
          </details>
          </div>

          <div className="references-surface">

          <div className="surface-heading compact-heading reference-heading">
            <div>
              <p className="section-kicker">03</p>
              <h2>Reference tray</h2>
            </div>
            <div className="reference-heading-actions">
              <RakingLight
                items={items}
                full={totalReferences + Number(Boolean(layoutMaster)) >= MAX_REFERENCE_IMAGES}
                onAdd={(itemKey, sample, file) => {
                  const reference = createReference(file, {
                    primary: !items.find(item => item.uiKey === itemKey)?.references.length,
                    sourceLabel: "Poly Haven",
                    sourceUrl: `https://polyhaven.com/a/${sample.id}`,
                    provenance: "sample",
                  });
                  setItems(current => current.map(item => item.uiKey === itemKey
                    ? { ...item, references: [...item.references, reference] }
                    : item));
                  setPanelText(`${sample.name} added to the reference tray.`);
                }}
              />
              <span
                className={hasFiles ? "status-pill ready" : "status-pill"}
                title={layoutMaster ? "The layout reference occupies one of the 16 image slots." : undefined}
              >
                {totalReferences}/{layoutMaster ? MAX_REFERENCE_IMAGES - 1 : MAX_REFERENCE_IMAGES}
              </span>
              <button type="button" className="add-item-button" onClick={addItem}>+ Add item</button>
            </div>
          </div>

          <div ref={itemsListRef} className="items-list">
            {items.map((item, index) => (
              <article
                className={`material-item ${slotDropClassName({
                  armed: slotDrop.armed && canAccept,
                  over: canAccept && slotDrop.overKey === item.uiKey,
                })}`}
                key={item.uiKey}
                {...slotDrop.targetProps(item.uiKey, {
                  onFiles: (files) => {
                    markDeveloping(files);
                    addReferences(item.uiKey, files);
                  },
                })}
              >
                <div className="item-row-head">
                  <div className="item-title-group">
                    <span className="item-number">{String(index + 1).padStart(2, "0")}</span>
                    <div>
                      <strong title={item.role || item.id || `Item ${index + 1}`}>{item.role || item.id || `Item ${index + 1}`}</strong>
                      <span>{item.references.length ? `${item.references.length} reference${item.references.length === 1 ? "" : "s"}` : "No image yet"}{item.required === false ? " / Optional" : ""}</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="remove-item-button"
                    onClick={() => removeItem(item.uiKey)}
                    aria-label={`Remove ${item.role || `item ${index + 1}`}`}
                    title="Remove item"
                  >
                    {"\u00d7"}
                  </button>
                </div>

                {item.references.length > 0 && (
                  <div className="reference-strip mc-print-scope">
                    {item.references.map((reference, referenceIndex) => {
                      return (
                        <figure className="reference-tile" key={reference.uiKey}>
                          <div className="reference-image-wrap">
                            <img
                              className={developClassName(
                                reference.file,
                                `mc-print-in ${printInClass(referencePrintLater, reference.uiKey)}`,
                              )}
                              {...developHandlers(reference.file)}
                              data-print-id={reference.uiKey}
                              src={reference.preview}
                              alt={`${item.id || item.role} reference ${referenceIndex + 1}`}
                            />
                            {referenceIndex === 0 && <span className="primary-badge">Primary</span>}
                          </div>
                          <figcaption>
                            <span title={reference.file.name}>{reference.file.name}</span>
                            <small>{formatBytes(reference.file.size)}</small>
                          </figcaption>
                          {reference.sourceLabel && (
                            <a className="reference-source" href={reference.sourceUrl} target="_blank" rel="noreferrer">
                              {reference.sourceLabel}
                            </a>
                          )}
                          <div className="reference-actions">
                            {referenceIndex > 0 && (
                              <button type="button" onClick={() => makePrimary(item.uiKey, reference.uiKey)}>
                                Make primary
                              </button>
                            )}
                            <button type="button" onClick={() => removeReference(item.uiKey, reference.uiKey)}>
                              Remove
                            </button>
                            <label className="replace-reference">
                              <input
                                type="file"
                                accept="image/png,image/jpeg,image/webp"
                                onChange={(event) => {
                                  replaceReference(item.uiKey, reference.uiKey, event.target.files);
                                  event.currentTarget.value = "";
                                }}
                              />
                              <span>Replace</span>
                            </label>
                          </div>
                        </figure>
                      );
                    })}
                  </div>
                )}

                {/* The whole card (article above) takes a dropped file; this box
                    keeps only the click / keyboard picker, so a drop is handled once. */}
                <div className="reference-dropzone">
                  <label>
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      onChange={(event) => {
                        markDeveloping(Array.from(event.target.files ?? []));
                        addReferences(item.uiKey, event.target.files);
                        event.currentTarget.value = "";
                      }}
                    />
                    <span>
                      {canAccept && slotDrop.overKey === item.uiKey
                        ? dropLabel(index + 1)
                        : item.references.length ? "Add another view" : "Upload primary image"}
                    </span>
                  </label>
                  <span>Drop a photo here / original preserved</span>
                </div>

                {item.analysisStatus === "analyzing" && <div className="investigation-status">Analyzing primary image...</div>}
                {item.analysisStatus === "ready" && item.analysis && (
                  <section className="investigation-panel">
                    <div className="investigation-heading">
                      <div>
                        <strong>Image analysis review</strong>
                        <span>Suggested product details from the primary image. Suggestions fill blank fields only.</span>
                      </div>
                      <button
                        type="button"
                        className="quiet-button"
                        onClick={() => void findReferenceMatches(item.uiKey)}
                        disabled={item.matchStatus === "searching" || !item.analysis.searchQuery}
                      >
                        {item.matchStatus === "searching" ? "Searching..." : "Find matches"}
                      </button>
                    </div>
                    <div className="analysis-evidence">
                      {([
                        ["Item type", "role", item.analysis.itemType],
                        ["Brand", "brand", item.analysis.brand],
                        ["Product", "name", item.analysis.product],
                        ["Finish", "finish", item.analysis.finish],
                        ["Notes", "notes", item.analysis.notes],
                      ] as Array<[string, "role" | "brand" | "name" | "finish" | "notes", AnalysisField]>).filter(([, , field]) => field.value).map(([label, key, field]) => (
                        <span key={label} className={field.confidence < 70 ? "uncertain" : ""}>
                          {label}: {field.value} / {field.confidence}%
                          {field.confidence < 70 && !item[key]?.trim() && (
                            <button type="button" onClick={() => applyAnalysisSuggestion(item.uiKey, key, field.value)}>Use</button>
                          )}
                        </span>
                      ))}
                    </div>
                  </section>
                )}

                {item.candidates && item.candidates.length > 0 && (
                  <div className="candidate-list">
                    {item.candidates.map((candidate) => (
                      <article className="candidate-item" key={candidate.pageUrl}>
                        {candidate.imageUrl ? <img src={candidate.imageUrl} alt="" /> : <div className="candidate-no-image">No preview</div>}
                        <div>
                          <strong>{candidate.title}</strong>
                          <span>{candidate.sourceLabel}{candidate.official ? " / Official" : ""} / {candidate.confidence}%</span>
                          {candidate.reason && <p>{candidate.reason}</p>}
                          <div className="candidate-actions">
                            <a href={candidate.pageUrl} target="_blank" rel="noreferrer">Review source</a>
                            <button type="button" onClick={() => void acceptReferenceCandidate(item.uiKey, candidate)} disabled={!candidate.imageUrl}>
                              Add reference
                            </button>
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                )}

                <details className="item-details">
                  <summary>Item details</summary>
                  <div className="item-fields">
                    <div className="item-field">
                      <FieldLabel htmlFor={`${itemFieldId(index)}-role`} text="Item type" help="What this object contributes to the collage, such as main bathroom tile, vanity faucet, or countertop stone." />
                      <input id={`${itemFieldId(index)}-role`} aria-describedby={`${itemFieldId(index)}-role-help`} value={item.role} onChange={(event) => updateItem(item.uiKey, { role: event.target.value })} />
                    </div>
                    <div className="item-field">
                      <FieldLabel htmlFor={`${itemFieldId(index)}-name`} text="Product / model" help="The exact collection, model number, or SKU when known. Leave blank when the image does not prove it." />
                      <input id={`${itemFieldId(index)}-name`} aria-describedby={`${itemFieldId(index)}-name-help`} value={item.name || ""} onChange={(event) => updateItem(item.uiKey, { name: event.target.value })} />
                    </div>
                    <div className="item-field">
                      <FieldLabel htmlFor={`${itemFieldId(index)}-brand`} text="Brand" help="The manufacturer name, not the retailer or showroom." />
                      <input id={`${itemFieldId(index)}-brand`} aria-describedby={`${itemFieldId(index)}-brand-help`} value={item.brand || ""} onChange={(event) => updateItem(item.uiKey, { brand: event.target.value })} />
                    </div>
                    <div className="item-field wide-field">
                      <FieldLabel htmlFor={`${itemFieldId(index)}-finish`} text="Finish / color" help="Use the manufacturer finish name when known, or describe the visible material color and sheen." />
                      <input id={`${itemFieldId(index)}-finish`} aria-describedby={`${itemFieldId(index)}-finish-help`} value={item.finish || ""} onChange={(event) => updateItem(item.uiKey, { finish: event.target.value })} />
                    </div>
                    <div className="item-field wide-field">
                      <FieldLabel htmlFor={`${itemFieldId(index)}-notes`} text="Generation notes" help="Add exceptions the image cannot communicate, such as which face to show, details to preserve, or objects that must not appear." />
                      <textarea id={`${itemFieldId(index)}-notes`} aria-describedby={`${itemFieldId(index)}-notes-help`} value={item.notes || ""} onChange={(event) => updateItem(item.uiKey, { notes: event.target.value })} />
                    </div>
                  </div>
                </details>
              </article>
            ))}
          </div>
          <ReferenceLoupe scopeRef={itemsListRef} />

          </div>
        </section>

        <aside className="output-surface">
          <div className="output-sticky">
            <div className="surface-heading output-heading">
              <div>
                <p className="section-kicker">04</p>
                <h2>Collage and review</h2>
              </div>
              <span className={isWorking ? "status-pill working" : result ? "status-pill ready" : "status-pill"}>
                {isWorking && <WorkingField variant="pill" />}
                {isWorking ? (
                  // One inline span so the space before the time survives the
                  // pill's inline-flex layout.
                  <span>
                    Working
                    {clockStartedAt !== null ? (
                      <>
                        {" "}
                        <RenderClockTime startedAt={clockStartedAt} frozenMs={clockFrozenMs} />
                      </>
                    ) : null}
                  </span>
                ) : result ? "Complete" : "Ready"}
              </span>
            </div>

            <div
              // The lifted state is still recorded while CompareStage shows,
              // but its sweep class is withheld: the wipe is that arrival's
              // motion, and the opaque compare frame would hide the sweep.
              className={`result-stage ${result ? "has-result" : ""}${result && !isWorking && !showCompare && liftedFor === result.dataUrl ? " is-lifted" : ""}`}
              style={result ? { aspectRatio: `${previewWidth} / ${previewHeight}` } : undefined}
            >
              {isWorking ? (
                <DitherReveal
                  className="dither-stage"
                  style={{ height: "100%" }}
                  src={result?.dataUrl ?? "/sample-collage.png"}
                  alt="Rendering the collage"
                />
              ) : result && previousResultUrl && showCompare ? (
                <CompareStage
                  previous={{ src: previousResultUrl, alt: "Previous material collage" }}
                  current={{ src: result.dataUrl, alt: "Generated material collage" }}
                  arrivalKey={result.dataUrl}
                  // Wipes in once per result; re-mounted after a prompt review
                  // or a cancelled / failed Final it is shown settled.
                  playArrival={compareSettledFor !== result.dataUrl}
                  onSettled={() => {
                    if (sweptResultRef.current === result.dataUrl) return;
                    sweptResultRef.current = result.dataUrl;
                    setLiftedFor(result.dataUrl);
                  }}
                />
              ) : result ? (
                <DitherReveal
                  key={result.dataUrl}
                  className="dither-stage"
                  style={{ height: "100%" }}
                  src={result.dataUrl}
                  alt="Generated material collage"
                  progress={revealProgress}
                  onSettled={() => {
                    if (sweptResultRef.current === result.dataUrl) return;
                    sweptResultRef.current = result.dataUrl;
                    setLiftedFor(result.dataUrl);
                  }}
                />
              ) : (
                <img src="/sample-collage.png" alt="Sample material collage" />
              )}
              {clockStartedAt !== null && (
                <RenderClockRule startedAt={clockStartedAt} typicalMs={clockTypicalMs} frozenMs={clockFrozenMs} />
              )}
              {/* Bottom edge only: the clock rule (top edge) shows only while a
                  render runs, when no receipt is set, and CompareStage's chips
                  sit in the top corners. */}
              {lastReceipt && !isWorking && (
                <ReceiptStamp
                  key={lastReceipt.id}
                  variant="stage"
                  receipt={lastReceipt.input}
                  playArrival={settledReceiptId !== lastReceipt.id}
                />
              )}
            </div>

            {isWorking && (
              // Only the stage label is a live region: the clock beside it
              // ticks every second and must not be announced each time.
              <div className="work-progress">
                <div>
                  <span aria-live="polite">{workingStage}</span>
                  {clockStartedAt !== null ? (
                    <RenderClock startedAt={clockStartedAt} typicalMs={clockTypicalMs} frozenMs={clockFrozenMs} />
                  ) : (
                    <strong>{overallProgress > 0 && overallProgress < 100 ? `${overallProgress}%` : ""}</strong>
                  )}
                </div>
                <div className="progress-track">
                  <span style={{ width: `${overallProgress}%` }}>
                    <WorkingField variant="track" />
                  </span>
                </div>
              </div>
            )}

            <div className="primary-actions">
              {isWorking ? (
                <button type="button" className="cancel-button" onClick={cancelWork}>Cancel</button>
              ) : (
                // The live estimate (CostEstimate.tsx) shows only once there
                // is a reference to price; until then the button is disabled
                // and carries no figure.
                <CostStack span="full">
                  <button
                    type="button"
                    className={`primary-button ${costHostClassName}`}
                    onClick={() => void generate(false)}
                    disabled={!hasFiles}
                    title="Renders immediately using the selected quality, resolution, and styling settings."
                    aria-label={hasFiles ? `Generate Collage, ${describeCostEstimate(renderCostEstimates.studio.breakdown?.totalUsd ?? null)}` : undefined}
                  >
                    Generate Collage
                    {hasFiles && <CostFigure usd={renderCostEstimates.studio.breakdown?.totalUsd ?? null} />}
                  </button>
                  {hasFiles && renderCostEstimates.studio.breakdown && (
                    <CostSplit
                      references={totalReferences}
                      extra={layoutMaster ? "layout" : undefined}
                      breakdown={renderCostEstimates.studio.breakdown}
                    />
                  )}
                </CostStack>
              )}
              <CostStack>
                <button
                  type="button"
                  className={`draft-button ${costHostClassName}`}
                  onClick={() => void generate(false, 1, "draft")}
                  disabled={isWorking || !hasFiles}
                  title="Creates a low-cost preview for composition and placement."
                  aria-label={hasFiles ? `Quick Draft, ${describeCostEstimate(renderCostEstimates.draft.breakdown?.totalUsd ?? null)}` : undefined}
                >
                  Quick Draft
                  {hasFiles && <CostFigure usd={renderCostEstimates.draft.breakdown?.totalUsd ?? null} />}
                </button>
                {hasFiles && renderCostEstimates.draft.breakdown && (
                  <CostSplit
                    references={totalReferences}
                    extra={layoutMaster ? "layout" : undefined}
                    breakdown={renderCostEstimates.draft.breakdown}
                  />
                )}
              </CostStack>
              <button type="button" className={`secondary-button ${costRowNeighbourClassName}`} onClick={dryRun} disabled={isWorking}>
                Review prompt
              </button>
              {result && (
                <a className="download-button" href={result.dataUrl} download={result.filename}>Download PNG</a>
              )}
              {result?.jobId && !result.libraryVisible && (
                <button type="button" className="library-save-button" onClick={() => void saveResultToLibrary()}>Save to Library</button>
              )}
              {result?.libraryVisible && <Link className="library-link-button" href="/">View in Library</Link>}
            </div>

            {result && result.kind !== "final" && (
              <section className="finalize-panel">
                <div className="finalize-heading">
                  <div>
                    <span>Final rendering</span>
                    <strong>Keep this layout and rebuild from every original reference</strong>
                  </div>
                  <span className="quality-lock">Maximum quality</span>
                </div>
                <div className="format-switch" role="group" aria-label="Final image format">
                  {FINAL_FORMATS.map((format) => {
                    const [width, height] = finalSizeFor(format, collageType).split("x");
                    return (
                      <button
                        key={format}
                        type="button"
                        aria-pressed={finalFormat === format}
                        className={finalFormat === format ? "selected" : ""}
                        onClick={() => setFinalFormat(format)}
                      >
                        <strong>{labelFor(format)}</strong><span>{width} x {height}</span>
                      </button>
                    );
                  })}
                </div>
                <div className="final-actions">
                  <button
                    type="button"
                    className={`final-now-button ${costHostClassName}`}
                    onClick={() => void finalizeDraft()}
                    disabled={isWorking}
                    title="Starts the selected-quality final render immediately; usage-based cost is shown after completion."
                    aria-label={hasFiles ? `Final Render Now, ${describeCostEstimate(renderCostEstimates.final.breakdown?.totalUsd ?? null)}` : undefined}
                  >
                    Final Render Now
                    <small>
                      {hasFiles && renderCostEstimates.final.breakdown
                        ? formatCostSplit(totalReferences, renderCostEstimates.final.breakdown, { extra: "draft" })
                        : "Usage-based cost shown after completion + references"}
                    </small>
                    {hasFiles && <CostFigure usd={renderCostEstimates.final.breakdown?.totalUsd ?? null} placement="inset-tight" />}
                  </button>
                </div>
              </section>
            )}

            {!isWorking && (
              <details className="output-tools">
                <summary>Troubleshooting</summary>
                <button type="button" className="quiet-button" onClick={() => void generate(true, 1)} disabled={!hasFiles}>
                  Test one reference
                </button>
              </details>
            )}

            <div className="activity-log" aria-live="polite">{panelText}</div>

            {diagnostics && (
              <details className="diagnostic-report">
                <summary>Diagnostic report</summary>
                <div className="diagnostic-summary">
                  <span>{diagnostics.referenceCount} references checked</span>
                  <span>{formatBytes(diagnostics.totalReferenceBytes)} total</span>
                  <span>{diagnostics.attempts.filter((attempt) => attempt.stage === "image_edit").length} generation attempts</span>
                </div>
                <pre>{JSON.stringify(diagnostics, null, 2)}</pre>
                <button
                  type="button"
                  className="quiet-button"
                  onClick={() => void navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2))}
                >
                  Copy report
                </button>
              </details>
            )}

            {promptPreview && (
              <details className="prompt-drawer">
                <summary>Generation prompt</summary>
                <pre>{promptPreview}</pre>
              </details>
            )}

            {jobs.length > 0 && (
              <details className="generation-history">
                <summary>Final render history</summary>
                <div className="history-list">
                  {jobs.map((job) => (
                    <article key={job.id}>
                      <div>
                        <strong>Final render</strong>
                        <span>{job.format} / {new Date(job.createdAt).toLocaleString()}</span>
                      </div>
                      <span className={`job-status ${job.status}`}>{job.status.replaceAll("_", " ")}</span>
                      {job.status === "completed" && (
                        <a href={`/api/jobs/${job.id}/output`} download={job.filename}>Open {(job.outputFormat || "png").toUpperCase()}</a>
                      )}
                      <small>
                        {/* The receipt already carries the quality, so the
                            separate quality suffix is not repeated after it.
                            The four-decimal cost stays available as its title. */}
                        <ReceiptStamp
                          variant="inline"
                          receipt={{
                            kind: job.renderKind,
                            quality: job.quality,
                            costUsd: job.costUsd,
                            failed: job.status === "failed",
                          }}
                          title={
                            typeof job.costUsd === "number" && Number.isFinite(job.costUsd)
                              ? `Cost $${job.costUsd.toFixed(4)} from completed usage`
                              : undefined
                          }
                        />
                        {typeof job.costUsd === "number" && Number.isFinite(job.costUsd)
                          ? ""
                          : " · Generation cost unavailable"}
                        {job.model ? ` · ${job.model}` : ""}
                        {job.background ? ` · ${job.background}` : ""}
                      </small>
                      {job.error && <p>{job.error}</p>}
                    </article>
                  ))}
                </div>
              </details>
            )}
          </div>
        </aside>
      </div>
    </main>
  );
}
