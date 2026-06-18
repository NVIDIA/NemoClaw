#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import argparse
from contextlib import redirect_stdout
import json
import os
from pathlib import Path
import shutil
import sys
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[5] / "shared"))

from script_utils import check_result, emit_json_report, resolve_output_path, usd_bounds_metadata


SKILL = "FET_001_MINIMAL"
TOOL = "pxr.Usd/UsdGeom unit normalization"
AUTHORING_METADATA = "physical-ai-skill-hub FET_001_MINIMAL/scripts/run.py v0.1.0"
SUPPORTED_USD_EXTENSIONS = {".usd", ".usda", ".usdc"}
DEFAULT_PROFILE = "Prop-Robotics-Neutral"
DEFAULT_PROFILE_VERSION = "1.0.0"
DEFAULT_FET001_VERSION = "0.1.0"
TARGET_METERS_PER_UNIT = 1.0
METER_NORMALIZATION_OP_SUFFIX = "meter_normalization"
SAVE_BACKENDS = ("root-layer", "usdex")
DEFAULT_SAVE_BACKEND = os.environ.get("FET001_SAVE_BACKEND", "root-layer")


_check = check_result


def _bounds_metadata(Usd: Any, UsdGeom: Any, stage: Any, *, meters_per_unit: float) -> dict[str, Any]:
    return usd_bounds_metadata(
        Usd,
        UsdGeom,
        stage,
        meters_per_unit=meters_per_unit,
        use_extents_hint=False,
        fallback_to_pseudo_root=False,
        empty_as_null=False,
    )


def _max_delta(left: list[float], right: list[float]) -> float:
    return max((abs(a - b) for a, b in zip(left, right)), default=0.0)


def _save_root_layer(stage: Any, warnings: list[str], save_backend: str) -> bool:
    root_layer = stage.GetRootLayer()
    if save_backend == "root-layer":
        warnings.append("Used rootLayer.Save() backend for FET001 persistence.")
        return bool(root_layer.Save())
    try:
        import usdex.core
    except Exception as exc:
        warnings.append(f"usdex.core unavailable; used rootLayer.Save() fallback: {exc}")
        return bool(root_layer.Save())
    with redirect_stdout(sys.stderr):
        return bool(usdex.core.saveLayer(root_layer, AUTHORING_METADATA))


def _report(
    *,
    input_usd_path: Path,
    output_usd_path: Path | None,
    profile: str,
    profile_version: str,
    fet001_version: str,
    requirements_repaired: list[str],
    requirements_already_passed: list[str],
    requirements_blocked: list[str],
    checks: list[dict[str, Any]],
    warnings: list[str],
    metadata: dict[str, Any],
) -> dict[str, Any]:
    errors = [check["message"] for check in checks if check["severity"] == "error" and not check["passed"]]
    return {
        "skill": SKILL,
        "tool": TOOL,
        "passed": not errors,
        "status": "PASS" if not errors else "FAIL",
        "input_usd_path": str(input_usd_path),
        "output_usd_path": str(output_usd_path) if output_usd_path is not None else None,
        "profile": profile,
        "profile_version": profile_version,
        "fet001_version": fet001_version,
        "requirements_repaired": requirements_repaired,
        "requirements_already_passed": requirements_already_passed,
        "requirements_blocked": requirements_blocked,
        "unit_repair_invoked": "UN.007" in requirements_repaired,
        "scale_preserved": metadata.get("scale_preserved"),
        "metadata": metadata,
        "checks": checks,
        "warnings": warnings,
        "errors": errors,
        "next_step": "validate-usd-minimum then simready-validate",
    }


