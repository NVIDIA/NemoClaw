#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import argparse
import base64
import ipaddress
import json
import os
import re
from pathlib import Path
import sys
from typing import Any, Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "shared"))

from script_utils import check_result as _check, emit_json_report

from preflight_manifest import load_preflight_manifest, preflight_required, preflight_status_check, ready_service_url

from stage_prep import can_prepare_with_openusd, inspect_png, prepare_render_stage, raw_asset_data_uri


SKILL = "ovrtx-render-service"
USD_EXTENSIONS = {".usd", ".usda", ".usdc", ".usdz"}
NVCF_INVOCATION_DOMAIN = "invocation.api.nvcf.nvidia.com"
RENDER_TOKEN_ENV_NAMES = (
    "OVRTX_RENDER_TOKEN",
    "RENDER_TOKEN",
    "CONTENT_AGENTS_RENDER_TOKEN",
)
REMOTE_USAGE_TOKEN_ENV_NAMES = (
    "NGC_API_KEY",
    "NVCF_API_KEY",
)
ZERO_COORD = 0.0
ONE_COORD = 1.0
FALLBACK_CAMERA_EYE_X_FACTOR = 0.65
FALLBACK_CAMERA_EYE_Z_FACTOR = 0.55


def _vec3d(Gf: Any, x: float, y: float, z: float) -> Any:
    return Gf.Vec3d(x, y, z)


def _env_first(names: tuple[str, ...]) -> str | None:
    for name in names:
        value = os.getenv(name)
        if value:
            return value
    return None


def _env_first_named(names: tuple[str, ...]) -> tuple[str | None, str | None]:
    for name in names:
        value = os.getenv(name)
        if value:
            return value, name
    return None, None


def _env_or_file_first(names: tuple[str, ...]) -> str | None:
    for name in names:
        value = os.getenv(name)
        if value:
            return value
        file_value = os.getenv(f"{name}_FILE")
        if not file_value:
            continue
        try:
            token = Path(file_value).read_text(encoding="utf-8").strip()
        except OSError:
            continue
        if token:
            return token
    return None


def _nvcf_render_url(function_id: str) -> str:
    clean = function_id.strip().strip("/")
    if clean.startswith(("http://", "https://")):
        return _render_url(clean)
    domain = os.getenv("CONTENT_AGENTS_NVCF_INVOCATION_DOMAIN", NVCF_INVOCATION_DOMAIN).strip().strip("/")
    domain = domain.removeprefix("https://").removeprefix("http://")
    return f"https://{clean}.{domain}/render"


def _render_url(endpoint: str) -> str:
    clean = endpoint.strip().rstrip("/")
    return clean if clean.endswith("/render") else f"{clean}/render"


def _resolve_endpoint(args: argparse.Namespace) -> tuple[str | None, str | None]:
    if args.endpoint:
        return _render_url(args.endpoint), "cli"
    if args.backend == "local":
        endpoint, name = _env_first_named(("OVRTX_RENDER_ENDPOINT", "OVRTX_RENDER_BASE_URL"))
        return (_render_url(endpoint), f"env_{name}") if endpoint and name else (None, None)
    if args.backend == "remote":
        endpoint, name = _env_first_named(("RENDER_ENDPOINT", "CONTENT_AGENTS_RENDER_BASE_URL", "NVCF_RENDER_ENDPOINT"))
        if endpoint and name:
            return _render_url(endpoint), f"env_{name}"
        function_id = _env_first(("NVCF_RENDER_FUNCTION_ID", "RENDER_FUNCTION_ID"))
        if function_id:
            return _nvcf_render_url(function_id), "remote_function_id"
        manifest, _, _ = load_preflight_manifest()
        manifest_endpoint = ready_service_url(manifest, "ovrtx")
        if manifest_endpoint:
            return _render_url(manifest_endpoint), "preflight_manifest"
        return None, None

    endpoint, name = _env_first_named(("OVRTX_RENDER_ENDPOINT", "OVRTX_RENDER_BASE_URL"))
    if endpoint and name:
        return _render_url(endpoint), f"env_{name}"
    manifest, _, _ = load_preflight_manifest()
    manifest_endpoint = ready_service_url(manifest, "ovrtx")
    if manifest_endpoint:
        return _render_url(manifest_endpoint), "preflight_manifest"
    endpoint, name = _env_first_named(("RENDER_ENDPOINT", "CONTENT_AGENTS_RENDER_BASE_URL", "NVCF_RENDER_ENDPOINT"))
    if endpoint and name:
        return _render_url(endpoint), f"env_{name}"
    function_id = _env_first(("NVCF_RENDER_FUNCTION_ID", "RENDER_FUNCTION_ID"))
    if function_id:
        return _nvcf_render_url(function_id), "remote_function_id"
    return None, None


