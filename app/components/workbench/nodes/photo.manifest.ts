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
  // photo.tsx applies its own run directly at upload time under an ad-hoc
  // `photo:<fingerprint>` signature (not signatureFor's hash), so the FIRST
  // time this node is actually scheduled in a graph run its signature never
  // matches -- runNodes calls this execute, which used to just validate and
  // return, leaving the node stuck at "Running" forever and permanently
  // stale (W-2). Re-applying the SAME run's values (the identical runId, so
  // downstream is never spuriously invalidated -- nothing about the photo's
  // content actually changed) under the executor's authoritative
  // ctx.signature settles the bookkeeping once; every run after that is a
  // genuine cache hit.
  execute: async (ctx) => {
    const active = ctx.node.data.runs[ctx.node.data.activeRun];
    if (!active) throw new Error("Choose an image for this Photo node first.");
    ctx.applyRun({ ...active, signature: ctx.signature });
  },
};
