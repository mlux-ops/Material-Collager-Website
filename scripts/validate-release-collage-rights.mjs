#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const ALLOWED_RIGHTS_BASES = new Set(["owned", "licensed", "permission"]);

function issue(code, message, assetKey) {
  return { severity: "error", code, message, ...(assetKey ? { assetKey } : {}) };
}

function isIsoDateTime(value) {
  return typeof value === "string" && value.trim() !== "" && Number.isFinite(Date.parse(value));
}

function validateSourceAsset(sourceAsset, index, assetKey) {
  const issues = [];
  if (!sourceAsset || typeof sourceAsset !== "object" || Array.isArray(sourceAsset)) {
    return [issue("source_asset.invalid", `sourceAssets[${index}] must be an object.`, assetKey)];
  }
  if (typeof sourceAsset.description !== "string" || sourceAsset.description.trim() === "") {
    issues.push(issue("source_asset.description", `sourceAssets[${index}].description is required.`, assetKey));
  }
  if (!ALLOWED_RIGHTS_BASES.has(sourceAsset.rightsBasis)) {
    issues.push(issue(
      "source_asset.rights_basis",
      `sourceAssets[${index}].rightsBasis must be owned, licensed, or permission.`,
      assetKey,
    ));
  }
  if (
    sourceAsset.reference !== undefined
    && (typeof sourceAsset.reference !== "string" || sourceAsset.reference.trim() === "")
  ) {
    issues.push(issue("source_asset.reference", `sourceAssets[${index}].reference must be a non-empty string.`, assetKey));
  }
  return issues;
}

export function validateRightsManifest(manifest, { release = false } = {}) {
  const issues = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { ok: false, issues: [issue("manifest.invalid", "The rights manifest must be a JSON object.")], collageCount: 0 };
  }

  if (manifest.version !== 1) {
    issues.push(issue("manifest.version", "version must be 1."));
  }
  if (!Array.isArray(manifest.collages)) {
    issues.push(issue("manifest.collages", "collages must be an array."));
    return { ok: false, issues, collageCount: 0 };
  }

  const seenAssetKeys = new Set();
  for (const [index, collage] of manifest.collages.entries()) {
    const context = `collages[${index}]`;
    if (!collage || typeof collage !== "object" || Array.isArray(collage)) {
      issues.push(issue("collage.invalid", `${context} must be an object.`));
      continue;
    }

    const assetKey = typeof collage.assetKey === "string" ? collage.assetKey.trim() : "";
    if (!assetKey) {
      issues.push(issue("collage.asset_key", `${context}.assetKey is required.`));
    } else if (!/^[a-z0-9][a-z0-9._-]*$/.test(assetKey)) {
      issues.push(issue("collage.asset_key_format", `${context}.assetKey must use lowercase letters, numbers, dots, underscores, or hyphens.`, assetKey));
    } else if (seenAssetKeys.has(assetKey)) {
      issues.push(issue("collage.asset_key_duplicate", `Duplicate assetKey: ${assetKey}.`, assetKey));
    } else {
      seenAssetKeys.add(assetKey);
    }

    if (typeof collage.title !== "string" || collage.title.trim() === "") {
      issues.push(issue("collage.title", `${context}.title is required.`, assetKey));
    }
    if (typeof collage.approvedForPublicPreview !== "boolean") {
      issues.push(issue("collage.preview_approval", `${context}.approvedForPublicPreview must be boolean.`, assetKey));
    }
    if (typeof collage.approvedForDownload !== "boolean") {
      issues.push(issue("collage.download_approval", `${context}.approvedForDownload must be boolean.`, assetKey));
    }
    if (!ALLOWED_RIGHTS_BASES.has(collage.rightsBasis)) {
      issues.push(issue("collage.rights_basis", `${context}.rightsBasis must be owned, licensed, or permission.`, assetKey));
    }
    if (typeof collage.approvedBy !== "string" || collage.approvedBy.trim() === "") {
      issues.push(issue("collage.approved_by", `${context}.approvedBy is required.`, assetKey));
    }
    if (!isIsoDateTime(collage.approvedAt)) {
      issues.push(issue("collage.approved_at", `${context}.approvedAt must be an ISO-8601 date-time.`, assetKey));
    }
    if (!Array.isArray(collage.sourceAssets) || collage.sourceAssets.length === 0) {
      issues.push(issue("collage.source_assets", `${context}.sourceAssets must contain at least one entry.`, assetKey));
    } else {
      for (const [sourceIndex, sourceAsset] of collage.sourceAssets.entries()) {
        issues.push(...validateSourceAsset(sourceAsset, sourceIndex, assetKey));
      }
    }
    if (collage.notes !== undefined && typeof collage.notes !== "string") {
      issues.push(issue("collage.notes", `${context}.notes must be a string.`, assetKey));
    }

    if (release) {
      if (collage.approvedForPublicPreview !== true) {
        issues.push(issue("release.preview_not_approved", `${assetKey || context} is not approved for public preview.`, assetKey));
      }
      if (collage.approvedForDownload !== true) {
        issues.push(issue("release.download_not_approved", `${assetKey || context} is not approved for download.`, assetKey));
      }
    }
  }

  if (release && manifest.collages.length < 8) {
    issues.push(issue("release.minimum_collages", `Release mode requires at least 8 approved collages; found ${manifest.collages.length}.`));
  }

  return {
    ok: issues.length === 0,
    collageCount: manifest.collages.length,
    issues,
  };
}

function parseArgs(argv) {
  const args = {
    file: "docs/release-collage-rights.json",
    release: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--release") {
      args.release = true;
    } else if (value === "--file") {
      args.file = argv[index + 1];
      index += 1;
    } else if (value === "--help" || value === "-h") {
      args.help = true;
    } else if (!value.startsWith("-") && args.file === "docs/release-collage-rights.json") {
      args.file = value;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/validate-release-collage-rights.mjs [options]\n\nOptions:\n  --file <path>  Rights manifest path (default: docs/release-collage-rights.json)\n  --release      Require at least eight fully approved collages\n  -h, --help     Show this help`);
}

export async function runRightsCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }

  const filePath = path.resolve(args.file);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    console.error(`Rights manifest could not be read: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const result = validateRightsManifest(manifest, { release: args.release });
  console.log(`Rights manifest: ${filePath}`);
  console.log(`Mode: ${args.release ? "release" : "schema"}`);
  console.log(`Collages: ${result.collageCount}`);
  console.log(`Result: ${result.ok ? "PASS" : "FAIL"}`);
  for (const item of result.issues) {
    console.error(`- [${item.code}] ${item.message}`);
  }
  return result.ok ? 0 : 1;
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) {
  process.exitCode = await runRightsCli();
}
