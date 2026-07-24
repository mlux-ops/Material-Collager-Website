import type { NodeManifest } from "../types";

// Compare is a passive viewer: no execute anywhere, so isExecutable() skips
// it during runs. The slider position is presentation state, excluded from
// the memoization signature via stableParams.
export const compareManifest: NodeManifest = {
  kind: "compare",
  spec: {
    kind: "compare",
    title: "Compare A/B",
    description: "Slide between two images.",
    inputs: [
      { id: "a", kind: "image", label: "A", required: true },
      { id: "b", kind: "image", label: "B", required: true },
    ],
    outputs: [],
  },
  defaultParams: { split: 50 },
  importSchema: {
    paramKeys: {
      split: { type: "number", optional: true, min: 0, max: 100 },
    },
    sourceBlobKeys: [],
  },
  stableParams: ({ split: _split, ...rest }) => rest,
};
