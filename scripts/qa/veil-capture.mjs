// Drives a headless Chrome over CDP and screencasts the Library's
// FIRST-ARRIVAL veil exit: the 0-100% counter, the Bayer dissolve that takes
// the white sheet away (.mc-veil-dissolve), and the settled scene behind it.
// morph-capture.mjs cannot see this, because it waits for the veil to be
// gone before it starts casting. The desktop app's hidden browser pane runs
// no animation frames, so the counter never reaches 100% there and the veil
// never completes; this records the real exit at full frame rate.
//
// Usage: node scripts/qa/veil-capture.mjs <chrome.exe> <outDir> [reduced|reduced-setting] [url]
//   reduced          emulate prefers-reduced-motion: reduce (expect no dissolve)
//   reduced-setting  seed the site's own REDUCE MOTION setting instead (same)
//   url              defaults to http://localhost:3000/
//
// Needs `npm run dev` on port 3000 with the Access gate blanked (.dev.vars).
// Writes veil-<t>.jpg frames, frames.json, summary.json and
// veil-dissolving-animations.json into <outDir>. Pair with
// `node scripts/qa/frame-stats.mjs <outDir> veil` to turn the frames into
// numbers (frame-stats filters by the `veil-` prefix).
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const [chromePath, outDir] = args;
const rest = args.slice(2);
const reduced = rest.includes("reduced");
const reducedSetting = rest.includes("reduced-setting");
const url = rest.find((arg) => arg !== "reduced" && arg !== "reduced-setting") ?? "http://localhost:3000/";
if (!chromePath || !outDir) {
  console.error("usage: node scripts/qa/veil-capture.mjs <chrome.exe> <outDir> [reduced] [url]");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });
const PORT = 9333 + Math.floor(Math.random() * 100);
const userData = join(outDir, "profile");
mkdirSync(userData, { recursive: true });

const chrome = spawn(chromePath, [
  "--headless=new",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${userData}`,
  "--window-size=1440,900",
  "--hide-scrollbars",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu-vsync",
  "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getTarget() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json`);
      const list = await res.json();
      const page = list.find((t) => t.type === "page");
      if (page) return page;
    } catch {}
    await sleep(200);
  }
  throw new Error("chrome did not expose a page target");
}

const target = await getTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

let nextId = 1;
const pending = new Map();
const listeners = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
  } else if (msg.method && listeners.has(msg.method)) {
    for (const fn of listeners.get(msg.method)) fn(msg.params);
  }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const on = (method, fn) => {
  if (!listeners.has(method)) listeners.set(method, []);
  listeners.get(method).push(fn);
};
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + JSON.stringify(r.exceptionDetails.exception));
  return r.result.value;
};

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
if (reduced) {
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
}

// Screencast plumbing.
const frames = [];
let captureStart = 0;
let captureLabel = "";
on("Page.screencastFrame", (p) => {
  const t = Math.round(performance.now() - captureStart);
  const name = `${captureLabel}-${String(t).padStart(5, "0")}.jpg`;
  writeFileSync(join(outDir, name), Buffer.from(p.data, "base64"));
  frames.push({ label: captureLabel, t, name, meta: p.metadata?.timestamp });
  send("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => {});
});
const startCast = async (label) => {
  captureLabel = label;
  captureStart = performance.now();
  await send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: 960, maxHeight: 600, everyNthFrame: 1 });
};
const stopCast = () => send("Page.stopScreencast");

const dumpAnimations = async (label) => {
  const info = await evaluate(`(() => {
    const anims = document.getAnimations().map(a => ({
      pseudo: a.effect?.pseudoElement ?? null,
      target: a.effect?.target ? (a.effect.target.tagName + '.' + String(a.effect.target.className).split(' ').slice(0,2).join('.')) : null,
      name: a.animationName ?? a.constructor.name,
      state: a.playState,
      t: a.currentTime == null ? null : Math.round(a.currentTime),
      dur: a.effect?.getTiming().duration ?? null,
    }));
    const veil = document.querySelector('[aria-label="Loading library"]');
    const style = veil ? getComputedStyle(veil) : null;
    return {
      veil: style ? {
        cls: veil.className,
        maskImage: style.maskImage,
        maskSize: style.maskSize,
        animationName: style.animationName,
        animationDuration: style.animationDuration,
        animationDirection: style.animationDirection,
      } : null,
      anims,
    };
  })()`);
  writeFileSync(join(outDir, `${label}-animations.json`), JSON.stringify(info, null, 2));
  console.log(label, "animations dumped:", info.anims.length, "veil:", JSON.stringify(info.veil));
};

