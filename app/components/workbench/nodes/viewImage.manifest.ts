import type { NodeManifest } from "../types";

// A passive viewer, the same shape as Compare: no execute anywhere, so
// isExecutable() keeps it out of every run. Zoom/pan is transient viewing
// state kept in the component, not workflow configuration — nothing here is
// worth persisting or exporting, so there are no params at all.
export const viewImageManifest: NodeManifest = {
  kind: "viewImage",
  spec: {
    kind: "viewImage",
    title: "View Image",
    description: "Inspect a connected image full size, zoomed and panned.",
    inputs: [{ id: "image", kind: "image", label: "Image", required: true }],
    outputs: [],
  },
  defaultParams: {},
  importSchema: {
    paramKeys: {},
    sourceBlobKeys: [],
  },
};
