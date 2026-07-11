export const COLLAGE_TYPES = [
  "kitchen_material_palette",
  "appliance_collage",
  "bathroom_fixture_collage",
  "bathroom_tile_collage",
] as const;

export const QUALITIES = ["low", "medium", "high", "auto"] as const;
export const ORIENTATIONS = ["default", "landscape", "portrait", "square"] as const;
export const OUTPUT_RESOLUTIONS = ["standard", "studio"] as const;
export const COMPOSITIONS = ["editorial", "structured", "catalog"] as const;
export const DENSITIES = ["airy", "balanced", "layered"] as const;
export const STYLING_OPTIONS = ["materials_only", "botanical_linen"] as const;
export const LIGHTING_OPTIONS = ["soft_daylight", "crisp_studio"] as const;

export const MAX_REFERENCE_IMAGES = 16;
export const MAX_REFERENCE_FILE_BYTES = 50 * 1024 * 1024;

export type CollageType = (typeof COLLAGE_TYPES)[number];
export type Quality = (typeof QUALITIES)[number];
export type Orientation = (typeof ORIENTATIONS)[number];
export type OutputResolution = (typeof OUTPUT_RESOLUTIONS)[number];
export type Composition = (typeof COMPOSITIONS)[number];
export type Density = (typeof DENSITIES)[number];
export type StylingOption = (typeof STYLING_OPTIONS)[number];
export type LightingOption = (typeof LIGHTING_OPTIONS)[number];

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
  runQa?: boolean;
  items: CollageItemInput[];
};

