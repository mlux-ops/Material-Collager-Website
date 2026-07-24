import type { NodeManifest } from "../types";

export const textManifest: NodeManifest = {
  kind: "text",
  spec: {
    kind: "text",
    title: "Text",
    description: "A prompt or instruction fragment.",
    inputs: [],
    outputs: [{ id: "text", kind: "text", label: "Text" }],
  },
  defaultParams: { text: "" },
  importSchema: {
    paramKeys: {
      text: { type: "string", optional: true, maxLength: 20_000 },
    },
    sourceBlobKeys: [],
  },
  execute: async (ctx) => {
    const text = (ctx.params.text ?? "").trim();
    if (!text) throw new Error("Enter some text first.");
    ctx.applyRun({
      runId: ctx.createRunId(),
      signature: ctx.signature,
      at: Date.now(),
      values: [[{ kind: "text", text }]],
    });
  },
};
