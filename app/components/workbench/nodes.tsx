/* eslint-disable @next/next/no-img-element */
"use client";

import { Handle, Position, useEdges, useNodes, type NodeProps } from "@xyflow/react";
import { memo, useMemo, useRef, type ReactNode } from "react";
import { fileFingerprint } from "@/app/lib/image-transport";
import { putBlob } from "./blob-cache";
import { estimateRunUsd, formatUsd } from "./cost";
import { cancelExecution, runNodes } from "./executor";
import { PHOTO_SOURCE_KEY } from "./persistence";
import { useWorkbenchStore } from "./store";
import styles from "./workbench.module.css";
import { PORT_COLORS, specFor, type NodeSpec, type WorkbenchNode, type WorkbenchNodeData } from "./types";

const SIZE_OPTIONS = ["1024x1024", "1536x1024", "1024x1536", "2048x2048", "2560x1440"];
const QUALITY_OPTIONS = ["low", "medium", "high"] as const;

type WorkbenchNodeProps = NodeProps<WorkbenchNode>;

const STATUS_LABEL: Record<WorkbenchNodeData["status"], string> = {
  idle: "Idle",
  running: "Running",
  done: "Done",
  error: "Error",
  stale: "Stale",
};

function PortHandles({ spec }: { spec: NodeSpec }) {
  return (
    <>
      {spec.inputs.map((port, index) => (
        <Handle
          key={port.id}
          id={port.id}
          type="target"
          position={Position.Left}
          style={{ top: 44 + index * 22, background: PORT_COLORS[port.kind] }}
          title={`${port.label} (${port.kind}${port.multi ? ", multiple" : ""})`}
        />
      ))}
      {spec.outputs.map((port, index) => (
        <Handle
          key={port.id}
          id={port.id}
          type="source"
          position={Position.Right}
          style={{ top: 44 + index * 22, background: PORT_COLORS[port.kind] }}
          title={`${port.label} (${port.kind})`}
        />
      ))}
    </>
  );
}

function NodeShell({ data, children, footer }: { data: WorkbenchNodeData; children: ReactNode; footer?: ReactNode }) {
  const spec = specFor(data.kind);
  return (
    <div className={`${styles.node} ${data.status === "error" ? styles.nodeError : ""}`}>
      <PortHandles spec={spec} />
      <header className={styles.nodeHeader}>
        <span className={styles.nodeTitle}>{spec.title}</span>
        <span className={`${styles.status} ${styles[`status_${data.status}`]}`}>{STATUS_LABEL[data.status]}</span>
      </header>
      <div className={styles.nodeBody}>{children}</div>
      {data.error && <p className={styles.errorText}>{data.error}</p>}
      {footer}
      <span className={styles.portLabels}>
        {spec.inputs.map((port) => <em key={port.id}>{port.label}</em>)}
      </span>
    </div>
  );
}

function RunFooter({ id, data, inputImages }: { id: string; data: WorkbenchNodeData; inputImages: number }) {
  const running = useWorkbenchStore((state) => state.running);
  const estimate = estimateRunUsd({
    size: data.params.size || "1536x1024",
    quality: data.params.quality || "medium",
    candidates: data.params.candidates || 1,
    inputImages,
  });
  return (
    <div className={styles.runRow}>
      <button
        type="button"
        className={styles.runButton}
        disabled={running}
        onClick={() => void runNodes([id])}
      >
        Run{estimate !== null ? ` · ~${formatUsd(estimate)}` : ""}
      </button>
      {running && data.status === "running" && (
        <button type="button" className={styles.cancelButton} onClick={cancelExecution}>Cancel</button>
      )}
    </div>
  );
}

function OutputPreview({ id, data }: { id: string; data: WorkbenchNodeData }) {
  const setActiveRun = useWorkbenchStore((state) => state.setActiveRun);
  const run = data.runs[data.activeRun];
  const image = run?.values[0]?.find((value) => value.kind === "image");
  if (!image || image.kind !== "image") return null;
  return (
    <figure className={styles.preview}>
      <img src={image.url} alt="Node output" draggable={false} />
      {data.runs.length > 1 && (
        <figcaption className={styles.history}>
          <button type="button" onClick={() => setActiveRun(id, Math.min(data.activeRun + 1, data.runs.length - 1))} disabled={data.activeRun >= data.runs.length - 1}>‹</button>
          <span>{data.runs.length - data.activeRun}/{data.runs.length}</span>
          <button type="button" onClick={() => setActiveRun(id, Math.max(data.activeRun - 1, 0))} disabled={data.activeRun <= 0}>›</button>
        </figcaption>
      )}
    </figure>
  );
}

