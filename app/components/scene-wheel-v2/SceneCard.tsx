"use client";

import { useEffect, useMemo, useRef, type MutableRefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Group, LinearFilter, LinearMipmapLinearFilter, SRGBColorSpace, Texture } from "three";
import { getSceneWheelPose } from "./curve-model";

type ImageLike = { height?: number; naturalHeight?: number; naturalWidth?: number; width?: number };

type Props = {
  count: number;
  index: number;
  progress: MutableRefObject<number>;
  texture: Texture;
};

const CARD_HEIGHT = 2.35;
const CARD_DEPTH = 0.055;

export function SceneCard({ count, index, progress, texture }: Props) {
  const groupRef = useRef<Group>(null);
  const { gl } = useThree();
  const aspect = useMemo(() => {
    const image = texture.image as ImageLike;
    const width = image.naturalWidth ?? image.width ?? 1;
    const height = image.naturalHeight ?? image.height ?? 1;
    return Math.max(0.72, Math.min(1.65, width / Math.max(1, height)));
  }, [texture]);
  const width = CARD_HEIGHT * aspect;

  useEffect(() => {
    texture.colorSpace = SRGBColorSpace;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.magFilter = LinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = Math.min(12, gl.capabilities.getMaxAnisotropy());
    texture.needsUpdate = true;
  }, [gl, texture]);

  useFrame(() => {
    const group = groupRef.current;
    if (!group) return;
    const pose = getSceneWheelPose(index, count, progress.current);
    group.position.copy(pose.position);
    group.quaternion.copy(pose.quaternion);
  });

  return (
    <group ref={groupRef}>
      <mesh castShadow={false} receiveShadow={false}>
        <boxGeometry args={[width, CARD_HEIGHT, CARD_DEPTH]} />
        <meshBasicMaterial color="#c9c7c1" depthTest depthWrite toneMapped={false} />
      </mesh>
      <mesh position={[0, 0, CARD_DEPTH / 2 + 0.002]}>
        <planeGeometry args={[width - 0.035, CARD_HEIGHT - 0.035]} />
        <meshBasicMaterial map={texture} depthTest depthWrite toneMapped={false} />
      </mesh>
    </group>
  );
}
