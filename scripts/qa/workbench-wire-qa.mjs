// Drives a headless Chrome over CDP against /workbench and checks the wiring
// ergonomics end to end: places Photo, Text, Edit / Material Swap and Compare
// A/B from the palette, then measures the toolbar against the palette (with
// and without the docked inspector), the card Run row, and every Edit port
// (glyph box, glyph centre vs the card border, grab-zone hit tests). It then
// drags REAL wires with Input.dispatchMouseEvent -- Photo and Text onto the
// Edit card's body, Photo onto the incompatible Text card, Photo onto Compare
// twice, Photo onto empty canvas -- and records the edges and whether the
// add-node prompt opened after each, with mid-drag screenshots (card fade,
// port highlight, drop-target outline) and 3x zooms of the port strips.
//
// Usage: node scripts/qa/workbench-wire-qa.mjs <chrome.exe> <outDir> [WxH] [mobile]
//
// Needs `npm run dev` on port 3000 with the Access gate blanked (.dev.vars).
// Uses a fresh profile in <outDir>/profile, so the template gallery opens on
// an empty canvas. The node placement and drop points assume 1440x900: at
// narrower desktop widths cards land under the palette and the "empty
// canvas" point can fall on a card, so treat other widths' drag results as
// layout probes only. `mobile` emulates touch and only measures the toolbar.
// Prints one JSON report; screenshots land in <outDir>.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [chromePath, outDir, vp = "1440x900", mobileArg = ""] = process.argv.slice(2);
const [W, H] = vp.split("x").map(Number);
const mobile = mobileArg === "mobile";
mkdirSync(outDir, { recursive: true });
const PORT = 9500 + Math.floor(Math.random() * 300);
const chrome = spawn(chromePath, [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(outDir, "profile")}`,
  `--window-size=${W},${H}`, "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", "about:blank",
], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 100 && !target; i += 1) {
  try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === "page"); } catch {}
  if (!target) await sleep(200);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let nextId = 1;
const pending = new Map();
const consoleErrors = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
  } else if (msg.method === "Runtime.exceptionThrown") {
    consoleErrors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
  } else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
    consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
  }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + JSON.stringify(r.exceptionDetails.exception?.description));
  return r.result.value;
};
const shot = async (name) => {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(outDir, `${name}.png`), Buffer.from(data, "base64"));
};
const zoomShot = async (name, sel) => {
  const r = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); const b = e.getBoundingClientRect(); return { x: b.left - 16, y: b.top, width: b.width + 32, height: 110 }; })()`);
  const { data } = await send("Page.captureScreenshot", { format: "png", clip: { ...r, scale: 3 } });
  writeFileSync(join(outDir, `${name}.png`), Buffer.from(data, "base64"));
};
const mouse = (type, x, y, buttons = 0) =>
  send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" && !buttons ? "none" : "left", buttons, clickCount: type === "mouseMoved" ? 0 : 1 });
