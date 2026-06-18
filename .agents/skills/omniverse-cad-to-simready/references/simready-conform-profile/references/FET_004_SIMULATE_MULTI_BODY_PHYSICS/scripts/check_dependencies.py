#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[5] / "shared"))

from script_utils import check_result as _check, emit_json_report


SKILL = "FET_004_SIMULATE_MULTI_BODY_PHYSICS"


def check_dependencies() -> dict[str, Any]:
    checks = [_check("python_available", True, f"Python executable: {sys.executable}", "info")]
    try:
        from pxr import Sdf, Usd, UsdGeom, UsdPhysics  # noqa: F401
    except Exception as exc:
        checks.append(_check("openusd_python_available", False, f"OpenUSD Python modules are unavailable: {exc}"))
    else:
        checks.append(_check("openusd_python_available", True, "OpenUSD Python modules are available"))
    errors = [check["message"] for check in checks if check["severity"] == "error" and not check["passed"]]
    return {"skill": SKILL, "passed": not errors, "checks": checks, "errors": errors}


def emit(payload: dict[str, Any], report_path: Path | None) -> None:
    emit_json_report(payload, report_path)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Check FET004 multibody repair script dependencies.")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args(argv)
    payload = check_dependencies()
    emit(payload, args.report)
    return 0 if payload["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
