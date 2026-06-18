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

from script_utils import emit_json_report

from pxr import Gf, Sdf, Usd, UsdGeom, Vt


GRASP_GUIDE_COLOR_RED = 0.1
GRASP_GUIDE_COLOR_GREEN = 0.85
GRASP_GUIDE_COLOR_BLUE = 0.2


def parse_point(value: str) -> list[float]:
    parts = [part.strip() for part in value.split(",")]
    if len(parts) != 3:
        raise argparse.ArgumentTypeError(f"Point must be formatted as x,y,z: {value}")
    try:
        return [float(part) for part in parts]
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"Point contains a non-numeric value: {value}") from exc


def report_payload(
    *,
    asset_path: Path,
    output_path: Path,
    status: str,
    grasp_vector_path: str | None,
    parent_prim_path: str | None,
    points: list[list[float]],
    source_visual_asset: str | None,
    visual_evidence: list[str],
    rationale: str | None,
    coordinate_note: str | None,
    warnings: list[str],
    errors: list[str],
) -> dict[str, Any]:
    return {
        "asset_path": str(asset_path),
        "output_usd_path": str(output_path),
        "status": status,
        "passed": status == "PASS",
        "grasp_vector_path": grasp_vector_path,
        "parent_prim_path": parent_prim_path,
        "points": points,
        "source_visual_asset": source_visual_asset,
        "visual_evidence": visual_evidence,
        "rationale": rationale,
        "coordinate_note": coordinate_note,
        "warnings": warnings,
        "errors": errors,
        "next_step": "simready-validate",
    }


def write_reports(payload: dict[str, Any], report: Path | None, markdown_report: Path | None) -> None:
    lines = [
        "# Grasp Line Authoring Report",
        "",
        f"- Status: `{payload['status']}`",
        f"- Output USD: `{payload['output_usd_path']}`",
        f"- Grasp vector: `{payload['grasp_vector_path']}`",
        f"- Parent prim: `{payload['parent_prim_path']}`",
        f"- Points: `{payload['points']}`",
        f"- Source visual asset: `{payload['source_visual_asset']}`",
        f"- Rationale: {payload['rationale'] or 'Not provided'}",
        f"- Coordinate note: {payload['coordinate_note'] or 'Not provided'}",
        "",
        "## Visual Evidence",
        "",
    ]
    lines.extend(f"- `{item}`" for item in payload["visual_evidence"])
    if not payload["visual_evidence"]:
        lines.append("- None provided")
    lines.extend(["", "## Warnings", ""])
    lines.extend(f"- {item}" for item in payload["warnings"])
    if not payload["warnings"]:
        lines.append("- None")
    lines.extend(["", "## Errors", ""])
    lines.extend(f"- {item}" for item in payload["errors"])
    if not payload["errors"]:
        lines.append("- None")
    lines.append("")
    emit_json_report(payload, report, markdown_report, "\n".join(lines), print_output=False)


def copy_sidecar(asset_path: Path, output_path: Path, force: bool) -> None:
    source_json = asset_path.with_suffix(".json")
    if not source_json.exists():
        return
    target_json = output_path.with_suffix(".json")
    if target_json.exists() and not force:
        return
    shutil.copy2(source_json, target_json)


def next_grasp_name(parent_prim: Usd.Prim) -> str:
    used_names = {child.GetName() for child in parent_prim.GetChildren()}
    for index in range(1, 1000):
        name = f"grasp_identifier_{index:02d}"
        if name not in used_names:
            return name
    raise RuntimeError("No available grasp_identifier_## name below parent prim")


def make_extent(points: list[list[float]], width: float) -> Vt.Vec3fArray:
    pad = max(float(width), 0.0) * 0.5
    mins = [min(point[index] for point in points) - pad for index in range(3)]
    maxs = [max(point[index] for point in points) + pad for index in range(3)]
    return Vt.Vec3fArray([Gf.Vec3f(*mins), Gf.Vec3f(*maxs)])


def author_curve(
    *,
    stage: Usd.Stage,
    parent_prim: Usd.Prim,
    name: str,
    points: list[list[float]],
    width: float,
    force: bool,
) -> str:
    if not Sdf.Path.IsValidIdentifier(name):
        raise ValueError(f"Invalid USD prim name: {name}")
    path = parent_prim.GetPath().AppendChild(name)
    existing = stage.GetPrimAtPath(path)
    if existing and existing.IsValid() and existing.GetTypeName() != "BasisCurves":
        raise ValueError(f"Existing prim at {path} is not BasisCurves")
    if existing and existing.IsValid() and not force:
        raise ValueError(f"Grasp vector prim already exists: {path}")

    curve = UsdGeom.BasisCurves.Define(stage, path)
    curve.CreateTypeAttr(UsdGeom.Tokens.linear)
    curve.CreateCurveVertexCountsAttr(Vt.IntArray([len(points)]))
    curve.CreatePointsAttr(Vt.Vec3fArray([Gf.Vec3f(*point) for point in points]))
    curve.CreateWidthsAttr(Vt.FloatArray([float(width)]))
    curve.SetWidthsInterpolation(UsdGeom.Tokens.constant)
    computed_extent = UsdGeom.Boundable.ComputeExtentFromPlugins(curve, Usd.TimeCode.Default())
    curve.CreateExtentAttr(computed_extent if computed_extent else make_extent(points, width))
    guide_color = Gf.Vec3f(GRASP_GUIDE_COLOR_RED, GRASP_GUIDE_COLOR_GREEN, GRASP_GUIDE_COLOR_BLUE)
    curve.CreateDisplayColorAttr(Vt.Vec3fArray([guide_color]))
    curve.CreateDisplayOpacityAttr(Vt.FloatArray([1.0]))
    UsdGeom.Imageable(curve.GetPrim()).CreatePurposeAttr(UsdGeom.Tokens.guide)
    return str(path)


