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
// tsc exits non-zero exactly when it reports errors. A run that never started,
// was killed, or exited non-zero without a single diagnostic (its help text when
// no tsconfig.json is found, a crash) must not read as a clean 0: that would
// wave through the broken setup this gate exists to catch.
if (run.error || run.signal || (run.status !== 0 && count === 0)) {
  console.log(`tsc did not run cleanly (${run.error?.message ?? run.signal ?? `exit ${run.status}`}).`);
  console.log(output);
  process.exit(1);
}
// Every baseline error has a location ("path(line,col): error TS…"). One with
// none — a missing @types package, a bad tsconfig — means tsc never checked the
// project as configured, so a count under the baseline proves nothing.
const unlocated = output.split(/\r?\n/).filter((line) => /^error TS\d+/.test(line.trim()));
if (unlocated.length > 0) {
  console.log(`tsc could not check the project:\n${unlocated.join("\n")}`);
  process.exit(1);
}
console.log(`tsc: ${count} error(s); baseline allows ${allowed}.`);
if (count > allowed) {
  console.log(output);
  process.exit(1);
}
