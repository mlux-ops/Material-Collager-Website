// Drives a headless Chrome over CDP: loads the Library, hovers a card, clicks
// it, and screencasts the open morph (and optionally the close) at real speed,
// saving every frame as a JPEG with its timestamp. Also dumps the page's
// running animations ~120ms into the open for ground truth.
//
// Usage: node scripts/qa/morph-capture.mjs <chrome.exe> <outDir> [open|close|both] [scrollY] [inject.css]
//
// Needs `npm run dev` on port 3000 with the Access gate blanked (.dev.vars).
// Headless Chrome runs requestAnimationFrame at full rate even when the
// desktop app's own browser pane is hidden, which is why this exists: the
// pane freezes the Library's loading counter and cannot catch single frames.
// Pair with scripts/qa/frame-stats.mjs to turn the frames into numbers.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [chromePath, outDir, mode = "both", scrollArg = "0", injectCssPath = ""] = process.argv.slice(2);
import { readFileSync } from "node:fs";
if (!chromePath || !outDir) {
  console.error("usage: node scripts/qa/morph-capture.mjs <chrome.exe> <outDir> [open|close|both] [scrollY] [inject.css]");
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
await send("Page.navigate", { url: "http://localhost:3000/" });

// Wait for the veil to lift.
let revealed = false;
for (let i = 0; i < 300; i += 1) {
  revealed = await evaluate(`!document.querySelector('[aria-label="Loading library"]') && !!document.querySelector('canvas')`);
  if (revealed) break;
  await sleep(300);
}
if (!revealed) { console.error("scene never revealed"); chrome.kill(); process.exit(1); }
console.log("revealed");
if (injectCssPath) {
  const css = readFileSync(injectCssPath, "utf8");
  await evaluate(`(() => { const s = document.createElement("style"); s.id = "inject"; s.textContent = ${JSON.stringify(css)}; document.head.appendChild(s); return "injected"; })()`);
  console.log("injected", injectCssPath);
}
await sleep(1500);

const scrollY = Number(scrollArg);
if (scrollY > 0) {
  await evaluate(`window.scrollTo(0, ${scrollY}); 'ok'`);
  await sleep(1500);
}

// Find a card: probe points until the hover label appears.
const probes = [[720, 330], [640, 300], [800, 360], [560, 420], [880, 280], [500, 500], [960, 240]];
let cardPoint = null;
for (const [x, y] of probes) {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await sleep(500);
  const hovered = await evaluate(`!!document.querySelector('[class*="cursorLabel"]')`);
  if (hovered) { cardPoint = [x, y]; break; }
}
if (!cardPoint) { console.error("no card under any probe"); chrome.kill(); process.exit(1); }
console.log("card at", cardPoint);
await sleep(600);

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
    const frost = document.querySelector('[class*="viewerFrost"]');
    const cap = document.querySelector('figcaption');
    return {
      attr: document.documentElement.dataset.wheelViewer ?? null,
      rootName: getComputedStyle(document.documentElement).viewTransitionName,
      frost: frost ? { opacity: getComputedStyle(frost).opacity, cls: frost.className } : null,
      caption: cap ? { opacity: getComputedStyle(cap).opacity } : null,
      anims,
    };
  })()`);
  writeFileSync(join(outDir, `${label}-animations.json`), JSON.stringify(info, null, 2));
  console.log(label, "animations dumped:", info.anims.length, "root name:", info.rootName, "attr:", info.attr, "frost:", JSON.stringify(info.frost), "caption:", JSON.stringify(info.caption));
};

if (mode === "open" || mode === "both") {
  await startCast("open");
  await sleep(120);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: cardPoint[0], y: cardPoint[1], button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cardPoint[0], y: cardPoint[1], button: "left", clickCount: 1 });
  await sleep(140);
  await dumpAnimations("open-120ms");
  await sleep(160);
  await dumpAnimations("open-300ms");
  await sleep(900);
  await stopCast();
  console.log("open frames:", frames.filter((f) => f.label === "open").length);
}

if (mode === "close" || mode === "both") {
  if (mode === "close") {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: cardPoint[0], y: cardPoint[1], button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cardPoint[0], y: cardPoint[1], button: "left", clickCount: 1 });
    await sleep(1500);
  }
  await sleep(300);
  await startCast("close");
  await sleep(120);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await sleep(140);
  await dumpAnimations("close-120ms");
  await sleep(1000);
  await stopCast();
  console.log("close frames:", frames.filter((f) => f.label === "close").length);
}

writeFileSync(join(outDir, "frames.json"), JSON.stringify(frames, null, 2));
console.log("done", frames.length, "frames");
ws.close();
chrome.kill();
process.exit(0);
