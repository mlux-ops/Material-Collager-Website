"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  COLLAGE_TYPES,
  ITEM_PRESETS,
  ORIENTATIONS,
  QUALITIES,
  labelFor,
  slugify,
  type CollageItemInput,
  type CollageRequestInput,
  type CollageType,
  type Orientation,
  type Quality,
} from "@/app/lib/collage";

type UiItem = CollageItemInput & {
  uiKey: string;
  files: File[];
  previews: string[];
};

type DraftItem = CollageItemInput & {
  files: File[];
};

type SavedDraft = {
  collageType: CollageType;
  orientation: Orientation;
  quality: Quality;
  outputFilename: string;
  runQa: boolean;
  items: DraftItem[];
  savedAt: number;
};

type GenerateResponse = {
  ok: boolean;
  error?: string;
  summary?: string;
  prompt?: string;
  imageBase64?: string;
  mimeType?: string;
  filename?: string;
  qa?: {
    passed: boolean;
    findings: string[];
    recommendation: string;
  } | null;
};

const UPLOAD_REQUEST_TARGET_BYTES = 8 * 1024 * 1024;
const UPLOAD_FORM_HEADROOM_BYTES = 700 * 1024;
const MAX_UPLOAD_IMAGE_DIMENSION = 1800;
const MAX_PREPARED_IMAGE_BYTES = 1600 * 1024;
const MIN_PREPARED_IMAGE_BYTES = 520 * 1024;
const DRAFT_DB_NAME = "material-collager-drafts";
const DRAFT_STORE_NAME = "drafts";
const CURRENT_DRAFT_KEY = "current";

function createUiKey() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
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
    const request = store.get(CURRENT_DRAFT_KEY);
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
    const store = transaction.objectStore(DRAFT_STORE_NAME);
    store.put(draft, CURRENT_DRAFT_KEY);
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
    const store = transaction.objectStore(DRAFT_STORE_NAME);
    store.delete(CURRENT_DRAFT_KEY);
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
    files: [],
    previews: [],
  }));
}

