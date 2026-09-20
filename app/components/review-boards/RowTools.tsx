"use client";

/**
 * The two edits a person can make to one row from wherever it appears: pin it
 * to a slot, or remove it from every board.
 *
 * The pin choices come from the same core that builds the boards — the board
 * types this row's room maps to, and each one's preset slots — so the dropdown
 * can only name a slot that exists. The lighting board has no slots to pin to
 * and is left out; a row in a room no board type maps to gets Remove only.
 */

import { BOARD_KIND_LABELS, boardTypesForRoom } from "@/app/lib/autoboard/match";
import { pinChoices } from "@/app/lib/autoboard/row-edits";
import styles from "./review-boards.module.css";

export type Pin = { collageType: string; slotId: string };

type Props = {
  rowId: string;
  roomLabel: string;
  pin: Pin | undefined;
  busy: boolean;
  onPin: (rowId: string, pin: Pin | null) => Promise<void>;
  onRemove: (rowId: string) => Promise<void>;
};

const encode = (pin: Pin) => `${pin.collageType}::${pin.slotId}`;

export function RowTools({ rowId, roomLabel, pin, busy, onPin, onRemove }: Props) {
  const choices = pinChoices(boardTypesForRoom(roomLabel)).map((choice) => ({
    value: encode(choice),
    label: `pin: ${BOARD_KIND_LABELS[choice.collageType]} · ${choice.slotId}`,
  }));
  const current = pin ? encode(pin) : "";
  // A pin made when the row was in another room still shows as what it is.
  if (current && !choices.some((choice) => choice.value === current)) {
    choices.push({ value: current, label: `pin: ${pin!.collageType} · ${pin!.slotId}` });
  }

  return (
    <span className={styles.rowTools}>
      {choices.length ? (
        <select
          className={styles.select}
          aria-label="Pin this row to a slot"
          value={current}
          disabled={busy}
          onChange={(event) => {
            const value = event.target.value;
            if (!value) {
              void onPin(rowId, null);
              return;
            }
            const [collageType, slotId] = value.split("::");
            void onPin(rowId, { collageType, slotId });
          }}
        >
          <option value="">pin: rules decide</option>
          {choices.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
      ) : null}
      <button type="button" className={styles.photoAction} disabled={busy} onClick={() => void onRemove(rowId)}>
        Remove
      </button>
    </span>
  );
}
