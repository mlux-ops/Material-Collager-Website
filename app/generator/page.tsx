/* eslint-disable @next/next/no-img-element */
"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { DropdownSelect } from "../components/DropdownSelect";
import {
  COLLAGE_TYPES,
  COMPOSITIONS,
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
  type Density,
  type LightingOption,
  type Orientation,
  type OutputResolution,
  type Quality,
  type StylingOption,
} from "@/app/lib/collage";
import { ApiResponseError, readApiResponse } from "@/app/lib/api-client";
import {
  DIRECT_REQUEST_REFERENCE_BUDGET,
  FINAL_LAYOUT_REFERENCE_BUDGET,
  FINAL_REQUEST_BODY_BUDGET,
  base64ImageToObjectUrl,
  dataUrlFile,
  fileFingerprint,
  formatBytes,
  optimizeReferenceForTransport,
  optimizeReferencesForTransport,
} from "@/app/lib/image-transport";

type ReferenceUploadCache = {
  fileId: string;
  credentialFingerprint: string;
  fileFingerprint: string;
};

type UiReference = {
  uiKey: string;
  file: File;
  preview: string;
  remote?: ReferenceUploadCache;
  primary?: boolean;
  sourceUrl?: string;
  sourceLabel?: string;
  provenance?: "upload" | "investigation";
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

type UiItem = Omit<CollageItemInput, "imageKeys" | "imageNames" | "imageFileIds"> & {
  uiKey: string;
  references: UiReference[];
  analysis?: ReferenceAnalysis;
  analysisStatus?: "idle" | "analyzing" | "ready" | "error";
  matchStatus?: "idle" | "searching" | "ready" | "error";
  candidates?: ReferenceCandidate[];
};

type DraftReference = Omit<UiReference, "preview">;

// Persisted draft references keep only a pointer (fileKey) to the blob, which
// is stored under its own IndexedDB key. This lets a metadata-only change
// (editing a note, toggling a setting) rewrite the small record without
// re-serializing every full-quality reference image.
type PersistedReference = Omit<DraftReference, "file"> & { fileKey: string };
type PersistedItem = Omit<DraftItem, "references" | "files"> & { references: PersistedReference[] };
type StoredDraft = Omit<SavedDraft, "items"> & { format: "split"; items: PersistedItem[] };

type DraftItem = Omit<CollageItemInput, "imageKeys" | "imageNames" | "imageFileIds"> & {
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
  outputResolution?: OutputResolution;
  composition?: Composition;
  density?: Density;
  styling?: StylingOption;
  lighting?: LightingOption;
  heroItemId?: string;
  outputFilename: string;
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
};

type GenerationJob = {
  id: string;
  mode: "economy" | "immediate";
  status: string;
  filename: string;
  format: string;
  renderKind: "draft" | "studio" | "final";
  collageType: string;
  libraryVisible: boolean;
  title: string;
  estimatedUsd: number | null;
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

type ResultState = {
  dataUrl: string;
  filename: string;
  kind: "draft" | "studio" | "final";
  jobId?: string;
  libraryVisible: boolean;
};

type GenerationDiagnostics = {
  model: string;
  transport: string;
  quality: string;
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

const REFERENCE_CHUNK_BYTES = 4 * 1024 * 1024;
const DRAFT_DB_NAME = "material-collager-drafts";
const DRAFT_STORE_NAME = "drafts";
const CURRENT_DRAFT_KEY = "current";
const BLOB_KEY_PREFIX = "blob:";
const blobKey = (fileKey: string) => `${BLOB_KEY_PREFIX}${fileKey}`;
const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "expired", "cancelled"]);

function createUiKey() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function createReference(file: File, remote?: ReferenceUploadCache, metadata?: Partial<UiReference>): UiReference {
  return {
    uiKey: createUiKey(),
    file,
    preview: URL.createObjectURL(file),
    remote,
    primary: false,
    provenance: "upload",
    ...metadata,
  };
}

function FieldLabel({ text, help }: { text: string; help: string }) {
  return (
    <span className="field-label">
      {text}
      <span className="help-wrap">
        <button type="button" className="help-button" aria-label={`${text}: ${help}`}>?</button>
        <span className="field-help" role="tooltip">{help}</span>
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
      resolve({ ...stored, items } as unknown as SavedDraft);
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
  const stored: StoredDraft = {
    ...draft,
    format: "split",
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

async function credentialFingerprint(apiKey: string) {
  const trimmed = apiKey.trim();
  if (!trimmed) return "server-key";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(trimmed));
  return Array.from(new Uint8Array(digest).slice(0, 12), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function uploadReferenceFile(
  file: File,
  apiKey: string,
  signal: AbortSignal,
  onProgress: (progress: number) => void,
) {
  const started = await fetch("/api/references/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      apiKey,
      filename: file.name,
      bytes: file.size,
      mimeType: file.type,
    }),
  }).then((response) => readApiResponse<{ ok: boolean; error?: string; uploadId: string }>(response));

  const chunks = Array.from({ length: Math.ceil(file.size / REFERENCE_CHUNK_BYTES) }, (_, index) => ({
    index,
    start: index * REFERENCE_CHUNK_BYTES,
    end: Math.min(file.size, (index + 1) * REFERENCE_CHUNK_BYTES),
  }));
  const partIds = new Array<string>(chunks.length);
  let uploadedBytes = 0;

  for (let batchStart = 0; batchStart < chunks.length; batchStart += 2) {
    const batch = chunks.slice(batchStart, batchStart + 2);
    await Promise.all(
      batch.map(async (chunk) => {
        const data = file.slice(chunk.start, chunk.end, "application/octet-stream");
        const form = new FormData();
        form.append("apiKey", apiKey);
        form.append("uploadId", started.uploadId);
        form.append("data", data, `${file.name}.part-${chunk.index + 1}`);
        const part = await fetch("/api/references/part", {
          method: "POST",
          body: form,
          signal,
        }).then((response) => readApiResponse<{ ok: boolean; error?: string; partId: string }>(response));
        partIds[chunk.index] = part.partId;
        uploadedBytes += chunk.end - chunk.start;
        onProgress(Math.min(0.98, uploadedBytes / file.size));
      }),
    );
  }

  const completed = await fetch("/api/references/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({ apiKey, uploadId: started.uploadId, partIds }),
  }).then((response) => readApiResponse<{ ok: boolean; error?: string; fileId: string }>(response));
  onProgress(1);
  return completed.fileId;
}

export default function Home() {
  const [collageType, setCollageType] = useState<CollageType>("bathroom_fixture_collage");
  const [orientation, setOrientation] = useState<Orientation>("default");
  const [quality, setQuality] = useState<Quality>("high");
  const [outputResolution, setOutputResolution] = useState<OutputResolution>("studio");
  const [composition, setComposition] = useState<Composition>("editorial");
  const [density, setDensity] = useState<Density>("balanced");
  const [styling, setStyling] = useState<StylingOption>("botanical_linen");
  const [lighting, setLighting] = useState<LightingOption>("soft_daylight");
  const [heroItemId, setHeroItemId] = useState("");
  const [outputFilename, setOutputFilename] = useState("material-collage.png");
  const apiKey = "";
  const [items, setItems] = useState<UiItem[]>(() => presetItems("bathroom_fixture_collage"));
  const [panelText, setPanelText] = useState("Board ready.");
  const [diagnostics, setDiagnostics] = useState<GenerationDiagnostics | null>(null);
  const [promptPreview, setPromptPreview] = useState("");
  const [isWorking, setIsWorking] = useState(false);
  const [workingStage, setWorkingStage] = useState("");
  const [overallProgress, setOverallProgress] = useState(0);
  const [referenceProgress, setReferenceProgress] = useState<Record<string, number>>({});
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [result, setResult] = useState<ResultState | null>(null);
  const resultUrlRef = useRef<string | null>(null);
  // Store the generated image as an object URL, not a multi-MB base64 string
  // held in React state and diffed into DOM attributes on every re-render.
  const commitResult = (next: ResultState | null) => {
    if (resultUrlRef.current && resultUrlRef.current !== next?.dataUrl) {
      URL.revokeObjectURL(resultUrlRef.current);
      resultUrlRef.current = null;
    }
    if (next?.dataUrl.startsWith("blob:")) resultUrlRef.current = next.dataUrl;
    setResult(next);
  };
  const [finalFormat, setFinalFormat] = useState<FinalFormat>("landscape");
  const [jobs, setJobs] = useState<GenerationJob[]>([]);
  const hasLoadedDraft = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  // Token per item so a slower analyze response for a superseded reference
  // can't overwrite the fields of whatever is primary now.
  const analyzeTokens = useRef<Map<string, number>>(new Map());
  const analysisCache = useRef<Map<string, ReferenceAnalysis>>(new Map());
  const jobsRef = useRef<GenerationJob[]>([]);

  const totalReferences = useMemo(
    () => items.reduce((total, item) => total + item.references.length, 0),
    [items],
  );
  const totalReferenceBytes = useMemo(
    () => items.reduce((total, item) => total + item.references.reduce((sum, ref) => sum + ref.file.size, 0), 0),
    [items],
  );
  const hasFiles = totalReferences > 0;
  const heroOptions = useMemo(() => items.filter((item) => item.references.length > 0), [items]);
  const [previewWidth, previewHeight] = resolvedSize({ collageType, orientation, quality, outputResolution, items: [] })
    .split("x")
    .map(Number);

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
    void refreshJobs();
    // Only poll while a queued job is still running and the tab is visible;
    // otherwise the endpoint is hit every 30s forever for no reason.
    const hasPending = () => jobsRef.current.some((job) => !TERMINAL_JOB_STATUSES.has(job.status));
    const interval = window.setInterval(() => {
      if (document.visibilityState !== "hidden" && hasPending()) void refreshJobs();
    }, 30000);
    const onVisibility = () => {
      if (document.visibilityState === "visible" && hasPending()) void refreshJobs();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  useEffect(() => () => {
    if (resultUrlRef.current) URL.revokeObjectURL(resultUrlRef.current);
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
    outputResolution,
    composition,
    density,
    styling,
    lighting,
    heroItemId,
    outputFilename,
    items,
  ]);

  function revokeItemPreviews(currentItems: UiItem[]) {
    for (const item of currentItems) {
      for (const reference of item.references) URL.revokeObjectURL(reference.preview);
    }
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
        references: [...item.references, createReference(file, undefined, {
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

  function addReferences(itemKey: string, fileList: FileList | null) {
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
              references: [...item.references, ...files.map((file, index) => createReference(file, undefined, {
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
    const replacement = createReference(file, undefined, { primary: existing.primary, provenance: "upload" });
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
    setReferenceProgress((current) => {
      const next = { ...current };
      delete next[referenceKey];
      return next;
    });
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

  function updateReferenceRemote(itemKey: string, referenceKey: string, remote: ReferenceUploadCache) {
    setItems((current) =>
      current.map((item) =>
        item.uiKey === itemKey
          ? {
              ...item,
              references: item.references.map((reference) =>
                reference.uiKey === referenceKey ? { ...reference, remote } : reference,
              ),
            }
          : item,
      ),
    );
  }

  function makeDraft(): SavedDraft {
    return {
      version: 2,
      collageType,
      orientation,
      quality,
      outputResolution,
      composition,
      density,
      styling,
      lighting,
      heroItemId,
      outputFilename,
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
          remote: reference.remote,
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
    setQuality(draft.quality);
    setOutputResolution(draft.outputResolution ?? "studio");
    setComposition(draft.composition ?? "editorial");
    setDensity(draft.density ?? "balanced");
    setStyling(draft.collageType === "appliance_collage" ? "materials_only" : (draft.styling ?? "botanical_linen"));
    setLighting(draft.lighting ?? "soft_daylight");
    setHeroItemId(draft.heroItemId ?? "");
    setOutputFilename(draft.outputFilename);
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

  function makePayload(
    includeApiKey: boolean,
    fileIdsByReference?: Map<string, string>,
  ): CollageRequestInput {
    return {
      collageType,
      orientation,
      quality,
      outputResolution,
      composition,
      density,
      styling: collageType === "appliance_collage" ? "materials_only" : styling,
      lighting,
      heroItemId: heroItemId || undefined,
      outputFilename,
      apiKey: includeApiKey ? apiKey : "",
      items: items.map((item, index) => ({
        id: resolvedItemId(item, index),
        role: item.role,
        brand: item.brand,
        name: item.name,
        finish: item.finish,
        notes: item.notes,
        required: item.required,
        imageNames: item.references.map((reference) => reference.file.name),
        imageFileIds: fileIdsByReference
          ? item.references.map((reference) => fileIdsByReference.get(reference.uiKey) || "").filter(Boolean)
          : undefined,
      })),
    };
  }

  async function refreshJobs() {
    try {
      const response = await fetch("/api/economy", { cache: "no-store" })
        .then((value) => readApiResponse<{ ok: boolean; error?: string; jobs: GenerationJob[] }>(value));
      jobsRef.current = response.jobs;
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

  async function ensureFullQualityReferenceIds(controller: AbortController) {
    const fingerprint = await credentialFingerprint(apiKey);
    const fileIds = new Map<string, string>();
    const references = items.flatMap((item) => item.references.map((reference) => ({ itemKey: item.uiKey, reference })));
    let complete = 0;
    const markComplete = () => {
      complete += 1;
      setWorkingStage(`Uploading full-quality references ${complete}/${references.length}`);
      setOverallProgress(Math.round((complete / Math.max(references.length + 1, 1)) * 100));
    };
    const uploadOne = async (entry: (typeof references)[number]) => {
      const cached = entry.reference.remote;
      if (cached?.credentialFingerprint === fingerprint && cached.fileFingerprint === fileFingerprint(entry.reference.file)) {
        fileIds.set(entry.reference.uiKey, cached.fileId);
      } else {
        const fileId = await uploadReferenceFile(entry.reference.file, apiKey, controller.signal, (progress) => {
          setReferenceProgress((current) => ({ ...current, [entry.reference.uiKey]: progress }));
        });
        const remote = { fileId, credentialFingerprint: fingerprint, fileFingerprint: fileFingerprint(entry.reference.file) };
        updateReferenceRemote(entry.itemKey, entry.reference.uiKey, remote);
        fileIds.set(entry.reference.uiKey, fileId);
      }
      markComplete();
    };
    // Upload a few references at a time instead of strictly one-by-one; each
    // upload is itself several chunked round trips, so serial finalization of a
    // full board adds minutes on a slow uplink.
    const queue = [...references];
    const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
      for (let entry = queue.shift(); entry; entry = queue.shift()) await uploadOne(entry);
    });
    await Promise.all(workers);
    return fileIds;
  }

  async function finalizeDraft(mode: "immediate" | "economy") {
    if (!result) return;
    if (totalReferences > 15) {
      setPanelText("Final rendering can use the approved draft plus up to 15 product references. Remove one supporting view and retry.");
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setIsWorking(true);
    setOverallProgress(0);
    setReferenceProgress({});
    let transportFilesForReport: File[] | undefined;
    try {
      const layoutFile = await dataUrlFile(result.dataUrl, "approved-draft.png");

      if (mode === "economy") {
        // Economy uses the OpenAI Batch API, whose inputs can only be referenced
        // by uploaded file ID, so it still depends on the Uploads API.
        const fileIds = await ensureFullQualityReferenceIds(controller);
        setWorkingStage("Uploading approved composition");
        const layoutFileId = await uploadReferenceFile(layoutFile, apiKey, controller.signal, (progress) => {
          setOverallProgress(Math.round(90 + progress * 10));
        });
        const economyPayload: CollageRequestInput = {
          ...makePayload(false, fileIds),
          orientation: finalFormat,
          quality: "high",
          outputResolution: "final",
          layoutReference: true,
          layoutReferenceFileId: layoutFileId,
          renderKind: "final",
        };
        validateCollageRequest(economyPayload);
        setWorkingStage("Sending final render to Economy");
        const queued = await fetch("/api/economy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({ payload: economyPayload }),
        }).then((value) => readApiResponse<{ ok: boolean; error?: string; jobId: string; status: string; estimatedUsd: number }>(value));
        setPanelText(`Final render queued in Economy. Estimated generation cost: $${queued.estimatedUsd.toFixed(2)} plus reference input. It will remain in History for 6 months.`);
        await refreshJobs();
        return;
      }

      // Immediate Final sends the approved draft plus the product references
      // directly as multipart, exactly like the Studio render, so it never
      // touches the OpenAI Uploads API (which returns 500 in this hosting
      // environment). The draft is sent first so the server treats it as the
      // layout reference.
      const payload: CollageRequestInput = {
        ...makePayload(false),
        orientation: finalFormat,
        quality: "high",
        outputResolution: "final",
        layoutReference: true,
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
      // the real number and the Economy alternative beats the host's opaque
      // 413, which is what sent this bug to the wrong stage in the first place.
      const bodyBytes = layoutTransport.size + transportFiles.reduce((sum, file) => sum + file.size, 0);
      if (bodyBytes > FINAL_REQUEST_BODY_BUDGET) {
        throw new Error(
          `The final render payload is ${formatBytes(bodyBytes)} after optimization, over the ${formatBytes(FINAL_REQUEST_BODY_BUDGET)} this host accepts in one request. Remove a supporting view, or use the Economy final render, which uploads each reference separately at full quality.`,
        );
      }
      setWorkingStage("Rendering final at maximum quality");
      const form = new FormData();
      form.append("payload", JSON.stringify(payload));
      form.append("image[]", layoutTransport, layoutTransport.name);
      for (const file of transportFiles) form.append("image[]", file, file.name);
      setOverallProgress(100);
      const response = await fetch("/api/generate", { method: "POST", signal: controller.signal, body: form })
        .then((value) => readApiResponse<GenerateResponse>(value));
      if (!response.imageBase64) throw new Error("Final rendering completed without an image.");
      const dataUrl = base64ImageToObjectUrl(response.imageBase64, response.mimeType || "image/png");
      commitResult({
        dataUrl,
        filename: response.filename || outputFilename,
        qa: response.qa ?? null,
        kind: "final",
        jobId: response.jobId,
        libraryVisible: response.libraryVisible ?? true,
      });
      setQaRedoSelection(Object.fromEntries((response.qa?.items ?? []).map((item) => [item.id, !item.passed && Boolean(item.box)])));
      setPromptPreview(response.prompt || "");
      setDiagnostics(response.diagnostics ?? null);
      // Only assert the max resolution when the server did not fall back; a
      // notice means it downgraded, so show that instead of a false size.
      const finalSizeLabel = finalSizeFor(finalFormat, collageType);
      setPanelText(`Final ${finalFormat} render complete${response.notice ? "" : ` at ${finalSizeLabel}`}. Full-quality product references were used.${response.notice ? `\n\n${response.notice}` : ""}`);
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
            model: "gpt-image-2",
            transport: "multipart",
            quality: "high",
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
        setPanelText(`Final rendering failed: ${error instanceof Error ? error.message : "Unknown error."}`);
      }
    } finally {
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
    commitResult(null);
    setPromptPreview("");
    setOverallProgress(0);
    setWorkingStage(renderPreset === "draft" ? "Preparing quick draft" : "Checking references");
    let transportFilesForReport: File[] | null = null;

    try {
      const renderPayload = (payload: CollageRequestInput): CollageRequestInput => ({
        ...payload,
        ...(renderPreset === "draft" ? { quality: "low" as const, outputResolution: "standard" as const } : {}),
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
      setWorkingStage("Optimizing references for direct generation");
      const transportFiles = await optimizeReferencesForTransport(
        referencesToSend.map((entry) => entry.reference.file),
        DIRECT_REQUEST_REFERENCE_BUDGET,
      );
      transportFilesForReport = transportFiles;
      for (const file of transportFiles) form.append("image[]", file, file.name);
      setWorkingStage("Composing collage");
      const response = await fetch(diagnosticMode ? `/api/generate?diagnostic=isolation&count=${diagnosticCount}` : "/api/generate", {
        method: "POST",
        signal: controller.signal,
        body: form,
      }).then((value) => readApiResponse<GenerateResponse>(value));

      if (diagnosticMode && response.diagnosticComplete) {
        setDiagnostics(response.diagnostics ?? null);
        if (response.imageBase64) {
          commitResult({
            dataUrl: base64ImageToObjectUrl(response.imageBase64, response.mimeType || "image/png"),
            filename: response.filename || "isolation-test.png",
            kind: "studio",
            libraryVisible: false,
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
      });
      setPromptPreview(response.prompt || "");
      // Start the final-render switch on the shape the approved draft was
      // actually composed in, so finalizing a portrait draft doesn't silently
      // re-crop it to landscape.
      if (renderPreset === "draft") setFinalFormat(resolvedOrientation(payload));
      setPanelText(`${renderPreset === "draft" ? "Draft ready. Review the composition, then choose an immediate or Economy final render below." : response.summary || "Collage generated."}${response.notice ? `\n\n${response.notice}` : ""}`);
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
            model: "gpt-image-2",
            transport: "multipart",
            quality: diagnosticMode ? "low" : quality,
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
        setPanelText(`${diagnosticMode ? "Isolation test" : "Generation"} failed: ${error instanceof Error ? error.message : "Unknown error."}`);
      }
    } finally {
      setIsWorking(false);
      setWorkingStage("");
      abortRef.current = null;
    }
  }

  function cancelWork() {
    abortRef.current?.abort();
  }

  return (
    <main className="app-shell generator-shell">
      <header className="site-navigation generator-navigation">
        <Link className="site-wordmark" href="/">Material Collager</Link>
        <nav aria-label="Primary navigation">
          <Link href="/">Library</Link>
          <Link className="active" href="/generator">Generator</Link>
          <Link href="/workbench">Workbench</Link>
        </nav>
        <div className="generator-status" aria-label="Board reference summary">
          <span>{totalReferences}/{MAX_REFERENCE_IMAGES} references</span>
          <span>{formatBytes(totalReferenceBytes)}</span>
          <span>{lastSavedAt ? "Draft saved" : "Local draft"}</span>
        </div>
      </header>

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
                options={COMPOSITIONS.map((option) => ({ value: option, label: labelFor(option) }))}
              />
            </label>
            <label>
              <span>Spacing</span>
              <DropdownSelect
                value={density}
                onChange={(next) => setDensity(next as Density)}
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
              <span className={hasFiles ? "status-pill ready" : "status-pill"}>
                {totalReferences}/{MAX_REFERENCE_IMAGES}
              </span>
              <button type="button" className="add-item-button" onClick={addItem}>+ Add item</button>
            </div>
          </div>

          <div className="items-list">
            {items.map((item, index) => (
              <article className="material-item" key={item.uiKey}>
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
                  <div className="reference-strip">
                    {item.references.map((reference, referenceIndex) => {
                      const progress = referenceProgress[reference.uiKey];
                      return (
                        <figure className="reference-tile" key={reference.uiKey}>
                          <div className="reference-image-wrap">
                            <img src={reference.preview} alt={`${item.id || item.role} reference ${referenceIndex + 1}`} />
                            {referenceIndex === 0 && <span className="primary-badge">Primary</span>}
                            {isWorking && progress !== undefined && progress < 1 && (
                              <span className="reference-progress" style={{ height: `${Math.round(progress * 100)}%` }} />
                            )}
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

                <div
                  className="reference-dropzone"
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    addReferences(item.uiKey, event.dataTransfer.files);
                  }}
                >
                  <label>
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      onChange={(event) => {
                        addReferences(item.uiKey, event.target.files);
                        event.currentTarget.value = "";
                      }}
                    />
                    <span>{item.references.length ? "Add another view" : "Upload primary image"}</span>
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
                    <label>
                      <FieldLabel text="Item type" help="What this object contributes to the collage, such as main bathroom tile, vanity faucet, or countertop stone." />
                      <input value={item.role} onChange={(event) => updateItem(item.uiKey, { role: event.target.value })} />
                    </label>
                    <label>
                      <FieldLabel text="Product / model" help="The exact collection, model number, or SKU when known. Leave blank when the image does not prove it." />
                      <input value={item.name || ""} onChange={(event) => updateItem(item.uiKey, { name: event.target.value })} />
                    </label>
                    <label>
                      <FieldLabel text="Brand" help="The manufacturer name, not the retailer or showroom." />
                      <input value={item.brand || ""} onChange={(event) => updateItem(item.uiKey, { brand: event.target.value })} />
                    </label>
                    <label className="wide-field">
                      <FieldLabel text="Finish / color" help="Use the manufacturer finish name when known, or describe the visible material color and sheen." />
                      <input value={item.finish || ""} onChange={(event) => updateItem(item.uiKey, { finish: event.target.value })} />
                    </label>
                    <label className="wide-field">
                      <FieldLabel text="Generation notes" help="Add exceptions the image cannot communicate, such as which face to show, details to preserve, or objects that must not appear." />
                      <textarea value={item.notes || ""} onChange={(event) => updateItem(item.uiKey, { notes: event.target.value })} />
                    </label>
                  </div>
                </details>
              </article>
            ))}
          </div>

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
                {isWorking ? "Working" : result ? "Complete" : "Ready"}
              </span>
            </div>

            <div
              className={`result-stage ${result ? "has-result" : ""}`}
              style={result ? { aspectRatio: `${previewWidth} / ${previewHeight}` } : undefined}
            >
              {result ? (
                <img src={result.dataUrl} alt="Generated material collage" />
              ) : (
                <img src="/sample-collage.png" alt="Sample material collage" />
              )}
            </div>

            {isWorking && (
              <div className="work-progress" aria-live="polite">
                <div>
                  <span>{workingStage}</span>
                  <strong>{overallProgress > 0 && overallProgress < 100 ? `${overallProgress}%` : ""}</strong>
                </div>
                <div className="progress-track"><span style={{ width: `${overallProgress}%` }} /></div>
              </div>
            )}

            <div className="primary-actions">
              {isWorking ? (
                <button type="button" className="cancel-button" onClick={cancelWork}>Cancel</button>
              ) : (
                <button type="button" className="primary-button" onClick={() => void generate(false)} disabled={!hasFiles} title="Renders immediately using the selected quality, resolution, and styling settings.">
                  Current Settings
                </button>
              )}
              <button type="button" className="draft-button" onClick={() => void generate(false, 1, "draft")} disabled={isWorking || !hasFiles} title="Creates a low-cost preview for composition and placement.">
                Quick Draft
              </button>
              <button type="button" className="secondary-button" onClick={dryRun} disabled={isWorking}>
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
                  <button type="button" className="final-now-button" onClick={() => void finalizeDraft("immediate")} disabled={isWorking} title="Starts the maximum-quality final render immediately.">
                    Final Render Now
                    <small>{finalFormat === "square" ? "Est. $0.21" : "Est. $0.17"} + references</small>
                  </button>
                  <button type="button" className="economy-button" onClick={() => void finalizeDraft("economy")} disabled={isWorking} title="Queues the same maximum-quality final request for approximately half the generation cost.">
                    Economy Final
                    <small>{finalFormat === "square" ? "Est. $0.11" : "Est. $0.08"} + references / up to 24h</small>
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
              <details className="generation-history" open={jobs.some((job) => !["completed", "failed", "expired", "cancelled"].includes(job.status))}>
                <summary>Final render history</summary>
                <div className="history-list">
                  {jobs.map((job) => (
                    <article key={job.id}>
                      <div>
                        <strong>{job.mode === "economy" ? "Economy final" : "Final render"}</strong>
                        <span>{job.format} / {new Date(job.createdAt).toLocaleString()}</span>
                      </div>
                      <span className={`job-status ${job.status}`}>{job.status.replaceAll("_", " ")}</span>
                      {job.status === "completed" && (
                        <a href={`/api/economy/output/${job.id}`} download={job.filename}>Open PNG</a>
                      )}
                      {job.estimatedUsd !== null && <small>Est. ${job.estimatedUsd.toFixed(2)} + reference input</small>}
                      {job.qa && <small>Accuracy review: {job.qa.reviewFailed ? "unavailable" : `${job.qa.score}/100`}</small>}
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
