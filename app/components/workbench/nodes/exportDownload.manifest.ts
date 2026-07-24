import type { NodeManifest } from "../types";

// Terminal zero-token client node: canvas toBlob PNG/JPEG file download, no
// API call, no output ports. The DOM-touching execute wrapper (canvas +
// browser download) lives in exportDownload.tsx; this manifest carries no
// execute field so the registry dispatches to the .tsx wrapper exclusively.
export const exportDownloadManifest: NodeManifest = {
  kind: "exportDownload",
  spec: {
    kind: "exportDownload",
    title: "Export / Download",
    description: "Download the final image as a PNG or JPEG file.",
    inputs: [{ id: "image", kind: "image", label: "Image", required: true }],
    outputs: [],
  },
  defaultParams: { filename: "workbench-output.png", exportFormat: "png" },
  importSchema: {
    paramKeys: {
      filename: { type: "string", optional: true, maxLength: 200 },
      exportFormat: { type: "enum", optional: true, values: ["png", "jpeg"] },
    },
    sourceBlobKeys: [],
  },
};
