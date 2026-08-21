/**
 * Screen-space projection of the scene wheel's card quads — the same curve
 * model and camera the three.js scene uses, run as plain math so the DOM
 * placeholder layer (dithered thumbnails in SceneWheelV2) can stand exactly
 * where each card will render. No GL, no renderer: three's vector/camera
 * classes only.
 *
 * Placement is a full projective map: a perspective camera imaging a planar
 * card is a homography, so mapping the element's rect onto the four
 * projected corners (CSS matrix3d) reproduces the card's outline exactly —
 * foreshortening included — rather than approximating it with a
 * parallelogram.
 */

import { PerspectiveCamera, Vector3 } from "three";
import {
  getSceneWheelPose,
  SCENE_WHEEL_CAMERA,
  SCENE_WHEEL_MOBILE_CAMERA,
} from "./curve-model.ts";

/** Must match useMobileSceneFraming in SceneWheelCanvas. */
export const MOBILE_FRAMING_QUERY = "(max-width: 700px) and (max-aspect-ratio: 18 / 25)";

// Mirrors SceneCard exactly: the VISIBLE photo is not the card box's center
// plane — it is an inset plane pushed toward the camera along the card's
// local +Z (mesh position [0, 0, CARD_DEPTH / 2 + 0.001], planeGeometry
// [width - IMAGE_INSET, CARD_HEIGHT - IMAGE_INSET]). Projecting the box's
// mid-plane instead left the placeholders a few pixels off, growing with
// proximity to the camera.
const CARD_HEIGHT = 2.52;
const CARD_DEPTH = 0.045;
const IMAGE_INSET = 0.018;
const IMAGE_PLANE_Z = CARD_DEPTH / 2 + 0.001;

export type Point = { x: number; y: number };

export type PlacedCard = {
  /** Layout box size in px; the transform maps this box onto the quad. */
  width: number;
  height: number;
  /** CSS transform (matrix3d homography incl. translation; origin 0 0). */
  transform: string;
  /** Projected corners, exported for tests and debugging overlays. */
  corners: { tl: Point; tr: Point; br: Point; bl: Point };
  opacity: number;
  z: number;
  /** Rail-relative slot (negative = the wrap-around card easing in behind
   * the viewer's shoulder). */
  relative: number;
};

/**
 * Homography mapping the rect (0,0)-(w,h) onto the quad tl,tr,br,bl,
 * expressed as a CSS matrix3d (Heckbert's unit-square-to-quad mapping,
 * rescaled to the element box). Returns null when the quad degenerates.
 */
export function quadTransform(
  tl: Point,
  tr: Point,
  br: Point,
  bl: Point,
  w: number,
  h: number,
): string | null {
  const sx = tl.x - tr.x + br.x - bl.x;
  const sy = tl.y - tr.y + br.y - bl.y;
  const dx1 = tr.x - br.x;
  const dy1 = tr.y - br.y;
  const dx2 = bl.x - br.x;
  const dy2 = bl.y - br.y;
  const den = dx1 * dy2 - dx2 * dy1;
  if (!Number.isFinite(den) || Math.abs(den) < 1e-9) return null;
  const g = (sx * dy2 - dx2 * sy) / den;
  const hh = (dx1 * sy - sx * dy1) / den;
  const a = tr.x - tl.x + g * tr.x;
  const b = bl.x - tl.x + hh * bl.x;
  const c = tl.x;
  const d = tr.y - tl.y + g * tr.y;
  const e = bl.y - tl.y + hh * bl.y;
  const f = tl.y;
  const m = [a / w, d / w, 0, g / w, b / h, e / h, 0, hh / h, 0, 0, 1, 0, c, f, 0, 1];
  if (!m.every(Number.isFinite)) return null;
  return `matrix3d(${m.map((v) => v.toPrecision(8)).join(", ")})`;
}

export function projectCardRects(
  count: number,
  progress: number,
  viewportWidth: number,
  viewportHeight: number,
  mobileFraming: boolean,
  aspects: number[],
): PlacedCard[] {
  if (count <= 0 || viewportWidth <= 0 || viewportHeight <= 0) return [];
  const spec = mobileFraming ? SCENE_WHEEL_MOBILE_CAMERA : SCENE_WHEEL_CAMERA;
  const camera = new PerspectiveCamera(spec.fov, viewportWidth / viewportHeight, spec.near, spec.far);
  camera.position.set(...spec.position);
  // R3F orients its default camera toward the origin (measured empirically:
  // without this the whole placeholder field sat ~16px low — the 0.69°
  // downward pitch from y=0.15 across a 38° fov). Keep in lockstep with the
  // live scene's camera orientation.
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);

  const toScreen = (v: Vector3): Point => {
    const ndc = v.clone().project(camera);
    return { x: ((ndc.x + 1) / 2) * viewportWidth, y: ((1 - ndc.y) / 2) * viewportHeight };
  };

  const out: PlacedCard[] = [];
  for (let index = 0; index < count; index += 1) {
    const pose = getSceneWheelPose(index, count, progress);
    if (pose.opacity <= 0.02) continue;
    const aspect = Math.max(0.72, Math.min(1.65, aspects[index] ?? 4 / 3));
    const hw = ((CARD_HEIGHT * aspect - IMAGE_INSET) * pose.scale) / 2;
    const hh = ((CARD_HEIGHT - IMAGE_INSET) * pose.scale) / 2;
    const planeZ = IMAGE_PLANE_Z * pose.scale;
    // Pose position/quaternion come from shared scratch objects — consume
    // them fully before the next getSceneWheelPose call.
    const corner = (x: number, y: number) =>
      toScreen(new Vector3(x, y, planeZ).applyQuaternion(pose.quaternion).add(pose.position));
    const tl = corner(-hw, hh);
    const tr = corner(hw, hh);
    const br = corner(hw, -hh);
    const bl = corner(-hw, -hh);
    const width = Math.hypot(tr.x - tl.x, tr.y - tl.y);
    const height = Math.hypot(bl.x - tl.x, bl.y - tl.y);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 2 || height < 2) continue;
    const transform = quadTransform(tl, tr, br, bl, width, height);
    if (!transform) continue;
    out.push({
      width,
      height,
      transform,
      corners: { tl, tr, br, bl },
      opacity: pose.opacity,
      // Lower `relative` = nearer the viewer = stacked on top.
      z: Math.max(1, Math.round(500 - pose.relative * 10)),
      relative: pose.relative,
    });
  }
  return out;
}
