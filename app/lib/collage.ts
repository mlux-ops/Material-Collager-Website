import {
  SUNBURST_BACKGROUNDS,
  SUNBURST_INPUT_FIDELITIES,
  SUNBURST_QUALITIES,
  type SunburstBackground,
  type SunburstInputFidelity,
  type SunburstQuality,
} from "./sunburst.ts";

export { SUNBURST_BACKGROUNDS, SUNBURST_INPUT_FIDELITIES, SUNBURST_MODEL, SUNBURST_QUALITIES } from "./sunburst.ts";

export const COLLAGE_TYPES = [
  "kitchen_material_palette",
  "appliance_collage",
  "bathroom_fixture_collage",
  "bathroom_tile_collage",
] as const;

export const QUALITIES = SUNBURST_QUALITIES;
export const ORIENTATIONS = ["default", "landscape", "portrait", "square"] as const;
export const OUTPUT_RESOLUTIONS = ["standard", "studio", "final"] as const;
export const COMPOSITIONS = ["editorial", "structured", "catalog"] as const;
export const DENSITIES = ["airy", "balanced", "layered"] as const;
export const STYLING_OPTIONS = ["materials_only", "botanical_linen"] as const;
export const LIGHTING_OPTIONS = ["soft_daylight", "crisp_studio"] as const;
export const OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;

export const MAX_REFERENCE_IMAGES = 16;
export const MAX_REFERENCE_FILE_BYTES = 50 * 1024 * 1024;

export type CollageType = (typeof COLLAGE_TYPES)[number];
export type Quality = SunburstQuality;
export type Background = SunburstBackground;
export type Orientation = (typeof ORIENTATIONS)[number];
export type OutputResolution = (typeof OUTPUT_RESOLUTIONS)[number];
export type Composition = (typeof COMPOSITIONS)[number];
export type Density = (typeof DENSITIES)[number];
export type StylingOption = (typeof STYLING_OPTIONS)[number];
export type LightingOption = (typeof LIGHTING_OPTIONS)[number];
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export type CollageItemInput = {
  id: string;
  role: string;
  imageKeys?: string[];
  imageNames?: string[];
  imageFileIds?: string[];
  brand?: string;
  name?: string;
  finish?: string;
  notes?: string;
  required?: boolean;
};

export type CollageRequestInput = {
  collageType: CollageType;
  orientation: Orientation;
  quality: Quality;
  outputResolution?: OutputResolution;
  composition?: Composition;
  density?: Density;
  styling?: StylingOption;
  lighting?: LightingOption;
  heroItemId?: string;
  outputFilename?: string;
  apiKey?: string;
  layoutReference?: boolean;
  layoutReferenceFileId?: string;
  // What kind of authority Image 1 carries when layoutReference is set.
  // "approved-draft" (the default, and what a Final render sends) is this
  // app's own draft being rebuilt at full quality, so its composition is a
  // strong guide. "uploaded-collage" is a previous collage the user supplied
  // as the definitive layout; it outranks the art-direction composition and
  // spacing settings, which are omitted from the prompt rather than emitted
  // as contradictory instructions.
  layoutReferenceMode?: "approved-draft" | "uploaded-collage";
  renderKind?: "draft" | "studio" | "final";
  // Requested OpenAI output_format for a non-final render (a Final render is
  // always PNG regardless of this value; see resolvedOutputFormat). Defaults
  // to "png".
  outputFormat?: OutputFormat;
  // Only meaningful for jpeg/webp; OpenAI accepts 0-100 and ignores it for png.
  outputCompression?: number;
  // Solid white is the default for backwards compatibility. Transparent
  // output is only selected explicitly and is validated against its format.
  background?: Background;
  // Opt-in only, and absent from every default path. The edits endpoint
  // accepts input_fidelity, but the guide documents it only for earlier GPT
  // Image models, so whether Sunburst honours it is unverified. Setting this
  // deliberately puts the parameter on one render to measure the answer; an
  // unset value keeps the request byte-identical to what shipped before.
  inputFidelity?: SunburstInputFidelity;
  items: CollageItemInput[];
};

