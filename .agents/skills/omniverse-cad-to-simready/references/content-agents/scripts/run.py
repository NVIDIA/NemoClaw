#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
import sys
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "shared"))

from script_utils import emit_json_report


CALLS = ("material", "physics", "texture")
REFERENCE_BY_CALL = {
    "material": "material-agent-client",
    "physics": "physics-agent-client",
    "texture": "texture-agent-client",
}
USD_OUTPUT_KEYS = (
    "output_usd_path",
    "materialized_usd_path",
    "physics_usd_path",
    "textured_usdz_path",
    "output_usdz_path",
)


def _skill_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _reference_script(call: str) -> Path:
    return _skill_root() / "references" / REFERENCE_BY_CALL[call] / "scripts" / "run.py"


def _empty_report(asset_path: Path, output_dir: Path, selected_calls: list[str]) -> dict[str, Any]:
    return {
        "skill": "content-agents",
        "input_usd_path": str(asset_path),
        "output_dir": str(output_dir),
        "selected_calls": selected_calls,
        "steps": [],
        "reports": {},
        "output_usd_path": str(asset_path),
        "materialized_usd_path": None,
        "physics_usd_path": None,
        "textured_usdz_path": None,
        "passed": False,
        "status": "FAIL",
        "errors": [],
        "warnings": [],
        "next_step": "simready-conform-profile",
    }


def _load_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return payload


def _selected_calls(args: argparse.Namespace) -> list[str]:
    calls: list[str] = []
    if args.call:
        calls.extend(args.call)
    if args.material:
        calls.append("material")
    if args.physics:
        calls.append("physics")
    if args.texture:
        calls.append("texture")
    if not calls:
        calls = ["material", "physics"]
    seen: set[str] = set()
    ordered = []
    for call in CALLS:
        if call in calls and call not in seen:
            ordered.append(call)
            seen.add(call)
    return ordered


def _child_output_path(call: str, payload: dict[str, Any]) -> str | None:
    preferred = {
        "material": ("materialized_usd_path", "output_usd_path"),
        "physics": ("physics_usd_path", "output_usd_path"),
        "texture": ("textured_usdz_path", "output_usdz_path", "output_usd_path"),
    }[call]
    for key in preferred:
        value = payload.get(key)
        if value:
            return str(value)
    for key in USD_OUTPUT_KEYS:
        value = payload.get(key)
        if value:
            return str(value)
    return None


def _run_child(call: str, input_path: Path, output_dir: Path, args: argparse.Namespace) -> tuple[dict[str, Any], Path]:
    call_dir = output_dir / call
    report_path = call_dir / f"{REFERENCE_BY_CALL[call]}.json"
    markdown_path = report_path.with_suffix(".md")
    command = [
        sys.executable,
        str(_reference_script(call)),
        str(input_path),
        str(call_dir),
        "--report",
        str(report_path),
        "--markdown-report",
        str(markdown_path),
    ]
    if args.timeout is not None:
        command.extend(["--timeout", str(args.timeout)])
    if args.request_timeout is not None:
        command.extend(["--request-timeout", str(args.request_timeout)])
    if args.poll_interval is not None:
        command.extend(["--poll-interval", str(args.poll_interval)])
    if args.prompt:
        command.extend(["--prompt", args.prompt])
    if args.email:
        command.extend(["--email", args.email])
    if call == "physics" and args.convert_physics_output_to_usd:
        command.append("--convert-output-to-usd")
    if call == "texture" and args.material_textures:
        command.extend(["--material-textures", args.material_textures])

    call_dir.mkdir(parents=True, exist_ok=True)
    stdout_path = report_path.with_suffix(".stdout.log")
    stderr_path = report_path.with_suffix(".stderr.log")
    with stdout_path.open("w", encoding="utf-8") as stdout_file, stderr_path.open("w", encoding="utf-8") as stderr_file:
        completed = subprocess.run(command, stdout=stdout_file, stderr=stderr_file, text=True, timeout=args.subprocess_timeout, check=False)

    payload: dict[str, Any]
    if report_path.exists():
        payload = _load_json(report_path)
    else:
        payload = {
            "passed": False,
            "status": "FAIL",
            "errors": [f"{REFERENCE_BY_CALL[call]} did not write a report"],
            "warnings": [],
            "output_usd_path": str(input_path),
        }
    output = _child_output_path(call, payload)
    step = {
        "call": call,
        "reference": REFERENCE_BY_CALL[call],
        "status": str(payload.get("status", "PASS" if completed.returncode == 0 else "FAIL")),
        "passed": completed.returncode == 0 and bool(payload.get("passed")),
        "input_usd_path": str(input_path),
        "output_usd_path": output,
        "report_path": str(report_path),
        "markdown_report_path": str(markdown_path),
        "stdout_path": str(stdout_path),
        "stderr_path": str(stderr_path),
        "errors": list(payload.get("errors", [])),
        "warnings": list(payload.get("warnings", [])),
        "next_step": payload.get("next_step"),
        "command": command,
    }
    return step, Path(output) if output else input_path


