"use client";

/**
 * The review grid for one row's reference photos.
 *
 * Three ways in, because a reference arrives three ways: the sheet's own
 * reference URL (usually a product PAGE, so it is resolved to the images that
 * page declares about itself), a URL pasted by hand, and a file.
 *
 * Nothing collected is used until a person selects it. That is the point of the
 * grid — the earlier CLI rounds of this work produced an Energy Guide label, a
 * freezer drawer full of food and a Porcelanosa placeholder card among the
 * "best available" scrapes, and the only reliable filter was a person looking.
 */

import { useCallback, useRef, useState } from "react";
import styles from "./review-boards.module.css";

export type ProjectPhoto = {
  id: string;
  rowId: string;
  source: "url" | "upload";
  sourceUrl: string | null;
  bytes: number;
  width: number;
  height: number;
  status: "candidate" | "selected" | "rejected";
  lowResolution: boolean;
  imageUrl: string;
};

type Props = {
  projectId: string;
  rowId: string;
  itemName: string;
  reference: string;
  photos: ProjectPhoto[];
  onChanged: () => void | Promise<void>;
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

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`${file.name} could not be read.`));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

export function SlotPhotos({ projectId, rowId, itemName, reference, photos, onChanged }: Props) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [candidateUrls, setCandidateUrls] = useState<string[]>([]);
  const [manualUrl, setManualUrl] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const run = useCallback(
    async (label: string, work: () => Promise<unknown>) => {
      setBusy(label);
      setError("");
      try {
        await work();
        await onChanged();
      } catch (cause) {
        setError((cause as Error).message);
      } finally {
        setBusy("");
      }
    },
    [onChanged],
  );

  const discover = (url: string) =>
    run("discover", async () => {
      const found = await api<{ kind: "image" | "page"; urls: string[] }>(
        `/api/autoboard/projects/${encodeURIComponent(projectId)}/photos`,
        { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ action: "discover", url }) },
      );
      // A direct image link needs no review step — store it and move on. A page
      // yields several, and which one is the product is a person's call.
      if (found.kind === "image") {
        await api(`/api/autoboard/projects/${encodeURIComponent(projectId)}/photos`, {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ rowId, url: found.urls[0] }),
        });
        setCandidateUrls([]);
      } else {
        setCandidateUrls(found.urls);
      }
    });

  const collect = (url: string) =>
    run(`collect:${url}`, async () => {
      await api(`/api/autoboard/projects/${encodeURIComponent(projectId)}/photos`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ rowId, url }),
      });
      setCandidateUrls((current) => current.filter((entry) => entry !== url));
      setManualUrl("");
    });

  const upload = (files: FileList | null) =>
    run("upload", async () => {
      for (const file of [...(files ?? [])]) {
        await api(`/api/autoboard/projects/${encodeURIComponent(projectId)}/photos`, {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ rowId, mimeType: file.type, dataBase64: await readAsBase64(file) }),
        });
      }
      if (fileInput.current) fileInput.current.value = "";
    });

  const setStatus = (photoId: string, status: ProjectPhoto["status"]) =>
    run(`status:${photoId}`, () =>
      api(`/api/autoboard/photos/${encodeURIComponent(photoId)}`, {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify({ status }),
      }),
    );

  const remove = (photoId: string) =>
    run(`delete:${photoId}`, () =>
      api(`/api/autoboard/photos/${encodeURIComponent(photoId)}`, { method: "DELETE" }),
    );

  const live = photos.filter((photo) => photo.status !== "rejected");
  const rejected = photos.filter((photo) => photo.status === "rejected");

  return (
    <div className={styles.photos}>
      {live.length ? (
        <ul className={styles.photoGrid}>
          {live.map((photo) => (
            <li key={photo.id} className={styles.photoCell}>
              <button
                type="button"
                className={styles.photoPick}
                aria-pressed={photo.status === "selected"}
                aria-label={`${photo.status === "selected" ? "Deselect" : "Select"} this photo for ${itemName}`}
                disabled={busy !== ""}
                onClick={() => setStatus(photo.id, photo.status === "selected" ? "candidate" : "selected")}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- R2-backed
                    reference photography of unknown size; the optimizer adds a
                    round trip per thumbnail for no benefit at this scale. */}
                <img className={styles.photoImage} src={photo.imageUrl} alt="" loading="lazy" />
                <span className={styles.photoMeta}>
                  {photo.width}×{photo.height}
                  {photo.lowResolution ? <span className={styles.photoWarn}> low-res</span> : null}
                </span>
              </button>
              <div className={styles.photoActions}>
                <button
                  type="button"
                  className={styles.photoAction}
                  disabled={busy !== ""}
                  onClick={() => setStatus(photo.id, "rejected")}
                >
                  Reject
                </button>
                <button
                  type="button"
                  className={styles.photoAction}
                  disabled={busy !== ""}
                  onClick={() => remove(photo.id)}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {candidateUrls.length ? (
        <div className={styles.candidates}>
          <span className={styles.candidatesHead}>
            {candidateUrls.length} image{candidateUrls.length === 1 ? "" : "s"} on that page
          </span>
          <ul className={styles.candidateList}>
            {candidateUrls.map((url) => (
              <li key={url}>
                <button
                  type="button"
                  className={styles.candidateButton}
                  disabled={busy !== ""}
                  onClick={() => collect(url)}
                >
                  {busy === `collect:${url}` ? "Collecting…" : "Collect"}
                  <span className={styles.candidateUrl}>{url}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className={styles.photoTools}>
        {reference ? (
          <button
            type="button"
            className={styles.photoAction}
            disabled={busy !== ""}
            onClick={() => discover(reference)}
          >
            {busy === "discover" ? "Reading…" : "From sheet link"}
          </button>
        ) : null}

        <input
          className={styles.photoUrl}
          value={manualUrl}
          placeholder="Paste an image or page URL"
          aria-label={`Photo URL for ${itemName}`}
          onChange={(event) => setManualUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && manualUrl.trim()) {
              event.preventDefault();
              void discover(manualUrl.trim());
            }
          }}
        />
        <button
          type="button"
          className={styles.photoAction}
          disabled={busy !== "" || !manualUrl.trim()}
          onClick={() => discover(manualUrl.trim())}
        >
          Fetch
        </button>

        <label className={styles.photoAction}>
          Upload
          <input
            ref={fileInput}
            type="file"
            className={styles.visuallyHidden}
            accept="image/png,image/jpeg,image/webp"
            multiple
            disabled={busy !== ""}
            onChange={(event) => upload(event.target.files)}
          />
        </label>

        {rejected.length ? (
          <button
            type="button"
            className={styles.photoAction}
            disabled={busy !== ""}
            onClick={() => rejected.forEach((photo) => void setStatus(photo.id, "candidate"))}
          >
            Restore {rejected.length} rejected
          </button>
        ) : null}
      </div>

      {error ? (
        <p className={styles.photoError} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
