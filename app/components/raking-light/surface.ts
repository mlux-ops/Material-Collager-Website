import {
  AmbientLight, PointLight, Mesh, MeshStandardMaterial, OrthographicCamera, PlaneGeometry,
  Scene, SRGBColorSpace, TextureLoader, WebGLRenderer,
} from "three";
import { lightVector, sampleMap, type LightSample } from "../../lib/raking-light";

/** Paint only after a texture load, resize, or user input. The generator otherwise
 * has no canvas or rendering loop for this tool. */
export function mountSurface(
  canvas: HTMLCanvasElement, sample: LightSample, onReady: () => void, onFailure: () => void,
) {
  const renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: "low-power" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const scene = new Scene();
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.01, 10);
  camera.position.z = 3;
  const geometry = new PlaneGeometry(2, 2);
  const loader = new TextureLoader();
  let loaded = 0;
  let disposed = false;
  let failed = false;
  let frame = 0;
  const draw = () => {
    if (disposed || failed || loaded !== 3 || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      renderer.render(scene, camera);
      onReady();
    });
  };
  const fail = () => {
    if (disposed) return;
    failed = true;
    onFailure();
  };
  const load = (kind: "diffuse" | "nor_gl" | "rough") => loader.load(
    sampleMap(sample, kind), () => { loaded += 1; resize(); }, undefined, fail,
  );
  const color = load("diffuse");
  color.colorSpace = SRGBColorSpace;
  const normal = load("nor_gl");
  const roughness = load("rough");
  const material = new MeshStandardMaterial({ map: color, normalMap: normal, roughnessMap: roughness });
  const plane = new Mesh(geometry, material);
  // A nearby lamp grazes the specimen. Distance falloff makes the reflection
  // travel across glazed or polished areas as the user moves the light source.
  const lamp = new PointLight(0xffffff, 22);
  scene.add(plane, lamp, new AmbientLight(0xffffff, 0.88));
  const aim = (azimuth: number, elevation: number) => {
    lamp.position.set(...lightVector(azimuth, elevation)).multiplyScalar(2.8);
    draw();
  };
  function resize() {
    if (disposed || failed) return;
    const { clientWidth: width, clientHeight: height } = canvas;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    const frameAspect = width / height;
    const textureAspect = color.image ? color.image.width / color.image.height : 1;
    // Crop around the middle of the specimen to reveal the grain. Both
    // axes use the same physical magnification, including on tall phones.
    const scale = 1.45 * Math.max(1, frameAspect / textureAspect);
    plane.scale.set(textureAspect * scale, scale, 1);
    camera.left = -frameAspect;
    camera.right = frameAspect;
    camera.updateProjectionMatrix();
    draw();
  }
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  canvas.addEventListener("webglcontextlost", fail);
  return {
    aim,
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      canvas.removeEventListener("webglcontextlost", fail);
      geometry.dispose();
      material.dispose();
      for (const texture of [color, normal, roughness]) texture.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
