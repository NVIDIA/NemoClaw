# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import base64
from dataclasses import dataclass, field
import io
import math
from pathlib import Path
import tempfile
from typing import Any
import zipfile


USD_EXTENSIONS = {".usd", ".usda", ".usdc", ".usdz"}
ZERO_COORD = 0.0
ONE_COORD = 1.0
NEG_ONE_COORD = -1.0


@dataclass
class PreparedStage:
    data_uri: str
    camera_path: str
    stage_info: dict[str, Any]
    warnings: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


def can_prepare_with_openusd(asset_path: Path) -> tuple[bool, str | None]:
    try:
        from pxr import Usd, UsdGeom  # noqa: F401
    except Exception as exc:
        return False, f"OpenUSD Python modules are unavailable: {exc}"
    if asset_path.suffix.lower() not in USD_EXTENSIONS:
        return False, "Asset must be .usd, .usda, .usdc, or .usdz"
    return True, None


def raw_asset_data_uri(asset_path: Path) -> str:
    return "data:application/octet-stream;base64," + base64.b64encode(asset_path.read_bytes()).decode("ascii")


def _vec3d(Gf: Any, x: float, y: float, z: float) -> Any:
    return Gf.Vec3d(x, y, z)


def _zero3() -> list[float]:
    return [ZERO_COORD, ZERO_COORD, ZERO_COORD]