async function drag(from, to, { midShot, steps = 14 } = {}) {
  await mouse("mouseMoved", from.x, from.y);
  await mouse("mousePressed", from.x, from.y, 1);
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    await mouse("mouseMoved", from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, 1);
    await sleep(16);
  }
  await sleep(250);
  if (midShot) { await shot(midShot); await zoomShot(midShot + "-zoom-edit", '.react-flow__node[data-id^="imageEdit-"]'); await zoomShot(midShot + "-zoom-compare", '.react-flow__node[data-id^="compare-"]'); }
  const mid = await evaluate(`(() => {
    const cards = [...document.querySelectorAll('.react-flow__node')].map((n) => ({ id: n.dataset.id.split('-')[0], opacity: getComputedStyle(n.firstElementChild).opacity, outline: getComputedStyle(n.firstElementChild).outlineStyle + ' ' + getComputedStyle(n.firstElementChild).outlineWidth }));
    const handles = [...document.querySelectorAll('.react-flow__handle')].map((h) => ({ node: h.closest('.react-flow__node').dataset.id.split('-')[0], id: h.dataset.handleid, type: h.classList.contains('source') ? 'out' : 'in', opacity: getComputedStyle(h).opacity, cls: [...h.classList].filter((c) => !c.startsWith('react-flow')).join(' '), attrs: [...h.attributes].filter((a) => a.name.startsWith('data-') && a.name !== 'data-handleid' && a.name !== 'data-nodeid' && a.name !== 'data-handlepos' && a.name !== 'data-id').map((a) => a.name + '=' + a.value).join(' ') }));
    return { cards, handles };
  })()`);
  await mouse("mouseReleased", to.x, to.y, 0);
  await sleep(400);
  return mid;
}
const centerOf = (sel) => evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`);
const edgeSummary = () => evaluate(`[...document.querySelectorAll('.react-flow__edge')].map((e) => e.getAttribute('aria-label') || e.dataset.id || e.id)`);
const wirePromptOpen = () => evaluate(`!!document.querySelector('[role=dialog]')`);
const closeDialogs = async () => { await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }); await sleep(500); };

const report = { viewport: vp, mobile };
try {
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile });
  if (mobile) await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await send("Page.navigate", { url: "http://localhost:3000/workbench" });
  for (let i = 0; i < 240; i += 1) { if (await evaluate(`!!document.querySelector('[role=dialog]')`)) break; await sleep(250); }
  await sleep(2500);
  await evaluate(`[...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent.trim() === 'Skip').click()`);
  await sleep(800);
  if (!mobile) {
    for (const t of ["Photo", "Text", "Edit / Material Swap", "Compare A/B"]) {
      await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.startsWith(${JSON.stringify(t)})).click()`);
      await sleep(250);
    }
  }
  await sleep(1200);
  await shot("cards");

  // Toolbar vs palette geometry.
  report.toolbar = await evaluate(`(() => {
    const tb = document.querySelector('.react-flow__panel.top.right'); const pal = document.querySelector('.react-flow__panel.top.left');
    const a = tb?.getBoundingClientRect(), b = pal?.getBoundingClientRect();
    if (!a || !b) return null;
    const inter = !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
    const btns = [...tb.querySelectorAll('button')].filter((x) => x.offsetParent).map((x) => Math.round(x.getBoundingClientRect().top));
    return { toolbar: [a.left, a.top, a.right, a.bottom].map(Math.round), palette: [b.left, b.top, b.right, b.bottom].map(Math.round), intersects: inter, buttonRows: [...new Set(btns)].length, reason: tb.textContent.match(/node\\(s\\) are missing[^.]*/)?.[0] ?? null };
  })()`);
  if (mobile) { report.consoleErrors = consoleErrors; console.log(JSON.stringify(report, null, 1)); process.exit(0); }

  // Pan the canvas down so no port sits under the toolbar (a pane drag on
  // empty canvas), then re-measure from the new positions.
  await mouse("mouseMoved", W * 0.62, H - 300);
  await mouse("mousePressed", W * 0.62, H - 300, 1);
  for (let i = 1; i <= 10; i += 1) { await mouse("mouseMoved", W * 0.62 - 60 * i / 10, H - 300 + 150 * i / 10, 1); await sleep(16); }
  await mouse("mouseReleased", W * 0.62 - 60, H - 150, 0);
  await sleep(500);
  await shot("panned");

  // Toolbar vs palette with the inspector docked (select a card).
  const header = await centerOf('.react-flow__node[data-id^="compare-"] header');
  await mouse("mouseMoved", header.x - 40, header.y);
  await mouse("mousePressed", header.x - 40, header.y, 1);
  await mouse("mouseReleased", header.x - 40, header.y, 0);
  await sleep(700);
  report.toolbarInspector = await evaluate(`(() => {
    const tb = document.querySelector('.react-flow__panel.top.right'); const pal = document.querySelector('.react-flow__panel.top.left');
    const a = tb.getBoundingClientRect(), b = pal.getBoundingClientRect();
    const inter = !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
    const btns = [...tb.querySelectorAll('button')].filter((x) => x.offsetParent).map((x) => Math.round(x.getBoundingClientRect().top));
    return { toolbar: [a.left, a.top, a.right, a.bottom].map(Math.round), palette: [b.left, b.right].map(Math.round), intersects: inter, buttonRows: [...new Set(btns)].length, flow: Math.round(document.querySelector('.react-flow').getBoundingClientRect().width) };
  })()`);
  await shot("inspector");
  await mouse("mouseMoved", W * 0.45, H - 30);
  await mouse("mousePressed", W * 0.45, H - 30, 1);
  await mouse("mouseReleased", W * 0.45, H - 30, 0);
  await sleep(600);

  // Run-row geometry on the Edit card.
  report.runRow = await evaluate(`(() => { const n = document.querySelector('.react-flow__node[data-id^="imageEdit-"]'); const b = [...n.querySelectorAll('button')].find((x) => x.textContent.startsWith('Run')); const r = b.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })()`);

  // Glyph centre vs card border + hit zone.
  report.handles = await evaluate(`(() => [...document.querySelectorAll('.react-flow__node[data-id^="imageEdit-"] .react-flow__handle')].map((h) => {
    const card = h.closest('.react-flow__node').firstElementChild.getBoundingClientRect(); const r = h.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2; const side = h.classList.contains('source') ? 'out' : 'in';
    const border = side === 'in' ? card.left + 0.5 : card.right - 0.5;
    const hit = (dx, dy) => document.elementFromPoint(cx + dx, cy + dy)?.closest('.react-flow__handle') === h;
    const after = getComputedStyle(h, '::after');
    const label = h.parentElement.textContent.trim();
    return { id: h.dataset.handleid, side, box: [Math.round(r.width), Math.round(r.height)], centreToBorder: +(cx - border).toFixed(2), hit8: [hit(-8,0), hit(8,0), hit(0,-8), hit(0,8)], hit12: [hit(-12,0), hit(12,0)], afterSize: after.width + 'x' + after.height, rowText: label };
  }))()`);

  // Drag 1: Photo output -> Edit card body (expect image port).
  const photoOut = await centerOf('.react-flow__node[data-id^="photo-"] .react-flow__handle.source');
  const editBody = await centerOf('.react-flow__node[data-id^="imageEdit-"]');
  const textOut = await centerOf('.react-flow__node[data-id^="text-"] .react-flow__handle.source');
  const textBody = await centerOf('.react-flow__node[data-id^="text-"]');
  const compareBody = await centerOf('.react-flow__node[data-id^="compare-"]');
  report.drag1Mid = await drag(photoOut, { x: editBody.x, y: editBody.y + 20 }, { midShot: "drag-photo-over-edit" });
  report.afterDrag1 = { edges: await edgeSummary(), prompt: await wirePromptOpen() };
  if (await wirePromptOpen()) await closeDialogs();
  await shot("after-drag1");
  // Drag 2: Text output -> Edit card body (expect prompt port).
  await drag(textOut, { x: editBody.x, y: editBody.y + 30 });
  report.afterDrag2 = { edges: await edgeSummary(), prompt: await wirePromptOpen() };
  if (await wirePromptOpen()) await closeDialogs();
  // Drag 3: Photo output -> Text card body (incompatible: expect nothing, no prompt).
  await drag(photoOut, { x: textBody.x, y: textBody.y + 10 });
  report.afterDrag3 = { edges: await edgeSummary(), prompt: await wirePromptOpen() };
  if (await wirePromptOpen()) await closeDialogs();
  // Drag 4: Photo output -> Compare twice (expect a, then b).
  await drag(photoOut, { x: compareBody.x, y: compareBody.y });
  await drag(photoOut, { x: compareBody.x, y: compareBody.y });
  report.afterDrag4 = { edges: await edgeSummary(), prompt: await wirePromptOpen() };
  if (await wirePromptOpen()) await closeDialogs();
  await shot("after-all-drags");
  // Drag 5: Photo output -> empty canvas (expect wire prompt).
  await drag(photoOut, { x: W - 200, y: H - 260 });
  report.afterDrag5 = { prompt: await wirePromptOpen() };
  await shot("empty-drop-prompt");
  await closeDialogs();
  if (await wirePromptOpen()) await evaluate(`[...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent.trim().toLowerCase() === 'close')?.click()`);
  await sleep(600);
  report.finalStrip = await evaluate(`[...document.querySelectorAll('.react-flow__node')].map((n) => n.dataset.id.split('-')[0] + ': ' + [...n.querySelectorAll('.react-flow__handle')].map((h) => h.parentElement.textContent.trim() + '[' + getComputedStyle(h.parentElement.querySelector('span,em,label') ?? h.parentElement).color + ']').join(' / '))`);
  await shot("final");
  await zoomShot("final-zoom-edit", '.react-flow__node[data-id^="imageEdit-"]');
  await zoomShot("final-zoom-compare", '.react-flow__node[data-id^="compare-"]');
  await zoomShot("final-zoom-text", '.react-flow__node[data-id^="text-"]');
  report.consoleErrors = consoleErrors;
  console.log(JSON.stringify(report, null, 1));
} finally {
  ws.close();
  chrome.kill();
}
process.exit(0);
