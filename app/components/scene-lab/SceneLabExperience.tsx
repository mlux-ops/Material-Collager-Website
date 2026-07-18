"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  adaptCompletedCollages,
  getLibraryCollageNavigationTarget,
  getLibraryPresentationOffset,
  normalizeLibraryCollageRecords,
  removeLibraryCollageRecord,
  parseLibraryPayload,
  type LibraryCollageRecord,
  type SceneLabLibraryState,
} from "@/app/lib/scene-lab-assets";
import { getFocalTrackId, getReferencePath, getTrackNavigation, getViewportKey, type ScenePlaneState } from "@/app/lib/scene-lab-geometry";
import { nearestReachableTrack } from "@/app/lib/scene-lab-navigation";
import { beginPointerDrag, finishPointerDrag, IDLE_DRAG_STATE, movePointerDrag, type PointerFinishReason } from "@/app/lib/scene-lab-pointer";
import { useSceneLabQA } from "@/app/hooks/useSceneLabQA";
import { useVirtualProgress } from "@/app/hooks/useVirtualProgress";
import { SceneLabChrome, type SceneLabView } from "./SceneLabChrome";
import { SceneLabIndex } from "./SceneLabIndex";
import type { TextureLoadState } from "./SceneLabCanvas";
import styles from "@/app/scene-lab/scene-lab.module.css";

const SceneLabCanvas = dynamic(() => import("./SceneLabCanvas"), { ssr: false });

type SceneLabQAExport = {
  anchor: string | null;
  content: {
    actualCollageCount: number;
    deterministicLabRepetition: boolean;
    libraryMessage: string | null;
    libraryState: SceneLabLibraryState;
    persistedCollageCount: number;
    source: string;
    uniqueCollageIds: string[];
  };
  deterministic: true;
  geometryHash: string;
  planeCount: number;
  planes: Array<{
    cornersNormalized: ScenePlaneState["corners"];
    cornersPixels: Array<[number, number]>;
    collageId: string;
    focal: boolean;
    instanceId: string;
    opacity: number;
    role: string;
    sourceKind: string;
    trackId: string;
    viewportEdges: string[];
    zRank: number;
  }>;
  policies: {
    alpha: string;
    depthTest: true;
    depthWrite: false;
    rendererOutput: string;
    toneMapping: string;
  };
  performance: {
    frameMaxMs: number | null;
    frameP95Ms: number | null;
    frameSamples: number;
    geometries: number;
    over100Ms: number;
    rendererDpr: number;
    textureExpected: number;
    textureFailed: number;
    textureFailedTrackIds: string[];
    textureLoaded: number;
    texturePending: number;
    textures: number;
  };
  progress: number;
  referencePath: string | null;
  viewport: { height: number; key: string; width: number };
};

const EMPTY_TEXTURE_STATE: TextureLoadState = {
  expected: 0,
  failed: 0,
  failedTrackIds: [],
  loaded: 0,
  pending: 0,
  ready: false,
};

declare global {
  interface Window {
    __SCENE_LAB_QA__?: SceneLabQAExport;
  }
}

