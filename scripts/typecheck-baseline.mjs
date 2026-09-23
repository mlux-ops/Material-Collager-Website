// `npm run typecheck` is not pass/fail: errors that pre-date the review sit in
// the tree (see CLAUDE.md). This makes it one anyway: fail when tsc reports more
// errors than the recorded baseline, so a change can pay the debt down (then
// lower the number in typecheck-baseline.json) but never add to it.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const { errors: allowed } = JSON.parse(readFileSync(new URL("./typecheck-baseline.json", import.meta.url), "utf8"));
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const run = spawnSync(process.execPath, [tsc, "--noEmit"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
const count = (output.match(/error TS\d+/g) ?? []).length;
console.log(`tsc: ${count} error(s); baseline allows ${allowed}.`);
if (count > allowed) {
  console.log(output);
  process.exit(1);
}
