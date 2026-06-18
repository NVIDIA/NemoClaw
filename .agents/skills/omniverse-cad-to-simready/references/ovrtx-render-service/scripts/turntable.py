#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from run import _check, _decode_png, _endpoint_kind, _endpoint_requires_token, _post_json, _resolve_endpoint, _resolve_token
from script_utils import emit_json_report
from stage_prep import inspect_png, prepare_render_stage


SKILL = "ovrtx-render-service"
CAMERA_PATH = "/TurntableCamera"


def _stitch_gif(frame_paths: list[Path], output_gif: Path, fps: int) -> str | None:
    try:
        from PIL import Image
    except Exception as exc:
        return f"Pillow is unavailable; skipped GIF stitching: {exc}"
    if not frame_paths:
        return "No frame paths were available for GIF stitching"
    output_gif.parent.mkdir(parents=True, exist_ok=True)
    images = [Image.open(path).convert("RGB") for path in frame_paths]
    duration_ms = max(1, int(1000 / max(fps, 1)))
    images[0].save(
        output_gif,
        save_all=True,
        append_images=images[1:],
        duration=duration_ms,
        loop=0,
        optimize=False,
        disposal=2,
    )
    return None


def _render_one_frame(
    *,
    endpoint: str,
    token: str | None,
    data_uri: str,
    camera_path: str,
    width: int,
    height: int,
    timeout: int,
) -> bytes:
    payload = {
        "url": data_uri,
        "force_render": True,
        "render_settings": {
            "camera_paths": [camera_path],
            "frame_range": {"start": 0, "end": 0},
            "camera_parameters": {"width": width, "height": height},
            "sensors": None,
            "apply_background_mask": False,
        },
    }
    headers, body = _post_json(endpoint, payload, token, timeout)
    return _decode_png(headers, body)


def render_turntable(args: argparse.Namespace) -> dict[str, Any]:
    asset_path = args.asset_path.resolve()
    output_dir = args.output_dir.resolve()
    endpoint, endpoint_source = _resolve_endpoint(args)
    token_required = _endpoint_requires_token(args, endpoint, endpoint_source)
    token = _resolve_token(args, endpoint, token_required)
    endpoint_kind = _endpoint_kind(args, endpoint, endpoint_source)
    auth_mode = "bearer-token" if token else ("required-missing" if token_required else "none")
    checks: list[dict[str, Any]] = []
    report: dict[str, Any] = {
        "asset_path": str(asset_path),
        "output_dir": str(output_dir),
        "output_gif_path": str(args.gif.resolve()) if args.gif else "",
        "renderer_skill": SKILL,
        "renderer_tool": "OVRTX rendering service",
        "renderer_backend": endpoint_kind,
        "renderer_endpoint_kind": endpoint_kind,
        "renderer_auth_mode": auth_mode,
        "legacy_backend": args.backend or "",
        "renderer_endpoint": endpoint,
        "camera_path": CAMERA_PATH,
        "width": args.width,
        "height": args.height,
        "frames_requested": args.frames,
        "frames_rendered": 0,
        "checks": checks,
        "frame_reports": [],
        "generated_files": [],
        "warnings": [],
        "errors": [],
        "passed": False,
        "next_step": "inspect-turntable-output",
    }
    checks.append(_check("asset_exists", asset_path.exists(), "Asset path exists" if asset_path.exists() else "Asset path does not exist"))
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

    initial_errors = [check["message"] for check in checks if check["severity"] == "error" and not check["passed"]]
    if initial_errors:
        report["errors"] = initial_errors
        return report

    output_dir.mkdir(parents=True, exist_ok=True)
    frame_paths: list[Path] = []
    for frame in range(args.frames):
        angle = 360.0 * frame / max(args.frames, 1)
        prepared = prepare_render_stage(
            asset_path,
            camera_path=CAMERA_PATH,
            width=args.width,
            height=args.height,
            fit_margin=args.fit_margin,
            focal_length=args.focal_length,
            elevation=args.elevation,
            turntable_angle=angle,
            flatten=args.flatten and not args.no_flatten,
            add_default_lights=args.default_lights and not args.no_default_lights,
            bundle_local_assets=not args.no_bundle_local_assets,
            force_generate_camera=True,
        )
        frame_report: dict[str, Any] = {
            "frame": frame,
            "angle_degrees": angle,
            "camera_path": prepared.camera_path,
            "stage_construction": prepared.stage_info,
            "warnings": list(prepared.warnings),
            "errors": list(prepared.errors),
            "output_image_path": "",
            "pixel_inspection": {},
            "passed": False,
        }
        if prepared.errors:
            report["frame_reports"].append(frame_report)
            continue
        try:
            png = _render_one_frame(
                endpoint=endpoint or "",
                token=token,
                data_uri=prepared.data_uri,
                camera_path=prepared.camera_path,
                width=args.width,
                height=args.height,
                timeout=args.request_timeout,
            )
        except Exception as exc:
            frame_report["errors"].append(str(exc))
            report["frame_reports"].append(frame_report)
            continue
        frame_path = output_dir / f"frame_{frame:03d}.png"
        frame_path.write_bytes(png)
        frame_report["output_image_path"] = str(frame_path)
        frame_report["pixel_inspection"] = inspect_png(frame_path)
        if frame_report["pixel_inspection"].get("uniform"):
            frame_report["errors"].append("Output PNG is blank/uniform by pixel inspection")
        frame_report["passed"] = not frame_report["errors"]
        frame_paths.append(frame_path)
        report["frame_reports"].append(frame_report)

    report["frames_rendered"] = len(frame_paths)
    report["generated_files"] = [str(path) for path in frame_paths]
    if args.gif and frame_paths:
        warning = _stitch_gif(frame_paths, args.gif.resolve(), args.fps)
        if warning:
            report["warnings"].append(warning)
        else:
            report["generated_files"].append(str(args.gif.resolve()))
    report["errors"] = [
        f"frame {frame['frame']}: {'; '.join(frame['errors'])}"
        for frame in report["frame_reports"]
        if frame["errors"]
    ]
    if len(frame_paths) != args.frames:
        report["errors"].append(f"Rendered {len(frame_paths)} frame(s), expected {args.frames}")
    report["passed"] = not report["errors"]
    return report