export const ITEM_PRESETS: Record<CollageType, CollageItemInput[]> = {
  kitchen_material_palette: [
    { id: "wood", role: "wood cabinet or panel sample", required: true },
    { id: "countertop", role: "countertop stone sample", required: true },
    { id: "faucet", role: "kitchen faucet or fixture", required: true },
    { id: "hardware", role: "cabinet hardware", required: true },
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
    { id: "vanity_wood", role: "wood vanity sample", required: true },
    { id: "main_tile", role: "main bathroom tile", required: true },
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

const TYPE_PROMPTS: Record<CollageType, string> = {
  kitchen_material_palette: `Purpose: a luxury residential kitchen material palette for an architecture and interiors editorial.
Use only the referenced materials and fixtures. Do not add tile, appliances, or substitute samples unless they are referenced.`,
  appliance_collage: `Purpose: a luxury appliance product composition for an architecture and interiors editorial.
Use only the referenced appliances. Isolate them cleanly from their source backgrounds and preserve exact product identity.`,
  bathroom_fixture_collage: `Purpose: a luxury bathroom fixture and finish board for an architecture and interiors editorial.
Use only the referenced fixtures, finishes, tile, wood, stone, and hardware. Do not add sanitaryware or plumbing pieces that are not referenced.`,
  bathroom_tile_collage: `Purpose: a luxury bathroom tile and finish palette for an architecture and interiors editorial.
Use only the referenced tile, stone, wood, and metal finish samples. Preserve their real scale relationships and tactile character.`,
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

  if (request.heroItemId && !ids.has(request.heroItemId)) {
    throw new Error("Choose a hero item that is still in the board.");
  }

  if (request.collageType === "bathroom_tile_collage" && resolvedOrientation(request) !== "portrait") {
    throw new Error("Bathroom tile collages use portrait orientation.");
  }
  if (request.collageType !== "bathroom_fixture_collage" && resolvedOrientation(request) === "square") {
    throw new Error("Square format is only available for bathroom fixture collages.");
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

export function resolvedSize(request: CollageRequestInput) {
  const orientation = resolvedOrientation(request);
  if (resolvedOutputResolution(request) === "standard") {
    if (orientation === "portrait") return "1024x1536";
    if (orientation === "square") return "1024x1024";
    return "1536x1024";
  }
  if (orientation === "portrait") return "1360x2048";
  if (orientation === "square") return "2048x2048";
  return "2048x1360";
}

export function buildGenerationPrompt(request: CollageRequestInput) {
  const items = activeItems(request);
  const labels: string[] = [];
  let nextIndex = 1;
  for (const item of items) {
    const count = referenceCount(item);
    const start = nextIndex;
    const end = nextIndex + count - 1;
    const imageRange = start === end ? `Image ${start}` : `Images ${start}-${end}`;
    nextIndex += count;
    const details = [
      `role: ${item.role}`,
      item.brand ? `brand: ${item.brand}` : null,
      item.name ? `product: ${item.name}` : null,
      item.finish ? `finish name: ${item.finish}` : null,
      item.notes ? `specific instruction: ${item.notes}` : null,
    ].filter(Boolean);
    labels.push(`${imageRange} -> item \"${item.id}\" (${details.join("; ")})`);
  }

  const hero = request.heroItemId
    ? `Make item \"${request.heroItemId}\" the visual anchor. It may be largest, but it must remain faithful to its reference.`
    : "Choose the most visually substantial referenced item as the anchor without diminishing any other requested item.";

  return [
    "GOAL",
    "Create one finished, photorealistic interior-design material collage that feels art-directed, restrained, and publication-ready for a leading architecture and interiors magazine.",
    TYPE_PROMPTS[request.collageType],
    "ART DIRECTION",
    COMPOSITION_PROMPTS[resolvedComposition(request)],
    DENSITY_PROMPTS[resolvedDensity(request)],
    LIGHTING_PROMPTS[resolvedLighting(request)],
    STYLING_PROMPTS[resolvedStyling(request)],
    hero,
    "REFERENCE MAP",
    "Use the uploaded images by their exact order below. The images, not the text labels, are the visual source of truth.",
    labels.join("\n"),
    "REFERENCE FIDELITY - NON-NEGOTIABLE",
    `- Include every mapped item exactly once as a distinct collage element. Multiple images mapped to one item are alternate views of that same item, not extra objects.
- For a multi-image item, use the first image as the primary identity view and use every remaining view to resolve geometry, finish, and details.
- Preserve recognizable product identity, silhouette, component count, proportions, edge profile, hardware geometry, finish temperature, sheen, grain direction, veining, pattern scale, texture, and color.
- Remove source backgrounds cleanly, but do not redesign, simplify, mirror, recolor, or substitute the referenced item.
- Metadata clarifies identity and role. If metadata and a visible reference appear to conflict, preserve the visible reference and do not invent a compromise.
- Do not create generic stand-ins. Do not add a material, fixture, appliance, sample, or placeholder that is absent from the reference map.
- Keep each item readable. Overlap may crop only a small nonessential edge; never cover a defining product feature or most of a sample.
- Do not repeat an item unless separate mapped item IDs explicitly request it.`,
    "PHOTOGRAPHY AND FINISH",
    `- True overhead camera with corrected perspective; no oblique room scene and no rendered interior.
- Seamless pure white background (#FFFFFF) with no gray cast, vignette, border, frame, or colored surface.
- Realistic material thickness, contact shadows, reflective behavior, and edge detail. Avoid CGI gloss, plastic-looking stone, fake wood grain, warped fixtures, and impossible shadows.
- Sophisticated scale hierarchy, quiet negative space, clean cutout edges, and a cohesive editorial color balance.
- No text, labels, annotations, dimensions, logos added by the model, watermarks, people, hands, packaging, swatch names, or unrequested objects. The selected editorial styling option, if any, is the only exception.`,
    "OUTPUT",
    `Orientation: ${resolvedOrientation(request)}. Canvas: ${resolvedSize(request)}. Deliver one complete collage, not a contact sheet, presentation page, or set of alternatives.`,
  ].join("\n\n");
}

export function buildSummary(request: CollageRequestInput) {
  const lines = [
    `Collage type: ${labelFor(request.collageType)}`,
    `Canvas: ${resolvedSize(request)}`,
    `Composition: ${labelFor(resolvedComposition(request))}`,
    `Spacing: ${labelFor(resolvedDensity(request))}`,
    `Styling: ${labelFor(resolvedStyling(request))}`,
    `Quality: ${labelFor(request.quality)}`,
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
