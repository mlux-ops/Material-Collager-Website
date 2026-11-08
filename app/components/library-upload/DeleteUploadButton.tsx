"use client";

/**
 * Two-step, permanent delete for a Library item (an upload or a render),
 * shared by /library/upload and /archive. "Delete" turns into the confirm
 * label / "Cancel" for a few seconds (no window.confirm); confirming sends
 * DELETE /api/library/[id], which removes the row and its stored image for
 * good. The server refuses rows that are not Library items (drafts etc.).
 */

import { useEffect, useRef, useState } from "react";
import styles from "./delete-upload.module.css";

const CONFIRM_WINDOW_MS = 4000;

type Phase = "idle" | "confirm" | "deleting";

export function DeleteUploadButton({
  id,
  name,
  buttonClassName,
  className,
  confirmLabel = "Confirm delete",
  onDeleted,
}: {
  id: string;
  /** For the accessible labels: "Delete <name>". */
  name: string;
  /** The caller's button type style (size, colour). */
  buttonClassName?: string;
  className?: string;
  /** The armed button's text, e.g. "Delete permanently" for a render. */
  confirmLabel?: string;
  onDeleted: (id: string) => void;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const deleteRef = useRef<HTMLButtonElement | null>(null);
  const returnFocus = useRef(false);

  // The confirm offer lapses on its own, so a stray first click can't arm a
  // delete that a much later click then fires.
  useEffect(() => {
    if (phase !== "confirm") return;
    confirmRef.current?.focus();
    const lapse = window.setTimeout(() => {
      returnFocus.current = true;
      setPhase("idle");
    }, CONFIRM_WINDOW_MS);
    return () => window.clearTimeout(lapse);
  }, [phase]);

  useEffect(() => {
    if (phase === "idle" && returnFocus.current) {
      returnFocus.current = false;
      deleteRef.current?.focus();
    }
  }, [phase]);

  const confirm = async () => {
    setPhase("deleting");
    setError("");
    try {
      const response = await fetch(`/api/library/${encodeURIComponent(id)}`, { method: "DELETE" });
      let message = "";
      try {
        const body = (await response.json()) as { ok?: boolean; error?: string };
        if (response.ok && body?.ok) {
          onDeleted(id);
          return;
        }
        message = body?.error || "";
      } catch {
        message = "";
      }
      setError(message || `Delete failed (HTTP ${response.status})`);
    } catch {
      setError("Delete failed — check the connection");
    }
    returnFocus.current = true;
    setPhase("idle");
  };

  const button = [styles.button, buttonClassName].filter(Boolean).join(" ");

  return (
    <span
      className={[styles.root, className].filter(Boolean).join(" ")}
      data-active={phase !== "idle" || error ? "true" : undefined}
    >
      {phase === "idle" ? (
        <button
          ref={deleteRef}
          type="button"
          className={button}
          onClick={() => {
            setError("");
            setPhase("confirm");
          }}
          aria-label={`Delete ${name}`}
        >
          Delete
        </button>
      ) : null}
      {phase === "confirm" ? (
        <>
          <button
            ref={confirmRef}
            type="button"
            className={`${button} ${styles.confirm}`}
            onClick={() => void confirm()}
            aria-label={`${confirmLabel}: ${name}`}
          >
            {confirmLabel}
          </button>
          <button
            type="button"
            className={button}
            onClick={() => {
              returnFocus.current = true;
              setPhase("idle");
            }}
          >
            Cancel
          </button>
        </>
      ) : null}
      {phase === "deleting" ? (
        <button type="button" className={button} disabled>
          Deleting…
        </button>
      ) : null}
      {error ? (
        <span className={styles.error} role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}

export default DeleteUploadButton;
