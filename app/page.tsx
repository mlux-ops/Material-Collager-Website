/* eslint-disable @next/next/no-img-element */
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
};

type UiItem = Omit<CollageItemInput, "imageKeys" | "imageNames" | "imageFileIds"> & {
  uiKey: string;
  references: UiReference[];
};

type DraftReference = Omit<UiReference, "preview">;

type DraftItem = Omit<CollageItemInput, "imageKeys" | "imageNames" | "imageFileIds"> & {
  uiKey?: string;
  references?: DraftReference[];
  files?: File[];
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
  runQa: boolean;
  items: DraftItem[];
  savedAt: number;
};

type QaResult = {
  passed: boolean;
  score: number;
  findings: string[];
  recommendation: string;
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
  qa?: QaResult | null;
};

const REFERENCE_CHUNK_BYTES = 4 * 1024 * 1024;
const DRAFT_DB_NAME = "material-collager-drafts";
const DRAFT_STORE_NAME = "drafts";
const CURRENT_DRAFT_KEY = "current";

function createUiKey() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function fileFingerprint(file: File) {
  return `${file.name}:${file.size}:${file.lastModified}:${file.type}`;
}

function createReference(file: File, remote?: ReferenceUploadCache): UiReference {
  return {
    uiKey: createUiKey(),
    file,
    preview: URL.createObjectURL(file),
    remote,
  };
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
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
    const request = transaction.objectStore(DRAFT_STORE_NAME).get(CURRENT_DRAFT_KEY);
    request.onsuccess = () => resolve((request.result as SavedDraft | undefined) ?? null);
    request.onerror = () => reject(request.error || new Error("Could not read saved draft."));
    transaction.oncomplete = () => db.close();
    transaction.onerror = () => {
      db.close();
      reject(transaction.error || new Error("Could not read saved draft."));
    };
  });
}

