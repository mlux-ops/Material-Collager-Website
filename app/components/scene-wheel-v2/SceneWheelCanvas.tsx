"use client";

import { Suspense, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { Canvas, useFrame, useLoader } from "@react-three/fiber";
import { NoToneMapping, SRGBColorSpace, TextureLoader } from "three";
import type { SceneLabCollageItem } from "@/app/lib/scene-lab-assets";
import { SceneCard, type SceneWheelHoverState } from "./SceneCard";
import { SCENE_WHEEL_CAMERA, SCENE_WHEEL_MOBILE_CAMERA } from "./curve-model";

type Props = {
  items: readonly SceneLabCollageItem[];
  onHover: (state: SceneWheelHoverState) => void;
  onOpen: (item: SceneLabCollageItem) => void;
  targetProgress: MutableRefObject<number>;
  /** Fires once, on the scene's first rendered frame — the moment the canvas
   * actually has pixels, so placeholders above it can stand down. */
  onFirstFrame?: () => void;
};

function FirstFramePing({ onFirstFrame }: { onFirstFrame?: () => void }) {
  const fired = useRef(false);
  useFrame(() => {
    if (fired.current) return;
    fired.current = true;
    onFirstFrame?.();
  });
  return null;
}

function useMobileSceneFraming() {
  const [isMobile, setIsMobile] = useState(() => (
    typeof window !== "undefined"
      && window.matchMedia("(max-width: 700px) and (max-aspect-ratio: 18 / 25)").matches
  ));

  useEffect(() => {
    const query = window.matchMedia("(max-width: 700px) and (max-aspect-ratio: 18 / 25)");
    const sync = () => setIsMobile(query.matches);

    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  return isMobile;
}

function WheelScene({ items, onHover, onOpen, targetProgress }: Props) {
  const urls = useMemo(() => items.map((item) => item.url), [items]);
  const textures = useLoader(TextureLoader, urls);
  const previousUrlsRef = useRef<string[]>([]);

  // Evict superseded textures from the shared loader cache so replaced url
  // lists (e.g. live library refreshes) do not accumulate GPU uploads.
  useEffect(() => {
    const previous = previousUrlsRef.current;
    previousUrlsRef.current = urls;
    const active = new Set(urls);
    const stale = previous.filter((url: string) => !active.has(url));
    if (stale.length > 0) useLoader.clear(TextureLoader, stale);
  }, [urls]);

  const renderedProgress = useRef(targetProgress.current);
  const velocity = useRef(0);
  const freezeQaProgress = useMemo(() => {
    if (process.env.NODE_ENV === "production" || typeof window === "undefined") return false;
    const query = new URLSearchParams(window.location.search);
    return query.get("qa") === "1"
      && query.has("progress")
      && Number.isFinite(Number(query.get("progress")));
  }, []);

  useFrame((_, rawDelta) => {
    if (freezeQaProgress) {
      renderedProgress.current = targetProgress.current;
      velocity.current = 0;
      return;
    }

    const delta = Math.min(0.05, Math.max(0.001, rawDelta));
    const stiffness = 92;
    const damping = 2 * Math.sqrt(stiffness);
    const displacement = targetProgress.current - renderedProgress.current;
    const acceleration = stiffness * displacement - damping * velocity.current;
    velocity.current += acceleration * delta;
    renderedProgress.current += velocity.current * delta;
    if (Math.abs(displacement) < 0.00001 && Math.abs(velocity.current) < 0.00001) {
      renderedProgress.current = targetProgress.current;
      velocity.current = 0;
    }
  }, -1);

  return (
    <>
      {items.map((item, index) => (
        <SceneCard
          key={item.id}
          count={items.length}
          index={index}
          item={item}
          onHover={onHover}
          onOpen={onOpen}
          progress={renderedProgress}
          texture={textures[index]}
        />
      ))}
    </>
  );
}

export default function SceneWheelCanvas(props: Props) {
  const useMobileFraming = useMobileSceneFraming();

  return (
    <Canvas
      key={useMobileFraming ? "mobile" : "desktop"}
      aria-hidden="true"
      camera={useMobileFraming ? SCENE_WHEEL_MOBILE_CAMERA : SCENE_WHEEL_CAMERA}
      dpr={[1, 2]}
      frameloop="always"
      gl={{ alpha: false, antialias: true, powerPreference: "high-performance", premultipliedAlpha: false }}
      onCreated={({ gl }) => {
        gl.outputColorSpace = SRGBColorSpace;
        gl.toneMapping = NoToneMapping;
        gl.setClearColor(0xfafafa, 1);
        gl.domElement.setAttribute("data-scene-renderer", "scene-wheel-v2-linear-glass");
      }}
      onPointerMissed={() => props.onHover(null)}
    >
      <color attach="background" args={["#fafafa"]} />
      <Suspense fallback={null}>
        <WheelScene {...props} />
        {/* Inside the boundary on purpose: mounts only after the scene's
            textures resolve, so the first tick it sees is the first frame
            that actually shows cards — not an empty clear. */}
        <FirstFramePing onFirstFrame={props.onFirstFrame} />
      </Suspense>
    </Canvas>
  );
}
