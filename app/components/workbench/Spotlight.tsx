"use client";

// Spotlight/search add-menu (S29/AC24), replacing the old static full-list
// palette: filters the registry's node kinds by title/description as the
// user types. Rendered two ways by WorkbenchApp.tsx — embedded (no onClose)
// as the always-visible add-node panel, and as a dismissible modal when a
// wire dropped on empty canvas needs a compatible-kind picker (`kinds` then
// carries only the registry-derived compatible subset).

import { useEffect, useMemo, useRef, useState } from "react";
import { NODE_SPECS } from "./nodes/index";
import styles from "./workbench.module.css";
import type { NodeKind } from "./types";

export type SpotlightProps = {
  kinds: readonly NodeKind[];
  onPick: (kind: NodeKind) => void;
  onClose?: () => void; // present => renders as a dismissible modal overlay
  title?: string;
  emptyHint?: string;
};

export function Spotlight({ kinds, onPick, onClose, title, emptyHint }: SpotlightProps) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return kinds;
    return kinds.filter((kind) => {
      const spec = NODE_SPECS[kind];
      return spec.title.toLowerCase().includes(needle) || spec.description.toLowerCase().includes(needle);
    });
  }, [kinds, query]);

  useEffect(() => {
    if (onClose) inputRef.current?.focus();
    // Only on mount of the modal variant — an embedded panel shouldn't steal focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const body = (
    <div className={styles.spotlight}>
      <input
        ref={inputRef}
        className={`nodrag ${styles.spotlightInput}`}
        type="text"
        placeholder="Search node types…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && results[0]) onPick(results[0]);
          if (event.key === "Escape") onClose?.();
        }}
      />
      <div className={styles.spotlightList} role="listbox" aria-label="Node types">
        {results.map((kind) => (
          <button
            key={kind}
            type="button"
            className={styles.spotlightItem}
            onClick={() => onPick(kind)}
            title={NODE_SPECS[kind].description}
          >
            <span className={styles.spotlightItemTitle}>{NODE_SPECS[kind].title}</span>
            <span className={styles.spotlightItemDesc}>{NODE_SPECS[kind].description}</span>
          </button>
        ))}
        {!results.length && <p className={styles.hint}>{emptyHint ?? "No matching node types."}</p>}
      </div>
    </div>
  );

  if (!onClose) return body;

  return (
    <div className={styles.templateOverlay} role="dialog" aria-modal="true" aria-label={title ?? "Add a node"} onClick={onClose}>
      <div className={styles.spotlightModal} onClick={(event) => event.stopPropagation()}>
        <header className={styles.templateHeader}>
          <h2>{title ?? "Add a node"}</h2>
          <button type="button" className={styles.smallButton} onClick={onClose}>Close</button>
        </header>
        {body}
      </div>
    </div>
  );
}
