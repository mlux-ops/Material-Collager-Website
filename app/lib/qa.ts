// Pure, testable building blocks for the collage accuracy-review ("QA")
// endpoint: request validation, the OpenAI Responses API request body (prompt
// + JSON schema), and parsing of the model's structured JSON reply. No
// network calls live here — app/api/qa/route.ts owns the fetch.

export const QA_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type QaMimeType = (typeof QA_MIME_TYPES)[number];

export const QA_FINISH_MATCHES = ["match", "mismatch", "unclear"] as const;
export type QaFinishMatch = (typeof QA_FINISH_MATCHES)[number];

export const QA_DEFAULT_MODEL = "gpt-5.4-mini";

// The rendered board plus one reference per item all travel as base64 JSON,
// so the practical ceiling is the same reasoning /api/generate's multipart
// path uses for a request body, minus headroom for the JSON envelope itself.
export const QA_MAX_PAYLOAD_BYTES = 24 * 1024 * 1024;

export type QaItemInput = {
  id: string;
  role: string;
  name?: string;
  brand?: string;
  notes?: string;
};

export type QaImageInput = {
  imageBase64: string;
  mimeType: QaMimeType;
};

export type QaReferenceInput = QaImageInput & { itemId: string };

export type QaItemResult = {
  id: string;
  present: boolean;
  count: number;
  finishMatch: QaFinishMatch;
  scaleOk: boolean | null;
  issues: string[];
};

export type QaModelResult = {
  items: QaItemResult[];
  extraObjects: string[];
  summary: string;
};

export type QaResult = QaModelResult & {
  model: string;
  checkedAt: string;
  flagCount: number;
};

export type ValidatedQaRequest = {
  items: QaItemInput[];
  output: QaImageInput;
  referencesByItem: Map<string, QaImageInput>;
};

export function validateQaRequest(body: unknown): ValidatedQaRequest {
  if (!body || typeof body !== "object") {
    throw new Error("Missing the QA request body.");
  }
  const input = body as Record<string, unknown>;

  const output = validateQaImage(input.output, "rendered output image");

  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new Error("Add at least one item to review.");
  }
  const items = input.items.map((item, index) => normalizeQaItem(item, index));
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) {
      throw new Error(`Item ID "${item.id}" is used more than once.`);
    }
    ids.add(item.id);
  }

  if (!Array.isArray(input.references) || input.references.length === 0) {
    throw new Error("Add one reference image per item.");
  }
  const referencesByItem = new Map<string, QaImageInput>();
  let totalBytes = output.byteLength;
  input.references.forEach((rawReference, index) => {
    if (!rawReference || typeof rawReference !== "object") {
      throw new Error(`Reference ${index + 1} is missing its item ID and image.`);
    }
    const record = rawReference as Record<string, unknown>;
    const itemId = typeof record.itemId === "string" ? record.itemId.trim() : "";
    if (!itemId) {
      throw new Error(`Reference ${index + 1} is missing an item ID.`);
    }
    if (!ids.has(itemId)) {
      throw new Error(`Reference "${itemId}" does not match any item in the request.`);
    }
    if (referencesByItem.has(itemId)) {
      throw new Error(`Item "${itemId}" has more than one reference image.`);
    }
    const reference = validateQaImage(record, `reference for item "${itemId}"`);
    totalBytes += reference.byteLength;
    referencesByItem.set(itemId, { imageBase64: reference.imageBase64, mimeType: reference.mimeType });
  });

  for (const item of items) {
    if (!referencesByItem.has(item.id)) {
      throw new Error(`Item "${item.id}" is missing its reference image.`);
    }
  }
  if (referencesByItem.size !== items.length) {
    throw new Error("Every reference must map to exactly one item.");
  }

  if (totalBytes > QA_MAX_PAYLOAD_BYTES) {
    const totalMb = (totalBytes / (1024 * 1024)).toFixed(1);
    const limitMb = (QA_MAX_PAYLOAD_BYTES / (1024 * 1024)).toFixed(0);
    throw new Error(`The rendered image and references total ${totalMb} MB, over the ${limitMb} MB QA limit. Use smaller or fewer images.`);
  }

  return { items, output: { imageBase64: output.imageBase64, mimeType: output.mimeType }, referencesByItem };
}

function normalizeQaItem(value: unknown, index: number): QaItemInput {
  if (!value || typeof value !== "object") {
    throw new Error(`Item ${index + 1} is not a valid item.`);
  }
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (!id) {
    throw new Error(`Item ${index + 1} is missing an ID.`);
  }
  const role = typeof record.role === "string" ? record.role.trim() : "";
  if (!role) {
    throw new Error(`Item "${id}" is missing a role.`);
  }
  const item: QaItemInput = { id, role };
  if (typeof record.name === "string" && record.name.trim()) item.name = record.name.trim();
  if (typeof record.brand === "string" && record.brand.trim()) item.brand = record.brand.trim();
  if (typeof record.notes === "string" && record.notes.trim()) item.notes = record.notes.trim();
  return item;
}