def _endpoint_host(endpoint: str | None) -> str:
    if not endpoint:
        return ""
    return (urlparse(endpoint).hostname or "").strip("[]").lower()


def _is_local_endpoint(endpoint: str | None) -> bool:
    host = _endpoint_host(endpoint)
    if not host:
        return False
    if host in {"localhost", "host.docker.internal"} or host.endswith(".localhost"):
        return True
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    return address.is_loopback


def _is_nvcf_endpoint(endpoint: str | None, endpoint_source: str | None) -> bool:
    host = _endpoint_host(endpoint)
    source = endpoint_source or ""
    return (
        source == "remote_function_id"
        or "NVCF_RENDER_ENDPOINT" in source
        or "nvcf" in host
        or host.endswith(NVCF_INVOCATION_DOMAIN)
    )


def _endpoint_requires_token(args: argparse.Namespace, endpoint: str | None, endpoint_source: str | None) -> bool:
    if args.backend == "local":
        return False
    if args.backend == "remote":
        return True
    return _is_nvcf_endpoint(endpoint, endpoint_source)


def _endpoint_kind(args: argparse.Namespace, endpoint: str | None, endpoint_source: str | None) -> str:
    if args.backend:
        return f"legacy-{args.backend}"
    if _is_nvcf_endpoint(endpoint, endpoint_source):
        return "nvcf"
    if _is_local_endpoint(endpoint):
        return "local-service"
    return "service"


def _token_env_names(endpoint: str | None, token_required: bool) -> tuple[str, ...]:
    names = list(RENDER_TOKEN_ENV_NAMES)
    if token_required or not _is_local_endpoint(endpoint):
        names.extend(REMOTE_USAGE_TOKEN_ENV_NAMES)
    return tuple(names)


def _resolve_token(args: argparse.Namespace, endpoint: str | None = None, token_required: bool = False) -> str | None:
    if args.token:
        return args.token
    return _env_or_file_first(_token_env_names(endpoint, token_required))


def _collect_stage_stats(asset_path: Path) -> tuple[dict[str, Any] | None, str | None]:
    try:
        from pxr import Gf, Usd, UsdGeom
    except Exception as exc:
        return None, f"OpenUSD Python modules are unavailable: {exc}"

    try:
        stage = Usd.Stage.Open(str(asset_path))
    except Exception as exc:
        return None, f"Could not open USD stage: {exc}"
    if stage is None:
        return None, f"Could not open USD stage: {asset_path}"

    default_prim = stage.GetDefaultPrim()
    mesh_count = 0
    point_count = 0
    triangle_count = 0
    for prim in stage.Traverse():
        if not prim.IsA(UsdGeom.Mesh):
            continue
        mesh_count += 1
        mesh = UsdGeom.Mesh(prim)
        points = mesh.GetPointsAttr().Get() or []
        counts = mesh.GetFaceVertexCountsAttr().Get() or []
        point_count += len(points)
        triangle_count += sum(max(int(count) - 2, 0) for count in counts)

    bounds: dict[str, Any] | None = None
    fallback_camera: dict[str, Any] | None = None
    if default_prim:
        try:
            purposes = [UsdGeom.Tokens.default_, UsdGeom.Tokens.render, UsdGeom.Tokens.proxy]
            cache = UsdGeom.BBoxCache(Usd.TimeCode.Default(), purposes, useExtentsHint=False)
            box = cache.ComputeWorldBound(default_prim).ComputeAlignedBox()
            minimum = box.GetMin()
            maximum = box.GetMax()
            size = maximum - minimum
            center = (minimum + maximum) * 0.5
            max_size = max(abs(float(size[0])), abs(float(size[1])), abs(float(size[2])), 1e-6)
            radius = max(float(size.GetLength()) * 0.5, max_size * 0.5, 1e-6)
            distance = max(radius * 4.0, max_size * 3.0, 1e-4)
            eye = center + _vec3d(
                Gf,
                distance * FALLBACK_CAMERA_EYE_X_FACTOR,
                -distance,
                distance * FALLBACK_CAMERA_EYE_Z_FACTOR,
            )
            transform = Gf.Matrix4d().SetLookAt(
                eye,
                center,
                _vec3d(Gf, ZERO_COORD, ZERO_COORD, ONE_COORD),
            ).GetInverse()
            near = max(distance - radius * 3.0, 1e-6)
            far = max(distance + radius * 5.0, near * 10.0)
            bounds = {
                "min": [float(minimum[0]), float(minimum[1]), float(minimum[2])],
                "max": [float(maximum[0]), float(maximum[1]), float(maximum[2])],
                "size": [float(size[0]), float(size[1]), float(size[2])],
                "center": [float(center[0]), float(center[1]), float(center[2])],
            }
            fallback_camera = {
                "eye": [float(eye[0]), float(eye[1]), float(eye[2])],
                "target": [float(center[0]), float(center[1]), float(center[2])],
                "clipping_range": [near, far],
                "transform": [[float(transform[row][col]) for col in range(4)] for row in range(4)],
            }
        except Exception:
            bounds = None
            fallback_camera = None
    return {
        "default_prim": default_prim.GetPath().pathString if default_prim else None,
        "mesh_count": mesh_count,
        "point_count": point_count,
        "triangle_count": triangle_count,
        "bounds": bounds,
        "fallback_camera": fallback_camera,
    }, None


