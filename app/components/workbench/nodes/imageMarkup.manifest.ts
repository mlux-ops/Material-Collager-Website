import type { NodeManifest } from "../types";

// Image Markup: draw coloured brush marks over an input image, then emit
//   1. a transparent PNG at exactly the input image's pixel size holding only
//      the marks (for Image Edit's explicit-only Markup port), and
//   2. a prompt fragment naming what each colour means (for a Text node's
//      Append port, or straight into a Prompt port).
// Zero API cost. The canvas render lives in imageMarkup.tsx; everything here
// is framework-free so the unit tests can import it.
//
// Params:
//   strokes      -- JSON MarkupStroke[]; coordinates normalized 0-1000 against
//                   the image's width (x) and height (y), radius against the
//                   width, exactly like Masked Edit's brush shapes.
//   instructions -- JSON { [colour name]: instruction }. Keyed by colour, not
//                   by stroke, so undo/clear never loses typed text; only
//                   colours present in `strokes` are listed or emitted.

export const MARKUP_PALETTE = [
  { name: "red", hex: "#ff0000" },
  { name: "blue", hex: "#0000ff" },
  { name: "green", hex: "#00ff00" },
  { name: "yellow", hex: "#ffff00" },
  { name: "magenta", hex: "#ff00ff" },
  { name: "cyan", hex: "#00ffff" },
] as const;

export type MarkupColorName = (typeof MARKUP_PALETTE)[number]["name"];

export type MarkupStroke = {
  color: MarkupColorName;
  radius: number; // normalized 0-1000 against image width
  points: number[]; // x,y,x,y,... normalized 0-1000
};

export type MarkupInstructions = Partial<Record<MarkupColorName, string>>;

export const MARKUP_STROKES_MAX_LENGTH = 200_000;
export const MARKUP_INSTRUCTIONS_MAX_LENGTH = 16_000;
export const MARKUP_INSTRUCTION_MAX_LENGTH = 2_000;

const PALETTE_NAMES: readonly string[] = MARKUP_PALETTE.map((entry) => entry.name);

export function isMarkupColor(value: unknown): value is MarkupColorName {
  return typeof value === "string" && PALETTE_NAMES.includes(value);
}

export function markupColorHex(name: MarkupColorName): string {
  return MARKUP_PALETTE.find((entry) => entry.name === name)?.hex ?? "#ff0000";
}

function clampUnit(value: number): number {
  return Math.min(1000, Math.max(0, value));
}

// Defensive parse: anything malformed is dropped stroke-by-stroke rather than
// failing the whole set, so one bad entry in an imported graph never erases
// the rest of the drawing.
export function parseStrokes(json: string | undefined): MarkupStroke[] {
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const strokes: MarkupStroke[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const { color, radius, points } = entry as { color?: unknown; radius?: unknown; points?: unknown };
    if (!isMarkupColor(color)) continue;
    if (typeof radius !== "number" || !Number.isFinite(radius) || radius <= 0) continue;
    if (!Array.isArray(points) || points.length < 2 || points.length % 2 !== 0) continue;
    if (!points.every((value) => typeof value === "number" && Number.isFinite(value))) continue;
    strokes.push({
      color,
      radius: Math.min(1000, radius),
      points: (points as number[]).map(clampUnit),
    });
  }
  return strokes;
}

export function parseInstructions(json: string | undefined): MarkupInstructions {
  if (!json) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const instructions: MarkupInstructions = {};
  for (const name of PALETTE_NAMES) {
    const value = (parsed as Record<string, unknown>)[name];
    if (typeof value === "string") {
      instructions[name as MarkupColorName] = value.slice(0, MARKUP_INSTRUCTION_MAX_LENGTH);
    }
  }
  return instructions;
}

// Colours that appear in at least one stroke, in palette order (not draw
// order) so the card list and the prompt are stable.
export function usedColors(strokes: MarkupStroke[]): MarkupColorName[] {
  const present = new Set(strokes.map((stroke) => stroke.color));
  return MARKUP_PALETTE.map((entry) => entry.name).filter((name) => present.has(name));
}

// Used colours whose instruction is blank. The node refuses to run while any
// exist: their marks would still be in the PNG with nothing telling the model
// what to do inside them.
export function colorsMissingInstructions(strokes: MarkupStroke[], instructions: MarkupInstructions): MarkupColorName[] {
  return usedColors(strokes).filter((name) => !(instructions[name] ?? "").trim());
}

export const MARKUP_PROMPT_CLOSING =
  "The coloured marks are guidance only: remove every drawn mark from the result and keep everything outside the marked areas unchanged.";

function sentence(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

// One line per used colour, palette order, then the closing instruction
// (docs/reference/openai-image-prompting.md "Markup-guided edits": describe
// the change inside the mark and ask for the mark to be removed).
export function buildMarkupPrompt(strokes: MarkupStroke[], instructions: MarkupInstructions): string {
  const used = usedColors(strokes);
  if (!used.length) throw new Error("Draw some markup first.");
  const missing = colorsMissingInstructions(strokes, instructions);
  if (missing.length === used.length) throw new Error("Add an instruction for each colour you used.");
  if (missing.length) throw new Error(`Add an instruction for the ${missing.join(", ")} marks, or erase them.`);
  const lines = used.map((name) => `Inside the ${name} marks: ${sentence(instructions[name] ?? "")}`);
  lines.push(MARKUP_PROMPT_CLOSING);
  return lines.join("\n");
}

export const imageMarkupManifest: NodeManifest = {
  kind: "imageMarkup",
  spec: {
    kind: "imageMarkup",
    title: "Image Markup",
    description:
      "Draw coloured marks over an image and say what each colour means (zero API cost). Drag Markup onto Image Edit's Markup port itself (a drop on the card won't attach it), and Prompt onto a Text node's Append port or straight into a prompt.",
    inputs: [{ id: "image", kind: "image", label: "Image", required: true }],
    outputs: [
      { id: "image", kind: "image", label: "Markup" },
      { id: "text", kind: "text", label: "Prompt" },
    ],
  },
  defaultParams: { strokes: "[]", instructions: "{}" },
  importSchema: {
    paramKeys: {
      // Opaque to import validation beyond the size cap; parseStrokes and
      // parseInstructions drop anything malformed at use.
      strokes: { type: "string", optional: true, maxLength: MARKUP_STROKES_MAX_LENGTH },
      instructions: { type: "string", optional: true, maxLength: MARKUP_INSTRUCTIONS_MAX_LENGTH },
    },
    sourceBlobKeys: [],
  },
};
