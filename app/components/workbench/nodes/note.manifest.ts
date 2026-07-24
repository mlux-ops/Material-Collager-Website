import type { NodeManifest } from "../types";

// Notes are annotation only: no execute anywhere, so isExecutable() keeps
// them out of every run.
export const noteManifest: NodeManifest = {
  kind: "note",
  spec: {
    kind: "note",
    title: "Note",
    description: "A sticky note. Not part of execution.",
    inputs: [],
    outputs: [],
  },
  defaultParams: { text: "" },
  importSchema: {
    paramKeys: {
      text: { type: "string", optional: true, maxLength: 20_000 },
    },
    sourceBlobKeys: [],
  },
};
