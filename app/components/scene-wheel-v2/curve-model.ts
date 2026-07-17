import { Matrix4, MathUtils, Quaternion, Vector3 } from "three";

// Keep the measured rail direction, but tighten the interval so adjacent panes
// overlap with the steady cadence visible in the reference capture.
const RAIL_ORIGIN = new Vector3(-3.15, -2.05, 4.55);
const RAIL_STEP = new Vector3(0.98, 0.665, -1.155);
const FRONT_BUFFER = 1.35;

const WORLD_UP = new Vector3(0, 1, 0);
const CAMERA_FACING_NORMAL = new Vector3(0, 0, 1);
const SCROLL_DIRECTION = RAIL_STEP.clone().multiplyScalar(-1);
const RAIL_FACING_NORMAL = new Vector3(SCROLL_DIRECTION.x, 0, SCROLL_DIRECTION.z).normalize();

// The reference panes remain largely camera-facing while sharing one stable
// orientation. A restrained rail-facing component preserves depth without
// turning the stack into edge-on dominoes.
const FACE_NORMAL = CAMERA_FACING_NORMAL.clone().lerp(RAIL_FACING_NORMAL, 0.32).normalize();
const FACE_RIGHT = new Vector3().crossVectors(WORLD_UP, FACE_NORMAL).normalize();
const FACE_UP = new Vector3().crossVectors(FACE_NORMAL, FACE_RIGHT).normalize();
const BASE_ORIENTATION = new Quaternion().setFromRotationMatrix(
  new Matrix4().makeBasis(FACE_RIGHT, FACE_UP, FACE_NORMAL),
).multiply(new Quaternion().setFromAxisAngle(FACE_NORMAL, MathUtils.degToRad(-1.2)));

// Hover extraction is intentionally screen-right dominant, with only a small
// movement toward the camera so the pane separates without feeling enlarged.
export const SCENE_WHEEL_HOVER_OFFSET = new Vector3(1.18, 0.02, 0.2);

export type SceneWheelPose = {
  opacity: number;
  position: Vector3;
  quaternion: Quaternion;
  relative: number;
  scale: number;
};

function wrapToRail(value: number, count: number) {
  const span = Math.max(1, count);
  return ((((value + FRONT_BUFFER) % span) + span) % span) - FRONT_BUFFER;
}

export function getSceneWheelPose(index: number, count: number, progress: number): SceneWheelPose {
  const relative = wrapToRail(index - progress, count);
  const position = RAIL_ORIGIN.clone().addScaledVector(RAIL_STEP, relative);
  const nearFade = MathUtils.smoothstep(relative, -1.32, -0.58);
  const farFade = 1 - MathUtils.smoothstep(relative, 8.1, 10.6);
  const opacity = MathUtils.clamp(nearFade * farFade, 0, 1);
  const distancePhase = MathUtils.clamp(relative / 8.6, 0, 1);
  const scale = MathUtils.lerp(1.02, 0.98, distancePhase);

  return {
    opacity,
    position,
    quaternion: BASE_ORIENTATION.clone(),
    relative,
    scale,
  };
}

export const SCENE_WHEEL_CAMERA = {
  far: 90,
  fov: 38,
  near: 0.1,
  position: [0, 0.15, 12.4] as [number, number, number],
};
