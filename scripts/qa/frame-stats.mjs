// Per-frame brightness stats for a capture run: whole frame, the deck region
// (lower-left, where cards always sit), and the nav text band. A one-frame
// jump toward 255 in the deck region is the "flash to white".
// Usage: node scripts/qa/frame-stats.mjs <runDir> [open|close]
// Run from the repo root so `sharp` resolves from node_modules.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");

const [dir, label = "close"] = process.argv.slice(2);
const files = readdirSync(dir).filter((f) => f.startsWith(`${label}-`) && f.endsWith(".jpg")).sort();

async function regionMean(buf, info, x0, y0, x1, y1) {
  const { width, channels } = info;
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = (y * width + x) * channels;
      sum += 0.299 * buf[i] + 0.587 * buf[i + 1] + 0.114 * buf[i + 2];
      n += 1;
    }
  }
  return sum / n;
}

const rows = [];
for (const f of files) {
  const { data, info } = await sharp(join(dir, f)).raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const whole = await regionMean(data, info, 0, 0, W, H);
  const deck = await regionMean(data, info, 0, Math.round(H * 0.4), Math.round(W * 0.45), H);
  const nav = await regionMean(data, info, Math.round(W * 0.02), 0, Math.round(W * 0.4), Math.round(H * 0.06));
  const panel = await regionMean(data, info, Math.round(W * 0.55), Math.round(H * 0.15), W, Math.round(H * 0.85));
  rows.push({ f, t: Number(f.split("-")[1].replace(".jpg", "")), whole, deck, nav, panel });
}

let prev = null;
for (const r of rows) {
  const dDeck = prev ? r.deck - prev.deck : 0;
  const flag = Math.abs(dDeck) > 12 ? "  <-- jump" : "";
  console.log(`${String(r.t).padStart(5)}  whole ${r.whole.toFixed(1).padStart(6)}  deck ${r.deck.toFixed(1).padStart(6)} (${(dDeck >= 0 ? "+" : "") + dDeck.toFixed(1)})  nav ${r.nav.toFixed(1).padStart(6)}  panel ${r.panel.toFixed(1).padStart(6)}${flag}`);
  prev = r;
}
