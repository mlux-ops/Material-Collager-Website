"use client";

import { useEffect, useMemo, useRef, type MutableRefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import {
  DoubleSide,
  Group,
  LinearFilter,
  LinearMipmapLinearFilter,
  ShaderMaterial,
  SRGBColorSpace,
  Texture,
  Vector2,
} from "three";
import type { SceneLabCollageItem } from "@/app/lib/scene-lab-assets";
import { getSceneWheelPose } from "./curve-model";

type ImageLike = { height?: number; naturalHeight?: number; naturalWidth?: number; width?: number };

type Props = {
  count: number;
  index: number;
  item: SceneLabCollageItem;
  onOpen: (item: SceneLabCollageItem) => void;
  progress: MutableRefObject<number>;
  texture: Texture;
};

const CARD_HEIGHT = 2.52;

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalView;
  varying vec3 vViewDirection;

  void main() {
    vUv = uv;
    vec3 transformed = position;
    float edgeX = abs(uv.x - 0.5) * 2.0;
    float edgeY = abs(uv.y - 0.5) * 2.0;
    float dome = sin(uv.x * 3.14159265) * sin(uv.y * 3.14159265);
    transformed.z += dome * 0.105;
    transformed.z -= pow(edgeX, 4.0) * 0.035;
    transformed.z -= pow(edgeY, 5.0) * 0.018;

    vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
    vNormalView = normalize(normalMatrix * normal);
    vViewDirection = normalize(-mvPosition.xyz);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec2 uTexel;
  uniform float uOpacity;
  uniform float uHover;

  varying vec2 vUv;
  varying vec3 vNormalView;
  varying vec3 vViewDirection;

  vec4 diffuseSample(vec2 uv, float radius) {
    vec2 stepSize = uTexel * radius;
    vec4 total = texture2D(uMap, uv) * 0.22;
    total += texture2D(uMap, uv + vec2(stepSize.x, 0.0)) * 0.12;
    total += texture2D(uMap, uv - vec2(stepSize.x, 0.0)) * 0.12;
    total += texture2D(uMap, uv + vec2(0.0, stepSize.y)) * 0.12;
    total += texture2D(uMap, uv - vec2(0.0, stepSize.y)) * 0.12;
    total += texture2D(uMap, uv + stepSize) * 0.075;
    total += texture2D(uMap, uv - stepSize) * 0.075;
    total += texture2D(uMap, uv + vec2(stepSize.x, -stepSize.y)) * 0.075;
    total += texture2D(uMap, uv + vec2(-stepSize.x, stepSize.y)) * 0.075;
    return total;
  }

  void main() {
    vec3 normal = normalize(vNormalView);
    vec3 viewDirection = normalize(vViewDirection);
    float fresnel = pow(1.0 - abs(dot(normal, viewDirection)), 2.35);
    float edge = smoothstep(0.66, 1.0, max(abs(vUv.x - 0.5), abs(vUv.y - 0.5)) * 2.0);
    float frost = 0.44 + fresnel * 1.6 + edge * 0.7;

    vec4 sharp = texture2D(uMap, vUv);
    vec4 diffused = diffuseSample(vUv, frost);
    vec3 image = mix(sharp.rgb, diffused.rgb, 0.25 + fresnel * 0.24 + edge * 0.08);

    float highlight = pow(max(0.0, dot(reflect(-viewDirection, normal), normalize(vec3(-0.35, 0.72, 0.6)))), 28.0);
    vec3 glassTint = vec3(0.965, 0.982, 1.0);
    image = mix(image, image * glassTint + 0.06, fresnel * 0.42);
    image += highlight * (0.14 + uHover * 0.1);
    image += fresnel * 0.045;

    gl_FragColor = vec4(image, uOpacity * (0.93 + fresnel * 0.05));
  }
`;

export function SceneCard({ count, index, item, onOpen, progress, texture }: Props) {
  const groupRef = useRef<Group>(null);
  const materialRef = useRef<ShaderMaterial>(null);
  const hoverTarget = useRef(0);
  const hoverValue = useRef(0);
  const { gl } = useThree();
  const dimensions = useMemo(() => {
    const image = texture.image as ImageLike;
    const width = image.naturalWidth ?? image.width ?? 1;
    const height = image.naturalHeight ?? image.height ?? 1;
    return { aspect: Math.max(0.72, Math.min(1.65, width / Math.max(1, height))), height, width };
  }, [texture]);
  const width = CARD_HEIGHT * dimensions.aspect;

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
    const material = materialRef.current;
    if (!group || !material) return;
    const pose = getSceneWheelPose(index, count, progress.current);
    group.position.copy(pose.position);
    group.quaternion.copy(pose.quaternion);
    group.scale.setScalar(pose.scale * (1 + hoverValue.current * 0.018));
    group.visible = pose.opacity > 0.002;
    material.uniforms.uOpacity.value = pose.opacity;
    hoverValue.current += (hoverTarget.current - hoverValue.current) * (1 - Math.exp(-12 * Math.min(delta, 0.05)));
    material.uniforms.uHover.value = hoverValue.current;
  });

  return (
    <group ref={groupRef}>
      <mesh
        onClick={(event) => {
          event.stopPropagation();
          onOpen(item);
        }}
        onPointerEnter={(event) => {
          event.stopPropagation();
          hoverTarget.current = 1;
          gl.domElement.style.cursor = "pointer";
        }}
        onPointerLeave={() => {
          hoverTarget.current = 0;
          gl.domElement.style.cursor = "default";
        }}
      >
        <planeGeometry args={[width, CARD_HEIGHT, 48, 48]} />
        <shaderMaterial
          ref={materialRef}
          depthTest
          depthWrite
          fragmentShader={fragmentShader}
          side={DoubleSide}
          transparent
          uniforms={{
            uHover: { value: 0 },
            uMap: { value: texture },
            uOpacity: { value: 1 },
            uTexel: { value: new Vector2(1 / dimensions.width, 1 / dimensions.height) },
          }}
          vertexShader={vertexShader}
        />
      </mesh>
    </group>
  );
}
