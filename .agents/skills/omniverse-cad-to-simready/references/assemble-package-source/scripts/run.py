#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import sys
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "shared"))

from script_utils import check_result_with_code as _check


USD_SUFFIXES = {".usd", ".usda", ".usdc"}
TEXTURE_SUFFIXES = {".png", ".jpg", ".jpeg", ".exr", ".tif", ".tiff", ".bmp", ".tga"}
URI_PREFIXES = ("http://", "https://", "omniverse://", "s3://", "ngc://", "mdl://")


def _normalize_asset_name(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_")
    normalized = re.sub(r"_+", "_", normalized)
    return normalized or "asset"


def _is_uri(value: str) -> bool:
    lower = value.lower()
    return lower.startswith(URI_PREFIXES) or "://" in lower


def _resolve_authored_path(source_layer_path: Path, authored_path: str) -> Path | None:
    if not authored_path or _is_uri(authored_path):
        return None
    if "[" in authored_path and "]" in authored_path:
        return None
    path = Path(authored_path)
    if not path.is_absolute():
        path = source_layer_path.parent / path
    try:
        return path.resolve()
    except OSError:
        return path


def _safe_relative_to(path: Path, base: Path) -> Path | None:
    try:
        rel = path.resolve().relative_to(base.resolve())
    except (OSError, ValueError):
        return None
    if any(part == ".." for part in rel.parts):
        return None
    return rel


def _anchored_relative(from_dir: Path, target: Path) -> str:
    try:
        rel = Path(os.path.relpath(target.resolve(), from_dir.resolve()))
    except OSError:
        rel = Path(os.path.relpath(target, from_dir))
    value = rel.as_posix()
    if not value.startswith((".", "/")):
        value = f"./{value}"
    return value


def _file_same(left: Path, right: Path) -> bool:
    if not left.exists() or not right.exists():
        return False
    return left.stat().st_size == right.stat().st_size and left.read_bytes() == right.read_bytes()


def _copy_with_collision(source: Path, destination: Path) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() and _file_same(source, destination):
        return destination
    target = destination
    counter = 1
    while target.exists() and not _file_same(source, target):
        target = destination.with_name(f"{destination.stem}_{counter}{destination.suffix}")
        counter += 1
    shutil.copy2(source, target)
    return target


def _layer_identifier(layer: Any) -> str:
    return str(getattr(layer, "realPath", None) or getattr(layer, "identifier", "") or "")


def _source_layers(final_usd: Path) -> list[Path]:
    from pxr import UsdUtils

    layers: list[Path] = [final_usd.resolve()]
    try:
        dependency_layers, _, _ = UsdUtils.ComputeAllDependencies(str(final_usd))
    except Exception:
        return layers
    for layer in dependency_layers:
        identifier = _layer_identifier(layer)
        if not identifier:
            continue
        path = Path(identifier)
        if not path.is_file():
            continue
        resolved = path.resolve()
        if resolved not in layers:
            layers.append(resolved)
    return layers


def _target_layer_path(source_layer: Path, final_usd: Path, simready_root: Path, root_usd_name: str) -> Path:
    if source_layer.resolve() == final_usd.resolve():
        return simready_root / root_usd_name
    source_root = final_usd.resolve().parent
    rel = _safe_relative_to(source_layer, source_root)
    if rel is None or rel.name == final_usd.name:
        rel = Path("layers") / source_layer.name
    return simready_root / rel


def _target_asset_path(source_asset: Path, final_usd: Path, simready_root: Path) -> Path:
    suffix = source_asset.suffix.lower()
    source_root = final_usd.resolve().parent
    rel = _safe_relative_to(source_asset, source_root)
    if suffix == ".mdl":
        return simready_root / "materials" / source_asset.parent.name / source_asset.name
    if suffix in TEXTURE_SUFFIXES:
        if rel is not None and "textures" in rel.parts:
            index = rel.parts.index("textures")
            return simready_root.joinpath(*rel.parts[index:])
        return simready_root / "textures" / source_asset.name
    if suffix in USD_SUFFIXES:
        if rel is not None:
            return simready_root / rel
        return simready_root / "layers" / source_asset.name
    if rel is not None:
        return simready_root / rel
    return simready_root / "assets" / source_asset.name


def _iter_prim_specs(prim_spec: Any) -> Any:
    yield prim_spec
    for child in prim_spec.nameChildren:
        yield from _iter_prim_specs(child)


def _rewrite_asset_path_value(
    *,
    value: Any,
    source_layer_path: Path,
    target_layer_path: Path,
    final_usd: Path,
    simready_root: Path,
    copied: dict[Path, Path],
    copied_records: list[dict[str, str]],
    unresolved: list[str],
) -> tuple[Any, dict[str, str] | None]:
    from pxr import Sdf

    if not isinstance(value, Sdf.AssetPath):
        return value, None
    original = str(value.path)
    if not original or _is_uri(original):
        return value, None
    source_asset = _resolve_authored_path(source_layer_path, original)
    if source_asset is None or not source_asset.is_file():
        unresolved.append(f"{source_layer_path}:{original}")
        return value, None
    source_asset = source_asset.resolve()
    target_asset = copied.get(source_asset)
    if target_asset is None:
        target_asset = _copy_with_collision(source_asset, _target_asset_path(source_asset, final_usd, simready_root))
        copied[source_asset] = target_asset
        copied_records.append(
            {
                "source": str(source_asset),
                "destination": str(target_asset),
                "relative_path": target_asset.relative_to(simready_root).as_posix(),
            }
        )
    rewritten = _anchored_relative(target_layer_path.parent, target_asset)
    return Sdf.AssetPath(rewritten), {"layer": str(target_layer_path), "kind": "asset", "original_path": original, "new_path": rewritten}


def _rewrite_layer(
    *,
    source_layer_path: Path,
    target_layer_path: Path,
    final_usd: Path,
    simready_root: Path,
    copied: dict[Path, Path],
    copied_records: list[dict[str, str]],
    unresolved: list[str],
) -> list[dict[str, str]]:
    from pxr import Sdf

    layer = Sdf.Layer.FindOrOpen(str(target_layer_path))
    if layer is None:
        unresolved.append(f"could not open assembled layer: {target_layer_path}")
        return []

    rewritten_paths: list[dict[str, str]] = []

    for original in list(layer.GetCompositionAssetDependencies()):
        if not original or _is_uri(str(original)):
            continue
        source_asset = _resolve_authored_path(source_layer_path, str(original))
        if source_asset is None or not source_asset.is_file():
            unresolved.append(f"{source_layer_path}:{original}")
            continue
        source_asset = source_asset.resolve()
        target_asset = copied.get(source_asset)
        if target_asset is None:
            target_asset = _copy_with_collision(source_asset, _target_asset_path(source_asset, final_usd, simready_root))
            copied[source_asset] = target_asset
            copied_records.append(
                {
                    "source": str(source_asset),
                    "destination": str(target_asset),
                    "relative_path": target_asset.relative_to(simready_root).as_posix(),
                }
            )
        rewritten = _anchored_relative(target_layer_path.parent, target_asset)
        if layer.UpdateCompositionAssetDependency(str(original), rewritten):
            rewritten_paths.append(
                {
                    "layer": str(target_layer_path),
                    "kind": "composition",
                    "original_path": str(original),
                    "new_path": rewritten,
                }
            )

    for root_prim in layer.rootPrims:
        for prim_spec in _iter_prim_specs(root_prim):
            for attr_name in list(prim_spec.attributes.keys()):
                attr_spec = prim_spec.attributes[attr_name]
                value, record = _rewrite_asset_path_value(
                    value=attr_spec.default,
                    source_layer_path=source_layer_path,
                    target_layer_path=target_layer_path,
                    final_usd=final_usd,
                    simready_root=simready_root,
                    copied=copied,
                    copied_records=copied_records,
                    unresolved=unresolved,
                )
                if record is not None:
                    attr_spec.default = value
                    rewritten_paths.append(record)
    if rewritten_paths:
        layer.Save()
    return rewritten_paths


def _authored_asset_paths(layer: Any) -> list[str]:
    from pxr import Sdf

    values: list[str] = []
    for root_prim in layer.rootPrims:
        for prim_spec in _iter_prim_specs(root_prim):
            for attr_name in list(prim_spec.attributes.keys()):
                value = prim_spec.attributes[attr_name].default
                if isinstance(value, Sdf.AssetPath) and value.path:
                    values.append(str(value.path))
    return values


def _self_containment_checks(deliverable_root: Path, simready_root: Path) -> list[dict[str, Any]]:
    from pxr import Sdf, Usd

    checks: list[dict[str, Any]] = []
    root_layers = sorted(path for path in simready_root.rglob("*") if path.is_file() and path.suffix.lower() in USD_SUFFIXES)
    checks.append(
        _check(
            "usd_layers_present",
            bool(root_layers),
            "Assembled USD layers are present" if root_layers else "No assembled USD layers were found",
        )
    )
    for usd_path in root_layers:
        stage_opens = Usd.Stage.Open(str(usd_path)) is not None
        checks.append(
            _check(
                f"usd_opens:{usd_path.relative_to(deliverable_root).as_posix()}",
                stage_opens,
                f"USD opens: {usd_path}" if stage_opens else f"USD cannot be opened: {usd_path}",
            )
        )
        layer = Sdf.Layer.FindOrOpen(str(usd_path))
        if layer is None:
            continue
        for authored in list(layer.GetCompositionAssetDependencies()) + _authored_asset_paths(layer):
            if not authored or _is_uri(str(authored)):
                continue
            resolved = _resolve_authored_path(usd_path, str(authored))
            exists = resolved is not None and resolved.is_file()
            inside = exists and _safe_relative_to(resolved, deliverable_root) is not None
            checks.append(
                _check(
                    f"dependency_self_contained:{usd_path.relative_to(deliverable_root).as_posix()}:{authored}",
                    bool(exists and inside),
                    f"Dependency is self-contained: {authored}" if exists and inside else f"Dependency is missing or outside deliverable: {authored}",
                    code="FET031",
                )
            )
    return checks


def _errors_from_checks(checks: list[dict[str, Any]]) -> list[str]:
    return [check["message"] for check in checks if check["severity"] == "error" and not check["passed"]]


def _warnings_from_checks(checks: list[dict[str, Any]]) -> list[str]:
    return [check["message"] for check in checks if check["severity"] == "warning" and not check["passed"]]


def _write_report(report_path: Path, report: dict[str, Any]) -> None:
    report["assembly_report_path"] = str(report_path)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def assemble(args: argparse.Namespace) -> dict[str, Any]:
    final_usd = args.final_usd.resolve()
    output_root = args.output_root.resolve()
    pipeline_root = output_root / "pipeline"
    deliverable_root = output_root / "deliverable"
    simready_root = deliverable_root / "simready_usd"
    asset_name = _normalize_asset_name(args.asset_name or final_usd.stem)
    root_usd_name = f"sm_{asset_name}_01.usd"
    root_usd_path = simready_root / root_usd_name
    thumbnail_target = simready_root / ".thumbs" / "256x256" / f"{root_usd_name}.png"
    report_path = args.report or pipeline_root / "assembly-report.json"

    report: dict[str, Any] = {
        "skill": "assemble-package-source",
        "operation": "assemble",
        "asset_name": asset_name,
        "output_root": str(output_root),
        "pipeline_root": str(pipeline_root),
        "deliverable_root": str(deliverable_root),
        "root_usd_path": str(root_usd_path),
        "root_usd_relative_path": f"simready_usd/{root_usd_name}",
        "thumbnail_path": str(thumbnail_target),
        "copied_files": [],
        "rewritten_paths": [],
        "checks": [],
        "warnings": [],
        "errors": [],
        "passed": False,
        "status": "FAIL",
        "next_step": "fix-assembly-inputs",
    }
    checks = report["checks"]
    checks.append(_check("final_usd_exists", final_usd.is_file(), f"Final USD exists: {final_usd}" if final_usd.is_file() else f"Final USD does not exist: {final_usd}"))
    checks.append(_check("thumbnail_exists", args.thumbnail.is_file(), f"Thumbnail exists: {args.thumbnail}" if args.thumbnail.is_file() else f"Thumbnail does not exist: {args.thumbnail}", code="SR.002"))
    if _errors_from_checks(checks):
        report["errors"] = _errors_from_checks(checks)
        _write_report(report_path, report)
        return report

    if deliverable_root.exists() and args.overwrite:
        shutil.rmtree(deliverable_root)
        report["warnings"].append(f"Overwrote existing deliverable root: {deliverable_root}")
    elif root_usd_path.exists() and not args.overwrite:
        checks.append(_check("root_usd_not_existing", False, f"Root USD already exists: {root_usd_path}; pass --overwrite to replace it"))
        report["errors"] = _errors_from_checks(checks)
        _write_report(report_path, report)
        return report

    simready_root.mkdir(parents=True, exist_ok=True)
    pipeline_root.mkdir(parents=True, exist_ok=True)
    copied: dict[Path, Path] = {}
    layer_pairs: list[tuple[Path, Path]] = []
    for source_layer in _source_layers(final_usd):
        target_layer = _target_layer_path(source_layer, final_usd, simready_root, root_usd_name)
        copied_target = _copy_with_collision(source_layer, target_layer)
        copied[source_layer.resolve()] = copied_target
        layer_pairs.append((source_layer.resolve(), copied_target))
        report["copied_files"].append(
            {
                "source": str(source_layer.resolve()),
                "destination": str(copied_target),
                "relative_path": copied_target.relative_to(simready_root).as_posix(),
            }
        )

    thumbnail_target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(args.thumbnail, thumbnail_target)
    report["copied_files"].append(
        {
            "source": str(args.thumbnail.resolve()),
            "destination": str(thumbnail_target),
            "relative_path": thumbnail_target.relative_to(simready_root).as_posix(),
        }
    )

    unresolved: list[str] = []
    for source_layer, target_layer in layer_pairs:
        report["rewritten_paths"].extend(
            _rewrite_layer(
                source_layer_path=source_layer,
                target_layer_path=target_layer,
                final_usd=final_usd,
                simready_root=simready_root,
                copied=copied,
                copied_records=report["copied_files"],
                unresolved=unresolved,
            )
        )

    checks.append(_check("root_usd_assembled", root_usd_path.is_file(), f"Assembled root USD: {root_usd_path}" if root_usd_path.is_file() else f"Assembled root USD is missing: {root_usd_path}"))
    checks.append(_check("thumbnail_assembled", thumbnail_target.is_file(), f"Assembled thumbnail: {thumbnail_target}" if thumbnail_target.is_file() else f"Assembled thumbnail is missing: {thumbnail_target}", code="SR.002"))
    checks.append(_check("authored_paths_resolved", not unresolved, "All local authored asset paths resolved" if not unresolved else f"Unresolved local authored asset paths: {unresolved}", code="AA.001"))
    checks.extend(_self_containment_checks(deliverable_root, simready_root))
    report["errors"] = list(dict.fromkeys(_errors_from_checks(checks) + report["errors"]))
    report["warnings"] = list(dict.fromkeys(report["warnings"] + _warnings_from_checks(checks)))
    report["passed"] = not report["errors"]
    report["status"] = "PASS" if report["passed"] else "FAIL"
    report["next_step"] = "nv-core-package-sample" if report["passed"] else "fix-assembly-inputs"
    _write_report(report_path, report)
    return report


def parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Assemble a clean SimReady package source folder.")
    parser.add_argument("final_usd", type=Path)
    parser.add_argument("output_root", type=Path)
    parser.add_argument("--asset-name")
    parser.add_argument("--thumbnail", type=Path, required=True)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--overwrite", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    report = assemble(args)
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