def main() -> int:
    parser = argparse.ArgumentParser(description="Author a SimReady FET005 grasp line as BasisCurves.")
    parser.add_argument("asset_path", type=Path)
    output_group = parser.add_mutually_exclusive_group(required=True)
    output_group.add_argument("--output", type=Path)
    output_group.add_argument("--in-place", action="store_true")
    parser.add_argument("--parent-prim", help="Parent prim for the grasp line. Defaults to the stage default prim.")
    parser.add_argument("--name", help="Grasp prim name. Defaults to the next grasp_identifier_##.")
    parser.add_argument("--point", action="append", type=parse_point, required=True, dest="points")
    parser.add_argument("--width", type=float, default=0.01)
    parser.add_argument("--source-visual-asset", help="Source asset used for visual evidence when different from the authored USD.")
    parser.add_argument("--visual-evidence", action="append", default=[], help="Render, screenshot, or evidence file used to choose the grasp line.")
    parser.add_argument("--rationale", help="Short explanation of why the selected region is graspable.")
    parser.add_argument("--coordinate-note", help="Short note describing any source-to-local coordinate conversion.")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--report", type=Path)
    parser.add_argument("--markdown-report", type=Path)
    args = parser.parse_args()

    asset_path = args.asset_path.resolve()
    output_path = asset_path if args.in_place else args.output.resolve()
    warnings: list[str] = []
    errors: list[str] = []
    grasp_path: str | None = None
    parent_path: str | None = args.parent_prim
    points: list[list[float]] = [[float(coord) for coord in point] for point in args.points]

    if len(points) < 2:
        errors.append("At least two --point values are required.")
    elif points[0] == points[-1]:
        errors.append("The first and last grasp line points must not be identical.")
    if not asset_path.exists():
        errors.append(f"Asset path does not exist: {asset_path}")
    if asset_path.suffix.lower() not in {".usd", ".usda", ".usdc"}:
        errors.append("Asset must be a .usd, .usda, or .usdc root layer.")
    if output_path.exists() and output_path != asset_path and not args.force:
        errors.append(f"Output path already exists: {output_path}")
    if args.name and not args.name.startswith("grasp_identifier"):
        warnings.append("GSP.001 validator expects grasp vector names to start with 'grasp_identifier'.")

    if errors:
        payload = report_payload(
            asset_path=asset_path,
            output_path=output_path,
            status="FAIL",
            grasp_vector_path=grasp_path,
            parent_prim_path=parent_path,
            points=points,
            source_visual_asset=args.source_visual_asset,
            visual_evidence=args.visual_evidence,
            rationale=args.rationale,
            coordinate_note=args.coordinate_note,
            warnings=warnings,
            errors=errors,
        )
        write_reports(payload, args.report, args.markdown_report)
        print(json.dumps(payload, indent=2, sort_keys=True))
        return 1

    if output_path != asset_path:
        try:
            output_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(asset_path, output_path)
            copy_sidecar(asset_path, output_path, args.force)
        except OSError as exc:
            errors.append(f"Failed to stage output asset: {exc}")

    if not errors:
        stage = Usd.Stage.Open(str(output_path))
        if stage is None:
            errors.append(f"Failed to open stage: {output_path}")
        else:
            default_prim = stage.GetDefaultPrim()
            if not default_prim or not default_prim.IsValid():
                errors.append("Stage has no valid default prim.")
            else:
                parent_prim = stage.GetPrimAtPath(args.parent_prim) if args.parent_prim else default_prim
                if not parent_prim or not parent_prim.IsValid():
                    errors.append(f"Parent prim is invalid: {args.parent_prim}")
                elif not parent_prim.GetPath().HasPrefix(default_prim.GetPath()):
                    errors.append("Parent prim must be under the default prim.")
                else:
                    parent_path = str(parent_prim.GetPath())
                    name = args.name or next_grasp_name(parent_prim)
                    try:
                        grasp_path = author_curve(
                            stage=stage,
                            parent_prim=parent_prim,
                            name=name,
                            points=points,
                            width=args.width,
                            force=args.force,
                        )
                        if not stage.GetRootLayer().Save():
                            errors.append("Failed to save root layer.")
                    except Exception as exc:
                        errors.append(str(exc))

    payload = report_payload(
        asset_path=asset_path,
        output_path=output_path,
        status="PASS" if not errors else "FAIL",
        grasp_vector_path=grasp_path,
        parent_prim_path=parent_path,
        points=points,
        source_visual_asset=args.source_visual_asset,
        visual_evidence=args.visual_evidence,
        rationale=args.rationale,
        coordinate_note=args.coordinate_note,
        warnings=warnings,
        errors=errors,
    )
    write_reports(payload, args.report, args.markdown_report)
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
