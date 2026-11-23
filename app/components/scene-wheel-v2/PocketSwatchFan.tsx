"use client";

import { useEffect, useId, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { motionReduced, potatoMode } from "@/app/lib/site-settings";
import { fanOpening, fanPull, isFanFlick } from "./swatch-fan-gesture";
import styles from "./pocket-swatch-fan.module.css";

// Locally cropped CC0 photographs. Oak and wool use the same scans as Raking light.
// Additional scans: ambientcg.com/a/Metal009, ambientcg.com/a/Travertine009,
// and polyhaven.com/a/lacquered_cherry_wood.
const stock = [
  { id: "brushed-steel", name: "Steel", edge: "#92928e" },
  { id: "lacquered-cherry", name: "Lacquer", edge: "#663b27" },
  { id: "herringbone", name: "Wool", edge: "#676159" },
  { id: "travertine", name: "Travertine", edge: "#bca78b" },
  { id: "white-oak", name: "White oak", edge: "#907356" },
];

type Gesture = {
  id: number; x: number; y: number; initial: number; travel: number;
  moved: boolean; lastDistance: number; lastTime: number; flickTime: number;
};

export function PocketSwatchFan() {
  const hintId = useId();
  const [opening, setOpening] = useState(0);
  const [dragging, setDragging] = useState(false);
  const gesture = useRef<Gesture | null>(null);
  const returnTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(returnTimer.current), []);

  function fold() {
    clearTimeout(returnTimer.current);
    gesture.current = null;
    setDragging(false);
    setOpening(0);
  }

  function start(event: PointerEvent<HTMLButtonElement>) {
    if (!event.isPrimary || event.button !== 0 || gesture.current) return;
    clearTimeout(returnTimer.current);
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = {
      id: event.pointerId, x: event.clientX, y: event.clientY, initial: opening,
      travel: event.currentTarget.offsetWidth, moved: false, lastDistance: 0,
      lastTime: event.timeStamp, flickTime: -Infinity,
    };
  }

  function move(event: PointerEvent<HTMLButtonElement>) {
    const g = gesture.current;
    if (!g || g.id !== event.pointerId) return;
    const dx = event.clientX - g.x;
    const dy = event.clientY - g.y;
    if (!g.moved && Math.hypot(dx, dy) < 4) return;
    g.moved = true;
    setDragging(true);
    const distance = fanPull(dx, dy);
    if (distance < g.lastDistance) g.flickTime = -Infinity;
    if (isFanFlick(distance - g.lastDistance, event.timeStamp - g.lastTime)) g.flickTime = event.timeStamp;
    g.lastTime = event.timeStamp;
    g.lastDistance = distance;
    setOpening(fanOpening(g.initial, distance, g.travel));
  }

  function release(event: PointerEvent<HTMLButtonElement>) {
    const g = gesture.current;
    if (!g || g.id !== event.pointerId) return;
    gesture.current = null;
    setDragging(false);
    if (!g.moved) {
      setOpening(g.initial > 0 ? 0 : 1);
    } else if (event.timeStamp - g.flickTime <= 100 && !motionReduced() && !potatoMode()) {
      setOpening(1);
      returnTimer.current = setTimeout(() => setOpening(0), 240);
    } else {
      setOpening(0);
    }
  }

  return (
    <button
      type="button"
      className={styles.fan}
      aria-label="Material swatch fan"
      aria-pressed={opening > 0}
      aria-describedby={hintId}
      data-dragging={dragging ? "" : undefined}
      data-open={opening > 0.8 ? "" : undefined}
      style={{ "--fan-open": opening } as CSSProperties}
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={release}
      onPointerCancel={fold}
      onLostPointerCapture={() => { if (gesture.current) fold(); }}
      onClick={(event) => {
        if (event.detail === 0) {
          clearTimeout(returnTimer.current);
          setOpening((value) => value > 0 ? 0 : 1);
        }
      }}
      onKeyDown={(event) => { if (event.key === "Escape") fold(); }}
      onBlur={fold}
    >
      <span id={hintId} hidden>Drag left to fan the swatches, or press to open and close. White oak, travertine, herringbone wool, lacquered cherry and brushed steel.</span>
      {stock.map((sample, index) => (
        <span
          key={sample.id} className={styles.leaf} aria-hidden="true"
          style={{
            "--fan-rest": `${3 + index * 2.2}deg`,
            "--fan-turn": `${(stock.length - 1 - index) * 22 - 2}deg`,
            "--fan-lag": `${index * 15}ms`,
            "--sample-edge": sample.edge,
            backgroundImage: `url("/swatch-fan/${sample.id}.webp")`,
          } as CSSProperties}
        ><span className={styles.ticket}>{sample.name}</span></span>
      ))}
      <span className={styles.pin} aria-hidden="true" />
    </button>
  );
}
