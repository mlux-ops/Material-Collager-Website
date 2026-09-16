import { assembleSections, buildReferenceMap, changeScopeLines } from "../../../lib/prompt-sections.ts";
import type { NodeManifest, NodeOutputValue, WorkbenchParams } from "../types";

const DOMAIN_LINES = {
  interior: "Photorealistic interior architectural rendering. Preserve the room's geometry, camera position, and perspective exactly.",
  exterior: "Photorealistic exterior architectural rendering. Preserve the building massing, site context, camera position, and perspective exactly.",
  collage: "Clean editorial material collage on a pure white background, professionally lit, every item cleanly isolated.",
} as const;

export const PROMPT_MODES = ["generate", "edit", "refine"] as const;
export type PromptMode = (typeof PROMPT_MODES)[number];

// OpenAI's guide calls for naming each reference by number AND purpose. These
// are the roles it names, plus "supporting view" from collage.ts's hard-won
// lesson that a second photo of one item must be marked as such or the model
// renders it as a second object.
export const REFERENCE_ROLES = ["subject", "layout master", "style", "background", "supporting view"] as const;
export const DEFAULT_REFERENCE_ROLE = "subject";

// A references value groups many images; a bare image value is one. The prompt
// must number what the model will actually receive, not how many wires arrive.
export function countReferences(values: NodeOutputValue[]): number {
  let total = 0;
  for (const value of values) {
    if (value.kind === "references") total += value.items.length;
    else if (value.kind === "image") total += 1;
  }
  return total;
}

function lines(...parts: Array<string | undefined>): string {
  return parts.map((part) => part?.trim() ?? "").filter(Boolean).join("\n");
}

function referenceSection(params: WorkbenchParams, referenceCount: number) {
  if (referenceCount < 1) return null;
  const roles = params.referenceRoles ?? [];
  const refs = Array.from({ length: referenceCount }, (_, index) => ({
    role: roles[index]?.trim() || DEFAULT_REFERENCE_ROLE,
  }));
  return { heading: "REFERENCE MAP", body: buildReferenceMap(refs) };
}

export function buildPrompt(params: WorkbenchParams, referenceCount: number, extra = ""): string {
  const mode: PromptMode = params.promptMode ?? "generate";
  const refMap = referenceSection(params, referenceCount);
  const tail = { heading: "ADDITIONAL DIRECTION", body: lines(params.extraDirection, extra) };

  if (mode === "edit") {
    return assembleSections([
      ...changeScopeLines({
        change: params.editChange?.trim() ?? "",
        preserve: params.editPreserve,
        exclusions: params.editExclusions,
      }),
      refMap,
      tail,
    ]);
  }

  if (mode === "refine") {
    // Refine deliberately exposes one change and no exclusions list: the guide's
    // rule for iterating is one change per turn, and a list box invites the
    // batching that rule exists to prevent.
    const [change, carry] = changeScopeLines({
      change: params.refineChange?.trim() ?? "",
      preserve: params.refineCarry,
    });
    return assembleSections([
      change ? { heading: "SINGLE CHANGE", body: change.body } : null,
      carry ? { heading: "CARRY FORWARD", body: carry.body } : null,
      tail,
    ]);
  }

  return assembleSections([
    { heading: "GOAL", body: DOMAIN_LINES[params.domain ?? "interior"] },
    { heading: "SCENE", body: params.genScene?.trim() ?? "" },
    { heading: "SUBJECT", body: params.genSubject?.trim() ?? "" },
    {
      heading: "MATERIALS AND DETAIL",
      body: lines(
        params.genDetails,
        params.lighting ? `Lighting: ${params.lighting}.` : "",
        params.styleDirection ? `Style: ${params.styleDirection}.` : "",
      ),
    },
    refMap,
    { heading: "CONSTRAINTS", body: params.genConstraints?.trim() ?? "" },
    tail,
  ]);
}

export const promptBuilderManifest: NodeManifest = {
  kind: "promptBuilder",
  spec: {
    kind: "promptBuilder",
    title: "Prompt Builder",
    description: "Compose a GPT Image 2.5 prompt: generate, edit, or refine.",
    inputs: [
      { id: "extra", kind: "text", label: "Extra direction" },
      { id: "references", kind: "image", label: "References", multi: true, acceptedKinds: ["image", "references"] },
    ],
    // The references pass-through exists so the numbered map and the images it
    // describes come from one node. Wiring references straight into the
    // generate/edit node still works, but then nothing stops the prompt from
    // describing an Image 4 the model never receives.
    outputs: [
      { id: "text", kind: "text", label: "Prompt" },
      { id: "references", kind: "references", label: "References" },
    ],
  },
  defaultParams: {
    promptMode: "generate",
    domain: "interior",
    lighting: "soft daylight",
    styleDirection: "photorealistic, editorial",
    extraDirection: "",
    genScene: "",
    genSubject: "",
    genDetails: "",
    genConstraints: "",
    editChange: "",
    editPreserve: [],
    editExclusions: [],
    refineChange: "",
    refineCarry: [],
    referenceRoles: [],
  },
  importSchema: {
    paramKeys: {
      promptMode: { type: "enum", optional: true, values: PROMPT_MODES },
      domain: { type: "enum", optional: true, values: ["interior", "exterior", "collage"] },
      lighting: { type: "string", optional: true, maxLength: 400 },
      styleDirection: { type: "string", optional: true, maxLength: 400 },
      extraDirection: { type: "string", optional: true, maxLength: 4_000 },
      genScene: { type: "string", optional: true, maxLength: 4_000 },
      genSubject: { type: "string", optional: true, maxLength: 4_000 },
      genDetails: { type: "string", optional: true, maxLength: 4_000 },
      genConstraints: { type: "string", optional: true, maxLength: 4_000 },
      editChange: { type: "string", optional: true, maxLength: 4_000 },
      editPreserve: { type: "stringList", optional: true, maxItems: 40, maxLength: 400 },
      editExclusions: { type: "stringList", optional: true, maxItems: 40, maxLength: 400 },
      refineChange: { type: "string", optional: true, maxLength: 4_000 },
      refineCarry: { type: "stringList", optional: true, maxItems: 40, maxLength: 400 },
      referenceRoles: { type: "stringList", optional: true, maxItems: 64, maxLength: 60 },
    },
    sourceBlobKeys: [],
  },
  execute: async (ctx) => {
    const extra = ctx
      .inputs("extra")
      .map((value) => (value.kind === "text" ? value.text : ""))
      .filter(Boolean)
      .join("\n");
    const references = ctx.inputs("references");
    const text = buildPrompt(ctx.params, countReferences(references), extra);
    ctx.applyRun({
      runId: ctx.createRunId(),
      signature: ctx.signature,
      at: Date.now(),
      values: [[{ kind: "text", text }], references],
    });
  },
};
