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

const MAX_TOTAL_UPLOAD_BYTES = 22 * 1024 * 1024;
const MAX_SINGLE_UPLOAD_BYTES = 8 * 1024 * 1024;
const DRAFT_DB_NAME = "material-collager-drafts";
const DRAFT_STORE_NAME = "drafts";
const CURRENT_DRAFT_KEY = "current";

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
      items: items.map(({ previews, ...item }) => item),
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
      throw new Error("The reference images are too large to send together. Use fewer images, or resize/compress them and try again.");
    }

    throw new Error(text || `Request failed with status ${response.status}.`);
  }

  function validateUploadSize() {
    const allFiles = items.flatMap((item) => item.files);
    const largeFile = allFiles.find((file) => file.size > MAX_SINGLE_UPLOAD_BYTES);
    if (largeFile) {
      throw new Error(`${largeFile.name} is too large. Please resize it below 8 MB and try again.`);
    }

    const totalBytes = allFiles.reduce((total, file) => total + file.size, 0);
    if (totalBytes > MAX_TOTAL_UPLOAD_BYTES) {
      throw new Error("The reference images are too large to send together. Use fewer images, or resize/compress them and try again.");
    }
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
    setPanelText("Generating...");
    try {
      const payload = makePayload(true);
      validateUploadSize();
      const form = new FormData();
      form.append("payload", JSON.stringify(payload));
      items.forEach((item, itemIndex) => {
        item.files.forEach((file, fileIndex) => {
          form.append(`file:${itemIndex}:${fileIndex}`, file, file.name);
        });
      });

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
      setPanelText(`${response.summary || "Generated."}${qaText}`);
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
                <article className="item-row" key={`${item.id}-${index}`}>
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
