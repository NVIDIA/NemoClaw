#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[5] / "shared"))

import kit_app_template_cad
from preflight_manifest import load_preflight_manifest, preflight_required, preflight_status_check, ready_path_from_runtime
from script_utils import check_result as _check, emit_json_report, subprocess_output, tail_text
from usd_convert_cad_diagnostics import summarize_usd_convert_cad_validation_failure


SKILL = "usd-convert-cad"
UPSTREAM_REPO_URL = "https://github.com/NVIDIA-Omniverse/usd-convert-cad"
UPSTREAM_ROOT_ENV = "PHYSICAL_AI_SKILL_HUB_UPSTREAM_ROOT"
INSTALL_HINT = (
    'export PHYSICAL_AI_SKILL_HUB_UPSTREAM_ROOT="${PHYSICAL_AI_SKILL_HUB_UPSTREAM_ROOT:-$HOME/.physical-ai-skill-hub/upstreams}" '
    "&& mkdir -p \"$PHYSICAL_AI_SKILL_HUB_UPSTREAM_ROOT\" "
    f"&& git clone {UPSTREAM_REPO_URL} \"$PHYSICAL_AI_SKILL_HUB_UPSTREAM_ROOT/usd-convert-cad\" "
    "&& cd \"$PHYSICAL_AI_SKILL_HUB_UPSTREAM_ROOT/usd-convert-cad\" "
    "&& OMNI_KIT_ACCEPT_EULA=yes python install.py && python validate.py"
)
UPSTREAM_PREFLIGHT_TIMEOUT_SECONDS = 600


def default_upstream_root() -> Path:
    root = os.environ.get(UPSTREAM_ROOT_ENV)
    if root:
        return Path(root).expanduser() / "usd-convert-cad"
    return Path.home() / ".physical-ai-skill-hub" / "upstreams" / "usd-convert-cad"


def resolve_usd_convert_cad_root(explicit: Path | None) -> Path:
    if explicit is not None:
        return explicit.expanduser().resolve()
    manifest, _, _ = load_preflight_manifest()
    manifest_root = ready_path_from_runtime(manifest, "usd_convert_cad")
    if manifest_root is not None:
        return manifest_root
    env_root = os.environ.get("USD_CONVERT_CAD_ROOT")
    if env_root:
        return Path(env_root).expanduser().resolve()
    default = default_upstream_root().expanduser()
    if default.exists():
        return default.resolve()
    legacy = Path("~/.usd-convert-cad").expanduser()
    if legacy.exists():
        return legacy.resolve()
    return default.resolve()


def _write_report(payload: dict[str, Any], report_path: Path | None) -> None:
    emit_json_report(payload, report_path)


def check_dependencies(
    usd_convert_cad_root: Path | None = None,
    *,
    kit_app_template_root: Path | None = None,
    kit_build_dir: Path | None = None,
    kit_executable: Path | None = None,
    cad_service_extension_dir: Path | None = None,
    execution_mode: str = "core",
) -> dict[str, Any]:
    if kit_app_template_cad.is_arm64_host():
        return kit_app_template_cad.check_dependencies(
            kit_app_template_root=kit_app_template_root,
            kit_build_dir=kit_build_dir,
            kit_executable=kit_executable,
            cad_service_extension_dir=cad_service_extension_dir,
            execution_mode=execution_mode,
        )
    if preflight_required() and usd_convert_cad_root is None:
        preflight_check = preflight_status_check("usd-convert-cad", "usd_convert_cad")
        if not preflight_check["passed"]:
            return {
                "skill": SKILL,
                "passed": False,
                "checks": [preflight_check],
                "errors": [preflight_check["message"]],
                "install_hint": preflight_check["message"],
            }
    upstream_root = resolve_usd_convert_cad_root(usd_convert_cad_root)
    checks = [
        _check("python_available", True, f"Python executable: {sys.executable}"),
        _check("usd_convert_cad_root_exists", upstream_root.exists(), f"usd-convert-cad root: {upstream_root}"),
        _check("usd_convert_cad_convert_py_exists", (upstream_root / "convert.py").exists(), f"convert.py under: {upstream_root}"),
        _check("usd_convert_cad_validate_py_exists", (upstream_root / "validate.py").exists(), f"validate.py under: {upstream_root}"),
    ]
    if all(check["passed"] for check in checks):
        checks.append(check_upstream_validation(upstream_root))
    errors = [check["message"] for check in checks if not check["passed"]]
    diagnostics = [
        diagnostic
        for check in checks
        for diagnostic in check.get("diagnostics", [])
        if isinstance(diagnostic, dict)
    ]
    payload = {
        "skill": SKILL,
        "passed": not errors,
        "upstream_root": str(upstream_root),
        "upstream_repo": UPSTREAM_REPO_URL,
        "checks": checks,
        "errors": errors,
    }
    if diagnostics:
        payload["diagnostics"] = diagnostics
    if errors:
        payload["install_hint"] = INSTALL_HINT
    return payload


