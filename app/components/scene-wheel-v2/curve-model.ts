import { CatmullRomCurve3, MathUtils, Quaternion, Vector3 } from "three";

const CONTROL_POINTS = [
  new Vector3(-7.2, -4.8, 1.8),
  new Vector3(-4.4, -2.4, 4.4),
  new Vector3(-0.8, 0.2, 3.1),
  new Vector3(3.4, 2.8, -1.2),
  new Vector3(7.4, 5.2, -8.8),
  new Vector3(3.2, 7.1, -13.2),
  new Vector3(-3.8, 6.3, -12.4),
  new Vector3(-7.6, 2.2, -7.2),
  new Vector3(-8.2, -3.4, -2.1),
] as const;

export const SCENE_WHEEL_CURVE = new CatmullRomCurve3(
  [...CONTROL_POINTS],
  true,
  "centripetal",
  0.45,
);

export type SceneWheelPose = {
  position: Vector3;
  quaternion: Quaternion;
  roll: number;
  t: number;
};

const CAMERA_POSITION = new Vector3(0, 0.25, 11.5);
const WORLD_UP = new Vector3(0, 1, 0);
const FORWARD = new Vector3(0, 0, 1);

export function wrapProgress(value: number) {
  return ((value % 1) + 1) % 1;
}

export function getSceneWheelPose(index: number, count: number, progress: number): SceneWheelPose {
  const t = wrapProgress(index / Math.max(1, count) + progress);
  const position = SCENE_WHEEL_CURVE.getPointAt(t);
  const tangent = SCENE_WHEEL_CURVE.getTangentAt(t).normalize();
  const toCamera = CAMERA_POSITION.clone().sub(position).normalize();
  const right = new Vector3().crossVectors(WORLD_UP, toCamera);
  if (right.lengthSq() < 0.0001) right.set(1, 0, 0);
  right.normalize();
  const up = new Vector3().crossVectors(toCamera, right).normalize();
  const cameraFacing = new Quaternion().setFromRotationMatrix(
    new (await import("three")).Matrix4().makeBasis(right, up, toCamera),
  );
  const tangentFacing = new Quaternion().setFromUnitVectors(FORWARD, tangent);
  const depth = MathUtils.clamp((position.z + 13.2) / 17.6, 0, 1);
  const facingBlend = MathUtils.lerp(0.18, 0.68, depth);
  const quaternion = tangentFacing.slerp(cameraFacing, facingBlend);
  const roll = Math.sin(t * Math.PI * 2 + 0.5) * MathUtils.degToRad(8);
  quaternion.multiply(new Quaternion().setFromAxisAngle(FORWARD, roll));
  return { position, quaternion, roll, t };
}

export const SCENE_WHEEL_CAMERA = {
  far: 80,
  fov: 40,
  near: 0.1,
  position: CAMERA_POSITION.toArray() as [number, number, number],
};