def _headers(token: str | None) -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _post_json(url: str, payload: dict[str, Any], token: str | None, timeout: int) -> tuple[dict[str, str], bytes]:
    request = Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers=_headers(token),
        method="POST",
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            return dict(response.headers.items()), response.read()
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        body = _redact_data_uri(body)
        raise RuntimeError(f"HTTP {exc.code} from {url}: {body[:500]}") from exc
    except URLError as exc:
        raise RuntimeError(f"Could not reach {url}: {exc.reason}") from exc


def _redact_data_uri(text: str) -> str:
    return re.sub(r"data:[^\"\\s,]+;base64,[A-Za-z0-9+/=]+", "data:<redacted>;base64,<redacted>", text)


def _decode_png(headers: dict[str, str], body: bytes) -> bytes:
    content_type = (headers.get("Content-Type") or headers.get("content-type") or "").lower()
    if "image/png" in content_type or body.startswith(b"\x89PNG\r\n\x1a\n"):
        return body
    payload = json.loads(body.decode("utf-8"))
    if payload.get("status") == "exception" and payload.get("error"):
        raise RuntimeError(f"Render service reported exception: {payload['error']}")
    candidate_keys = {"image", "png", "image_data", "output_image", "render", "rendered_image", "images"}

    def iter_candidates(value: Any, parent_key: str | None = None, in_images: bool = False) -> Iterable[str]:
        if isinstance(value, str) and (parent_key in candidate_keys or in_images):
            yield value
        elif isinstance(value, list):
            for item in value:
                yield from iter_candidates(item, parent_key, in_images)
        elif isinstance(value, dict):
            nested_in_images = in_images or parent_key == "images"
            for key, item in value.items():
                yield from iter_candidates(item, key, nested_in_images)

    for value in iter_candidates(payload):
        data = value.split(",", 1)[1] if value.startswith("data:image") and "," in value else value
        try:
            return base64.b64decode(data, validate=True)
        except Exception:
            continue
    raise RuntimeError("Render service did not return PNG bytes or a base64 PNG field")


def _markdown(report: dict[str, Any]) -> str:
    lines = [
        f"# {SKILL} Report",
        "",
        f"- Asset: `{report['asset_path']}`",
        f"- Output image: `{report['output_image_path']}`",
        f"- Renderer endpoint kind: `{report['renderer_endpoint_kind']}`",
        f"- Renderer auth mode: `{report['renderer_auth_mode']}`",
        f"- Passed: `{report['passed']}`",
        f"- Next step: `{report['next_step']}`",
        "",
        "## Checks",
        "",
    ]
    for check in report["checks"]:
        state = "PASS" if check["passed"] else "FAIL"
        lines.append(f"- `{state}` `{check['name']}`: {check['message']}")
    if report["errors"]:
        lines.extend(["", "## Errors", ""])
        lines.extend(f"- {error}" for error in report["errors"])
    if report["warnings"]:
        lines.extend(["", "## Warnings", ""])
        lines.extend(f"- {warning}" for warning in report["warnings"])
    lines.append("")
    return "\n".join(lines)


def _emit(report: dict[str, Any], report_path: Path | None, markdown_report_path: Path | None) -> None:
    emit_json_report(report, report_path, markdown_report_path, _markdown(report))


