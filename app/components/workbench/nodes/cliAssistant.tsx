"use client";

import { memo, useEffect, useState } from "react";
import { fileToBase64 } from "@/app/lib/image-transport";
import { useWorkbenchStore } from "../store";
import styles from "../workbench.module.css";
import type { ExecuteContext, NodeOutputValue } from "../types";
import { CLI_BRIDGE_ORIGIN, CLI_DEFAULT_MODEL, CLI_MODELS, type CliProvider } from "./cliAssistant.manifest";
import { imageCacheKeysFromValue } from "./generation";
import { fileFromCacheKey, NodeShell, RunFooter, useConnectedImageCount, type WorkbenchNodeProps } from "./shared";

const OFFLINE_HINT = "CLI helper not running — start it on this computer with npm run cli-bridge.";
const HEALTH_TTL_MS = 15_000;
const HEALTH_TIMEOUT_MS = 2_000;

type ProviderHealth = { available: boolean; reason?: string };
type BridgeHealth = { online: false } | { online: true; providers: Partial<Record<CliProvider, ProviderHealth>> };

// One shared probe for every CLI node on the canvas, refreshed at most every
// HEALTH_TTL_MS, so a graph with several of them makes one request.
let healthCache: { at: number; promise: Promise<BridgeHealth> } | null = null;

function probeBridge(): Promise<BridgeHealth> {
  if (healthCache && Date.now() - healthCache.at < HEALTH_TTL_MS) return healthCache.promise;
  const promise = fetch(`${CLI_BRIDGE_ORIGIN}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
    .then((response) => response.json() as Promise<{ ok?: boolean; providers?: Partial<Record<CliProvider, ProviderHealth>> }>)
    .then((body): BridgeHealth => (body.ok ? { online: true, providers: body.providers ?? {} } : { online: false }))
    .catch((): BridgeHealth => ({ online: false }));
  healthCache = { at: Date.now(), promise };
  return promise;
}

function healthHint(health: BridgeHealth | null, provider: CliProvider): string | null {
  if (!health) return null;
  if (!health.online) return OFFLINE_HINT;
  const state = health.providers[provider];
  if (!state) return `CLI helper has no ${provider} provider.`;
  return state.available ? null : `Unavailable: ${state.reason ?? "unknown reason"}`;
}

function CliNodeBody({ id, data, provider }: WorkbenchNodeProps & { provider: CliProvider }) {
  const updateParams = useWorkbenchStore((state) => state.updateParams);
  const inputImages = useConnectedImageCount(id, ["image"]);
  const [health, setHealth] = useState<BridgeHealth | null>(null);
  useEffect(() => {
    let live = true;
    void probeBridge().then((result) => { if (live) setHealth(result); });
    return () => { live = false; };
  }, [data.status]);
  const run = data.runs[data.activeRun];
  const answer = run?.values[0]?.find((value) => value.kind === "text");
  const models = CLI_MODELS[provider];
  const hint = healthHint(health, provider);
  return (
    <NodeShell data={data} footer={<RunFooter id={id} data={data} inputImages={inputImages} />}>
      {models.length > 1 && (
        <label className={styles.field}>
          <span>Model</span>
          <select
            className="nodrag"
            value={data.params.model ?? CLI_DEFAULT_MODEL[provider]}
            onChange={(event) => updateParams(id, { model: event.target.value })}
          >
            {models.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
      )}
      <textarea
        className={`${styles.textarea} nodrag nowheel`}
        rows={3}
        placeholder="Ask a question…"
        value={data.params.instruction ?? ""}
        onChange={(event) => updateParams(id, { instruction: event.target.value })}
      />
      {hint && <p className={styles.hint}>{hint}</p>}
      {answer && answer.kind === "text" && (
        <p className={styles.hint} style={{ whiteSpace: "pre-wrap" }}>{answer.text}</p>
      )}
    </NodeShell>
  );
}

export const ClaudeCliComponent = memo(function ClaudeCliNode(props: WorkbenchNodeProps) {
  return <CliNodeBody {...props} provider="claude" />;
});

export const CodexCliComponent = memo(function CodexCliNode(props: WorkbenchNodeProps) {
  return <CliNodeBody {...props} provider="codex" />;
});

// Same input handling as the AI Assistant's execute, posted to the local
// bridge instead of /api/workbench/assist. The answer is a plain Text value.
function cliExecute(provider: CliProvider) {
  return async (ctx: ExecuteContext): Promise<void> => {
    const instruction = (ctx.params.instruction ?? "").trim();
    if (!instruction) throw new Error("Enter an instruction for the assistant.");

    const requestedModel = String(ctx.params.model ?? "").trim();
    const model = CLI_MODELS[provider].find((entry) => entry === requestedModel) ?? CLI_DEFAULT_MODEL[provider];

    const contextText = ctx.inputs("text")
      .filter((value): value is Extract<NodeOutputValue, { kind: "text" }> => value.kind === "text")
      .map((value) => value.text)
      .filter(Boolean)
      .join("\n\n");
    const combinedInstruction = contextText ? `${instruction}\n\nContext:\n${contextText}` : instruction;

    const imageKeys = ctx.inputs("image").flatMap(imageCacheKeysFromValue);
    if (imageKeys.length > 16) throw new Error("Connect at most 16 images to the assistant.");
    const images = await Promise.all(imageKeys.map(async (key) => {
      const file = fileFromCacheKey(key);
      return { imageBase64: await fileToBase64(file), mimeType: file.type || "image/png" };
    }));

    ctx.setProgress(provider === "claude" ? "Asking Claude…" : "Asking Codex…");
    let response: Response;
    try {
      response = await fetch(`${CLI_BRIDGE_ORIGIN}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctx.signal,
        body: JSON.stringify({ provider, model, instruction: combinedInstruction, images }),
      });
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      healthCache = null;
      throw new Error(OFFLINE_HINT);
    }
    const body = await response.json().catch(() => null) as { ok?: boolean; text?: string; error?: string } | null;
    if (!response.ok || !body?.ok || typeof body.text !== "string") {
      throw new Error(body?.error || `CLI helper answered HTTP ${response.status}.`);
    }

    ctx.applyRun({
      runId: ctx.createRunId(),
      signature: ctx.signature,
      at: Date.now(),
      values: [[{ kind: "text", text: body.text }]],
    });
  };
}

export const claudeCliExecute = cliExecute("claude");
export const codexCliExecute = cliExecute("codex");
