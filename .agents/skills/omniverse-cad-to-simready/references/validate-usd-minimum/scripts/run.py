#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import argparse
from dataclasses import dataclass, field
import json
from pathlib import Path
import sys
from typing import Any, Iterable

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "shared"))

from script_utils import usd_bounds_metadata


SKILL = "validate-usd-minimum"
TOOL = "pxr.Usd"
DEFAULT_NEXT_STEP = "omni-asset-validate"
PHYSICS_COUNT_KEYS = ("rigid_body_count", "collider_count", "joint_count")


@dataclass(frozen=True)
class ValidationCheck:
    name: str
    passed: bool
    message: str
    severity: str = "error"

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "passed": self.passed,
            "severity": self.severity,
            "message": self.message,
        }


@dataclass(frozen=True)
class MinimumUsdValidationReport:
    asset_path: str
    validator_skill: str
    validator_tool: str
    passed: bool
    checks: list[ValidationCheck]
    metadata: dict[str, Any]
    warnings: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    next_step: str = DEFAULT_NEXT_STEP

    def to_dict(self) -> dict[str, Any]:
        return {
            "asset_path": self.asset_path,
            "validator_skill": self.validator_skill,
            "validator_tool": self.validator_tool,
            "passed": self.passed,
            "checks": [check.to_dict() for check in self.checks],
            "metadata": self.metadata,
            "warnings": self.warnings,
            "errors": self.errors,
            "next_step": self.next_step,
        }

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), indent=2, sort_keys=True) + "\n"

    def to_markdown(self) -> str:
        lines = [
            "# Minimum USD Validation Report",
            "",
            f"- Asset: `{self.asset_path}`",
            f"- Validator skill: `{self.validator_skill}`",
            f"- Validator tool: `{self.validator_tool}`",
            f"- Passed: `{self.passed}`",
            f"- Next step: `{self.next_step}`",
            "",
            "## Checks",
            "",
        ]
        for check in self.checks:
            state = "PASS" if check.passed else "FAIL"
            lines.append(f"- `{state}` `{check.name}`: {check.message}")
        lines.extend(["", "## Errors", ""])
        lines.extend(f"- {error}" for error in self.errors)
        if not self.errors:
            lines.append("- None")
        lines.extend(["", "## Warnings", ""])
        lines.extend(f"- {warning}" for warning in self.warnings)
        if not self.warnings:
            lines.append("- None")
        lines.append("")
        return "\n".join(lines)


_check = ValidationCheck


def _base_metadata() -> dict[str, Any]:
    return {
        "default_prim_path": None,
        "meters_per_unit": None,
        "up_axis": None,
        "prim_count": 0,
        "all_prim_count": 0,
        "mesh_count": 0,
        "prototype_count": 0,
        "prototype_paths": [],
        "prototype_prim_count": 0,
        "prototype_mesh_count": 0,
        "prototype_material_binding_count": 0,
        "authored_reference_count": 0,
        "authored_reference_prim_count": 0,
        "material_binding_count": 0,
        "rigid_body_count": 0,
        "collider_count": 0,
        "joint_count": 0,
        "bounds": {"stage_units": None, "meters": None},
        "root_prim_paths": [],
        "used_layers": [],
    }


def validate_minimum_usd(asset_path: Path, next_step: str = DEFAULT_NEXT_STEP) -> MinimumUsdValidationReport:
    asset_path = asset_path.resolve()
    checks: list[ValidationCheck] = []
    warnings: list[str] = []
    errors: list[str] = []
    metadata = _base_metadata()

    exists = asset_path.exists()
    checks.append(_check("asset_exists", exists, "Asset path exists" if exists else "Asset path does not exist"))
    if not exists:
        errors.append("Asset path does not exist")
        return _report(asset_path, False, checks, metadata, warnings, errors, next_step)

    try:
        from pxr import Usd, UsdGeom, UsdPhysics
    except Exception as exc:
        message = f"OpenUSD Python modules are unavailable: {exc}"
        checks.append(_check("openusd_python_available", False, message))
        errors.append(message)
        return _report(asset_path, False, checks, metadata, warnings, errors, next_step)

    checks.append(_check("openusd_python_available", True, "OpenUSD Python modules are available", "info"))
    try:
        stage = Usd.Stage.Open(str(asset_path), Usd.Stage.LoadAll)
    except Exception as exc:
        stage = None
        warnings.append(f"Stage open raised {type(exc).__name__}: {exc}")

    stage_opens = stage is not None
    checks.append(_check("stage_opens", stage_opens, "Stage opens" if stage_opens else "Stage cannot be opened"))
    if stage is None:
        errors.append("Stage cannot be opened")
        return _report(asset_path, False, checks, metadata, warnings, errors, next_step)

    default_prim = stage.GetDefaultPrim()
    default_prim_valid = bool(default_prim and default_prim.IsValid())
    metadata["default_prim_path"] = str(default_prim.GetPath()) if default_prim_valid else None
    checks.append(
        _check(
            "default_prim_valid",
            default_prim_valid,
            "Default prim is valid" if default_prim_valid else "Default prim is missing or invalid",
        )
    )

    up_axis = UsdGeom.GetStageUpAxis(stage)
    metadata["up_axis"] = str(up_axis) if up_axis else None
    checks.append(_check("up_axis_available", bool(up_axis), "Stage up-axis is available" if up_axis else "Stage up-axis is missing"))

    meters_per_unit = UsdGeom.GetStageMetersPerUnit(stage)
    metadata["meters_per_unit"] = meters_per_unit
    checks.append(
        _check(
            "meters_per_unit_available",
            meters_per_unit is not None,
            "Stage metersPerUnit is available" if meters_per_unit is not None else "Stage metersPerUnit is missing",
        )
    )

    metadata.update(_collect_usd_structure_metadata(Usd, UsdGeom, UsdPhysics, stage, meters_per_unit=meters_per_unit))

    prims = list(stage.Traverse())
    checks.append(_check("has_prims", len(prims) > 0, "Stage has prims" if prims else "Stage has no prims"))

    root_prims = stage.GetPseudoRoot().GetChildren()
    metadata["root_prim_paths"] = [str(prim.GetPath()) for prim in root_prims]
    checks.append(
        _check(
            "has_root_prims",
            bool(root_prims),
            "Stage has root prims" if root_prims else "Stage has no root prims",
        )
    )

    used_layers = stage.GetUsedLayers()
    metadata["used_layers"] = [layer.identifier for layer in used_layers]
    if len(used_layers) > 1:
        warnings.append("Asset uses multiple layers")

    errors.extend(check.message for check in checks if check.severity == "error" and not check.passed)
    return _report(asset_path, not errors, checks, metadata, warnings, errors, next_step)


