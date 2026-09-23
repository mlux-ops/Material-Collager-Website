import assert from "node:assert/strict";
import test from "node:test";

import { assessCheck, assessPrecheck } from "../scripts/typecheck-baseline.mjs";

// Every fixture is tsc 5.9.3's own `--noEmit --pretty false` output for its case.
const run = (stdout, status) => ({ stdout, stderr: "", status, signal: null });

// A checkout whose node_modules lacks @cloudflare/workers-types, with the line
// endings tsc printed on Windows. This is everything tsc reports: it stops
// before checking a single file.
const MISSING_TYPES = [
  "error TS2688: Cannot find type definition file for '@cloudflare/workers-types'.",
  "  The file is in the program because:",
  "    Entry point of type library '@cloudflare/workers-types' specified in compilerOptions",
  "",
].join("\r\n");

const sourceErrors = (count) =>
  Array.from(
    { length: count },
    (_, i) => `app/components/workbench/WorkbenchApp.tsx(${i + 1},7): error TS2322: Type 'string' is not assignable to type 'number'.\n`,
  ).join("");

test("a run stopped by an unresolved types entry fails, though its one error is under the baseline", () => {
  const precheck = assessPrecheck(run(`${MISSING_TYPES}E:/repo/app/page.tsx\r\n`, 1));
  assert.equal(precheck.ok, false);
  assert.match(precheck.report, /TS2688/);

  const check = assessCheck(run(MISSING_TYPES, 2), 14);
  assert.equal(check.ok, false);
  assert.match(check.report, /^tsc did not run cleanly \(config, option or global error: TS2688\)/);
});

test("more errors than the baseline fail, with the errors printed", () => {
  const check = assessCheck(run(sourceErrors(15), 2), 14);
  assert.equal(check.ok, false);
  assert.match(check.report, /^tsc: 15 error\(s\); baseline allows 14\./);
  assert.match(check.report, /WorkbenchApp\.tsx\(15,7\): error TS2322/);
});

test("the baseline's own errors pass", () => {
  assert.deepEqual(assessCheck(run(sourceErrors(14), 2), 14), { ok: true, report: "tsc: 14 error(s); baseline allows 14." });
  assert.deepEqual(assessCheck(run("", 0), 14), { ok: true, report: "tsc: 0 error(s); baseline allows 14." });
});

// All but the unknown option stop tsc before it checks a file; that one it
// reports alongside the check, which is then not the configuration the
// baseline counts.
const SETUP_ERRORS = {
  "a missing global type": "error TS2318: Cannot find global type 'Array'.\nerror TS2318: Cannot find global type 'Boolean'.\n",
  "a files entry that does not exist":
    "error TS6053: File 'E:/repo/missing.ts' not found.\n  The file is in the program because:\n    Part of 'files' list in tsconfig.json\n",
  "a config with no inputs": `error TS18003: No inputs were found in config file 'E:/repo/tsconfig.json'. Specified 'include' paths were '["src/**/*.ts"]' and 'exclude' paths were '[]'.\n`,
  "an option conflict":
    "tsconfig.json(1,40): error TS5095: Option 'bundler' can only be used when 'module' is set to 'preserve' or to 'es2015' or later.\n",
  "an unknown option":
    "app/page.tsx(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\ntsconfig.json(1,21): error TS5023: Unknown compiler option 'bogusOption'.\n",
};
for (const [cause, output] of Object.entries(SETUP_ERRORS)) {
  test(`${cause} fails the gate`, () => {
    const check = assessCheck(run(output, 2), 14);
    assert.equal(check.ok, false);
    assert.match(check.report, /^tsc did not run cleanly \(config, option or global error: TS\d+\)/);
  });
}

test("an error in a source file counts toward the baseline, whatever its code", () => {
  // noUnusedLocals reports TS6133, and a bad `/// <reference types>` TS2688, in
  // the file itself; neither stops the check.
  const output =
    "c.ts(1,29): error TS6133: 'unused' is declared but its value is never read.\n" +
    "d.ts(1,23): error TS2688: Cannot find type definition file for 'nope'.\n";
  assert.deepEqual(assessCheck(run(output, 2), 14), { ok: true, report: "tsc: 2 error(s); baseline allows 14." });
});

test("a syntax error fails the precheck, whose report leaves out the file list", () => {
  // The real run prints only this error: it skips every type check.
  const precheck = assessPrecheck(run("b.ts(1,7): error TS1134: Variable declaration expected.\nE:/repo/a.ts\nE:/repo/b.ts\n", 1));
  assert.deepEqual(precheck, {
    ok: false,
    report: "tsc did not run cleanly (config, option or syntax error: TS1134).\nb.ts(1,7): error TS1134: Variable declaration expected.",
  });
});

test("a precheck that only lists files passes", () => {
  assert.equal(assessPrecheck(run("E:/repo/a.ts\nE:/repo/b.ts\n", 0)).ok, true);
});

test("a tsc that never ran, was killed, or exited non-zero without a diagnostic fails", () => {
  const broken = [
    { stdout: "", stderr: "", status: null, signal: null, error: new Error("spawnSync node ENOENT") },
    { stdout: "", stderr: "", status: null, signal: "SIGTERM" },
    run("Version 5.9.3\ntsc: The TypeScript Compiler - Version 5.9.3\n", 1),
  ];
  for (const result of broken) {
    assert.equal(assessPrecheck(result).ok, false);
    assert.equal(assessCheck(result, 14).ok, false);
  }
});
