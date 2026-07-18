#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function makeIssue(severity, code, message, recordId) {
  return { severity, code, message, ...(recordId ? { recordId } : {}) };
}

function parseTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }
  return Number.NaN;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

export function validateLibraryPayload(payload, { release = false, now = Date.now() } = {}) {
  const issues = [];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      ok: false,
      items: [],
      records: [],
      issues: [makeIssue("error", "payload.invalid", "The Library response must be a JSON object.")],
    };
  }
  if (payload.ok !== true) {
    issues.push(makeIssue("error", "payload.ok", "The Library response must contain ok: true."));
  }
  if (!Array.isArray(payload.items)) {
    issues.push(makeIssue("error", "payload.items", "The Library response must contain an items array."));
    return { ok: false, items: [], records: [], issues };
  }

  const seenIds = new Set();
  const seenImageUrls = new Set();
  const records = payload.items.map((item, index) => {
    const recordIssues = [];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      recordIssues.push(makeIssue("error", "record.invalid", `items[${index}] must be an object.`));
      return { index, item, issues: recordIssues };
    }

    const id = isNonEmptyString(item.id) ? item.id.trim() : "";
    const recordId = id || `items[${index}]`;
    const requiredStrings = ["id", "title", "imageUrl", "filename", "renderKind", "collageType", "status"];
    for (const field of requiredStrings) {
      if (!isNonEmptyString(item[field])) {
        recordIssues.push(makeIssue("error", `record.${field}`, `${recordId}.${field} is required.`, id));
      }
    }

    if (id) {
      if (seenIds.has(id)) {
        recordIssues.push(makeIssue("error", "record.duplicate_id", `Duplicate Library id: ${id}.`, id));
      }
      seenIds.add(id);
    }

    if (isNonEmptyString(item.imageUrl)) {
      const imageUrl = item.imageUrl.trim();
      if (seenImageUrls.has(imageUrl)) {
        recordIssues.push(makeIssue("error", "record.duplicate_image_url", `Duplicate imageUrl: ${imageUrl}.`, id));
      }
      seenImageUrls.add(imageUrl);
    }

    if (item.status !== "completed") {
      recordIssues.push(makeIssue("error", "record.status", `${recordId} must have status completed.`, id));
    }
    if (item.renderKind !== "final") {
      recordIssues.push(makeIssue("error", "record.render_kind", `${recordId} must have renderKind final.`, id));
    }
    if (item.libraryVisible !== true) {
      recordIssues.push(makeIssue("error", "record.library_visible", `${recordId} must have libraryVisible true.`, id));
    }

    for (const field of ["createdAt", "updatedAt", "expiresAt"]) {
      if (!Number.isFinite(parseTimestamp(item[field]))) {
        recordIssues.push(makeIssue("error", `record.${field}`, `${recordId}.${field} must be a valid timestamp.`, id));
      }
    }

    const expiresAt = parseTimestamp(item.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt <= now) {
      recordIssues.push(makeIssue("error", "record.expired", `${recordId} expired at ${new Date(expiresAt).toISOString()}.`, id));
    }

    return { index, id, item, issues: recordIssues };
  });

  for (const record of records) issues.push(...record.issues);
  if (release && payload.items.length < 8) {
    issues.push(makeIssue(
      "error",
      "release.minimum_records",
      `Release mode requires at least 8 completed final Library records; found ${payload.items.length}.`,
    ));
  }

  return {
    ok: issues.every((item) => item.severity !== "error"),
    items: payload.items,
    records,
    issues,
  };
}

function resolveUrl(baseUrl, value) {
  return new URL(value, baseUrl).toString();
}

