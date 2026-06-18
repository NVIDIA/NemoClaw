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


SKILL = "FET_004_SIMULATE_MULTI_BODY_PHYSICS"
SUPPORTED_USD_EXTENSIONS = {".usd", ".usda", ".usdc"}
RB_MB_001 = "RB.MB.001"


def _has_schema(prim: Any, schema_name: str) -> bool:
    return schema_name in prim.GetAppliedSchemas()


def _is_rigid_body(prim: Any) -> bool:
    return _has_schema(prim, "PhysicsRigidBodyAPI")


def _is_collider(prim: Any) -> bool:
    return _has_schema(prim, "PhysicsCollisionAPI") or _has_schema(prim, "PhysicsMeshCollisionAPI")


def _is_mass_api(prim: Any) -> bool:
    return _has_schema(prim, "PhysicsMassAPI")


def _paths(prims: list[Any]) -> list[str]:
    return [str(prim.GetPath()) for prim in prims]


def _path_is_descendant(path: str, ancestor: str) -> bool:
    return path.startswith(f"{ancestor}/")


def _find_rigid_bodies(stage: Any) -> list[Any]:
    return [prim for prim in stage.Traverse() if prim.IsActive() and _is_rigid_body(prim)]


def _find_component_body_candidates(stage: Any, aggregate_rigid_body_paths: set[str]) -> list[Any]:
    candidates: list[Any] = []
    seen: set[str] = set()
    for prim in stage.Traverse():
        if not prim.IsActive():
            continue
        prim_path = str(prim.GetPath())
        if prim_path in aggregate_rigid_body_paths:
            continue
        if not _is_collider(prim):
            continue
        if prim_path in seen:
            continue
        candidates.append(prim)
        seen.add(prim_path)
    return candidates


def _aggregate_rigid_bodies_to_remove(rigid_bodies: list[Any], candidates: list[Any]) -> list[Any]:
    candidate_paths = _paths(candidates)
    removable: list[Any] = []
    for prim in rigid_bodies:
        prim_path = str(prim.GetPath())
        descendant_colliders = [path for path in candidate_paths if _path_is_descendant(path, prim_path)]
        if len(descendant_colliders) >= 2 and not _is_collider(prim):
            removable.append(prim)
    return removable


def _report(
    *,
    args: argparse.Namespace,
    output_path: Path | None,
    checks: list[dict[str, Any]],
    warnings: list[str],
    applicability: str,
    requirements_repaired: list[str],
    requirements_blocked: list[str],
    rigid_body_roots_before: list[str],
    rigid_body_roots_after: list[str],
    component_body_candidates: list[str],
    aggregate_rigid_bodies_removed: list[str],
    save_succeeded: bool,
) -> dict[str, Any]:
    errors = [check["message"] for check in checks if check["severity"] == "error" and not check["passed"]]
    passed = not errors and not requirements_blocked and len(rigid_body_roots_after) >= 2
    return {
        "applicability": applicability,
        "aggregate_rigid_bodies_removed": aggregate_rigid_bodies_removed,
        "articulation_roots": [],
        "checks": checks,
        "component_body_candidates": component_body_candidates,
        "errors": errors,
        "fet004_variant": args.fet004_variant,
        "geometry_policy": "No geometry was created, duplicated, split, or imported; only USD physics schemas were edited.",
        "input_usd_path": str(args.asset_path.resolve()),
        "joint_prims": [],
        "output_usd_path": str(output_path) if output_path is not None else None,
        "passed": passed,
        "profile": args.profile,
        "profile_version": args.profile_version,
        "requirements_blocked": requirements_blocked,
        "requirements_repaired": requirements_repaired,
        "rigid_body_roots": rigid_body_roots_after,
        "rigid_body_roots_after": rigid_body_roots_after,
        "rigid_body_roots_before": rigid_body_roots_before,
        "save_succeeded": save_succeeded,
        "skill": SKILL,
        "status": "PASS" if passed else "WARN" if not errors else "FAIL",
        "validation_report": str(args.validation_report.resolve()) if args.validation_report else None,
        "warnings": warnings,
    }


