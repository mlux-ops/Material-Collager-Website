"""Request schema and validation for material collage generation."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


class ValidationError(ValueError):
    """Raised when a collage request is invalid."""


COLLAGE_TYPES = {
    "kitchen_material_palette",
    "appliance_collage",
    "bathroom_fixture_collage",
    "bathroom_tile_collage",
}

ORIENTATIONS = {"landscape", "portrait", "square"}
QUALITIES = {"low", "medium", "high", "auto"}
OUTPUT_FORMATS = {"png", "jpeg", "webp"}
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}

DEFAULT_ORIENTATION_BY_TYPE = {
    "kitchen_material_palette": "landscape",
    "appliance_collage": "landscape",
    "bathroom_fixture_collage": "landscape",
    "bathroom_tile_collage": "portrait",
}

DEFAULT_SIZE_BY_ORIENTATION = {
    "landscape": "1536x1024",
    "portrait": "1024x1536",
    "square": "1024x1024",
}

REQUIRED_ROLES_BY_TYPE = {
    "kitchen_material_palette": [
        "wood",
        "countertop",
        "faucet",
        "hardware",
        "flooring",
    ],
    "appliance_collage": [
        "appliance",
    ],
    "bathroom_fixture_collage": [
        "vanity faucet",
        "shower",
        "valve",
        "hardware",
        "wood",
        "tile",
        "countertop",
    ],
    "bathroom_tile_collage": [
        "wall tile",
        "floor tile",
        "accent tile",
        "wood",
        "countertop",
        "metal",
    ],
}


@dataclass(frozen=True)
class CollageItem:
    """One material, appliance, fixture, or styling reference."""

    id: str
    role: str
    image_paths: tuple[Path, ...]
    brand: str | None = None
    name: str | None = None
    finish: str | None = None
    notes: str | None = None
    required: bool = True

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "CollageItem":
        missing = [key for key in ("id", "role", "image_paths") if key not in data]
        if missing:
            raise ValidationError(f"Item is missing required field(s): {', '.join(missing)}")

        raw_paths = data["image_paths"]
        if not isinstance(raw_paths, list) or not raw_paths:
            raise ValidationError(f"Item {data.get('id', '<unknown>')} must include image_paths.")

        return cls(
            id=_nonempty_string(data["id"], "item.id"),
            role=_nonempty_string(data["role"], f"{data['id']}.role"),
            image_paths=tuple(Path(path) for path in raw_paths),
            brand=_optional_string(data.get("brand"), f"{data['id']}.brand"),
            name=_optional_string(data.get("name"), f"{data['id']}.name"),
            finish=_optional_string(data.get("finish"), f"{data['id']}.finish"),
            notes=_optional_string(data.get("notes"), f"{data['id']}.notes"),
            required=bool(data.get("required", True)),
        )

    def to_prompt_label(self, start_index: int) -> str:
        """Return a compact label mapping this item to image reference numbers."""

        end_index = start_index + len(self.image_paths) - 1
        if start_index == end_index:
            image_range = f"Image {start_index}"
        else:
            image_range = f"Images {start_index}-{end_index}"

        details = [self.role]
        if self.brand:
            details.append(f"brand: {self.brand}")
        if self.name:
            details.append(f"name: {self.name}")
        if self.finish:
            details.append(f"finish: {self.finish}")
        if self.notes:
            details.append(f"notes: {self.notes}")

        return f"- {image_range}: item `{self.id}` ({'; '.join(details)})"


@dataclass(frozen=True)
class CollageRequest:
    """Top-level request for one collage board."""

    collage_type: str
    items: tuple[CollageItem, ...]
    orientation: str | None = None
    quality: str = "high"
    output_path: Path | None = None
    output_format: str = "png"
    auto_retry: int = 0

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "CollageRequest":
        collage_type = _nonempty_string(data.get("collage_type"), "collage_type")
        if collage_type not in COLLAGE_TYPES:
            raise ValidationError(
                f"Unsupported collage_type `{collage_type}`. "
                f"Use one of: {', '.join(sorted(COLLAGE_TYPES))}."
            )

        raw_items = data.get("items")
        if not isinstance(raw_items, list) or not raw_items:
            raise ValidationError("Request must include at least one item.")

        orientation = data.get("orientation")
        if orientation is not None:
            orientation = _nonempty_string(orientation, "orientation")
            if orientation not in ORIENTATIONS:
                raise ValidationError(
                    f"Unsupported orientation `{orientation}`. "
                    f"Use one of: {', '.join(sorted(ORIENTATIONS))}."
                )

        quality = _optional_string(data.get("quality"), "quality") or "high"
        if quality not in QUALITIES:
            raise ValidationError(
                f"Unsupported quality `{quality}`. Use one of: {', '.join(sorted(QUALITIES))}."
            )

        output_format = _optional_string(data.get("output_format"), "output_format") or "png"
        if output_format not in OUTPUT_FORMATS:
            raise ValidationError(
                f"Unsupported output_format `{output_format}`. "
                f"Use one of: {', '.join(sorted(OUTPUT_FORMATS))}."
            )

        return cls(
            collage_type=collage_type,
            items=tuple(CollageItem.from_dict(item) for item in raw_items),
            orientation=orientation,
            quality=quality,
            output_path=Path(data["output_path"]) if data.get("output_path") else None,
            output_format=output_format,
            auto_retry=int(data.get("auto_retry", 0)),
        )

    @classmethod
    def from_json_file(cls, path: str | Path) -> "CollageRequest":
        with Path(path).open("r", encoding="utf-8-sig") as file:
            return cls.from_dict(json.load(file))

    def resolved_orientation(self) -> str:
        return self.orientation or DEFAULT_ORIENTATION_BY_TYPE[self.collage_type]

    def resolved_size(self) -> str:
        return DEFAULT_SIZE_BY_ORIENTATION[self.resolved_orientation()]

    def all_image_paths(self) -> tuple[Path, ...]:
        paths: list[Path] = []
        for item in self.items:
            paths.extend(item.image_paths)
        return tuple(paths)

    def validate_paths(self) -> None:
        for item in self.items:
            for path in item.image_paths:
                if not path.exists():
                    raise ValidationError(f"Image path does not exist for `{item.id}`: {path}")
                if not path.is_file():
                    raise ValidationError(f"Image path is not a file for `{item.id}`: {path}")
                if path.suffix.lower() not in IMAGE_SUFFIXES:
                    raise ValidationError(
                        f"Unsupported image type for `{item.id}`: {path}. "
                        f"Use one of: {', '.join(sorted(IMAGE_SUFFIXES))}."
                    )

    def validate_required_roles(self) -> None:
        required_roles = REQUIRED_ROLES_BY_TYPE[self.collage_type]
        normalized_roles = " | ".join(item.role.lower() for item in self.items if item.required)
        missing = [role for role in required_roles if role not in normalized_roles]

        if missing and self.collage_type != "appliance_collage":
            raise ValidationError(
                "Request appears to be missing required item role(s): "
                f"{', '.join(missing)}. Add items or mark intentional omissions with notes."
            )

    def validate(self, *, check_paths: bool = True, check_roles: bool = False) -> None:
        if not self.items:
            raise ValidationError("Request must include at least one item.")
        for item in self.items:
            if not item.image_paths:
                raise ValidationError(f"Item `{item.id}` must include at least one image path.")
        if self.auto_retry < 0:
            raise ValidationError("auto_retry must be 0 or greater.")
        if check_roles:
            self.validate_required_roles()
        if check_paths:
            self.validate_paths()


def _nonempty_string(value: Any, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValidationError(f"{field_name} must be a non-empty string.")
    return value.strip()


def _optional_string(value: Any, field_name: str) -> str | None:
    if value is None:
        return None
    return _nonempty_string(value, field_name)