def prepare_render_stage(
    asset_path: Path,
    *,
    camera_path: str | None,
    width: int,
    height: int,
    fit_margin: float,
    focal_length: float = 50.0,
    elevation: float = 0.34,
    turntable_angle: float | None = None,
    flatten: bool = False,
    add_default_lights: bool = False,
    bundle_local_assets: bool = True,
    force_generate_camera: bool = False,
) -> PreparedStage:
    from pxr import Gf, Sdf, Usd, UsdGeom, UsdLux

    asset_path = asset_path.resolve()
    warnings: list[str] = []
    errors: list[str] = []
    stage = Usd.Stage.Open(str(asset_path), Usd.Stage.LoadAll)
    if stage is None:
        return PreparedStage(
            data_uri="",
            camera_path=camera_path or "/Camera",
            stage_info={},
            errors=[f"Could not open USD stage: {asset_path}"],
        )

    source_root_layer = stage.GetRootLayer()
    source_default_prim = stage.GetDefaultPrim()
    source_default_path = str(source_default_prim.GetPath()) if source_default_prim and source_default_prim.IsValid() else ""
    source_up_axis = UsdGeom.GetStageUpAxis(stage)
    source_meters_per_unit = UsdGeom.GetStageMetersPerUnit(stage)

    if flatten:
        layer = stage.Flatten()
        render_stage = Usd.Stage.Open(layer)
        if render_stage is None:
            return PreparedStage(
                data_uri="",
                camera_path=camera_path or "/Camera",
                stage_info={},
                errors=["Failed to reopen flattened USD stage"],
            )
        UsdGeom.SetStageUpAxis(render_stage, source_up_axis)
        if source_meters_per_unit is not None:
            UsdGeom.SetStageMetersPerUnit(render_stage, source_meters_per_unit)
        if source_default_path:
            flat_default = render_stage.GetPrimAtPath(source_default_path)
            if flat_default and flat_default.IsValid():
                render_stage.SetDefaultPrim(flat_default)
    else:
        render_stage = stage

    target_prim = _find_target_prim(render_stage, UsdGeom)
    bounds_info = _compute_bounds_info(render_stage, target_prim, Gf, Usd, UsdGeom)
    if bounds_info["empty"]:
        errors.append("Could not compute non-empty render bounds for the stage")

    if turntable_angle is not None and not errors:
        _apply_centered_rotation(target_prim, bounds_info["center_vec"], source_up_axis, turntable_angle, Gf, UsdGeom)
        bounds_info = _compute_bounds_info(render_stage, target_prim, Gf, Usd, UsdGeom)

    generated_camera = False
    selected_camera_path = camera_path or "/Camera"
    if not camera_path or force_generate_camera:
        selected_camera_path = camera_path or "/Camera"
        _define_fit_camera(
            render_stage,
            selected_camera_path,
            bounds_info,
            source_up_axis,
            width=width,
            height=height,
            fit_margin=fit_margin,
            focal_length=focal_length,
            elevation=elevation,
            Gf=Gf,
            UsdGeom=UsdGeom,
        )
        generated_camera = True
    elif not render_stage.GetPrimAtPath(camera_path):
        errors.append(f"Camera prim does not exist in prepared stage: {camera_path}")

    lights_added = False
    if add_default_lights and not _stage_has_lights(render_stage, UsdLux):
        _add_default_lights(render_stage, bounds_info, source_up_axis, Gf, Sdf, UsdLux)
        lights_added = True

    if errors:
        return PreparedStage(
            data_uri="",
            camera_path=selected_camera_path,
            stage_info={
                "flattened": flatten,
                "target_prim_path": str(target_prim.GetPath()) if target_prim and target_prim.IsValid() else "",
                "bounds": _json_bounds(bounds_info),
            },
            warnings=warnings,
            errors=errors,
        )

    with tempfile.TemporaryDirectory(prefix="ovrtx_stage_") as tmp:
        tmp_dir = Path(tmp)
        main_usda = tmp_dir / "main.usda"
        if not render_stage.GetRootLayer().Export(str(main_usda)):
            return PreparedStage(
                data_uri="",
                camera_path=selected_camera_path,
                stage_info={},
                warnings=warnings,
                errors=["Failed to export prepared render stage"],
            )

        local_asset_count = 0
        copied_files: list[str] = []
        if bundle_local_assets:
            local_asset_count, copied_files = _bundle_local_assets(main_usda, asset_path.parent, Sdf)

        if copied_files:
            archive = io.BytesIO()
            with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
                for file_path in sorted(tmp_dir.rglob("*")):
                    if file_path.is_file():
                        bundle.write(file_path, file_path.relative_to(tmp_dir).as_posix())
            payload = archive.getvalue()
            package_format = "zip"
            root_asset = "main.usda"
        else:
            payload = main_usda.read_bytes()
            package_format = "usda"
            root_asset = "main.usda"

    stage_info = {
        "flattened": flatten,
        "package_format": package_format,
        "root_asset": root_asset,
        "source_root_layer": source_root_layer.identifier,
        "source_default_prim": source_default_path,
        "target_prim_path": str(target_prim.GetPath()),
        "up_axis": str(source_up_axis),
        "meters_per_unit": source_meters_per_unit,
        "bounds": _json_bounds(bounds_info),
        "camera": {
            "path": selected_camera_path,
            "generated": generated_camera,
            **bounds_info.get("camera", {}),
        },
        "default_lights_added": lights_added,
        "local_asset_count": local_asset_count,
        "copied_local_assets": copied_files,
        "turntable_angle": turntable_angle,
    }
    return PreparedStage(
        data_uri="data:application/octet-stream;base64," + base64.b64encode(payload).decode("ascii"),
        camera_path=selected_camera_path,
        stage_info=stage_info,
        warnings=warnings,
    )


def _find_target_prim(stage: Any, UsdGeom: Any) -> Any:
    default_prim = stage.GetDefaultPrim()
    if default_prim and default_prim.IsValid():
        return default_prim
    for prim in stage.GetPseudoRoot().GetChildren():
        if UsdGeom.Xformable(prim):
            return prim
    return stage.GetPseudoRoot()


