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
import styles from "./review-boards.module.css";

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

export type BuiltBoard = {
  id: string;
  title: string;
  collageType: string;
  kindLabel: string;
  unitType: string;
  roomLabel: string;
  items: { slotId: string; role: string; name: string; brand: string; images: string[] }[];
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
};

export function BoardWorkflow({ projectId, board, renders, onSaved }: Props) {
  const [instruction, setInstruction] = useState(board.state.instruction);
  const [notes, setNotes] = useState<Record<string, string>>(board.state.notes);
  const [showPrompt, setShowPrompt] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [rendering, setRendering] = useState(false);
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

  const renderDraft = useCallback(async () => {
    setRendering(true);
    setError("");
    try {
      const response = await fetch(
        `/api/autoboard/projects/${encodeURIComponent(projectId)}/boards/${encodeURIComponent(board.id)}/renders`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ variant: "A" }) },
      );
      const payload = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!response.ok || !payload?.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`);
      await onSaved();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setRendering(false);
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
    <div className={styles.workflow}>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={`instruction-${board.id}`}>
          Board instruction
        </label>
        <textarea
          id={`instruction-${board.id}`}
          className={styles.textarea}
          rows={2}
          value={instruction}
          placeholder="Warmer metals throughout; keep the tile cool."
          onChange={(event) => {
            setInstruction(event.target.value);
            saveSoon({ instruction: event.target.value });
          }}
        />
      </div>

      <div className={styles.workflowRow}>
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

      <ul className={styles.noteList}>
        {board.items.map((item) => (
          <li key={item.slotId} className={styles.noteRow}>
            <label className={styles.noteLabel} htmlFor={`note-${board.id}-${item.slotId}`}>
              {item.slotId}
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
          </li>
        ))}
      </ul>

      <div className={styles.workflowFoot}>
        <button type="button" className={styles.photoAction} onClick={() => setShowPrompt((open) => !open)}>
          {showPrompt ? "Hide prompt" : "Show prompt"}
        </button>
        <span className={styles.workflowMeta}>
          {board.referenceCount} references · {board.renderOptions.quality}/{board.renderOptions.background} ·{" "}
          {board.selectionHash.slice(0, 8)}
          {saving ? " · saving…" : ""}
        </span>
      </div>

      {showPrompt ? <pre className={styles.prompt}>{board.prompt}</pre> : null}

      <div className={styles.workflowRow}>
        <button
          type="button"
          className={styles.primary}
          disabled={rendering || !board.referenceCount}
          onClick={renderDraft}
        >
          {rendering ? "Rendering…" : "Render draft"}
        </button>
        {/* Named plainly rather than buried: this is the one control on the
            page that costs money, and a draft's bill is dominated by its
            reference count, not its quality tier (CLAUDE.md). */}
        <span className={styles.workflowMeta}>
          spends on {board.referenceCount} reference{board.referenceCount === 1 ? "" : "s"}
        </span>
      </div>

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
  );
}
