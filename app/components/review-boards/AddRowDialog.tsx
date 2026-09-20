"use client";

/**
 * Adding an item to a project.
 *
 * The form is not designed here: it is the project's row form from the server
 * (GET .../rows) — one field per Smartsheet column for a project with a sheet
 * behind it, the sheet's own picklists as dropdowns and its existing values as
 * suggestions; or the handful of fields a row needs for a project without one.
 * Submitting writes the row where the project keeps its rows: into the sheet,
 * filed under its unit type and room, or beside the project as a manual row.
 *
 * The dialog stays open after an add so several items can go in one after
 * another; the placement fields keep their values, the item fields clear.
 */

import { useEffect, useRef, useState, type FormEvent } from "react";
import styles from "./review-boards.module.css";

type RowField = {
  key: string;
  label: string;
  kind: "text" | "select" | "checkbox";
  required: boolean;
  options: string[];
  suggestions: string[];
  field: string | null;
  hint?: string;
};

type RowForm = { mode: "sheet" | "manual"; fields: RowField[]; target: string };

export type AddedRow = { rowId: string; inProject: boolean; where: string };

type Props<TProject> = {
  projectId: string;
  open: boolean;
  /** The project's filter, so a single unit type or room is filled in. */
  onlyUnitType: string;
  onlyRoom: string;
  onClose: () => void;
  onAdded: (payload: { project: TProject; added: AddedRow }) => Promise<void>;
};

const JSON_HEADERS = { "content-type": "application/json" };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const payload = (await response.json().catch(() => null)) as
    | ({ ok: boolean; error?: string } & Record<string, unknown>)
    | null;
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error ?? `Request failed with HTTP ${response.status}.`);
  }
  return payload as T;
}

// Fields that place the row, kept between adds so a run of items for one room
// needs them typed once.
const PLACEMENT_FIELDS = new Set(["unitType", "roomType", "costCode"]);

type Values = Record<string, string | boolean>;

export function AddRowDialog<TProject>({ projectId, open, onlyUnitType, onlyRoom, onClose, onAdded }: Props<TProject>) {
  const ref = useRef<HTMLDialogElement>(null);
  const [form, setForm] = useState<RowForm | null>(null);
  const [values, setValues] = useState<Values>({});
  const [busy, setBusy] = useState<"" | "saving">("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // The form is fetched each time the dialog opens: for a sheet-backed project
  // it reflects the sheet's columns and values as they are now. A request that
  // is no longer the latest (the dialog reopened, the project changed) is
  // dropped rather than allowed to overwrite the newer one.
  const requestId = useRef(0);
  useEffect(() => {
    if (!open) return;
    const id = ++requestId.current;
    api<{ form: RowForm }>(`/api/autoboard/projects/${encodeURIComponent(projectId)}/rows`)
      .then((payload) => {
        if (requestId.current !== id) return;
        const initial: Values = {};
        for (const field of payload.form.fields) {
          if (field.field === "unitType" && onlyUnitType) initial[field.key] = onlyUnitType;
          if (field.field === "roomType" && onlyRoom) initial[field.key] = onlyRoom;
        }
        setForm(payload.form);
        setValues(initial);
        setError("");
        setMessage("");
      })
      .catch((cause: unknown) => {
        if (requestId.current !== id) return;
        setForm(null);
        setError((cause as Error).message);
      });
  }, [open, projectId, onlyUnitType, onlyRoom]);

  const loading = open && form === null && !error;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form) return;
    setBusy("saving");
    setError("");
    setMessage("");
    try {
      const payload = await api<{ project: TProject; added: AddedRow }>(
        `/api/autoboard/projects/${encodeURIComponent(projectId)}/rows`,
        { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ values }) },
      );
      setMessage(payload.added.where);
      setValues((current) => {
        const next = { ...current };
        for (const field of form.fields) {
          if (!PLACEMENT_FIELDS.has(field.field ?? "")) delete next[field.key];
        }
        return next;
      });
      await onAdded(payload);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy("");
    }
  };

  const intro = form
    ? form.mode === "sheet"
      ? `Writes a new row into ${form.target}, filed under its unit type and room, then re-reads the sheet. Fields marked * are what a row needs to reach a board.`
      : `Stored with ${form.target}; there is no sheet behind it. Fields marked * are what a row needs to reach a board.`
    : loading
      ? "Loading the form…"
      : "";

  return (
    <dialog ref={ref} className={styles.dialog} onClose={onClose} aria-labelledby="add-row-title">
      <form className={styles.dialogForm} onSubmit={(event) => void submit(event)}>
        <div className={styles.dialogHead}>
          <h2 id="add-row-title" className={styles.dialogTitle}>
            Add item
          </h2>
          {intro ? <p className={styles.help}>{intro}</p> : null}
        </div>

        {form ? (
          <div className={styles.dialogFields}>
            {form.fields.map((field) => (
              <Field
                key={field.key}
                field={field}
                value={values[field.key]}
                onChange={(value) => setValues((current) => ({ ...current, [field.key]: value }))}
              />
            ))}
          </div>
        ) : null}

        {error ? (
          <p className={styles.notice} role="alert">
            {error}
          </p>
        ) : null}
        {message ? (
          <p className={styles.dialogMessage} role="status">
            {message}
          </p>
        ) : null}

        <div className={styles.actions}>
          <button type="submit" className={styles.primary} disabled={!form || busy !== ""}>
            {busy === "saving" ? "Adding…" : "Add"}
          </button>
          <button type="button" className={styles.secondary} onClick={onClose} disabled={busy === "saving"}>
            Done
          </button>
        </div>
      </form>
    </dialog>
  );
}

function Field({
  field,
  value,
  onChange,
}: {
  field: RowField;
  value: string | boolean | undefined;
  onChange: (value: string | boolean) => void;
}) {
  const id = `add-row-${field.key}`;
  const wide = field.field === "itemName" || field.field === "reference";

  if (field.kind === "checkbox") {
    return (
      <label className={styles.checkboxRow}>
        <input type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} />
        <span className={styles.label}>{field.label}</span>
      </label>
    );
  }

  const text = typeof value === "string" ? value : "";
  const label = `${field.label}${field.required ? " *" : ""}`;

  if (field.kind === "select") {
    const options = field.options.filter((option) => option !== "");
    return (
      <div className={`${styles.field} ${wide ? styles.fieldWide : ""}`}>
        <label className={styles.label} htmlFor={id}>
          {label}
        </label>
        <select
          id={id}
          className={`${styles.select} ${styles.dialogSelect}`}
          value={text}
          required={field.required}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">{field.required ? "Choose…" : "—"}</option>
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </div>
    );
  }

  return (
    <div className={`${styles.field} ${wide ? styles.fieldWide : ""}`}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className={styles.input}
        value={text}
        required={field.required}
        list={field.suggestions.length ? `${id}-list` : undefined}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
      />
      {field.suggestions.length ? (
        <datalist id={`${id}-list`}>
          {field.suggestions.map((suggestion) => (
            <option key={suggestion} value={suggestion} />
          ))}
        </datalist>
      ) : null}
      {field.hint ? <p className={styles.help}>{field.hint}</p> : null}
    </div>
  );
}
