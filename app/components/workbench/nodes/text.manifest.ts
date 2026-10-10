import type { NodeManifest } from "../types";

export const textManifest: NodeManifest = {
  kind: "text",
  spec: {
    kind: "text",
    title: "Text",
    description: "A prompt or instruction fragment. Connect text in to edit it here.",
    inputs: [{ id: "text", kind: "text", label: "Text in" }],
    outputs: [{ id: "text", kind: "text", label: "Text" }],
  },
  defaultParams: { text: "" },
  importSchema: {
    paramKeys: {
      text: { type: "string", optional: true, maxLength: 20_000 },
      textEdited: { type: "boolean", optional: true },
    },
    sourceBlobKeys: [],
  },
  execute: async (ctx) => {
    // Connected text is the starting point; once the user types over it
    // (`textEdited`) their version wins until they reset to the incoming text.
    const incoming = ctx
      .inputs("text")
      .map((value) => (value.kind === "text" ? value.text : ""))
      .filter(Boolean)
      .join("\n");
    const text = (ctx.params.textEdited || !incoming ? ctx.params.text ?? "" : incoming).trim();
    if (!text) throw new Error("Enter some text first.");
    ctx.applyRun({
      runId: ctx.createRunId(),
      signature: ctx.signature,
      at: Date.now(),
      values: [[{ kind: "text", text }]],
    });
  },
};