def repair_multibody(args: argparse.Namespace) -> dict[str, Any]:
    asset_path = args.asset_path.resolve()
    output_path = resolve_output_path(
        asset_path,
        args.output,
        args.output_dir,
        args.in_place,
        default_stem_suffix="_fet004",
    ).resolve()
    checks: list[dict[str, Any]] = []
    warnings: list[str] = []
    applicability = "not_evaluated"
    requirements_repaired: list[str] = []
    requirements_blocked: list[str] = []
    rigid_before: list[str] = []
    rigid_after: list[str] = []
    component_candidates: list[str] = []
    removed_aggregates: list[str] = []
    save_succeeded = False

    exists = asset_path.exists()
    checks.append(_check("asset_exists", exists, "Asset path exists" if exists else "Asset path does not exist"))
    supported_suffix = asset_path.suffix.lower() in SUPPORTED_USD_EXTENSIONS
    checks.append(_check("supported_usd_extension", supported_suffix, "Asset uses editable USD extension" if supported_suffix else "Asset must be .usd, .usda, or .usdc"))
    if args.output is not None and args.output_dir is not None:
        checks.append(_check("output_mode_valid", False, "Use either --output or --output-dir, not both"))
    elif args.in_place and (args.output is not None or args.output_dir is not None):
        checks.append(_check("output_mode_valid", False, "Use either --in-place or an output path, not both"))
    elif not args.in_place and output_path == asset_path:
        checks.append(_check("output_mode_valid", False, "Output path matches input path; use --in-place to edit the source asset"))
    else:
        checks.append(_check("output_mode_valid", True, "Output mode is valid"))
    if any(check["severity"] == "error" and not check["passed"] for check in checks):
        return _report(
            args=args,
            output_path=output_path,
            checks=checks,
            warnings=warnings,
            applicability=applicability,
            requirements_repaired=requirements_repaired,
            requirements_blocked=[RB_MB_001],
            rigid_body_roots_before=rigid_before,
            rigid_body_roots_after=rigid_after,
            component_body_candidates=component_candidates,
            aggregate_rigid_bodies_removed=removed_aggregates,
            save_succeeded=save_succeeded,
        )

    if not args.in_place:
        if output_path.exists() and not args.force:
            checks.append(_check("output_available", False, f"Output path already exists: {output_path}"))
            return _report(
                args=args,
                output_path=output_path,
                checks=checks,
                warnings=warnings,
                applicability=applicability,
                requirements_repaired=requirements_repaired,
                requirements_blocked=[RB_MB_001],
                rigid_body_roots_before=rigid_before,
                rigid_body_roots_after=rigid_after,
                component_body_candidates=component_candidates,
                aggregate_rigid_bodies_removed=removed_aggregates,
                save_succeeded=save_succeeded,
            )
        output_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(asset_path, output_path)
        checks.append(_check("output_prepared", True, f"Copied source asset to {output_path}", "info"))
    else:
        checks.append(_check("output_prepared", True, "Editing source asset in place", "info"))

    try:
        from pxr import Usd, UsdPhysics

        stage = Usd.Stage.Open(str(output_path))
    except Exception as exc:
        checks.append(_check("stage_opens", False, f"Stage cannot be opened: {exc}"))
        return _report(
            args=args,
            output_path=output_path,
            checks=checks,
            warnings=warnings,
            applicability="blocked_stage_open_failed",
            requirements_repaired=requirements_repaired,
            requirements_blocked=[RB_MB_001],
            rigid_body_roots_before=rigid_before,
            rigid_body_roots_after=rigid_after,
            component_body_candidates=component_candidates,
            aggregate_rigid_bodies_removed=removed_aggregates,
            save_succeeded=save_succeeded,
        )

    checks.append(_check("stage_opens", stage is not None, "Stage opens"))
    stage.SetEditTarget(stage.GetRootLayer())
    rigid_body_prims = _find_rigid_bodies(stage)
    rigid_before = _paths(rigid_body_prims)
    aggregate_paths = set(rigid_before)
    candidate_prims = _find_component_body_candidates(stage, aggregate_paths)
    component_candidates = _paths(candidate_prims)
    checks.append(_check("rigid_body_inspected", True, f"Found {len(rigid_before)} rigid body prims before repair", "info"))
    checks.append(_check("component_candidates_inspected", True, f"Found {len(component_candidates)} existing component collider candidates", "info"))

    if len(rigid_before) >= 2:
        applicability = "already_satisfied"
        rigid_after = rigid_before
        checks.append(_check("rb_mb_001_satisfied", True, "Asset already has at least two rigid bodies"))
    elif len(component_candidates) < 2:
        applicability = "blocked_no_component_candidates"
        rigid_after = rigid_before
        requirements_blocked.append(RB_MB_001)
        checks.append(_check("component_candidates_sufficient", False, "Need at least two existing component collider candidates to repair RB.MB.001"))
    else:
        removable_aggregates = _aggregate_rigid_bodies_to_remove(rigid_body_prims, candidate_prims)
        for prim in removable_aggregates:
            if _is_mass_api(prim):
                prim.RemoveAPI(UsdPhysics.MassAPI)
            prim.RemoveAPI(UsdPhysics.RigidBodyAPI)
            removed_aggregates.append(str(prim.GetPath()))
        for prim in candidate_prims:
            UsdPhysics.RigidBodyAPI.Apply(prim)
        save_succeeded = bool(stage.GetRootLayer().Save())
        rigid_after = _paths(_find_rigid_bodies(stage))
        if len(rigid_after) >= 2:
            applicability = "applied"
            requirements_repaired.append(RB_MB_001)
            checks.append(_check("rb_mb_001_repaired", True, f"Promoted {len(component_candidates)} existing component colliders to rigid bodies"))
            checks.append(_check("root_layer_saved", save_succeeded, "Saved root layer after FET004 repair" if save_succeeded else "Failed to save root layer after FET004 repair"))
        else:
            applicability = "failed_after_repair"
            requirements_blocked.append(RB_MB_001)
            checks.append(_check("rb_mb_001_repaired", False, f"Rigid body count after repair is {len(rigid_after)}"))
    if not removed_aggregates and len(rigid_before) == 1 and len(component_candidates) >= 2:
        warnings.append("No aggregate rigid body was removed; verify the resulting hierarchy has no unwanted nested rigid bodies.")
    return _report(
        args=args,
        output_path=output_path,
        checks=checks,
        warnings=warnings,
        applicability=applicability,
        requirements_repaired=requirements_repaired,
        requirements_blocked=requirements_blocked,
        rigid_body_roots_before=rigid_before,
        rigid_body_roots_after=rigid_after,
        component_body_candidates=component_candidates,
        aggregate_rigid_bodies_removed=removed_aggregates,
        save_succeeded=save_succeeded,
    )


