"""Prompt building for collage generation."""

from __future__ import annotations

from .models import CollageRequest


UNIVERSAL_STYLE_RULES = """Universal style rules:
- Seamless pure white background (#FFFFFF).
- Editorial overhead flat-lay composition with an organic curated arrangement, not a grid.
- Soft neutral light from the upper-left with realistic contact shadows, edge detail, and material thickness.
- Photorealistic product photography quality, never illustrated or cartoon.
- Leave breathing room; do not crowd items.
- Slight overlap between items is encouraged when it feels natural.
- The hero item should be the most prominent item.
- No text, labels, annotations, watermarks, or callouts in the generated image.
- Do not include unrequested objects."""


METAL_FINISH_RULES = """Metal finish reference:
- Brushed Moderne Brass: warm, matte, slightly amber-toned brass; not shiny gold and not yellow.
- Polished Chrome: bright, mirror-like, cool silver.
- Matte Black: flat black with zero sheen.
- Brilliance Stainless Steel: cool-toned brushed stainless; not brass, not gold, not warm.
- Brushed Nickel: warmer than chrome, satin finish.
- Polished Nickel: bright but slightly warmer than chrome."""

# The glossary above only earns its place when some item actually carries a
# metal finish; a tile-only board gains nothing from it. Matched against each
# item's finish, name, role and notes.
_METAL_FINISH_KEYWORDS = ("brass", "chrome", "nickel", "stainless", "bronze", "matte black", "metal")


def _mentions_metal_finish(request: CollageRequest) -> bool:
    for item in request.items:
        haystack = " ".join(
            value for value in (item.finish, item.name, item.role, item.notes) if value
        ).lower()
        if any(keyword in haystack for keyword in _METAL_FINISH_KEYWORDS):
            return True
    return False


TYPE_PROMPTS = {
    "kitchen_material_palette": """Collage type: Kitchen Material Palette.
Create an elegant interior design flat-lay mood board photograph on a clean white surface.
Arrange the referenced materials and fixtures in a curated overhead composition: wood, countertop stone, faucet or fixture, cabinet hardware, and flooring samples.
No subway tile. No ceramic tile of any kind. No full appliances. Use materials and samples only.
Include subtle olive or eucalyptus sprigs and a natural linen or waffle-weave towel corner.
Style should feel warm, luxurious, residential, and magazine-quality.""",
    "appliance_collage": """Collage type: Appliance Collage.
Create a clean editorial appliance product collage on a pure white background.
Use only the appliances from the reference images. Remove source-image backgrounds.
No styling greenery, plants, towels, material samples, labels, annotations, or decorative extras.
Each appliance must remain clearly visible and recognizable as the exact product shown in its source image.
Preserve the product form, door configuration, handle shape, surface finish, proportions, and edge details.
Arrange dynamically like a luxury appliance advertisement, with subtle drop shadows and clean edges.""",
    "bathroom_fixture_collage": """Collage type: Bathroom Fixture Collage.
Create a high-end bathroom fixture flat-lay product collage on a clean white background.
Include the referenced bathroom fixtures, cabinet hardware, vanity wood, main tile, and countertop/stone sample.
Do not include any toilet, bathtub, sink basin, large porcelain fixture, or unrequested plumbing piece.
Include olive or eucalyptus sprigs and a natural linen or waffle-weave towel corner.
Let the fixture finish, wood, tile, and stone samples fill the frame naturally while keeping breathing room.""",
    "bathroom_tile_collage": """Collage type: Bathroom Tile Collage.
Create an interior design tile and finish mood board collage for a luxury bathroom.
Arrange overlapping tile and material samples in an editorial flat-lay: wall tile, floor tile, accent or mosaic tile, vanity wood, countertop stone, and metal finish sample or hardware.
Items may extend slightly beyond the frame.
Include subtle olive or eucalyptus sprigs and a natural linen or waffle-weave towel corner.
The result should feel warm, curated, tactile, and magazine-quality.""",
}


def build_generation_prompt(request: CollageRequest) -> str:
    """Build the image-generation prompt while preserving direct image references."""

    request.validate(check_paths=False, check_roles=False)
    labels = []
    next_index = 1
    for item in request.items:
        labels.append(item.to_prompt_label(next_index))
        next_index += len(item.image_paths)

    object_count = len(request.items)
    total_images = sum(len(item.image_paths) for item in request.items)
    supporting = total_images - object_count
    ids = ", ".join(f"`{item.id}`" for item in request.items)
    object_count_lines = [
        f"Object count: the finished collage contains exactly {object_count} referenced "
        f"object{'' if object_count == 1 else 's'}, one per item id: {ids}."
    ]
    if supporting:
        object_count_lines.append(
            f"{supporting} of the {total_images} uploaded images "
            f"{'is a supporting view' if supporting == 1 else 'are supporting views'} that add no object "
            "of their own."
        )
    if request.collage_type != "appliance_collage":
        object_count_lines.append(
            "Styling props are excluded from this product count; allow at most one sprig and one small linen corner."
        )

    supporting_rules = []
    if supporting:
        supporting_rules = [
            "- A supporting view is another photograph of the SAME physical item, never a second object. Use it to resolve geometry, hidden faces, thickness, component count, and pattern scale. Where they disagree, the primary view decides identity, color, and finish.",
            "- Never place a supporting view on the canvas as its own element: no duplicates, mirrored twins, insets, exploded parts, or spare swatches.",
        ]

    prompt_parts = [
        "Create one finished high-end interior design material collage board.",
        TYPE_PROMPTS[request.collage_type],
        UNIVERSAL_STYLE_RULES,
        *([METAL_FINISH_RULES] if _mentions_metal_finish(request) else []),
        "Reference image mapping. The image model can see these actual uploaded image files; use them directly as visual references:",
        "\n".join(labels),
        " ".join(object_count_lines),
        "Reference handling rules:",
        "- Preserve each referenced item's exact visible material, finish tone, proportions, geometry, texture, grain, veining, and physical style.",
        "- Do not invent alternate products when a reference image is provided.",
        "- Do not rely on the item labels as visual descriptions; the uploaded images are the visual source of truth.",
        "- Use metadata only to clarify item role, brand, finish name, and placement priority.",
        *supporting_rules,
        "Output requirements:",
        f"- Orientation: {request.resolved_orientation()}.",
        f"- Canvas size target: {request.resolved_size()}.",
        "- Check product count, finish, geometry, visibility, and requested placement against the reference map before finishing.",
    ]

    if request.collage_type == "appliance_collage":
        prompt_parts.append("- Appliance collage exception: no greenery, no towel, no botanical styling.")

    return "\n\n".join(prompt_parts)

