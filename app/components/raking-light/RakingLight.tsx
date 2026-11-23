/* eslint-disable @next/next/no-img-element */
"use client";

import { useEffect, useId, useRef, useState, type PointerEvent } from "react";
import { lightSamples, pointToLight, sampleMap, type LightSample } from "../../lib/raking-light";
import { potatoMode } from "../../lib/site-settings";
import type { mountSurface } from "./surface";
import styles from "./raking-light.module.css";

type Item = { uiKey: string; role: string; id: string };
type Props = {
  items: readonly Item[];
  full: boolean;
  onAdd: (key: string, sample: LightSample, file: File) => void;
};

function SampleView({ sample }: { sample: LightSample }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const surface = useRef<ReturnType<typeof mountSurface> | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "static">("loading");
  const [light, setLight] = useState({ azimuth: 310, elevation: 23 });
  const currentLight = useRef(light);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    let cancelled = false;
    async function mount() {
      try {
        if (potatoMode()) { setState("static"); return; }
        const { mountSurface } = await import("./surface");
        if (cancelled || !element) return;
        surface.current = mountSurface(element, sample, () => setState("ready"), () => setState("static"));
        const { azimuth, elevation } = currentLight.current;
        surface.current.aim(azimuth, elevation);
      } catch {
        if (!cancelled) setState("static");
      }
    }
    void mount();
    return () => {
      cancelled = true;
      surface.current?.dispose();
      surface.current = null;
    };
  }, [sample]);

  function aim(next: typeof light) {
    currentLight.current = next;
    setLight(next);
    surface.current?.aim(next.azimuth, next.elevation);
  }
  function aimFromPointer(event: PointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    aim(pointToLight(
      (event.clientX - bounds.left) / bounds.width * 2 - 1,
      (event.clientY - bounds.top) / bounds.height * 2 - 1,
    ));
  }
  return <>
    <div className={styles.surface} data-state={state}
      onPointerDown={(event) => {
        if (state !== "ready" || !event.isPrimary || event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        aimFromPointer(event);
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) aimFromPointer(event);
      }}
    >
      <img className={styles.still} src={sampleMap(sample, "diffuse")} alt={`${sample.name} surface detail`} />
      <canvas ref={canvas} className={styles.canvas} aria-hidden="true" />
    </div>
    <div className={styles.controlBar} aria-busy={state === "loading"}>
      {state === "ready" ? <>
        <span className={styles.hint}>Drag the light across the sample</span>
        <label>Direction <output>{light.azimuth}°</output>
          <input type="range" aria-label="Light direction" min="0" max="359" value={light.azimuth}
            onChange={event => aim({ ...light, azimuth: Number(event.target.value) })} />
        </label>
        <label>Elevation <output>{light.elevation}°</output>
          <input type="range" aria-label="Light elevation" min="10" max="80" value={light.elevation}
            onChange={event => aim({ ...light, elevation: Number(event.target.value) })} />
        </label>
      </> : <span role="status">{state === "loading" ? "Loading surface detail…" : "Color map view · Interactive lighting unavailable"}</span>}
    </div>
  </>;
}

function SampleDialog({ items, full, onAdd, onDismiss }: Props & { onDismiss: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [sample, setSample] = useState<LightSample>(lightSamples[0]);
  const [target, setTarget] = useState("");
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    const modal = dialog.current;
    modal?.showModal();
    return () => { pending.current?.abort(); };
  }, []);
  async function add() {
    if (!target || full || pending.current) return;
    const request = new AbortController();
    pending.current = request;
    setAdding(true);
    setError("");
    try {
      const response = await fetch(sampleMap(sample, "diffuse"), { signal: request.signal });
      if (!response.ok) throw new Error("Could not load the reference image.");
      const blob = await response.blob();
      if (!blob.type.startsWith("image/")) throw new Error("Invalid reference image.");
      if (request.signal.aborted) return;
      onAdd(target, sample, new File([blob], `${sample.id}.webp`, { type: "image/webp" }));
      dialog.current?.close();
    } catch {
      if (!request.signal.aborted) setError("The sample could not be added. Try again.");
    } finally {
      if (!request.signal.aborted) setAdding(false);
      pending.current = null;
    }
  }
  return <dialog ref={dialog} className={styles.dialog} aria-labelledby={titleId} onClose={onDismiss}>
    <header className={styles.head}>
      <h2 id={titleId}>Raking light</h2>
      <button type="button" className={styles.close} onClick={() => dialog.current?.close()}>Close</button>
    </header>
    <div className={styles.samples} aria-label="Material samples" role="group">
      {lightSamples.map(option => <button type="button" key={option.id} aria-pressed={option.id === sample.id}
        disabled={adding} onClick={() => { setSample(option); setError(""); }}>
        <img alt="" width="28" height="28" src={`/raking-light/${option.id}-swatch.webp`} />
        <span>{option.name}</span>
      </button>)}
    </div>
    <SampleView key={sample.id} sample={sample} />
    <footer className={styles.footer}>
      <div className={styles.credit}><strong>{sample.name}</strong>
        <a href={`https://polyhaven.com/a/${sample.id}`} target="_blank" rel="noreferrer">Poly Haven · PBR scan ↗</a>
      </div>
      <div className={styles.add}>
        <select aria-label="Reference tray item" value={target} disabled={full || adding || !items.length} onChange={event => setTarget(event.target.value)}>
          <option value="">{full ? "Reference tray is full" : !items.length ? "Add an item to the tray first" : "Choose tray item…"}</option>
          {items.map((item, index) => <option key={item.uiKey} value={item.uiKey}>{item.role || item.id || `Item ${index + 1}`}</option>)}
        </select>
        <button type="button" disabled={!target || full || adding} onClick={() => void add()}>{adding ? "Adding…" : "Add reference"}</button>
      </div>
    </footer>
    {error && <p role="alert" className={styles.error}>{error}</p>}
  </dialog>;
}

export function RakingLight(props: Props) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className={styles.trigger} aria-haspopup="dialog" onClick={() => setOpen(true)}>Raking light</button>
    {open && <SampleDialog {...props} onDismiss={() => setOpen(false)} />}
  </>;
}