def repair_minimal(args: argparse.Namespace) -> dict[str, Any]:
    asset_path = args.asset_path.resolve()
    output_path = resolve_output_path(
        asset_path,
        args.output,
        args.output_dir,
        args.in_place,
        default_stem_suffix="_fet001",
    ).resolve()
    checks: list[dict[str, Any]] = []
    warnings: list[str] = []
    requirements_repaired: list[str] = []
    requirements_already_passed: list[str] = []
    requirements_blocked: list[str] = []
    metadata: dict[str, Any] = {"repair_strategy": args.unit_strategy, "save_backend": args.save_backend}

    exists = asset_path.exists()
    checks.append(_check("asset_exists", exists, "Asset path exists" if exists else "Asset path does not exist"))
    supported_suffix = asset_path.suffix.lower() in SUPPORTED_USD_EXTENSIONS
    checks.append(
        _check(
            "supported_usd_extension",
            supported_suffix,
            "Asset uses a supported editable USD extension" if supported_suffix else "Asset must be .usd, .usda, or .usdc",
        )
    )
    if args.in_place and (args.output is not None or args.output_dir is not None):
        checks.append(_check("output_mode_valid", False, "Use either --in-place or an output path, not both"))
    elif args.output is not None and args.output_dir is not None:
        checks.append(_check("output_mode_valid", False, "Use either --output or --output-dir, not both"))
    elif not args.in_place and output_path == asset_path:
        checks.append(_check("output_mode_valid", False, "Output path matches input path; use --in-place to edit the source asset"))
    else:
        checks.append(_check("output_mode_valid", True, "Output mode is valid"))
    if output_path.exists() and not args.in_place and not args.force:
        checks.append(_check("output_available", False, f"Output path already exists: {output_path}"))
    if any(check["severity"] == "error" and not check["passed"] for check in checks):
        return _report(
            input_usd_path=asset_path,
            output_usd_path=output_path,
            profile=args.profile,
            profile_version=args.profile_version,
            fet001_version=args.fet001_version,
            requirements_repaired=requirements_repaired,
            requirements_already_passed=requirements_already_passed,
            requirements_blocked=requirements_blocked,
            checks=checks,
            warnings=warnings,
            metadata=metadata,
        )

    try:
        from pxr import Gf, Usd, UsdGeom
    except Exception as exc:
        checks.append(_check("openusd_python_available", False, f"OpenUSD Python modules are unavailable: {exc}"))
        return _report(
            input_usd_path=asset_path,
            output_usd_path=output_path,
            profile=args.profile,
            profile_version=args.profile_version,
            fet001_version=args.fet001_version,
            requirements_repaired=requirements_repaired,
            requirements_already_passed=requirements_already_passed,
            requirements_blocked=requirements_blocked,
            checks=checks,
            warnings=warnings,
            metadata=metadata,
        )
    checks.append(_check("openusd_python_available", True, "OpenUSD Python modules are available", "info"))

    if not args.in_place:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(asset_path, output_path)
        sidecar_path = asset_path.with_suffix(".json")
        if sidecar_path.exists():
            shutil.copy2(sidecar_path, output_path.with_suffix(".json"))
            warnings.append(f"Copied sidecar metadata from {sidecar_path}")
        checks.append(_check("output_prepared", True, f"Copied source asset to {output_path}", "info"))
    else:
        checks.append(_check("output_prepared", True, "Editing source asset in place", "info"))

    stage = Usd.Stage.Open(str(output_path))
    checks.append(_check("stage_opens", stage is not None, "Stage opens" if stage is not None else "Stage cannot be opened"))
    if stage is None:
        return _report(
            input_usd_path=asset_path,
            output_usd_path=output_path,
            profile=args.profile,
            profile_version=args.profile_version,
            fet001_version=args.fet001_version,
            requirements_repaired=requirements_repaired,
            requirements_already_passed=requirements_already_passed,
            requirements_blocked=requirements_blocked,
            checks=checks,
            warnings=warnings,
            metadata=metadata,
        )

    root = stage.GetDefaultPrim()
    root_valid = bool(root and root.IsValid())
    checks.append(_check("default_prim_valid", root_valid, f"Default prim is {root.GetPath()}" if root_valid else "Default prim is missing or invalid"))
    old_mpu = float(UsdGeom.GetStageMetersPerUnit(stage))
    old_up_axis = str(UsdGeom.GetStageUpAxis(stage))
    metadata.update({"old_meters_per_unit": old_mpu, "old_up_axis": old_up_axis})
    checks.append(_check("meters_per_unit_declared", old_mpu is not None, f"metersPerUnit is {old_mpu}"))
    checks.append(_check("up_axis_declared", bool(old_up_axis), f"upAxis is {old_up_axis}" if old_up_axis else "upAxis is missing"))

    if not root_valid:
        requirements_blocked.append("UN.007")
        return _report(
            input_usd_path=asset_path,
            output_usd_path=output_path,
            profile=args.profile,
            profile_version=args.profile_version,
            fet001_version=args.fet001_version,
            requirements_repaired=requirements_repaired,
            requirements_already_passed=requirements_already_passed,
            requirements_blocked=requirements_blocked,
            checks=checks,
            warnings=warnings,
            metadata=metadata,
        )

    bounds_before = _bounds_metadata(Usd, UsdGeom, stage, meters_per_unit=old_mpu)
    scale_factor = old_mpu / args.target_meters_per_unit
    metadata.update({"scale_factor": scale_factor, "bounds_before": bounds_before})

    if abs(old_mpu - args.target_meters_per_unit) <= args.unit_tolerance:
        requirements_already_passed.append("UN.007")
        warnings.append("metersPerUnit already satisfies UN.007")
    elif args.unit_strategy == "metadata-only":
        UsdGeom.SetStageMetersPerUnit(stage, args.target_meters_per_unit)
        saved = _save_root_layer(stage, warnings, args.save_backend)
        checks.append(_check("unit_repair_saved", saved, f"Set metersPerUnit={args.target_meters_per_unit} without scale compensation"))
        if saved:
            requirements_repaired.append("UN.007")
            warnings.append("Metadata-only unit repair can change the asset's physical size.")
    else:
        root_xformable = root.IsA(UsdGeom.Xformable)
        checks.append(
            _check(
                "root_xformable_for_unit_repair",
                root_xformable,
                "Default prim is xformable for root-scale normalization" if root_xformable else "Default prim is not xformable",
            )
        )
        if not root_xformable:
            requirements_blocked.append("UN.007")
        else:
            xformable = UsdGeom.Xformable(root)
            op_name = f"xformOp:scale:{METER_NORMALIZATION_OP_SUFFIX}"
            existing_ops = [op for op in xformable.GetOrderedXformOps() if op.GetOpName() == op_name]
            scale_op = existing_ops[0] if existing_ops else xformable.AddScaleOp(UsdGeom.XformOp.PrecisionDouble, METER_NORMALIZATION_OP_SUFFIX)
            scale_op.Set(Gf.Vec3d(scale_factor, scale_factor, scale_factor))
            UsdGeom.SetStageMetersPerUnit(stage, args.target_meters_per_unit)
            saved = _save_root_layer(stage, warnings, args.save_backend)
            checks.append(
                _check(
                    "unit_repair_saved",
                    saved,
                    f"Set metersPerUnit={args.target_meters_per_unit} and authored {op_name}=({scale_factor}, {scale_factor}, {scale_factor})",
                )
            )
            if saved:
                requirements_repaired.append("UN.007")
                metadata["meter_normalization_op"] = op_name

    stage = Usd.Stage.Open(str(output_path))
    if stage is None:
        checks.append(_check("stage_reopens_after_repair", False, "Stage cannot be reopened after repair"))
        return _report(
            input_usd_path=asset_path,
            output_usd_path=output_path,
            profile=args.profile,
            profile_version=args.profile_version,
            fet001_version=args.fet001_version,
            requirements_repaired=requirements_repaired,
            requirements_already_passed=requirements_already_passed,
            requirements_blocked=requirements_blocked,
            checks=checks,
            warnings=warnings,
            metadata=metadata,
        )
    checks.append(_check("stage_reopens_after_repair", True, "Stage reopens after repair", "info"))
    new_mpu = float(UsdGeom.GetStageMetersPerUnit(stage))
    new_up_axis = str(UsdGeom.GetStageUpAxis(stage))
    bounds_after = _bounds_metadata(Usd, UsdGeom, stage, meters_per_unit=new_mpu)
    max_size_delta = _max_delta(bounds_before["meters"]["size"], bounds_after["meters"]["size"])
    max_center_delta = _max_delta(bounds_before["meters"]["center"], bounds_after["meters"]["center"])
    max_ref = max([abs(value) for value in bounds_before["meters"]["size"]] + [1.0])
    scale_preserved = max_size_delta <= max(args.bounds_tolerance, max_ref * args.relative_bounds_tolerance)
    metadata.update(
        {
            "new_meters_per_unit": new_mpu,
            "new_up_axis": new_up_axis,
            "bounds_after": bounds_after,
            "max_meter_size_delta": max_size_delta,
            "max_meter_center_delta": max_center_delta,
            "scale_preserved": scale_preserved,
        }
    )
    checks.append(
        _check(
            "meters_per_unit_normalized",
            abs(new_mpu - args.target_meters_per_unit) <= args.unit_tolerance,
            f"metersPerUnit after repair is {new_mpu}",
        )
    )
    if args.require_scale_preservation and "UN.007" in requirements_repaired:
        checks.append(_check("physical_size_preserved", scale_preserved, f"Max meter-size delta after repair: {max_size_delta}"))

    return _report(
        input_usd_path=asset_path,
        output_usd_path=output_path,
        profile=args.profile,
        profile_version=args.profile_version,
        fet001_version=args.fet001_version,
        requirements_repaired=requirements_repaired,
        requirements_already_passed=requirements_already_passed,
        requirements_blocked=requirements_blocked,
        checks=checks,
        warnings=warnings,
        metadata=metadata,
    )


