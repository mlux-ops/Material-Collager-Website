// `npm run typecheck` is not pass/fail: errors that pre-date the review sit in
// the tree (see CLAUDE.md). This makes it one anyway: fail when tsc reports more
// errors than the recorded baseline, so a change can pay the debt down (then
// lower the number in typecheck-baseline.json) but never add to it.
//
// A count under the baseline means something only if tsc type-checked the
// project, and tsc stops short of that when it finds an option error (a `types`
// entry that doesn't resolve, a `files` entry that doesn't exist), a syntax
// error or a missing global type: it prints those few errors, fewer than the
// baseline, having checked no file. So those fail the gate outright, as does
// any other error in tsconfig.json. tests/typecheck-baseline.test.mjs has each.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

// A diagnostic's first line in `--pretty false` output: "path(line,col): error
// TSn: …", or "error TSn: …" when it has no location. Its continuation lines
// are indented.
const HEADER = /^(?:(.+?)\(\d+,\d+\): )?error TS(\d+): /;

function readRun(run) {
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  const diagnostics = output.split(/\r?\n/).flatMap((line) => {
    const match = HEADER.exec(line);
    return match ? [{ file: match[1] ?? null, code: `TS${match[2]}` }] : [];
  });
  // tsc exits non-zero exactly when it reports errors. A run that never started,
  // was killed, or exited non-zero without a single diagnostic (its help text
  // when no tsconfig.json is found, a crash) must not read as a clean 0: that
  // would wave through the broken setup this gate exists to catch.
  const broken =
    run.error || run.signal || (run.status !== 0 && diagnostics.length === 0)
      ? `tsc did not run cleanly (${run.error?.message ?? run.signal ?? `exit ${run.status}`}).\n${output}`
      : null;
  return { output, diagnostics, broken };
}

const codes = (diagnostics) => [...new Set(diagnostics.map((d) => d.code))].join(", ");

// The `--listFilesOnly` run: tsc resolves every option and parses every file,
// then stops short of type-checking, so each error it reports is a config,
// option or syntax error, the kinds that stop the real run early. The file list
// it prints after them stays out of the report.
export function assessPrecheck(run) {
  const { output, diagnostics, broken } = readRun(run);
  if (broken) return { ok: false, report: broken };
  if (diagnostics.length === 0) return { ok: true, report: "" };
  const shown = output.split(/\r?\n/).filter((line) => HEADER.test(line) || /^\s+\S/.test(line));
  return { ok: false, report: `tsc did not run cleanly (config, option or syntax error: ${codes(diagnostics)}).\n${shown.join("\n")}` };
}

// Every baseline error sits in a source file. One with no location, or located
// in tsconfig.json, is a config, option or global error; the precheck can't see
// a missing global type, which tsc reports only once checking starts. The
// location tells, not the code: noUnusedLocals reports TS6133 in the source
// file, and a bad `/// <reference types>` puts its TS2688 there too.
export function assessCheck(run, allowed) {
  const { output, diagnostics, broken } = readRun(run);
  if (broken) return { ok: false, report: broken };
  const setup = diagnostics.filter((d) => d.file === null || /\.json$/i.test(d.file));
  if (setup.length > 0) {
    return { ok: false, report: `tsc did not run cleanly (config, option or global error: ${codes(setup)}).\n${output}` };
  }
  const summary = `tsc: ${diagnostics.length} error(s); baseline allows ${allowed}.`;
  return diagnostics.length > allowed ? { ok: false, report: `${summary}\n${output}` } : { ok: true, report: summary };
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) {
  const { errors: allowed } = JSON.parse(readFileSync(new URL("./typecheck-baseline.json", import.meta.url), "utf8"));
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  // `--pretty false` pins the format HEADER reads, even if tsconfig.json turns `pretty` on.
  const runTsc = (...args) =>
    spawnSync(process.execPath, [tsc, "--noEmit", "--pretty", "false", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  let result = assessPrecheck(runTsc("--listFilesOnly"));
  if (result.ok) result = assessCheck(runTsc(), allowed);
  console.log(result.report);
  // exitCode rather than exit(), which can cut a long report short on a pipe.
  process.exitCode = result.ok ? 0 : 1;
}