export const ITEM_PRESETS: Record<CollageType, CollageItemInput[]> = {
  kitchen_material_palette: [
    { id: "wood", role: "wood cabinet or panel sample", required: true },
    { id: "countertop", role: "countertop stone sample", required: true },
    { id: "faucet", role: "kitchen faucet or fixture", required: true },
    { id: "hardware", role: "cabinet hardware", required: true },
    { id: "light_fixture", role: "pendant or ceiling light fixture", required: false },
    { id: "flooring", role: "flooring sample", required: true },
  ],
  appliance_collage: [
    { id: "refrigerator", role: "appliance refrigerator", required: true },
    { id: "cooktop", role: "appliance cooktop", required: false },
    { id: "range_hood", role: "appliance range hood", required: false },
    { id: "oven", role: "appliance oven", required: false },
    { id: "dishwasher", role: "appliance dishwasher", required: false },
  ],
  bathroom_fixture_collage: [
    { id: "vanity_faucet", role: "vanity faucet", required: true },
    { id: "shower_head", role: "shower head and wall arm", required: true },
    { id: "valve_trim", role: "shower valve trim", required: true },
    { id: "cabinet_hardware", role: "cabinet hardware pull or knob", required: false },
    { id: "light_fixture", role: "vanity or wall light fixture", required: false },
    { id: "vanity_wood", role: "wood vanity sample", required: true },
    { id: "main_tile", role: "main bathroom tile", required: true },
    { id: "accent_tile", role: "accent or secondary bathroom tile", required: false },
    { id: "countertop", role: "vanity countertop stone", required: true },
  ],
  bathroom_tile_collage: [
    { id: "wall_tile", role: "wall tile", required: true },
    { id: "floor_tile", role: "floor tile", required: true },
    { id: "accent_tile", role: "accent tile or mosaic tile", required: true },
    { id: "vanity_wood", role: "vanity wood sample", required: true },
    { id: "countertop", role: "countertop stone", required: true },
    { id: "metal_finish", role: "metal finish sample or hardware", required: true },
  ],
};

// Each subject line keeps its type-specific prohibition: the generic "no
// unmapped products" sentence later in the prompt is not enough on its own,
// because each board type has a named failure mode (a bathroom board growing
// a sink basin, a kitchen palette growing tile or an appliance) that the
// model avoids far more reliably when told so up front.
const TYPE_PROMPTS: Record<CollageType, string> = {
  kitchen_material_palette:
    "Subject: luxury residential kitchen materials and fixtures from the reference map. Do not add tile, appliances, or substitute samples that are not referenced.",
  appliance_collage:
    "Subject: luxury appliances from the reference map, preserving product identity and door/handle configuration. Do not add material samples or appliances that are not referenced.",
  bathroom_fixture_collage:
    "Subject: luxury bathroom fixtures and finishes from the reference map. Do not add sanitaryware (toilet, tub, sink basin) or plumbing pieces that are not referenced.",
  bathroom_tile_collage:
    "Subject: luxury bathroom tile and finishes from the reference map, with realistic pattern scale and tactile detail. Do not add tile or finish samples that are not referenced.",
};

const COMPOSITION_PROMPTS: Record<Composition, string> = {
  editorial:
    "Asymmetrical overhead flat lay with a clear visual anchor, calm editorial rhythm, intentional negative space, and a few natural overlaps.",
  structured:
    "Disciplined architectural sample-board composition with aligned axes, measured spacing, clean hierarchy, and restrained overlap.",
  catalog:
    "Polished luxury product arrangement with every item fully legible, clean separation, balanced scale, and minimal overlap.",
};

const DENSITY_PROMPTS: Record<Density, string> = {
  airy: "Keep generous white space around the group; approximately one third of the canvas should remain open.",
  balanced: "Use comfortable breathing room with a satisfyingly full but uncluttered frame.",
  layered: "Build a richer tactile composition with controlled overlap while keeping every referenced item identifiable.",
};