def _compute_bounds_info(stage: Any, target_prim: Any, Gf: Any, Usd: Any, UsdGeom: Any) -> dict[str, Any]:
    purposes = [UsdGeom.Tokens.default_, UsdGeom.Tokens.render]
    cache = UsdGeom.BBoxCache(Usd.TimeCode.Default(), purposes, useExtentsHint=True)
    bbox = cache.ComputeWorldBound(target_prim)
    bounds = bbox.ComputeAlignedRange()
    empty = bounds.IsEmpty()
    if empty:
        center = _vec3d(Gf, ZERO_COORD, ZERO_COORD, ZERO_COORD)
        size = _vec3d(Gf, ONE_COORD, ONE_COORD, ONE_COORD)
        radius = 1.0
    else:
        center = (bounds.GetMin() + bounds.GetMax()) / 2.0
        size = bounds.GetMax() - bounds.GetMin()
        bbox_min = bounds.GetMin()
        bbox_max = bounds.GetMax()
        corners = [
            Gf.Vec3d(
                bbox_max[0] if i & 1 else bbox_min[0],
                bbox_max[1] if i & 2 else bbox_min[1],
                bbox_max[2] if i & 4 else bbox_min[2],
            )
            for i in range(8)
        ]
        radius = max((corner - Gf.Vec3d(center)).GetLength() for corner in corners)
        radius = max(radius, 1e-6)
    return {
        "empty": empty,
        "min": list(bounds.GetMin()) if not empty else _zero3(),
        "max": list(bounds.GetMax()) if not empty else _zero3(),
        "size": [float(size[0]), float(size[1]), float(size[2])],
        "center": [float(center[0]), float(center[1]), float(center[2])],
        "center_vec": center,
        "radius": float(radius),
    }


def _safe_unit(vec: Any, fallback: Any) -> Any:
    if vec.GetLength() < 1e-12:
        return fallback
    return vec.GetNormalized()


def _camera_matrix(cam_pos: Any, look_at: Any, world_up: Any, fallback_up: Any, Gf: Any) -> Any:
    forward = _safe_unit(look_at - cam_pos, _vec3d(Gf, NEG_ONE_COORD, ZERO_COORD, ZERO_COORD))
    if abs(Gf.Dot(forward, world_up)) > 0.999:
        world_up = fallback_up
    right = _safe_unit(Gf.Cross(forward, world_up), _vec3d(Gf, ZERO_COORD, NEG_ONE_COORD, ZERO_COORD))
    camera_up = _safe_unit(Gf.Cross(right, forward), world_up)

    transform = Gf.Matrix4d(1.0)
    transform.SetRow(0, Gf.Vec4d(right[0], right[1], right[2], 0.0))
    transform.SetRow(1, Gf.Vec4d(camera_up[0], camera_up[1], camera_up[2], 0.0))
    transform.SetRow(2, Gf.Vec4d(-forward[0], -forward[1], -forward[2], 0.0))
    transform.SetRow(3, Gf.Vec4d(cam_pos[0], cam_pos[1], cam_pos[2], 1.0))
    return transform


def _define_fit_camera(
    stage: Any,
    camera_path: str,
    bounds_info: dict[str, Any],
    up_axis: Any,
    *,
    width: int,
    height: int,
    fit_margin: float,
    focal_length: float,
    elevation: float,
    Gf: Any,
    UsdGeom: Any,
) -> None:
    camera = UsdGeom.Camera.Define(stage, camera_path)
    radius = max(float(bounds_info["radius"]), 1e-6)
    aspect = width / max(height, 1)
    aperture = 36.0
    h_aperture = aperture if aspect >= 1.0 else aperture * aspect
    v_aperture = aperture / aspect if aspect >= 1.0 else aperture
    h_fov = 2.0 * math.atan(h_aperture / (2.0 * focal_length))
    v_fov = 2.0 * math.atan(v_aperture / (2.0 * focal_length))
    camera_distance = radius * max(float(fit_margin), 1.01) / math.tan(min(h_fov, v_fov) / 2.0)

    center = _vec3d(Gf, *bounds_info["center"])
    if up_axis == UsdGeom.Tokens.z:
        view_dir = _safe_unit(
            _vec3d(Gf, ONE_COORD, NEG_ONE_COORD, elevation),
            _vec3d(Gf, ONE_COORD, NEG_ONE_COORD, ZERO_COORD),
        )
        world_up = _vec3d(Gf, ZERO_COORD, ZERO_COORD, ONE_COORD)
        fallback_up = _vec3d(Gf, ZERO_COORD, ONE_COORD, ZERO_COORD)
    else:
        view_dir = _safe_unit(
            _vec3d(Gf, ONE_COORD, elevation, NEG_ONE_COORD),
            _vec3d(Gf, ONE_COORD, ZERO_COORD, NEG_ONE_COORD),
        )
        world_up = _vec3d(Gf, ZERO_COORD, ONE_COORD, ZERO_COORD)
        fallback_up = _vec3d(Gf, ZERO_COORD, ZERO_COORD, ONE_COORD)
    cam_pos = center + view_dir * camera_distance
    transform = _camera_matrix(cam_pos, center, world_up, fallback_up, Gf)
    UsdGeom.Xformable(camera).MakeMatrixXform().Set(transform)
    camera.GetFocalLengthAttr().Set(float(focal_length))
    camera.GetHorizontalApertureAttr().Set(float(h_aperture))
    camera.GetVerticalApertureAttr().Set(float(v_aperture))

    near = max(radius * 0.001, 1e-6)
    far = max(camera_distance + radius * 4.0, near + radius * 10.0, near + 1e-3)
    camera.GetClippingRangeAttr().Set(Gf.Vec2f(float(near), float(far)))
    bounds_info["camera"] = {
        "position": [float(cam_pos[0]), float(cam_pos[1]), float(cam_pos[2])],
        "look_at": bounds_info["center"],
        "distance": float(camera_distance),
        "near": float(near),
        "far": float(far),
        "focal_length": float(focal_length),
        "horizontal_aperture": float(h_aperture),
        "vertical_aperture": float(v_aperture),
    }


