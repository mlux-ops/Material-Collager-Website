// Verification screenshot script. Not part of the app build.
// Run: node scripts/shoot-dither-lab.mjs
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.MC_BASE_URL || "http://localhost:5312";
const OUT_DIR = "artifacts/dither-lab";

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await page.goto(`${BASE}/dither-lab`, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);

  // 1. Progress states, bayer mode
  const progressButtons = [0, 0.15, 0.35, 0.55, 0.75, 1];
  for (const p of progressButtons) {
    await page.click(`[data-testid="progress-${p}"]`);
    // allow the eased tween to settle
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${OUT_DIR}/bayer-progress-${p}.png` });
  }

  // 2. Halftone mode at mid progress
  await page.click('[data-testid="mode-halftone"]');
  await page.click('[data-testid="progress-0.35"]');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT_DIR}/halftone-progress-0.35.png` });
  await page.click('[data-testid="mode-bayer"]');

  // 3. Indeterminate/hold state (shimmer) -- capture two frames apart to prove motion
  await page.click('[data-testid="progress-indeterminate"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT_DIR}/hold-frame-1.png` });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT_DIR}/hold-frame-2.png` });

  // 4. Discrete-jump autoplay: mid-sequence + final handoff to <img>
  await page.click('[data-testid="progress-autoplay"]');
  await page.waitForTimeout(700); // partway through first tween
  await page.screenshot({ path: `${OUT_DIR}/autoplay-midtween.png` });
  await page.waitForTimeout(4500); // let all 4 stages land, hand off to <img>
  await page.screenshot({ path: `${OUT_DIR}/autoplay-settled-img.png` });
  const finalIsImg = await page.evaluate(() => {
    const wrap = document.querySelector('[data-testid="dither-reveal-wrap"]');
    return !!wrap?.querySelector("img") && !wrap?.querySelector("canvas");
  });
  console.log("Final state is plain <img> (canvas removed):", finalIsImg);

  // 5. Cell size variants
  await page.click('[data-testid="progress-0.55"]');
  for (const c of [2, 3, 6]) {
    await page.click(`[data-testid="cell-${c}"]`);
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `${OUT_DIR}/cell-${c}-progress-0.55.png` });
  }
  await page.click('[data-testid="cell-4"]');

  // 6. Full page (grain overlay + count-up + hover-focus grid) baseline
  await page.click('[data-testid="progress-1"]');
  await page.waitForTimeout(1000);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT_DIR}/full-page-bottom.png`, fullPage: false });

  // 7. Hover-focus grid: hover item 3, siblings should drop to ~60% opacity
  const item = page.locator('[data-testid="focus-grid"] .focus-grid-item').nth(2);
  await item.hover();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT_DIR}/hover-focus-grid.png` });

  // 8. FPS measurement during an active tween (bayer, cell=3, big jump)
  await page.click('[data-testid="cell-3"]');
  await page.click('[data-testid="progress-0"]');
  await page.waitForTimeout(300);
  await page.click('[data-testid="progress-1"]');
  await page.waitForTimeout(2200); // let FPS meter average over ~2s of active tween
  const fpsText = await page.locator('[data-testid="fps-readout"]').textContent();
  console.log("FPS readout during tween (cell=3):", fpsText);
  await page.screenshot({ path: `${OUT_DIR}/fps-cell3.png` });

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
