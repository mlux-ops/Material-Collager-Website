import type { NodeManifest, NodeOutputValue } from "../types";

function joinText(values: NodeOutputValue[]): string {
  return values
    .map((value) => (value.kind === "text" ? value.text : ""))
    .filter(Boolean)
    .join("\n");
}

// Text arriving on the Append port is added below the node's own text, after
// a blank line. Exported for the unit tests.
export function withAppendedText(text: string, appended: string): string {
  const base = text.trim();
  const tail = appended.trim();
  if (base && tail) return `${base}\n\n${tail}`;
  return base || tail;
}

export const textManifest: NodeManifest = {
  kind: "text",
  spec: {
    kind: "text",
    title: "Text",
    description: "A prompt or instruction fragment. Connect text in to edit it here; text on Append is added at the bottom.",
    inputs: [
      { id: "text", kind: "text", label: "Text in" },
      // Explicit-only so a text wire dropped on the card still lands on
      // "Text in"; Image Markup's Prompt output is the intended source.
      { id: "append", kind: "text", label: "Append", multi: true, explicitOnly: true },
    ],
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
    const incoming = joinText(ctx.inputs("text"));
    const own = ctx.params.textEdited || !incoming ? ctx.params.text ?? "" : incoming;
    const text = withAppendedText(own, joinText(ctx.inputs("append")));
    if (!text) throw new Error("Enter some text first.");
    ctx.applyRun({
      runId: ctx.createRunId(),
      signature: ctx.signature,
      at: Date.now(),
      values: [[{ kind: "text", text }]],
    });
  },
};
