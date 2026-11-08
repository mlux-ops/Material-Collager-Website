"use client";

/**
 * LibraryUpload — /library/upload
 * -------------------------------
 * Mass upload into the Library's storage. Files arrive by drop (anywhere on
 * the page, folders included), by the two pickers, or by pasting; each one is
 * checked here first (its header bytes decide the type, never its name or the
 * browser's MIME guess, which is often blank for folder drops and HEIC), then
 * queued, then sent one image per request to /api/library/upload, three at a
 * time, over XMLHttpRequest — fetch reports no upload progress.
 *
 * Uploads are kept permanently on the server (retention "permanent"), unlike
 * renders. Nothing here touches the 3D landing: it caps its own scene.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { RouteReady } from "../RouteReady";
import { SiteNavigation } from "../SiteNavigation";
import { TransitionLink } from "../TransitionLink";
import { DeleteUploadButton } from "./DeleteUploadButton";
import { HEADER_PEEK_BYTES, sniffImageType } from "@/app/lib/autoboard/image-size";
import { LIBRARY_UPLOAD_ACCEPT, LIBRARY_UPLOAD_MAX_BYTES } from "@/app/lib/image-upload";
import styles from "./library-upload.module.css";

const CONCURRENCY = 3;
const MAX_MB = LIBRARY_UPLOAD_MAX_BYTES / (1024 * 1024);

// Folder clutter that is never an image and never worth a "rejected" row.
const JUNK_NAMES = new Set(["thumbs.db", ".ds_store", "desktop.ini"]);

type Status = "checking" | "queued" | "uploading" | "done" | "failed" | "rejected";

type UploadedItem = { id: string; title: string; imageUrl: string; aspectRatio?: number };

type Row = {
  id: string;
  key: string;
  file: File;
  /** Folder-relative path when the file came from a folder, else "". */
  path: string;
  status: Status;
  progress: number;
  reason?: string;
  previewUrl?: string;
  item?: UploadedItem;
};

type Candidate = { file: File; path: string };

let rowSerial = 0;

