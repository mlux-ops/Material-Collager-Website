import type { NodeManifest } from "../types";
import { CLI_EFFORTS } from "./cliAssistant.manifest.ts";

// Prompt Expert: writes a GPT Image 2.6 prompt through the local CLI bridge
// (`npm run cli-bridge`), on the codex CLI and the user's ChatGPT plan. The
// bridge prepends its own instruction file for the persona below
// (scripts/cli-bridge/personas/gpt-image-2-6-prompting.md), so the answer is
// prompt text only, ready for an Image Generation, Image Edit or Test node's
// Prompt port. The model is fixed; only the effort is picked on the node.
export const PROMPT_EXPERT_PROVIDER = "codex" as const;
export const PROMPT_EXPERT_MODEL = "gpt-6-astra";
export const PROMPT_EXPERT_PERSONA = "gpt-image-2.6-prompting";

// Not `paid`, like the CLI nodes: a subscription run has no per-call charge.
export const promptExpertManifest: NodeManifest = {
  kind: "promptExpert",
  spec: {
    kind: "promptExpert",
    title: "Prompt Expert",
    description: "Write a GPT Image 2.6 prompt with gpt-6-astra through the codex CLI on this computer, on your ChatGPT subscription. Needs npm run cli-bridge.",
    inputs: [
      // Same ids as the CLI nodes, so the wiring code is shared. Images are
      // numbered Image 1, Image 2, ... in wire order in the written prompt.
      { id: "image", kind: "image", label: "Images", multi: true, acceptedKinds: ["image", "references"] },
      { id: "text", kind: "text", label: "Context" },
    ],
    outputs: [{ id: "text", kind: "text", label: "Prompt" }],
  },
  defaultParams: { instruction: "", effort: "default" },
  importSchema: {
    paramKeys: {
      instruction: { type: "string", optional: true, maxLength: 4_000 },
      effort: { type: "enum", optional: true, values: CLI_EFFORTS },
    },
    sourceBlobKeys: [],
  },
};
