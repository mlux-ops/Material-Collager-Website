"use client";

import type { CSSProperties, KeyboardEvent, MouseEvent, RefCallback } from "react";
import type { SceneLabCollageItem } from "@/app/lib/scene-lab-assets";
import type { SceneLabView } from "./SceneLabChrome";
import styles from "@/app/scene-lab/scene-lab.module.css";

type Props = {
  activeId: string;
  assets: readonly SceneLabCollageItem[];
  buttonRef: (id: string) => RefCallback<HTMLButtonElement>;
  failedTextureIds: ReadonlySet<string>;
  onActivate: (id: string, event: MouseEvent<HTMLButtonElement>) => void;
  onFocus: (id: string) => void;
  onHover: (id: string | null) => void;
  onKeyDown: (id: string, event: KeyboardEvent<HTMLButtonElement>) => void;
  view: SceneLabView;
};

export function SceneLabIndex({ activeId, assets, buttonRef, failedTextureIds, onActivate, onFocus, onHover, onKeyDown, view }: Props) {
  return (
    <ol className={styles.projectCollection} data-view={view} aria-label="Completed finish collages">
      {assets.map((asset) => (
        <li key={asset.id} data-track={asset.id} data-collage-id={asset.collageId} data-lab-instance={asset.instanceId} data-source-kind={asset.sourceKind} data-preview-failed={failedTextureIds.has(asset.id) ? "true" : "false"}>
          <button
            ref={buttonRef(asset.id)}
            type="button"
            className={styles.projectControl}
            data-active={asset.id === activeId ? "true" : "false"}
            onClick={(event) => onActivate(asset.id, event)}
            onFocus={() => onFocus(asset.id)}
            onKeyDown={(event) => onKeyDown(asset.id, event)}
            onPointerEnter={() => onHover(asset.id)}
            onPointerLeave={() => onHover(null)}
            tabIndex={asset.id === activeId ? 0 : -1}
            aria-label={`${asset.accessibleName}${failedTextureIds.has(asset.id) ? ", preview unavailable" : ""}`}
          >
            <span
              className={styles.indexImage}
              aria-hidden="true"
              style={{ "--asset-url": `url("${asset.url}")` } as CSSProperties}
            />
            <span className={styles.projectTitle}>{asset.title}</span>
            <span className={styles.instanceMeta}>{asset.instanceLabel}</span>
            {failedTextureIds.has(asset.id) ? <span className={styles.previewFailure}>PREVIEW UNAVAILABLE</span> : null}
          </button>
        </li>
      ))}
    </ol>
  );
}