const STYLING_PROMPTS: Record<StylingOption, string> = {
  materials_only: "Use no decorative props. Every visible object must come from a reference image.",
  botanical_linen:
    "Allow only one restrained olive or eucalyptus sprig and one small natural linen corner as secondary editorial styling. They must never replace, cover, or visually compete with a referenced item.",
};

const LIGHTING_PROMPTS: Record<LightingOption, string> = {
  soft_daylight:
    "Soft, neutral daylight from the upper left, realistic contact shadows, controlled highlights, accurate whites, and true material color.",
  crisp_studio:
    "Large diffused studio source from the upper left, crisp but soft-edged shadows, clean specular control, accurate whites, and true material color.",
};

export function validateCollageRequest(request: CollageRequestInput) {
  if (!COLLAGE_TYPES.includes(request.collageType)) {
    throw new Error("Choose a supported collage type.");
  }
  if (!QUALITIES.includes(request.quality)) {
    throw new Error("Choose a supported quality.");
  }
  if (!ORIENTATIONS.includes(request.orientation)) {
    throw new Error("Choose a supported orientation.");
  }
  if (!OUTPUT_RESOLUTIONS.includes(resolvedOutputResolution(request))) {
    throw new Error("Choose a supported output resolution.");
  }
  if (!COMPOSITIONS.includes(resolvedComposition(request))) {
    throw new Error("Choose a supported composition.");
  }
  if (!DENSITIES.includes(resolvedDensity(request))) {
    throw new Error("Choose a supported spacing option.");
  }
  if (!STYLING_OPTIONS.includes(resolvedStyling(request))) {
    throw new Error("Choose a supported styling option.");
  }
  if (!LIGHTING_OPTIONS.includes(resolvedLighting(request))) {
    throw new Error("Choose a supported lighting option.");
  }
  if (request.outputFormat !== undefined && !OUTPUT_FORMATS.includes(request.outputFormat)) {
    throw new Error("Choose a supported output format.");
  }
  if (request.background !== undefined && !SUNBURST_BACKGROUNDS.includes(request.background)) {
    throw new Error("Choose a supported background.");
  }
  if (request.inputFidelity !== undefined && !SUNBURST_INPUT_FIDELITIES.includes(request.inputFidelity)) {
    throw new Error("Choose a supported input fidelity.");
  }
  if (resolvedBackground(request) === "transparent" && resolvedOutputFormat(request) === "jpeg") {
    throw new Error("Transparent output requires PNG or WebP; choose a compatible format before generating.");
  }
  if (request.outputCompression !== undefined) {
    if (!Number.isInteger(request.outputCompression) || request.outputCompression < 0 || request.outputCompression > 100) {
      throw new Error("Output compression must be a whole number between 0 and 100.");
    }
  }

  const items = activeItems(request);
  if (!items.length) {
    throw new Error("Add at least one item with a reference image.");
  }

  const ids = new Set<string>();
  for (const item of items) {
    const id = item.id.trim();
    if (!id) {
      throw new Error(`Give ${item.role || "each item"} a unique ID.`);
    }
    if (ids.has(id)) {
      throw new Error(`Item ID \"${id}\" is used more than once.`);
    }
    ids.add(id);

    if (!item.role.trim()) {
      throw new Error(`Item ${id} needs a role.`);
    }
    if (referenceCount(item) === 0) {
      throw new Error(`Add at least one reference image for ${id}.`);
    }
  }

  if (totalReferenceCount(request) > MAX_REFERENCE_IMAGES) {
    throw new Error(`Use no more than ${MAX_REFERENCE_IMAGES} reference images in one collage.`);
  }
  if (request.layoutReference && totalReferenceCount(request) >= MAX_REFERENCE_IMAGES) {
    throw new Error(`A layout reference occupies one of the ${MAX_REFERENCE_IMAGES} image slots, so it can accompany at most ${MAX_REFERENCE_IMAGES - 1} product references. Remove one supporting view, or render without the layout reference.`);
  }

  if (request.heroItemId && !ids.has(request.heroItemId)) {
    throw new Error("Choose a hero item that is still in the board.");
  }
}

