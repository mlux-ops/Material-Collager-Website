"use client";

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { useThree } from "@react-three/fiber";
import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  MeshBasicMaterial,
  Texture,
} from "three";
import type { SceneLabCollageItem } from "@/app/lib/scene-lab-assets";
import type { ScenePlaneState } from "@/app/lib/scene-lab-geometry";

export type ScenePlaneHandle = {
  update: (state: ScenePlaneState | null, active: boolean) => boolean;
};

type ImageLike = { height?: number; naturalHeight?: number; naturalWidth?: number; width?: number };

function textureDimensions(texture: Texture) {
  const image = texture.image as ImageLike;
  return {
    height: image.naturalHeight ?? image.height ?? 1,
    width: image.naturalWidth ?? image.width ?? 1,
  };
}

function cropUVs(texture: Texture, targetAspect: number, anchor: readonly [number, number]) {
  const { height, width } = textureDimensions(texture);
  const sourceAspect = width / height;
  let u0 = 0;
  let u1 = 1;
  let v0 = 0;
  let v1 = 1;
  if (sourceAspect > targetAspect) {
    const visible = targetAspect / sourceAspect;
    u0 = Math.max(0, Math.min(1 - visible, anchor[0] - visible / 2));
    u1 = u0 + visible;
  } else {
    const visible = sourceAspect / targetAspect;
    const top = Math.max(0, Math.min(1 - visible, anchor[1] - visible / 2));
    v0 = 1 - (top + visible);
    v1 = 1 - top;
  }
  return new Float32Array([u0, v1, u1, v1, u1, v0, u0, v0]);
}

export const ScenePlane = forwardRef<ScenePlaneHandle, { asset: SceneLabCollageItem; texture: Texture | null }>(
  function ScenePlane({ asset, texture }, forwardedRef) {
    const meshRef = useRef<Mesh>(null);
    const materialRef = useRef<MeshBasicMaterial>(null);
    const lastAspectRef = useRef(0);
    const viewportSize = useThree((state) => state.size);
    const geometry = useMemo(() => {
      const next = new BufferGeometry();
      next.setAttribute("position", new BufferAttribute(new Float32Array(12), 3));
      next.setAttribute("uv", new BufferAttribute(new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]), 2));
      // Screen coordinates use a downward y axis; reverse winding for the +z camera.
      next.setIndex([0, 2, 1, 0, 3, 2]);
      return next;
    }, []);

    useEffect(() => () => geometry.dispose(), [geometry]);

    useEffect(() => {
      if (!texture) return;
      texture.minFilter = LinearMipmapLinearFilter;
      texture.magFilter = LinearFilter;
      texture.generateMipmaps = true;
      texture.needsUpdate = true;
    }, [texture]);

    useImperativeHandle(forwardedRef, () => ({
      update(state, active) {
        const mesh = meshRef.current;
        const material = materialRef.current;
        if (!mesh || !material) return false;
        if (!state || !texture || state.opacity <= 0.005) {
          mesh.visible = false;
          return false;
        }
        mesh.visible = true;
        mesh.position.z = state.zRank * 0.012;
        mesh.renderOrder = 1000 + Math.round(state.zRank * 10);
        const positions = geometry.getAttribute("position") as BufferAttribute;
        state.corners.forEach(([x, y], index) => {
          positions.setXYZ(index, (x - 0.5) * viewportSize.width, (0.5 - y) * viewportSize.height, 0);
        });
        positions.needsUpdate = true;
        geometry.computeBoundingSphere();

        if (Math.abs(lastAspectRef.current - state.projectedAspect) > 0.001) {
          const uv = geometry.getAttribute("uv") as BufferAttribute;
          uv.copyArray(cropUVs(texture, state.projectedAspect, asset.cropAnchor));
          uv.needsUpdate = true;
          lastAspectRef.current = state.projectedAspect;
        }
        if (material.map !== texture) {
          material.map = texture;
          material.needsUpdate = true;
        }
        material.opacity = Math.min(1, state.opacity + (active ? 0.07 : 0));
        return true;
      },
    }), [asset.cropAnchor, geometry, texture, viewportSize.height, viewportSize.width]);

    return (
      <mesh ref={meshRef} geometry={geometry} frustumCulled={false} visible={false}>
        <meshBasicMaterial
          ref={materialRef}
          alphaTest={0}
          depthTest
          depthWrite={false}
          opacity={1}
          premultipliedAlpha={false}
          side={DoubleSide}
          toneMapped={false}
          transparent
        />
      </mesh>
    );
  },
);