async function fetchJson(url, timeoutMs, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON from ${url}; received ${response.status} ${response.statusText}.`);
  }
  return { response, payload };
}

async function verifyPreview({ record, baseUrl, timeoutMs, fetchImpl }) {
  const id = isNonEmptyString(record.item?.id) ? record.item.id.trim() : undefined;
  const imageUrl = record.item?.imageUrl;
  if (!isNonEmptyString(imageUrl)) {
    return {
      id,
      ok: false,
      imageUrl: null,
      status: null,
      contentType: null,
      issues: [makeIssue("error", "preview.image_url", "Preview check skipped because imageUrl is invalid.", id)],
    };
  }

  const absoluteImageUrl = resolveUrl(baseUrl, imageUrl);
  try {
    const response = await fetchImpl(absoluteImageUrl, {
      headers: { Accept: "image/*" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const contentType = response.headers.get("content-type") || "";
    const issues = [];
    if (response.status !== 200) {
      issues.push(makeIssue("error", "preview.status", `${id || imageUrl} preview returned HTTP ${response.status}.`, id));
    }
    if (!contentType.toLowerCase().startsWith("image/")) {
      issues.push(makeIssue("error", "preview.content_type", `${id || imageUrl} preview returned ${contentType || "no content type"}.`, id));
    }
    if (response.body) await response.body.cancel();
    return {
      id,
      ok: issues.length === 0,
      imageUrl: absoluteImageUrl,
      status: response.status,
      contentType,
      issues,
    };
  } catch (error) {
    return {
      id,
      ok: false,
      imageUrl: absoluteImageUrl,
      status: null,
      contentType: null,
      issues: [makeIssue(
        "error",
        "preview.fetch",
        `${id || imageUrl} preview could not be fetched: ${error instanceof Error ? error.message : String(error)}`,
        id,
      )],
    };
  }
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

export async function validateLibrary({
  baseUrl,
  release = false,
  timeoutMs = 15000,
  fetchImpl = fetch,
  now = Date.now(),
} = {}) {
  if (!baseUrl) throw new Error("baseUrl is required.");
  const normalizedBaseUrl = new URL(baseUrl).toString();
  const apiUrl = resolveUrl(normalizedBaseUrl, "/api/library");
  const generatedAt = new Date(now).toISOString();
  const topLevelIssues = [];
  let api = { url: apiUrl, status: null, contentType: null };
  let payload = null;
  let payloadValidation = { ok: false, items: [], records: [], issues: [] };
  let previews = [];

  try {
    const result = await fetchJson(apiUrl, timeoutMs, fetchImpl);
    api = {
      url: apiUrl,
      status: result.response.status,
      contentType: result.response.headers.get("content-type"),
    };
    payload = result.payload;
    if (result.response.status !== 200) {
      topLevelIssues.push(makeIssue("error", "api.status", `GET /api/library returned HTTP ${result.response.status}.`));
    }
    payloadValidation = validateLibraryPayload(payload, { release, now });
    previews = await mapWithConcurrency(payloadValidation.records, 4, (record) => verifyPreview({
      record,
      baseUrl: normalizedBaseUrl,
      timeoutMs,
      fetchImpl,
    }));
  } catch (error) {
    topLevelIssues.push(makeIssue(
      "error",
      "api.fetch",
      `GET /api/library failed: ${error instanceof Error ? error.message : String(error)}`,
    ));
  }

  const issues = [
    ...topLevelIssues,
    ...payloadValidation.issues,
    ...previews.flatMap((preview) => preview.issues),
  ];
  const errorCount = issues.filter((item) => item.severity === "error").length;
  const warningCount = issues.filter((item) => item.severity === "warning").length;
  const report = {
    generatedAt,
    baseUrl: normalizedBaseUrl,
    releaseMode: release,
    ok: errorCount === 0,
    api,
    summary: {
      recordCount: payloadValidation.items.length,
      previewChecks: previews.length,
      previewPasses: previews.filter((preview) => preview.ok).length,
      errorCount,
      warningCount,
    },
    issues,
    records: payloadValidation.records.map((record, index) => ({
      id: record.id || null,
      title: record.item?.title ?? null,
      imageUrl: record.item?.imageUrl ?? null,
      filename: record.item?.filename ?? null,
      renderKind: record.item?.renderKind ?? null,
      collageType: record.item?.collageType ?? null,
      status: record.item?.status ?? null,
      createdAt: record.item?.createdAt ?? null,
      updatedAt: record.item?.updatedAt ?? null,
      expiresAt: record.item?.expiresAt ?? null,
      fieldIssues: record.issues,
      preview: previews[index] ?? null,
    })),
    rawPayload: payload,
  };
  return report;
}

async function writeJson(filePath, value) {
  const absolutePath = path.resolve(filePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return absolutePath;
}

function parseArgs(argv) {
  const args = { release: false, timeoutMs: 15000 };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--release") {
      args.release = true;
    } else if (value === "--base-url") {
      args.baseUrl = argv[index + 1];
      index += 1;
    } else if (value === "--output") {
      args.output = argv[index + 1];
      index += 1;
    } else if (value === "--records-output") {
      args.recordsOutput = argv[index + 1];
      index += 1;
    } else if (value === "--timeout-ms") {
      args.timeoutMs = Number(argv[index + 1]);
      index += 1;
    } else if (value === "--help" || value === "-h") {
      args.help = true;
    } else if (!value.startsWith("-") && !args.baseUrl) {
      args.baseUrl = value;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive number.");
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/validate-release-library.mjs --base-url <url> [options]\n\nOptions:\n  --release                Require at least eight completed final records\n  --output <path>          Write the full JSON validation report\n  --records-output <path>  Write the raw Library payload snapshot\n  --timeout-ms <number>    Per-request timeout (default: 15000)\n  -h, --help               Show this help`);
}

export async function runLibraryCli(argv = process.argv.slice(2)) {
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
  if (!args.baseUrl) {
    printHelp();
    return 1;
  }

  let report;
  try {
    report = await validateLibrary(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  if (args.output) {
    console.log(`Report: ${await writeJson(args.output, report)}`);
  }
  if (args.recordsOutput) {
    console.log(`Records: ${await writeJson(args.recordsOutput, {
      generatedAt: report.generatedAt,
      baseUrl: report.baseUrl,
      items: report.rawPayload?.items ?? [],
    })}`);
  }

  console.log(`Library: ${report.api.url}`);
  console.log(`Mode: ${report.releaseMode ? "release" : "contract"}`);
  console.log(`Records: ${report.summary.recordCount}`);
  console.log(`Previews: ${report.summary.previewPasses}/${report.summary.previewChecks} passed`);
  console.log(`Result: ${report.ok ? "PASS" : "FAIL"}`);
  for (const item of report.issues) {
    const output = item.severity === "warning" ? console.warn : console.error;
    output(`- [${item.code}] ${item.message}`);
  }
  return report.ok ? 0 : 1;
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) {
  process.exitCode = await runLibraryCli();
}
