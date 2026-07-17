"use client";

import { Suspense, useMemo, useRef, type MutableRefObject } from "react";
import { Canvas, useFrame, useLoader } from "@react-three/fiber";
import { NoToneMapping, SRGBColorSpace, TextureLoader } from "three";
import type { SceneLabCollageItem } from "@/app/lib/scene-lab-assets";
import { SceneCard } from "./SceneCard";
import { SCENE_WHEEL_CAMERA } from "./curve-model";

type Props = {
  items: readonly SceneLabCollageItem[];
  targetProgress: MutableRefObject<number>;
};

function WheelScene({ items, targetProgress }: Props) {
  const urls = useMemo(() => items.map((item) => item.url), [items]);
  const textures = useLoader(TextureLoader, urls);
  const renderedProgress = useRef(targetProgress.current);
  const velocity = useRef(0);

  useFrame((_, rawDelta) => {
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
          progress={renderedProgress}
          texture={textures[index]}
        />
      ))}
    </>
  );
}

export default function SceneWheelCanvas(props: Props) {
  return (
    <Canvas
      aria-hidden="true"
      camera={SCENE_WHEEL_CAMERA}
      dpr={[1, 2]}
      frameloop="always"
      gl={{ alpha: false, antialias: true, powerPreference: "high-performance", premultipliedAlpha: false }}
      onCreated={({ gl }) => {
        gl.outputColorSpace = SRGBColorSpace;
        gl.toneMapping = NoToneMapping;
        gl.setClearColor(0xfafafa, 1);
        gl.domElement.setAttribute("data-scene-renderer", "scene-wheel-v2-perspective");
      }}
    >
      <color attach="background" args={["#fafafa"]} />
      <Suspense fallback={null}>
        <WheelScene {...props} />
      </Suspense>
    </Canvas>
  );
}
