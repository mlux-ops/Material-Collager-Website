import type { NodeKind, NodeManifest } from "../types";

// Claude CLI / Codex CLI nodes: the AI Assistant's text-in/text-out contract,
// answered by the `claude` or `codex` CLI on the user's own computer through
// the local bridge (scripts/cli-bridge/server.mjs, `npm run cli-bridge`) so it
// runs on their Claude / ChatGPT subscription instead of an API key. The
// browser calls the bridge directly — the Worker cannot reach the user's
// loopback — so the node works from local dev and the deployed site alike,
// but only on a computer where the bridge is running.
export const CLI_BRIDGE_ORIGIN = "http://127.0.0.1:4795";

export type CliProvider = "claude" | "codex";

// Mirrors the bridge's allowlist (scripts/cli-bridge/lib.mjs PROVIDERS) for
// the model selector only; the bridge is the enforcement point. Codex's
// "default" sends no model flag — the ChatGPT plan picks.
export const CLI_MODELS: Record<CliProvider, readonly string[]> = {
  claude: ["sonnet", "opus", "haiku"],
  codex: ["default", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
};
export const CLI_DEFAULT_MODEL: Record<CliProvider, string> = {
  claude: "sonnet",
  codex: "default",
};

// Not `paid`: a subscription run has no per-call charge to estimate, and the
// CLI's own total_cost_usd is a list-price figure, not a bill.
function cliManifest(kind: NodeKind, provider: CliProvider, title: string, description: string): NodeManifest {
  return {
    kind,
    spec: {
      kind,
      title,
      description,
      inputs: [
        { id: "image", kind: "image", label: "Image" },
        { id: "text", kind: "text", label: "Context" },
      ],
      outputs: [{ id: "text", kind: "text", label: "Answer" }],
    },
    defaultParams: { instruction: "", model: CLI_DEFAULT_MODEL[provider] },
    importSchema: {
      paramKeys: {
        instruction: { type: "string", optional: true, maxLength: 4_000 },
        model: { type: "enum", optional: true, values: CLI_MODELS[provider] },
      },
      sourceBlobKeys: [],
    },
  };
}

export const claudeCliManifest = cliManifest(
  "claudeCli",
  "claude",
  "Claude CLI",
  "Ask Claude through the claude CLI on this computer, on your Claude subscription. Needs npm run cli-bridge.",
);

export const codexCliManifest = cliManifest(
  "codexCli",
  "codex",
  "Codex CLI",
  "Ask ChatGPT through the codex CLI on this computer, on your ChatGPT subscription. Needs npm run cli-bridge.",
);
