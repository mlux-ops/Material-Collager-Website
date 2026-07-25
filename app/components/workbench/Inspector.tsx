"use client";

// Selected-node inspector panel (S29/AC24): a docked side panel that shows
// whichever node is currently selected on the canvas. Hosts the params every
// node kind exposes plus, for a References node, its item model (role/brand/
// name/finish/notes/required) -- the same fields the card edits, so either
// surface stays in sync via the same store actions.

import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useWorkbenchStore } from "./store";
import { ThumbnailImage } from "./nodes/shared";
import styles from "./workbench.module.css";
import { specFor, type ReferenceItem, type WorkbenchNode } from "./types";

function ReferenceItemsInspector({ id, items }: { id: string; items: ReferenceItem[] }) {
  const updateParams = useWorkbenchStore((state) => state.updateParams);

  const updateItem = (itemId: string, patch: Partial<ReferenceItem>) => {
    updateParams(id, { referenceItems: items.map((item) => (item.id === itemId ? { ...item, ...patch } : item)) });
  };

  if (!items.length) return <p className={styles.hint}>No reference items yet — add some on the card.</p>;

  return (
    <div className={styles.inspectorItemList}>
      {items.map((item) => (
        <div key={item.id} className={styles.inspectorItem}>
          <div className={styles.referenceThumbRow}>
            {item.imageKeys.map((key) => (
              <ThumbnailImage key={key} cacheKey={key} alt="" width={40} height={40} className={styles.inspectorThumb} />
            ))}
          </div>
          <label className={styles.field}>
            <span>Role</span>
            <input className="nodrag" type="text" value={item.role} onChange={(event) => updateItem(item.id, { role: event.target.value })} />
          </label>
          <label className={styles.field}>
            <span>Brand</span>
            <input className="nodrag" type="text" value={item.brand ?? ""} onChange={(event) => updateItem(item.id, { brand: event.target.value })} />
          </label>
          <label className={styles.field}>
            <span>Name</span>
            <input className="nodrag" type="text" value={item.name ?? ""} onChange={(event) => updateItem(item.id, { name: event.target.value })} />
          </label>
          <label className={styles.field}>
            <span>Finish</span>
            <input className="nodrag" type="text" value={item.finish ?? ""} onChange={(event) => updateItem(item.id, { finish: event.target.value })} />
          </label>
          <label className={styles.field}>
            <span>Notes</span>
            <input className="nodrag" type="text" value={item.notes ?? ""} onChange={(event) => updateItem(item.id, { notes: event.target.value })} />
          </label>
          <label style={{ fontSize: 10, display: "flex", alignItems: "center", gap: 5 }}>
            <input className="nodrag" type="checkbox" checked={item.required ?? false} onChange={(event) => updateItem(item.id, { required: event.target.checked })} />
            Required
          </label>
        </div>
      ))}
    </div>
  );
}

// Every other param key rendered as a small read/write text field — no
// per-kind knowledge needed beyond "is this value a string/number/boolean".
function GenericParamsInspector({ id, node }: { id: string; node: WorkbenchNode }) {
  const updateParams = useWorkbenchStore((state) => state.updateParams);
  const entries = Object.entries(node.data.params).filter(
    (entry): entry is [string, string | number] => typeof entry[1] === "string" || typeof entry[1] === "number",
  );
  if (!entries.length) return <p className={styles.hint}>This node has no editable params.</p>;
  return (
    <div className={styles.inspectorParamGrid}>
      {entries.map(([key, value]) => (
        <label key={key} className={styles.field}>
          <span>{key}</span>
          <input
            className="nodrag"
            type={typeof value === "number" ? "number" : "text"}
            value={value}
            onChange={(event) =>
              updateParams(id, { [key]: typeof value === "number" ? Number(event.target.value) : event.target.value })
            }
          />
        </label>
      ))}
    </div>
  );
}

export function Inspector() {
  const selected = useWorkbenchStore(useShallow((state) => state.nodes.find((node) => node.selected)));
  const spec = useMemo(() => (selected ? specFor(selected.data.kind) : undefined), [selected]);

  // Deselecting is purely a canvas-selection concern (React Flow's own
  // `selected` flag), not a persisted graph mutation -- so this closes the
  // panel by clearing selection directly rather than routing through a
  // dedicated store action.
  const close = () => {
    useWorkbenchStore.setState((state) => ({
      nodes: state.nodes.map((node) => (node.selected ? { ...node, selected: false } : node)),
    }));
  };

  if (!selected || !spec) return null;

  return (
    <aside className={styles.inspector} aria-label="Node inspector">
      <header className={styles.inspectorHeader}>
        <div>
          <p className={styles.inspectorTitle}>{spec.title}</p>
          <p className={styles.inspectorSubtitle}>{spec.description}</p>
        </div>
        <button type="button" className={styles.smallButton} onClick={close}>Close</button>
      </header>
      <div className={styles.inspectorBody}>
        <p className={styles.inspectorSectionLabel}>Status</p>
        <p className={styles.hint}>{selected.data.status}{selected.data.error ? ` — ${selected.data.error}` : ""}</p>
        {selected.data.kind === "references" ? (
          <>
            <p className={styles.inspectorSectionLabel}>Reference items</p>
            <ReferenceItemsInspector id={selected.id} items={selected.data.params.referenceItems ?? []} />
          </>
        ) : (
          <>
            <p className={styles.inspectorSectionLabel}>Params</p>
            <GenericParamsInspector id={selected.id} node={selected} />
          </>
        )}
      </div>
    </aside>
  );
}