def check_upstream_validation(upstream_root: Path) -> dict[str, Any]:
    command = [sys.executable, str(upstream_root / "validate.py")]
    env = os.environ.copy()
    env.setdefault("OMNI_KIT_ACCEPT_EULA", "yes")
    try:
        completed = subprocess.run(
            command,
            cwd=str(upstream_root),
            env=env,
            capture_output=True,
            text=True,
            timeout=UPSTREAM_PREFLIGHT_TIMEOUT_SECONDS,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        output = subprocess_output(getattr(exc, "stdout", ""), getattr(exc, "stderr", ""))
        detail = tail_text(output)
        message = (
            "upstream usd-convert-cad readiness validation timed out after "
            f"{UPSTREAM_PREFLIGHT_TIMEOUT_SECONDS}s. Resolve the upstream usd-convert-cad runtime and rerun validate.py."
        )
        if detail:
            message = f"{message} Output: {detail}"
        return _check("usd_convert_cad_upstream_validate_passes", False, message)

    output = subprocess_output(completed.stdout, completed.stderr)
    if completed.returncode == 0:
        return _check(
            "usd_convert_cad_upstream_validate_passes",
            True,
            f"upstream validate.py passed using command: {' '.join(command)}",
        )

    detail = tail_text(output) or f"validate.py exited with {completed.returncode}"
    message = (
        "upstream usd-convert-cad readiness validation failed "
        f"(exit {completed.returncode}): {detail}. Resolve the upstream usd-convert-cad runtime and rerun validate.py."
    )
    diagnostic = summarize_usd_convert_cad_validation_failure(output, completed.returncode)
    if diagnostic:
        message = (
            "upstream usd-convert-cad readiness validation failed "
            f"(exit {completed.returncode}): {diagnostic['summary']} "
            f"{diagnostic['recovery_hint']} Output: {detail}"
        )
    check = _check(
        "usd_convert_cad_upstream_validate_passes",
        False,
        message,
    )
    if diagnostic:
        check["diagnostics"] = [diagnostic]
    return check


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Check portable usd-convert-cad dependencies.")
    parser.add_argument("--usd-convert-cad-root", type=Path)
    parser.add_argument("--kit-app-template-root", type=Path, help="Linux arm64 fallback: local Kit App Template checkout path.")
    parser.add_argument("--kit-build-dir", type=Path, help="Linux arm64 fallback: built Kit App Template _build/<platform>/release directory.")
    parser.add_argument("--kit-executable", type=Path, help="Linux arm64 fallback: built Kit executable.")
    parser.add_argument("--cad-service-extension-dir", type=Path, help="Linux arm64 fallback service mode: omni.services.convert.cad extension directory.")
    parser.add_argument(
        "--execution-mode",
        default="core",
        choices=["core", "service"],
        help="Linux arm64 fallback: dependency checks for direct CAD core mode or CAD service mode.",
    )
    parser.add_argument("--report", type=Path, help="Write dependency check JSON to this path.")
    args = parser.parse_args(argv)

    payload = check_dependencies(
        args.usd_convert_cad_root,
        kit_app_template_root=args.kit_app_template_root,
        kit_build_dir=args.kit_build_dir,
        kit_executable=args.kit_executable,
        cad_service_extension_dir=args.cad_service_extension_dir,
        execution_mode=args.execution_mode,
    )
    _write_report(payload, args.report)
    return 0 if payload["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
