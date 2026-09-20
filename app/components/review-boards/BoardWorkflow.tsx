"use client";

/**
 * The reviewer's controls for one built board.
 *
 * Everything here feeds the prompt the model receives, and three of the four
 * feed selectionHash — so a render made before any of them changed is stale and
 * says so. The exception is the hero slot, which reorders the payload rather
 * than changing what is in it.
 *
 * The prompt is shown rather than described. It is built by the app's own
 * buildGenerationPrompt from the same payload a render would send, so what is
 * on screen is what would go out, not a summary of it.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { DitherReveal } from "../DitherReveal";
import { DEFAULT_VARIANTS } from "@/app/lib/autoboard/variants";
import styles from "./review-boards.module.css";

// extractBrand pulls the brand out of the item name but leaves the name intact,
// so rendering both prints "Kohler Kohler Purist Basin Faucet". The brand is
// shown in its own weight; the name drops the prefix it duplicates.
export function withoutBrandPrefix(name: string, brand: string): string {
  if (!brand || !name.toLowerCase().startsWith(brand.toLowerCase())) return name;
  return name.slice(brand.length).trim();
}

export type BoardState = {
  boardId: string;
  instruction: string;
  heroItemId: string | null;
  quality: string | null;
  background: string | null;
  notes: Record<string, string>;
};

export type BoardRender = {
  id: string;
  boardId: string;
  kind: string;
  variant: string;
  status: "candidate" | "picked" | "approved";
  selectionHash: string;
  renderOptionsHash: string;
  quality: string;
  background: string;
  costUsd: number | null;
  imageUrl: string;
  createdAt: number;
};

// A stable, readable name for a saved render: which board, which draft/final
// pass, which of that pass's variants. The id's own randomness stays out of
// it -- nothing here needs to be unique, only recognizable in a downloads folder.
function renderFilename(boardId: string, render: BoardRender): string {
  return `${boardId}-${render.kind}-${render.variant}.png`;
}

export type BuiltBoard = {
  id: string;
  title: string;
  collageType: string;
  kindLabel: string;
  unitType: string;
  roomLabel: string;
  // rowId is null for an item injected from the tile schedule rather than a row.
  items: { slotId: string; role: string; name: string; brand: string; images: string[]; rowId: string | null }[];
  state: BoardState;
  selectionHash: string;
  renderOptions: { quality: string; background: string };
  renderOptionsHash: string;
  prompt: string;
  referenceCount: number;
};

const QUALITIES = ["low", "medium", "high", "xhigh", "max", "auto"];
const BACKGROUNDS = ["opaque", "transparent"];

// A note is typed a character at a time; a save per keystroke would be a write
// per character. Long enough to coalesce a phrase, short enough that switching
// boards does not lose it — and every pending save is flushed on unmount.
const SAVE_DEBOUNCE_MS = 700;

type Props = {
  projectId: string;
  board: BuiltBoard;
  renders: BoardRender[];
  onSaved: () => void | Promise<void>;
  /** Removes the item's row from every board (see RowTools); absent when the caller offers no removal. */
  onRemoveRow?: (rowId: string) => Promise<void>;
};

