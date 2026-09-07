// Measures prompt text only, not billed image/text tokens or rendering quality.
// Run with the pre-optimization revision to reproduce the comparison.
import { execFileSync } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";
import { buildGenerationPrompt } from "../app/lib/collage.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const revision = process.argv[2] || "1e5dee9";
if (!/^[a-zA-Z0-9._/-]+$/.test(revision) || revision.startsWith("-")) throw new Error("Supply a Git revision.");
const source = execFileSync("git", ["show", `${revision}:app/lib/collage.ts`], { cwd: root, encoding: "utf8" });
const baseline = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`);
const items = [
  { id: "faucet", role: "vanity faucet", finish: "matte black", imageNames: ["faucet.png"] },
  { id: "tile", role: "wall tile", imageNames: ["tile.png"] },
  { id: "wood", role: "vanity wood", imageNames: ["wood.png"] },
];
const base = { collageType: "bathroom_fixture_collage", orientation: "landscape", quality: "high", items };
const fixtures = {
  "Single views": base,
  "Supporting views": { ...base, items: [{ ...items[0], imageNames: ["front.png", "side.png", "detail.png"] }, ...items.slice(1)] },
  "Approved draft": { ...base, layoutReference: true, outputResolution: "final" },
  "Uploaded layout": { ...base, layoutReference: true, layoutReferenceMode: "uploaded-collage" },
};
for (const [name, request] of Object.entries(fixtures)) {
  const before = baseline.buildGenerationPrompt(request).length;
  const after = buildGenerationPrompt(request).length;
  console.log(JSON.stringify({ name, beforeCharacters: before, afterCharacters: after, reductionPercent: Math.round((1 - after / before) * 1000) / 10 }));
}
