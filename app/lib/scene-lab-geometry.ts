import geometrySource from "../../artifacts/reference-audit/reference-geometry.json";
import { buildTrackNavigation, type NavigationSample } from "./scene-lab-navigation";

export const SCENE_ANCHORS = ["p00", "p20", "p40", "p60", "p80", "p100"] as const;
export type SceneAnchor = (typeof SCENE_ANCHORS)[number];
export type ViewportKey = "1440x900" | "1280x800" | "1024x768" | "390x844";
export type SceneRole = "near" | "focal" | "adjacent" | "mid" | "far";
export type Point = readonly [number, number];

type SourcePlane = {
  aspect_class: "portrait" | "square" | "landscape";
  dominant: boolean;
  focal: boolean;
  materially_visible: boolean;
  projected_corners_normalized: Point[];
  projected_pixel_aspect_ratio: number;
  role: SceneRole;
  slot_id: string;
  track_id: string;
  viewport_edges_intersected: string[];
  z_rank: number;
};

type SourceViewport = {
  anchors: Record<SceneAnchor, { planes: SourcePlane[]; source_capture: string }>;
  height: number;
  materially_visible_plane_count: number;
  width: number;
};

type GeometrySource = {
  viewports: Record<ViewportKey, SourceViewport>;
};

const GEOMETRY = geometrySource as GeometrySource;
const ANCHOR_PROGRESS = [0, 0.2, 0.4, 0.6, 0.8, 1] as const;

export type ScenePlaneState = {
  aspectClass: SourcePlane["aspect_class"];
  corners: Point[];
  dominant: boolean;
  focal: boolean;
  opacity: number;
  projectedAspect: number;
  role: SceneRole;
  slotId: string;
  trackId: string;
  viewportEdges: string[];
  zRank: number;
};

export function anchorToProgress(anchor: SceneAnchor) {
  return ANCHOR_PROGRESS[SCENE_ANCHORS.indexOf(anchor)];
}

export function isSceneAnchor(value: string | null): value is SceneAnchor {
  return SCENE_ANCHORS.includes(value as SceneAnchor);
}

