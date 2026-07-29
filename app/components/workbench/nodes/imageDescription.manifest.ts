import type { NodeManifest } from "../types";
import {
  AI_ASSISTANT_DEFAULT_MODEL,
  AI_ASSISTANT_MODELS,
  estimateAssistantCost,
} from "./aiAssistant.manifest.ts";

export const IMAGE_DESCRIPTION_INSTRUCTION = `Describe exactly what the supplied image visibly shows for an architectural material-composition workflow.
Focus on:
- lighting: direction, softness or hardness, contrast, color temperature, shadows, reflections, and exposure;
- materiality: visible materials, finishes, texture, sheen, color, pattern, edge conditions, and transitions;
- organization: composition, hierarchy, spacing, alignment, grouping, scale relationships, foreground/background, and spatial layout.
Be concrete and visually grounded. Do not identify hidden construction, brands, or materials that cannot be supported by the pixels. Return concise plain text that can be edited and reused as a generation prompt.`;

export const imageDescriptionManifest: NodeManifest = {
  kind: "imageDescription",
  spec: {
    kind: "imageDescription",
    title: "Image Description",
    description: "Describe an image's lighting, materiality, and organization as editable text.",
    inputs: [{ id: "image", kind: "image", label: "Image", required: true }],
    outputs: [{ id: "description", kind: "text", label: "Description" }],
    paid: true,
  },
  defaultParams: { model: AI_ASSISTANT_DEFAULT_MODEL },
  importSchema: {
    paramKeys: {
      model: { type: "enum", optional: true, values: AI_ASSISTANT_MODELS },
    },
    sourceBlobKeys: [],
  },
  estimateCost: estimateAssistantCost,
  paid: true,
};
