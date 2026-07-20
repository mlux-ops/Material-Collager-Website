"use client";

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { useThree } from "@react-three/fiber";
import {
  DoubleSide,
  Group,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  MathUtils,
  MeshBasicMaterial,
  PerspectiveCamera,
  Quaternion,
  Texture,
  Vector3,
} from "three";
import type { ScenePlaneState } from "@/app/lib/scene-lab-geometry";
import { getIntrinsicFrameSize, WORLD_FRAME_NORMAL } from "@/app/lib/world-scene-geometry";
import type { ScenePlaneHandle } from "./ScenePlane";

type ImageLike = { height?: number; naturalHeight?: number; naturalWidth?: number; width?: number };

const FRAME_DEPTH = 0.024;
function textureAspect(texture: Texture) {
  const image = texture.image as ImageLike;
  const width = image.naturalWidth ?? image.width ?? 1;
  const height = image.naturalHeight ?? image.height ?? 1;
  return width / Math.max(1, height);
}

function polygonArea(corners: ScenePlaneState["corners"]) {
  let area = 0;
  for (let index = 0; index < corners.length; index += 1) {
    const [x1, y1] = corners[index];
    const [x2, y2] = corners[(index + 1) % corners.length];
    area += x1 * y2 - x2 * y1;
  }
  return Math.max(0.0004, Math.abs(area) / 2);
}

function frameDepth(zRank: number) {
  return 0.65 + zRank * 0.34;
}

// Shared scratch for the per-frame update path so it never allocates.
const WORLD_UP = new Vector3(0, 1, 0);
const SCRATCH_NORMAL = new Vector3();
const SCRATCH_RIGHT = new Vector3();
const SCRATCH_UP = new Vector3();
const SCRATCH_BASIS = new Matrix4();
const SCRATCH_RAY = new Vector3();
const SCRATCH_POSITION = new Vector3();
const SCRATCH_VIEW_DIRECTION = new Vector3();
const SCRATCH_CAMERA_QUATERNION = new Quaternion();

function uprightQuaternion(normal: Vector3, target: Quaternion) {
  SCRATCH_NORMAL.copy(normal).normalize();
  SCRATCH_RIGHT.crossVectors(WORLD_UP, SCRATCH_NORMAL);
  if (SCRATCH_RIGHT.lengthSq() < 0.0001) SCRATCH_RIGHT.set(1, 0, 0);
  SCRATCH_RIGHT.normalize();
  SCRATCH_UP.crossVectors(SCRATCH_NORMAL, SCRATCH_RIGHT).normalize();
  return target.setFromRotationMatrix(SCRATCH_BASIS.makeBasis(SCRATCH_RIGHT, SCRATCH_UP, SCRATCH_NORMAL));
}

export const WorldScenePlane = forwardRef<ScenePlaneHandle, { texture: Texture | null }>(
  function WorldScenePlane({ texture }, forwardedRef) {
    const groupRef = useRef<Group>(null);
    const edgeMaterialRef = useRef<MeshBasicMaterial>(null);
    const faceMaterialRef = useRef<MeshBasicMaterial>(null);
    const { camera, size } = useThree();
    const rowNormal = useMemo(() => new Vector3(...WORLD_FRAME_NORMAL).normalize(), []);
    const rowQuaternion = useMemo(() => uprightQuaternion(rowNormal, new Quaternion()), [rowNormal]);

    useEffect(() => {
      if (!texture) return;
      texture.minFilter = LinearMipmapLinearFilter;
      texture.magFilter = LinearFilter;
      texture.generateMipmaps = true;
      texture.needsUpdate = true;
    }, [texture]);

    useImperativeHandle(forwardedRef, () => ({
      update(state, active, presentationPhase = 0) {
        const group = groupRef.current;
        const edgeMaterial = edgeMaterialRef.current;
        const faceMaterial = faceMaterialRef.current;
        const perspective = camera as PerspectiveCamera;
        if (!group || !edgeMaterial || !faceMaterial || !perspective.isPerspectiveCamera) return false;
        if (!state || !texture || state.opacity <= 0.005) {
          group.visible = false;
          return false;
        }

        const centerX = state.corners.reduce((sum, corner) => sum + corner[0], 0) / state.corners.length;
        const centerY = state.corners.reduce((sum, corner) => sum + corner[1], 0) / state.corners.length;
        const z = frameDepth(state.zRank);
        const rayDirection = SCRATCH_RAY.set(centerX * 2 - 1, 1 - centerY * 2, 0.5)
          .unproject(perspective)
          .sub(perspective.position)
          .normalize();
        const rayDistance = (z - perspective.position.z) / rayDirection.z;
        const position = SCRATCH_POSITION.copy(perspective.position).addScaledVector(rayDirection, rayDistance);

        const distance = Math.max(0.1, perspective.position.z - z);
        const visibleHeight = 2 * Math.tan(MathUtils.degToRad(perspective.fov / 2)) * distance;
        const visibleWidth = visibleHeight * perspective.aspect;
        const sourceAspect = textureAspect(texture);
        const area = polygonArea(state.corners);
        const frameSize = getIntrinsicFrameSize({
          normalizedArea: area,
          sourceAspect,
          viewportHeight: size.height,
          viewportWidth: size.width,
          visibleHeight,
          visibleWidth,
        });
        const phase = Math.max(0, Math.min(1, presentationPhase));
        const easedPhase = phase * phase * (3 - 2 * phase);
        const viewDirection = SCRATCH_VIEW_DIRECTION.copy(perspective.position).sub(position).normalize();
        const rowForeshortening = Math.max(0.25, Math.abs(rowNormal.dot(viewDirection)));
        const rowScaleCompensation = 1 / Math.sqrt(rowForeshortening);
        const scaleCompensation = rowScaleCompensation + (1 - rowScaleCompensation) * easedPhase;

        group.visible = true;
        group.position.copy(position);
        group.scale.set(frameSize.width * scaleCompensation, frameSize.height * scaleCompensation, 1);
        if (easedPhase > 0) {
          const cameraQuaternion = uprightQuaternion(viewDirection, SCRATCH_CAMERA_QUATERNION);
          group.quaternion.copy(rowQuaternion).slerp(cameraQuaternion, easedPhase);
        } else {
          group.quaternion.copy(rowQuaternion);
        }
        group.renderOrder = 1000 + Math.round(state.zRank * 10);
        edgeMaterial.opacity = Math.min(1, state.opacity + 0.08);
        faceMaterial.opacity = Math.min(1, state.opacity + (active ? 0.07 : 0));
        if (faceMaterial.map !== texture) {
          faceMaterial.map = texture;
          faceMaterial.needsUpdate = true;
        }
        group.userData.sourceAspect = sourceAspect;
        group.userData.worldAspect = group.scale.x / group.scale.y;
        group.userData.rowNormal = WORLD_FRAME_NORMAL;
        group.userData.presentationPhase = easedPhase;
        return true;
      },
    }), [camera, rowNormal, rowQuaternion, size.height, size.width, texture]);

    return (
      <group ref={groupRef} visible={false}>
        <mesh>
          <boxGeometry args={[1, 1, FRAME_DEPTH]} />
          <meshBasicMaterial
            ref={edgeMaterialRef}
            color="#d7d6d2"
            depthTest
            depthWrite
            opacity={1}
            toneMapped={false}
            transparent
          />
        </mesh>
        <mesh position={[0, 0, FRAME_DEPTH / 2 + 0.001]}>
          <planeGeometry args={[1, 1]} />
          <meshBasicMaterial
            ref={faceMaterialRef}
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
      </group>
    );
  },
);