function validateQaImage(value: unknown, label: string): QaImageInput & { byteLength: number } {
  if (!value || typeof value !== "object") {
    throw new Error(`Missing the ${label}.`);
  }
  const record = value as Record<string, unknown>;
  const imageBase64 = record.imageBase64;
  if (typeof imageBase64 !== "string" || !imageBase64.trim()) {
    throw new Error(`Missing image data for the ${label}.`);
  }
  const byteLength = decodedBase64Length(imageBase64, label);
  const mimeType = record.mimeType;
  if (typeof mimeType !== "string" || !(QA_MIME_TYPES as readonly string[]).includes(mimeType)) {
    throw new Error(`The ${label} must use one of: ${QA_MIME_TYPES.join(", ")}.`);
  }
  return { imageBase64, mimeType: mimeType as QaMimeType, byteLength };
}

function decodedBase64Length(base64: string, label: string): number {
  try {
    return atob(base64).length;
  } catch {
    throw new Error(`The ${label} image data is not valid base64.`);
  }
}

// The system/developer instruction sent as the Responses API `instructions`
// field. Names every item ID and, when present, its note, so the model has a
// closed, exact worklist rather than inferring one from the images.
export function buildQaInstructions(items: QaItemInput[]): string {
  const idList = items.map((item) => `"${item.id}"`).join(", ");
  const itemLines = items.map((item) => {
    const brandName = [item.brand, item.name].filter(Boolean).join(" ");
    const details = [
      `role: ${item.role}`,
      brandName ? `product: ${brandName}` : null,
      item.notes ? `note to verify: ${item.notes}` : null,
    ].filter(Boolean).join("; ");
    return `- "${item.id}" (${details})`;
  });

  return [
    "ROLE",
    "You are a meticulous quality-control auditor for a rendered material and fixture collage. You are given one RENDERED BOARD image and one REFERENCE image per item. Judge accuracy against the references only — not overall composition or aesthetics.",
    "ITEMS TO AUDIT",
    `Audit exactly these item IDs, and only these: ${idList}.`,
    itemLines.join("\n"),
    "FOR EACH ITEM DECIDE",
    [
      '- present: is an object built from that item\'s reference visible on the rendered board?',
      "- count: how many distinct objects on the board trace back to this item's reference? Correct is 1.",
      '- finishMatch: does the rendered object\'s finish, color, and material read the same as its reference — matte white vs chrome vs black onyx, tile pattern and colour? "match", "mismatch", or "unclear" if you cannot tell.',
      "- scaleOk: is its size plausible relative to the other items, given what the objects actually are (a wine tower should read roughly fridge height; a faucet should not dwarf a shower head)? true, false, or null if you cannot judge.",
      '- issues: short, specific strings describing any problem, e.g. "rendered as chrome; reference is matte white" or "two shower heads".',
    ].join("\n"),
    "NOTES",
    "If an item lists a note above, treat it as an assertion to check against the rendered board. If the rendered board violates it, record that as one of the item's issues.",
    "EXTRA OBJECTS",
    "List anything visible on the rendered board that is not traceable to any item ID above under extraObjects.",
    "BE LITERAL AND CONSERVATIVE",
    'When you are not sure, answer "unclear" (finishMatch) or null (scaleOk) rather than guessing. Do not guess at scale or finish from ambiguous lighting or cropping.',
    "Respond only with the structured JSON requested by the schema — no prose outside it.",
  ].join("\n\n");
}

// Strict-mode JSON schema for the Responses API `text.format`. Mirrors
// QaModelResult; flagCount is computed server-side and is never part of the
// model's own output.
export function qaJsonSchema(itemIds: string[]) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", enum: itemIds },
            present: { type: "boolean" },
            count: { type: "integer" },
            finishMatch: { type: "string", enum: [...QA_FINISH_MATCHES] },
            scaleOk: { type: ["boolean", "null"] },
            issues: { type: "array", items: { type: "string" } },
          },
          required: ["id", "present", "count", "finishMatch", "scaleOk", "issues"],
        },
      },
      extraObjects: { type: "array", items: { type: "string" } },
      summary: { type: "string" },
    },
    required: ["items", "extraObjects", "summary"],
  };
}

export function dataUrlFor(image: QaImageInput): string {
  return `data:${image.mimeType};base64,${image.imageBase64}`;
}