export function referenceCount(item: CollageItemInput) {
  return Math.max(item.imageFileIds?.length ?? 0, item.imageKeys?.length ?? 0, item.imageNames?.length ?? 0);
}

export function totalReferenceCount(request: CollageRequestInput) {
  return request.items.reduce((total, item) => total + referenceCount(item), 0);
}

export function activeItems(request: CollageRequestInput) {
  return request.items.filter((item) => item.required !== false || referenceCount(item) > 0);
}

export function resolvedOrientation(request: CollageRequestInput) {
  if (request.orientation !== "default") return request.orientation;
  if (request.collageType === "bathroom_tile_collage") return "portrait";
  return "landscape";
}

export function resolvedOutputResolution(request: CollageRequestInput): OutputResolution {
  return request.outputResolution ?? "studio";
}

export function resolvedComposition(request: CollageRequestInput): Composition {
  return request.composition ?? "editorial";
}

export function resolvedDensity(request: CollageRequestInput): Density {
  return request.density ?? "balanced";
}

export function resolvedStyling(request: CollageRequestInput): StylingOption {
  if (request.collageType === "appliance_collage") return "materials_only";
  return request.styling ?? "botanical_linen";
}

export function resolvedLighting(request: CollageRequestInput): LightingOption {
  return request.lighting ?? "soft_daylight";
}

// A Final render is the archival, library-visible artifact. Callers can flag
// it via renderKind or via outputResolution, so both are checked here — every
// "is this a Final?" decision (format, quality, render kind) goes through
// this one predicate instead of re-deriving the condition per call site.
export function isFinalRender(request: CollageRequestInput): boolean {
  return request.renderKind === "final" || request.outputResolution === "final";
}

// Finals are always PNG regardless of what output format was requested: they
// must not carry lossy compression.
export function resolvedOutputFormat(request: CollageRequestInput): OutputFormat {
  if (isFinalRender(request)) return "png";
  return request.outputFormat ?? "png";
}

export function resolvedBackground(request: CollageRequestInput): Background {
  return request.background ?? "opaque";
}

// Finals always render at high quality regardless of the requested tier, so a
// draft-tier setting left over in a client (or a CLI flag) can never quietly
// produce a degraded deliverable. Callers compare the result against the
// requested quality to tell the user when the upgrade happened.
export function resolvedQuality(request: CollageRequestInput): Quality {
  const quality = request.quality ?? "high";
  // Final is never allowed below high, but explicit xhigh/max remain intact.
  if (isFinalRender(request) && (quality === "low" || quality === "medium" || quality === "auto")) return "high";
  return quality;
}

export function resolvedSize(request: CollageRequestInput) {
  const orientation = resolvedOrientation(request);
  if (resolvedOutputResolution(request) === "final") {
    if (orientation === "portrait") return "1440x2560";
    if (orientation === "square") return "2048x2048";
    return "2560x1440";
  }
  if (resolvedOutputResolution(request) === "standard") {
    if (orientation === "portrait") return "1024x1536";
    if (orientation === "square") return "1024x1024";
    return "1536x1024";
  }
  if (orientation === "portrait") return "1360x2048";
  if (orientation === "square") return "2048x2048";
  return "2048x1360";
}

function supportingRange(start: number, end: number) {
  return start === end ? `Image ${start}` : `Images ${start}-${end}`;
}

// True when Image 1 is a previous collage the user uploaded as the definitive
// layout, rather than this app's own approved draft being finalized.
export function usesLayoutMaster(request: CollageRequestInput) {
  return Boolean(request.layoutReference) && request.layoutReferenceMode === "uploaded-collage";
}

