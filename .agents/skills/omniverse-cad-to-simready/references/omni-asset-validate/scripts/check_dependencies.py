#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
import shutil
import sys
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "shared"))

from script_utils import check_result as _check, emit_json_report


SKILL = "omni-asset-validate"
TOOL = "nvidia_usd_validate"
LEGACY_TOOL = "omni_asset_validate"
MODULE_TOOL = "usd_validation_nvidia"
LEGACY_MODULE_TOOL = "omni.asset_validator"


def _write_report(payload: dict[str, Any], report_path: Path | None) -> None:
    emit_json_report(payload, report_path)


def check_dependencies() -> dict[str, Any]:
    executable = shutil.which(TOOL)
    legacy_executable = shutil.which(LEGACY_TOOL)
    module_tool = next((name for name in (MODULE_TOOL, LEGACY_MODULE_TOOL) if importlib.util.find_spec(name) is not None), None)
    runtime = executable or legacy_executable or (f"{sys.executable} -m {module_tool}" if module_tool else "not found")
    checks = [
        _check("python_available", True, f"Python executable: {sys.executable}"),
        _check(f"{TOOL}_available", executable is not None or legacy_executable is not None or module_tool is not None, f"{TOOL} runtime: {runtime}"),
    ]
    errors = [check["message"] for check in checks if not check["passed"]]
    return {
        "skill": SKILL,
        "passed": not errors,
        "checks": checks,
        "errors": errors,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Check portable Asset Validator dependencies.")
    parser.add_argument("--report", type=Path, help="Write dependency check JSON to this path.")
    args = parser.parse_args(argv)

    payload = check_dependencies()
    _write_report(payload, args.report)
    return 0 if payload["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
