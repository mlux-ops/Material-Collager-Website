"use client";

import type { Edge } from "@xyflow/react";
import { readApiResponse } from "@/app/lib/api-client";
import { getBlob } from "./blob-cache";
import { collectFinalImageOutputs } from "./final-outputs";
import type { WorkbenchNode } from "./types";

const AUTO_SAVE_PREFERENCE_KEY = "mc.workbench.autoSaveFinalOutput";
const AUTO_SAVED_IDENTITIES_KEY = "mc.workbench.autoSavedFinalIdentities.v1";
const MAX_SAVED_IDENTITIES = 500;

export function readAutoSaveFinalPreference(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(AUTO_SAVE_PREFERENCE_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeAutoSaveFinalPreference(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(AUTO_SAVE_PREFERENCE_KEY, String(enabled));
  } catch {
    // The toggle still applies for this tab when storage is unavailable.
  }
}

function readSavedIdentities(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const parsed = JSON.parse(window.localStorage.getItem(AUTO_SAVED_IDENTITIES_KEY) || "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : []);
  } catch {
    return new Set();
  }
}

function writeSavedIdentities(identities: Set<string>): void {
  if (typeof window === "undefined") return;
  const capped = [...identities].slice(-MAX_SAVED_IDENTITIES);
  try {
    window.localStorage.setItem(AUTO_SAVED_IDENTITIES_KEY, JSON.stringify(capped));
  } catch {
    // Deduplication is best-effort; saving the actual library image already
    // succeeded and must not be reported as failed because localStorage is
    // blocked or full.
  }
}

export type AutoSaveFinalResult = {
  saved: number;
  skipped: number;
  failures: string[];
};

export async function autoSaveFinalOutputs(nodes: WorkbenchNode[], edges: Edge[]): Promise<AutoSaveFinalResult> {
  const outputs = collectFinalImageOutputs(nodes, edges);
  const savedIdentities = readSavedIdentities();
  const result: AutoSaveFinalResult = { saved: 0, skipped: 0, failures: [] };

  for (const [index, output] of outputs.entries()) {
    if (savedIdentities.has(output.identity)) {
      result.skipped += 1;
      continue;
    }
    const blob = getBlob(output.value.cacheKey);
    if (!blob) {
      result.failures.push(`${output.nodeId}: final image is no longer cached`);
      continue;
    }

    const safeNodeId = output.nodeId.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 80) || "workbench";
    const filename = `${safeNodeId}-final-${index + 1}.png`;
    const file = new File([blob], filename, { type: blob.type || "image/png" });
    const form = new FormData();
    form.append("payload", JSON.stringify({
      filename,
      prompt: "Automatically saved final workbench output",
      format: "workbench",
    }));
    form.append("image", file, filename);

    try {
      await fetch("/api/workbench/save", { method: "POST", body: form })
        .then((response) => readApiResponse<{ ok: boolean; jobId: string }>(response));
      savedIdentities.add(output.identity);
      result.saved += 1;
    } catch (error) {
      result.failures.push(`${output.nodeId}: ${error instanceof Error ? error.message : "save failed"}`);
    }
  }

  writeSavedIdentities(savedIdentities);
  return result;
}
