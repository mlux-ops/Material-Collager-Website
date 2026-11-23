import { MathUtils, Vector3 } from "three";
import type { MeshBasicMaterial, Quaternion } from "three";

/** One set of uniforms and scratch vectors per pane. The existing image pass
 * shades just its outermost pixels, so the rim shares its depth and fade. */
export function createPrismRim(aspect: number) {
  const uniforms = {
    uPrismAspect: { value: aspect },
    uPrismPixelRatio: { value: 1 },
    uPrismSweep: { value: 0 },
    uPrismStrength: { value: 0 },
  };
  const toEye = new Vector3();
  const right = new Vector3();
  const patchImage: MeshBasicMaterial["onBeforeCompile"] = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec2 vPrismUv;")
      .replace("#include <uv_vertex>", "#include <uv_vertex>\nvPrismUv = uv;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
        varying vec2 vPrismUv;
        uniform float uPrismAspect, uPrismPixelRatio, uPrismSweep, uPrismStrength;
      `)
      .replace("#include <map_fragment>", `#include <map_fragment>
        if (uPrismStrength > 0.0) {
          // Measure width in CSS pixels even on oblique or high-DPI panes.
          vec2 width = max(fwidth(vPrismUv) * uPrismPixelRatio, vec2(0.000001));
          float end = uPrismSweep < 0.0 ? vPrismUv.x : 1.0 - vPrismUv.x;
          float sidePx = end / width.x;
          float topPx = (1.0 - vPrismUv.y) / width.y;
          float rim = 1.0 - smoothstep(0.35, 1.65, min(sidePx, topPx));
          // Signed distance along the top edge and around its leading corner.
          float arc = topPx < sidePx ? -end * uPrismAspect : 1.0 - vPrismUv.y;
          float offset = arc - mix(-0.6, 0.66, abs(uPrismSweep));
          float highlight = rim * (1.0 - smoothstep(0.015, 0.29, abs(offset)));
          vec3 amber = vec3(0.73, 0.30, 0.055);
          vec3 blue = vec3(0.061, 0.27, 0.65);
          vec3 tint = mix(amber, blue, smoothstep(-0.055, 0.055, offset));
          diffuseColor.rgb = mix(diffuseColor.rgb, tint, highlight * uPrismStrength);
        }
      `);
  };
  return {
    patchImage,
    uniforms,
    update(
      eye: Vector3, center: Vector3, orientation: Quaternion,
      pixelRatio: number, enabled: boolean,
    ) {
      // The panes remain parallel in world space. The moving eye-to-pane ray
      // provides the changing incidence, including the true hover displacement.
      uniforms.uPrismStrength.value = 0;
      if (!enabled) return;
      const incidence = toEye.copy(eye).sub(center).normalize()
        .dot(right.set(1, 0, 0).applyQuaternion(orientation));
      const angle = Math.abs(incidence);
      uniforms.uPrismStrength.value = 0.9 * MathUtils.smoothstep(angle, 0.09, 0.29);
      uniforms.uPrismSweep.value = Math.sign(incidence) * MathUtils.smoothstep(angle, 0.10, 0.73);
      uniforms.uPrismPixelRatio.value = pixelRatio;
    },
  };
}