def _report(
    asset_path: Path,
    passed: bool,
    checks: list[ValidationCheck],
    metadata: dict[str, Any],
    warnings: list[str],
    errors: list[str],
    next_step: str,
) -> MinimumUsdValidationReport:
    return MinimumUsdValidationReport(
        asset_path=str(asset_path),
        validator_skill=SKILL,
        validator_tool=TOOL,
        passed=passed,
        checks=checks,
        metadata=metadata,
        warnings=warnings,
        errors=errors,
        next_step=next_step,
    )


def _collect_usd_structure_metadata(
    Usd: Any,
    UsdGeom: Any,
    UsdPhysics: Any,
    stage: Any,
    *,
    meters_per_unit: float | None = None,
) -> dict[str, Any]:
    stage_prims = list(stage.Traverse())
    all_stage_prims = list(stage.TraverseAll())
    prototypes = list(stage.GetPrototypes())
    prototype_prims = [prim for prototype in prototypes for prim in Usd.PrimRange(prototype)]
    return {
        "load_policy": "LoadAll",
        "prim_count": len(stage_prims),
        "all_prim_count": len(all_stage_prims),
        "mesh_count": _count_meshes(UsdGeom, all_stage_prims),
        "prototype_count": len(prototypes),
        "prototype_paths": [str(prototype.GetPath()) for prototype in prototypes],
        "prototype_prim_count": len(prototype_prims),
        "prototype_mesh_count": _count_meshes(UsdGeom, prototype_prims),
        "prototype_material_binding_count": _count_material_bindings(prototype_prims),
        "authored_reference_count": _count_authored_references(all_stage_prims),
        "authored_reference_prim_count": sum(1 for prim in all_stage_prims if prim.HasAuthoredReferences()),
        "material_binding_count": _count_material_bindings(all_stage_prims),
        "rigid_body_count": _count_applied_api(all_stage_prims, UsdPhysics.RigidBodyAPI),
        "collider_count": _count_applied_api(all_stage_prims, UsdPhysics.CollisionAPI),
        "joint_count": sum(1 for prim in all_stage_prims if prim.IsA(UsdPhysics.Joint)),
        "bounds": usd_bounds_metadata(
            Usd,
            UsdGeom,
            stage,
            meters_per_unit=meters_per_unit,
            use_extents_hint=True,
            fallback_to_pseudo_root=True,
            empty_as_null=True,
        ),
    }


def _count_meshes(UsdGeom: Any, prims: Iterable[Any]) -> int:
    return sum(1 for prim in prims if prim.IsA(UsdGeom.Mesh))


def _count_applied_api(prims: Iterable[Any], api_schema: Any) -> int:
    return sum(1 for prim in prims if prim.HasAPI(api_schema))


def _count_authored_references(prims: Iterable[Any]) -> int:
    count = 0
    for prim in prims:
        if not prim.HasAuthoredReferences():
            continue
        references = prim.GetMetadata("references")
        if references is None or not hasattr(references, "GetAddedOrExplicitItems"):
            count += 1
            continue
        items = references.GetAddedOrExplicitItems()
        count += len(items) if items else 1
    return count


def _count_material_bindings(prims: Iterable[Any]) -> int:
    count = 0
    for prim in prims:
        count += sum(
            1
            for relationship in prim.GetAuthoredRelationships()
            if relationship.GetName().startswith("material:binding")
        )
    return count


def emit_report(
    report: MinimumUsdValidationReport,
    *,
    report_path: Path | None = None,
    markdown_report_path: Path | None = None,
) -> None:
    report_json = report.to_json()
    if report_path is not None:
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(report_json, encoding="utf-8")
    if markdown_report_path is not None:
        markdown_report_path.parent.mkdir(parents=True, exist_ok=True)
        markdown_report_path.write_text(report.to_markdown(), encoding="utf-8")
    print(report_json, end="")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Validate minimum OpenUSD asset viability.")
    parser.add_argument("asset_path", type=Path)
    parser.add_argument("--next-step", default=DEFAULT_NEXT_STEP)
    parser.add_argument("--report", type=Path, help="Write a JSON report to this path.")
    parser.add_argument("--markdown-report", type=Path, help="Write a Markdown report to this path.")
    args = parser.parse_args(argv)

    report = validate_minimum_usd(args.asset_path, next_step=args.next_step)
    emit_report(report, report_path=args.report, markdown_report_path=args.markdown_report)
    return 0 if report.passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
