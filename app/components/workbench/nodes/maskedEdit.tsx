"use client";

import { useEdges, useNodes } from "@xyflow/react";
import { memo, useCallback, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { readApiResponse } from "@/app/lib/api-client";
import { compositeSelectiveEdit, type NormalizedBox } from "@/app/lib/selective-edit";
import { getBlob, putBlob } from "../blob-cache";
import { recordUsageCalibration } from "../cost";
import { useWorkbenchStore } from "../store";
import { useModalDismiss } from "../useModalDismiss";
import styles from "../workbench.module.css";
import type { ExecuteContext, NodeOutputValue, WorkbenchNode, WorkbenchParams } from "../types";
import { buildGenerationPayload, decodeBase64Image } from "./generation";
import {
  blobFromImageValue,
  GenerationSettings,
  NodeShell,
  OutputPreview,
  RunFooter,
  useConnectedImageCount,
  type WorkbenchNodeProps,
} from "./shared";

type DraftRect = { x: number; y: number; width: number; height: number }; // normalized 0-1000

function regionFromParams(params: WorkbenchParams): NormalizedBox | undefined {
  if (
    params.maskRegionX === undefined ||
    params.maskRegionY === undefined ||
    params.maskRegionWidth === undefined ||
    params.maskRegionHeight === undefined
  ) {
    return undefined;
  }
  return [params.maskRegionX, params.maskRegionY, params.maskRegionWidth, params.maskRegionHeight];
}

// Rectangle/region-selection surface: pointer events (not mouse-only) so the
// drag works with mouse, touch, and stylus alike. Freehand selection is
// deferred; masking is guidance, not pixel-exact geometry.
function MaskModal({
  imageUrl,
  initial,
  onCancel,
  onApply,
}: {
  imageUrl: string;
  initial?: NormalizedBox;
  onCancel: () => void;
  onApply: (box: NormalizedBox) => void;
}) {
  const areaRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<DraftRect | undefined>(
    initial ? { x: initial[0], y: initial[1], width: initial[2], height: initial[3] } : undefined,
  );
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  // Both dismissal paths animate out: Apply stashes its box here so the
  // shared exit animation runs before onApply/onCancel fires.
  const pendingApply = useRef<NormalizedBox | null>(null);
  const { closing, requestClose } = useModalDismiss(() => {
    const box = pendingApply.current;
    if (box) onApply(box);
    else onCancel();
  });

  const toNormalized = useCallback((clientX: number, clientY: number) => {
    const rect = areaRef.current?.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height) return { x: 0, y: 0 };
    return {
      x: Math.min(1000, Math.max(0, ((clientX - rect.left) / rect.width) * 1000)),
      y: Math.min(1000, Math.max(0, ((clientY - rect.top) / rect.height) * 1000)),
    };
  }, []);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = toNormalized(event.clientX, event.clientY);
    dragStart.current = point;
    setDraft({ x: point.x, y: point.y, width: 0, height: 0 });
  }, [toNormalized]);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragStart.current) return;
    const point = toNormalized(event.clientX, event.clientY);
    const start = dragStart.current;
    setDraft({
      x: Math.min(start.x, point.x),
      y: Math.min(start.y, point.y),
      width: Math.abs(point.x - start.x),
      height: Math.abs(point.y - start.y),
    });
  }, [toNormalized]);

  const handlePointerUp = useCallback(() => {
    dragStart.current = null;
  }, []);

  const canApply = Boolean(draft && draft.width > 8 && draft.height > 8);

  return (
    <div className={`${styles.maskModalOverlay} ${closing ? styles.overlayClosing : ""}`} role="dialog" aria-modal="true" aria-label="Select a region to edit">
      <div className={styles.maskModal}>
        <p className={styles.hint}>
          Drag to select the region to edit — everything outside is protected. Masking is guidance, not pixel-exact.
        </p>
        <div
          ref={areaRef}
          className={styles.maskCanvasArea}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imageUrl} alt="Node input" draggable={false} />
          {draft && (
            <span
              className={styles.maskRegionBox}
              style={{
                left: `${draft.x / 10}%`,
                top: `${draft.y / 10}%`,
                width: `${draft.width / 10}%`,
                height: `${draft.height / 10}%`,
              }}
            />
          )}
        </div>
        <div className={styles.maskModalActions}>
          <button type="button" className="nodrag" onClick={requestClose}>Cancel</button>
          <button
            type="button"
            className="nodrag"
            disabled={!canApply}
            onClick={() => {
              if (!draft) return;
              pendingApply.current = [draft.x, draft.y, draft.width, draft.height];
              requestClose();
            }}
          >
            Apply region
          </button>
        </div>
      </div>
    </div>
  );
}