def emit(payload: dict[str, Any], report_path: Path | None, markdown_report_path: Path | None) -> None:
    lines = [
        "# FET004 Multibody Repair Report",
        "",
        f"- Status: `{payload['status']}`",
        f"- Applicability: `{payload['applicability']}`",
        f"- Rigid bodies before: `{len(payload['rigid_body_roots_before'])}`",
        f"- Rigid bodies after: `{len(payload['rigid_body_roots_after'])}`",
        f"- Requirements repaired: `{', '.join(payload['requirements_repaired']) or 'none'}`",
        f"- Requirements blocked: `{', '.join(payload['requirements_blocked']) or 'none'}`",
        f"- Geometry policy: {payload['geometry_policy']}",
        "",
    ]
    emit_json_report(payload, report_path, markdown_report_path, "\n".join(lines))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Repair FET004 RB.MB.001 by promoting existing component colliders to rigid bodies.")
    parser.add_argument("asset_path", type=Path)
    output_group = parser.add_mutually_exclusive_group()
    output_group.add_argument("--output", type=Path)
    output_group.add_argument("--output-dir", type=Path)
    output_group.add_argument("--in-place", action="store_true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--profile", default="Prop-Robotics-Neutral")
    parser.add_argument("--profile-version", default="1.0.0")
    parser.add_argument("--fet004-variant", default="FET004_BASE_NEUTRAL@0.1.0")
    parser.add_argument("--validation-report", type=Path)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--markdown-report", type=Path)
    args = parser.parse_args(argv)
    payload = repair_multibody(args)
    emit(payload, args.report, args.markdown_report)
    return 0 if payload["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
