"use client";

import { useEffect, useMemo, useRef, type MutableRefObject } from "react";
import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import {
  DoubleSide,
  Group,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  MeshPhysicalMaterial,
  ShaderMaterial,
  SRGBColorSpace,
  Texture,
  Vector2,
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
  smoke: string;
};

const CARD_HEIGHT = 2.52;
const CARD_DEPTH = 0.045;
const IMAGE_INSET = 0.018;

const IMAGE_VERTEX_SHADER = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const IMAGE_FRAGMENT_SHADER = `
  uniform sampler2D uMap;
  uniform float uOpacity;
  uniform float uBlur;
  uniform vec2 uTexelSize;
  varying vec2 vUv;

  void main() {
    vec2 radius = uTexelSize * mix(0.35, 3.25, uBlur);
    vec4 sharp = texture2D(uMap, vUv);
    vec4 softened = sharp * 0.28;
    softened += texture2D(uMap, vUv + vec2(radius.x, 0.0)) * 0.12;
    softened += texture2D(uMap, vUv - vec2(radius.x, 0.0)) * 0.12;
    softened += texture2D(uMap, vUv + vec2(0.0, radius.y)) * 0.12;
    softened += texture2D(uMap, vUv - vec2(0.0, radius.y)) * 0.12;
    softened += texture2D(uMap, vUv + radius) * 0.06;
    softened += texture2D(uMap, vUv - radius) * 0.06;
    softened += texture2D(uMap, vUv + vec2(radius.x, -radius.y)) * 0.06;
    softened += texture2D(uMap, vUv + vec2(-radius.x, radius.y)) * 0.06;
    vec4 color = mix(sharp, softened, uBlur * 0.82);
    gl_FragColor = vec4(color.rgb, color.a * uOpacity);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// The reference field mixes clearer and smokier panes. Variation is stable by
// track index so the composition does not flicker or change between renders.
const PANE_PROFILES: readonly PaneProfile[] = [
  { glassOpacity: 0.045, imageOpacity: 0.94, smoke: "#f3f6f6" },
  { glassOpacity: 0.07, imageOpacity: 0.86, smoke: "#e9eeee" },
  { glassOpacity: 0.035, imageOpacity: 0.97, smoke: "#f6f8f8" },
  { glassOpacity: 0.085, imageOpacity: 0.8, smoke: "#dfe5e6" },
  { glassOpacity: 0.055, imageOpacity: 0.91, smoke: "#edf1f1" },
  { glassOpacity: 0.075, imageOpacity: 0.84, smoke: "#e4e9ea" },
];

export function SceneCard({ count, index, item, onHover, onOpen, progress, texture }: Props) {
  const groupRef = useRef<Group>(null);
  const shellRef = useRef<Mesh>(null);
  const imageRef = useRef<Mesh>(null);
  const glassRef = useRef<Mesh>(null);
  const imageMaterialRef = useRef<ShaderMaterial>(null);
  const glassMaterialRef = useRef<MeshPhysicalMaterial>(null);
  const edgeMaterialRef = useRef<MeshPhysicalMaterial>(null);
  const hoverTarget = useRef(0);
  const hoverValue = useRef(0);
  const maxAnisotropy = useThree((state) => state.gl.capabilities.getMaxAnisotropy());

  const aspect = useMemo(() => {
    const image = texture.image as ImageLike;
    const width = image.naturalWidth ?? image.width ?? 1;
    const height = image.naturalHeight ?? image.height ?? 1;
    return width / Math.max(1, height);
  }, [texture]);

  const profile = PANE_PROFILES[index % PANE_PROFILES.length];
  const width = CARD_HEIGHT * aspect;

  const configuredTexture = useMemo(() => {
    const next = texture.clone();
    next.colorSpace = SRGBColorSpace;
    next.minFilter = LinearMipmapLinearFilter;
    next.magFilter = LinearFilter;
    next.generateMipmaps = true;
    next.anisotropy = Math.min(16, maxAnisotropy);
    next.needsUpdate = true;
    return next;
  }, [maxAnisotropy, texture]);

  useEffect(() => () => configuredTexture.dispose(), [configuredTexture]);

  const imageUniforms = useMemo(() => {
    const image = texture.image as ImageLike;
    const sourceWidth = image.naturalWidth ?? image.width ?? 1;
    const sourceHeight = image.naturalHeight ?? image.height ?? 1;
    return {
      uBlur: { value: 0 },
      uMap: { value: configuredTexture },
      uOpacity: { value: profile.imageOpacity },
      uTexelSize: { value: new Vector2(1 / sourceWidth, 1 / sourceHeight) },
    };
  }, [configuredTexture, profile.imageOpacity, texture]);

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

    // One image layer preserves clarity. The independent shell and face layers
    // provide the glass veil without sampling or blurring neighboring texels.
    imageMaterial.uniforms.uOpacity.value = pose.opacity
      * Math.min(0.995, profile.imageOpacity * (0.72 + pose.focus * 0.31) + hoverValue.current * 0.045);
    imageMaterial.uniforms.uBlur.value = Math.max(
      0,
      pose.depthSoftness * 0.78 - hoverValue.current * 0.24,
    );
    glassMaterial.opacity = pose.opacity
      * Math.max(0.018, profile.glassOpacity + pose.depthSoftness * 0.065 - pose.focus * 0.018 - hoverValue.current * 0.012);
    edgeMaterial.opacity = pose.opacity * (0.065 + profile.glassOpacity * 0.32 + pose.depthSoftness * 0.025);

    const order = Math.round((12 - pose.relative) * 100) * 3 + index;
    if (shellRef.current) shellRef.current.renderOrder = order;
    if (imageRef.current) imageRef.current.renderOrder = order + 1;
    if (glassRef.current) glassRef.current.renderOrder = order + 2;
  });

  return (
    <group ref={groupRef}>
      <mesh ref={shellRef}>
        <boxGeometry args={[width, CARD_HEIGHT, CARD_DEPTH]} />
        <meshPhysicalMaterial
          ref={edgeMaterialRef}
          clearcoat={0.75}
          clearcoatRoughness={0.22}
          color={profile.smoke}
          depthTest
          depthWrite={false}
          ior={1.42}
          metalness={0}
          opacity={0.09}
          roughness={0.24}
          side={DoubleSide}
          thickness={0.045}
          transparent
          transmission={0.18}
        />
      </mesh>

      <mesh ref={imageRef} position={[0, 0, CARD_DEPTH / 2 + 0.001]}>
        <planeGeometry args={[width - IMAGE_INSET, CARD_HEIGHT - IMAGE_INSET]} />
        <shaderMaterial
          ref={imageMaterialRef}
          depthTest
          depthWrite={false}
          side={DoubleSide}
          toneMapped={false}
          transparent
          uniforms={imageUniforms}
          vertexShader={IMAGE_VERTEX_SHADER}
          fragmentShader={IMAGE_FRAGMENT_SHADER}
        />
      </mesh>

      <mesh
        ref={glassRef}
        position={[0, 0, CARD_DEPTH / 2 + 0.004]}
        onClick={(event) => {
          event.stopPropagation();
          onOpen(item);
        }}
        onPointerEnter={(event) => {
          event.stopPropagation();
          hoverTarget.current = 1;
          reportHover(event);
        }}
        onPointerMove={(event) => {
          event.stopPropagation();
          reportHover(event);
        }}
        onPointerLeave={() => {
          hoverTarget.current = 0;
          onHover(null);
        }}
      >
        <planeGeometry args={[width, CARD_HEIGHT]} />
        <meshPhysicalMaterial
          ref={glassMaterialRef}
          clearcoat={0.92}
          clearcoatRoughness={0.18}
          color={profile.smoke}
          depthTest
          depthWrite={false}
          ior={1.36}
          metalness={0}
          opacity={profile.glassOpacity}
          roughness={0.27}
          side={DoubleSide}
          thickness={0.014}
          transparent
          transmission={0.1}
        />
      </mesh>
    </group>
  );
}