async function writeSavedDraft(draft: SavedDraft) {
  const db = await openDraftDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(DRAFT_STORE_NAME, "readwrite");
    transaction.objectStore(DRAFT_STORE_NAME).put(draft, CURRENT_DRAFT_KEY);
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
    transaction.objectStore(DRAFT_STORE_NAME).delete(CURRENT_DRAFT_KEY);
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

async function readApiResponse<T extends { ok: boolean; error?: string }>(response: Response): Promise<T> {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const payload = (await response.json()) as T;
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || `Request failed with status ${response.status}.`);
    }
    return payload;
  }

  const text = (await response.text()).trim();
  if (response.status === 413 || /payload too large/i.test(text)) {
    throw new Error("A reference chunk was rejected by the host. The original files are still saved in your draft.");
  }
  throw new Error(text || `Request failed with status ${response.status}.`);
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
  const [apiKey, setApiKey] = useState("");
  const [runQa, setRunQa] = useState(true);
  const [items, setItems] = useState<UiItem[]>(() => presetItems("bathroom_fixture_collage"));
  const [panelText, setPanelText] = useState("Board ready.");
  const [promptPreview, setPromptPreview] = useState("");
  const [isWorking, setIsWorking] = useState(false);
  const [workingStage, setWorkingStage] = useState("");
  const [overallProgress, setOverallProgress] = useState(0);
  const [referenceProgress, setReferenceProgress] = useState<Record<string, number>>({});
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [result, setResult] = useState<{ dataUrl: string; filename: string; qa: QaResult | null } | null>(null);
  const hasLoadedDraft = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

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
    runQa,
    items,
  ]);

  function revokeItemPreviews(currentItems: UiItem[]) {
    for (const item of currentItems) {
      for (const reference of item.references) URL.revokeObjectURL(reference.preview);
    }
  }

  function changeType(nextType: CollageType) {
    if (hasFiles && !window.confirm("Change board type and remove the references currently on this board?")) return;
    setItems((current) => {
      revokeItemPreviews(current);
      return presetItems(nextType);
    });
    setCollageType(nextType);
    setOrientation("default");
    setStyling(nextType === "appliance_collage" ? "materials_only" : "botanical_linen");
    setHeroItemId("");
    setResult(null);
    setPromptPreview("");
    setPanelText("Board ready.");
  }

  function resetPreset() {
    if (hasFiles && !window.confirm("Reset this board and remove its current references?")) return;
    setItems((current) => {
      revokeItemPreviews(current);
      return presetItems(collageType);
    });
    setHeroItemId("");
    setResult(null);
    setPromptPreview("");
    setPanelText("Preset reset.");
  }

  function updateItem(itemKey: string, patch: Partial<UiItem>) {
    setItems((current) => current.map((item) => (item.uiKey === itemKey ? { ...item, ...patch } : item)));
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

    setItems((current) =>
      current.map((item) =>
        item.uiKey === itemKey
          ? { ...item, references: [...item.references, ...files.map((file) => createReference(file))] }
          : item,
      ),
    );
    setPanelText(`${files.length} reference image${files.length === 1 ? "" : "s"} added.`);
  }

  function removeReference(itemKey: string, referenceKey: string) {
    const item = items.find((candidate) => candidate.uiKey === itemKey);
    if (item?.id === heroItemId && item.references.length === 1) setHeroItemId("");
    setItems((current) =>
      current.map((item) => {
        if (item.uiKey !== itemKey) return item;
        const reference = item.references.find((candidate) => candidate.uiKey === referenceKey);
        if (reference) URL.revokeObjectURL(reference.preview);
        return { ...item, references: item.references.filter((candidate) => candidate.uiKey !== referenceKey) };
      }),
    );
    setReferenceProgress((current) => {
      const next = { ...current };
      delete next[referenceKey];
      return next;
    });
  }

  function makePrimary(itemKey: string, referenceKey: string) {
    setItems((current) =>
      current.map((item) => {
        if (item.uiKey !== itemKey) return item;
        const selected = item.references.find((reference) => reference.uiKey === referenceKey);
        if (!selected) return item;
        return {
          ...item,
          references: [selected, ...item.references.filter((reference) => reference.uiKey !== referenceKey)],
        };
      }),
    );
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
      runQa,
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
        references: item.references.map((reference) => ({
          uiKey: reference.uiKey,
          file: reference.file,
          remote: reference.remote,
        })),
      })),
    };
  }

  function restoreDraft(draft: SavedDraft) {
    setItems((current) => {
      revokeItemPreviews(current);
      return draft.items.map((item) => {
        const savedReferences = item.references?.length
          ? item.references
          : (item.files ?? []).map((file) => ({ uiKey: createUiKey(), file }));
        return {
          id: item.id,
          role: item.role,
          brand: item.brand ?? "",
          name: item.name ?? "",
          finish: item.finish ?? "",
          notes: item.notes ?? "",
          required: item.required,
          uiKey: item.uiKey || createUiKey(),
          references: savedReferences.map((reference) => ({
            ...reference,
            uiKey: reference.uiKey || createUiKey(),
            preview: URL.createObjectURL(reference.file),
          })),
        };
      });
    });
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
    setRunQa(draft.runQa ?? true);
    setResult(null);
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

  function makePayload(includeApiKey: boolean, fileIdsByReference?: Map<string, string>): CollageRequestInput {
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
      runQa,
      items: items.map((item, index) => ({
        id: item.id || slugify(item.role || `item_${index + 1}`),
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

  async function dryRun() {
    setIsWorking(true);
    setWorkingStage("Reviewing board");
    try {
      const payload = makePayload(false);
      validateCollageRequest(payload);
      const response = await fetch("/api/dry-run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).then((value) =>
        readApiResponse<{ ok: boolean; error?: string; summary?: string; prompt?: string }>(value),
      );
      setPromptPreview(response.prompt || "");
      setPanelText(response.summary || "Board prompt is ready.");
    } catch (error) {
      setPanelText(`Review failed: ${error instanceof Error ? error.message : "Could not review board."}`);
    } finally {
      setIsWorking(false);
      setWorkingStage("");
    }
  }

  async function generate() {
    const controller = new AbortController();
    abortRef.current = controller;
    setIsWorking(true);
    setResult(null);
    setPromptPreview("");
    setOverallProgress(0);
    setWorkingStage("Checking references");

    try {
      const validationPayload = makePayload(false);
      validateCollageRequest(validationPayload);
      const keyFingerprint = await credentialFingerprint(apiKey);
      const references = items.flatMap((item) =>
        item.references.map((reference) => ({ itemKey: item.uiKey, itemId: item.id, reference })),
      );
      const fileIdsByReference = new Map<string, string>();
      const progress = new Map<string, number>();

      for (const entry of references) {
        const fingerprint = fileFingerprint(entry.reference.file);
        const cached = entry.reference.remote;
        if (
          cached &&
          cached.credentialFingerprint === keyFingerprint &&
          cached.fileFingerprint === fingerprint
        ) {
          fileIdsByReference.set(entry.reference.uiKey, cached.fileId);
          progress.set(entry.reference.uiKey, 1);
        } else {
          progress.set(entry.reference.uiKey, 0);
        }
      }

      const updateProgress = (referenceKey: string, value: number) => {
        progress.set(referenceKey, value);
        const weighted = references.reduce(
          (sum, entry) => sum + entry.reference.file.size * (progress.get(entry.reference.uiKey) ?? 0),
          0,
        );
        setOverallProgress(Math.round((weighted / Math.max(totalReferenceBytes, 1)) * 100));
        setReferenceProgress(Object.fromEntries(progress));
      };

      const pending = references.filter((entry) => !fileIdsByReference.has(entry.reference.uiKey));
      for (let batchStart = 0; batchStart < pending.length; batchStart += 2) {
        const batch = pending.slice(batchStart, batchStart + 2);
        setWorkingStage(`Preparing references ${batchStart + 1}-${Math.min(batchStart + 2, pending.length)} of ${pending.length}`);
        await Promise.all(
          batch.map(async (entry) => {
            const fileId = await uploadReferenceFile(
              entry.reference.file,
              apiKey,
              controller.signal,
              (value) => updateProgress(entry.reference.uiKey, value),
            );
            const remote = {
              fileId,
              credentialFingerprint: keyFingerprint,
              fileFingerprint: fileFingerprint(entry.reference.file),
            };
            fileIdsByReference.set(entry.reference.uiKey, fileId);
            updateReferenceRemote(entry.itemKey, entry.reference.uiKey, remote);
          }),
        );
      }

      setOverallProgress(100);
      setWorkingStage(runQa ? "Composing and reviewing collage" : "Composing collage");
      const payload = makePayload(true, fileIdsByReference);
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify(payload),
      }).then((value) => readApiResponse<GenerateResponse>(value));

      if (!response.imageBase64) throw new Error("Generation completed without an image.");
      const dataUrl = `data:${response.mimeType || "image/png"};base64,${response.imageBase64}`;
      setResult({
        dataUrl,
        filename: response.filename || outputFilename || "material-collage.png",
        qa: response.qa ?? null,
      });
      setPromptPreview(response.prompt || "");
      setPanelText(response.summary || "Collage generated.");
      await saveDraft(false);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setPanelText("Generation cancelled. Your board and references are still saved.");
      } else {
        setPanelText(`Generation failed: ${error instanceof Error ? error.message : "Unknown error."}`);
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
    <main className="app-shell">
      <header className="studio-header">
        <div className="brand-block">
          <p className="eyebrow">Interior Finish Boards</p>
          <h1>Material Collager</h1>
        </div>
        <div className="board-metrics" aria-label="Board reference summary">
          <div>
            <strong>{totalReferences}</strong>
            <span>of {MAX_REFERENCE_IMAGES} references</span>
          </div>
          <div>
            <strong>{formatBytes(totalReferenceBytes)}</strong>
            <span>source files</span>
          </div>
          <div>
            <strong>{lastSavedAt ? "Saved" : "Local"}</strong>
            <span>{lastSavedAt ? new Date(lastSavedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "browser draft"}</span>
          </div>
        </div>
      </header>

      <div className="workbench">
        <section className="builder-surface">
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
            <label>
              <span>Board type</span>
              <select value={collageType} onChange={(event) => changeType(event.target.value as CollageType)}>
                {COLLAGE_TYPES.map((type) => (
                  <option key={type} value={type}>{labelFor(type)}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Orientation</span>
              <select value={orientation} onChange={(event) => setOrientation(event.target.value as Orientation)}>
                {ORIENTATIONS.map((option) => (
                  <option key={option} value={option}>{labelFor(option)}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Resolution</span>
              <select value={outputResolution} onChange={(event) => setOutputResolution(event.target.value as OutputResolution)}>
                {OUTPUT_RESOLUTIONS.map((option) => (
                  <option key={option} value={option}>{option === "studio" ? "Studio 2K" : "Standard"}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Render quality</span>
              <select value={quality} onChange={(event) => setQuality(event.target.value as Quality)}>
                {QUALITIES.map((option) => (
                  <option key={option} value={option}>{labelFor(option)}</option>
                ))}
              </select>
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
              <select value={composition} onChange={(event) => setComposition(event.target.value as Composition)}>
                {COMPOSITIONS.map((option) => (
                  <option key={option} value={option}>{labelFor(option)}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Spacing</span>
              <select value={density} onChange={(event) => setDensity(event.target.value as Density)}>
                {DENSITIES.map((option) => (
                  <option key={option} value={option}>{labelFor(option)}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Lighting</span>
              <select value={lighting} onChange={(event) => setLighting(event.target.value as LightingOption)}>
                {LIGHTING_OPTIONS.map((option) => (
                  <option key={option} value={option}>{labelFor(option)}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Styling</span>
              <select
                value={collageType === "appliance_collage" ? "materials_only" : styling}
                onChange={(event) => setStyling(event.target.value as StylingOption)}
                disabled={collageType === "appliance_collage"}
              >
                {STYLING_OPTIONS.map((option) => (
                  <option key={option} value={option}>{labelFor(option)}</option>
                ))}
              </select>
            </label>
            <label className="wide-field">
              <span>Hero item</span>
              <select value={heroItemId} onChange={(event) => setHeroItemId(event.target.value)}>
                <option value="">Automatic</option>
                {heroOptions.map((item) => (
                  <option key={item.uiKey} value={item.id}>{item.id || item.role}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="surface-divider" />

          <div className="surface-heading compact-heading reference-heading">
            <div>
              <p className="section-kicker">03</p>
              <h2>Materials and products</h2>
            </div>
            <span className={hasFiles ? "status-pill ready" : "status-pill"}>
              {totalReferences}/{MAX_REFERENCE_IMAGES}
            </span>
          </div>

          <div className="items-list">
            {items.map((item, index) => (
              <article className="material-item" key={item.uiKey}>
                <div className="item-row-head">
                  <div className="item-title-group">
                    <span className="item-number">{String(index + 1).padStart(2, "0")}</span>
                    <div>
                      <strong>{item.role || item.id || `Item ${index + 1}`}</strong>
                      <span>{item.id || "Unassigned ID"}{item.required === false ? " / Optional" : ""}</span>
                    </div>
                  </div>
                  <button type="button" className="text-button danger" onClick={() => removeItem(item.uiKey)}>
                    Remove item
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
                          <div className="reference-actions">
                            {referenceIndex > 0 && (
                              <button type="button" onClick={() => makePrimary(item.uiKey, reference.uiKey)}>
                                Make primary
                              </button>
                            )}
                            <button type="button" onClick={() => removeReference(item.uiKey, reference.uiKey)}>
                              Remove
                            </button>
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
                      multiple
                      onChange={(event) => {
                        addReferences(item.uiKey, event.target.files);
                        event.currentTarget.value = "";
                      }}
                    />
                    <span>Add references</span>
                  </label>
                  <span>PNG, JPEG, or WebP / under 50 MB each</span>
                </div>

                <details className="item-details">
                  <summary>Product details</summary>
                  <div className="item-fields">
                    <label>
                      <span>ID</span>
                      <input
                        value={item.id}
                        onChange={(event) => {
                          const nextId = event.target.value;
                          if (heroItemId === item.id) setHeroItemId(nextId);
                          updateItem(item.uiKey, { id: nextId });
                        }}
                      />
                    </label>
                    <label>
                      <span>Role</span>
                      <input value={item.role} onChange={(event) => updateItem(item.uiKey, { role: event.target.value })} />
                    </label>
                    <label>
                      <span>Product name</span>
                      <input value={item.name || ""} onChange={(event) => updateItem(item.uiKey, { name: event.target.value })} />
                    </label>
                    <label>
                      <span>Brand</span>
                      <input value={item.brand || ""} onChange={(event) => updateItem(item.uiKey, { brand: event.target.value })} />
                    </label>
                    <label className="wide-field">
                      <span>Finish</span>
                      <input value={item.finish || ""} onChange={(event) => updateItem(item.uiKey, { finish: event.target.value })} />
                    </label>
                    <label className="wide-field">
                      <span>Specific instructions</span>
                      <textarea value={item.notes || ""} onChange={(event) => updateItem(item.uiKey, { notes: event.target.value })} />
                    </label>
                  </div>
                </details>
              </article>
            ))}
          </div>

          <button type="button" className="add-item-button" onClick={addItem}>Add custom item</button>

          <details className="settings-drawer">
            <summary>Generation settings</summary>
            <div className="control-grid settings-controls">
              <label>
                <span>Output file name</span>
                <input value={outputFilename} onChange={(event) => setOutputFilename(event.target.value)} />
              </label>
              <label>
                <span>OpenAI API key</span>
                <input
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  type="password"
                  autoComplete="off"
                  placeholder="Uses hosted key when blank"
                />
              </label>
              <label className="toggle-field wide-field">
                <input checked={runQa} onChange={(event) => setRunQa(event.target.checked)} type="checkbox" />
                <span>Run accuracy review after generation</span>
              </label>
            </div>
            <div className="drawer-actions">
              <button type="button" onClick={() => void restoreSavedDraft()}>Restore saved draft</button>
              <button type="button" className="danger" onClick={() => void clearSavedDraft()}>Delete saved draft</button>
            </div>
          </details>
        </section>

        <aside className="output-surface">
          <div className="output-sticky">
            <div className="surface-heading output-heading">
              <div>
                <p className="section-kicker">04</p>
                <h2>Collage output</h2>
              </div>
              <span className={isWorking ? "status-pill working" : result ? "status-pill ready" : "status-pill"}>
                {isWorking ? "Working" : result ? "Complete" : "Ready"}
              </span>
            </div>

            <div className={`result-stage ${result ? "has-result" : ""}`}>
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
              <button type="button" className="secondary-button" onClick={dryRun} disabled={isWorking}>
                Review prompt
              </button>
              {isWorking ? (
                <button type="button" className="cancel-button" onClick={cancelWork}>Cancel</button>
              ) : (
                <button type="button" className="primary-button" onClick={generate} disabled={!hasFiles}>
                  Generate studio collage
                </button>
              )}
              {result && (
                <a className="download-button" href={result.dataUrl} download={result.filename}>Download PNG</a>
              )}
            </div>

            {result?.qa && (
              <section className={`qa-result ${result.qa.passed ? "passed" : "review"}`}>
                <div>
                  <span>Accuracy review</span>
                  <strong>{result.qa.score}/100</strong>
                </div>
                {result.qa.findings.length > 0 && (
                  <ul>{result.qa.findings.map((finding) => <li key={finding}>{finding}</li>)}</ul>
                )}
                {result.qa.recommendation && <p>{result.qa.recommendation}</p>}
              </section>
            )}

            <div className="activity-log" aria-live="polite">{panelText}</div>

            {promptPreview && (
              <details className="prompt-drawer">
                <summary>Generation prompt</summary>
                <pre>{promptPreview}</pre>
              </details>
            )}
          </div>
        </aside>
      </div>
    </main>
  );
}