// The site's own REDUCE MOTION setting (html[data-reduce-motion="1"]), the
// second reduced-motion source, seeded before the app reads its settings.
if (reducedSetting) {
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `try { localStorage.setItem("mc:site-settings:v1", JSON.stringify({ reduceMotion: true })); } catch {}`,
  });
}

// In-page probe, installed before any app script runs. CDP polling lags a
// busy main thread by hundreds of ms, so the dissolve's true start, end,
// painted frames and the long tasks inside it are stamped from the page.
await send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
  const probe = { start: null, end: null, frames: 0, longTasks: [], renderer: null };
  window.__veilProbe = probe;
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) probe.longTasks.push({ at: Math.round(e.startTime), ms: Math.round(e.duration) });
    }).observe({ type: "longtask", buffered: true });
  } catch {}
  const tick = () => {
    if (probe.start !== null && probe.end === null) probe.frames += 1;
    if (probe.end === null) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  new MutationObserver(() => {
    const veil = document.querySelector('[aria-label="Loading library"]');
    if (probe.start === null && veil && veil.classList.contains("mc-veil-dissolve")) probe.start = Math.round(performance.now());
    if (probe.start !== null && probe.end === null && !veil) probe.end = Math.round(performance.now());
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
  addEventListener("DOMContentLoaded", () => {
    try {
      const gl = document.createElement("canvas").getContext("webgl");
      const ext = gl && gl.getExtension("WEBGL_debug_renderer_info");
      probe.renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
    } catch {}
  });
})();` });

// Cast first, then navigate, so the frames cover the counter, the dissolve
// and the settled scene.
await startCast("veil");
await send("Page.navigate", { url });

const POLL_MS = 40;
const LIMIT_MS = 60000;
const probe = `(() => ({
  veil: !!document.querySelector('[aria-label="Loading library"]'),
  dissolving: !!document.querySelector('[aria-label="Loading library"].mc-veil-dissolve'),
  counter: document.querySelector('[aria-label="Loading library"] p')?.textContent ?? null,
  canvas: !!document.querySelector('canvas'),
}))()`;

let dissolveStartMs = null;
let veilGoneMs = null;
let sawVeil = false;
while (performance.now() - captureStart < LIMIT_MS) {
  let state;
  try {
    state = await evaluate(probe);
  } catch {
    // The document can be mid-navigation; try again on the next tick.
    await sleep(POLL_MS);
    continue;
  }
  const now = Math.round(performance.now() - captureStart);
  if (state.veil) sawVeil = true;
  if (state.dissolving && dissolveStartMs === null) {
    dissolveStartMs = now;
    await dumpAnimations("veil-dissolving");
  }
  if (sawVeil && !state.veil) {
    veilGoneMs = now;
    break;
  }
  await sleep(POLL_MS);
}

if (veilGoneMs === null) {
  await stopCast().catch(() => {});
  writeFileSync(join(outDir, "frames.json"), JSON.stringify(frames, null, 2));
  console.error(`veil never lifted within ${LIMIT_MS / 1000}s`);
  ws.close();
  chrome.kill();
  process.exit(1);
}

await sleep(700);
await stopCast();

const framesDuringDissolve = dissolveStartMs === null
  ? 0
  : frames.filter((f) => f.t >= dissolveStartMs && f.t <= veilGoneMs).length;
const page = await evaluate("window.__veilProbe ?? null");
const inPage = page ? {
  renderer: page.renderer,
  dissolveStart: page.start,
  dissolveEnd: page.end,
  dissolveMs: page.start === null || page.end === null ? null : page.end - page.start,
  paintedFrames: page.frames,
  longTasksDuringDissolve: page.start === null ? [] : page.longTasks.filter((t) => t.at + t.ms >= page.start - 50 && t.at <= (page.end ?? Infinity)),
} : null;
const summary = {
  inPage,
  reduced,
  reducedSetting,
  dissolveStartMs,
  veilGoneMs,
  dissolveMs: dissolveStartMs === null ? null : veilGoneMs - dissolveStartMs,
  frameCount: frames.length,
  framesDuringDissolve,
};
writeFileSync(join(outDir, "frames.json"), JSON.stringify(frames, null, 2));
writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
console.log("summary", JSON.stringify(summary));
ws.close();
chrome.kill();
process.exit(0);
