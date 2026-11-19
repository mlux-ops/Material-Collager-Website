"use client";

import { Component, lazy, Suspense, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { motionReduced, potatoMode, subscribeSettings } from "@/app/lib/site-settings";
import type { BuiltBoard } from "./BoardWorkflow";
import { sampleSpread } from "./sample-layout";
import styles from "./sample-board.module.css";
import review from "./review-boards.module.css";

const SampleScene = lazy(() => import("./SampleScene"));

class SceneBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

function subscribeFlatMode(listener: () => void) {
  const unsubscribe = subscribeSettings(listener);
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  media.addEventListener("change", listener);
  return () => { unsubscribe(); media.removeEventListener("change", listener); };
}

function flatMode() { return potatoMode() || motionReduced(); }

function needsStaticView() {
  if (flatMode()) return true;
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    if (!gl) return true;
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return false;
  } catch {
    return true;
  }
}

type Props = { board: BuiltBoard; composed?: string };

function SampleDialog({ board, composed, onClose }: Props & { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const samples = board.items.filter((item) => item.images[0]);
  const [selectedId, select] = useState(samples[0]?.slotId);
  const [unpack, setUnpack] = useState(composed ? 0 : 75);
  const flat = useSyncExternalStore(subscribeFlatMode, flatMode, () => true);
  const [staticView, setStaticView] = useState(needsStaticView);
  const selectedIndex = Math.max(0, samples.findIndex((item) => item.slotId === selectedId));
  const active = samples[selectedIndex];
  const spread = sampleSpread(samples, selectedIndex);
  function selectSample(slotId: string) {
    select(slotId);
    if (composed && unpack < 20) setUnpack(75);
  }

  useEffect(() => {
    const element = dialog.current;
    const surface = stage.current;
    const useContactSheet = () => setStaticView(true);
    surface?.addEventListener("webglcontextlost", useContactSheet, true);
    element?.showModal();
    return () => {
      surface?.removeEventListener("webglcontextlost", useContactSheet, true);
      if (element?.open) element.close();
    };
  }, []);

  const contactSheet = (
    <div className={styles.sheet}>
      {spread.map((sample) => (
        <button key={sample.slotId} type="button" aria-label={sample.name || sample.role}
          aria-pressed={sample.slotId === active?.slotId} onClick={() => selectSample(sample.slotId)}>
          {/* eslint-disable-next-line @next/next/no-img-element -- authorized board photo */}
          <img src={sample.images[0]} alt={sample.name || sample.role} />
        </button>
      ))}
    </div>
  );

  return (
    <dialog ref={dialog} aria-labelledby={titleId} className={styles.dialog}
      onClose={(event) => { event.stopPropagation(); if (!event.currentTarget.open) onClose(); }}>
      <header className={styles.header}>
        <div><p>{board.unitType} · {board.roomLabel}</p><h2 id={titleId}>Sample board</h2></div>
        <button type="button" className={review.secondary} onClick={() => dialog.current?.close()}>Close samples</button>
      </header>
      {active ? <div className={styles.body}>
        <div className={styles.visual}>
          <div ref={stage} className={styles.stage}>
            {flat || staticView ? contactSheet : (
              <SceneBoundary fallback={<StaticFallback onFallback={setStaticView} />}>
                <Suspense fallback={contactSheet}>
                  <SampleScene samples={spread} selected={active.slotId} unpack={unpack / 100} onSelect={selectSample} onUnavailable={setStaticView} />
                </Suspense>
              </SceneBoundary>
            )}
            {composed && !flat && !staticView && unpack < 20 ? (
              // eslint-disable-next-line @next/next/no-img-element -- actual current board render
              <img className={styles.cover} src={composed} alt={board.title} style={{ opacity: 1 - unpack / 20 }} />
            ) : null}
          </div>
          {!flat && !staticView ? <label className={styles.control}>
            <span>Unpack</span>
            <input type="range" aria-label="Unpack" aria-valuetext={`${unpack}% separated`} min="0" max="100" value={unpack} onChange={(event) => setUnpack(Number(event.target.value))} />
            <output>{unpack}%</output>
          </label> : null}
        </div>
        <aside className={styles.catalog}>
          <h3>References <span>{samples.length}</span></h3>
          <ol className={styles.index}>
            {samples.map((item) => (
              <li key={item.slotId}>
                <button type="button" aria-pressed={item.slotId === active.slotId} onClick={() => selectSample(item.slotId)}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- selected source, also used on the plane */}
                  <img src={item.images[0]} alt="" loading="lazy" /><span>{item.role || item.name}</span>
                </button>
              </li>
            ))}
          </ol>
          <div className={styles.caption} aria-live="polite">
            <p>{active.brand && !active.name.toLowerCase().startsWith(active.brand.toLowerCase()) ? active.brand : active.role}</p><strong>{active.name || active.role}</strong>
            {active.sku ? <small>{active.sku}</small> : null}
            <a href={active.images[0]} target="_blank" rel="noreferrer">Open reference photo <span aria-hidden="true">↗</span></a>
          </div>
        </aside>
      </div> : null}
    </dialog>
  );
}

function StaticFallback({ onFallback }: { onFallback: (value: boolean) => void }) {
  useEffect(() => onFallback(true), [onFallback]);
  return null;
}

export function SampleBoard({ board, composed }: Props) {
  const [open, setOpen] = useState(false);
  if (!board.items.some((item) => item.images[0])) return null;
  return <>
    <button type="button" className={review.secondary} aria-haspopup="dialog" onClick={() => setOpen(true)}>Inspect sample board</button>
    {open ? <SampleDialog key={board.id} board={board} composed={composed} onClose={() => setOpen(false)} /> : null}
  </>;
}