def _stage_has_lights(stage: Any, UsdLux: Any) -> bool:
    return any(
        prim.IsA(UsdLux.BoundableLightBase) or prim.IsA(UsdLux.NonboundableLightBase)
        for prim in stage.Traverse()
    )


def _add_default_lights(stage: Any, bounds_info: dict[str, Any], up_axis: Any, Gf: Any, Sdf: Any, UsdLux: Any) -> None:
    dome = UsdLux.DomeLight.Define(stage, "/OvRTXDefaultLights/DomeLight")
    dome.CreateIntensityAttr(650.0)
    dome.GetPrim().CreateAttribute("inputs:texture:format", Sdf.ValueTypeNames.Token).Set("latlong")

    key = UsdLux.SphereLight.Define(stage, "/OvRTXDefaultLights/KeyLight")
    key.CreateIntensityAttr(5500.0)
    key.CreateRadiusAttr(max(float(bounds_info["radius"]) * 0.25, 0.01))
    center = _vec3d(Gf, *bounds_info["center"])
    radius = max(float(bounds_info["radius"]), 1e-6)
    if str(up_axis) == "Z":
        position = center + Gf.Vec3d(radius * 2.5, -radius * 3.0, radius * 2.2)
    else:
        position = center + Gf.Vec3d(radius * 2.5, radius * 2.2, -radius * 3.0)
    transform = Gf.Matrix4d(1.0)
    transform.SetTranslate(position)
    from pxr import UsdGeom

    UsdGeom.Xformable(key.GetPrim()).MakeMatrixXform().Set(transform)


def _apply_centered_rotation(target_prim: Any, center: Any, up_axis: Any, angle: float, Gf: Any, UsdGeom: Any) -> None:
    xform = UsdGeom.Xformable(target_prim)
    old_ops = xform.GetOrderedXformOps()
    turntable_op = xform.AddTransformOp(opSuffix="ovrtxTurntable")
    xform.SetXformOpOrder([turntable_op, *old_ops])
    axis = (
        _vec3d(Gf, ZERO_COORD, ZERO_COORD, ONE_COORD)
        if up_axis == UsdGeom.Tokens.z
        else _vec3d(Gf, ZERO_COORD, ONE_COORD, ZERO_COORD)
    )
    to_origin = Gf.Matrix4d(1.0)
    to_origin.SetTranslate(-Gf.Vec3d(center))
    rotation = Gf.Matrix4d(1.0)
    rotation.SetRotate(Gf.Rotation(axis, angle))
    back = Gf.Matrix4d(1.0)
    back.SetTranslate(Gf.Vec3d(center))
    turntable_op.Set(to_origin * rotation * back)


