#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
from pathlib import Path
import shutil
import subprocess
import sys
from typing import Any


USD_LAYER_EXTENSIONS = {".usd", ".usda", ".usdc"}
DEFAULT_DIFFUSE_GRAY = 0.65


def _base_info(asset_path: Path) -> dict[str, Any]:
    return {
        "attempted": False,
        "path": str(asset_path),
        "skipped_reason": None,
        "warning": None,
        "bound_material_count": 0,
        "inspected_material_count": 0,
        "removed_material_count": 0,
        "removed_materials": [],
        "removed_invalid_shader_count": 0,
        "repaired_bound_shader_count": 0,
        "repaired_bound_shaders": [],
        "invalid_shader_count": 0,
        "invalid_shaders": [],
        "kept_bound_materials_with_invalid_shaders": [],
        "kept_bound_invalid_shader_count": 0,
    }


def _asset_path_record(value: Any, sdf_module: Any) -> dict[str, str]:
    if isinstance(value, sdf_module.AssetPath):
        return {
            "path": str(value.path or ""),
            "resolved_path": str(value.resolvedPath or ""),
        }
    return {"path": str(value or ""), "resolved_path": ""}


def _is_probably_missing_local_mdl(path: str, resolved_path: str, layer_path: Path) -> bool:
    if not path.lower().endswith(".mdl") or resolved_path:
        return False
    lowered = path.lower()
    if "://" in lowered or lowered.startswith("omniverse:"):
        return False
    candidate = Path(path)
    if candidate.is_absolute():
        return not candidate.exists()
    if path.startswith(".") or "/" in path or "\\" in path:
        return not (layer_path.parent / candidate).exists()
    return False


def _shader_source_asset_records(shader_prim: Any, sdf_module: Any) -> list[dict[str, str]]:
    records: list[dict[str, str]] = []
    for attr in shader_prim.GetAttributes():
        name = attr.GetName()
        if name != "info:sourceAsset" and not (name.startswith("info:") and name.endswith(":sourceAsset")):
            continue
        try:
            records.append(_asset_path_record(attr.Get(), sdf_module))
        except Exception:
            continue
    return records


def _invalid_source_asset_reason(shader_prim: Any, usdshade_module: Any, sdf_module: Any, layer_path: Path) -> str | None:
    shader = usdshade_module.Shader(shader_prim)
    try:
        implementation_source = shader.GetImplementationSourceAttr().Get()
    except Exception:
        implementation_source = None
    if str(implementation_source) != "sourceAsset":
        return None

    source_assets = _shader_source_asset_records(shader_prim, sdf_module)
    if not source_assets:
        return "sourceAsset implementation has no authored sourceAsset attribute"
    if not any(record["path"].strip() for record in source_assets):
        return "sourceAsset implementation has only empty sourceAsset values"
    for record in source_assets:
        if _is_probably_missing_local_mdl(record["path"], record["resolved_path"], layer_path):
            return f"sourceAsset MDL file is not packaged or resolvable: {record['path']}"
    return None


def _invalid_shader_records(material_prim: Any, usd_module: Any, usdshade_module: Any, sdf_module: Any, layer_path: Path) -> list[dict[str, str]]:
    invalid: list[dict[str, str]] = []
    for prim in usd_module.PrimRange(material_prim):
        if not prim.IsA(usdshade_module.Shader):
            continue
        reason = _invalid_source_asset_reason(prim, usdshade_module, sdf_module, layer_path)
        if reason:
            invalid.append({"path": str(prim.GetPath()), "reason": reason})
    return invalid


def _repair_bound_source_asset_shader(shader_prim: Any, usdshade_module: Any, sdf_module: Any, gf_module: Any) -> None:
    for prop in list(shader_prim.GetProperties()):
        name = prop.GetName()
        if name == "info:sourceAsset" or name.startswith("info:mdl:"):
            shader_prim.RemoveProperty(name)
    shader = usdshade_module.Shader(shader_prim)
    shader.SetShaderId("UsdPreviewSurface")
    diffuse = gf_module.Vec3f(DEFAULT_DIFFUSE_GRAY, DEFAULT_DIFFUSE_GRAY, DEFAULT_DIFFUSE_GRAY)
    shader.CreateInput("diffuseColor", sdf_module.ValueTypeNames.Color3f).Set(diffuse)
    shader.CreateInput("roughness", sdf_module.ValueTypeNames.Float).Set(0.55)
    shader.CreateInput("metallic", sdf_module.ValueTypeNames.Float).Set(0.0)
    shader.CreateOutput("surface", sdf_module.ValueTypeNames.Token)


def _bound_material_paths(stage: Any, usdshade_module: Any) -> set[str]:
    bound: set[str] = set()
    for prim in stage.Traverse():
        for rel in prim.GetRelationships():
            if not rel.GetName().startswith("material:binding"):
                continue
            for target in rel.GetTargets():
                target_prim = stage.GetPrimAtPath(target)
                if target_prim and target_prim.IsA(usdshade_module.Material):
                    bound.add(str(target_prim.GetPath()))
    return bound


