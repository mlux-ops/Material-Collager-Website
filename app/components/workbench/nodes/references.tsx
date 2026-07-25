"use client";

import { memo, useEffect, useRef } from "react";
import { COLLAGE_TYPES, ITEM_PRESETS, labelFor, type CollageType } from "@/app/lib/collage";
import { putBlob, releaseBlob } from "../blob-cache";
import { DEFAULT_MAX_IMAGES_PER_ITEM } from "../export-import";
import { useWorkbenchStore } from "../store";
import styles from "../workbench.module.css";
import type { ReferenceItem } from "../types";
import { NodeShell, ThumbnailImage, validateUploadFile, type WorkbenchNodeProps } from "./shared";

function createItemId() {
  return `item-${globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Date.now().toString(36)}`;
}

function buildReferencesRun(nodeId: string, items: ReferenceItem[]) {
  return {
    runId: `references-${Date.now().toString(36)}`,
    // A stable, ad-hoc content signature (photo.manifest.ts uses the same
    // pattern) — distinct from signatureFor's generic hash, but harmless: a
    // mismatch just re-runs the manifest's cheap validation execute.
    signature: `references:${JSON.stringify(items.map((item) => ({ id: item.id, imageKeys: item.imageKeys })))}`,
    at: Date.now(),
    values: [[{ kind: "references" as const, items, order: items.map((item) => item.id) }]],
  };
}

