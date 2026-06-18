#!/usr/bin/env python3
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

from script_utils import check_result as _check, emit_json_report


SKILL = "urdf-usd-converter"
TOOL = "urdf_usd_converter"


def _write_report(payload: dict[str, Any], report_path: Path | None) -> None:
    emit_json_report(payload, report_path)


def check_dependencies() -> dict[str, Any]:
    executable = shutil.which(TOOL)
    checks = [
        _check("python_available", True, f"Python executable: {sys.executable}"),
        _check(f"{TOOL}_available", executable is not None, f"{TOOL} executable: {executable or 'not found'}"),
    ]
    errors = [check["message"] for check in checks if not check["passed"]]
    return {
        "skill": SKILL,
        "passed": not errors,
        "checks": checks,
        "errors": errors,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Check portable URDF converter dependencies.")
    parser.add_argument("--report", type=Path, help="Write dependency check JSON to this path.")
    args = parser.parse_args(argv)

    payload = check_dependencies()
    _write_report(payload, args.report)
    return 0 if payload["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
