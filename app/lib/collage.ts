export const COLLAGE_TYPES = [
  "kitchen_material_palette",
  "appliance_collage",
  "bathroom_fixture_collage",
  "bathroom_tile_collage",
] as const;

export const QUALITIES = ["low", "medium", "high", "auto"] as const;
export const ORIENTATIONS = ["default", "landscape", "portrait", "square"] as const;

export type CollageType = (typeof COLLAGE_TYPES)[number];
export type Quality = (typeof QUALITIES)[number];
export type Orientation = (typeof ORIENTATIONS)[number];

export type CollageItemInput = {
  id: string;
  role: string;
  imageKeys?: string[];
  imageNames?: string[];
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
  outputFilename?: string;
  apiKey?: string;
  runQa?: boolean;
  items: CollageItemInput[];
};

export type UploadedReference = {
  key: string;
  file: File;
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
  kitchen_material_palette: `Collage type: Kitchen Material Palette.
Create an elegant interior design flat-lay mood board photograph on a clean white surface.
Arrange the referenced materials and fixtures in a curated overhead composition: wood, countertop stone, faucet or fixture, cabinet hardware, and flooring samples.
No subway tile. No ceramic tile of any kind. No full appliances. Use materials and samples only.
Include subtle olive or eucalyptus sprigs and a natural linen or waffle-weave towel corner.
Style should feel warm, luxurious, residential, and magazine-quality.`,
  appliance_collage: `Collage type: Appliance Collage.
Create a clean editorial appliance product collage on a pure white background.
Use only the appliances from the reference images. Remove source-image backgrounds.
No styling greenery, plants, towels, material samples, labels, annotations, or decorative extras.
Each appliance must remain clearly visible and recognizable as the exact product shown in its source image.
Preserve the product form, door configuration, handle shape, surface finish, proportions, and edge details.
Arrange dynamically like a luxury appliance advertisement, with subtle drop shadows and clean edges.`,
  bathroom_fixture_collage: `Collage type: Bathroom Fixture Collage.
Create a high-end bathroom fixture flat-lay product collage on a clean white background.
Include the referenced bathroom fixtures, cabinet hardware, vanity wood, main tile, and countertop/stone sample.
Do not include any toilet, bathtub, sink basin, large porcelain fixture, or unrequested plumbing piece.
Include olive or eucalyptus sprigs and a natural linen or waffle-weave towel corner.
Let the fixture finish, wood, tile, and stone samples fill the frame naturally while keeping breathing room.`,
  bathroom_tile_collage: `Collage type: Bathroom Tile Collage.
Create an interior design tile and finish mood board collage for a luxury bathroom.
Arrange overlapping tile and material samples in an editorial flat-lay: wall tile, floor tile, accent or mosaic tile, vanity wood, countertop stone, and metal finish sample or hardware.
Items may extend slightly beyond the frame.
Include subtle olive or eucalyptus sprigs and a natural linen or waffle-weave towel corner.
The result should feel warm, curated, tactile, and magazine-quality.`,
};

const UNIVERSAL_STYLE_RULES = `Universal style rules:
- Pure white background, no exceptions.
- Editorial overhead flat-lay composition with an organic curated arrangement, not a grid.
- Soft natural light from the upper-left with subtle drop shadows so items float on the white surface.
- Photorealistic product photography quality, never illustrated or cartoon.
- Leave breathing room; do not crowd items.
- Slight overlap between items is encouraged when it feels natural.
- The hero item should be the most prominent item.
- No text, labels, annotations, watermarks, or callouts in the generated image.
- No colored background.
- Do not include unrequested objects.`;

const METAL_FINISH_RULES = `Metal finish reference:
- Brushed Moderne Brass: warm, matte, slightly amber-toned brass; not shiny gold and not yellow.
- Polished Chrome: bright, mirror-like, cool silver.
- Matte Black: flat black with zero sheen.
- Brilliance Stainless Steel: cool-toned brushed stainless; not brass, not gold, not warm.
- Brushed Nickel: warmer than chrome, satin finish.
- Polished Nickel: bright but slightly warmer than chrome.`;

