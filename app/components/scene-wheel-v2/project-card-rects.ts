/**
 * Screen-space projection of the scene wheel's card quads — the same curve
 * model and camera the three.js scene uses, run as plain math so the DOM
 * placeholder layer (dithered thumbnails in SceneWheelV2) can stand exactly
 * where each card will render. No GL, no renderer: three's vector/camera
 * classes only.
 */

import { PerspectiveCamera, Vector3 } from "three";
import {
  getSceneWheelPose,
  SCENE_WHEEL_CAMERA,
  SCENE_WHEEL_MOBILE_CAMERA,
} from "./curve-model.ts";

/** Must match useMobileSceneFraming in SceneWheelCanvas. */
export const MOBILE_FRAMING_QUERY = "(max-width: 700px) and (max-aspect-ratio: 18 / 25)";

// Mirrors SceneCard: plane height is fixed, width follows the image aspect.
const CARD_HEIGHT = 2.52;

export type PlacedCard = {
  /** Screen px of the card's top-left corner. */
  left: number;
  top: number;
  /** Screen px lengths of the projected top and left edges. */
  width: number;
  height: number;
  /** CSS matrix() components mapping the width×height box onto the
   * projected parallelogram (perspective tilt approximated linearly —
   * within a pixel or two at this scene's mild angles). */
  a: number;
  b: number;
  c: number;
  d: number;
  opacity: number;
  z: number;
  /** Rail-relative slot (negative = the wrap-around card easing in behind
   * the viewer's shoulder). */
  relative: number;
};

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
  camera.updateMatrixWorld(true);

  const toScreen = (v: Vector3) => {
    const ndc = v.clone().project(camera);
    return { x: ((ndc.x + 1) / 2) * viewportWidth, y: ((1 - ndc.y) / 2) * viewportHeight };
  };

  const out: PlacedCard[] = [];
  for (let index = 0; index < count; index += 1) {
    const pose = getSceneWheelPose(index, count, progress);
    if (pose.opacity <= 0.02) continue;
    const aspect = Math.max(0.72, Math.min(1.65, aspects[index] ?? 4 / 3));
    const hw = (CARD_HEIGHT * aspect * pose.scale) / 2;
    const hh = (CARD_HEIGHT * pose.scale) / 2;
    // Pose position/quaternion come from shared scratch objects — consume
    // them fully before the next getSceneWheelPose call.
    const corner = (x: number, y: number) =>
      toScreen(new Vector3(x, y, 0).applyQuaternion(pose.quaternion).add(pose.position));
    const tl = corner(-hw, hh);
    const tr = corner(hw, hh);
    const bl = corner(-hw, -hh);
    const width = Math.hypot(tr.x - tl.x, tr.y - tl.y);
    const height = Math.hypot(bl.x - tl.x, bl.y - tl.y);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 2 || height < 2) continue;
    out.push({
      left: tl.x,
      top: tl.y,
      width,
      height,
      a: (tr.x - tl.x) / width,
      b: (tr.y - tl.y) / width,
      c: (bl.x - tl.x) / height,
      d: (bl.y - tl.y) / height,
      opacity: pose.opacity,
      // Lower `relative` = nearer the viewer = stacked on top.
      z: Math.max(1, Math.round(500 - pose.relative * 10)),
      relative: pose.relative,
    });
  }
  return out;
}
