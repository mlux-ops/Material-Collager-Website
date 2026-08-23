"use client";

/**
 * Velaris — animated simplex-noise gradient rendered on a WebGL canvas
 * (color blending, vignette glow, film grain).
 *
 * Vendored from the owner's chosen component and adapted to this codebase:
 * the project doesn't use Tailwind or the shadcn structure, so the `cn`
 * helper from "@/lib/utils" and the utility classes are replaced with plain
 * inline styles (visually identical).
 *
 * One extension over the original (owner request): a `seed` prop, fed to the
 * shader as u_seed, offsets the noise domain and the time phase so every
 * instance shows a genuinely different pattern — the original always
 * rendered the same field. The shader accepts exactly FOUR colors
 * (u_colors[4]) plus a background (u_bg).
 */

import { useEffect, useRef } from "react";

const vertexShaderGLSL = `
attribute vec2 position;
varying vec2 vUv;
void main() {
  vUv = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const fragmentShaderGLSL = `
precision highp float;
varying vec2 vUv;

uniform vec2  u_resolution;
uniform float u_time;
uniform float u_grain;
uniform float u_seed;
uniform vec3  u_colors[4];
uniform vec3  u_bg;

vec3 permute(vec3 x) { return mod(((x*34.0)+1.0)*x, 289.0); }

float snoise(vec2 v){
  const vec4 C = vec4(0.211324865405187, 0.366025403784439,
           -0.577350269189626, 0.024390243902439);
  vec2 i  = floor(v + dot(v, C.yy) );
  vec2 x0 = v -   i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod(i, 289.0);
  vec3 p = permute( permute( i.y + vec3(0.0, i1.y, 1.0 ))
  + i.x + vec3(0.0, i1.x, 1.0 ));
  vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy),
    dot(x12.zw,x12.zw)), 0.0);
  m = m*m ;
  m = m*m ;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * ( a0*a0 + h*h );
  vec3 g;
  g.x  = a0.x  * x0.x  + h.x  * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

void main() {
  vec2 uv = vUv;
  float ratio = u_resolution.x / u_resolution.y;
  vec2 p = uv - 0.5;
  p.x *= ratio;

  float t = u_time * 0.1 + u_seed * 43.7;

  // Seed offsets the noise DOMAIN only (q), never p itself — dist/vignette/
  // glow below must stay centered on the element.
  vec2 q = p + vec2(u_seed * 7.31, u_seed * 3.17);

  float n1 = snoise(q * 0.4 + vec2(t * 0.2, -t * 0.3));
  float n2 = snoise(q * 0.55 + vec2(-t * 0.15, t * 0.25) + n1 * 0.25);
  float n3 = snoise(q * 0.75 + vec2(t * 0.1, -t * 0.2) + n2 * 0.2);

  vec3 col = u_bg;

  float dist = length(p) * 1.5;
  float vignette = 1.0 - smoothstep(0.3, 1.2, dist);

  col = mix(col, u_colors[0], smoothstep(-0.2, 0.5, n1) * 0.85);
  col = mix(col, u_colors[1], smoothstep(-0.1, 0.6, n2) * 0.7);
  col = mix(col, u_colors[2], smoothstep(-0.3, 0.4, n3) * 0.6);
  col = mix(col, u_colors[3], smoothstep(0.0, 0.7, n1 * n2) * 0.5);

  float glow = smoothstep(0.8, 0.0, dist) * 0.3;
  col += u_colors[1] * glow;

  /* Edge fade generalized for light backgrounds: the original col * 0.2
     fades edges toward BLACK, which is exactly mix(black, col, 0.2) — so on
     a black bg this line is identical, and on a white bg the edges wash out
     toward the paper instead of going dark. */
  col = mix(mix(u_bg, col, 0.2), col, vignette);

  float grain = fract(sin(dot(uv, vec2(12.9898, 78.233))) * 43758.5453 + u_time);
  col += (grain - 0.5) * u_grain * 0.1;

  gl_FragColor = vec4(col, 1.0);
}
`;

export interface VelarisProps {
  bg?: string;
  /** Exactly four are used (u_colors[4]); extras are ignored. */
  colors?: string[];
  speed?: number;
  grain?: number;
  /** Any number; each value renders a different noise pattern and phase. */
  seed?: number;
  height?: string;
  className?: string;
  children?: React.ReactNode;
}

const DEFAULT_COLORS = ["#86efac", "#4ade80", "#059669", "#000000"];

const hexToRgb = (hex: string): [number, number, number] => {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
};

const Velaris = ({
  bg = "#000000",
  colors = DEFAULT_COLORS,
  speed = 2.0,
  grain = 0.3,
  seed = 0,
  height = "100vh",
  className,
  children,
}: VelarisProps) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    // alpha: false — the rectangle is fully opaque, never blended with
    // whatever sits behind the canvas (owner: no transparency on the
    // gradient background).
    const gl = canvas.getContext("webgl", { alpha: false });
    if (!gl) return;

    const createShader = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };

    const program = gl.createProgram()!;
    gl.attachShader(program, createShader(gl.VERTEX_SHADER, vertexShaderGLSL));
    gl.attachShader(
      program,
      createShader(gl.FRAGMENT_SHADER, fragmentShaderGLSL),
    );
    gl.linkProgram(program);
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );

    const pos = gl.getAttribLocation(program, "position");
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);

    const locs = {
      res: gl.getUniformLocation(program, "u_resolution"),
      time: gl.getUniformLocation(program, "u_time"),
      grain: gl.getUniformLocation(program, "u_grain"),
      seed: gl.getUniformLocation(program, "u_seed"),
      colors: gl.getUniformLocation(program, "u_colors"),
      bg: gl.getUniformLocation(program, "u_bg"),
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio, 2);
      canvas.width = container.clientWidth * dpr;
      canvas.height = container.clientHeight * dpr;
      gl.viewport(0, 0, canvas.width, canvas.height);
    };

    const ro = new ResizeObserver(resize);
    ro.observe(container);

    let raf: number;
    const render = (t: number) => {
      gl.uniform2f(locs.res, canvas.width, canvas.height);
      gl.uniform1f(locs.time, t * 0.001 * speed);
      gl.uniform1f(locs.grain, grain);
      gl.uniform1f(locs.seed, seed);
      gl.uniform3f(locs.bg, ...hexToRgb(bg));

      // The shader declares exactly vec3 u_colors[4]; a shorter palette is
      // padded by repeating its last color (an unset slot would read black).
      const four = colors.slice(0, 4);
      while (four.length < 4) four.push(four[four.length - 1] ?? bg);
      const flat = new Float32Array(four.flatMap(hexToRgb));
      gl.uniform3fv(locs.colors, flat);

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      raf = requestAnimationFrame(render);
    };

    raf = requestAnimationFrame(render);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [bg, colors, speed, grain, seed]);

  return (
    <div
      ref={containerRef}
      style={{ height, position: "relative", width: "100%", overflow: "hidden" }}
      className={className}
    >
      <canvas
        ref={canvasRef}
        style={{ pointerEvents: "none", position: "absolute", inset: 0, height: "100%", width: "100%" }}
      />
      {children != null && (
        <div style={{ position: "relative", zIndex: 10, height: "100%", width: "100%" }}>{children}</div>
      )}
    </div>
  );
};

export default Velaris;