export function validateCollageRequest(request: CollageRequestInput, filesByKey?: Map<string, File>) {
  if (!COLLAGE_TYPES.includes(request.collageType)) {
    throw new Error("Choose a supported collage type.");
  }
  if (!QUALITIES.includes(request.quality)) {
    throw new Error("Choose a supported quality.");
  }
  if (!ORIENTATIONS.includes(request.orientation)) {
    throw new Error("Choose a supported orientation.");
  }

  const items = activeItems(request);
  if (!items.length) {
    throw new Error("Add at least one item.");
  }

  for (const item of items) {
    if (!item.role.trim()) {
      throw new Error(`Item ${item.id || "without an id"} needs a role.`);
    }
    const imageKeys = item.imageKeys ?? [];
    const imageNames = item.imageNames ?? [];
    if (!imageKeys.length && !imageNames.length) {
      throw new Error(`Add at least one reference image for ${item.id || item.role}.`);
    }
    if (filesByKey) {
      for (const key of imageKeys) {
        const file = filesByKey.get(key);
        if (!file) {
          throw new Error(`Missing uploaded file for ${item.id || item.role}.`);
        }
        if (!file.type.startsWith("image/")) {
          throw new Error(`${file.name} is not an image file.`);
        }
      }
    }
  }

  if (request.collageType === "bathroom_tile_collage" && resolvedOrientation(request) !== "portrait") {
    throw new Error("Bathroom tile collages use portrait orientation.");
  }
  if (request.collageType !== "bathroom_fixture_collage" && resolvedOrientation(request) === "square") {
    throw new Error("Square format is only available for bathroom fixture collages.");
  }
}

export function activeItems(request: CollageRequestInput) {
  return request.items.filter((item) => item.required !== false || (item.imageKeys?.length ?? item.imageNames?.length ?? 0) > 0);
}

export function resolvedOrientation(request: CollageRequestInput) {
  if (request.orientation !== "default") return request.orientation;
  if (request.collageType === "bathroom_tile_collage") return "portrait";
  return "landscape";
}

export function resolvedSize(request: CollageRequestInput) {
  const orientation = resolvedOrientation(request);
  if (orientation === "portrait") return "1024x1536";
  if (orientation === "square") return "1024x1024";
  return "1536x1024";
}

export function buildGenerationPrompt(request: CollageRequestInput) {
  const labels: string[] = [];
  let nextIndex = 1;
  for (const item of activeItems(request)) {
    const count = Math.max(item.imageKeys?.length ?? 0, item.imageNames?.length ?? 0);
    const start = nextIndex;
    const end = nextIndex + count - 1;
    const imageRange = start === end ? `Image ${start}` : `Images ${start}-${end}`;
    nextIndex += count;
    const details = [
      item.role,
      item.brand ? `brand: ${item.brand}` : null,
      item.name ? `name: ${item.name}` : null,
      item.finish ? `finish: ${item.finish}` : null,
      item.notes ? `notes: ${item.notes}` : null,
    ].filter(Boolean);
    labels.push(`- ${imageRange}: item \`${item.id || slugify(item.role)}\` (${details.join("; ")})`);
  }

  const parts = [
    "Create one finished high-end interior design material collage board.",
    TYPE_PROMPTS[request.collageType],
    UNIVERSAL_STYLE_RULES,
    METAL_FINISH_RULES,
    "Reference image mapping. The image model can see these actual uploaded image files; use them directly as visual references:",
    labels.join("\n"),
    `Reference handling rules:
- Preserve each referenced item's exact visible material, finish tone, proportions, geometry, texture, grain, veining, and physical style.
- Do not invent alternate products when a reference image is provided.
- Do not rely on the item labels as visual descriptions; the uploaded images are the visual source of truth.
- Use metadata only to clarify item role, brand, finish name, and placement priority.
- If multiple images belong to one item, treat them as alternate views of the same item unless notes say otherwise.`,
    `Output requirements:
- Orientation: ${resolvedOrientation(request)}.
- Canvas size target: ${resolvedSize(request)}.
- Background must be pure white.
- Photorealistic overhead product photography.`,
  ];

  if (request.collageType === "appliance_collage") {
    parts.push("Appliance collage exception: no greenery, no towel, no botanical styling.");
  }

  return parts.join("\n\n");
}

export function buildSummary(request: CollageRequestInput) {
  const lines = [
    `Collage type: ${labelFor(request.collageType)}`,
    `Orientation: ${labelFor(resolvedOrientation(request))}`,
    `Size: ${resolvedSize(request)}`,
    `Quality: ${labelFor(request.quality)}`,
    "Items:",
  ];

  for (const item of activeItems(request)) {
    const count = Math.max(item.imageKeys?.length ?? 0, item.imageNames?.length ?? 0);
    lines.push(`- ${item.id || slugify(item.role)}: ${item.role} (${count} image${count === 1 ? "" : "s"})`);
  }

  return lines.join("\n");
}

export function labelFor(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "item";
}

