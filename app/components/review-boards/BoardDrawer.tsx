"use client";

/**
 * A built board's full workflow, opened from its card.
 *
 * Same <dialog> idiom as AddRowDialog: `open` toggles showModal()/close()
 * rather than driving visibility with a mount/unmount, so the native Escape
 * handling and top-layer stacking come for free. It differs only in shape —
 * pinned to the left edge at 75% width instead of centered — because it holds
 * a whole board's settings/items/preview, not one form.
 */

import { useEffect, useRef } from "react";
import { BoardWorkflow, type BoardRender, type BuiltBoard } from "./BoardWorkflow";
import styles from "./review-boards.module.css";

type Props = {
  projectId: string;
  /** null closes the drawer. Only the open transition slides; close is instant,
   *  the same as AddRowDialog. */
  board: BuiltBoard | null;
  renders: BoardRender[];
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  onRemoveRow: (rowId: string) => Promise<void>;
};

export function BoardDrawer({ projectId, board, renders, onClose, onSaved, onRemoveRow }: Props) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (board && !dialog.open) dialog.showModal();
    if (!board && dialog.open) dialog.close();
  }, [board]);

  return (
    <dialog
      ref={ref}
      className={styles.drawer}
      onClose={onClose}
      aria-label={board ? `${board.title} workflow` : "Board workflow"}
    >
      {board ? (
        <>
          <div className={styles.drawerHead}>
            <div>
              <span className={styles.boardRoom}>
                {board.unitType} · {board.roomLabel}
              </span>
              <h2 className={styles.drawerTitle}>{board.kindLabel}</h2>
            </div>
            <button type="button" className={styles.secondary} onClick={onClose}>
              Close
            </button>
          </div>
          <div className={styles.drawerBody}>
            <BoardWorkflow
              projectId={projectId}
              board={board}
              renders={renders}
              onSaved={onSaved}
              onRemoveRow={onRemoveRow}
            />
          </div>
        </>
      ) : null}
    </dialog>
  );
}
