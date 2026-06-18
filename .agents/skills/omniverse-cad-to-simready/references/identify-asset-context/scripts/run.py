#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import sys
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "shared"))

from script_utils import emit_json_report


SKILL = "identify-asset-context"
TEXTUAL_EXTENSIONS = {".dae", ".ifc", ".iges", ".igs", ".mjcf", ".obj", ".step", ".stp", ".urdf", ".xml"}
CAD_EXTENSIONS = {".dgn", ".ifc", ".ifczip", ".iges", ".igs", ".step", ".stp"}
USD_EXTENSIONS = {".usd", ".usda", ".usdc", ".usdz"}
MESH_EXTENSIONS = {".fbx", ".obj", ".gltf", ".glb", ".dae", ".stl"}
GSPLAT_EXTENSIONS = {".ply", ".spz"}
PRODUCT_TOKEN_RE = re.compile(r"(?<![A-Za-z0-9])[A-Z0-9]{2,}(?:[-_][A-Z0-9]{2,})+(?=[^A-Za-z0-9]|$)")
TIMESTAMP_TOKEN_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{1,2}$")
FILE_NAME_RE = re.compile(r"FILE_NAME\s*\(\s*'([^']*)'", re.IGNORECASE)
FILE_DESCRIPTION_RE = re.compile(r"FILE_DESCRIPTION\s*\(\s*\(\s*'([^']*)'", re.IGNORECASE)
FILE_SCHEMA_RE = re.compile(r"FILE_SCHEMA\s*\(\s*\(\s*'([^']*)'", re.IGNORECASE)
SYSTEM_RE = re.compile(r"'([^']*(?:SolidWorks|SwSTEP|Open CASCADE|CATIA|Creo|NX|Inventor)[^']*)'", re.IGNORECASE)
STEP_IDENTIFIER_BLACKLIST = {
    "AXIS2_PLACEMENT_3D",
    "CARTESIAN_POINT",
    "DIRECTION",
    "FILE_DESCRIPTION",
    "FILE_NAME",
    "FILE_SCHEMA",
    "GEOMETRIC_REPRESENTATION_CONTEXT",
    "ISO-10303-21",
    "LENGTH_UNIT",
    "NAMED_UNIT",
    "PLANE_ANGLE_UNIT",
    "SI_UNIT",
    "SOLID_ANGLE_UNIT",
}


def _real_suffix(path: Path) -> str:
    name = path.name.lower()
    for suffix in (".tar.gz", ".usdz"):
        if name.endswith(suffix):
            return suffix
    return path.suffix.lower()


def _detect_source_format(path: Path) -> str:
    suffix = _real_suffix(path)
    if suffix in USD_EXTENSIONS:
        return "usd"
    if suffix in CAD_EXTENSIONS:
        return "cad"
    if suffix in MESH_EXTENSIONS:
        return "mesh"
    if suffix in GSPLAT_EXTENSIONS:
        return "gsplat"
    if suffix == ".urdf":
        return "urdf"
    if suffix in {".xml", ".mjcf"}:
        try:
            text = path.read_text(encoding="utf-8", errors="replace")[:4096].lower()
        except OSError:
            return "xml"
        if "<mujoco" in text:
            return "mjcf"
        if "<robot" in text:
            return "urdf"
        return "xml"
    return "unknown"


