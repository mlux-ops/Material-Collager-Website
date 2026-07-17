#!/usr/bin/env python3
"""Validate canonical reference geometry and optionally render verification overlays.

This tool is intentionally scoped to audit artifacts. It reads every QA image path
from active-sources.json and never discovers reference PNGs with a glob.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[2]
AUDIT_DIR = ROOT / "artifacts" / "reference-audit"
GEOMETRY_PATH = AUDIT_DIR / "reference-geometry.json"
ACTIVE_SOURCES_PATH = AUDIT_DIR / "active-sources.json"
OVERLAY_DIR = AUDIT_DIR / "geometry-overlays"
BASELINE_DOC = ROOT / "docs" / "pre-scene-lab-regression-baseline.md"
BASELINE_DIR = ROOT / "artifacts" / "pre-scene-lab-baseline"

VIEWPORTS = ("1440x900", "1280x800", "1024x768", "390x844")
ANCHORS = ("p00", "p20", "p40", "p60", "p80", "p100")
ROLE_COLORS = {
    "near": (255, 52, 52),
    "focal": (255, 215, 0),
    "adjacent": (0, 225, 255),
    "mid": (91, 255, 110),
    "far": (204, 128, 255),
}


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def normalized_path(path: str) -> str:
    return Path(path).as_posix()


def classify_aspect(ratio: float) -> str:
    if ratio < 0.85:
        return "portrait"
    if ratio <= 1.2:
        return "square"
    return "landscape"


def edge_intersections(corners: list[list[float]]) -> list[str]:
    """Return viewport boundaries crossed by polygon segments.

    This deliberately tests segment crossings rather than merely checking whether a
    polygon extends outside the viewport.
    """

    boundaries = (("left", 0, 0.0), ("right", 0, 1.0), ("top", 1, 0.0), ("bottom", 1, 1.0))
    hits: list[str] = []
    segments = list(zip(corners, corners[1:] + corners[:1]))
    eps = 1e-9
    for name, axis, boundary in boundaries:
        other = 1 - axis
        for start, end in segments:
            a = start[axis] - boundary
            b = end[axis] - boundary
            if abs(a) <= eps and abs(b) <= eps:
                lo, hi = sorted((start[other], end[other]))
                if hi >= -eps and lo <= 1.0 + eps:
                    hits.append(name)
                    break
            if a * b <= 0 and abs(a - b) > eps:
                t = a / (a - b)
                cross = start[other] + t * (end[other] - start[other])
                if -eps <= cross <= 1.0 + eps:
                    hits.append(name)
                    break
    return hits


def validate_baseline(errors: list[str]) -> None:
    required_files = (
        BASELINE_DOC,
        BASELINE_DIR / "current-library-1440x900.png",
        BASELINE_DIR / "current-generator-1440x900.png",
        BASELINE_DIR / "baseline-results.json",
    )
    for path in required_files:
        if not path.is_file():
            errors.append(f"baseline material missing: {path.relative_to(ROOT)}")
    result_path = BASELINE_DIR / "baseline-results.json"
    if not result_path.is_file():
        return
    results = load_json(result_path)
    required_sections = ("routes", "build", "console", "tests", "generator_smoke")
    for section in required_sections:
        if section not in results:
            errors.append(f"baseline-results.json lacks {section!r}")


def validate_geometry(geometry: dict, active: dict) -> list[str]:
    errors: list[str] = []
    if tuple(geometry.get("viewports", {}).keys()) != VIEWPORTS:
        errors.append("required viewport set or order is invalid")

    allowlist = {normalized_path(path) for path in active.get("raw_canonical_captures", [])}
    track_catalog = geometry.get("track_catalog", {})
    continuity = geometry.get("continuity_policy", {})
    expected_delta = continuity.get("expected_shared_track_slot_delta")
    role_rank = {"far": 0, "mid": 1, "adjacent": 2, "focal": 3, "near": 4}
    all_track_classes: dict[str, set[str]] = {}

    for viewport_name in VIEWPORTS:
        viewport = geometry.get("viewports", {}).get(viewport_name)
        if viewport is None:
            continue
        width, height = viewport.get("width"), viewport.get("height")
        expected_size = tuple(map(int, viewport_name.split("x")))
        if (width, height) != expected_size:
            errors.append(f"{viewport_name}: width/height metadata mismatch")
        anchors = viewport.get("anchors", {})
        if tuple(anchors.keys()) != ANCHORS:
            errors.append(f"{viewport_name}: required anchor set or order is invalid")

        uncertainty = viewport.get("annotation_uncertainty_normalized")
        tolerances = viewport.get("acceptance_tolerances", {})
        focal_tol = tolerances.get("focal_bounds_fraction")
        secondary_tol = tolerances.get("secondary_bounds_fraction")
        overlap_tol = tolerances.get("overlap_fraction")
        for label, tolerance in (("focal", focal_tol), ("secondary", secondary_tol)):
            if not isinstance(tolerance, (int, float)) or not isinstance(uncertainty, (int, float)):
                errors.append(f"{viewport_name}: {label} uncertainty/tolerance is not numeric")
            elif uncertainty > tolerance:
                errors.append(f"{viewport_name}: uncertainty {uncertainty} exceeds {label} tolerance {tolerance}")
        if isinstance(focal_tol, (int, float)) and isinstance(secondary_tol, (int, float)) and secondary_tol <= focal_tol:
            errors.append(f"{viewport_name}: secondary tolerance must be wider than focal tolerance")
        required_overlap = 0.12 if width == 390 else 0.10 if width == 1024 else 0.08
        if not isinstance(overlap_tol, (int, float)) or overlap_tol < required_overlap:
            errors.append(f"{viewport_name}: overlap tolerance must be at least {required_overlap:.0%}")

        previous_tracks: dict[str, dict] | None = None
        viewport_track_occurrences: dict[str, list[tuple[int, dict]]] = {}
        for anchor_index, anchor in enumerate(ANCHORS):
            state = anchors.get(anchor)
            if state is None:
                continue
            source = normalized_path(state.get("source_capture", ""))
            if source not in allowlist:
                errors.append(f"{viewport_name}/{anchor}: QA source is not in active-sources.json: {source}")
            elif not (ROOT / source).is_file():
                errors.append(f"{viewport_name}/{anchor}: allowlisted QA source does not exist: {source}")

            planes = state.get("planes", [])
            if len(planes) != viewport.get("materially_visible_plane_count"):
                errors.append(f"{viewport_name}/{anchor}: plane count differs from full-field count")
            focal_planes = [plane for plane in planes if plane.get("focal")]
            if len(focal_planes) != 1:
                errors.append(f"{viewport_name}/{anchor}: focal count is {len(focal_planes)}, expected 1")
            slots = [plane.get("slot_id") for plane in planes]
            tracks = [plane.get("track_id") for plane in planes]
            if len(set(slots)) != len(slots):
                errors.append(f"{viewport_name}/{anchor}: duplicate slot_id")
            if len(set(tracks)) != len(tracks):
                errors.append(f"{viewport_name}/{anchor}: duplicate track_id")

            current_tracks: dict[str, dict] = {}
            for plane in planes:
                track_id = plane.get("track_id")
                current_tracks[track_id] = plane
                viewport_track_occurrences.setdefault(track_id, []).append((anchor_index, plane))
                catalog = track_catalog.get(track_id)
                if catalog is None:
                    errors.append(f"{viewport_name}/{anchor}/{track_id}: missing track catalog entry")
                corners = plane.get("projected_corners_normalized", [])
                if len(corners) != 4 or any(len(point) != 2 for point in corners):
                    errors.append(f"{viewport_name}/{anchor}/{track_id}: polygon must have four 2D corners")
                    continue
                xs = [point[0] for point in corners]
                ys = [point[1] for point in corners]
                pixel_width = (max(xs) - min(xs)) * width
                pixel_height = (max(ys) - min(ys)) * height
                ratio = pixel_width / pixel_height if pixel_height else math.inf
                if abs(pixel_width - plane.get("projected_pixel_width", math.inf)) > 0.51:
                    errors.append(f"{viewport_name}/{anchor}/{track_id}: projected pixel width mismatch")
                if abs(pixel_height - plane.get("projected_pixel_height", math.inf)) > 0.51:
                    errors.append(f"{viewport_name}/{anchor}/{track_id}: projected pixel height mismatch")
                if abs(ratio - plane.get("projected_pixel_aspect_ratio", math.inf)) > 0.011:
                    errors.append(f"{viewport_name}/{anchor}/{track_id}: projected pixel aspect mismatch")
                expected_class = classify_aspect(ratio)
                if plane.get("aspect_class") != expected_class:
                    errors.append(
                        f"{viewport_name}/{anchor}/{track_id}: aspect_class {plane.get('aspect_class')} conflicts with {ratio:.3f}"
                    )
                if catalog and catalog.get("aspect_class") != plane.get("aspect_class"):
                    errors.append(f"{viewport_name}/{anchor}/{track_id}: aspect_class conflicts with track catalog")
                all_track_classes.setdefault(track_id, set()).add(plane.get("aspect_class"))
                expected_edges = edge_intersections(corners)
                if set(plane.get("viewport_edges_intersected", [])) != set(expected_edges):
                    errors.append(
                        f"{viewport_name}/{anchor}/{track_id}: edge metadata {plane.get('viewport_edges_intersected')} conflicts with {expected_edges}"
                    )
                if plane.get("focal") != (plane.get("role") == "focal"):
                    errors.append(f"{viewport_name}/{anchor}/{track_id}: focal flag and role conflict")

            if previous_tracks is not None:
                for track_id in sorted(set(previous_tracks) & set(current_tracks)):
                    prior = previous_tracks[track_id]
                    current = current_tracks[track_id]
                    prior_slot = int(prior["slot_id"].split("-")[-1])
                    current_slot = int(current["slot_id"].split("-")[-1])
                    if current_slot - prior_slot != expected_delta:
                        errors.append(f"{viewport_name}/{anchor}/{track_id}: track continuity slot delta is invalid")
                    if role_rank.get(current.get("role"), -1) < role_rank.get(prior.get("role"), -1):
                        errors.append(f"{viewport_name}/{anchor}/{track_id}: travelling plane regressed away from camera")
            previous_tracks = current_tracks

        for track_id, occurrences in viewport_track_occurrences.items():
            indices = [index for index, _ in occurrences]
            if indices != list(range(min(indices), max(indices) + 1)):
                errors.append(f"{viewport_name}/{track_id}: track disappears and later reappears")
            for (prior_index, prior), (current_index, current) in zip(occurrences, occurrences[1:]):
                anchor_steps = current_index - prior_index
                prior_slot = int(prior["slot_id"].split("-")[-1])
                current_slot = int(current["slot_id"].split("-")[-1])
                if current_slot - prior_slot != expected_delta * anchor_steps:
                    errors.append(f"{viewport_name}/{track_id}: non-contiguous track slot progression")

    for track_id, classes in sorted(all_track_classes.items()):
        if len(classes) != 1:
            errors.append(f"{track_id}: aspect class changes across anchors/viewports: {sorted(classes)}")

    transition = continuity.get("required_transition_example", {})
    transition_track = transition.get("track_id")
    expected_roles = transition.get("roles_by_visible_anchor", {})
    applicable_viewports = transition.get("applicable_viewports", VIEWPORTS)
    for viewport_name in applicable_viewports:
        viewport = geometry.get("viewports", {}).get(viewport_name, {})
        for anchor, expected_role in expected_roles.items():
            matching = [
                plane
                for plane in viewport.get("anchors", {}).get(anchor, {}).get("planes", [])
                if plane.get("track_id") == transition_track
            ]
            if len(matching) != 1 or matching[0].get("role") != expected_role:
                errors.append(f"{viewport_name}/{anchor}/{transition_track}: required role transition is invalid")

    validate_baseline(errors)
    if geometry.get("locked_after_overlay_verification"):
        for viewport_name in VIEWPORTS:
            for anchor in ANCHORS:
                overlay = OVERLAY_DIR / f"{viewport_name}-{anchor}-geometry-overlay.png"
                if not overlay.is_file():
                    errors.append(f"locked geometry overlay missing: {overlay.relative_to(ROOT)}")
            sheet = OVERLAY_DIR / f"{viewport_name}-geometry-overlay-contact-sheet.png"
            if not sheet.is_file():
                errors.append(f"locked geometry review sheet missing: {sheet.relative_to(ROOT)}")
    return errors


def label_font(scale: float) -> ImageFont.ImageFont:
    size = max(11, round(15 * scale))
    for candidate in ("C:/Windows/Fonts/consola.ttf", "C:/Windows/Fonts/arial.ttf"):
        try:
            return ImageFont.truetype(candidate, size=size)
        except OSError:
            pass
    return ImageFont.load_default()


def render_overlay(viewport_name: str, anchor: str, viewport: dict, state: dict) -> Path:
    source = ROOT / state["source_capture"]
    image = Image.open(source).convert("RGBA")
    draw = ImageDraw.Draw(image, "RGBA")
    width, height = image.size
    scale = max(0.72, min(1.0, width / 1440))
    font = label_font(scale)
    line_width = max(2, round(4 * scale))

    for plane in reversed(state["planes"]):
        points = [(round(x * width), round(y * height)) for x, y in plane["projected_corners_normalized"]]
        color = ROLE_COLORS[plane["role"]]
        draw.line(points + [points[0]], fill=color + (245,), width=line_width, joint="curve")
        if plane["focal"]:
            draw.line(points + [points[0]], fill=(255, 255, 255, 235), width=line_width + 3, joint="curve")
        min_x = max(2, min(point[0] for point in points))
        min_y = max(2, min(point[1] for point in points))
        edge_text = ",".join(plane["viewport_edges_intersected"]) or "none"
        focal_text = " FOCAL" if plane["focal"] else ""
        label = f"{plane['track_id']} {plane['role']} z{plane['z_rank']}{focal_text}\nedges:{edge_text}"
        box = draw.multiline_textbbox((min_x, min_y), label, font=font, spacing=2, stroke_width=0)
        pad = 3
        draw.rectangle((box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad), fill=(0, 0, 0, 190))
        draw.multiline_text((min_x, min_y), label, fill=(255, 255, 255, 255), font=font, spacing=2)

    title = f"{viewport_name} {anchor} | full materially-visible field | raw + annotation"
    title_box = draw.textbbox((8, 8), title, font=font)
    draw.rectangle((4, 4, title_box[2] + 8, title_box[3] + 8), fill=(0, 0, 0, 210))
    draw.text((8, 8), title, fill=(255, 255, 255, 255), font=font)
    OVERLAY_DIR.mkdir(parents=True, exist_ok=True)
    output = OVERLAY_DIR / f"{viewport_name}-{anchor}-geometry-overlay.png"
    image.convert("RGB").save(output, optimize=True)
    return output


def render_contact_sheet(viewport_name: str, overlay_paths: list[Path]) -> Path:
    images = [Image.open(path).convert("RGB") for path in overlay_paths]
    thumb_width = 480
    thumbs = [image.resize((thumb_width, round(image.height * thumb_width / image.width))) for image in images]
    gutter = 12
    label_height = 24
    cell_height = max(image.height for image in thumbs) + label_height
    sheet = Image.new("RGB", (thumb_width * 3 + gutter * 4, cell_height * 2 + gutter * 3), (24, 24, 24))
    draw = ImageDraw.Draw(sheet)
    font = label_font(0.8)
    for index, (anchor, image) in enumerate(zip(ANCHORS, thumbs)):
        column, row = index % 3, index // 3
        x = gutter + column * (thumb_width + gutter)
        y = gutter + row * (cell_height + gutter)
        draw.text((x, y), f"{viewport_name} {anchor}", fill=(255, 255, 255), font=font)
        sheet.paste(image, (x, y + label_height))
    output = OVERLAY_DIR / f"{viewport_name}-geometry-overlay-contact-sheet.png"
    sheet.save(output, optimize=True)
    return output


def write_overlays(geometry: dict) -> tuple[list[Path], list[Path]]:
    overlays: list[Path] = []
    sheets: list[Path] = []
    for viewport_name in VIEWPORTS:
        viewport = geometry["viewports"][viewport_name]
        viewport_overlays = [
            render_overlay(viewport_name, anchor, viewport, viewport["anchors"][anchor]) for anchor in ANCHORS
        ]
        overlays.extend(viewport_overlays)
        sheets.append(render_contact_sheet(viewport_name, viewport_overlays))
    return overlays, sheets


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write-overlays", action="store_true", help="render 24 overlays and four review sheets")
    args = parser.parse_args()
    geometry = load_json(GEOMETRY_PATH)
    active = load_json(ACTIVE_SOURCES_PATH)
    errors = validate_geometry(geometry, active)
    if errors:
        print("Audit validation FAILED:")
        for error in errors:
            print(f"- {error}")
        return 1
    print("Audit validation PASS: 4 viewports × 6 anchors; geometry, continuity, sources, tolerances, and baseline are valid.")
    if args.write_overlays:
        overlays, sheets = write_overlays(geometry)
        print(f"Wrote {len(overlays)} overlays and {len(sheets)} review contact sheets to {OVERLAY_DIR.relative_to(ROOT)}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
