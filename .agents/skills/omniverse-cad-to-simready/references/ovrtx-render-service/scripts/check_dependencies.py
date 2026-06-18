#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "shared"))

from script_utils import check_result as _check, emit_json_report

from preflight_manifest import load_preflight_manifest, preflight_required, preflight_status_check, ready_service_url


SKILL = "ovrtx-render-service"


def _env_first(names: tuple[str, ...]) -> str | None:
    for name in names:
        value = os.getenv(name)
        if value:
            return value
    return None


def _write_report(payload: dict[str, Any], report_path: Path | None) -> None:
    emit_json_report(payload, report_path)


def check_dependencies() -> dict[str, Any]:
    if preflight_required():
        preflight_check = preflight_status_check("ovrtx-render-service", "ovrtx")
        if not preflight_check["passed"]:
            return {
                "skill": SKILL,
                "passed": False,
                "checks": [preflight_check],
                "errors": [preflight_check["message"]],
            }
    checks = [
        _check("python_available", True, f"Python executable: {sys.executable}", "info"),
    ]
    try:
        from pxr import Usd, UsdGeom  # noqa: F401
    except Exception as exc:
        checks.append(_check("openusd_python_available", False, f"OpenUSD Python modules are unavailable: {exc}"))
    else:
        checks.append(_check("openusd_python_available", True, "OpenUSD Python modules are available", "info"))

    manifest, _, _ = load_preflight_manifest()
    endpoint = _env_first(
        (
            "RENDER_ENDPOINT",
            "CONTENT_AGENTS_RENDER_BASE_URL",
            "NVCF_RENDER_ENDPOINT",
            "OVRTX_RENDER_ENDPOINT",
            "OVRTX_RENDER_BASE_URL",
            "NVCF_RENDER_FUNCTION_ID",
            "RENDER_FUNCTION_ID",
        )
    ) or ready_service_url(manifest, "ovrtx")
    checks.append(
        _check(
            "render_endpoint_configured",
            bool(endpoint),
            f"Renderer endpoint configured: {endpoint}" if endpoint else "Set a render endpoint or render function ID",
        )
    )
    errors = [check["message"] for check in checks if check["severity"] == "error" and not check["passed"]]
    return {
        "skill": SKILL,
        "passed": not errors,
        "checks": checks,
        "errors": errors,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Check portable render-usd dependencies.")
    parser.add_argument("--report", type=Path, help="Write dependency check JSON to this path.")
    args = parser.parse_args(argv)

    payload = check_dependencies()
    _write_report(payload, args.report)
    return 0 if payload["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
