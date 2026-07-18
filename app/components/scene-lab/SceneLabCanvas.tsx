"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { createRef, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoToneMapping,
  RGBAFormat,
  SRGBColorSpace,
  Texture,
  TextureLoader,
  UnsignedByteType,
} from "three";
import type { SceneLabCollageItem } from "@/app/lib/scene-lab-assets";
import {
  applySelection,
  getInterpolatedPlanes,
  getTextureWindow,
  type ScenePlaneState,
  type ViewportKey,
} from "@/app/lib/scene-lab-geometry";
import type { VirtualProgressController } from "@/app/hooks/useVirtualProgress";
import { ScenePlane, type ScenePlaneHandle } from "./ScenePlane";
import { WorldScenePlane } from "./WorldScenePlane";

type Props = {
  activeId: string;
  assets: readonly SceneLabCollageItem[];
  frozen: boolean;
  initialProgress: number;
  onContextState: (lost: boolean) => void;
  onFrameState: (planes: ScenePlaneState[], progress: number, selectionPhase: number) => void;
  onTextureState: (state: TextureLoadState) => void;
  progress: VirtualProgressController;
  selectedId: string | null;
  viewportHeight: number;
  viewportKey: ViewportKey;
  viewportWidth: number;
  textureRetryNonce: number;
  worldSpace: boolean;
};

export type TextureLoadState = {
  expected: number;
  failed: number;
  failedTrackIds: string[];
  loaded: number;
  pending: number;
  ready: boolean;
};

type TextureFailure = { message: string; url: string };

function createFallbackTexture() {
  const pixels = new Uint8Array([
    230, 226, 218, 255, 198, 194, 186, 255,
    198, 194, 186, 255, 230, 226, 218, 255,
  ]);
  const texture = new DataTexture(pixels, 2, 2, RGBAFormat, UnsignedByteType);
  texture.colorSpace = SRGBColorSpace;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.userData.sceneLabFallback = true;
  texture.needsUpdate = true;
  return texture;
}

function useTextureWindow(
  trackIds: string[],
  assets: readonly SceneLabCollageItem[],
  onTextureState: Props["onTextureState"],
  retryNonce: number,
) {
  const [textures, setTextures] = useState<Map<string, Texture>>(() => new Map());
  const [failures, setFailures] = useState<Map<string, TextureFailure>>(() => new Map());
  const texturesRef = useRef(textures);
  const failuresRef = useRef(failures);
  const activeRef = useRef(new Set(trackIds));
  const activeUrlRef = useRef(new Map<string, string>());
  const pendingRef = useRef(new Set<string>());
  const retryRef = useRef(retryNonce);
  const fallbackTexture = useMemo(() => createFallbackTexture(), []);
  const key = trackIds.join("|");
  const catalogKey = assets.map((asset) => `${asset.id}:${asset.url}`).join("|");
  useEffect(() => {
    const ids = key ? key.split("|") : [];
    const active = new Set(ids);
    const assetById = new Map(assets.map((asset) => [asset.id, asset]));
    const activeUrls = new Map(ids.map((id) => [id, assetById.get(id)?.url ?? ""]));
    activeRef.current = active;
    activeUrlRef.current = activeUrls;
    if (retryRef.current !== retryNonce) {
      retryRef.current = retryNonce;
      failuresRef.current = new Map();
      setFailures(new Map());
    }
    let changed = false;
    const removedTextures = new Set<Texture>();
    for (const [id, texture] of texturesRef.current) {
      if (!active.has(id) || texture.userData.sceneLabUrl !== activeUrls.get(id)) {
        removedTextures.add(texture);
        texturesRef.current.delete(id);
        changed = true;
      }
    }
    const retainedTextures = new Set(texturesRef.current.values());
    for (const texture of removedTextures) {
      if (!retainedTextures.has(texture)) texture.dispose();
    }
    let failuresChanged = false;
    for (const [id, failure] of failuresRef.current) {
      if (!active.has(id) || failure.url !== activeUrls.get(id)) {
        failuresRef.current.delete(id);
        failuresChanged = true;
      }
    }
    if (failuresChanged) setFailures(new Map(failuresRef.current));

    const loader = new TextureLoader();
    for (const id of ids) {
      const asset = assetById.get(id);
      if (!asset) continue;
      if (texturesRef.current.has(id) || failuresRef.current.get(id)?.url === asset.url) continue;
      const sharedTexture = [...texturesRef.current.values()].find((texture) => texture.userData.sceneLabUrl === asset.url);
      if (sharedTexture) {
        texturesRef.current.set(id, sharedTexture);
        changed = true;
        continue;
      }
      if (pendingRef.current.has(asset.url)) continue;
      pendingRef.current.add(asset.url);
      loader.load(
        asset.url,
        (texture) => {
          pendingRef.current.delete(asset.url);
          const matchingIds = [...activeUrlRef.current]
            .filter(([, url]) => url === asset.url)
            .map(([trackId]) => trackId);
          if (matchingIds.length === 0) {
            texture.dispose();
            return;
          }
          texture.colorSpace = SRGBColorSpace;
          texture.minFilter = LinearMipmapLinearFilter;
          texture.magFilter = LinearFilter;
          texture.generateMipmaps = true;
          texture.anisotropy = 4;
          texture.userData.sceneLabUrl = asset.url;
          texture.needsUpdate = true;
          for (const trackId of matchingIds) {
            texturesRef.current.set(trackId, texture);
            failuresRef.current.delete(trackId);
          }
          setFailures(new Map(failuresRef.current));
          setTextures(new Map(texturesRef.current));
        },
        undefined,
        (error) => {
          pendingRef.current.delete(asset.url);
          const failure = {
            message: error instanceof Error ? error.message : "Collage preview texture failed to load.",
            url: asset.url,
          };
          for (const [trackId, url] of activeUrlRef.current) {
            if (url === asset.url) failuresRef.current.set(trackId, failure);
          }
          setFailures(new Map(failuresRef.current));
        },
      );
    }
    if (changed) setTextures(new Map(texturesRef.current));
  }, [assets, catalogKey, key, retryNonce]);

  useEffect(() => {
    const expected = key ? key.split("|").length : 0;
    const loaded = textures.size;
    const failedTrackIds = [...failures.keys()].toSorted();
    const failed = failedTrackIds.length;
    const pending = Math.max(0, expected - loaded - failed);
    onTextureState({ expected, failed, failedTrackIds, loaded, pending, ready: pending === 0 });
  }, [failures, onTextureState, textures, key]);

  const resolvedTextures = useMemo(() => {
    const resolved = new Map(textures);
    for (const id of failures.keys()) resolved.set(id, fallbackTexture);
    return resolved;
  }, [failures, fallbackTexture, textures]);

  useEffect(() => () => {
    for (const texture of new Set(texturesRef.current.values())) texture.dispose();
    texturesRef.current.clear();
    failuresRef.current.clear();
    pendingRef.current.clear();
    fallbackTexture.dispose();
  }, [fallbackTexture]);

  return resolvedTextures;
}