export default function Home() {
  const [collageType, setCollageType] = useState<CollageType>("bathroom_fixture_collage");
  const [orientation, setOrientation] = useState<Orientation>("default");
  const [quality, setQuality] = useState<Quality>("high");
  const [outputFilename, setOutputFilename] = useState("material-collage.png");
  const [apiKey, setApiKey] = useState("");
  const [runQa, setRunQa] = useState(false);
  const [items, setItems] = useState<UiItem[]>(() => presetItems("bathroom_fixture_collage"));
  const [panelText, setPanelText] = useState("Ready.");
  const [isWorking, setIsWorking] = useState(false);
  const [result, setResult] = useState<{ dataUrl: string; filename: string } | null>(null);
  const hasLoadedDraft = useRef(false);

  const hasFiles = useMemo(() => items.some((item) => item.files.length > 0), [items]);

  useEffect(() => {
    let cancelled = false;
    readSavedDraft()
      .then((draft) => {
        if (cancelled) return;
        if (draft) {
          restoreDraft(draft);
          setPanelText(`Restored saved draft from ${new Date(draft.savedAt).toLocaleString()}.`);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setPanelText(`Draft save is unavailable: ${error instanceof Error ? error.message : "Could not read saved draft."}`);
        }
      })
      .finally(() => {
        if (!cancelled) {
          hasLoadedDraft.current = true;
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hasLoadedDraft.current) return;

    const timeout = window.setTimeout(() => {
      void saveDraft(false);
    }, 900);

    return () => window.clearTimeout(timeout);
  }, [collageType, orientation, quality, outputFilename, runQa, items]);

  function changeType(nextType: CollageType) {
    setCollageType(nextType);
    setOrientation("default");
    setItems(presetItems(nextType));
    setResult(null);
    setPanelText("Ready.");
  }

  function updateItem(index: number, patch: Partial<UiItem>) {
    setItems((current) => current.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)));
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
        files: [],
        previews: [],
      },
    ]);
  }

  function removeItem(index: number) {
    setItems((current) => current.filter((_, itemIndex) => itemIndex !== index));
  }

  function onFiles(index: number, fileList: FileList | null) {
    const files = Array.from(fileList ?? []);
    const previews = files.map((file) => URL.createObjectURL(file));
    updateItem(index, { files, previews });
  }

  function makeDraft(): SavedDraft {
    return {
      collageType,
      orientation,
      quality,
      outputFilename,
      runQa,
      savedAt: Date.now(),
      items: items.map(({ previews, uiKey, ...item }) => item),
    };
  }

  function restoreDraft(draft: SavedDraft) {
    setCollageType(draft.collageType);
    setOrientation(draft.orientation);
    setQuality(draft.quality);
    setOutputFilename(draft.outputFilename);
    setRunQa(draft.runQa);
    setItems(
      draft.items.map((item) => ({
        ...item,
        uiKey: createUiKey(),
        files: item.files ?? [],
        previews: (item.files ?? []).map((file) => URL.createObjectURL(file)),
      })),
    );
    setResult(null);
  }

  async function saveDraft(showMessage: boolean) {
    await writeSavedDraft(makeDraft());
    if (showMessage) {
      setPanelText("Draft saved. Your text fields and reference images are stored in this browser.");
    }
  }

  async function restoreSavedDraft() {
    try {
      const draft = await readSavedDraft();
      if (!draft) {
        setPanelText("No saved draft found in this browser.");
        return;
      }

      restoreDraft(draft);
      setPanelText(`Restored saved draft from ${new Date(draft.savedAt).toLocaleString()}.`);
    } catch (error) {
      setPanelText(`Error: ${error instanceof Error ? error.message : "Could not restore saved draft."}`);
    }
  }

  async function clearSavedDraft() {
    try {
      await removeSavedDraft();
      setPanelText("Saved draft cleared from this browser.");
    } catch (error) {
      setPanelText(`Error: ${error instanceof Error ? error.message : "Could not clear saved draft."}`);
    }
  }

  async function readApiResponse<T>(response: Response): Promise<T> {
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      return (await response.json()) as T;
    }

    const text = (await response.text()).trim();
    if (response.status === 413 || /payload too large/i.test(text)) {
      throw new Error("The host rejected this upload before generation could start. I prepared smaller upload copies, but this batch still crossed the request limit.");
    }

    throw new Error(text || `Request failed with status ${response.status}.`);
  }

  async function prepareFilesForUpload() {
    const allFiles = items.flatMap((item) => item.files);
    const uploadBudget = Math.max(MIN_PREPARED_IMAGE_BYTES, UPLOAD_REQUEST_TARGET_BYTES - UPLOAD_FORM_HEADROOM_BYTES);
    const targetBytes = Math.max(
      MIN_PREPARED_IMAGE_BYTES,
      Math.min(MAX_PREPARED_IMAGE_BYTES, Math.floor(uploadBudget / Math.max(allFiles.length, 1))),
    );
    const prepared = new Map<string, File>();
    let originalBytes = 0;
    let uploadBytes = 0;
    let optimizedCount = 0;

    for (const [itemIndex, item] of items.entries()) {
      for (const [fileIndex, file] of item.files.entries()) {
        originalBytes += file.size;
        const uploadFile = await prepareImageForUpload(file, targetBytes);
        uploadBytes += uploadFile.size;
        if (uploadFile !== file) optimizedCount += 1;
        prepared.set(`${itemIndex}:${fileIndex}`, uploadFile);
      }
    }

    return { filesByKey: prepared, optimizedCount, originalBytes, uploadBytes };
  }

  async function prepareImageForUpload(file: File, targetBytes: number) {
    const bitmap = await createImageBitmap(file);
    if (file.size <= targetBytes && file.type !== "image/png" && Math.max(bitmap.width, bitmap.height) <= MAX_UPLOAD_IMAGE_DIMENSION) {
      bitmap.close();
      return file;
    }

    const scale = Math.min(1, MAX_UPLOAD_IMAGE_DIMENSION / Math.max(bitmap.width, bitmap.height));
    let width = Math.max(1, Math.round(bitmap.width * scale));
    let height = Math.max(1, Math.round(bitmap.height * scale));
    let quality = 0.88;
    let best = await renderImageUploadCopy(file, bitmap, width, height, quality);

    while (best.size > targetBytes && quality > 0.62) {
      quality -= 0.06;
      best = await renderImageUploadCopy(file, bitmap, width, height, quality);
    }

    while (best.size > targetBytes && Math.max(width, height) > 950) {
      width = Math.round(width * 0.86);
      height = Math.round(height * 0.86);
      quality = Math.max(0.68, quality);
      best = await renderImageUploadCopy(file, bitmap, width, height, quality);
    }

    bitmap.close();
    return best;
  }

  async function renderImageUploadCopy(file: File, bitmap: ImageBitmap, width: number, height: number, quality: number) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not prepare reference images for upload.");
    context.drawImage(bitmap, 0, 0, width, height);

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (value) => {
          if (value) resolve(value);
          else reject(new Error("Could not prepare reference images for upload."));
        },
        "image/jpeg",
        quality,
      );
    });

    const name = file.name.replace(/\.[^.]+$/, "") || "reference";
    return new File([blob], `${name}.jpg`, { type: "image/jpeg", lastModified: file.lastModified });
  }

  function makePayload(includeApiKey: boolean): CollageRequestInput {
    return {
      collageType,
      orientation,
      quality,
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
        imageNames: item.files.map((file) => file.name),
        imageKeys: item.files.map((_, fileIndex) => `${index}:${fileIndex}`),
      })),
    };
  }

  async function dryRun() {
    setIsWorking(true);
    setResult(null);
    try {
      const response = await fetch("/api/dry-run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(makePayload(false)),
      }).then((res) => readApiResponse<{ ok: boolean; error?: string; summary?: string; prompt?: string }>(res));

      if (!response.ok) throw new Error(response.error || "Dry run failed.");
      setPanelText(`${response.summary}\n\n--- Prompt ---\n\n${response.prompt}`);
    } catch (error) {
      setPanelText(`Error: ${error instanceof Error ? error.message : "Dry run failed."}`);
    } finally {
      setIsWorking(false);
    }
  }

  async function generate() {
    setIsWorking(true);
    setResult(null);
    setPanelText("Preparing references...");
    try {
      const payload = makePayload(true);
      const prepared = await prepareFilesForUpload();
      const form = new FormData();
      form.append("payload", JSON.stringify(payload));
      for (const [key, file] of prepared.filesByKey.entries()) {
        form.append(`file:${key}`, file, file.name);
      }

      const prepText =
        prepared.optimizedCount > 0
          ? `Prepared ${prepared.optimizedCount} large reference image${prepared.optimizedCount === 1 ? "" : "s"} for upload. Originals remain saved in your draft.`
          : "References are ready.";
      setPanelText(`${prepText}\nGenerating...`);

      const response = await fetch("/api/generate", { method: "POST", body: form }).then((res) =>
        readApiResponse<GenerateResponse>(res),
      );

      if (!response.ok || !response.imageBase64) throw new Error(response.error || "Generation failed.");
      const dataUrl = `data:${response.mimeType || "image/png"};base64,${response.imageBase64}`;
      const filename = response.filename || outputFilename || "material-collage.png";
      setResult({ dataUrl, filename });

      const qaText = response.qa
        ? `\n\nQA: ${response.qa.passed ? "Passed" : "Needs review"}\n${response.qa.findings.join("\n")}${
            response.qa.recommendation ? `\n${response.qa.recommendation}` : ""
          }`
        : "";
      const uploadNote =
        prepared.optimizedCount > 0
          ? `\n\nReference upload copies: ${(prepared.uploadBytes / (1024 * 1024)).toFixed(1)} MB sent from ${(prepared.originalBytes / (1024 * 1024)).toFixed(1)} MB of source images.`
          : "";
      setPanelText(`${response.summary || "Generated."}${qaText}${uploadNote}`);
    } catch (error) {
      setPanelText(`Error: ${error instanceof Error ? error.message : "Generation failed."}`);
    } finally {
      setIsWorking(false);
    }
  }

  return (
    <main className="app-shell">
      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">Interior Finish Boards</p>
            <h1>Material Collager</h1>
          </div>
          <div className="topbar-sample">
            <img src="/sample-collage.png" alt="Sample material collage" />
          </div>
        </header>

        <div className="tool-grid">
          <section className="panel builder-panel">
            <div className="panel-head">
              <h2>Board</h2>
              <span className={hasFiles ? "status good" : "status"}>{hasFiles ? "References loaded" : "No references"}</span>
            </div>

            <div className="control-grid">
              <label>
                <span>Type</span>
                <select value={collageType} onChange={(event) => changeType(event.target.value as CollageType)}>
                  {COLLAGE_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {labelFor(type)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Orientation</span>
                <select value={orientation} onChange={(event) => setOrientation(event.target.value as Orientation)}>
                  {ORIENTATIONS.map((option) => (
                    <option key={option} value={option}>
                      {labelFor(option)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Quality</span>
                <select value={quality} onChange={(event) => setQuality(event.target.value as Quality)}>
                  {QUALITIES.map((option) => (
                    <option key={option} value={option}>
                      {labelFor(option)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>File name</span>
                <input value={outputFilename} onChange={(event) => setOutputFilename(event.target.value)} />
              </label>
              <label className="wide-field">
                <span>OpenAI API key</span>
                <input
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  type="password"
                  autoComplete="off"
                  placeholder="Uses server key when blank"
                />
              </label>
              <label className="toggle-field">
                <input checked={runQa} onChange={(event) => setRunQa(event.target.checked)} type="checkbox" />
                <span>QA review</span>
              </label>
            </div>

            <div className="section-actions">
              <button type="button" className="secondary-button" onClick={() => setItems(presetItems(collageType))}>
                Reset Preset
              </button>
              <button type="button" className="secondary-button" onClick={addItem}>
                Add Item
              </button>
              <button type="button" className="secondary-button" onClick={() => void saveDraft(true)}>
                Save Draft
              </button>
              <button type="button" className="secondary-button" onClick={() => void restoreSavedDraft()}>
                Restore Draft
              </button>
              <button type="button" className="secondary-button" onClick={() => void clearSavedDraft()}>
                Clear Draft
              </button>
            </div>

            <div className="items-list">
              {items.map((item, index) => (
                <article className="item-row" key={item.uiKey}>
                  <div className="item-row-head">
                    <div>
                      <strong>{item.id || `Item ${index + 1}`}</strong>
                      <span>{item.files.length} image{item.files.length === 1 ? "" : "s"}</span>
                    </div>
                    <button type="button" className="icon-button danger" onClick={() => removeItem(index)} aria-label="Remove item">
                      ×
                    </button>
                  </div>

                  <div className="item-fields">
                    <label>
                      <span>ID</span>
                      <input value={item.id} onChange={(event) => updateItem(index, { id: event.target.value })} />
                    </label>
                    <label>
                      <span>Role</span>
                      <input value={item.role} onChange={(event) => updateItem(index, { role: event.target.value })} />
                    </label>
                    <label>
                      <span>Finish</span>
                      <input value={item.finish || ""} onChange={(event) => updateItem(index, { finish: event.target.value })} />
                    </label>
                    <label>
                      <span>Brand</span>
                      <input value={item.brand || ""} onChange={(event) => updateItem(index, { brand: event.target.value })} />
                    </label>
                    <label className="wide-field">
                      <span>Notes</span>
                      <textarea value={item.notes || ""} onChange={(event) => updateItem(index, { notes: event.target.value })} />
                    </label>
                    <label className="file-field wide-field">
                      <span>References</span>
                      <input type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={(event) => onFiles(index, event.target.files)} />
                    </label>
                  </div>

                  {item.previews.length > 0 && (
                    <div className="thumb-strip">
                      {item.previews.map((preview, previewIndex) => (
                        <img key={preview} src={preview} alt={`${item.id || item.role} reference ${previewIndex + 1}`} />
                      ))}
                    </div>
                  )}
                </article>
              ))}
            </div>
          </section>

          <section className="panel output-panel">
            <div className="panel-head">
              <h2>Output</h2>
              <span className="status">{isWorking ? "Working" : "Ready"}</span>
            </div>

            <div className="result-stage">
              {result ? (
                <img src={result.dataUrl} alt="Generated material collage" />
              ) : (
                <div className="empty-result">
                  <img src="/sample-collage.png" alt="Sample material collage" />
                </div>
              )}
            </div>

            <div className="primary-actions">
              <button type="button" className="secondary-button" onClick={dryRun} disabled={isWorking}>
                Dry Run
              </button>
              <button type="button" className="primary-button" onClick={generate} disabled={isWorking}>
                Generate
              </button>
              {result && (
                <a className="download-button" href={result.dataUrl} download={result.filename}>
                  Download
                </a>
              )}
            </div>

            <pre>{panelText}</pre>
          </section>
        </div>
      </section>
    </main>
  );
}