export function BoardWorkflow({ projectId, board, renders, onSaved, onRemoveRow }: Props) {
  const [instruction, setInstruction] = useState(board.state.instruction);
  const [notes, setNotes] = useState<Record<string, string>>(board.state.notes);
  const [showPrompt, setShowPrompt] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [renderingVariant, setRenderingVariant] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<Record<string, unknown> | null>(null);

  const save = useCallback(
    async (patch: Record<string, unknown>) => {
      setSaving(true);
      setError("");
      try {
        const response = await fetch(
          `/api/autoboard/projects/${encodeURIComponent(projectId)}/boards/${encodeURIComponent(board.id)}`,
          { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) },
        );
        const payload = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!response.ok || !payload?.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`);
        await onSaved();
      } catch (cause) {
        setError((cause as Error).message);
      } finally {
        setSaving(false);
      }
    },
    [projectId, board.id, onSaved],
  );

  const saveSoon = useCallback(
    (patch: Record<string, unknown>) => {
      pending.current = { ...(pending.current ?? {}), ...patch };
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        const queued = pending.current;
        pending.current = null;
        timer.current = null;
        if (queued) void save(queued);
      }, SAVE_DEBOUNCE_MS);
    },
    [save],
  );

  // Flush on unmount, so switching tabs or projects mid-sentence does not
  // discard what was typed.
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
      const queued = pending.current;
      pending.current = null;
      if (queued) {
        void fetch(
          `/api/autoboard/projects/${encodeURIComponent(projectId)}/boards/${encodeURIComponent(board.id)}`,
          { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(queued) },
        );
      }
    };
  }, [projectId, board.id]);

  // A render made before the board changed is not "an older version" — it no
  // longer shows what the board says. renderRecordIsStale's two comparisons,
  // done here against the values recorded at render time.
  const isStale = (render: BoardRender) =>
    render.selectionHash !== board.selectionHash || render.renderOptionsHash !== board.renderOptionsHash;

  // The preview stage shows one image: whichever render is newest, or (before
  // any render exists) the board's own hero reference so the stage is never
  // simply blank.
  const latestRender = renders.length ? renders.reduce((a, b) => (a.createdAt >= b.createdAt ? a : b)) : null;
  const heroImage = board.items[0]?.images[0];

  const renderDraft = useCallback(async (variantKey: string) => {
    setRenderingVariant(variantKey);
    setError("");
    try {
      const response = await fetch(
        `/api/autoboard/projects/${encodeURIComponent(projectId)}/boards/${encodeURIComponent(board.id)}/renders`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ variant: variantKey }) },
      );
      const payload = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!response.ok || !payload?.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`);
      await onSaved();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setRenderingVariant(null);
    }
  }, [projectId, board.id, onSaved]);

  const setRenderStatus = useCallback(
    async (renderId: string, status: string) => {
      setError("");
      try {
        const response = await fetch(`/api/autoboard/renders/${encodeURIComponent(renderId)}`, {
          method: status === "delete" ? "DELETE" : "PATCH",
          headers: { "content-type": "application/json" },
          body: status === "delete" ? undefined : JSON.stringify({ status }),
        });
        const payload = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!response.ok || !payload?.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`);
        await onSaved();
      } catch (cause) {
        setError((cause as Error).message);
      }
    },
    [onSaved],
  );

  return (
    <div className={styles.workflowGrid}>
      {/* Settings: everything that feeds the prompt but is not itself an item. */}
      <div className={styles.workflowSettings}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor={`instruction-${board.id}`}>
            Board instruction
          </label>
          <textarea
            id={`instruction-${board.id}`}
            className={styles.textarea}
            rows={5}
            value={instruction}
            placeholder="Warmer metals throughout; keep the tile cool."
            onChange={(event) => {
              setInstruction(event.target.value);
              saveSoon({ instruction: event.target.value });
            }}
          />
        </div>

        <div className={styles.field}>
          <span className={styles.label}>Options</span>
          <select
            className={styles.select}
            aria-label="Render quality"
            value={board.state.quality ?? ""}
            onChange={(event) => void save({ quality: event.target.value })}
          >
            <option value="">quality: stage default ({board.renderOptions.quality})</option>
            {QUALITIES.map((quality) => (
              <option key={quality} value={quality}>
                quality: {quality}
              </option>
            ))}
          </select>
          <select
            className={styles.select}
            aria-label="Background"
            value={board.state.background ?? ""}
            onChange={(event) => void save({ background: event.target.value })}
          >
            <option value="">background: opaque</option>
            {BACKGROUNDS.map((background) => (
              <option key={background} value={background}>
                background: {background}
              </option>
            ))}
          </select>
          <select
            className={styles.select}
            aria-label="Hero slot"
            value={board.state.heroItemId ?? ""}
            onChange={(event) => void save({ heroItemId: event.target.value })}
          >
            <option value="">hero: by board type</option>
            {board.items.map((item) => (
              <option key={item.slotId} value={item.slotId}>
                hero: {item.slotId}
              </option>
            ))}
          </select>
        </div>

        <button type="button" className={styles.photoAction} onClick={() => setShowPrompt((open) => !open)}>
          {showPrompt ? "Hide prompt" : "Show prompt"}
        </button>
        {showPrompt ? <pre className={styles.prompt}>{board.prompt}</pre> : null}

        <span className={styles.workflowMeta}>
          {board.referenceCount} references · {board.renderOptions.quality}/{board.renderOptions.background} ·{" "}
          {board.selectionHash.slice(0, 8)}
          {saving ? " · saving…" : ""}
        </span>
      </div>

      {/* Items: one card per slot — its reference photo, name, and its note. */}
      <div className={styles.workflowItems}>
        <ul className={styles.itemGrid}>
          {board.items.map((item) => (
            <li key={item.slotId} className={styles.itemCard}>
              {/* eslint-disable-next-line @next/next/no-img-element -- see SlotPhotos */}
              <img className={styles.itemImage} src={item.images[0]} alt="" loading="lazy" />
              <div className={styles.itemBody}>
                <label className={styles.noteLabel} htmlFor={`note-${board.id}-${item.slotId}`}>
                  {item.brand ? <strong>{item.brand}</strong> : null}
                  {item.brand ? " " : ""}
                  {withoutBrandPrefix(item.name, item.brand)}
                  <span className={styles.builtSlot}> · {item.slotId}</span>
                </label>
                <input
                  id={`note-${board.id}-${item.slotId}`}
                  className={styles.noteInput}
                  value={notes[item.slotId] ?? ""}
                  placeholder={`Note for ${item.name || item.role}`}
                  onChange={(event) => {
                    const next = { ...notes, [item.slotId]: event.target.value };
                    setNotes(next);
                    saveSoon({ notes: { [item.slotId]: event.target.value } });
                  }}
                />
                {item.rowId && onRemoveRow ? (
                  <button
                    type="button"
                    className={styles.photoAction}
                    disabled={saving}
                    onClick={() => void onRemoveRow(item.rowId!)}
                  >
                    Remove
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </div>

      {/* Preview: the same dithered reveal the generator page uses, the render
          button, and the strip of candidates it produces. */}
      <div className={styles.workflowPreview}>
        <div className={styles.previewStage}>
          {renderingVariant ? (
            <DitherReveal
              className={styles.previewDither}
              style={{ height: "100%" }}
              src={latestRender?.imageUrl ?? heroImage ?? ""}
              alt="Rendering the board"
            />
          ) : latestRender ? (
            <DitherReveal
              key={latestRender.id}
              className={styles.previewDither}
              style={{ height: "100%" }}
              src={latestRender.imageUrl}
              alt={`${board.title} render`}
              progress={1}
            />
          ) : heroImage ? (
            // eslint-disable-next-line @next/next/no-img-element -- see SlotPhotos
            <img className={styles.previewImage} src={heroImage} alt="" />
          ) : (
            <span className={styles.previewEmpty}>No reference photo yet</span>
          )}
        </div>

        <div className={styles.workflowRow}>
          {/* One button per board style (A/B/C: DEFAULT_VARIANTS in
              autoboard/variants.ts) — same composition options the CLI's
              batch render offers, varying only composition/density per the
              standing rule that lighting and styling stay fixed. Each is its
              own paid render, so a render already in flight disables all
              three (no accidental concurrent spend) — the clicked one reads
              "Rendering…", the other two just go inert. */}
          {DEFAULT_VARIANTS.map((variant) => (
            <button
              key={variant.key}
              type="button"
              className={styles.primary}
              disabled={Boolean(renderingVariant) || !board.referenceCount}
              onClick={() => void renderDraft(variant.key)}
              title={`${variant.composition}, ${variant.density} spacing`}
            >
              {renderingVariant === variant.key ? "Rendering…" : `Render ${variant.key}`}
            </button>
          ))}
          {/* Named plainly rather than buried: this is the one control on the
              page that costs money, and a draft's bill is dominated by its
              reference count, not its quality tier (CLAUDE.md). */}
          <span className={styles.workflowMeta}>
            spends on {board.referenceCount} reference{board.referenceCount === 1 ? "" : "s"} per style
          </span>
        </div>

        {latestRender ? (
          <div className={styles.workflowRow}>
            <a className={styles.photoAction} href={latestRender.imageUrl} target="_blank" rel="noreferrer">
              Open full size
            </a>
            <a
              className={styles.photoAction}
              href={latestRender.imageUrl}
              download={renderFilename(board.id, latestRender)}
            >
              Download
            </a>
          </div>
        ) : null}

        {renders.length ? (
          <ul className={styles.renderStrip}>
            {renders.map((render) => (
              <li key={render.id} className={styles.renderCell}>
                <button
                  type="button"
                  className={styles.photoPick}
                  aria-pressed={render.status !== "candidate"}
                  aria-label={`${render.status === "candidate" ? "Pick" : "Release"} draft ${render.variant}`}
                  onClick={() => void setRenderStatus(render.id, render.status === "candidate" ? "picked" : "candidate")}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- see SlotPhotos */}
                  <img className={styles.renderImage} src={render.imageUrl} alt="" loading="lazy" />
                  <span className={styles.photoMeta}>
                    {render.kind} {render.variant} · {render.quality}
                    {isStale(render) ? <span className={styles.photoWarn}> stale</span> : null}
                    {render.status === "picked" ? " · picked" : ""}
                    {render.status === "approved" ? " · approved" : ""}
                  </span>
                </button>
                <div className={styles.photoActions}>
                  <a className={styles.photoAction} href={render.imageUrl} target="_blank" rel="noreferrer">
                    Open
                  </a>
                  <a className={styles.photoAction} href={render.imageUrl} download={renderFilename(board.id, render)}>
                    Save
                  </a>
                  <button type="button" className={styles.photoAction} onClick={() => void setRenderStatus(render.id, "approved")}>
                    Approve
                  </button>
                  <button type="button" className={styles.photoAction} onClick={() => void setRenderStatus(render.id, "delete")}>
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        {error ? (
          <p className={styles.photoError} role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