function useConnectedImageCount(id: string, portIds: string[]) {
  const edges = useEdges();
  return useMemo(
    () => edges.filter((edge) => edge.target === id && portIds.includes(edge.targetHandle || "")).length,
    [edges, id, portIds],
  );
}

const PhotoNode = memo(function PhotoNode({ id, data }: WorkbenchNodeProps) {
  const applyRun = useWorkbenchStore((state) => state.applyRun);
  const updateParams = useWorkbenchStore((state) => state.updateParams);
  const inputRef = useRef<HTMLInputElement>(null);
  const run = data.runs[data.activeRun];
  const image = run?.values[0]?.[0];

  const choose = (fileList: FileList | null) => {
    const file = fileList?.[0];
    if (!file || !file.type.startsWith("image/")) return;
    const url = putBlob(PHOTO_SOURCE_KEY(id), file);
    updateParams(id, { fileName: file.name, fileFingerprint: fileFingerprint(file) });
    applyRun(id, {
      runId: `photo-${Date.now().toString(36)}`,
      signature: `photo:${fileFingerprint(file)}`,
      at: Date.now(),
      values: [[{ kind: "image", url, cacheKey: PHOTO_SOURCE_KEY(id) }]],
    });
  };

  return (
    <NodeShell data={data}>
      {image && image.kind === "image"
        ? <figure className={styles.preview}><img src={image.url} alt={data.params.fileName || "Uploaded"} draggable={false} /></figure>
        : <p className={styles.hint}>PNG, JPEG, or WebP under 50 MB.</p>}
      <button type="button" className={styles.smallButton} onClick={() => inputRef.current?.click()}>
        {image ? "Replace image" : "Choose image"}
      </button>
      <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(event) => choose(event.target.files)} />
    </NodeShell>
  );
});

const TextNode = memo(function TextNode({ id, data }: WorkbenchNodeProps) {
  const updateParams = useWorkbenchStore((state) => state.updateParams);
  return (
    <NodeShell data={data}>
      <textarea
        className={`${styles.textarea} nodrag nowheel`}
        rows={4}
        placeholder="Describe the change, mood, or instruction…"
        value={data.params.text ?? ""}
        onChange={(event) => updateParams(id, { text: event.target.value })}
      />
    </NodeShell>
  );
});

const PromptBuilderNode = memo(function PromptBuilderNode({ id, data }: WorkbenchNodeProps) {
  const updateParams = useWorkbenchStore((state) => state.updateParams);
  return (
    <NodeShell data={data}>
      <label className={styles.field}>
        <span>Domain</span>
        <select className="nodrag" value={data.params.domain} onChange={(event) => updateParams(id, { domain: event.target.value as "interior" | "exterior" | "collage" })}>
          <option value="interior">Interior render</option>
          <option value="exterior">Exterior render</option>
          <option value="collage">Material collage</option>
        </select>
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
        <span>Direction</span>
        <textarea className={`${styles.textarea} nodrag nowheel`} rows={2} value={data.params.extraDirection ?? ""} onChange={(event) => updateParams(id, { extraDirection: event.target.value })} placeholder="Optional extra art direction…" />
      </label>
    </NodeShell>
  );
});

