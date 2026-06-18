#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import argparse
import json
from pathlib import Path
import shutil
import sys
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[5] / "shared"))

from script_utils import check_result as _check, emit_json_report, resolve_output_path


SKILL = "FET_000_CORE"
SIMREADY_METADATA_LAYER_KEY = "SimReady_Metadata"
SUPPORTED_USD_EXTENSIONS = {".usd", ".usda", ".usdc", ".usdz"}
ROOT_LAYER_EXTENSIONS = {".usd", ".usda", ".usdc"}
AUTHORING_TOOL = "pxr.Usd rootLayer.Save"


def _load_extra_metadata(metadata_json: Path | None) -> dict[str, Any]:
    if metadata_json is None:
        return {}
    payload = json.loads(metadata_json.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"{metadata_json} must contain a JSON object")
    return payload


def _build_metadata(
    *,
    asset_path: Path,
    output_path: Path,
    identifier: str | None,
    version: str,
    description: str | None,
    profile: str,
    profile_version: str,
    source_asset: str | None,
    generated_by: str,
    author: str | None,
    tags: list[str],
    pipeline_steps: list[str],
    extra_metadata: dict[str, Any],
) -> dict[str, Any]:
    resolved_identifier = identifier or output_path.stem
    metadata: dict[str, Any] = {
        "identifier": resolved_identifier,
        "version": version,
        "description": description or f"SimReady metadata for {resolved_identifier}",
        "profile": profile,
        "profile_version": profile_version,
        "source_asset": source_asset or asset_path.name,
        "generated_by": generated_by,
        "pipeline": pipeline_steps or [SKILL],
    }
    if author:
        metadata["author"] = author
    if tags:
        metadata["tags"] = tags
    metadata.update(extra_metadata)
    return metadata


def _custom_layer_metadata(metadata: dict[str, Any]) -> dict[str, str]:
    layer_metadata: dict[str, str] = {}
    for key, value in metadata.items():
        if value is None:
            continue
        if isinstance(value, (dict, list, tuple)):
            layer_metadata[key] = json.dumps(value, sort_keys=True)
        else:
            layer_metadata[key] = str(value)
    return layer_metadata


def _report(
    *,
    asset_path: Path,
    output_path: Path | None,
    operation: str,
    metadata: dict[str, Any],
    custom_layer_written: bool,
    sidecar_path: Path | None,
    checks: list[dict[str, Any]],
    warnings: list[str],
    next_step: str,
) -> dict[str, Any]:
    errors = [check["message"] for check in checks if check["severity"] == "error" and not check["passed"]]
    requirements_repaired = ["NP.006"] if not errors and (custom_layer_written or sidecar_path is not None) else []
    return {
        "asset_path": str(asset_path),
        "skill": SKILL,
        "tool": AUTHORING_TOOL,
        "passed": not errors,
        "status": "PASS" if not errors else "FAIL",
        "operation": operation,
        "output_usd_path": str(output_path) if output_path is not None else None,
        "requirements_repaired": requirements_repaired,
        "metadata": metadata,
        "custom_layer_key": SIMREADY_METADATA_LAYER_KEY,
        "custom_layer_written": custom_layer_written,
        "sidecar_json_path": str(sidecar_path) if sidecar_path is not None else None,
        "checks": checks,
        "warnings": warnings,
        "errors": errors,
        "next_step": next_step,
    }