def _markdown(report: dict[str, Any]) -> str:
    lines = [
        "# OVRTX Turntable Render Report",
        "",
        f"- Asset: `{report['asset_path']}`",
        f"- Output directory: `{report['output_dir']}`",
        f"- Output GIF: `{report['output_gif_path'] or 'not requested'}`",
        f"- Frames rendered: `{report['frames_rendered']}/{report['frames_requested']}`",
        f"- Passed: `{report['passed']}`",
        "",
        "## Frames",
        "",
    ]
    for frame in report["frame_reports"]:
        state = "PASS" if frame["passed"] else "FAIL"
        lines.append(
            f"- `{state}` frame `{frame['frame']}` angle `{frame['angle_degrees']:.1f}`: "
            f"`{frame['output_image_path'] or 'no image'}`"
        )
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


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Render OVRTX turntable frames for a USD asset.")
    parser.add_argument("asset_path", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--backend", choices=("remote", "local"), default=None, help=argparse.SUPPRESS)
    parser.add_argument("--endpoint")
    parser.add_argument(
        "--token",
        help="Last-resort bearer token fallback. Prefer renderer token environment variables or *_FILE variables.",
    )
    parser.add_argument("--frames", type=int, default=8)
    parser.add_argument("--width", type=int, default=720)
    parser.add_argument("--height", type=int, default=720)
    parser.add_argument("--fps", type=int, default=8)
    parser.add_argument("--gif", type=Path)
    parser.add_argument("--fit-margin", type=float, default=1.12)
    parser.add_argument("--focal-length", type=float, default=50.0)
    parser.add_argument("--elevation", type=float, default=0.34)
    parser.add_argument("--flatten", action="store_true", help="Flatten the composed source stage before rendering. Off by default to preserve renderer-visible material graphs.")
    parser.add_argument("--no-flatten", action="store_true", help="Compatibility no-op; composition-preserving stage preparation is the default.")
    parser.add_argument("--default-lights", action="store_true")
    parser.add_argument("--no-default-lights", action="store_true")
    parser.add_argument("--no-bundle-local-assets", action="store_true")
    parser.add_argument("--request-timeout", type=int, default=120)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--markdown-report", type=Path)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.frames < 1:
        raise SystemExit("--frames must be >= 1")
    report = render_turntable(args)
    _emit(report, args.report, args.markdown_report)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
