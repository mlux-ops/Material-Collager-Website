import type { NodeManifest } from "../types";

// Zero-token client node: conforms an image to valid gpt-image-2 dimensions
// (divisible by 16, aspect 1:3-3:1, 655,360-8,294,400 px) via
// createImageBitmap + canvas, routed through putBlob (no base64 in store
// state). Zero API round-trips. The DOM-touching execute wrapper lives in
// resize.tsx (canvas access is DOM work); this manifest carries no execute
// field so the registry dispatches to the .tsx wrapper exclusively.
export const resizeManifest: NodeManifest = {
  kind: "resize",
  spec: {
    kind: "resize",
    title: "Resize / Downscale",
    description: "Conform an image to a valid generation size (zero API cost).",
    inputs: [{ id: "image", kind: "image", label: "Image", required: true }],
    outputs: [{ id: "image", kind: "image", label: "Image" }],
  },
  defaultParams: { targetWidth: 1536, targetHeight: 1024 },
  importSchema: {
    paramKeys: {
      targetWidth: { type: "number", optional: true, integer: true, min: 16, max: 3840 },
      targetHeight: { type: "number", optional: true, integer: true, min: 16, max: 3840 },
    },
    sourceBlobKeys: [],
  },
};