export function getViewportKey(width: number, height: number): ViewportKey {
  const required: Array<[ViewportKey, number, number]> = [
    ["1440x900", 1440, 900],
    ["1280x800", 1280, 800],
    ["1024x768", 1024, 768],
    ["390x844", 390, 844],
  ];
  let best = required[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of required) {
    const distance = Math.hypot((width - candidate[1]) / candidate[1], (height - candidate[2]) / candidate[2]);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best[0];
}

function roleOpacity(role: SceneRole) {
  switch (role) {
    case "focal": return 0.99;
    case "near": return 0.9;
    case "adjacent": return 0.86;
    case "mid": return 0.64;
    case "far": return 0.44;
  }
}

function toPlaneState(plane: SourcePlane): ScenePlaneState {
  return {
    aspectClass: plane.aspect_class,
    corners: plane.projected_corners_normalized.map(([x, y]) => [x, y]),
    dominant: plane.dominant,
    focal: plane.focal,
    opacity: roleOpacity(plane.role),
    projectedAspect: plane.projected_pixel_aspect_ratio,
    role: plane.role,
    slotId: plane.slot_id,
    trackId: plane.track_id,
    viewportEdges: [...plane.viewport_edges_intersected],
    zRank: plane.z_rank,
  };
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function smoothstep(t: number) {
  return t * t * (3 - 2 * t);
}

function transformCorners(corners: Point[], dx: number, dy: number, scale: number) {
  const centerX = corners.reduce((sum, point) => sum + point[0], 0) / corners.length;
  const centerY = corners.reduce((sum, point) => sum + point[1], 0) / corners.length;
  return corners.map(([x, y]) => [centerX + (x - centerX) * scale + dx, centerY + (y - centerY) * scale + dy] as Point);
}

function interpolateShared(a: ScenePlaneState, b: ScenePlaneState, t: number): ScenePlaneState {
  const eased = smoothstep(t);
  const nearest = t < 0.5 ? a : b;
  return {
    ...nearest,
    corners: a.corners.map(([x, y], index) => [
      lerp(x, b.corners[index][0], eased),
      lerp(y, b.corners[index][1], eased),
    ] as Point),
    opacity: lerp(a.opacity, b.opacity, eased),
    projectedAspect: lerp(a.projectedAspect, b.projectedAspect, eased),
    zRank: lerp(a.zRank, b.zRank, eased),
  };
}

// Anchor states derive from static JSON and are never mutated by consumers,
// so each viewport/anchor pair is materialized once.
const anchorPlaneCache = new Map<string, ScenePlaneState[]>();

export function getAnchorPlanes(viewportKey: ViewportKey, anchor: SceneAnchor) {
  const cacheKey = `${viewportKey}|${anchor}`;
  let planes = anchorPlaneCache.get(cacheKey);
  if (!planes) {
    planes = GEOMETRY.viewports[viewportKey].anchors[anchor].planes.map(toPlaneState);
    anchorPlaneCache.set(cacheKey, planes);
  }
  return planes;
}

export function getInterpolatedPlanes(viewportKey: ViewportKey, rawProgress: number) {
  const progress = Math.max(0, Math.min(1, rawProgress));
  const exactIndex = ANCHOR_PROGRESS.findIndex((value) => Math.abs(value - progress) < 0.000001);
  if (exactIndex >= 0) return getAnchorPlanes(viewportKey, SCENE_ANCHORS[exactIndex]);

  const segment = Math.min(4, Math.floor(progress * 5));
  const local = (progress - ANCHOR_PROGRESS[segment]) / 0.2;
  const aPlanes = getAnchorPlanes(viewportKey, SCENE_ANCHORS[segment]);
  const bPlanes = getAnchorPlanes(viewportKey, SCENE_ANCHORS[segment + 1]);
  const aByTrack = new Map(aPlanes.map((plane) => [plane.trackId, plane]));
  const bByTrack = new Map(bPlanes.map((plane) => [plane.trackId, plane]));
  const ids = new Set([...aByTrack.keys(), ...bByTrack.keys()]);
  const states: ScenePlaneState[] = [];

  for (const trackId of ids) {
    const a = aByTrack.get(trackId);
    const b = bByTrack.get(trackId);
    if (a && b) {
      states.push(interpolateShared(a, b, local));
    } else if (a) {
      states.push({
        ...a,
        corners: transformCorners(a.corners, -0.16 * smoothstep(local), 0.15 * smoothstep(local), 1 + 0.08 * smoothstep(local)),
        opacity: a.opacity * (1 - smoothstep(local)),
        zRank: lerp(a.zRank, 1, smoothstep(local)),
      });
    } else if (b) {
      const inverse = 1 - smoothstep(local);
      states.push({
        ...b,
        corners: transformCorners(b.corners, 0.09 * inverse, -0.08 * inverse, 1 - 0.16 * inverse),
        opacity: b.opacity * smoothstep(local),
        zRank: lerp(-11, b.zRank, smoothstep(local)),
      });
    }
  }
  return states.sort((left, right) => left.zRank - right.zRank || left.trackId.localeCompare(right.trackId));
}

export function getTextureWindow(viewportKey: ViewportKey, progress: number) {
  return getInterpolatedPlanes(viewportKey, progress)
    .filter((plane) => plane.opacity > 0.015)
    .map((plane) => plane.trackId)
    .sort();
}

export function applySelection(
  planes: ScenePlaneState[],
  selectedId: string | null,
  selectionPhase: number,
  viewportWidth: number,
  viewportHeight: number,
): ScenePlaneState[] {
  if (!selectedId || selectionPhase <= 0) return planes;
  const eased = smoothstep(selectionPhase);
  return planes.map((plane): ScenePlaneState => {
    if (plane.trackId !== selectedId) {
      return { ...plane, opacity: plane.opacity * (1 - eased * 0.84) };
    }
    const width = viewportWidth <= 520 ? 0.72 : 0.42;
    const height = Math.min(0.76, (width * viewportWidth) / (plane.projectedAspect * viewportHeight));
    const target: Point[] = [
      [0.5 - width / 2, 0.52 - height / 2],
      [0.5 + width / 2, 0.52 - height / 2],
      [0.5 + width / 2, 0.52 + height / 2],
      [0.5 - width / 2, 0.52 + height / 2],
    ];
    return {
      ...plane,
      corners: plane.corners.map(([x, y], index) => [
        lerp(x, target[index][0], eased),
        lerp(y, target[index][1], eased),
      ] as Point),
      dominant: true,
      focal: true,
      opacity: lerp(plane.opacity, 1, eased),
      role: "focal",
      zRank: lerp(plane.zRank, 2, eased),
    };
  });
}

export function getFocalTrackId(viewportKey: ViewportKey, progress: number) {
  const planes = getInterpolatedPlanes(viewportKey, progress);
  const focal = planes.reduce((best, plane) => {
    if (!best) return plane;
    return Math.abs(plane.zRank + 2) < Math.abs(best.zRank + 2) ? plane : best;
  }, null as ScenePlaneState | null);
  return focal?.trackId ?? "track-03";
}

export function getReferencePath(viewportKey: ViewportKey, anchor: SceneAnchor) {
  return GEOMETRY.viewports[viewportKey].anchors[anchor].source_capture;
}

export function getViewportDimensions(viewportKey: ViewportKey) {
  const viewport = GEOMETRY.viewports[viewportKey];
  return { height: viewport.height, width: viewport.width };
}

export function getTrackNavigation(viewportKey: ViewportKey) {
  const samples: NavigationSample[] = SCENE_ANCHORS.flatMap((anchor) => {
    const progress = anchorToProgress(anchor);
    return getAnchorPlanes(viewportKey, anchor).map((plane) => ({
      dominant: plane.dominant,
      focal: plane.focal,
      progress,
      role: plane.role,
      trackId: plane.trackId,
      zRank: plane.zRank,
    }));
  });
  return buildTrackNavigation(samples);
}