function GenerationSettings({ id, data }: { id: string; data: WorkbenchNodeData }) {
  const updateParams = useWorkbenchStore((state) => state.updateParams);
  return (
    <>
      <label className={styles.field}>
        <span>Size</span>
        <select className="nodrag" value={data.params.size} onChange={(event) => updateParams(id, { size: event.target.value })}>
          {SIZE_OPTIONS.map((option) => <option key={option} value={option}>{option}{option === "2560x1440" ? " (2K)" : ""}</option>)}
        </select>
      </label>
      <label className={styles.field}>
        <span>Quality</span>
        <select className="nodrag" value={data.params.quality} onChange={(event) => updateParams(id, { quality: event.target.value as "low" | "medium" | "high" })}>
          {QUALITY_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      </label>
    </>
  );
}

const ImageGenerateNode = memo(function ImageGenerateNode({ id, data }: WorkbenchNodeProps) {
  const inputImages = useConnectedImageCount(id, ["references"]);
  return (
    <NodeShell data={data} footer={<RunFooter id={id} data={data} inputImages={inputImages} />}>
      <GenerationSettings id={id} data={data} />
      <OutputPreview id={id} data={data} />
    </NodeShell>
  );
});

const ImageEditNode = memo(function ImageEditNode({ id, data }: WorkbenchNodeProps) {
  const inputImages = useConnectedImageCount(id, ["image", "references"]);
  return (
    <NodeShell data={data} footer={<RunFooter id={id} data={data} inputImages={inputImages} />}>
      <GenerationSettings id={id} data={data} />
      <OutputPreview id={id} data={data} />
    </NodeShell>
  );
});

const CompareNode = memo(function CompareNode({ id, data }: WorkbenchNodeProps) {
  const updateParams = useWorkbenchStore((state) => state.updateParams);
  const nodes = useNodes<WorkbenchNode>();
  const edges = useEdges();
  const [urlA, urlB] = useMemo(() => {
    const pick = (portId: string) => {
      const edge = edges.find((candidate) => candidate.target === id && candidate.targetHandle === portId);
      if (!edge) return undefined;
      const source = nodes.find((candidate) => candidate.id === edge.source);
      const run = source?.data.runs[source.data.activeRun];
      const value = run?.values[0]?.find((entry) => entry.kind === "image");
      return value && value.kind === "image" ? value.url : undefined;
    };
    return [pick("a"), pick("b")];
  }, [edges, nodes, id]);
  const split = data.params.split ?? 50;

  return (
    <NodeShell data={data}>
      {urlA && urlB ? (
        <>
          <figure className={styles.compare}>
            <img src={urlA} alt="A" draggable={false} />
            <img src={urlB} alt="B" draggable={false} style={{ clipPath: `inset(0 0 0 ${split}%)` }} />
            <span className={styles.compareLine} style={{ left: `${split}%` }} />
          </figure>
          <input
            className={`${styles.slider} nodrag`}
            type="range"
            min={0}
            max={100}
            value={split}
            onChange={(event) => updateParams(id, { split: Number(event.target.value) })}
          />
        </>
      ) : (
        <p className={styles.hint}>Connect two images to compare.</p>
      )}
    </NodeShell>
  );
});

const SaveToLibraryNode = memo(function SaveToLibraryNode({ id, data }: WorkbenchNodeProps) {
  const updateParams = useWorkbenchStore((state) => state.updateParams);
  const running = useWorkbenchStore((state) => state.running);
  const savedJobId = data.runs[0]?.usage?.jobId as string | undefined;
  return (
    <NodeShell data={data}>
      <label className={styles.field}>
        <span>Filename</span>
        <input className="nodrag" type="text" value={data.params.filename ?? ""} onChange={(event) => updateParams(id, { filename: event.target.value })} />
      </label>
      <button type="button" className={styles.smallButton} disabled={running} onClick={() => void runNodes([id])}>
        Save to Library
      </button>
      {data.status === "done" && savedJobId && <p className={styles.hint}>Saved. It will stay in the Library for 30 days.</p>}
    </NodeShell>
  );
});

const NoteNode = memo(function NoteNode({ id, data }: WorkbenchNodeProps) {
  const updateParams = useWorkbenchStore((state) => state.updateParams);
  return (
    <div className={styles.note}>
      <textarea
        className={`${styles.noteText} nodrag nowheel`}
        rows={4}
        placeholder="Note…"
        value={data.params.text ?? ""}
        onChange={(event) => updateParams(id, { text: event.target.value })}
      />
    </div>
  );
});

export const NODE_TYPES = {
  photo: PhotoNode,
  text: TextNode,
  promptBuilder: PromptBuilderNode,
  imageGenerate: ImageGenerateNode,
  imageEdit: ImageEditNode,
  compare: CompareNode,
  saveToLibrary: SaveToLibraryNode,
  note: NoteNode,
};
