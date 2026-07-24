import type { NodeManifest } from "../types";

// Lists items via GET /api/library; the user's selection's image
// (/api/library/[id]/image, public route) is fetched into the blob cache
// and emitted downstream. Zero API-billing cost — the library GET/image
// routes are not paid OpenAI calls. The DOM-touching execute wrapper (blob
// cache) lives in libraryPick.tsx.
export const libraryPickManifest: NodeManifest = {
  kind: "libraryPick",
  spec: {
    kind: "libraryPick",
    title: "Library Pick",
    description: "Pick a saved image from the 30-day library.",
    inputs: [],
    outputs: [{ id: "image", kind: "image", label: "Image" }],
  },
  defaultParams: { selectedLibraryId: "" },
  importSchema: {
    paramKeys: {
      selectedLibraryId: { type: "string", optional: true, maxLength: 128 },
    },
    sourceBlobKeys: [],
  },
};