export const Component = memo(function ReferencesNode({ id, data }: WorkbenchNodeProps) {
  const applyRun = useWorkbenchStore((state) => state.applyRun);
  const updateParams = useWorkbenchStore((state) => state.updateParams);
  const setStatus = useWorkbenchStore((state) => state.setStatus);
  const items = data.params.referenceItems ?? [];
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const commit = (nextItems: ReferenceItem[]) => {
    updateParams(id, { referenceItems: nextItems });
    applyRun(id, buildReferencesRun(id, nextItems));
  };

  // Reload reconstruction: persistence.ts restores this node's blobs into the
  // blob cache generically (via persistBlobKeys) before this component mounts,
  // but does not rebuild non-Photo runs — so restore the output run here from
  // the now-populated cache, once, if params carry items but no run exists yet.
  useEffect(() => {
    if (data.runs.length > 0) return;
    if (!items.some((item) => item.imageKeys.length > 0)) return;
    applyRun(id, buildReferencesRun(id, items));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addItem = () => commit([...items, { id: createItemId(), role: "", imageKeys: [] }]);

  const addPreset = (type: CollageType) => {
    const existingIds = new Set(items.map((item) => item.id));
    const additions = ITEM_PRESETS[type].filter((preset) => !existingIds.has(preset.id));
    if (!additions.length) return;
    commit([...items, ...additions.map((preset) => ({ id: preset.id, role: preset.role, required: preset.required, imageKeys: [] }))]);
  };

  const updateItem = (itemId: string, patch: Partial<ReferenceItem>) =>
    commit(items.map((item) => (item.id === itemId ? { ...item, ...patch } : item)));

  const removeItem = (itemId: string) => {
    const target = items.find((item) => item.id === itemId);
    for (const key of target?.imageKeys ?? []) releaseBlob(key);
    commit(items.filter((item) => item.id !== itemId));
  };

  const moveItem = (itemId: string, direction: -1 | 1) => {
    const index = items.findIndex((item) => item.id === itemId);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= items.length) return;
    const next = [...items];
    [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
    commit(next);
  };

  // issue-9: enforce the advertised PNG/JPEG/WebP + 50MB limits (the
  // accept="" attribute on the <input> below is only a picker hint, never a
  // validation boundary) plus a per-item image-count cap matching the
  // import validator's own DEFAULT_MAX_IMAGES_PER_ITEM, so a graph built
  // live has the same limits as one that would survive export/import. The
  // whole batch is validated up front and rejected together with an
  // actionable error (surfaced via NodeShell's existing error display) if
  // ANY file fails ANY check, rather than silently dropping just the
  // offending files.
  const addImages = (itemId: string, fileList: FileList | null) => {
    const requested = Array.from(fileList ?? []);
    if (!requested.length) return;

    for (const file of requested) {
      const rejection = validateUploadFile(file);
      if (rejection) {
        setStatus(id, "error", rejection);
        return;
      }
    }

    const currentCount = items.find((item) => item.id === itemId)?.imageKeys.length ?? 0;
    if (currentCount + requested.length > DEFAULT_MAX_IMAGES_PER_ITEM) {
      setStatus(id, "error", `This item can hold at most ${DEFAULT_MAX_IMAGES_PER_ITEM} images.`);
      return;
    }

    const stamp = Date.now().toString(36);
    const newKeys = requested.map((file, index) => {
      const key = `${id}:ref:${itemId}:${stamp}-${index}`;
      putBlob(key, file);
      return key;
    });
    commit(items.map((item) => (item.id === itemId ? { ...item, imageKeys: [...item.imageKeys, ...newKeys] } : item)));
  };

  const removeImage = (itemId: string, key: string) => {
    releaseBlob(key);
    commit(items.map((item) => (item.id === itemId ? { ...item, imageKeys: item.imageKeys.filter((k) => k !== key) } : item)));
  };

  return (
    <NodeShell data={data}>
      <div className={styles.field}>
        <span>Load preset items</span>
        <select
          className="nodrag"
          value=""
          onChange={(event) => {
            if (event.target.value) addPreset(event.target.value as CollageType);
            event.target.value = "";
          }}
        >
          <option value="">Choose a collage preset…</option>
          {COLLAGE_TYPES.map((type) => <option key={type} value={type}>{labelFor(type)}</option>)}
        </select>
      </div>

      {items.length === 0 && <p className={styles.hint}>Add reference items and upload their images.</p>}

      {items.map((item, index) => (
        <div key={item.id} className={styles.referenceItem}>
          <div className={styles.referenceItemHeader}>
            <input
              className="nodrag"
              type="text"
              placeholder="Role (e.g. countertop stone)"
              value={item.role}
              onChange={(event) => updateItem(item.id, { role: event.target.value })}
              style={{ flex: 1, fontSize: 11 }}
            />
            <button type="button" className={styles.smallButton} onClick={() => moveItem(item.id, -1)} disabled={index === 0}>↑</button>
            <button type="button" className={styles.smallButton} onClick={() => moveItem(item.id, 1)} disabled={index === items.length - 1}>↓</button>
            <button type="button" className={styles.smallButton} onClick={() => removeItem(item.id)}>✕</button>
          </div>
          <input
            className="nodrag"
            type="text"
            placeholder="Brand"
            value={item.brand ?? ""}
            onChange={(event) => updateItem(item.id, { brand: event.target.value })}
            style={{ fontSize: 11 }}
          />
          <input
            className="nodrag"
            type="text"
            placeholder="Product / name"
            value={item.name ?? ""}
            onChange={(event) => updateItem(item.id, { name: event.target.value })}
            style={{ fontSize: 11 }}
          />
          <input
            className="nodrag"
            type="text"
            placeholder="Finish"
            value={item.finish ?? ""}
            onChange={(event) => updateItem(item.id, { finish: event.target.value })}
            style={{ fontSize: 11 }}
          />
          <input
            className="nodrag"
            type="text"
            placeholder="Notes"
            value={item.notes ?? ""}
            onChange={(event) => updateItem(item.id, { notes: event.target.value })}
            style={{ fontSize: 11 }}
          />
          <label style={{ fontSize: 10, display: "flex", alignItems: "center", gap: 5 }}>
            <input
              className="nodrag"
              type="checkbox"
              checked={item.required ?? false}
              onChange={(event) => updateItem(item.id, { required: event.target.checked })}
            />
            Required
          </label>

          <div className={styles.referenceThumbRow}>
            {item.imageKeys.map((key) => (
              <span key={key} className={styles.referenceThumb}>
                <ThumbnailImage cacheKey={key} alt="Reference" width={36} height={36} />
                <button type="button" className={styles.referenceThumbRemove} onClick={() => removeImage(item.id, key)}>✕</button>
              </span>
            ))}
          </div>
          <button type="button" className={styles.smallButton} onClick={() => inputRefs.current[item.id]?.click()}>
            Add images
          </button>
          <input
            ref={(element) => { inputRefs.current[item.id] = element; }}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            hidden
            onChange={(event) => { addImages(item.id, event.target.files); event.target.value = ""; }}
          />
        </div>
      ))}

      <button type="button" className={styles.smallButton} onClick={addItem}>+ Add item</button>
    </NodeShell>
  );
});