// The exact POST body for https://api.openai.com/v1/responses: a single user
// message interleaving the rendered board and each item's labeled reference,
// a developer `instructions` string, and a strict json_schema output format.
export function buildQaRequestBody(params: {
  model: string;
  items: QaItemInput[];
  output: QaImageInput;
  referencesByItem: Map<string, QaImageInput>;
}) {
  const { model, items, output, referencesByItem } = params;
  const content: Array<Record<string, unknown>> = [
    { type: "input_text", text: "RENDERED BOARD" },
    // Default detail for the rendered board: this is the object being
    // audited, so full detail matters. Omitting `detail` lets the API use its
    // own default rather than us guessing at the "equivalent" of default.
    { type: "input_image", image_url: dataUrlFor(output) },
  ];
  for (const item of items) {
    const reference = referencesByItem.get(item.id);
    if (!reference) {
      throw new Error(`Item "${item.id}" is missing its reference image.`);
    }
    const brandName = [item.brand, item.name].filter(Boolean).join(" ");
    const label = brandName ? `${item.role}; ${brandName}` : item.role;
    const noteSuffix = item.notes ? `; note: ${item.notes}` : "";
    content.push({ type: "input_text", text: `REFERENCE for item "${item.id}" (${label})${noteSuffix}` });
    // References only need to establish presence/count/finish/scale, not
    // pixel-level detail, so they go in at the API's cheapest image detail.
    content.push({ type: "input_image", image_url: dataUrlFor(reference), detail: "low" });
  }

  return {
    model,
    instructions: buildQaInstructions(items),
    input: [{ role: "user", content }],
    text: {
      format: {
        type: "json_schema",
        name: "collage_qa_result",
        schema: qaJsonSchema(items.map((item) => item.id)),
        strict: true,
      },
    },
  };
}

export function computeFlagCount(qa: { items: QaItemResult[]; extraObjects: string[] }): number {
  const flaggedItems = qa.items.filter(
    (item) => !item.present || item.count !== 1 || item.finishMatch === "mismatch" || item.scaleOk === false,
  ).length;
  return flaggedItems + qa.extraObjects.length;
}

// Parses the model's structured-output JSON string (Response.output_text, or
// the concatenated output_text parts of Response.output) into QaModelResult.
// Throws with a message mentioning "QA model returned" on any malformed or
// unusable shape, per the route's error-surfacing contract.
export function parseQaModelJson(raw: string): QaModelResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("QA model returned malformed JSON that could not be parsed.");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("QA model returned JSON that was not an object.");
  }
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.items)) {
    throw new Error('QA model returned JSON missing an "items" array.');
  }
  const items = record.items.map((entry, index) => parseQaItemResult(entry, index));
  const extraObjects = Array.isArray(record.extraObjects)
    ? record.extraObjects.filter((value): value is string => typeof value === "string")
    : [];
  const summary = typeof record.summary === "string" ? record.summary : "";
  return { items, extraObjects, summary };
}

function parseQaItemResult(entry: unknown, index: number): QaItemResult {
  if (!entry || typeof entry !== "object") {
    throw new Error(`QA model returned an invalid item at position ${index + 1}.`);
  }
  const record = entry as Record<string, unknown>;
  const id = record.id;
  if (typeof id !== "string" || !id.trim()) {
    throw new Error(`QA model returned an item at position ${index + 1} with no ID.`);
  }
  if (typeof record.present !== "boolean") {
    throw new Error(`QA model returned item "${id}" with a non-boolean "present" value.`);
  }
  if (typeof record.count !== "number" || !Number.isFinite(record.count)) {
    throw new Error(`QA model returned item "${id}" with a non-numeric "count" value.`);
  }
  const finishMatch = record.finishMatch;
  if (finishMatch !== "match" && finishMatch !== "mismatch" && finishMatch !== "unclear") {
    throw new Error(`QA model returned item "${id}" with an unrecognized "finishMatch" value.`);
  }
  const scaleOk = record.scaleOk;
  if (scaleOk !== true && scaleOk !== false && scaleOk !== null) {
    throw new Error(`QA model returned item "${id}" with an unrecognized "scaleOk" value.`);
  }
  const issues = Array.isArray(record.issues)
    ? record.issues.filter((value): value is string => typeof value === "string")
    : [];
  return { id, present: record.present, count: record.count, finishMatch, scaleOk, issues };
}

export function buildQaResult(model: string, parsed: QaModelResult, checkedAt: string = new Date().toISOString()): QaResult {
  return {
    model,
    checkedAt,
    items: parsed.items,
    extraObjects: parsed.extraObjects,
    summary: parsed.summary,
    flagCount: computeFlagCount(parsed),
  };
}
