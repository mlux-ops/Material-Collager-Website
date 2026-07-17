"""Vision QA review for generated material collage boards."""

from __future__ import annotations

import base64
import json
import mimetypes
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .models import CollageRequest, ValidationError


@dataclass(frozen=True)
class QAResult:
    """Structured result from the post-generation QA pass."""

    passed: bool
    findings: list[str]
    recommendation: str
    raw_text: str


QA_SYSTEM_PROMPT = """You are a meticulous interior design production art director.
Evaluate whether the generated material collage meets the request and reference images.
Return only compact JSON with keys: passed, findings, recommendation.
Use passed=false if any item mismatches its reference, the background is not pure white,
the composition is rigid/grid-like, there are labels/text, or unrequested objects appear."""


def review_collage(
    result_path: str | Path,
    request: CollageRequest,
    *,
    client: Any | None = None,
    model: str | None = None,
) -> QAResult:
    """Run a vision QA pass against the generated image and its references."""

    request.validate(check_paths=True, check_roles=False)
    result = Path(result_path)
    if not result.exists():
        raise ValidationError(f"Generated image does not exist: {result}")

    api_client = client or _make_openai_client()
    qa_model = model or os.environ.get("MATERIAL_COLLAGER_QA_MODEL", "gpt-5.5")

    content: list[dict[str, Any]] = [
        {
            "type": "input_text",
            "text": _build_qa_prompt(request),
        },
        {
            "type": "input_image",
            "image_url": _image_to_data_url(result),
        },
    ]

    for path in request.all_image_paths():
        content.append({"type": "input_image", "image_url": _image_to_data_url(path)})

    response = api_client.responses.create(
        model=qa_model,
        instructions=QA_SYSTEM_PROMPT,
        input=[{"role": "user", "content": content}],
    )

    raw_text = _extract_text(response)
    return _parse_qa_text(raw_text)


def _build_qa_prompt(request: CollageRequest) -> str:
    lines = [
        "The first image is the generated collage. All following images are the original item references, in the same order used for generation.",
        f"Collage type: {request.collage_type}",
        f"Expected orientation: {request.resolved_orientation()}",
        "Evaluate these criteria:",
        "- Every requested product/material matches its reference image in finish, color, form, and style.",
        "- Composition is organic editorial flat-lay, not a grid.",
        "- Background is pure white.",
        "- There is no visible text, label, annotation, or watermark.",
        "- There are no unrequested items such as toilets, tubs, sink basins, extra fixtures, or extra appliances.",
        "- Appliance collages have no greenery or towel styling.",
        "Requested items:",
    ]
    for item in request.items:
        metadata = [item.role]
        if item.brand:
            metadata.append(f"brand={item.brand}")
        if item.name:
            metadata.append(f"name={item.name}")
        if item.finish:
            metadata.append(f"finish={item.finish}")
        if item.notes:
            metadata.append(f"notes={item.notes}")
        lines.append(f"- {item.id}: {', '.join(metadata)}")
    return "\n".join(lines)


def _parse_qa_text(raw_text: str) -> QAResult:
    cleaned = raw_text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        if cleaned.startswith("json"):
            cleaned = cleaned[4:].strip()

    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError:
        return QAResult(
            passed=False,
            findings=["QA response was not valid JSON."],
            recommendation="Review the generated image manually before using it.",
            raw_text=raw_text,
        )

    findings = data.get("findings") or []
    if isinstance(findings, str):
        findings = [findings]

    return QAResult(
        passed=bool(data.get("passed", False)),
        findings=[str(finding) for finding in findings],
        recommendation=str(data.get("recommendation", "")),
        raw_text=raw_text,
    )


def _image_to_data_url(path: Path) -> str:
    mime_type = mimetypes.guess_type(path.name)[0] or "image/png"
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime_type};base64,{encoded}"


def _extract_text(response: Any) -> str:
    text = getattr(response, "output_text", None)
    if text:
        return str(text)

    chunks: list[str] = []
    for output in getattr(response, "output", []) or []:
        for content in getattr(output, "content", []) or []:
            value = getattr(content, "text", None)
            if value:
                chunks.append(str(value))
    return "\n".join(chunks)


def _make_openai_client() -> Any:
    if not os.environ.get("OPENAI_API_KEY"):
        raise RuntimeError("OPENAI_API_KEY is required to review collages.")
    try:
        from openai import OpenAI
    except ImportError as exc:
        raise RuntimeError(
            "The `openai` package is required. Install with: python -m pip install -e ."
        ) from exc
    return OpenAI()