def apply_metadata(args: argparse.Namespace) -> dict[str, Any]:
    asset_path = args.asset_path.resolve()
    output_path = resolve_output_path(
        asset_path,
        args.output,
        args.output_dir,
        args.in_place,
        default_stem_suffix="_simready",
    ).resolve()
    operation = "in_place" if args.in_place else "copy_and_apply_metadata"
    checks: list[dict[str, Any]] = []
    warnings: list[str] = []
    metadata: dict[str, Any] = {}
    custom_layer_written = False
    sidecar_path: Path | None = None

    exists = asset_path.exists()
    checks.append(_check("asset_exists", exists, "Asset path exists" if exists else "Asset path does not exist"))
    supported_suffix = asset_path.suffix.lower() in SUPPORTED_USD_EXTENSIONS
    checks.append(_check("supported_usd_extension", supported_suffix, "Asset uses a supported USD extension" if supported_suffix else "Asset must be .usd, .usda, .usdc, or .usdz"))
    if args.in_place and (args.output is not None or args.output_dir is not None):
        checks.append(_check("output_mode_valid", False, "Use either --in-place or an output path, not both"))
    elif args.output is not None and args.output_dir is not None:
        checks.append(_check("output_mode_valid", False, "Use either --output or --output-dir, not both"))
    elif not args.in_place and output_path == asset_path:
        checks.append(_check("output_mode_valid", False, "Output path matches input path; use --in-place to edit the source asset"))
    else:
        checks.append(_check("output_mode_valid", True, "Output mode is valid"))
    if any(check["severity"] == "error" and not check["passed"] for check in checks):
        return _report(asset_path=asset_path, output_path=output_path, operation=operation, metadata=metadata, custom_layer_written=False, sidecar_path=None, checks=checks, warnings=warnings, next_step=args.next_step)

    try:
        extra_metadata = _load_extra_metadata(args.metadata_json)
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        checks.append(_check("metadata_json_valid", False, f"Metadata JSON is invalid: {exc}"))
        return _report(asset_path=asset_path, output_path=output_path, operation=operation, metadata=metadata, custom_layer_written=False, sidecar_path=None, checks=checks, warnings=warnings, next_step=args.next_step)
    checks.append(_check("metadata_json_valid", True, "Metadata JSON is valid" if args.metadata_json else "No metadata JSON override provided", "info"))

    metadata = _build_metadata(
        asset_path=asset_path,
        output_path=output_path,
        identifier=args.identifier,
        version=args.version,
        description=args.description,
        profile=args.profile,
        profile_version=args.profile_version,
        source_asset=args.source_asset,
        generated_by=args.generated_by,
        author=args.author,
        tags=args.tags,
        pipeline_steps=args.pipeline_steps,
        extra_metadata=extra_metadata,
    )
    if not args.no_sidecar:
        sidecar_path = (args.sidecar_json or output_path.with_suffix(".json")).resolve()
        if sidecar_path.exists() and not args.force:
            checks.append(_check("sidecar_available", False, f"Sidecar JSON already exists: {sidecar_path}"))
            return _report(asset_path=asset_path, output_path=output_path, operation=operation, metadata=metadata, custom_layer_written=False, sidecar_path=None, checks=checks, warnings=warnings, next_step=args.next_step)
    if not args.in_place:
        if output_path.exists() and not args.force:
            checks.append(_check("output_available", False, f"Output path already exists: {output_path}"))
            return _report(asset_path=asset_path, output_path=output_path, operation=operation, metadata=metadata, custom_layer_written=False, sidecar_path=sidecar_path, checks=checks, warnings=warnings, next_step=args.next_step)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(asset_path, output_path)
        checks.append(_check("output_prepared", True, f"Copied source asset to {output_path}", "info"))
    else:
        checks.append(_check("output_prepared", True, "Editing source asset in place", "info"))

    if output_path.suffix.lower() in ROOT_LAYER_EXTENSIONS:
        try:
            from pxr import Usd
            stage = Usd.Stage.Open(str(output_path))
        except Exception as exc:
            stage = None
            warnings.append(f"OpenUSD stage open raised {type(exc).__name__}: {exc}")
        checks.append(_check("stage_opens", stage is not None, "Stage opens" if stage is not None else "Stage cannot be opened"))
        if stage is not None:
            root_layer = stage.GetRootLayer()
            custom_layer_data = dict(root_layer.customLayerData)
            custom_layer_data[SIMREADY_METADATA_LAYER_KEY] = _custom_layer_metadata(metadata)
            root_layer.customLayerData = custom_layer_data
            custom_layer_written = bool(root_layer.Save())
            checks.append(_check("custom_layer_written", custom_layer_written, f"Authored root layer customLayerData[{SIMREADY_METADATA_LAYER_KEY!r}]" if custom_layer_written else "Failed to save root layer metadata"))
    else:
        warnings.append("USDZ root layers are not edited; metadata is written as sidecar JSON only")
        checks.append(_check("custom_layer_written", True, "Skipped root layer metadata for USDZ sidecar-only mode", "warning"))

    if sidecar_path is not None:
        sidecar_path.parent.mkdir(parents=True, exist_ok=True)
        sidecar_path.write_text(json.dumps(metadata, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        checks.append(_check("sidecar_written", True, f"Wrote sidecar metadata to {sidecar_path}", "info"))
    else:
        checks.append(_check("sidecar_written", True, "Sidecar metadata disabled", "info"))
    warnings.append("Grasp vectors are not authored by this FET000 Core metadata script; handle GSP.001 with FET_005_SIMULATE_GRASP_PHYSICS.")
    return _report(asset_path=asset_path, output_path=output_path, operation=operation, metadata=metadata, custom_layer_written=custom_layer_written, sidecar_path=sidecar_path, checks=checks, warnings=warnings, next_step=args.next_step)


def emit(payload: dict[str, Any], report_path: Path | None, markdown_report_path: Path | None) -> None:
    emit_json_report(
        payload,
        report_path,
        markdown_report_path,
        f"# FET000 Core Metadata Repair Report\n\n- Passed: `{payload['passed']}`",
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Author SimReady Core metadata onto a USD asset.")
    parser.add_argument("asset_path", type=Path)
    output_group = parser.add_mutually_exclusive_group()
    output_group.add_argument("--output", type=Path)
    output_group.add_argument("--output-dir", type=Path)
    output_group.add_argument("--in-place", action="store_true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--identifier")
    parser.add_argument("--version", default="1.0.0")
    parser.add_argument("--description")
    parser.add_argument("--profile", default="Prop-Robotics-Neutral")
    parser.add_argument("--profile-version", default="1.0.0")
    parser.add_argument("--source-asset")
    parser.add_argument("--generated-by", default="physical-ai-skill-hub")
    parser.add_argument("--author")
    parser.add_argument("--tag", dest="tags", action="append", default=[])
    parser.add_argument("--pipeline-step", dest="pipeline_steps", action="append", default=[])
    parser.add_argument("--metadata-json", type=Path)
    parser.add_argument("--sidecar-json", type=Path)
    parser.add_argument("--no-sidecar", action="store_true")
    parser.add_argument("--next-step", default="simready-validate")
    parser.add_argument("--report", type=Path)
    parser.add_argument("--markdown-report", type=Path)
    args = parser.parse_args(argv)
    payload = apply_metadata(args)
    emit(payload, args.report, args.markdown_report)
    return 0 if payload["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
