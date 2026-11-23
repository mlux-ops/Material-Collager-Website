"use client";

import { Canvas, useThree } from "@react-three/fiber";
import { useEffect, useState } from "react";
import { CanvasTexture, SRGBColorSpace } from "three";
import { samplePose } from "./sample-layout";

type PlaneProps = {
  url: string;
  index: number;
  count: number;
  selected: boolean;
  unpack: number;
  onSelect: () => void;
  onUnavailable: (value: true) => void;
};

function SamplePlane({ url, index, count, selected, unpack, onSelect, onUnavailable }: PlaneProps) {
  const [photo, setPhoto] = useState<CanvasTexture | null>(null);
  useEffect(() => {
    let disposed = false;
    let texture: CanvasTexture | undefined;
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      if (disposed) return;
      const scale = Math.min(1, 768 / Math.max(image.width, image.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      texture = new CanvasTexture(canvas);
      texture.colorSpace = SRGBColorSpace;
      setPhoto(texture);
    };
    image.onerror = () => { if (!disposed) onUnavailable(true); };
    image.src = url;
    return () => {
      disposed = true;
      image.onload = null;
      image.onerror = null;
      texture?.dispose();
    };
  }, [url, onUnavailable]);
  const pose = samplePose(index, count, unpack);
  const aspect = photo ? photo.image.width / photo.image.height : 1;
  const width = Math.min(1.84, 1.28 * aspect);
  return (
    <group
      position={[pose.x, pose.y, pose.z]}
      rotation={[pose.tilt, 0, pose.turn]}
      scale={pose.scale}
      onClick={(event) => { event.stopPropagation(); onSelect(); }}
    >
      <mesh position={[0, 0, -0.024]}>
        <boxGeometry args={[1.94, 1.38, 0.045]} />
        <meshBasicMaterial color={selected ? "#334c40" : "#a6aaa1"} toneMapped={false} />
      </mesh>
      <mesh>
        <planeGeometry args={[1.91, 1.35]} />
        <meshBasicMaterial color="#faf9f4" toneMapped={false} />
      </mesh>
      {photo ? (
        <mesh position={[0, 0, 0.002]}>
          <planeGeometry args={[width, width / aspect]} />
          <meshBasicMaterial map={photo} transparent toneMapped={false} />
        </mesh>
      ) : null}
    </group>
  );
}

type SceneProps = {
  samples: { slotId: string; images: string[] }[];
  selected: string;
  unpack: number;
  onSelect: (slotId: string) => void;
  onUnavailable: (value: true) => void;
};

function ContactPrint({ samples, selected, unpack, onSelect, onUnavailable }: SceneProps) {
  const { viewport } = useThree();
  const scale = Math.min(viewport.width / 4.8, viewport.height / 4.6);
  return (
    <group scale={scale}>
      {samples.map((item, index) => (
        <SamplePlane key={item.slotId + item.images[0]} url={item.images[0]} index={index}
          count={samples.length} selected={item.slotId === selected} unpack={unpack}
          onSelect={() => onSelect(item.slotId)} onUnavailable={onUnavailable} />
      ))}
    </group>
  );
}

export default function SampleScene(props: SceneProps) {
  return (
    <Canvas orthographic camera={{ position: [0, 0, 8], near: 0.1, far: 20, zoom: 90 }}
      dpr={[1, 1.5]} frameloop="demand" gl={{ alpha: true, antialias: true }}>
      <ContactPrint {...props} />
    </Canvas>
  );
}