def emit(payload: dict[str, Any], report_path: Path | None, markdown_report_path: Path | None) -> None:
    markdown = (
        "# FET001 Minimal Repair Report\n\n"
        f"- Passed: `{payload['passed']}`\n"
        f"- Unit repair invoked: `{payload['unit_repair_invoked']}`\n"
        f"- Output USD: `{payload['output_usd_path']}`"
    )
    emit_json_report(payload, report_path, markdown_report_path, markdown)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Repair deterministic FET001 Minimal requirements on a staged USD asset.")
    parser.add_argument("asset_path", type=Path)
    output_group = parser.add_mutually_exclusive_group()
    output_group.add_argument("--output", type=Path)
    output_group.add_argument("--output-dir", type=Path)
    output_group.add_argument("--in-place", action="store_true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--profile", default=DEFAULT_PROFILE)
    parser.add_argument("--profile-version", default=DEFAULT_PROFILE_VERSION)
    parser.add_argument("--fet001-version", default=DEFAULT_FET001_VERSION)
    parser.add_argument("--target-meters-per-unit", type=float, default=TARGET_METERS_PER_UNIT)
    parser.add_argument("--unit-strategy", choices=("root-scale", "metadata-only"), default="root-scale")
    parser.add_argument("--unit-tolerance", type=float, default=1e-12)
    parser.add_argument("--bounds-tolerance", type=float, default=1e-9)
    parser.add_argument("--relative-bounds-tolerance", type=float, default=1e-6)
    parser.add_argument("--require-scale-preservation", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument(
        "--save-backend",
        choices=SAVE_BACKENDS,
        default=DEFAULT_SAVE_BACKEND if DEFAULT_SAVE_BACKEND in SAVE_BACKENDS else "root-layer",
        help="Persistence backend. Defaults to root-layer because usdex.core.saveLayer can abort the Python process in some mixed USD runtimes.",
    )
    parser.add_argument("--report", type=Path)
    parser.add_argument("--markdown-report", type=Path)
    args = parser.parse_args(argv)
    payload = repair_minimal(args)
    emit(payload, args.report, args.markdown_report)
    return 0 if payload["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