// The REFERENCE MAP lines describing Image 1. The uploaded-collage wording is
// deliberately much stronger than the approved-draft wording: the draft is a
// composition this same board already produced, while an uploaded master is an
// unrelated collage whose PRODUCTS must be ignored entirely — the failure mode
// is the model treating its objects as things to render.
function layoutReferenceLines(request: CollageRequestInput) {
  if (!usesLayoutMaster(request)) {
    return [
      "Image 1 -> approved draft used only for composition, placement, scale, overlap, camera, lighting direction, and negative space. Preserve these as closely as possible.",
      "Images 2 onward define product identity, geometry, finish, color, and detail. Never copy a draft error over an original reference.",
    ];
  }
  return [
    "Image 1 -> a previously produced collage supplied as the LAYOUT MASTER: the single source of truth for composition and organization. Fill its slots with this board's items, retaining position, scale, rotation, stacking, and spacing.",
    "Where Image 1 and any other composition or spacing instruction disagree, Image 1 wins.",
    "Ignore every product, material, color, finish, and prop shown in Image 1; none of them may appear in the output unless independently mapped below. Images 2 onward define product identity and detail.",
    "For a different number of objects than the item list, add/remove slots while retaining spatial rhythm. If its aspect ratio differs from the target canvas, adapt margins. Never crop an item to force the old proportions.",
  ];
}

