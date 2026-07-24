import type { NodeManifest } from "../types";

const DOMAIN_LINES = {
  interior: "Photorealistic interior architectural rendering. Preserve the room's geometry, camera position, and perspective exactly.",
  exterior: "Photorealistic exterior architectural rendering. Preserve the building massing, site context, camera position, and perspective exactly.",
  collage: "Clean editorial material collage on a pure white background, professionally lit, every item cleanly isolated.",
} as const;

export const promptBuilderManifest: NodeManifest = {
  kind: "promptBuilder",
  spec: {
    kind: "promptBuilder",
    title: "Prompt Builder",
    description: "Compose an architectural prompt from presets.",
    inputs: [{ id: "extra", kind: "text", label: "Extra direction" }],
    outputs: [{ id: "text", kind: "text", label: "Prompt" }],
  },
  defaultParams: { domain: "interior", lighting: "soft daylight", styleDirection: "photorealistic, editorial", extraDirection: "" },
  importSchema: {
    paramKeys: {
      domain: { type: "enum", optional: true, values: ["interior", "exterior", "collage"] },
      lighting: { type: "string", optional: true, maxLength: 400 },
      styleDirection: { type: "string", optional: true, maxLength: 400 },
      extraDirection: { type: "string", optional: true, maxLength: 4_000 },
    },
    sourceBlobKeys: [],
  },
  execute: async (ctx) => {
    const extra = ctx
      .inputs("extra")
      .map((value) => (value.kind === "text" ? value.text : ""))
      .filter(Boolean)
      .join("\n");
    const parts = [
      DOMAIN_LINES[ctx.params.domain ?? "interior"],
      ctx.params.lighting ? `Lighting: ${ctx.params.lighting}.` : "",
      ctx.params.styleDirection ? `Style: ${ctx.params.styleDirection}.` : "",
      ctx.params.extraDirection?.trim() ?? "",
      extra,
    ].filter(Boolean);
    ctx.applyRun({
      runId: ctx.createRunId(),
      signature: ctx.signature,
      at: Date.now(),
      values: [[{ kind: "text", text: parts.join("\n") }]],
    });
  },
};
