import type { NodeManifest } from "../types";

// Zero-token client node: canvas-only crop to a selected region, clamped to
// valid gpt-image-2 dimensions (divisible by 16, aspect 1:3-3:1,
// 655,360-8,294,400 px). Region coordinates are stored as fractions (0-1) of
// the source image so the same crop rectangle survives regardless of the
// upstream image's actual pixel size. Routed through putBlob; zero API
// round-trips. The DOM-touching execute wrapper lives in crop.tsx.
export const cropManifest: NodeManifest = {
  kind: "crop",
  spec: {
    kind: "crop",
    title: "Crop",
    description: "Crop an image to a region (zero API cost).",
    inputs: [{ id: "image", kind: "image", label: "Image", required: true }],
    outputs: [{ id: "image", kind: "image", label: "Image" }],
  },
  defaultParams: { cropX: 0, cropY: 0, cropWidth: 1, cropHeight: 1 },
  importSchema: {
    paramKeys: {
      cropX: { type: "number", optional: true, min: 0, max: 1 },
      cropY: { type: "number", optional: true, min: 0, max: 1 },
      cropWidth: { type: "number", optional: true, min: 0, max: 1 },
      cropHeight: { type: "number", optional: true, min: 0, max: 1 },
    },
    sourceBlobKeys: [],
  },
};