export const Component = memo(function MaskedEditNode({ id, data }: WorkbenchNodeProps) {
  const updateParams = useWorkbenchStore((state) => state.updateParams);
  const touchBlobs = useWorkbenchStore((state) => state.touchBlobs);
  const inputImages = useConnectedImageCount(id, ["image"]);
  const edges = useEdges();
  const nodes = useNodes<WorkbenchNode>();
  const [modalOpen, setModalOpen] = useState(false);

  const inputImageUrl = useMemo(() => {
    const edge = edges.find((candidate) => candidate.target === id && candidate.targetHandle === "image");
    if (!edge) return undefined;
    const source = nodes.find((candidate) => candidate.id === edge.source);
    const run = source?.data.runs[source.data.activeRun];
    const value = run?.values[0]?.find((entry) => entry.kind === "image");
    return value && value.kind === "image" ? value.url : undefined;
  }, [edges, nodes, id]);

  const region = regionFromParams(data.params);

  const applyRegion = useCallback(async (box: NormalizedBox) => {
    setModalOpen(false);
    if (!inputImageUrl) return;
    const [x, y, width, height] = box;
    const cacheKey = `${id}:mask:${Math.round(x)}-${Math.round(y)}-${Math.round(width)}-${Math.round(height)}`;

    const image = new Image();
    image.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Could not read the input image."));
      image.src = inputImageUrl;
    });

    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) return;
    // OpenAI mask convention: opaque = protected, transparent = editable.
    context.fillStyle = "#000";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.clearRect(
      Math.floor((x / 1000) * canvas.width),
      Math.floor((y / 1000) * canvas.height),
      Math.ceil((width / 1000) * canvas.width),
      Math.ceil((height / 1000) * canvas.height),
    );

    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("Could not build the mask."))), "image/png"),
    );
    if (blob.size >= 4 * 1024 * 1024) {
      window.alert("The selected region produced a mask over 4MB. Select a smaller region.");
      return;
    }

    putBlob(cacheKey, blob);
    updateParams(id, {
      maskCacheKey: cacheKey,
      maskRegionX: x,
      maskRegionY: y,
      maskRegionWidth: width,
      maskRegionHeight: height,
    });
    // The mask is a SOURCE upload (persistBlobKeys declares maskCacheKey),
    // but it's created via updateParams alone, not applyRun -- so it needs
    // its own explicit blob-ownership-changed event (AC16) to get the old
    // mask GC'd and the new one durably written promptly.
    touchBlobs();
  }, [id, inputImageUrl, touchBlobs, updateParams]);

  return (
    <NodeShell data={data} footer={<RunFooter id={id} data={data} inputImages={inputImages} />}>
      <p className={styles.hint}>Masking is guidance, not pixel-exact.</p>
      <button type="button" className="nodrag" onClick={() => setModalOpen(true)} disabled={!inputImageUrl}>
        {region ? "Change selected region…" : "Select region…"}
      </button>
      <GenerationSettings id={id} data={data} />
      <OutputPreview id={id} data={data} />
      {modalOpen && inputImageUrl && (
        <MaskModal imageUrl={inputImageUrl} initial={region} onCancel={() => setModalOpen(false)} onApply={applyRegion} />
      )}
    </NodeShell>
  );
});

// DOM-touching execute wrapper: uploads the rendered PNG mask (<4MB, opaque
// elsewhere / transparent inside the selected region) alongside the base
// image, then composites the edited result back over the original using the
// extracted selective-edit compositor (feathered protection outside the
// region) — reused verbatim from app/lib/selective-edit.ts.
export async function execute(ctx: ExecuteContext): Promise<void> {
  const payload = buildGenerationPayload(ctx.params, ctx.inputs("prompt"));
  const base = ctx.inputs("image");
  if (!base.length) throw new Error("Connect an input image first.");
  const baseValue = base[0];
  if (baseValue.kind !== "image") throw new Error("Connect an input image first.");

  const region = regionFromParams(ctx.params);
  if (!region) throw new Error("Select a region to edit first.");
  const maskCacheKey = ctx.params.maskCacheKey;
  if (!maskCacheKey) throw new Error("Select a region to edit first.");
  const maskBlob = getBlob(maskCacheKey);
  if (!maskBlob) throw new Error("The mask is no longer cached. Re-select the region.");
  if (maskBlob.size >= 4 * 1024 * 1024) throw new Error("The mask exceeds the 4MB limit; select a smaller region.");

  const baseFile = await blobFromImageValue(baseValue);
  const maskFile = new File([maskBlob], "mask.png", { type: "image/png" });

  const form = new FormData();
  form.append("payload", JSON.stringify(payload));
  form.append("image[]", baseFile, "input.png");
  form.append("mask", maskFile, "mask.png");

  ctx.setProgress("Editing region…");
  const response = await fetch("/api/workbench/edit", { method: "POST", body: form, signal: ctx.signal })
    .then((value) => readApiResponse<{ ok: boolean; images: string[]; mimeType: string; usage?: Record<string, unknown> }>(value));

  const runId = ctx.createRunId();
  const originalUrl = baseValue.url;
  const images: NodeOutputValue[] = [];
  for (let index = 0; index < response.images.length; index += 1) {
    const cacheKey = `${ctx.nodeId}:${runId}:${index}`;
    const bytes = decodeBase64Image(response.images[index]);
    const editedUrl = URL.createObjectURL(new Blob([bytes], { type: response.mimeType || "image/png" }));
    try {
      const compositedUrl = await compositeSelectiveEdit(originalUrl, editedUrl, [region], []);
      const compositedBlob = await fetch(compositedUrl).then((value) => value.blob());
      URL.revokeObjectURL(compositedUrl);
      images.push({ kind: "image", url: putBlob(cacheKey, compositedBlob), cacheKey });
    } finally {
      URL.revokeObjectURL(editedUrl);
    }
  }
  ctx.applyRun({ runId, signature: ctx.signature, at: Date.now(), values: [images], usage: response.usage });
  recordUsageCalibration(payload.size, payload.quality, response.usage, 1);
}
