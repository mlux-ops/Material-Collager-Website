import { Matrix4, MathUtils, Quaternion, Vector3 } from "three";

// Lower-left foreground to upper-right depth path. Small lateral and vertical
// deviations prevent the field from collapsing into one mechanically regular
// diagonal. Each pane takes its own normal from this path's local tangent.
const RAIL_ORIGIN = new Vector3(-3.42, -2.34, 4.72);
const RAIL_STEP = new Vector3(0.91, 0.63, -1.12);
const FRONT_BUFFER = 1.35;
const SIZE_PROFILES = [1.12, 0.94, 1.04, 0.86, 1.08, 0.91, 1.0, 0.89] as const;

const WORLD_UP = new Vector3(0, 1, 0);
const PANEL_ROLL = MathUtils.degToRad(-1.2);
const CAMERA_POSITION = new Vector3(0, 0.15, 12.4);

// Reference hover behavior extracts one pane predominantly toward screen-right.
export const SCENE_WHEEL_HOVER_OFFSET = new Vector3(1.18, 0.02, 0.2);

export type SceneWheelPose = {
  depthSoftness: number;
  focus: number;
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

function getRailPosition(relative: number) {
  const position = RAIL_ORIGIN.clone().addScaledVector(RAIL_STEP, relative);
  position.x += Math.sin(relative * 0.83 + 0.45) * 0.22;
  position.y += Math.sin(relative * 0.57 - 0.8) * 0.11;
  position.z += Math.cos(relative * 0.71) * 0.08;
  return position;
}

export function getSceneWheelTravelTangent(relative: number) {
  return new Vector3(
    RAIL_STEP.x + Math.cos(relative * 0.83 + 0.45) * 0.22 * 0.83,
    RAIL_STEP.y + Math.cos(relative * 0.57 - 0.8) * 0.11 * 0.57,
    RAIL_STEP.z - Math.sin(relative * 0.71) * 0.08 * 0.71,
  ).normalize();
}

function projectDirectionToCameraPlane(point: Vector3, direction: Vector3) {
  const cameraPoint = point.clone().sub(CAMERA_POSITION);
  return new Vector3(
    cameraPoint.z * direction.x - cameraPoint.x * direction.z,
    cameraPoint.z * direction.y - cameraPoint.y * direction.z,
    0,
  ).normalize();
}

// The visual target is the apparent 90° relationship, not only the world-space
// one. Perspective skews world directions, so solve the face normal from the
// rail tangent after projection through the active camera. Its screen-plane
// projection is parallel to travel, making the panel surface perpendicular to
// the visible path of travel.
function getScreenAlignedFaceNormal(relative: number) {
  const position = getRailPosition(relative);
  const tangent = getSceneWheelTravelTangent(relative);
  const projectedTangent = projectDirectionToCameraPlane(position, tangent);
  const cameraPoint = position.clone().sub(CAMERA_POSITION);
  const faceNormal = new Vector3(
    (projectedTangent.x + cameraPoint.x) / cameraPoint.z,
    (projectedTangent.y + cameraPoint.y) / cameraPoint.z,
    1,
  ).normalize();

  return faceNormal;
}

export function getSceneWheelScreenPathAlignment(relative: number) {
  const position = getRailPosition(relative);
  const pathDirection = projectDirectionToCameraPlane(position, getSceneWheelTravelTangent(relative));
  const panelNormalDirection = projectDirectionToCameraPlane(position, getScreenAlignedFaceNormal(relative));
  return pathDirection.dot(panelNormalDirection);
}

function getPaneOrientation(relative: number) {
  const faceNormal = getScreenAlignedFaceNormal(relative);
  const faceRight = new Vector3().crossVectors(WORLD_UP, faceNormal).normalize();
  const faceUp = new Vector3().crossVectors(faceNormal, faceRight).normalize();

  const orientation = new Quaternion().setFromRotationMatrix(
    new Matrix4().makeBasis(faceRight, faceUp, faceNormal),
  );

  // Pre-multiply the roll in world space so it stays around the already
  // aligned face normal instead of canting that normal away from the tangent.
  return new Quaternion()
    .setFromAxisAngle(faceNormal, PANEL_ROLL)
    .multiply(orientation);
}

export function getSceneWheelPose(index: number, count: number, progress: number): SceneWheelPose {
  const relative = wrapToRail(index - progress, count);
  const position = getRailPosition(relative);
  const nearFade = MathUtils.smoothstep(relative, -1.32, -0.58);
  const farFade = 1 - MathUtils.smoothstep(relative, 8.35, 10.35);
  const opacity = MathUtils.clamp(nearFade * farFade, 0, 1);
  const focus = Math.exp(-Math.pow((relative - 1.15) / 1.45, 2));
  const distancePhase = MathUtils.clamp(Math.abs(relative - 1.15) / 8.4, 0, 1);
  const depthSoftness = MathUtils.smoothstep(distancePhase, 0.08, 0.82);
  const scale = SIZE_PROFILES[index % SIZE_PROFILES.length]
    * MathUtils.lerp(1.075, 0.94, distancePhase)
    * MathUtils.lerp(1, 1.055, focus);

  return {
    depthSoftness,
    focus,
    opacity,
    position,
    quaternion: getPaneOrientation(relative),
    relative,
    scale,
  };
}

export const SCENE_WHEEL_CAMERA = {
  far: 90,
  fov: 38,
  near: 0.1,
  position: [CAMERA_POSITION.x, CAMERA_POSITION.y, CAMERA_POSITION.z] as [number, number, number],
};

export const SCENE_WHEEL_MOBILE_CAMERA = {
  ...SCENE_WHEEL_CAMERA,
  fov: 50,
  position: [-1.3, -0.35, 12.4] as [number, number, number],
};
