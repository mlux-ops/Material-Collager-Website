"""Command line interface for the material collage agent."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .client import generate_collage
from .models import COLLAGE_TYPES, CollageItem, CollageRequest, ValidationError
from .prompts import build_generation_prompt
from .qa import review_collage


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    try:
        if args.command == "dry-run":
            return _dry_run(args)
        if args.command == "generate":
            return _generate(args)
        if args.command == "wizard":
            return _wizard(args)
    except (RuntimeError, ValidationError, OSError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    parser.print_help()
    return 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="material-collager",
        description="Generate high-end material collage boards from direct image references.",
    )
    subparsers = parser.add_subparsers(dest="command")

    dry_run = subparsers.add_parser("dry-run", help="Validate a request and preview the prompt.")
    dry_run.add_argument("--input", required=True, help="Path to request JSON.")
    dry_run.add_argument("--check-roles", action="store_true", help="Enforce expected item roles.")

    generate = subparsers.add_parser("generate", help="Generate a collage image.")
    generate.add_argument("--input", required=True, help="Path to request JSON.")
    generate.add_argument("--output", help="Output image path.")
    generate.add_argument("--auto-retry", type=int, default=None, help="Automatic QA retry count.")
    generate.add_argument("--skip-qa", action="store_true", help="Skip the vision QA pass.")

    wizard = subparsers.add_parser("wizard", help="Guided interactive request builder.")
    wizard.add_argument("--save-request", help="Optional path to save the request JSON.")
    wizard.add_argument("--output", help="Output image path.")
    wizard.add_argument("--skip-generate", action="store_true", help="Only build the request JSON.")

    return parser


def _dry_run(args: argparse.Namespace) -> int:
    request = CollageRequest.from_json_file(args.input)
    request.validate(check_paths=True, check_roles=args.check_roles)
    print(_request_summary(request))
    print("\n--- Generation Prompt ---\n")
    print(build_generation_prompt(request))
    return 0


def _generate(args: argparse.Namespace) -> int:
    request = CollageRequest.from_json_file(args.input)
    if args.auto_retry is not None:
        request = CollageRequest(
            collage_type=request.collage_type,
            items=request.items,
            orientation=request.orientation,
            quality=request.quality,
            output_path=request.output_path,
            output_format=request.output_format,
            auto_retry=args.auto_retry,
        )

    result = generate_collage(request, output_path=args.output)
    print(f"Generated collage: {result.output_path}")

    if args.skip_qa:
        return 0

    qa = review_collage(result.output_path, request)
    print(f"QA passed: {qa.passed}")
    if qa.findings:
        print("Findings:")
        for finding in qa.findings:
            print(f"- {finding}")
    if qa.recommendation:
        print(f"Recommendation: {qa.recommendation}")

    retries_remaining = request.auto_retry
    while not qa.passed and retries_remaining > 0:
        retries_remaining -= 1
        print("Regenerating because QA did not pass...")
        result = generate_collage(request, output_path=args.output)
        print(f"Generated collage: {result.output_path}")
        qa = review_collage(result.output_path, request)
        print(f"QA passed: {qa.passed}")

    return 0 if qa.passed else 3


def _wizard(args: argparse.Namespace) -> int:
    print("High-End Material Collage Agent")
    collage_type = _ask_choice("Collage type", sorted(COLLAGE_TYPES))
    orientation = _ask_optional("Orientation override (blank for default, or landscape/portrait/square)")
    quality = _ask_optional("Quality (blank for high, or low/medium/high/auto)") or "high"

    items: list[CollageItem] = []
    print("\nAdd each collage item. Leave item id blank when finished.")
    while True:
        item_id = _ask_optional("Item id")
        if not item_id:
            break
        role = _ask_required("Item role")
        paths = _ask_required("Image paths for this item, separated by semicolons")
        brand = _ask_optional("Brand")
        name = _ask_optional("Name")
        finish = _ask_optional("Finish")
        notes = _ask_optional("Notes")
        items.append(
            CollageItem(
                id=item_id,
                role=role,
                image_paths=tuple(Path(path.strip()) for path in paths.split(";") if path.strip()),
                brand=brand,
                name=name,
                finish=finish,
                notes=notes,
                required=True,
            )
        )

    request = CollageRequest(
        collage_type=collage_type,
        items=tuple(items),
        orientation=orientation or None,
        quality=quality,
        output_path=Path(args.output) if args.output else None,
    )
    request.validate(check_paths=True, check_roles=False)

    print("\nReview before generation:")
    print(_request_summary(request))
    confirm = _ask_optional("Generate now? Type YES to continue")
    if confirm != "YES":
        _save_request_if_requested(request, args.save_request)
        print("Stopped before generation.")
        return 0

    _save_request_if_requested(request, args.save_request)
    if args.skip_generate:
        print("Request saved; generation skipped.")
        return 0

    result = generate_collage(request, output_path=args.output)
    print(f"Generated collage: {result.output_path}")

    qa = review_collage(result.output_path, request)
    print(f"QA passed: {qa.passed}")
    for finding in qa.findings:
        print(f"- {finding}")
    if qa.recommendation:
        print(f"Recommendation: {qa.recommendation}")
    return 0


def _request_summary(request: CollageRequest) -> str:
    lines = [
        f"Collage type: {request.collage_type}",
        f"Orientation: {request.resolved_orientation()}",
        f"Size: {request.resolved_size()}",
        f"Quality: {request.quality}",
        "Items:",
    ]
    for item in request.items:
        lines.append(f"- {item.id}: {item.role} ({len(item.image_paths)} image path(s))")
    return "\n".join(lines)


def _save_request_if_requested(request: CollageRequest, path: str | None) -> None:
    if not path:
        return

    data = {
        "collage_type": request.collage_type,
        "orientation": request.orientation,
        "quality": request.quality,
        "output_path": str(request.output_path) if request.output_path else None,
        "items": [
            {
                "id": item.id,
                "role": item.role,
                "image_paths": [str(path) for path in item.image_paths],
                "brand": item.brand,
                "name": item.name,
                "finish": item.finish,
                "notes": item.notes,
                "required": item.required,
            }
            for item in request.items
        ],
    }
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(data, indent=2), encoding="utf-8")
    print(f"Saved request: {destination}")


def _ask_choice(label: str, choices: list[str]) -> str:
    print(f"{label}:")
    for index, choice in enumerate(choices, start=1):
        print(f"  {index}. {choice}")
    while True:
        raw = input("> ").strip()
        if raw.isdigit() and 1 <= int(raw) <= len(choices):
            return choices[int(raw) - 1]
        if raw in choices:
            return raw
        print("Please choose a listed value.")


def _ask_required(label: str) -> str:
    while True:
        raw = input(f"{label}: ").strip()
        if raw:
            return raw
        print("This value is required.")


def _ask_optional(label: str) -> str | None:
    raw = input(f"{label}: ").strip()
    return raw or None


if __name__ == "__main__":
    raise SystemExit(main())

