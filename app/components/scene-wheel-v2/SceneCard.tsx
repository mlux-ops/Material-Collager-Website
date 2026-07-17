"use client";

import { useEffect, useMemo, useRef, type MutableRefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { DoubleSide, Group, LinearFilter, LinearMipmapLinearFilter, MeshBasicMaterial, MeshPhysicalMaterial, SRGBColorSpace, Texture } from "three";
import type { SceneLabCollageItem } from "@/app/lib/scene-lab-assets";
import { getSceneWheelPose } from "./curve-model";

type ImageLike = { height?: number; naturalHeight?: number; naturalWidth?: number; width?: number };
type Props = { count: number; index: number; item: SceneLabCollageItem; onOpen: (item: SceneLabCollageItem) => void; progress: MutableRefObject<number>; texture: Texture };

const H = 2.52;
const D = 0.18;

export function SceneCard({ count, index, item, onOpen, progress, texture }: Props) {
  const groupRef = useRef<Group>(null);
  const shellRef = useRef<MeshPhysicalMaterial>(null);
  const layerRefs = useRef<Array<MeshBasicMaterial | null>>([]);
  const hoverTarget = useRef(0);
  const hover = useRef(0);
  const { gl } = useThree();
  const aspect = useMemo(() => {
    const image = texture.image as ImageLike;
    return Math.max(0.72, Math.min(1.65, (image.naturalWidth ?? image.width ?? 1) / Math.max(1, image.naturalHeight ?? image.height ?? 1)));
  }, [texture]);
  const width = H * aspect;

  useEffect(() => {
    texture.colorSpace = SRGBColorSpace;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.magFilter = LinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = Math.min(16, gl.capabilities.getMaxAnisotropy());
    texture.needsUpdate = true;
  }, [gl, texture]);

  useFrame((_, delta) => {
    const group = groupRef.current;
    if (!group) return;
    const pose = getSceneWheelPose(index, count, progress.current);
    hover.current += (hoverTarget.current - hover.current) * (1 - Math.exp(-12 * Math.min(delta, 0.05)));
    group.position.copy(pose.position);
    group.quaternion.copy(pose.quaternion);
    group.scale.setScalar(pose.scale * (1 + hover.current * 0.02));
    group.visible = pose.opacity > 0.002;
    if (shellRef.current) shellRef.current.opacity = pose.opacity * 0.38;
    for (const material of layerRefs.current) if (material) material.opacity = pose.opacity * 0.34;
  });

  return (
    <group ref={groupRef}>
      <mesh
        onClick={(event) => { event.stopPropagation(); onOpen(item); }}
        onPointerEnter={(event) => { event.stopPropagation(); hoverTarget.current = 1; gl.domElement.style.cursor = "pointer"; }}
        onPointerLeave={() => { hoverTarget.current = 0; gl.domElement.style.cursor = "default"; }}
      >
        <boxGeometry args={[width, H, D, 1, 1, 4]} />
        <meshPhysicalMaterial ref={shellRef} color="#eef4f8" depthTest depthWrite={false} metalness={0} opacity={0.38} roughness={0.18} side={DoubleSide} thickness={0.22} transparent transmission={0.74} />
      </mesh>
      {[-0.045, 0, 0.045].map((z, layer) => (
        <mesh key={z} position={[0, 0, z]}>
          <planeGeometry args={[width - 0.035, H - 0.035]} />
          <meshBasicMaterial ref={(material) => { layerRefs.current[layer] = material; }} map={texture} depthTest depthWrite={layer === 2} opacity={0.34} side={DoubleSide} toneMapped={false} transparent />
        </mesh>
      ))}
    </group>
  );
}
