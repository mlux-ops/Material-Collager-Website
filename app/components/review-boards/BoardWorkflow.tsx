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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createBoardSaveQueue } from "@/app/lib/board-save-queue";
import { DitherReveal } from "../DitherReveal";
import { CompareStage } from "../CompareStage";
import { RenderClockNote, RenderClockRule, RenderClockTime, useRenderClock } from "../RenderClock";
import { CostFigure } from "../CostEstimate";
import { ReceiptStamp } from "../ReceiptStamp";
import { receiptAnnouncement } from "@/app/lib/render-receipt";
import type { RenderReceiptInput } from "@/app/lib/render-receipt";
import { DEFAULT_VARIANTS } from "@/app/lib/autoboard/variants";
import { formatElapsed, renderClockKey } from "@/app/lib/render-clock";
import { collageRenderCostBasis, estimateCollageRenderCost } from "@/app/lib/collage-cost";
import { describeCostEstimate, formatCostSplit } from "@/app/lib/image-cost";
import type { CollageType, Quality } from "@/app/lib/collage";
import styles from "./review-boards.module.css";
import { SampleBoard } from "./SampleBoard";

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
  items: { slotId: string; role: string; name: string; brand: string; sku?: string; images: string[]; rowId: string | null }[];
  state: BoardState;
  selectionHash: string;
  renderOptions: { quality: string; background: string };
  renderOptionsHash: string;
  prompt: string;
  referenceCount: number;
};

