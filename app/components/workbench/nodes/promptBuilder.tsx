"use client";

import { memo, useMemo } from "react";
import { useWorkbenchStore } from "../store";
import styles from "../workbench.module.css";
import { getBlobUrl, getThumbnailUrl } from "../blob-cache";
import { NodeShell, useConnectedReferenceSlots, type WorkbenchNodeProps } from "./shared";
import {
  DEFAULT_REFERENCE_ROLE,
  PROMPT_MODES,
  REFERENCE_ROLES,
  buildPrompt,
  hasBaseImage,
  type PromptMode,
} from "./promptBuilder.manifest";

const REFERENCE_PORTS = ["references"];

const MODE_LABELS: Record<PromptMode, string> = {
  generate: "Generate",
  edit: "Edit",
  refine: "Refine",
};

// Renders exactly what was typed. Normalizing here would erase a space or a
// newline the instant it is typed, because the controlled value round-trips on
// every keystroke; buildPrompt splits the text at assembly time instead.
function rawText(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join("\n") : value ?? "";
}

export const Component = memo(function PromptBuilderNode({ id, data }: WorkbenchNodeProps) {
  const updateParams = useWorkbenchStore((state) => state.updateParams);
  const slots = useConnectedReferenceSlots(id, REFERENCE_PORTS);
  const referenceCount = slots.length;
  const mode: PromptMode = data.params.promptMode ?? "generate";
  // On an edit turn the base image is Image 1, so the references connected
  // here are numbered from 2 (see executeGeneration's multipart order).
  const numberOffset = hasBaseImage(mode) ? 1 : 0;
  const preview = useMemo(() => buildPrompt(data.params, referenceCount), [data.params, referenceCount]);

  const roles = data.params.referenceRoles ?? [];
  const setRole = (index: number, role: string) => {
    const next = Array.from({ length: referenceCount }, (_, i) => roles[i] ?? DEFAULT_REFERENCE_ROLE);
    next[index] = role;
    updateParams(id, { referenceRoles: next });
  };

  return (
    <NodeShell data={data}>
      <label className={styles.field}>
        <span>Mode</span>
        <select
          className="nodrag"
          value={mode}
          onChange={(event) => updateParams(id, { promptMode: event.target.value as PromptMode })}
        >
          {PROMPT_MODES.map((value) => (
            <option key={value} value={value}>{MODE_LABELS[value]}</option>
          ))}
        </select>
      </label>

      {mode === "generate" ? (
        <>
          <label className={styles.field}>
            <span>Domain</span>
            <select
              className="nodrag"
              value={data.params.domain ?? "interior"}
              onChange={(event) => updateParams(id, { domain: event.target.value as "interior" | "exterior" | "collage" })}
            >
              <option value="interior">Interior render</option>
              <option value="exterior">Exterior render</option>
              <option value="collage">Material collage</option>
            </select>
          </label>
          <label className={styles.field}>
            <span>Scene</span>
            <textarea className={`${styles.textarea} nodrag nowheel`} rows={2} value={data.params.genScene ?? ""} onChange={(event) => updateParams(id, { genScene: event.target.value })} placeholder="Where this is, framing, aspect…" />
          </label>
          <label className={styles.field}>
            <span>Subject</span>
            <textarea className={`${styles.textarea} nodrag nowheel`} rows={2} value={data.params.genSubject ?? ""} onChange={(event) => updateParams(id, { genSubject: event.target.value })} placeholder="What the image is of…" />
          </label>
          <label className={styles.field}>
            <span>Materials &amp; detail</span>
            <textarea className={`${styles.textarea} nodrag nowheel`} rows={2} value={data.params.genDetails ?? ""} onChange={(event) => updateParams(id, { genDetails: event.target.value })} placeholder="Materials, texture, finish…" />
          </label>
          <label className={styles.field}>
            <span>Lighting</span>
            <input className="nodrag" type="text" value={data.params.lighting ?? ""} onChange={(event) => updateParams(id, { lighting: event.target.value })} placeholder="soft daylight, golden hour…" />
          </label>
          <label className={styles.field}>
            <span>Style</span>
            <input className="nodrag" type="text" value={data.params.styleDirection ?? ""} onChange={(event) => updateParams(id, { styleDirection: event.target.value })} placeholder="photorealistic, editorial…" />
          </label>
          <label className={styles.field}>
            <span>Constraints</span>
            <textarea className={`${styles.textarea} nodrag nowheel`} rows={2} value={data.params.genConstraints ?? ""} onChange={(event) => updateParams(id, { genConstraints: event.target.value })} placeholder="No text, no watermarks, no extra objects…" />
          </label>
        </>
      ) : null}

      {mode === "edit" ? (
        <>
          <label className={styles.field}>
            <span>Change only</span>
            <textarea className={`${styles.textarea} nodrag nowheel`} rows={2} value={data.params.editChange ?? ""} onChange={(event) => updateParams(id, { editChange: event.target.value })} placeholder="the white chairs, replaced with wood…" />
          </label>
          <label className={styles.field}>
            <span>Preserve (one per line)</span>
            <textarea className={`${styles.textarea} nodrag nowheel`} rows={3} value={rawText(data.params.editPreserve)} onChange={(event) => updateParams(id, { editPreserve: event.target.value })} placeholder={"camera angle\nroom lighting\nfloor shadows"} />
          </label>
          <label className={styles.field}>
            <span>Exclusions (one per line)</span>
            <textarea className={`${styles.textarea} nodrag nowheel`} rows={2} value={rawText(data.params.editExclusions)} onChange={(event) => updateParams(id, { editExclusions: event.target.value })} placeholder={"text\nlogos\nwatermarks"} />
          </label>
        </>
      ) : null}

      {mode === "refine" ? (
        <>
          <label className={styles.field}>
            <span>The one change</span>
            <textarea className={`${styles.textarea} nodrag nowheel`} rows={2} value={data.params.refineChange ?? ""} onChange={(event) => updateParams(id, { refineChange: event.target.value })} placeholder="make it a winter evening with snowfall" />
          </label>
          <label className={styles.field}>
            <span>Carry forward (one per line)</span>
            <textarea className={`${styles.textarea} nodrag nowheel`} rows={3} value={rawText(data.params.refineCarry)} onChange={(event) => updateParams(id, { refineCarry: event.target.value })} placeholder={"the exact billboard text\nthe product label"} />
          </label>
        </>
      ) : null}

      {referenceCount > 0 ? (
        <div className={styles.field}>
          <span>Reference roles ({referenceCount})</span>
          {numberOffset ? (
            <small>Image 1 is the image being edited, connected on the edit node.</small>
          ) : null}
          {slots.map((slot, index) => {
            // A thumbnail only exists once something has generated one; the
            // full blob is always there, so fall back to it rather than
            // showing an empty row.
            const thumbnail = getThumbnailUrl(slot.cacheKey) ?? getBlobUrl(slot.cacheKey);
            return (
              <label key={slot.cacheKey} className={styles.field}>
                <span>
                  Image {index + 1 + numberOffset} · {slot.sourceTitle}
                </span>
                {/* eslint-disable-next-line @next/next/no-img-element -- blob: URL from the in-memory cache; next/image cannot optimize it */}
                {thumbnail ? <img src={thumbnail} alt="" width={48} height={48} style={{ objectFit: "cover" }} /> : null}
                <select
                  className="nodrag"
                  value={roles[index] ?? DEFAULT_REFERENCE_ROLE}
                  onChange={(event) => setRole(index, event.target.value)}
                >
                  {REFERENCE_ROLES.map((role) => (
                    <option key={role} value={role}>{role}</option>
                  ))}
                </select>
              </label>
            );
          })}
        </div>
      ) : null}

      <label className={styles.field}>
        <span>Extra direction</span>
        <textarea className={`${styles.textarea} nodrag nowheel`} rows={2} value={data.params.extraDirection ?? ""} onChange={(event) => updateParams(id, { extraDirection: event.target.value })} placeholder="Optional extra art direction…" />
      </label>

      <label className={styles.field}>
        <span>Preview</span>
        <textarea className={`${styles.textarea} nodrag nowheel`} rows={6} value={preview} readOnly />
      </label>
    </NodeShell>
  );
});
