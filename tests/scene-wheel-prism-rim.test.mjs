import assert from "node:assert/strict";
import test from "node:test";
import { Quaternion, Vector3 } from "three";
import { createPrismRim } from "../app/components/scene-wheel-v2/prism-rim.ts";
import { getSceneWheelPose, SCENE_WHEEL_CAMERA } from "../app/components/scene-wheel-v2/curve-model.ts";

test("the glint retraces the same corner as a card reverses along the rail", () => {
  const rim = createPrismRim(1.5);
  const eye = new Vector3(...SCENE_WHEEL_CAMERA.position);
  function measure(progress) {
    const pose = getSceneWheelPose(4, 12, progress);
    rim.update(eye, pose.position, pose.quaternion, 2, true);
    return rim.uniforms.uPrismSweep.value;
  }
  const start = measure(0);
  const midway = measure(1);
  assert.ok(start < midway && midway < measure(2));
  assert.equal(measure(1), midway);
  assert.equal(measure(0), start);
  assert.equal(rim.uniforms.uPrismPixelRatio.value, 2);
});

test("direct views and reduced-motion preferences leave the photograph untinted", () => {
  const rim = createPrismRim(1);
  const pane = new Vector3();
  const orientation = new Quaternion();
  rim.update(new Vector3(0, 0, 8), pane, orientation, 1, true);
  assert.equal(rim.uniforms.uPrismStrength.value, 0);
  rim.update(new Vector3(3, 0, 8), pane, orientation, 1, true);
  const right = rim.uniforms.uPrismSweep.value;
  assert.ok(right > 0 && rim.uniforms.uPrismStrength.value > 0);
  rim.update(new Vector3(-3, 0, 8), pane, orientation, 1, true);
  assert.equal(rim.uniforms.uPrismSweep.value, -right);
  rim.update(new Vector3(-3, 0, 8), pane, orientation, 1, false);
  assert.equal(rim.uniforms.uPrismStrength.value, 0);
});