def _dedupe(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        normalized = value.strip()
        if not normalized:
            continue
        key = normalized.lower()
        if key in seen:
            continue
        seen.add(key)
        result.append(normalized)
    return result


def _text_excerpt(asset_path: Path, max_chars: int) -> tuple[str, list[str]]:
    if _real_suffix(asset_path) not in TEXTUAL_EXTENSIONS:
        return "", []
    try:
        text = asset_path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return "", [f"Could not read text excerpt: {exc}"]
    warnings = [f"Content excerpt truncated to {max_chars} characters"] if len(text) > max_chars else []
    return text[:max_chars], warnings


def _metadata_from_excerpt(excerpt: str) -> dict[str, Any]:
    metadata: dict[str, Any] = {}
    file_name_match = FILE_NAME_RE.search(excerpt)
    if file_name_match:
        metadata["file_name"] = file_name_match.group(1)
    description_match = FILE_DESCRIPTION_RE.search(excerpt)
    if description_match:
        metadata["file_description"] = description_match.group(1)
    schema_match = FILE_SCHEMA_RE.search(excerpt)
    if schema_match:
        metadata["file_schema"] = schema_match.group(1)
    systems = _dedupe([match.group(1) for match in SYSTEM_RE.finditer(excerpt)])
    if systems:
        metadata["authoring_systems"] = systems
    compact_excerpt = re.sub(r"\s+", "", excerpt)
    if "SI_UNIT(.MILLI.,.METRE." in compact_excerpt:
        metadata["length_unit_hint"] = "millimeter"
    return metadata


def _product_identifiers(text: str) -> list[str]:
    identifiers: list[str] = []
    for match in PRODUCT_TOKEN_RE.findall(text):
        if match in STEP_IDENTIFIER_BLACKLIST:
            continue
        if TIMESTAMP_TOKEN_RE.match(match):
            continue
        if "_" in match and "-" not in match:
            continue
        if not any(character.isalpha() for character in match):
            continue
        if not any(character.isdigit() for character in match):
            continue
        if match.startswith(("ISO-", "FILE_", "SI_")) or match.endswith("_3D"):
            continue
        if re.search(r"E[-_]\d", match):
            continue
        identifiers.append(match)
    return identifiers


def _local_identifiers(asset_path: Path, excerpt: str, metadata: dict[str, Any]) -> list[str]:
    candidates = [asset_path.name, asset_path.stem]
    metadata_file_name = metadata.get("file_name")
    if isinstance(metadata_file_name, str):
        candidates.extend([metadata_file_name, Path(metadata_file_name).stem])
    candidates.extend(_product_identifiers(asset_path.name))
    candidates.extend(_product_identifiers(excerpt[:200_000]))
    return _dedupe(candidates)


def _recommended_web_queries(asset_path: Path, identifiers: list[str], metadata: dict[str, Any]) -> list[str]:
    queries = [f'"{asset_path.name}"', f'"{asset_path.stem}"']
    for identifier in identifiers:
        if identifier not in {asset_path.name, asset_path.stem}:
            queries.append(f'"{identifier}"')
    file_schema = metadata.get("file_schema")
    query_identifiers = [
        identifier
        for identifier in identifiers
        if identifier not in {asset_path.name, asset_path.stem} and "." not in identifier and " " not in identifier
    ]
    query_identifiers.extend(identifier for identifier in identifiers if identifier not in query_identifiers)
    if isinstance(file_schema, str):
        for identifier in query_identifiers[:4]:
            queries.append(f'"{identifier}" "{file_schema}"')
    for identifier in query_identifiers[:4]:
        queries.append(f'"{identifier}" CAD')
    return _dedupe(queries)[:12]


def _prompt_seed(identifiers: list[str], metadata: dict[str, Any]) -> str:
    parts = ["Use the source asset context and cited web evidence when predicting visual materials and physics."]
    if identifiers:
        parts.append(f"Local identifiers: {', '.join(identifiers[:8])}.")
    file_schema = metadata.get("file_schema")
    if file_schema:
        parts.append(f"Source schema: {file_schema}.")
    systems = metadata.get("authoring_systems")
    if isinstance(systems, list) and systems:
        parts.append(f"Authoring/export systems: {', '.join(str(value) for value in systems[:4])}.")
    parts.append("Prefer specific manufacturer/product information over visual guesses; mark uncertain material or physics assumptions.")
    return " ".join(parts)


def inspect_source_asset(asset_path: Path, *, max_excerpt_chars: int) -> dict[str, Any]:
    asset_path = asset_path.resolve()
    warnings: list[str] = []
    errors: list[str] = []
    if not asset_path.exists():
        errors.append(f"asset path does not exist: {asset_path}")
        return {
            "asset_path": str(asset_path),
            "source_format": "unknown",
            "suffix": asset_path.suffix.lower(),
            "file_name": asset_path.name,
            "file_size_bytes": None,
            "local_identifiers": [],
            "source_metadata": {},
            "geometry_summary": {},
            "content_excerpt": "",
            "recommended_web_queries": [],
            "material_physics_prompt_seed": "",
            "warnings": warnings,
            "errors": errors,
            "next_step": "web-research-asset-context",
            "passed": False,
        }

    excerpt, excerpt_warnings = _text_excerpt(asset_path, max_excerpt_chars)
    warnings.extend(excerpt_warnings)
    metadata = _metadata_from_excerpt(excerpt)
    identifiers = _local_identifiers(asset_path, excerpt, metadata)
    if _real_suffix(asset_path) in CAD_EXTENSIONS:
        warnings.append("CAD geometry summary skipped; conversion delegates to upstream usd-convert-cad / CAD Converter tooling only")

    return {
        "asset_path": str(asset_path),
        "source_format": _detect_source_format(asset_path),
        "suffix": _real_suffix(asset_path),
        "file_name": asset_path.name,
        "file_size_bytes": asset_path.stat().st_size,
        "local_identifiers": identifiers,
        "source_metadata": metadata,
        "geometry_summary": {},
        "content_excerpt": excerpt,
        "recommended_web_queries": _recommended_web_queries(asset_path, identifiers, metadata),
        "material_physics_prompt_seed": _prompt_seed(identifiers, metadata),
        "warnings": warnings,
        "errors": errors,
        "next_step": "web-research-asset-context",
        "passed": True,
    }


def _markdown(report: dict[str, Any]) -> str:
    lines = [
        "# Source Asset Context Inspection",
        "",
        f"- Asset: `{report['asset_path']}`",
        f"- Source format: `{report['source_format']}`",
        f"- File name: `{report['file_name']}`",
        f"- Suffix: `{report['suffix']}`",
        f"- Passed: `{report['passed']}`",
        f"- Next step: `{report['next_step']}`",
        "",
        "## Local Identifiers",
        "",
    ]
    lines.extend(f"- `{identifier}`" for identifier in report["local_identifiers"])
    if not report["local_identifiers"]:
        lines.append("- None")
    lines.extend(["", "## Recommended Web Queries", ""])
    lines.extend(f"- `{query}`" for query in report["recommended_web_queries"])
    if not report["recommended_web_queries"]:
        lines.append("- None")
    lines.extend(["", "## Material/Physics Prompt Seed", "", report["material_physics_prompt_seed"] or "None"])
    lines.extend(["", "## Content Excerpt", "", "```text", report["content_excerpt"], "```"])
    if report["warnings"]:
        lines.extend(["", "## Warnings", ""])
        lines.extend(f"- {warning}" for warning in report["warnings"])
    if report["errors"]:
        lines.extend(["", "## Errors", ""])
        lines.extend(f"- {error}" for error in report["errors"])
    lines.append("")
    return "\n".join(lines)


def _emit(report: dict[str, Any], report_path: Path | None, markdown_report_path: Path | None) -> None:
    emit_json_report(report, report_path, markdown_report_path, _markdown(report))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Inspect source asset metadata and emit search/query context.")
    parser.add_argument("asset_path", type=Path)
    parser.add_argument("--max-excerpt-chars", type=int, default=20_000)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--markdown-report", type=Path)
    args = parser.parse_args(argv)

    report = inspect_source_asset(args.asset_path, max_excerpt_chars=args.max_excerpt_chars)
    _emit(report, args.report, args.markdown_report)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