def _cleanup_with_pxr(asset_path: Path, usd_module: Any, usdshade_module: Any, sdf_module: Any, gf_module: Any) -> dict[str, Any]:
    info = _base_info(asset_path)
    if asset_path.suffix.lower() not in USD_LAYER_EXTENSIONS:
        info["skipped_reason"] = "material output cleanup only edits .usd, .usda, or .usdc layers"
        return info

    stage = usd_module.Stage.Open(str(asset_path))
    if stage is None:
        info["warning"] = f"Could not open material output USD for cleanup: {asset_path}"
        return info

    info["attempted"] = True
    bound = _bound_material_paths(stage, usdshade_module)
    info["bound_material_count"] = len(bound)
    materials = [prim for prim in stage.Traverse() if prim.IsA(usdshade_module.Material)]
    info["inspected_material_count"] = len(materials)

    removed_materials: list[str] = []
    removed_invalid_shaders: list[dict[str, str]] = []
    repaired_bound_shaders: list[dict[str, str]] = []
    kept_bound_materials: list[dict[str, Any]] = []
    kept_bound_invalid_shader_count = 0
    for material in materials:
        material_path = str(material.GetPath())
        invalid_shaders = _invalid_shader_records(material, usd_module, usdshade_module, sdf_module, asset_path)
        if not invalid_shaders:
            continue
        if material_path in bound:
            unrepaired: list[dict[str, str]] = []
            for invalid_shader in invalid_shaders:
                shader_prim = stage.GetPrimAtPath(invalid_shader["path"])
                try:
                    _repair_bound_source_asset_shader(shader_prim, usdshade_module, sdf_module, gf_module)
                    repaired_bound_shaders.append(invalid_shader)
                except Exception as exc:
                    failed = dict(invalid_shader)
                    failed["repair_error"] = str(exc)
                    unrepaired.append(failed)
            if unrepaired:
                kept_bound_materials.append({"path": material_path, "invalid_shaders": unrepaired})
                kept_bound_invalid_shader_count += len(unrepaired)
            continue
        if stage.RemovePrim(material.GetPath()):
            removed_materials.append(material_path)
            removed_invalid_shaders.extend(invalid_shaders)

    info["removed_material_count"] = len(removed_materials)
    info["removed_materials"] = removed_materials
    info["removed_invalid_shader_count"] = len(removed_invalid_shaders)
    info["repaired_bound_shader_count"] = len(repaired_bound_shaders)
    info["repaired_bound_shaders"] = repaired_bound_shaders
    info["invalid_shader_count"] = len(removed_invalid_shaders) + len(repaired_bound_shaders)
    info["invalid_shaders"] = removed_invalid_shaders
    info["kept_bound_materials_with_invalid_shaders"] = kept_bound_materials
    info["kept_bound_invalid_shader_count"] = kept_bound_invalid_shader_count

    if (removed_materials or repaired_bound_shaders) and not stage.GetRootLayer().Save():
        info["warning"] = f"Could not save material output cleanup edits: {asset_path}"
    return info


def _cleanup_external(asset_path: Path) -> dict[str, Any]:
    info = _base_info(asset_path)
    uv = shutil.which("uv")
    if not uv:
        info["warning"] = "uv was not found on PATH for alternate OpenUSD Python material output cleanup"
        return info
    command = [uv, "run", "--python", "3.12", "python", str(Path(__file__).resolve()), str(asset_path)]
    try:
        completed = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120, check=False)
    except Exception as exc:
        info["warning"] = f"Alternate OpenUSD Python material output cleanup failed to launch: {exc}"
        return info
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "").strip()
        info["warning"] = f"Alternate OpenUSD Python material output cleanup failed: {detail[:500]}"
        return info
    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        info["warning"] = f"Alternate OpenUSD Python material output cleanup returned invalid JSON: {exc}"
        return info
    if isinstance(payload, dict):
        return payload
    info["warning"] = "Alternate OpenUSD Python material output cleanup returned a non-object payload"
    return info


def cleanup_material_output(asset_path: Path, *, allow_external: bool = True) -> dict[str, Any]:
    info = _base_info(asset_path)
    try:
        from pxr import Gf, Sdf, Usd, UsdShade
    except Exception as exc:
        if allow_external:
            external = _cleanup_external(asset_path)
            if external.get("attempted") or not external.get("warning"):
                return external
            info["warning"] = (
                f"OpenUSD Python APIs are unavailable for material output cleanup: {exc}. "
                + str(external.get("warning") or "No alternate OpenUSD Python runtime cleaned the material output.")
            )
            return info
        info["warning"] = f"OpenUSD Python APIs are unavailable for material output cleanup: {exc}"
        return info

    try:
        return _cleanup_with_pxr(asset_path, Usd, UsdShade, Sdf, Gf)
    except Exception as exc:
        info["warning"] = f"Could not clean material output USD: {exc}"
        return info


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) != 1:
        print("usage: content_agent_material_cleanup.py MATERIAL_OUTPUT.usd", file=sys.stderr)
        return 2
    print(json.dumps(cleanup_material_output(Path(args[0]).resolve(), allow_external=False), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