def run(args: argparse.Namespace) -> dict[str, Any]:
    asset_path = args.asset_path.resolve()
    output_dir = args.output_dir.resolve()
    selected = _selected_calls(args)
    report = _empty_report(asset_path, output_dir, selected)
    if not asset_path.exists():
        report["errors"].append(f"Asset path does not exist: {asset_path}")
        return _finalize(report)

    current_path = asset_path
    output_dir.mkdir(parents=True, exist_ok=True)
    for call in selected:
        step, child_output = _run_child(call, current_path, output_dir, args)
        report["steps"].append(step)
        report["reports"][call] = step["report_path"]
        report["warnings"].extend(step["warnings"])
        report["errors"].extend(step["errors"])
        if step["passed"]:
            current_path = child_output
            if call == "material":
                report["materialized_usd_path"] = str(child_output)
                report["output_usd_path"] = str(child_output)
            elif call == "physics":
                report["physics_usd_path"] = str(child_output)
                report["output_usd_path"] = str(child_output)
            elif call == "texture":
                report["textured_usdz_path"] = str(child_output)
                # Keep output_usd_path on the latest simulation USD for downstream validation.
                if not report.get("physics_usd_path"):
                    report["output_usd_path"] = str(child_output)
        else:
            return _finalize(report)
    return _finalize(report)


def _finalize(report: dict[str, Any]) -> dict[str, Any]:
    failed = any(not step.get("passed") for step in report["steps"])
    errors = bool(report["errors"])
    report["passed"] = bool(report["steps"]) and not failed and not errors
    report["status"] = "PASS" if report["passed"] else "FAIL"
    report["next_step"] = "simready-conform-profile"
    return report


def emit(payload: dict[str, Any], report_path: Path | None, markdown_report_path: Path | None) -> None:
    lines = [
        "# Content Agents Router Report",
        "",
        f"- Status: `{payload['status']}`",
        f"- Passed: `{payload['passed']}`",
        f"- Output USD: `{payload['output_usd_path']}`",
        f"- Materialized USD: `{payload.get('materialized_usd_path') or 'none'}`",
        f"- Physics USD: `{payload.get('physics_usd_path') or 'none'}`",
        f"- Textured USDZ: `{payload.get('textured_usdz_path') or 'none'}`",
        f"- Next step: `{payload['next_step']}`",
        "",
    ]
    emit_json_report(payload, report_path, markdown_report_path, "\n".join(lines))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Route ordered Content Agents calls and preserve USD handoff paths.")
    parser.add_argument("asset_path", type=Path)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--call", action="append", choices=CALLS, help="Content Agents call to include; repeated values are ordered material, physics, texture.")
    parser.add_argument("--material", action="store_true", help="Include Material Agent call.")
    parser.add_argument("--physics", action="store_true", help="Include Physics Agent call.")
    parser.add_argument("--texture", action="store_true", help="Include Texture Agent call.")
    parser.add_argument("--prompt")
    parser.add_argument("--email")
    parser.add_argument("--timeout", type=int, default=1800)
    parser.add_argument("--request-timeout", type=int, default=120)
    parser.add_argument("--poll-interval", type=float, default=2.0)
    parser.add_argument("--subprocess-timeout", type=int, default=3600)
    parser.add_argument("--convert-physics-output-to-usd", action="store_true")
    parser.add_argument("--material-textures")
    parser.add_argument("--report", type=Path)
    parser.add_argument("--markdown-report", type=Path)
    args = parser.parse_args(argv)
    payload = run(args)
    emit(payload, args.report, args.markdown_report)
    return 0 if payload["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
