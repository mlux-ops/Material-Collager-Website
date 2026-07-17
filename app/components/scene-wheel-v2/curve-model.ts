import { CatmullRomCurve3, MathUtils, Vector3 } from "three";

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

export const SCENE_WHEEL_CURVE = new Cat