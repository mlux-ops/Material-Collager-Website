import type { NodeManifest } from "../types";

// Holds an ordered set of uploaded reference/product images plus their item
// metadata (id/role/brand/name/finish/notes/required — reusing
// CollageItemInput + ITEM_PRESETS from app/lib/collage.ts). The full item
// model is hosted directly on the node card (S29's dedicated inspector panel
// will relocate this UI without changing the data shape). Images are routed
// through putBlob/blob-cache (never base64 in store state) and persisted via
// the generalized split-blob pattern (persistBlobKeys below).
//
// A source node: it produces its own run directly from user interaction
// (references.tsx calls applyRun on every edit), so this framework-free
// execute only validates that at least one item carries an uploaded image
// when the node is scheduled as part of a graph run — mirroring photo.manifest.ts.
export const referencesManifest: NodeManifest = {
  kind: "references",
  spec: {
    kind: "references",
    title: "References",
    description: "Upload ordered product/material reference images with item metadata.",
    inputs: [],
    outputs: [{ id: "references", kind: "references", label: "References" }],
  },
  defaultParams: { referenceItems: [] },
  importSchema: {
    // "referenceItemList" (types.ts) is the generic rule the dedicated import
    // validator (export-import.ts) uses to sanitize + cap this array and
    // remap each item's imageKeys through the same blob-key-ownership check
    // every other blob-bearing field gets.
    paramKeys: {
      referenceItems: { type: "referenceItemList", optional: true, maxItems: 32, maxImagesPerItem: 12 },
    },
    sourceBlobKeys: [],
  },
  persistBlobKeys: (_nodeId, params) => (params.referenceItems ?? []).flatMap((item) => item.imageKeys),
  execute: async (ctx) => {
    const items = ctx.params.referenceItems ?? [];
    if (!items.some((item) => item.imageKeys.length > 0)) {
      throw new Error("Add at least one reference item with an uploaded image first.");
    }
  },
};