export function buildGenerationPrompt(request: CollageRequestInput) {
  const items = activeItems(request);
  const labels: string[] = [];
  let nextIndex = request.layoutReference ? 2 : 1;
  let supportingTotal = 0;
  for (const item of items) {
    const count = referenceCount(item);
    const start = nextIndex;
    const end = nextIndex + count - 1;
    const imageRange = start === end ? `Image ${start}` : `Images ${start}-${end}`;
    nextIndex += count;
    supportingTotal += count - 1;
    const details = [
      `role: ${item.role}`,
      item.brand ? `brand: ${item.brand}` : null,
      item.name ? `product: ${item.name}` : null,
      item.finish ? `finish name: ${item.finish}` : null,
      item.notes ? `specific instruction: ${item.notes}` : null,
    ].filter(Boolean);
    // Spell out which image is the identity view and which are supporting
    // views of that same unit. A bare "Images 4-6 -> faucet" range reads as
    // three things to place; the model then renders the extra views as extra
    // objects, which is the failure this split exists to prevent.
    if (count > 1) details.push(`primary identity view: Image ${start}`, `supporting views of this same physical item: ${supportingRange(start + 1, end)}`);
    labels.push(`${imageRange} -> item \"${item.id}\" (${details.join("; ")})`);
  }

  const layoutMaster = usesLayoutMaster(request);
  const hero = request.heroItemId
    ? layoutMaster
      ? `Assign item \"${request.heroItemId}\" to the layout master's most prominent slot. It must remain faithful to its reference.`
      : `Make item \"${request.heroItemId}\" the visual anchor. It may be largest, but it must remain faithful to its reference.`
    : layoutMaster
      ? "Keep the layout master's existing emphasis; do not promote a different item to anchor."
      : "Choose the most visually substantial referenced item as the anchor without diminishing any other requested item.";

  // Supporting-view rules only make sense once some item actually
  // has a supporting view; a single-image-per-item board has nothing for them
  // to describe, so emitting them anyway is noise the model has to discard.
  const fidelityBullets = [
    ...(supportingTotal > 0
      ? [
          `- A supporting view is another photograph of the SAME physical item. Use it to resolve geometry, hidden faces, thickness, component count, and pattern scale. Where they disagree, the primary view decides identity, color, and finish.`,
          `- Never place a supporting view on the canvas as its own element: no duplicates, mirrored twins, insets, exploded parts, or spare swatches. If two objects on the canvas would trace back to one item ID, remove the extra.`,
        ]
      : []),
    `- Preserve recognizable product identity, silhouette, component count, proportions, edge profile, hardware geometry, finish temperature, sheen, grain direction, veining, pattern scale, texture, and color.`,
    `- Remove source backgrounds cleanly. Do not redesign, simplify, mirror, recolor, or substitute an item unless its specific instruction explicitly requests that change.`,
    `- Metadata identifies products; item-specific instructions control requested placement and edits. Preserve visible reference details unless that item's instruction explicitly requests a change. Never invent a compromise between conflicting finishes.`,
    `- Keep each item readable. Overlap may crop only a small nonessential edge; never cover a defining product feature or most of a sample.`,
  ];

  return [
    "GOAL",
    "Create one photorealistic interior-design material collage for an architecture and interiors editorial.",
    TYPE_PROMPTS[request.collageType],
    "ART DIRECTION",
    // A layout reference already dictates arrangement and spacing, so emitting
    // the composition/density presets alongside it would contradict it. The
    // lighting and styling presets are independent of layout and still apply.
    ...(request.layoutReference ? [] : [COMPOSITION_PROMPTS[resolvedComposition(request)], DENSITY_PROMPTS[resolvedDensity(request)]]),
    ...(request.layoutReference && !layoutMaster ? [] : [LIGHTING_PROMPTS[resolvedLighting(request)]]),
    STYLING_PROMPTS[resolvedStyling(request)],
    ...(request.layoutReference && !layoutMaster && !request.heroItemId ? [] : [hero]),
    "REFERENCE MAP",
    "Use the uploaded images by their exact order below. The images, not the text labels, are the visual source of truth.",
    ...(request.layoutReference ? layoutReferenceLines(request) : []),
    labels.join("\n"),
    "OBJECT COUNT",
    [
      `The finished collage contains exactly ${items.length} referenced object${items.length === 1 ? "" : "s"}, one per item ID: ${items.map((item) => `\"${item.id}\"`).join(", ")}.`,
      supportingTotal
        ? `${supportingTotal} of the ${totalReferenceCount(request)} uploaded product images ${supportingTotal === 1 ? "is a supporting view" : "are supporting views"} that add no object of their own.`
        : "",
      resolvedStyling(request) === "botanical_linen"
        ? "Styling props are excluded from this product count; only the sprig and linen allowed above may be added."
        : "No additional objects or props.",
    ].filter(Boolean).join(" "),
    "REFERENCE FIDELITY - NON-NEGOTIABLE",
    fidelityBullets.join("\n"),
    "PHOTOGRAPHY AND FINISH",
    request.layoutReference && !layoutMaster
      ? "Keep the approved draft camera and lighting direction."
      : "True overhead camera with corrected perspective; no room scene.",
    resolvedBackground(request) === "transparent"
      ? "Transparent background with preserved alpha and no white matte, clean cutout edges, realistic thickness, contact shadows, reflections, and surface texture. No CGI gloss, warped fixtures, gray cast, vignette, or border."
      : "Seamless pure white background (#FFFFFF), clean cutout edges, realistic thickness, contact shadows, reflections, and surface texture. No CGI gloss, warped fixtures, gray cast, vignette, or border.",
    "No added text, labels, annotations, logos, watermarks, people, hands, packaging, or unmapped products. Only the selected styling props are allowed.",
    "OUTPUT",
    `Orientation: ${resolvedOrientation(request)}. Canvas: ${resolvedSize(request)}. Deliver one complete collage, not a contact sheet. Before finishing, check item count, finish, geometry, visibility, and requested placement against the reference map.`,
  ].join("\n\n");
}

export function buildSummary(request: CollageRequestInput) {
  const layoutMaster = usesLayoutMaster(request);
  const lines = [
    `Collage type: ${labelFor(request.collageType)}`,
    `Canvas: ${resolvedSize(request)}`,
    layoutMaster
      ? "Composition: from the uploaded layout master"
      : `Composition: ${labelFor(resolvedComposition(request))}`,
    layoutMaster
      ? "Spacing: from the uploaded layout master"
      : `Spacing: ${labelFor(resolvedDensity(request))}`,
    `Styling: ${labelFor(resolvedStyling(request))}`,
    `Quality: ${labelFor(resolvedQuality(request))}`,
    `Background: ${labelFor(resolvedBackground(request))}`,
    `References: ${totalReferenceCount(request)}/${MAX_REFERENCE_IMAGES}`,
    "Items:",
  ];

  for (const item of activeItems(request)) {
    const count = referenceCount(item);
    lines.push(`- ${item.id}: ${item.role} (${count} image${count === 1 ? "" : "s"})`);
  }

  return lines.join("\n");
}

export function labelFor(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "item";
}