function SceneField({
  activeId,
  assets,
  onFrameState,
  onWindowChange,
  planeRefs,
  progress,
  reportEveryFrame,
  staticWindowIds,
  selectedId,
  viewportHeight,
  viewportKey,
  viewportWidth,
}: Omit<Props, "frozen" | "initialProgress" | "onContextState" | "onTextureState" | "textureRetryNonce" | "worldSpace"> & {
  onWindowChange: (ids: string[]) => void;
  planeRefs: Map<string, RefObject<ScenePlaneHandle | null>>;
  reportEveryFrame: boolean;
  staticWindowIds: string[] | null;
}) {
  const selectionRef = useRef(0);
  const frameSamplesRef = useRef<number[]>([]);
  const frameNumberRef = useRef(0);
  const longFrameCountRef = useRef(0);
  const performanceRunRef = useRef("");
  const reportElapsedRef = useRef(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const selectedTrackRef = useRef<string | null>(selectedId);
  const windowKeyRef = useRef("");
  const { gl } = useThree();

  useEffect(() => {
    canvasRef.current = gl.domElement;
  }, [gl]);

  useFrame((_, delta) => {
    const requestedRun = canvasRef.current?.dataset.performanceRunId ?? "";
    if (requestedRun !== performanceRunRef.current) {
      performanceRunRef.current = requestedRun;
      frameSamplesRef.current = [];
      frameNumberRef.current = 0;
      longFrameCountRef.current = 0;
    }
    const frameMs = delta * 1000;
    if (frameMs > 0 && frameMs < 250) {
      const samples = frameSamplesRef.current;
      samples.push(frameMs);
      if (samples.length > 720) samples.shift();
      if (frameMs > 100) longFrameCountRef.current += 1;
      frameNumberRef.current += 1;
      if (frameNumberRef.current % 30 === 0 && samples.length > 0) {
        const sorted = [...samples].sort((left, right) => left - right);
        const percentileIndex = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
        canvasRef.current?.setAttribute("data-frame-p95-ms", sorted[percentileIndex].toFixed(2));
        canvasRef.current?.setAttribute("data-frame-max-ms", sorted.at(-1)?.toFixed(2) ?? "0");
        canvasRef.current?.setAttribute("data-frame-samples", String(sorted.length));
        canvasRef.current?.setAttribute("data-frame-over-100-ms", String(longFrameCountRef.current));
      }
    }
    const rendered = progress.step(delta);
    if (selectedId) selectedTrackRef.current = selectedId;
    const selectionTarget = selectedId ? 1 : 0;
    selectionRef.current += (selectionTarget - selectionRef.current) * (1 - Math.exp(-7.5 * Math.min(0.05, delta)));
    if (!selectedId && selectionRef.current < 0.002) selectedTrackRef.current = null;
    let planes = getInterpolatedPlanes(viewportKey, rendered);
    planes = applySelection(planes, selectedTrackRef.current, selectionRef.current, viewportWidth, viewportHeight);
    const byId = new Map(planes.map((plane) => [plane.trackId, plane]));
    let registeredHandles = 0;
    let drawablePlanes = 0;
    for (const asset of assets) {
      const handle = planeRefs.get(asset.id)?.current;
      if (handle) registeredHandles += 1;
      const presentationPhase = asset.id === selectedTrackRef.current ? selectionRef.current : 0;
      if (handle?.update(byId.get(asset.id) ?? null, asset.id === activeId, presentationPhase)) drawablePlanes += 1;
    }
    if (reportEveryFrame || frameNumberRef.current % 10 === 0) {
      canvasRef.current?.setAttribute("data-scene-handles", String(registeredHandles));
      canvasRef.current?.setAttribute("data-scene-planes", String(planes.length));
      canvasRef.current?.setAttribute("data-drawable-planes", String(drawablePlanes));
      canvasRef.current?.setAttribute("data-render-calls", String(gl.info.render.calls));
      canvasRef.current?.setAttribute("data-renderer-dpr", gl.getPixelRatio().toFixed(2));
      canvasRef.current?.setAttribute("data-texture-count", String(gl.info.memory.textures));
      canvasRef.current?.setAttribute("data-geometry-count", String(gl.info.memory.geometries));
    }
    const windowIds = staticWindowIds ?? getTextureWindow(viewportKey, rendered);
    const windowKey = windowIds.join("|");
    if (windowKey !== windowKeyRef.current) {
      windowKeyRef.current = windowKey;
      onWindowChange(windowIds);
    }
    reportElapsedRef.current += delta;
    if (reportEveryFrame || reportElapsedRef.current >= 0.1) {
      reportElapsedRef.current = 0;
      onFrameState(planes, rendered, selectionRef.current);
    }
  });
  return null;
}

export default function SceneLabCanvas(props: Props) {
  const staticWindowIds = useMemo(() => new Set(props.assets.map((asset) => asset.url)).size <= 10
    ? props.assets.map((asset) => asset.id)
    : null, [props.assets]);
  const [windowIds, setWindowIds] = useState(() => staticWindowIds ?? getTextureWindow(props.viewportKey, props.initialProgress));
  const planeRefs = useMemo(
    () => new Map(props.assets.map((asset) => [asset.id, createRef<ScenePlaneHandle>()])),
    [props.assets],
  );
  const textures = useTextureWindow(windowIds, props.assets, props.onTextureState, props.textureRetryNonce);
  const contextCleanupRef = useRef<(() => void) | null>(null);
  const { onContextState } = props;
  const handleCreated = useCallback(({ gl }: { gl: import("three").WebGLRenderer }) => {
    gl.outputColorSpace = SRGBColorSpace;
    gl.toneMapping = NoToneMapping;
    gl.setClearColor(0xfafafa, 1);
    const canvas = gl.domElement;
    canvas.setAttribute("aria-hidden", "true");
    canvas.setAttribute("data-scene-renderer", props.worldSpace ? "world-perspective" : "projected-orthographic");
    const lost = (event: Event) => {
      event.preventDefault();
      onContextState(true);
    };
    const restored = () => onContextState(false);
    canvas.addEventListener("webglcontextlost", lost, false);
    canvas.addEventListener("webglcontextrestored", restored, false);
    contextCleanupRef.current = () => {
      canvas.removeEventListener("webglcontextlost", lost, false);
      canvas.removeEventListener("webglcontextrestored", restored, false);
    };
  }, [onContextState, props.worldSpace]);

  useEffect(() => () => contextCleanupRef.current?.(), []);

  return (
    <Canvas
      aria-hidden="true"
      orthographic={!props.worldSpace}
      camera={props.worldSpace
        ? { far: 40, fov: 35, near: 0.1, position: [0, 0, 8] }
        : { far: 10, near: 0.1, position: [0, 0, 2], zoom: 1 }}
      dpr={[1, 1.25]}
      frameloop="always"
      gl={{ alpha: false, antialias: true, powerPreference: "high-performance", premultipliedAlpha: false }}
      onCreated={handleCreated}
    >
      <color attach="background" args={["#fafafa"]} />
      {props.assets.map((asset) => props.worldSpace ? (
        <WorldScenePlane key={asset.id} ref={planeRefs.get(asset.id)} texture={textures.get(asset.id) ?? null} />
      ) : (
        <ScenePlane key={asset.id} ref={planeRefs.get(asset.id)} asset={asset} texture={textures.get(asset.id) ?? null} />
      ))}
      <SceneField
        activeId={props.activeId}
        assets={props.assets}
        onFrameState={props.onFrameState}
        onWindowChange={setWindowIds}
        planeRefs={planeRefs}
        progress={props.progress}
        reportEveryFrame={props.frozen}
        staticWindowIds={staticWindowIds}
        selectedId={props.selectedId}
        viewportHeight={props.viewportHeight}
        viewportKey={props.viewportKey}
        viewportWidth={props.viewportWidth}
      />
    </Canvas>
  );
}