// The receipt on the preview stage (ReceiptStamp variant="stage") for a render
// that landed -- or failed -- in this session. boardId ties it to the board it
// was made on (this component is reused when the drawer switches boards);
// renderId is the landed render's id, null for a failure; key re-mounts the
// stamp so each new receipt replays its arrival.
type StageReceipt = {
  boardId: string;
  key: string;
  renderId: string | null;
  receipt: RenderReceiptInput;
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
  // Elapsed time of the draft render in flight (app/components/RenderClock.tsx).
  // renderClock.lastElapsedMs holds the duration of the render that last
  // finished successfully; renderDraft's finish() also returns it.
  const renderClock = useRenderClock();
  const { start: startRenderClock, finish: finishRenderClock, stop: stopRenderClock } = renderClock;
  // Null until a render lands or fails in this session; cleared when the next
  // render starts. A saved render merely on display gets no stage receipt.
  const [stageReceipt, setStageReceipt] = useState<StageReceipt | null>(null);
  // The receipt's sentence for screen readers, in the polite status element
  // below. Emptied when a render starts so a repeat sentence is announced again.
  const [receiptNotice, setReceiptNotice] = useState("");
  const failedReceiptCountRef = useRef(0);
  const onSavedRef = useRef(onSaved);
  useEffect(() => {
    onSavedRef.current = onSaved;
  }, [onSaved]);

  // Every edit reaches the server through one queue per board
  // (app/lib/board-save-queue.ts): notes coalesce per slot, writes go out one
  // at a time, and a render waits on flush() so it never starts before what
  // was typed is stored.
  const queue = useMemo(() => {
    const url = `/api/autoboard/projects/${encodeURIComponent(projectId)}/boards/${encodeURIComponent(board.id)}`;
    // onSavedRef is read only once send() actually runs (on a debounce timer,
    // or from saveNow/flush in an event handler) — never synchronously here
    // while the memo itself is being computed — so a stale closure over
    // onSaved is not possible; the lint rule cannot see that the read is
    // deferred, since it flags any ref reachable from a value built in useMemo.
    // eslint-disable-next-line react-hooks/refs
    return createBoardSaveQueue({
      debounceMs: SAVE_DEBOUNCE_MS,
      onError: (cause) => setError(cause.message),
      send: async (patch) => {
        setSaving(true);
        setError("");
        try {
          const response = await fetch(url, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(patch),
          });
          const payload = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
          if (!response.ok || !payload?.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`);
        } finally {
          setSaving(false);
        }
        // The patch is stored at this point. A failed reload is reported but is
        // not a failed save, so it must not put the patch back in the queue.
        await Promise.resolve(onSavedRef.current()).catch((cause: unknown) => setError((cause as Error).message));
      },
    });
  }, [projectId, board.id]);

  // Flush on unmount or board switch, so leaving mid-sentence does not
  // discard what was typed. This only covers an actual React unmount (for
  // example switching to a different open board): React runs no effect
  // cleanup on a tab close or reload, so a keystroke right before either of
  // those can still be lost. Going through the queue (rather than firing a
  // separate fetch here) keeps this in the same one-at-a-time order as every
  // other save, instead of racing whatever the queue itself has in flight.
  useEffect(() => {
    return () => {
      void queue.flush().catch(() => {});
    };
  }, [queue]);

  // A render made before the board changed is not "an older version" — it no
  // longer shows what the board says. renderRecordIsStale's two comparisons,
  // done here against the values recorded at render time.
  const isStale = (render: BoardRender) =>
    render.selectionHash !== board.selectionHash || render.renderOptionsHash !== board.renderOptionsHash;

  // The preview stage shows whichever render is newest (split against the one
  // before it once there are two), or (before any render exists) the board's
  // own hero reference so the stage is never simply blank.
  const latestRender = renders.length ? renders.reduce((a, b) => (a.createdAt >= b.createdAt ? a : b)) : null;
  const heroImage = board.items[0]?.images[0];
  // The render the latest one replaced, for the compare split: the newest of
  // the rest. Null with fewer than two renders.
  const previousRender = latestRender
    ? renders
        .filter((render) => render.id !== latestRender.id)
        .reduce<BoardRender | null>((a, b) => (a === null || b.createdAt > a.createdAt ? b : a), null)
    : null;
  // The stage receipt belongs to this board, and a landed one only while the
  // render it describes is the one on the stage (not after it was deleted).
  const ownStageReceipt = stageReceipt !== null && stageReceipt.boardId === board.id ? stageReceipt : null;
  const visibleStageReceipt =
    ownStageReceipt !== null && (ownStageReceipt.renderId === null || ownStageReceipt.renderId === latestRender?.id)
      ? ownStageReceipt
      : null;
  // The compare wipe plays only for a render that landed in this session; a
  // board opened on saved renders shows the comparison at rest.
  const latestLandedHere =
    latestRender !== null && ownStageReceipt !== null && ownStageReceipt.renderId === latestRender.id;

  // Live estimate for one Render A/B/C (app/lib/collage-cost.ts). Every board
  // render is a draft, and renderBoardDraft (app/lib/autoboard-renders.ts)
  // sends it through boardPayload with orientation "default" and
  // outputResolution "standard" -- mirrored here, since that server module
  // cannot be imported into the browser. renderOptions.quality is already the
  // effective tier (resolveRenderOptions), and every image of every item goes
  // up, which is what referenceCount counts. breakdown is null for
  // xhigh/max/auto, shown as "usage-based".
  const draftCost = useMemo(() => {
    const basis = collageRenderCostBasis(
      {
        collageType: board.collageType as CollageType,
        orientation: "default",
        quality: board.renderOptions.quality as Quality,
        outputResolution: "standard",
        renderKind: "draft",
        items: [],
      },
      board.referenceCount,
    );
    return { basis, breakdown: estimateCollageRenderCost(basis) };
  }, [board.collageType, board.renderOptions.quality, board.referenceCount]);
  const draftCostUsd = draftCost.breakdown?.totalUsd ?? null;

  const renderDraft = useCallback(async (variantKey: string) => {
    setRenderingVariant(variantKey);
    setError("");
    setStageReceipt(null);
    setReceiptNotice("");
    const boardId = board.id;
    const references = board.referenceCount;
    // renderOptions.quality is already the effective one (the board's own
    // choice folded over the draft stage default by resolveRenderOptions).
    startRenderClock(renderClockKey("review", "draft", board.renderOptions.quality));
    // The clock's own startedAt is state, stale inside this closure; a failed
    // receipt's elapsed time is measured from here instead.
    const startedAt = Date.now();
    // sent: the render request went out (the save succeeded). landed: the
    // render is stored. Only a sent-but-not-landed render gets a FAILED
    // receipt -- a failed save sent nothing, so it bills nothing.
    let sent = false;
    let landed = false;
    // An OK response whose body could not be read: the render may well be
    // stored and billed, so it is not stamped FAILED (and no cost is
    // guessed); the parent still reloads so a stored render appears.
    let unreadableOk = false;
    try {
      // The render route builds the prompt from what D1 holds, so an unsaved
      // note or instruction would be missing from a render the reviewer pays
      // for. A save that fails stops the render.
      try {
        await queue.flush();
      } catch (cause) {
        throw new Error(`Not rendered: your latest changes could not be saved (${(cause as Error).message}).`);
      }
      sent = true;
      const response = await fetch(
        `/api/autoboard/projects/${encodeURIComponent(projectId)}/boards/${encodeURIComponent(board.id)}/renders`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ variant: variantKey }) },
      );
      const payload = (await response.json().catch(() => null)) as
        | { ok?: boolean; error?: string; render?: BoardRender }
        | null;
      unreadableOk = response.ok && payload === null;
      if (!response.ok || !payload?.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`);
      landed = true;
      // The render is stored: record its duration now, before the reload
      // below, so the list refresh is not counted as render time.
      const elapsedMs = finishRenderClock();
      // The stored record as the route returned it. Without one there is
      // nothing true to stamp, so no receipt rather than a guessed one.
      const render = payload.render;
      if (render && typeof render.id === "string") {
        const receipt: RenderReceiptInput = {
          kind: render.kind,
          variant: render.variant,
          quality: render.quality,
          costUsd: render.costUsd,
          elapsedMs,
          references,
        };
        setStageReceipt({ boardId, key: render.id, renderId: render.id, receipt });
        setReceiptNotice(receiptAnnouncement(receipt));
      }
      await onSaved();
    } catch (cause) {
      setError((cause as Error).message);
      if (unreadableOk) {
        // Refresh so a render that was stored shows up; a failed reload
        // leaves the error above in place rather than replacing it.
        await Promise.resolve(onSaved()).catch(() => {});
      } else if (sent && !landed) {
        // The role="alert" error above announces the failure; the polite
        // receipt notice stays empty so it is not announced twice. The
        // visible FAILED strip still lands on the stage.
        const receipt: RenderReceiptInput = { failed: true, elapsedMs: Date.now() - startedAt, references };
        failedReceiptCountRef.current += 1;
        setStageReceipt({ boardId, key: `failed-${failedReceiptCountRef.current}`, renderId: null, receipt });
      }
    } finally {
      // A failed save, a failed render or a thrown fetch: stop without
      // recording (a no-op once finish() has run).
      stopRenderClock();
      setRenderingVariant(null);
    }
  }, [
    projectId,
    board.id,
    board.referenceCount,
    board.renderOptions.quality,
    onSaved,
    queue,
    startRenderClock,
    finishRenderClock,
    stopRenderClock,
  ]);

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

  // The clicked render button's label while it is busy: "Rendering 0:42",
  // ticking. Between finish() and the end of the reload that follows it, the
  // finished time holds still rather than dropping back to a bare label.
  const renderingLabel = () => {
    if (renderClock.startedAt !== null) {
      return (
        <>
          Rendering <RenderClockTime startedAt={renderClock.startedAt} />
        </>
      );
    }
    if (renderClock.lastElapsedMs !== null) return `Rendering ${formatElapsed(renderClock.lastElapsedMs)}`;
    return "Rendering…";
  };

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
              queue.saveSoon({ instruction: event.target.value });
            }}
          />
        </div>

        <div className={styles.field}>
          <span className={styles.label}>Options</span>
          <select
            className={styles.select}
            aria-label="Render quality"
            value={board.state.quality ?? ""}
            onChange={(event) => void queue.saveNow({ quality: event.target.value })}
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
            onChange={(event) => void queue.saveNow({ background: event.target.value })}
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
            onChange={(event) => void queue.saveNow({ heroItemId: event.target.value })}
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
                    queue.saveSoon({ notes: { [item.slotId]: event.target.value } });
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
            previousRender ? (
              // Two or more renders: the newest over the one it replaced. The
              // wipe plays only for a render that landed in this session.
              <CompareStage
                previous={{
                  src: previousRender.imageUrl,
                  alt: `${board.title} previous render, style ${previousRender.variant}`,
                }}
                current={{ src: latestRender.imageUrl, alt: `${board.title} render, style ${latestRender.variant}` }}
                arrivalKey={latestRender.id}
                playArrival={latestLandedHere}
              />
            ) : (
              <DitherReveal
                key={latestRender.id}
                className={styles.previewDither}
                style={{ height: "100%" }}
                src={latestRender.imageUrl}
                alt={`${board.title} render`}
                progress={1}
              />
            )
          ) : heroImage ? (
            // eslint-disable-next-line @next/next/no-img-element -- see SlotPhotos
            <img className={styles.previewImage} src={heroImage} alt="" />
          ) : (
            <span className={styles.previewEmpty}>No reference photo yet</span>
          )}
          {renderClock.startedAt !== null ? (
            <RenderClockRule startedAt={renderClock.startedAt} typicalMs={renderClock.typicalMs} />
          ) : null}
          {/* Bottom edge, above the image (z-index 2 in ReceiptStamp.module.css);
              the compare chips sit in the top corners. */}
          {visibleStageReceipt ? (
            <ReceiptStamp key={visibleStageReceipt.key} variant="stage" receipt={visibleStageReceipt.receipt} />
          ) : null}
        </div>

        <SampleBoard board={board} composed={latestRender && !isStale(latestRender) ? latestRender.imageUrl : undefined} />

        <div className={styles.workflowRow}>
          {/* One button per board style (A/B/C: DEFAULT_VARIANTS in
              autoboard/variants.ts) — same composition options the CLI's
              batch render offers, varying only composition/density per the
              standing rule that lighting and styling stay fixed. Each is its
              own paid render, so a render already in flight disables all
              three (no accidental concurrent spend) — the clicked one reads
              "Rendering…", the other two just go inert. */}
          {DEFAULT_VARIANTS.map((variant) => {
            const busy = renderingVariant === variant.key;
            // The figure follows the label in the flow (these buttons size to
            // their content). The busy button drops it, and its aria-label,
            // so "Rendering 0:42" is what it shows and what it is called.
            const showCost = !busy && board.referenceCount > 0;
            return (
              <button
                key={variant.key}
                type="button"
                className={styles.primary}
                disabled={Boolean(renderingVariant) || !board.referenceCount}
                onClick={() => void renderDraft(variant.key)}
                title={`${variant.composition}, ${variant.density} spacing`}
                aria-label={showCost ? `Render ${variant.key}, ${describeCostEstimate(draftCostUsd)}` : undefined}
              >
                {busy ? renderingLabel() : `Render ${variant.key}`}
                {showCost ? <CostFigure usd={draftCostUsd} placement="inline" /> : null}
              </button>
            );
          })}
          {/* Named plainly rather than buried: this is the one control on the
              page that costs money, and a draft's bill is dominated by its
              reference count, not its quality tier (CLAUDE.md). Outside a
              render it carries the estimate's input/output split; while one
              runs it goes back to the plain count beside the clock's note. */}
          <span className={styles.workflowMeta}>
            {renderClock.startedAt === null && draftCost.breakdown && board.referenceCount > 0 ? (
              formatCostSplit(board.referenceCount, draftCost.breakdown, { perStyle: true })
            ) : (
              <>
                spends on {board.referenceCount} reference{board.referenceCount === 1 ? "" : "s"} per style
              </>
            )}
            {renderClock.startedAt !== null && renderClock.typicalMs !== null ? (
              <>
                {" · "}
                <RenderClockNote startedAt={renderClock.startedAt} typicalMs={renderClock.typicalMs} />
              </>
            ) : null}
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
                    <ReceiptStamp
                      variant="inline"
                      className={styles.renderReceipt}
                      receipt={{
                        kind: render.kind,
                        variant: render.variant,
                        quality: render.quality,
                        costUsd: render.costUsd,
                      }}
                    />
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
        {/* Always mounted, so the receipt sentence is announced when it is
            set; holds no clock readout (those are role="timer"). */}
        <p className={styles.visuallyHidden} role="status" aria-live="polite">
          {receiptNotice}
        </p>
      </div>
    </div>
  );
}
