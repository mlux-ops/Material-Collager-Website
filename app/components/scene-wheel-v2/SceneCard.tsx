"use client";

import { useEffect, useMemo, useRef, type MutableRefObject } from "react";
import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
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

export type SceneWheelHoverState = {
  clientX: number;
  clientY: number;
  item: SceneLabCollageItem;
} | null;

type Props = {
  count: number;
  index: number;
  item: SceneLabCollageItem;
  onHover: (state: SceneWheelHoverState) => void;
  onOpen: (item: SceneLabCollageItem) => void;
  progress: MutableRefObject<number>;
  texture: Texture;
};

type PaneProfile = {
  glassOpacity: number;
  imageOpacity: number;
};

const CARD_HEIGHT = 2.52;
const CARD_DEPTH = 0.045;
const IMAGE_INSET = 0.018;

// The reference uses a varied field: some panes are clearer, while others read
// as smoke-tinted glass. Keep the variation deterministic instead of random.
const PANE_PROFILES: readonly PaneProfile[] = [
  { glassOpacity: 0.055, imageOpacity: 0.88 },
  { glassOpacity: 0.075, imageOpacity: 0.78 },
  { glassOpacity: 0.045, imageOpacity: 0.93 },
  { glassOpacity: 0.09, imageOpacity: 0.72 },
  { glassOpacity: 0.06, imageOpacity: 0.84 },
  { glassOpacity: 0.08, imageOpacity: 0.76 },
];

export function SceneCard({ count, index, item, onHover, onOpen, progress, texture }: Props) {
  const groupRef = useRef<Group>(null);
  const imageMaterialRef = useRef<MeshBasicMaterial>(null);
  const glassMaterialRef = useRef<MeshPhysicalMaterial>(null);
  const edgeMaterialRef = useRef<MeshPhysicalMaterial>(null);
  const hoverTarget = useRef(0);
  const hoverValue = useRef(0);
  const { gl } = useThree();

  const aspect = useMemo(() => {
    const image = texture.image as ImageLike;
    const width = image.naturalWidth ?? image.width ?? 1;
    const height = image.naturalHeight ?? image.height ?? 1;
    return Math.max(0.72, Math.min(1.65, width / Math.max(1, height)));
  }, [texture]);

  const profile = PANE_PROFILES[index % PANE_PROFILES.length];
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

  const reportHover = (event: ThreeEvent<PointerEvent>) => {
    const nativeEvent = event.nativeEvent as PointerEvent;
    onHover({ clientX: nativeEvent.clientX, clientY: nativeEvent.clientY, item });
  };

  useFrame((_, delta) => {
    const group = groupRef.current;
    const imageMaterial = imageMaterialRef.current;
    const glassMaterial = glassMaterialRef.current;
    const edgeMaterial = edgeMaterialRef.current;
    if (!group || !imageMaterial || !glassMaterial || !edgeMaterial) return;

    const pose = getSceneWheelPose(index, count, progress.current);
    hoverValue.current += (hoverTarget.current - hoverValue.current)
      * (1 - Math.exp(-13 * Math.min(delta, 0.05)));

    group.position.copy(pose.position).addScaledVector(SCENE_WHEEL_HOVER_OFFSET, hoverValue.current);
    group.quaternion.copy(pose.quaternion);
    group.scale.setScalar(pose.scale * (1 + hoverValue.current * 0.012));
    group.visible = pose.opacity > 0.002;

    // One image layer preserves texture sharpness. Hovering clarifies the pane
    // slightly, while the separate glass surfaces supply the frosted veil.
    imageMaterial.opacity = pose.opacity * Math.min(0.98, profile.imageOpacity + hoverValue.current * 0.08);
    glassMaterial.opacity = pose.opacity * (profile.glassOpacity + hoverValue.current * 0.018);
    edgeMaterial.opacity = pose.opacity * (0.1 + profile.glassOpacity * 0.45);
  });

  return (
    <group ref={groupRef}>
      <mesh renderOrder={0}>
        <boxGeometry args={[width, CARD_HEIGHT, CARD_DEPTH]} />
        <meshPhysicalMaterial
          ref={edgeMaterialRef}
          clearcoat={0.65}
          clearcoatRoughness={0.28}
          color="#dfe7e9"
          depthTest
          depthWrite={false}
          ior={1.42}
          metalness={0}
          opacity={0.12}
          roughness={0.28}
          side={DoubleSide}
          thickness={0.05}
          transparent
          transmission={0.58}
        />
      </mesh>

      <mesh position={[0, 0, CARD_DEPTH / 2 + 0.001]} renderOrder={1}>
        <planeGeometry args={[width - IMAGE_INSET, CARD_HEIGHT - IMAGE_INSET]} />
        <meshBasicMaterial
          ref={imageMaterialRef}
          depthTest
          depthWrite={false}
          map={texture}
          opacity={profile.imageOpacity}
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
          reportHover(event);
          gl.domElement.style.cursor = "pointer";
        }}
        onPointerMove={(event) => {
          event.stopPropagation();
          reportHover(event);
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
          clearcoat={0.8}
          clearcoatRoughness={0.22}
          color="#f2f6f7"
          depthTest
          depthWrite={false}
          ior={1.36}
          metalness={0}
          opacity={profile.glassOpacity}
          roughness={0.32}
          side={DoubleSide}
          thickness={0.018}
          transparent
          transmission={0.72}
        />
      </mesh>
    </group>
  );
}