function fileKey(file: File) {
  return `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function extensionOf(name: string) {
  const match = /\.([a-z0-9]+)$/i.exec(name);
  return match ? match[1].toUpperCase() : "";
}

function isJunk(name: string) {
  const lower = name.toLowerCase();
  return JUNK_NAMES.has(lower) || lower.startsWith("._");
}

// The same header check the server runs, so a HEIC, GIF or SVG is turned
// away with its reason before a byte is sent.
async function checkFile(file: File): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (file.size === 0) return { ok: false, reason: "Empty file" };
  if (file.size > LIBRARY_UPLOAD_MAX_BYTES) {
    return { ok: false, reason: `Larger than ${MAX_MB} MB (${formatBytes(file.size)})` };
  }
  let head: Uint8Array;
  try {
    head = new Uint8Array(await file.slice(0, HEADER_PEEK_BYTES).arrayBuffer());
  } catch {
    return { ok: false, reason: "Could not be read" };
  }
  if (sniffImageType(head)) return { ok: true };
  const extension = extensionOf(file.name);
  return {
    ok: false,
    reason: extension
      ? `${extension} is not supported — PNG, JPEG or WebP only`
      : "Not a PNG, JPEG or WebP image",
  };
}

function readEntryFile(entry: FileSystemFileEntry) {
  return new Promise<File>((resolve, reject) => entry.file(resolve, reject));
}

function readDirectoryBatch(reader: FileSystemDirectoryReader) {
  return new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
}

// readEntries hands a directory over in batches (Chromium: 100 at a time),
// so it is called until it comes back empty.
async function collectEntry(entry: FileSystemEntry, out: Candidate[]): Promise<void> {
  if (entry.isFile) {
    try {
      const file = await readEntryFile(entry as FileSystemFileEntry);
      out.push({ file, path: entry.fullPath.replace(/^\//, "") });
    } catch {
      // An unreadable entry (permissions, a vanished file) is skipped.
    }
    return;
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      let batch: FileSystemEntry[];
      try {
        batch = await readDirectoryBatch(reader);
      } catch {
        return;
      }
      if (batch.length === 0) return;
      for (const child of batch) await collectEntry(child, out);
    }
  }
}

function stamp() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

type UploadResponse = { ok?: boolean; error?: string; item?: UploadedItem };

function parseUploadResponse(text: string): UploadResponse | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as UploadResponse) : null;
  } catch {
    return null;
  }
}

function statusLabel(row: Row) {
  switch (row.status) {
    case "checking": return "Checking";
    case "queued": return "Queued";
    case "uploading": return `Uploading ${Math.round(row.progress * 100)}%`;
    case "done": return "Done";
    case "failed": return "Failed";
    case "rejected": return "Rejected";
  }
}

export function LibraryUpload() {
  const [rows, setRows] = useState<Row[]>([]);
  const [running, setRunning] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [note, setNote] = useState("");

  // Mirrors for the unmount cleanup, which must see the CURRENT rows and
  // requests rather than the ones captured when the effect was created.
  const rowsRef = useRef<Row[]>([]);
  const requests = useRef(new Map<string, XMLHttpRequest>());
  const fileInput = useRef<HTMLInputElement | null>(null);
  const folderInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  const patchRow = useCallback((id: string, patch: Partial<Row>) => {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }, []);

  // React's typings have no webkitdirectory, so the folder picker gets its
  // attribute here.
  useEffect(() => {
    folderInput.current?.setAttribute("webkitdirectory", "");
    folderInput.current?.setAttribute("directory", "");
  }, []);

  useEffect(() => {
    const live = requests.current;
    return () => {
      for (const request of live.values()) request.abort();
      live.clear();
      for (const row of rowsRef.current) if (row.previewUrl) URL.revokeObjectURL(row.previewUrl);
    };
  }, []);

  const addCandidates = useCallback((candidates: Candidate[]) => {
    const known = new Set(rowsRef.current.map((row) => row.key));
    const added: Row[] = [];
    let duplicates = 0;
    for (const { file, path } of candidates) {
      if (isJunk(file.name)) continue;
      const key = fileKey(file);
      if (known.has(key)) {
        duplicates += 1;
        continue;
      }
      known.add(key);
      rowSerial += 1;
      added.push({ id: `upload-${rowSerial}`, key, file, path, status: "checking", progress: 0 });
    }
    setNote(duplicates > 0 ? `${duplicates} duplicate${duplicates === 1 ? "" : "s"} already in the queue skipped.` : "");
    if (added.length === 0) return;
    rowsRef.current = [...rowsRef.current, ...added];
    setRows((current) => [...current, ...added]);
    for (const row of added) {
      void checkFile(row.file).then((result) => {
        // A row removed while it was being checked stays removed.
        if (!rowsRef.current.some((entry) => entry.id === row.id)) return;
        if (result.ok) {
          patchRow(row.id, { status: "queued", previewUrl: URL.createObjectURL(row.file) });
        } else {
          patchRow(row.id, { status: "rejected", reason: result.reason });
        }
      });
    }
  }, [patchRow]);

  const startUpload = useCallback((row: Row) => {
    const request = new XMLHttpRequest();
    requests.current.set(row.id, request);
    const form = new FormData();
    form.append("image", row.file, row.file.name);
    const finish = (patch: Partial<Row>) => {
      requests.current.delete(row.id);
      patchRow(row.id, patch);
    };
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) patchRow(row.id, { progress: event.loaded / event.total });
    };
    request.onload = () => {
      const body = parseUploadResponse(request.responseText);
      if (request.status >= 200 && request.status < 300 && body?.ok && body.item) {
        finish({ status: "done", progress: 1, item: body.item, reason: undefined });
      } else if (request.status === 413) {
        finish({ status: "failed", progress: 0, reason: "Too large for the server" });
      } else {
        finish({ status: "failed", progress: 0, reason: body?.error || `Server answered HTTP ${request.status}` });
      }
    };
    request.onerror = () => finish({ status: "failed", progress: 0, reason: "Network error — check the connection" });
    request.ontimeout = () => finish({ status: "failed", progress: 0, reason: "Timed out" });
    request.onabort = () => {
      requests.current.delete(row.id);
    };
    request.open("POST", "/api/library/upload");
    request.send(form);
    patchRow(row.id, { status: "uploading", progress: 0, reason: undefined });
  }, [patchRow]);

  // The pump: while a run is on, keep CONCURRENCY requests in flight. The
  // request map, not row status, is the in-flight count, so a re-render that
  // lands before a row reads "uploading" cannot start it twice.
  useEffect(() => {
    if (!running) return;
    const queued = rows.filter((row) => row.status === "queued" && !requests.current.has(row.id));
    const slots = CONCURRENCY - requests.current.size;
    for (const row of queued.slice(0, Math.max(0, slots))) startUpload(row);
    const stillChecking = rows.some((row) => row.status === "checking");
    if (queued.length === 0 && requests.current.size === 0 && !stillChecking) setRunning(false);
  }, [rows, running, startUpload]);

  const inFlight = rows.some((row) => row.status === "uploading");
  useEffect(() => {
    if (!inFlight) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [inFlight]);

  // --- Drop anywhere on the page --------------------------------------------
  useEffect(() => {
    let depth = 0;
    const carriesFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const onEnter = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth += 1;
      setDragging(true);
    };
    const onOver = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      // Without this the browser treats the drop as "open this file" and
      // navigates away from the page and the queue.
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const onLeave = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDrop = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setDragging(false);
      const transfer = event.dataTransfer;
      if (!transfer) return;
      // Entries must be taken NOW, synchronously: the DataTransferItemList
      // is emptied as soon as this handler returns. dataTransfer.files would
      // flatten a dropped folder away, so it is only the fallback.
      const entries: FileSystemEntry[] = [];
      for (const item of Array.from(transfer.items ?? [])) {
        if (item.kind !== "file") continue;
        const entry = typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null;
        if (entry) entries.push(entry);
      }
      if (entries.length === 0) {
        addCandidates(Array.from(transfer.files).map((file) => ({ file, path: "" })));
        return;
      }
      void (async () => {
        const found: Candidate[] = [];
        for (const entry of entries) await collectEntry(entry, found);
        // A loose file dropped on its own carries no folder to show.
        addCandidates(found.map(({ file, path }) => ({ file, path: path.includes("/") ? path : "" })));
      })();
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [addCandidates]);

  // --- Paste --------------------------------------------------------------
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName))) return;
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length === 0) return;
      event.preventDefault();
      const when = stamp();
      // A pasted screenshot is always "image.png"; give each a name worth
      // keeping as its library title.
      addCandidates(files.map((file, index) => {
        const extension = extensionOf(file.name).toLowerCase() || (file.type.split("/")[1] ?? "png");
        const suffix = files.length > 1 ? `-${index + 1}` : "";
        const renamed = new File([file], `pasted-${when}${suffix}.${extension}`, {
          type: file.type,
          lastModified: file.lastModified,
        });
        return { file: renamed, path: "" };
      }));
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [addCandidates]);

  const onPicked = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    addCandidates(files.map((file) => ({
      file,
      path: file.webkitRelativePath && file.webkitRelativePath.includes("/") ? file.webkitRelativePath : "",
    })));
    // Cleared so picking the same file again still fires a change.
    event.target.value = "";
  };

  const removeRows = useCallback((predicate: (row: Row) => boolean) => {
    const removing = rowsRef.current.filter((row) => predicate(row) && !requests.current.has(row.id));
    if (removing.length === 0) return;
    const ids = new Set(removing.map((row) => row.id));
    for (const row of removing) if (row.previewUrl) URL.revokeObjectURL(row.previewUrl);
    rowsRef.current = rowsRef.current.filter((row) => !ids.has(row.id));
    setRows((current) => current.filter((row) => !ids.has(row.id)));
  }, []);

  const retry = (ids: Set<string>) => {
    setRows((current) => current.map((row) => (
      ids.has(row.id) && row.status === "failed" ? { ...row, status: "queued", progress: 0, reason: undefined } : row
    )));
    setRunning(true);
  };

  const summary = useMemo(() => {
    const counts: Record<Status, number> = { checking: 0, queued: 0, uploading: 0, done: 0, failed: 0, rejected: 0 };
    let totalBytes = 0;
    let acceptedBytes = 0;
    let sentBytes = 0;
    for (const row of rows) {
      counts[row.status] += 1;
      totalBytes += row.file.size;
      if (row.status === "rejected" || row.status === "checking") continue;
      acceptedBytes += row.file.size;
      if (row.status === "done") sentBytes += row.file.size;
      else if (row.status === "uploading") sentBytes += row.file.size * row.progress;
    }
    return { counts, totalBytes, acceptedBytes, sentBytes };
  }, [rows]);

  const { counts } = summary;
  const countParts = ([
    ["done", "done"],
    ["uploading", "uploading"],
    ["queued", "queued"],
    ["checking", "checking"],
    ["failed", "failed"],
    ["rejected", "rejected"],
  ] as const)
    .filter(([status]) => counts[status] > 0)
    .map(([status, label]) => `${counts[status]} ${label}`);
  const overall = summary.acceptedBytes > 0 ? summary.sentBytes / summary.acceptedBytes : 0;
  const showOverall = running || counts.uploading > 0 || (counts.done > 0 && counts.done < rows.length);

  return (
    <main className={styles.page}>
      <RouteReady path="/library/upload" />
      <SiteNavigation active="library" />

      <div className={styles.shell}>
        <header className={styles.head}>
          <div>
            <p className={styles.kicker}>Library</p>
            <h1 className={styles.title}>Upload images</h1>
            <p className={styles.sub}>
              PNG, JPEG or WebP, up to {MAX_MB} MB each. Uploaded images are kept permanently.
            </p>
          </div>
          <TransitionLink href="/archive" className={styles.textLink}>
            Open archive
          </TransitionLink>
        </header>

        <button
          type="button"
          className={`${styles.zone}${dragging ? ` ${styles.zoneActive}` : ""}`}
          onClick={() => fileInput.current?.click()}
          aria-describedby="library-upload-zone-hint"
        >
          <span className={styles.zoneTitle}>{dragging ? "Release to add to the queue" : "Drop images or folders"}</span>
          <span className={styles.zoneHint} id="library-upload-zone-hint">
            Anywhere on this page. Or press Enter to choose files, or paste with Ctrl+V.
          </span>
        </button>

        <div className={styles.pickers}>
          <button type="button" className={styles.secondary} onClick={() => fileInput.current?.click()}>
            Choose files
          </button>
          <button type="button" className={styles.secondary} onClick={() => folderInput.current?.click()}>
            Choose folder
          </button>
          <input
            ref={fileInput}
            className={styles.hiddenInput}
            type="file"
            multiple
            accept={LIBRARY_UPLOAD_ACCEPT}
            onChange={onPicked}
            tabIndex={-1}
            aria-hidden="true"
          />
          <input
            ref={folderInput}
            className={styles.hiddenInput}
            type="file"
            multiple
            onChange={onPicked}
            tabIndex={-1}
            aria-hidden="true"
          />
        </div>

        <section className={styles.queue} aria-label="Upload queue">
          <div className={styles.queueHead}>
            <div className={styles.summary}>
              <p className={styles.label}>Queue</p>
              <p className={styles.counts} aria-live="polite" aria-atomic="true">
                {rows.length === 0
                  ? "Nothing queued yet."
                  : `${rows.length} file${rows.length === 1 ? "" : "s"} · ${formatBytes(summary.totalBytes)} — ${countParts.join(" · ")}`}
                {note ? ` ${note}` : ""}
              </p>
            </div>
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.primary}
                onClick={() => setRunning(true)}
                disabled={counts.queued === 0 || running}
              >
                {running ? "Uploading…" : "Upload all"}
              </button>
              <button
                type="button"
                className={styles.secondary}
                onClick={() => retry(new Set(rows.filter((row) => row.status === "failed").map((row) => row.id)))}
                disabled={counts.failed === 0}
              >
                Retry failed
              </button>
              <button
                type="button"
                className={styles.secondary}
                onClick={() => removeRows((row) => row.status === "done" || row.status === "rejected")}
                disabled={counts.done + counts.rejected === 0}
              >
                Clear finished
              </button>
            </div>
          </div>

          {showOverall ? (
            <div
              className={styles.overall}
              role="progressbar"
              aria-label="Batch progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(overall * 100)}
            >
              <span className={styles.bar} style={{ transform: `scaleX(${overall})` }} />
            </div>
          ) : null}

          {rows.length > 0 ? (
            <ul className={styles.list}>
              {rows.map((row) => (
                <li key={row.id} className={styles.row} data-status={row.status}>
                  <span className={styles.thumb} aria-hidden="true">
                    {row.previewUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={row.previewUrl} alt="" loading="lazy" decoding="async" />
                    ) : (
                      <span className={styles.thumbBlank}>{extensionOf(row.file.name) || "?"}</span>
                    )}
                  </span>
                  <span className={styles.meta}>
                    <span className={styles.name} title={row.file.name}>{row.file.name}</span>
                    <span className={styles.detail}>
                      {formatBytes(row.file.size)}
                      {row.path ? ` · ${row.path}` : ""}
                    </span>
                  </span>
                  <span className={styles.state}>
                    <span className={styles.statusLabel}>{statusLabel(row)}</span>
                    {row.reason ? <span className={styles.reason}>{row.reason}</span> : null}
                  </span>
                  <span className={styles.rowActions}>
                    {row.status === "done" && row.item ? (
                      <>
                        <a className={styles.textLink} href={row.item.imageUrl} target="_blank" rel="noreferrer">
                          View
                        </a>
                        {/* Deletes it from the Library for good, then drops
                            the row; "Clear finished" only tidies the queue. */}
                        <DeleteUploadButton
                          id={row.item.id}
                          name={row.file.name}
                          onDeleted={() => removeRows((entry) => entry.id === row.id)}
                        />
                      </>
                    ) : null}
                    {row.status === "failed" ? (
                      <button type="button" className={styles.quiet} onClick={() => retry(new Set([row.id]))}>
                        Retry
                      </button>
                    ) : null}
                    {row.status !== "uploading" && row.status !== "done" ? (
                      <button
                        type="button"
                        className={styles.quiet}
                        onClick={() => removeRows((entry) => entry.id === row.id)}
                        aria-label={`Remove ${row.file.name}`}
                      >
                        Remove
                      </button>
                    ) : null}
                  </span>
                  <span className={styles.track} aria-hidden="true">
                    <span
                      className={styles.bar}
                      style={{ transform: `scaleX(${row.status === "done" ? 1 : row.status === "uploading" ? row.progress : 0})` }}
                    />
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      </div>

      {dragging ? <div className={styles.dropVeil} aria-hidden="true" /> : null}
    </main>
  );
}

export default LibraryUpload;
