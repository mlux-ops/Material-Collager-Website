import type { NodeManifest, WorkbenchParams } from "../types";

// Pure request-building core for the save call; the DOM-side execute wrapper
// in saveToLibrary.tsx (which reads the input blob from the cache) composes
// it into the multipart upload.
export function buildSavePayload(params: WorkbenchParams): { filename: string; prompt: string; format: string } {
  return {
    filename: params.filename || "workbench-output.png",
    prompt: "Workbench output",
    format: "workbench",
  };
}

export const saveToLibraryManifest: NodeManifest = {
  kind: "saveToLibrary",
  spec: {
    kind: "saveToLibrary",
    title: "Save to Library",
    description: "Persist an image to the six-month library.",
    inputs: [{ id: "image", kind: "image", label: "Image", required: true }],
    outputs: [],
  },
  defaultParams: { filename: "workbench-output.png" },
  importSchema: {
    paramKeys: {
      filename: { type: "string", optional: true, maxLength: 200 },
      savedJobId: { type: "string", optional: true, maxLength: 64 },
    },
    sourceBlobKeys: [],
  },
  // savedJobId is a run artifact, not a setting: it must never invalidate the
  // memoized run (this replaces the executor's old hardcoded exclusion).
  stableParams: ({ savedJobId: _saved, ...rest }) => rest,
};