function hashString(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

export default function SceneLabExperience({ surface = "lab" }: { surface?: "lab" | "library" }) {
  const productionLibrary = surface === "library";
  const qa = useSceneLabQA();
  const reducedMotion = useReducedMotion();
  const shellRef = useRef<HTMLElement>(null);
  const buttonsRef = useRef(new Map<string, HTMLButtonElement>());
  const viewRef = useRef<SceneLabView>("scene");
  const dragRef = useRef(IDLE_DRAG_STATE);
  const focusLockRef = useRef<string | null>(null);
  const pendingSelectionRef = useRef<string | null>(null);
  const suppressClickRef = useRef(false);
  const visiblePlanesRef = useRef<ScenePlaneState[]>([]);
  const libraryRequestRef = useRef(0);
  const pendingPresentationSelectionRef = useRef<string | null>(null);
  const presentationOffsetRef = useRef(0);
  const [records, setRecords] = useState<LibraryCollageRecord[]>([]);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [libraryState, setLibraryState] = useState<SceneLabLibraryState>("loading");
  const [libraryMessage, setLibraryMessage] = useState("");
  const [presentationOffset, setPresentationOffset] = useState(0);
  const catalog = useMemo(
    () => adaptCompletedCollages(records, { allowLabFixtures: !productionLibrary, presentationOffset }),
    [presentationOffset, productionLibrary, records],
  );
  const assets = useMemo(() => qa.failedTextureTrack
    ? catalog.items.map((asset) => asset.id === qa.failedTextureTrack
      ? { ...asset, url: "/scene-lab/collages/__missing-preview-for-qa__.png" }
      : asset)
    : catalog.items, [catalog.items, qa.failedTextureTrack]);
  const assetById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);
  const [viewport, setViewport] = useState({ height: 900, width: 1440 });
  const viewportKey = getViewportKey(viewport.width, viewport.height);
  const navigation = useMemo(() => getTrackNavigation(viewportKey), [viewportKey]);
  const navigationById = useMemo(() => new Map(navigation.map((target) => [target.trackId, target])), [navigation]);
  const reachableAssets = useMemo(() => navigation.map((target) => assetById.get(target.trackId)).filter((asset): asset is NonNullable<typeof asset> => Boolean(asset)), [assetById, navigation]);
  const [view, setView] = useState<SceneLabView>("scene");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [activeId, setActiveId] = useState(() => getFocalTrackId("1440x900", qa.progress));
  const [textureState, setTextureState] = useState<TextureLoadState>(EMPTY_TEXTURE_STATE);
  const [textureRetryNonce, setTextureRetryNonce] = useState(0);
  const [contextLost, setContextLost] = useState(false);
  const [webGLAvailable] = useState(() => {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  });
  const fallback = !webGLAvailable || contextLost;
  const effectiveView: SceneLabView = fallback ? "index" : view;
  const progress = useVirtualProgress({ frozen: qa.frozen, initialProgress: qa.progress, reducedMotion });

  const loadCompletedCollages = useCallback(async (signal?: AbortSignal) => {
      const requestId = ++libraryRequestRef.current;
      const setFailure = (state: Extract<SceneLabLibraryState, "failed" | "malformed">, message: string) => {
        if (signal?.aborted || requestId !== libraryRequestRef.current) return;
        setRecords([]);
        setLibraryState(state);
        setLibraryMessage(message);
        setCatalogLoaded(true);
      };
      let response: Response;
      try {
        response = await fetch("/api/library", { cache: "no-store", signal });
      } catch (error) {
        setFailure("failed", error instanceof Error ? error.message : "Library request failed.");
        return;
      }
      if (!response.ok) {
        setFailure("failed", `Library request failed with HTTP ${response.status}.`);
        return;
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        setFailure("malformed", "Library response was not valid JSON.");
        return;
      }
      const parsed = parseLibraryPayload(payload);
      if (!parsed.valid) {
        setFailure("malformed", parsed.message);
        return;
      }
      if (signal?.aborted || requestId !== libraryRequestRef.current) return;
      const nextRecords = normalizeLibraryCollageRecords(parsed.records);
      const nextCatalog = adaptCompletedCollages(nextRecords, { allowLabFixtures: !productionLibrary, presentationOffset: presentationOffsetRef.current });
      setRecords(nextRecords);
      setLibraryState(nextCatalog.actualCollageCount > 0 ? "populated" : "empty");
      setLibraryMessage(nextCatalog.actualCollageCount > 0
        ? `Loaded ${nextCatalog.actualCollageCount} completed Library collage${nextCatalog.actualCollageCount === 1 ? "" : "s"}.`
        : productionLibrary
          ? "Your finished collages will live here."
          : "Library is empty; using four user-provided completed lab collages.");
      setCatalogLoaded(true);
  }, [productionLibrary]);

  useEffect(() => {
    presentationOffsetRef.current = presentationOffset;
  }, [presentationOffset]);

  useEffect(() => {
    const controller = new AbortController();
    void loadCompletedCollages(controller.signal);
    const interval = window.setInterval(() => void loadCompletedCollages(), 30_000);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [loadCompletedCollages]);

  useLayoutEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const update = () => setViewport({ height: shell.clientHeight, width: shell.clientWidth });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(shell);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (navigationById.has(activeId)) return;
    const replacement = nearestReachableTrack(navigation, activeId);
    if (!replacement) return;
    const trackControlHadFocus = document.activeElement?.getAttribute("data-track-control") === "true";
    focusLockRef.current = replacement.trackId;
    pendingSelectionRef.current = null;
    const frame = requestAnimationFrame(() => {
      setSelectedId(null);
      setHoveredId(null);
      setActiveId(replacement.trackId);
      progress.jumpTo(replacement.progress);
      if (trackControlHadFocus) buttonsRef.current.get(replacement.trackId)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [activeId, navigation, navigationById, progress]);

  useEffect(() => {
    viewRef.current = effectiveView;
    if (effectiveView === "index") {
      for (const button of buttonsRef.current.values()) {
        button.removeAttribute("style");
        button.parentElement?.removeAttribute("style");
      }
    }
  }, [effectiveView]);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const onWheel = (event: WheelEvent) => {
      if (qa.frozen || selectedId || viewRef.current !== "scene") return;
      event.preventDefault();
      focusLockRef.current = null;
      const modeScale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? viewport.height : 1;
      const dominant = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      progress.impulse(dominant * modeScale, viewport.height);
    };
    shell.addEventListener("wheel", onWheel, { passive: false });
    return () => shell.removeEventListener("wheel", onWheel);
  }, [progress, qa.frozen, selectedId, viewport.height]);

  const setButtonRef = useCallback((id: string) => (node: HTMLButtonElement | null) => {
    if (node) buttonsRef.current.set(id, node);
    else buttonsRef.current.delete(id);
  }, []);

  const focusTrack = useCallback((id: string, focusDom = true) => {
    const target = navigationById.get(id);
    if (!target) return false;
    focusLockRef.current = id;
    setActiveId(id);
    progress.jumpTo(target.progress);
    if (focusDom) requestAnimationFrame(() => buttonsRef.current.get(id)?.focus({ preventScroll: true }));
    return true;
  }, [navigationById, progress]);

  const moveFocus = useCallback((fromId: string, delta: number) => {
    const from = Math.max(0, navigation.findIndex((target) => target.trackId === fromId));
    const nextIndex = Math.max(0, Math.min(navigation.length - 1, from + delta));
    const next = navigation[nextIndex];
    if (next) focusTrack(next.trackId);
  }, [focusTrack, navigation]);

  const requestSelection = useCallback((id: string) => {
    if (!focusTrack(id, false)) return;
    pendingSelectionRef.current = id;
    setSelectedId(null);
  }, [focusTrack]);

  const requestProductionCollageSelection = useCallback((collageId: string) => {
    setView("scene");
    const visibleItem = catalog.items.find((item) => item.collageId === collageId);
    if (visibleItem) {
      requestSelection(visibleItem.id);
      return;
    }
    const nextOffset = getLibraryPresentationOffset(catalog.actualRecords, collageId);
    if (nextOffset === null) return;
    pendingPresentationSelectionRef.current = collageId;
    setPresentationOffset(nextOffset);
  }, [catalog.actualRecords, catalog.items, requestSelection]);

  useEffect(() => {
    const pendingCollageId = pendingPresentationSelectionRef.current;
    if (!pendingCollageId) return;
    const visibleItem = catalog.items.find((item) => item.collageId === pendingCollageId);
    if (!visibleItem) return;
    pendingPresentationSelectionRef.current = null;
    requestSelection(visibleItem.id);
  }, [catalog.items, requestSelection]);

  const focusProductionCollage = useCallback((collageId: string) => {
    const visibleItem = catalog.items.find((item) => item.collageId === collageId);
    if (visibleItem) {
      focusTrack(visibleItem.id, false);
      return;
    }
    buttonsRef.current.get(`semantic:${collageId}`)?.focus({ preventScroll: true });
  }, [catalog.items, focusTrack]);

  const handleKeyDown = useCallback((id: string, event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (productionLibrary) {
      const collageId = id.startsWith("semantic:") ? id.slice("semantic:".length) : assetById.get(id)?.collageId;
      if (collageId && catalog.actualRecords.some((record) => record.id === collageId)) {
        const focusByIntent = (intent: Parameters<typeof getLibraryCollageNavigationTarget>[2]) => {
          const next = getLibraryCollageNavigationTarget(catalog.actualRecords, collageId, intent);
          if (next) focusProductionCollage(next.id);
        };
        switch (event.key) {
          case "ArrowLeft": case "ArrowUp": event.preventDefault(); focusByIntent("previous"); return;
          case "ArrowRight": case "ArrowDown": event.preventDefault(); focusByIntent("next"); return;
          case "PageUp": event.preventDefault(); focusByIntent("previousPage"); return;
          case "PageDown": event.preventDefault(); focusByIntent("nextPage"); return;
          case "Home": event.preventDefault(); focusByIntent("first"); return;
          case "End": event.preventDefault(); focusByIntent("last"); return;
          case "Enter": case " ": event.preventDefault(); requestProductionCollageSelection(collageId); return;
          case "Escape": event.preventDefault(); if (selectedId) setSelectedId(null); else if (viewRef.current === "index") setView("scene"); return;
        }
      }
    }
    switch (event.key) {
      case "ArrowLeft": case "ArrowUp": event.preventDefault(); moveFocus(id, -1); break;
      case "ArrowRight": case "ArrowDown": event.preventDefault(); moveFocus(id, 1); break;
      case "PageUp": event.preventDefault(); moveFocus(id, -3); break;
      case "PageDown": event.preventDefault(); moveFocus(id, 3); break;
      case "Home": event.preventDefault(); if (navigation[0]) focusTrack(navigation[0].trackId); break;
      case "End": event.preventDefault(); if (navigation.at(-1)) focusTrack(navigation.at(-1)!.trackId); break;
      case "Enter": case " ": event.preventDefault(); requestSelection(id); break;
      case "Escape":
        event.preventDefault();
        if (selectedId) setSelectedId(null);
        else if (viewRef.current === "index") setView("scene");
        break;
    }
  }, [assetById, catalog.actualRecords, focusProductionCollage, focusTrack, moveFocus, navigation, productionLibrary, requestProductionCollageSelection, requestSelection, selectedId]);

  const handleActivate = useCallback((id: string) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (productionLibrary) setView("scene");
    if (productionLibrary && id.startsWith("semantic:")) {
      requestProductionCollageSelection(id.slice("semantic:".length));
      return;
    }
    requestSelection(id);
  }, [productionLibrary, requestProductionCollageSelection, requestSelection]);

  const handleFrameState = useCallback((planes: ScenePlaneState[], renderedProgress: number, selectionPhase: number) => {
    const visible = planes.filter((plane) => plane.opacity > 0.005);
    visiblePlanesRef.current = visible;
    const pendingSelection = pendingSelectionRef.current;
    if (pendingSelection && visible.some((plane) => plane.trackId === pendingSelection)) {
      pendingSelectionRef.current = null;
      setSelectedId(pendingSelection);
    }
    if (!hoveredId && !selectedId && !focusLockRef.current && document.activeElement?.getAttribute("data-track-control") !== "true") {
      const focal = visible.reduce((best, plane) => !best || Math.abs(plane.zRank + 2) < Math.abs(best.zRank + 2) ? plane : best, null as ScenePlaneState | null);
      if (focal && focal.trackId !== activeId) setActiveId(focal.trackId);
    }
    if (viewRef.current === "scene") {
      const visibleIds = new Set(visible.map((plane) => plane.trackId));
      for (const asset of assets) {
        const button = buttonsRef.current.get(asset.id);
        const item = button?.parentElement;
        const plane = visible.find((candidate) => candidate.trackId === asset.id);
        if (!button || !item) continue;
        if (!plane) {
          item.style.cssText = "display:block;left:-100vw;top:-100vh;width:1px;height:1px;z-index:0";
          continue;
        }
        const xs = plane.corners.map((corner) => corner[0]);
        const ys = plane.corners.map((corner) => corner[1]);
        const left = Math.min(...xs);
        const top = Math.min(...ys);
        const width = Math.max(...xs) - left;
        const height = Math.max(...ys) - top;
        item.style.cssText = `display:block;left:${left * 100}%;top:${top * 100}%;width:${width * 100}%;height:${height * 100}%;z-index:${1100 + Math.round(plane.zRank * 10)}`;
        button.dataset.active = asset.id === activeId ? "true" : "false";
        button.dataset.trackControl = "true";
      }
      for (const [id, button] of buttonsRef.current) {
        // High-frequency scene hit targets intentionally mirror projected canvas bounds.
        // eslint-disable-next-line react-hooks/immutability
        if (!visibleIds.has(id) && button.parentElement) button.parentElement.style.cssText = "display:block;left:-100vw;top:-100vh;width:1px;height:1px;z-index:0";
      }
    }
    if (qa.enabled) {
      const canvas = shellRef.current?.querySelector("canvas");
      const geometryPlanes = visible.map((plane) => ({
        cornersNormalized: plane.corners,
        cornersPixels: plane.corners.map(([x, y]) => [x * viewport.width, y * viewport.height] as [number, number]),
        focal: plane.focal,
        opacity: plane.opacity,
        role: plane.role,
        trackId: plane.trackId,
        viewportEdges: plane.viewportEdges,
        zRank: plane.zRank,
      }));
      const exportPlanes = geometryPlanes.map((plane) => {
        const item = assetById.get(plane.trackId);
        return {
          ...plane,
          collageId: item?.collageId ?? "unknown-collage",
          instanceId: item?.instanceId ?? "unknown-instance",
          sourceKind: item?.sourceKind ?? "unknown-source",
        };
      });
      const payload: SceneLabQAExport = {
        anchor: qa.anchor,
        content: {
          actualCollageCount: catalog.actualCollageCount,
          deterministicLabRepetition: catalog.repetitionRequired,
          libraryMessage: libraryMessage || null,
          libraryState,
          persistedCollageCount: catalog.persistedCollageCount,
          source: catalog.source,
          uniqueCollageIds: [...new Set(assets.map((asset) => asset.collageId))],
        },
        deterministic: true,
        geometryHash: hashString(JSON.stringify(geometryPlanes)),
        planeCount: exportPlanes.length,
        planes: exportPlanes,
        policies: {
          alpha: "opaque renderer, straight-alpha material opacity, premultipliedAlpha false",
          depthTest: true,
          depthWrite: false,
          rendererOutput: "sRGB",
          toneMapping: "none",
        },
        performance: {
          frameMaxMs: canvas?.dataset.frameMaxMs ? Number(canvas.dataset.frameMaxMs) : null,
          frameP95Ms: canvas?.dataset.frameP95Ms ? Number(canvas.dataset.frameP95Ms) : null,
          frameSamples: Number(canvas?.dataset.frameSamples ?? 0),
          geometries: Number(canvas?.dataset.geometryCount ?? 0),
          over100Ms: Number(canvas?.dataset.frameOver100Ms ?? 0),
          rendererDpr: Number(canvas?.dataset.rendererDpr ?? 0),
          textureExpected: textureState.expected,
          textureFailed: textureState.failed,
          textureFailedTrackIds: textureState.failedTrackIds,
          textureLoaded: textureState.loaded,
          texturePending: textureState.pending,
          textures: Number(canvas?.dataset.textureCount ?? 0),
        },
        progress: renderedProgress,
        referencePath: qa.anchor ? getReferencePath(viewportKey, qa.anchor) : null,
        viewport: { height: viewport.height, key: viewportKey, width: viewport.width },
      };
      window.__SCENE_LAB_QA__ = payload;
      const output = document.getElementById("scene-lab-qa-export");
      if (output) output.textContent = JSON.stringify(payload);
      shellRef.current?.setAttribute("data-geometry-hash", payload.geometryHash);
      shellRef.current?.setAttribute("data-progress", renderedProgress.toFixed(6));
      shellRef.current?.setAttribute("data-target-progress", progress.target.current.toFixed(6));
      shellRef.current?.setAttribute("data-velocity", progress.velocity.current.toFixed(6));
      shellRef.current?.setAttribute("data-selection-phase", selectionPhase.toFixed(4));
    }
  }, [activeId, assetById, assets, catalog, hoveredId, libraryMessage, libraryState, progress, qa.anchor, qa.enabled, selectedId, textureState, viewport.height, viewport.width, viewportKey]);

  const handleShellKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    if (selectedId) {
      event.preventDefault();
      setSelectedId(null);
    } else if (viewRef.current === "index") {
      event.preventDefault();
      setView("scene");
    }
  }, [selectedId]);

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (qa.frozen || selectedId || viewRef.current !== "scene") return;
    if (event.target instanceof HTMLElement && event.target.closest("button, a, input, select, textarea")) return;
    focusLockRef.current = null;
    event.currentTarget.setAttribute("data-last-pointer-type", event.pointerType || "unknown");
    dragRef.current = beginPointerDrag(event.pointerId, event.clientY);
    event.currentTarget.setAttribute("data-drag-pointer-id", String(event.pointerId));
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [qa.frozen, selectedId]);

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const movement = movePointerDrag(dragRef.current, event.pointerId, event.clientY);
    if (!movement.handled) return;
    dragRef.current = movement.drag;
    if (movement.drag.moved) progress.impulse(movement.delta * 2.2, viewport.height);
  }, [progress, viewport.height]);

  const finishPointer = useCallback((event: React.PointerEvent<HTMLElement>, reason: PointerFinishReason) => {
    const result = finishPointerDrag(dragRef.current, event.pointerId, reason);
    if (!result.finished) return;
    dragRef.current = result.drag;
    suppressClickRef.current = result.suppressClick;
    if (!result.suppressClick && reason === "pointerup" && viewRef.current === "scene") {
      const bounds = event.currentTarget.getBoundingClientRect();
      const point: [number, number] = [(event.clientX - bounds.left) / bounds.width, (event.clientY - bounds.top) / bounds.height];
      const hit = [...visiblePlanesRef.current]
        .toSorted((left, right) => right.zRank - left.zRank)
        .find((plane) => {
          const xs = plane.corners.map((corner) => corner[0]);
          const ys = plane.corners.map((corner) => corner[1]);
          return point[0] >= Math.min(...xs) && point[0] <= Math.max(...xs)
            && point[1] >= Math.min(...ys) && point[1] <= Math.max(...ys);
        });
      if (hit) requestSelection(hit.trackId);
    }
    event.currentTarget.setAttribute("data-drag-pointer-id", "-1");
    event.currentTarget.setAttribute("data-last-pointer-finish", reason);
    if (reason !== "lostpointercapture" && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, [requestSelection]);

  const handleTextureState = useCallback((next: TextureLoadState) => {
    setTextureState((current) => current.expected === next.expected
      && current.loaded === next.loaded
      && current.failed === next.failed
      && current.pending === next.pending
      && current.failedTrackIds.join("|") === next.failedTrackIds.join("|")
      ? current
      : next);
  }, []);

  const productionEmpty = productionLibrary && catalogLoaded && catalog.actualCollageCount === 0;
  const ready = productionEmpty || (catalogLoaded && textureState.ready && !fallback);
  const failedTextureIds = useMemo(() => new Set(textureState.failedTrackIds), [textureState.failedTrackIds]);
  const semanticAssets = useMemo(() => {
    if (!productionLibrary) return reachableAssets;
    const visibleByCollageId = new Map(catalog.items.map((asset) => [asset.collageId, asset]));
    return catalog.actualRecords.map((record, index) => visibleByCollageId.get(record.id) ?? {
      accessibleName: `${record.title}, completed finish collage`,
      collageId: record.id,
      cropAnchor: [0.5, 0.5] as const,
      id: `semantic:${record.id}`,
      instanceId: `semantic:${record.id}`,
      instanceLabel: "Library finish collage",
      repeated: false,
      route: "/",
      sequenceIndex: index + 1,
      sourceKind: "library-record" as const,
      title: record.title,
      url: record.imageUrl,
    });
  }, [catalog.actualRecords, catalog.items, productionLibrary, reachableAssets]);
  const activeItem = assetById.get(selectedId ?? activeId);
  const selectedRecord = useMemo(() => {
    const collageId = assetById.get(selectedId ?? "")?.collageId;
    return records.find((record) => record.id === collageId) ?? null;
  }, [assetById, records, selectedId]);
  const activeTitle = activeItem
    ? `${activeItem.title} · ${activeItem.instanceLabel}`
    : "Finish collage";
  const statusText = fallback
    ? "WebGL unavailable. Finish collage Index remains available."
    : !catalogLoaded
      ? "Loading completed finish collages"
      : `Loading finish collage field ${textureState.loaded + textureState.failed}/${textureState.expected}`;

  const retryLibrary = () => {
    setCatalogLoaded(false);
    setLibraryState("loading");
    setLibraryMessage("");
    void loadCompletedCollages();
  };

  const removeFromLibrary = async () => {
    if (!selectedRecord) return;
    try {
      const response = await fetch(`/api/library/${encodeURIComponent(selectedRecord.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visible: false }),
      });
      const payload = await response.json().catch(() => null) as { error?: string; ok?: boolean } | null;
      if (!response.ok || !payload?.ok) {
        setLibraryMessage(payload?.error || "The collage could not be removed.");
        setLibraryState("failed");
        return;
      }
      const nextRecords = removeLibraryCollageRecord(records, selectedRecord.id);
      const nextCatalog = adaptCompletedCollages(nextRecords, { allowLabFixtures: false, presentationOffset });
      setRecords(nextRecords);
      setLibraryState(nextCatalog.actualCollageCount > 0 ? "populated" : "empty");
      setLibraryMessage(nextCatalog.actualCollageCount > 0
        ? `Loaded ${nextCatalog.actualCollageCount} completed Library collage${nextCatalog.actualCollageCount === 1 ? "" : "s"}.`
        : "Your finished collages will live here.");
      setSelectedId(null);
      setActiveId(nextRecords.length ? "track-01" : getFocalTrackId(viewportKey, qa.progress));
    } catch (error) {
      setLibraryMessage(error instanceof Error ? error.message : "The collage could not be removed.");
      setLibraryState("failed");
    }
  };

  return (
    <main
      ref={shellRef}
      className={styles.shell}
      data-qa={qa.enabled ? "true" : "false"}
      data-ready={ready ? "true" : "false"}
      data-actual-collage-count={catalog.actualCollageCount}
      data-catalog-source={catalog.source}
      data-library-message={libraryMessage || undefined}
      data-library-state={libraryState}
      data-lab-repetition={catalog.repetitionRequired ? "true" : "false"}
      data-persisted-collage-count={catalog.persistedCollageCount}
      data-scene-renderer={qa.worldSpace && !productionLibrary ? "world-perspective" : "projected-orthographic"}
      data-texture-failed={textureState.failed}
      data-texture-loaded={textureState.loaded}
      data-texture-pending={textureState.pending}
      data-view={effectiveView}
      onLostPointerCapture={(event) => finishPointer(event, "lostpointercapture")}
      onPointerCancel={(event) => finishPointer(event, "pointercancel")}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(event) => finishPointer(event, "pointerup")}
      onKeyDown={handleShellKeyDown}
    >
      <div className={styles.canvasLayer} data-hidden={effectiveView === "index" || fallback || productionEmpty ? "true" : "false"}>
        {webGLAvailable && catalogLoaded && !productionEmpty ? (
          <SceneLabCanvas
            activeId={hoveredId ?? activeId}
            assets={assets}
            frozen={qa.frozen}
            initialProgress={qa.progress}
            onContextState={setContextLost}
            onFrameState={handleFrameState}
            onTextureState={handleTextureState}
            progress={progress}
            selectedId={selectedId}
            textureRetryNonce={textureRetryNonce}
            viewportHeight={viewport.height}
            viewportKey={viewportKey}
            viewportWidth={viewport.width}
            worldSpace={qa.worldSpace && !productionLibrary}
          />
        ) : null}
      </div>
      <SceneLabChrome active={productionLibrary ? "library" : undefined} homeHref={productionLibrary ? "/" : "/scene-lab"} view={effectiveView} onViewChange={(nextView) => { focusLockRef.current = null; pendingSelectionRef.current = null; setSelectedId(null); setView(nextView); }} />
      {productionEmpty ? (
        <section className={styles.productionState} aria-live="polite">
          <p>{libraryState === "failed" || libraryState === "malformed" ? libraryMessage : "Your finished collages will live here."}</p>
          <a href="/generator">OPEN GENERATOR</a>
          {(libraryState === "failed" || libraryState === "malformed") ? <button type="button" onClick={retryLibrary}>RETRY</button> : null}
        </section>
      ) : (
        <SceneLabIndex
          activeId={activeId}
          assets={semanticAssets}
          buttonRef={setButtonRef}
          failedTextureIds={failedTextureIds}
          onActivate={handleActivate}
          onFocus={(id) => {
            if (productionLibrary && id.startsWith("semantic:")) focusProductionCollage(id.slice("semantic:".length));
            else focusTrack(id, false);
            setHoveredId(null);
          }}
          onHover={(id) => { if (id) { focusLockRef.current = null; setActiveId(id); } setHoveredId(id); }}
          onKeyDown={handleKeyDown}
          view={effectiveView}
        />
      )}
      <p className={styles.activeTitle} data-selected={selectedId ? "true" : "false"} aria-hidden="true">{activeTitle}</p>
      {reducedMotion ? (
        <div className={styles.reducedControls} aria-label="Reduced motion finish collage controls">
          <button type="button" onClick={() => moveFocus(activeId, -1)} aria-label="Previous finish collage">PREV</button>
          <button type="button" onClick={() => moveFocus(activeId, 1)} aria-label="Next finish collage">NEXT</button>
        </div>
      ) : null}
      {!productionLibrary && (libraryState === "failed" || libraryState === "malformed") ? (
        <p className={styles.catalogNotice} role="status">
          {libraryState === "failed" ? "LIBRARY CONNECTION FAILED." : "LIBRARY RESPONSE INVALID."} USING FOUR USER-PROVIDED COMPLETED LAB COLLAGES. {libraryMessage}
        </p>
      ) : null}
      {textureState.failed > 0 ? (
        <p className={styles.textureNotice} role="status">
          {textureState.failed} COLLAGE PREVIEW{textureState.failed === 1 ? "" : "S"} UNAVAILABLE. A NEUTRAL PLACEHOLDER IS SHOWN.
          <button className={styles.retryTextures} type="button" onClick={() => setTextureRetryNonce((value) => value + 1)}>RETRY</button>
        </p>
      ) : null}
      {!ready ? <p className={styles.loading} role="status">{statusText}</p> : null}
      {selectedId && !productionLibrary ? <button className={styles.cancelSelection} type="button" onClick={() => setSelectedId(null)}>RETURN TO SCENE</button> : null}
      {productionLibrary && selectedRecord ? (
        <div className="collage-viewer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedId(null); }}>
          <section className="collage-viewer" role="dialog" aria-modal="true" aria-labelledby="viewer-title">
            <div className="viewer-toolbar"><div><p>Library</p><h2 id="viewer-title">{selectedRecord.title}</h2></div><button type="button" onClick={() => setSelectedId(null)}>Close</button></div>
            <div className="viewer-image">
              {/* API-backed collages retain their existing direct image endpoint. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={selectedRecord.imageUrl} alt={selectedRecord.title} />
            </div>
            <div className="viewer-meta"><span>{selectedRecord.collageType ?? "Finish collage"}</span><span>{selectedRecord.format ?? "Image"}</span><span>{selectedRecord.renderKind ?? "Final"}</span></div>
            <div className="viewer-actions"><a href={selectedRecord.imageUrl} download={selectedRecord.filename}>Download PNG</a><button type="button" onClick={() => void removeFromLibrary()}>Remove from Library</button></div>
          </section>
        </div>
      ) : null}
      <output id="scene-lab-qa-export" hidden aria-hidden="true" />
    </main>
  );
}
