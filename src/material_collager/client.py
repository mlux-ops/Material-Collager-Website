"""OpenAI Image API client for material collage generation."""

from __future__ import annotations

import base64
import os
from contextlib import ExitStack
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .models import CollageRequest
from .prompts import build_generation_prompt


@dataclass(frozen=True)
class CollageResult:
    """Result from one image generation request."""

    output_path: Path
    prompt: str
    model: str
    size: str
    quality: str
    usage: Any | None = None


def generate_collage(
    request: CollageRequest,
    *,
    client: Any | None = None,
    output_path: str | Path | None = None,
    model: str = "gpt-image-2",
) -> CollageResult:
    """Generate a collage using OpenAI image references and save it to disk."""

    request.validate(check_paths=True, check_roles=False)
    prompt = build_generation_prompt(request)
    destination = Path(output_path or request.output_path or "material_collage.png")
    destination.parent.mkdir(parents=True, exist_ok=True)

    api_client = client or _make_openai_client()

    with ExitStack() as stack:
        image_files = [
            stack.enter_context(path.open("rb"))
            for path in request.all_image_paths()
        ]
        response = api_client.images.edit(
            model=model,
            image=image_files,
            prompt=prompt,
            size=request.resolved_size(),
            quality=request.quality,
            background="opaque",
            output_format=request.output_format,
        )

    image_base64 = response.data[0].b64_json
    destination.write_bytes(base64.b64decode(image_base64))

    return CollageResult(
        output_path=destination,
        prompt=prompt,
        model=model,
        size=request.resolved_size(),
        quality=request.quality,
        usage=getattr(response, "usage", None),
    )


def _make_openai_client() -> Any:
    if not os.environ.get("OPENAI_API_KEY"):
        raise RuntimeError("OPENAI_API_KEY is required to generate collages.")
    try:
        from openai import OpenAI
    except ImportError as exc:
        raise RuntimeError(
            "The `openai` package is required. Install with: python -m pip install -e ."
        ) from exc
    return OpenAI()

