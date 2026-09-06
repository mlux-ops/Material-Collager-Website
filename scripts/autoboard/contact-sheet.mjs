// One-off: stitch a board's A/B/C candidates into a single labeled contact
// sheet so variants can be compared side by side. Usage:
//   node --experimental-strip-types scripts/autoboard/contact-sheet.mjs <runId> <boardId> [boardId...]
import sharp from "sharp";
import fs from "node:fs/promises";
import path from "node:path";

const [runId, ...boardIds] = process.argv.slice(2);
if (!runId || !boardIds.length) {
  console.error("usage: contact-sheet.mjs <runId> <boardId> [boardId...]");
  process.exit(1);
}

const repoRoot = "E:/Games/Claude/Material-Collager-Website";
const runDir = path.join(repoRoot, "autoboard-runs", runId);
const outDir = "E:/Temp/claude/E--Games-Claude-Material-Collager-Website/e2fb1478-f9cd-4802-8afa-74f9db49175f/scratchpad/contact-sheets";
await fs.mkdir(outDir, { recursive: true });

const results = JSON.parse(await fs.readFile(path.join(runDir, "results.json"), "utf8"));

const TILE_W = 480;
const LABEL_H = 40;
const GAP = 12;

for (const boardId of boardIds) {
  const tiles = [];
  for (const v of ["A", "B", "C"]) {
    const cand = results.candidates[`${boardId}--${v}`];
    if (!cand || cand.status !== "ok") continue;
    const abs = path.resolve(repoRoot, cand.savedPath);
    const { data, info } = await sharp(abs).resize(TILE_W, TILE_W, { fit: "inside" }).toBuffer({ resolveWithObject: true });
    tiles.push({ variant: v, buf: data, h: info.height });
  }
  if (!tiles.length) {
    console.error(`${boardId}: no ok candidates`);
    continue;
  }

  const canvasW = tiles.length * (TILE_W + GAP) - GAP;
  const canvasH = Math.max(...tiles.map((t) => t.h)) + LABEL_H;
  const composites = [];
  let x = 0;
  for (const t of tiles) {
    composites.push({ input: t.buf, left: x, top: LABEL_H });
    composites.push({
      input: Buffer.from(
        `<svg width="${TILE_W}" height="${LABEL_H}"><rect width="100%" height="100%" fill="#222"/><text x="10" y="27" font-size="22" fill="white" font-family="sans-serif">${t.variant}</text></svg>`,
      ),
      left: x,
      top: 0,
    });
    x += TILE_W + GAP;
  }

  const outPath = path.join(outDir, `${boardId}.png`);
  await sharp({ create: { width: canvasW, height: canvasH, channels: 3, background: "#ffffff" } })
    .composite(composites)
    .png()
    .toFile(outPath);
  console.log(outPath);
}
