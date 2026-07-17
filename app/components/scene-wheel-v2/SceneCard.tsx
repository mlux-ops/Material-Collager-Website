"use client";

import { useEffect, useMemo, useRef, type MutableRefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import {
  DoubleSide,
  Group,
  LinearFilter,
  LinearMipmapLinearFilter,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  SRGBColorSpace,
  Texture,
} from "three";
import type { SceneLabCollageItem } from "@/app/lib/scene-lab-assets";
import { getSceneWheelPose, SCENE_WHEEL_HOVER_OFFSET } from "./curve-model";

type ImageLike = {
  height?: number;
  naturalHeight?: number;
  naturalWidth?: number;
  width?: number;
};

type Props = {
  count: number;
  index: number;
  item: SceneLabCollageItem;
  onHover: (item: SceneLabCollageItem | null) => void;
  onOpen: (item: SceneLabCollageItem) => void;
  progress: MutableRefObject<number>;
  texture: Texture;
};

const CARD_HEIGHT = 2.52;
const CARD_DEPTH = 0.045;
const IMAGE_INSET = 0.018;

export function SceneCard({ count, index, item, onHover, onOpen, progress, texture }: Props) {
  const groupRef = useRef<Group>(null);
  const imageMaterialRef = useRef<MeshBasicMaterial>(null);
  const glassMaterialRef = useRef<MeshPhysicalMaterial>(null);
  const hoverTarget = useRef(0);
  const hoverValue = useRef(0);
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
    texture.anisotropy = Math.min(16, gl.capabilities.getMaxAnisotropy());
    texture.needsUpdate = true;
  }, [gl, texture]);

  useEffect(() => () => {
    gl.domElement.style.cursor = "default";
  }, [gl]);

  useFrame((_, delta) => {
    const group = groupRef.current;
    const imageMaterial = imageMaterialRef.current;
    const glassMaterial = glassMaterialRef.current;
    if (!group || !imageMaterial || !glassMaterial) return;

    const pose = getSceneWheelPose(index, count, progress.current);
    hoverValue.current += (hoverTarget.current - hoverValue.current)
      * (1 - Math.exp(-13 * Math.min(delta, 0.05)));

    group.position.copy(pose.position).addScaledVector(SCENE_WHEEL_HOVER_OFFSET, hoverValue.current);
    group.quaternion.copy(pose.quaternion);
    group.scale.setScalar(pose.scale * (1 + hoverValue.current * 0.012));
    group.visible = pose.opacity > 0.002;

    imageMaterial.opacity = pose.opacity * 0.86;
    glassMaterial.opacity = pose.opacity * (0.075 + hoverValue.current * 0.02);
  });

  return (
    <group ref={groupRef}>
      <mesh renderOrder={0}>
        <boxGeometry args={[width, CARD_HEIGHT, CARD_DEPTH]} />
        <meshPhysicalMaterial
          color="#e8edef"
          depthTest
          depthWrite={false}
          ior={1.42}
          metalness={0}
          opacity={0.09}
          roughness={0.3}
          side={DoubleSide}
          thickness={0.06}
          transparent
          transmission={0.72}
        />
      </mesh>

      <mesh position={[0, 0, CARD_DEPTH / 2 + 0.001]} renderOrder={1}>
        <planeGeometry args={[width - IMAGE_INSET, CARD_HEIGHT - IMAGE_INSET]} />
        <meshBasicMaterial
          ref={imageMaterialRef}
          depthTest
          depthWrite={false}
          map={texture}
          opacity={0.86}
          side={DoubleSide}
          toneMapped={false}
          transparent
        />
      </mesh>

      <mesh
        position={[0, 0, CARD_DEPTH / 2 + 0.004]}
        renderOrder={2}
        onClick={(event) => {
          event.stopPropagation();
          onOpen(item);
        }}
        onPointerEnter={(event) => {
          event.stopPropagation();
          hoverTarget.current = 1;
          onHover(item);
          gl.domElement.style.cursor = "pointer";
        }}
        onPointerLeave={() => {
          hoverTarget.current = 0;
          onHover(null);
          gl.domElement.style.cursor = "default";
        }}
      >
        <planeGeometry args={[width, CARD_HEIGHT]} />
        <meshPhysicalMaterial
          ref={glassMaterialRef}
          clearcoat={0.7}
          clearcoatRoughness={0.24}
          color="#f4f7f7"
          depthTest
          depthWrite={false}
          ior={1.36}
          metalness={0}
          opacity={0.075}
          roughness={0.34}
          side={DoubleSide}
          thickness={0.025}
          transparent
          transmission={0.68}
        />
      </mesh>
    </group>
  );
}
