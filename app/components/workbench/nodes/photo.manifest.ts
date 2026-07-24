import type { NodeManifest } from "../types";

// Photo runs are created at upload time (the component caches the file and
// applies a run itself), so execute only validates that an image was chosen.
export const photoManifest: NodeManifest = {
  kind: "photo",
  spec: {
    kind: "photo",
    title: "Photo",
    description: "Upload an image (render, reference, or site photo).",
    inputs: [],
    outputs: [{ id: "image", kind: "image", label: "Image" }],
  },
  defaultParams: {},
  importSchema: {
    paramKeys: {
      fileName: { type: "string", optional: true, maxLength: 256 },
      fileFingerprint: { type: "string", optional: true, maxLength: 128 },
    },
    // The photo source blob is cached under the node-id convention
    // (PHOTO_SOURCE_KEY), not under a param field.
    sourceBlobKeys: [],
  },
  execute: async (ctx) => {
    if (!ctx.node.data.runs.length) throw new Error("Choose an image for this Photo node first.");
  },
};