def _bundle_local_assets(main_usda: Path, source_base_dir: Path, Sdf: Any) -> tuple[int, list[str]]:
    layer = Sdf.Layer.FindOrOpen(str(main_usda))
    if layer is None:
        return 0, []

    bundle_root = main_usda.parent
    copied: dict[Path, str] = {}
    copied_files: list[str] = []

    def copy_asset(asset_path: str) -> str | None:
        if not asset_path or asset_path.startswith(("http://", "https://", "omniverse://")):
            return None
        source = Path(asset_path)
        if not source.is_absolute():
            source = source_base_dir / source
        if not source.exists() or not source.is_file():
            return None
        source = source.resolve()
        if source in copied:
            return copied[source]
        if source.suffix.lower() == ".mdl":
            target_dir = bundle_root / "assets" / "mdl" / source.parent.name
            target_dir.mkdir(parents=True, exist_ok=True)
            for mdl_file in sorted(source.parent.glob("*.mdl")):
                target = target_dir / mdl_file.name
                target.write_bytes(mdl_file.read_bytes())
                rel = target.relative_to(bundle_root).as_posix()
                copied_files.append(rel)
                copied[mdl_file.resolve()] = rel
            return copied.get(source)
        target_dir = bundle_root / "assets" / "textures"
        target_dir.mkdir(parents=True, exist_ok=True)
        target = target_dir / source.name
        counter = 1
        while target.exists() and target.read_bytes() != source.read_bytes():
            target = target_dir / f"{source.stem}_{counter}{source.suffix}"
            counter += 1
        target.write_bytes(source.read_bytes())
        rel = target.relative_to(bundle_root).as_posix()
        copied_files.append(rel)
        copied[source] = rel
        return rel

    def process_prim_spec(prim_spec: Any) -> int:
        updated = 0
        for attr_name in list(prim_spec.attributes.keys()):
            attr_spec = prim_spec.attributes[attr_name]
            value = attr_spec.default
            if value is None or not isinstance(value, Sdf.AssetPath):
                continue
            original = value.path if hasattr(value, "path") else str(value)
            relative = copy_asset(original)
            if relative:
                attr_spec.default = Sdf.AssetPath(relative)
                updated += 1
        for child in prim_spec.nameChildren:
            updated += process_prim_spec(child)
        return updated

    updated_count = 0
    for root_prim in layer.rootPrims:
        updated_count += process_prim_spec(root_prim)
    if updated_count:
        layer.Save()
    return len(set(copied_files)), sorted(set(copied_files))


def _json_bounds(bounds_info: dict[str, Any]) -> dict[str, Any]:
    return {
        "empty": bool(bounds_info.get("empty")),
        "min": [float(v) for v in bounds_info.get("min", [])],
        "max": [float(v) for v in bounds_info.get("max", [])],
        "size": [float(v) for v in bounds_info.get("size", [])],
        "center": [float(v) for v in bounds_info.get("center", [])],
        "radius": float(bounds_info.get("radius", 0.0)),
    }


def inspect_png(path: Path) -> dict[str, Any]:
    try:
        from PIL import Image, ImageStat
    except Exception as exc:
        return {"available": False, "warning": f"Pillow is unavailable: {exc}"}

    try:
        image = Image.open(path).convert("RGB")
    except Exception as exc:
        return {"available": False, "warning": f"Could not inspect PNG pixels: {exc}"}
    small = image.resize((min(64, image.width), min(64, image.height)))
    pixels = small.get_flattened_data() if hasattr(small, "get_flattened_data") else small.getdata()
    unique = len(set(pixels))
    extrema = image.getextrema()
    uniform = unique <= 1 or all(low == high for low, high in extrema)
    all_black = all(high == 0 for _, high in extrema)
    return {
        "available": True,
        "size": [image.width, image.height],
        "extrema": [[int(low), int(high)] for low, high in extrema],
        "unique_colors_after_resize": unique,
        "channel_mean": [float(v) for v in ImageStat.Stat(image).mean],
        "uniform": bool(uniform),
        "all_black": bool(all_black),
    }