def render(args: argparse.Namespace) -> dict[str, Any]:
    asset_path = args.asset_path.resolve()
    output_image_path = args.output_image_path.resolve()
    endpoint, endpoint_source = _resolve_endpoint(args)
    token_required = _endpoint_requires_token(args, endpoint, endpoint_source)
    token = _resolve_token(args, endpoint, token_required)
    endpoint_kind = _endpoint_kind(args, endpoint, endpoint_source)
    auth_mode = "bearer-token" if token else ("required-missing" if token_required else "none")
    checks: list[dict[str, Any]] = []
    report: dict[str, Any] = {
        "asset_path": str(asset_path),
        "output_image_path": str(output_image_path),
        "renderer_skill": SKILL,
        "renderer_tool": "OVRTX rendering service",
        "renderer_backend": endpoint_kind,
        "renderer_endpoint_kind": endpoint_kind,
        "renderer_auth_mode": auth_mode,
        "legacy_backend": args.backend or "",
        "renderer_endpoint": endpoint,
        "camera_path": args.camera,
        "width": args.width,
        "height": args.height,
        "fit_margin": args.fit_margin,
        "stage_construction": {},
        "pixel_inspection": {},
        "mesh_count": 0,
        "point_count": 0,
        "triangle_count": 0,
        "generated_files": [],
        "checks": checks,
        "warnings": [],
        "errors": [],
        "passed": False,
        "next_step": "inspect-render-output",
    }

    if preflight_required() and args.endpoint is None:
        preflight_check = preflight_status_check("ovrtx-render-service", "ovrtx")
        checks.append(preflight_check)
        if not preflight_check["passed"]:
            report["errors"] = [preflight_check["message"]]
            return report

    checks.append(_check("asset_exists", asset_path.exists(), "Asset path exists" if asset_path.exists() else "Asset path does not exist"))
    supported = asset_path.suffix.lower() in USD_EXTENSIONS
    checks.append(_check("supported_usd_extension", supported, "Asset uses a supported USD extension" if supported else "Asset must be .usd, .usda, .usdc, or .usdz"))
    checks.append(_check("render_endpoint_available", bool(endpoint), f"Using renderer endpoint {endpoint}" if endpoint else "Set --endpoint or renderer endpoint environment variables"))
    if endpoint_source:
        checks.append(_check(f"render_endpoint_from_{endpoint_source}", True, f"Resolved renderer endpoint from {endpoint_source}", "info"))
    if token:
        checks.append(_check("render_token_available", True, "Renderer bearer token is available", "info"))
    elif token_required:
        checks.append(
            _check(
                "render_token_available",
                False,
                "This renderer endpoint requires a bearer token. Set OVRTX_RENDER_TOKEN, RENDER_TOKEN, CONTENT_AGENTS_RENDER_TOKEN, NGC_API_KEY, NVCF_API_KEY, a matching *_FILE variable, or --token.",
            )
        )
    else:
        checks.append(_check("render_token_not_required", True, "Renderer endpoint does not require a bearer token before request", "info"))

    if asset_path.exists() and supported:
        stats, error = _collect_stage_stats(asset_path)
        if stats is None:
            checks.append(_check("openusd_stage_opened", False, error or "Could not open USD stage", "warning"))
            report["warnings"].append(error or "Could not open USD stage for local stats")
        else:
            checks.append(_check("openusd_stage_opened", True, "USD stage opened", "info"))
            report.update(stats)
            checks.append(_check("renderable_meshes_found", stats["mesh_count"] > 0, "Renderable mesh prims found" if stats["mesh_count"] > 0 else "No renderable mesh prims found"))

    errors = [check["message"] for check in checks if check["severity"] == "error" and not check["passed"]]
    if errors:
        report["errors"] = errors
        return report

    can_prepare, prepare_warning = can_prepare_with_openusd(asset_path)
    if can_prepare:
        prepared = prepare_render_stage(
            asset_path,
            camera_path=args.camera,
            width=args.width,
            height=args.height,
            fit_margin=args.fit_margin,
            focal_length=args.focal_length,
            elevation=args.elevation,
            flatten=args.flatten and not args.no_flatten,
            add_default_lights=args.default_lights and not args.no_default_lights,
            bundle_local_assets=not args.no_bundle_local_assets,
        )
        report["stage_construction"] = prepared.stage_info
        report["warnings"].extend(prepared.warnings)
        if prepared.errors:
            checks.append(_check("render_stage_prepared", False, "; ".join(prepared.errors)))
            report["errors"] = [check["message"] for check in checks if check["severity"] == "error" and not check["passed"]]
            return report
        stage_kind = "flattened" if prepared.stage_info.get("flattened") else "composition-preserving"
        checks.append(_check("render_stage_prepared", True, f"Prepared {stage_kind}, camera-fit render stage", "info"))
        camera_paths = [prepared.camera_path]
        data_uri = prepared.data_uri
    else:
        if prepare_warning:
            report["warnings"].append(prepare_warning)
        camera_paths = [args.camera] if args.camera else ["/Camera"]
        data_uri = raw_asset_data_uri(asset_path)
        report["stage_construction"] = {
            "flattened": False,
            "package_format": "source",
            "camera": {"path": camera_paths[0], "generated": False},
            "fallback_reason": prepare_warning,
        }
        checks.append(_check("render_stage_prepared", False, prepare_warning or "OpenUSD stage preparation unavailable", "warning"))
    report["camera_path"] = camera_paths[0]
    payload = {
        "url": data_uri,
        "force_render": True,
        "render_settings": {
            "camera_paths": camera_paths,
            "frame_range": {"start": 0, "end": 0},
            "camera_parameters": {"width": args.width, "height": args.height},
            "sensors": None,
            "apply_background_mask": False,
        },
    }

    try:
        headers, body = _post_json(endpoint or "", payload, token, args.request_timeout)
        png = _decode_png(headers, body)
        output_image_path.parent.mkdir(parents=True, exist_ok=True)
        output_image_path.write_bytes(png)
    except Exception as exc:
        checks.append(_check("renderer_returned_png", False, str(exc)))
        report["errors"] = [check["message"] for check in checks if check["severity"] == "error" and not check["passed"]]
        return report

    checks.append(_check("renderer_returned_png", True, "Renderer returned PNG data", "info"))
    checks.append(_check("output_png_written", output_image_path.exists() and output_image_path.stat().st_size > 0, f"Wrote {output_image_path}"))
    if output_image_path.exists() and output_image_path.stat().st_size > 0:
        pixel_inspection = inspect_png(output_image_path)
        report["pixel_inspection"] = pixel_inspection
        if pixel_inspection.get("available") is False:
            warning = pixel_inspection.get("warning", "Could not inspect output PNG pixels")
            report["warnings"].append(str(warning))
            checks.append(_check("output_png_pixel_inspected", False, str(warning), "warning"))
        elif pixel_inspection.get("uniform"):
            message = "Output PNG is blank/uniform by pixel inspection"
            severity = "error" if args.fail_on_uniform else "warning"
            checks.append(_check("output_png_non_uniform", False, message, severity))
            if not args.fail_on_uniform:
                report["warnings"].append(message)
        else:
            checks.append(_check("output_png_non_uniform", True, "Output PNG has visible pixel variation", "info"))
    report["generated_files"] = [str(output_image_path)]
    report["errors"] = [check["message"] for check in checks if check["severity"] == "error" and not check["passed"]]
    report["passed"] = not report["errors"]
    return report


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Render a USD asset through an OVRTX render endpoint.")
    parser.add_argument("asset_path", type=Path)
    parser.add_argument("output_image_path", type=Path)
    parser.add_argument("--backend", choices=("remote", "local"), default=None, help=argparse.SUPPRESS)
    parser.add_argument("--endpoint")
    parser.add_argument(
        "--token",
        help="Last-resort bearer token fallback. Prefer renderer token environment variables or *_FILE variables.",
    )
    parser.add_argument("--camera")
    parser.add_argument("--width", type=int, default=1024)
    parser.add_argument("--height", type=int, default=1024)
    parser.add_argument("--fit-margin", type=float, default=1.2)
    parser.add_argument("--focal-length", type=float, default=50.0)
    parser.add_argument("--elevation", type=float, default=0.34)
    parser.add_argument("--flatten", action="store_true", help="Flatten the composed source stage before rendering. Off by default to preserve renderer-visible material graphs.")
    parser.add_argument("--no-flatten", action="store_true", help="Compatibility no-op; composition-preserving stage preparation is the default.")
    parser.add_argument("--default-lights", action="store_true", help="Add default Dome/Sphere lights to lightless prepared stages.")
    parser.add_argument("--no-default-lights", action="store_true", help="Deprecated compatibility flag; default rendering does not author lights.")
    parser.add_argument("--no-bundle-local-assets", action="store_true", help="Do not bundle local MDL/texture assets referenced by the prepared stage.")
    parser.add_argument("--fail-on-uniform", action="store_true", help="Return failure when the rendered PNG is blank or uniform.")
    parser.add_argument("--request-timeout", type=int, default=120)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--markdown-report", type=Path)
    parser.add_argument("--background", help="Accepted for compatibility; OVRTX controls the rendered background.")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    report = render(args)
    _emit(report, args.report, args.markdown_report)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
