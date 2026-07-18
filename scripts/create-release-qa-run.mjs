#!/usr/bin/env node

import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--date") {
      args.date = argv[index + 1];
      index += 1;
    } else if (value === "--commit") {
      args.commit = argv[index + 1];
      index += 1;
    } else if (value === "--base-url") {
      args.baseUrl = argv[index + 1];
      index += 1;
    } else if (value === "--help" || value === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/create-release-qa-run.mjs [options]\n\nOptions:\n  --date <YYYY-MM-DD>  Evidence date (default: today)\n  --commit <sha>       Release-candidate commit\n  --base-url <url>     Private staging/review URL\n  -h, --help           Show this help`);
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

export async function createReleaseQaRun({
  date = new Date().toISOString().slice(0, 10),
  commit = "REPLACE_WITH_RELEASE_CANDIDATE_COMMIT",
  baseUrl = "https://REPLACE_WITH_PRIVATE_STAGING_URL",
  rootDir = process.cwd(),
} = {}) {
  if (!validDate(date)) throw new Error("date must use YYYY-MM-DD.");
  const root = path.resolve(rootDir);
  const target = path.join(root, "artifacts", "release-qa", date);
  const templateRoot = path.join(root, "artifacts", "release-qa", "templates");
  await mkdir(path.join(target, "screenshots"), { recursive: true });
  await mkdir(path.join(target, "recordings"), { recursive: true });

  const candidate = {
    createdAt: new Date().toISOString(),
    releaseCandidateCommit: commit,
    stagingBaseUrl: baseUrl,
    environment: "private-staging",
    d1Binding: "DB",
    r2Binding: "OUTPUTS",
    productionResourcesUsed: false,
    notes: "Confirm the deployed commit and staging bindings before generating release data.",
  };
  await writeFile(path.join(target, "release-candidate.json"), `${JSON.stringify(candidate, null, 2)}\n`, "utf8");
  await writeFile(path.join(target, "desktop-chrome-performance-run-1.json"), "{}\n", "utf8");
  await writeFile(path.join(target, "desktop-chrome-performance-run-2.json"), "{}\n", "utf8");
  await writeFile(path.join(target, "desktop-chrome-performance-run-3.json"), "{}\n", "utf8");
  await cp(path.join(templateRoot, "iphone-safari-checklist.md"), path.join(target, "iphone-safari-checklist.md"));
  await cp(path.join(templateRoot, "android-checklist.md"), path.join(target, "android-checklist.md"));
  await cp(path.join(templateRoot, "console-and-context-recovery.md"), path.join(target, "console-and-context-recovery.md"));
  return target;
}

export async function runScaffoldCli(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  if (args.help) {
    printHelp();
    return 0;
  }
  try {
    const target = await createReleaseQaRun(args);
    console.log(`Created release QA evidence directory: ${target}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) {
  process.exitCode = await runScaffoldCli();
}
