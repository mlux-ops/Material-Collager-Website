"use client";

import { Canvas, useThree } from "@react-three/fiber";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  LinearFilter,
  LinearMipmapLinearFilter,
  NoToneMapping,
  SRGBColorSpace,
  Texture,
  TextureLoader,
} from "three";
import styles from "./scene-lab.module.css";

const TEXTURE_URL = "/scene-lab/compatibility-texture.png";

type TextureSource = {
  height?: number;
  naturalHeight?: number;
  naturalWidth?: number;
  width?: number;
};

function getTextureSize(texture: Texture) {
  const source = texture.image as TextureSource;
  return {
    height: source.naturalHeight ?? source.height ?? 1,
    width: source.naturalWidth ?? source.width ?? 1,
  };
}

function CompatibilityPlane({
  onTextureReady,
}: {
  onTextureReady: (width: number, height: number) => void;
}) {
  const [texture, setTexture] = useState<Texture | null>(null);
  const textureRef = useRef<Texture | null>(null);
  const { viewport } = useThree();

  useEffect(() => {
    let cancelled = false;
    const loader = new TextureLoader();

    loader.load(TEXTURE_URL, (loadedTexture) => {
      if (cancelled) {
        loadedTexture.dispose();
        return;
      }

      loadedTexture.colorSpace = SRGBColorSpace;
      loadedTexture.minFilter = LinearMipmapLinearFilter;
      loadedTexture.magFilter = LinearFilter;
      loadedTexture.generateMipmaps = true;
      loadedTexture.needsUpdate = true;
      textureRef.current = loadedTexture;
      setTexture(loadedTexture);
      const sourceSize = getTextureSize(loadedTexture);
      onTextureReady(sourceSize.width, sourceSize.height);
    });

    return () => {
      cancelled = true;
      textureRef.current?.dispose();
      textureRef.current = null;
    };
  }, [onTextureReady]);

  if (!texture) return null;

  const { height: sourceHeight, width: sourceWidth } = getTextureSize(texture);
  const sourceAspect = sourceWidth / sourceHeight;
  const width = Math.min(viewport.width * 0.72, viewport.height * 0.66 * sourceAspect);
  const height = width / sourceAspect;

  return (
    <mesh scale={[width, height, 1]}>
      <planeGeometry args={[1, 1]} />
      <meshBasicMaterial
        alphaTest={0}
        depthTest
        depthWrite
        map={texture}
        opacity={1}
        toneMapped={false}
        transparent={false}
      />
    </mesh>
  );
}

export default function SceneLabCompatibilitySpike() {
  const [sourceSize, setSourceSize] = useState<{ height: number; width: number } | null>(null);
  const handleTextureReady = useCallback((width: number, height: number) => {
    setSourceSize({ height, width });
  }, []);

  return (
    <main className={styles.shell}>
      <section className={styles.chrome} aria-label="Compatibility spike status">
        <div>
          <p className={styles.kicker}>Scene Lab</p>
          <h1>R3F / Vinext compatibility spike</h1>
        </div>
        <p className={styles.contract}>One plane · unlit · opaque</p>
        <nav aria-label="Compatibility spike navigation">
          <Link href="/">Library</Link>
          <Link href="/generator">Generator</Link>
        </nav>
      </section>

      <div
        className={styles.stage}
        data-alpha-policy="opaque-unpremultiplied"
        data-depth-test="true"
        data-depth-write="true"
        data-material="mesh-basic"
        data-renderer-output="srgb"
        data-source-aspect={sourceSize ? String(sourceSize.width / sourceSize.height) : undefined}
        data-source-height={sourceSize?.height}
        data-source-width={sourceSize?.width}
        data-texture-color-space="srgb"
        data-tone-mapping="none"
      >
        <Canvas
          aria-hidden="true"
          camera={{ fov: 45, near: 0.1, far: 10, position: [0, 0, 2] }}
          dpr={[1, 2]}
          frameloop="demand"
          gl={{ alpha: false, antialias: true, premultipliedAlpha: false }}
          onCreated={({ gl }) => {
            gl.outputColorSpace = SRGBColorSpace;
            gl.toneMapping = NoToneMapping;
            gl.setClearColor(0x111111, 1);
          }}
        >
          <CompatibilityPlane onTextureReady={handleTextureReady} />
        </Canvas>
      </div>
    </main>
  );
}
