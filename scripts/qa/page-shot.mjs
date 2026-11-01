// Headless page screenshots over CDP, for QA when the desktop app's browser
// pane is hidden (it then runs no animation frames at all). Loads a URL,
// waits for a selector, optionally runs a snippet of page JS (to toggle a
// demo, scroll, or click), waits, and writes PNGs - one per `--shot`.
//
// Usage:
//   node scripts/qa/page-shot.mjs <chrome.exe> <url> <outDir> \
//     [--wait-for <selector>] [--viewport 1440x900] [--settle <ms>] \
//     [--shot <name>[:<js>[:<delayMs>]]]...
//
// Each --shot evaluates its JS (if any) in the page, waits delayMs (default
// 400), then saves <outDir>/<name>.png. `::` separates the fields so a
// snippet may contain single colons; keep snippets free of "::".
// Example:
//   node scripts/qa/page-shot.mjs chrome.exe http://localhost:3000/dither-lab out \
//     --wait-for canvas --shot idle --shot "working::document.querySelector('[data-qa=working-toggle]').click()::600"
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const [chromePath, url, outDir] = argv;
if (!chromePath || !url || !outDir) {
  console.error("usage: node scripts/qa/page-shot.mjs <chrome.exe> <url> <outDir> [--wait-for sel] [--viewport WxH] [--settle ms] [--shot name[::js[::delay]]]...");
  process.exit(2);
}
let waitFor = "body";
let viewport = [1440, 900];
let settle = 1500;
const shots = [];
for (let i = 3; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === "--wait-for") waitFor = argv[++i];
  else if (a === "--viewport") viewport = argv[++i].split("x").map(Number);
  else if (a === "--settle") settle = Number(argv[++i]);
  else if (a === "--shot") {
    const [name, js = "", delay = "400"] = argv[++i].split("::");
    shots.push({ name, js, delay: Number(delay) });
  }
}
if (shots.length === 0) shots.push({ name: "page", js: "", delay: 0 });

mkdirSync(outDir, { recursive: true });
const PORT = 9400 + Math.floor(Math.random() * 100);
const chrome = spawn(chromePath, [
  "--headless=new",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${join(outDir, "profile")}`,
  `--window-size=${viewport[0]},${viewport[1]}`,
  "--hide-scrollbars",
  "--no-first-run",
  "--no-default-browser-check",
  "about:blank",
], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getTarget() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
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
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
  }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + JSON.stringify(r.exceptionDetails.exception));
  return r.result.value;
};

try {
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: viewport[0], height: viewport[1], deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url });
  let ready = false;
  for (let i = 0; i < 200; i += 1) {
    ready = await evaluate(`!!document.querySelector(${JSON.stringify(waitFor)})`);
    if (ready) break;
    await sleep(250);
  }
  if (!ready) throw new Error(`timed out waiting for ${waitFor}`);
  await sleep(settle);
  for (const shot of shots) {
    if (shot.js) {
      const out = await evaluate(`(async () => { ${shot.js}; return "ok"; })()`);
      console.log(`${shot.name}: js -> ${out}`);
    }
    await sleep(shot.delay);
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    const file = join(outDir, `${shot.name}.png`);
    writeFileSync(file, Buffer.from(data, "base64"));
    console.log(`${shot.name}: ${file}`);
  }
  const errors = await evaluate(`(window.__qaErrors ?? []).length`);
  console.log("done; page errors tracked:", errors);
} finally {
  ws.close();
  chrome.kill();
}
process.exit(0);
