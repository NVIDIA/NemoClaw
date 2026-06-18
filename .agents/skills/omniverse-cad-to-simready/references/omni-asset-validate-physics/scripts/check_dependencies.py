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


SKILL = "omni-asset-validate-physics"
TOOL = "omni_asset_validate"
MODULE_TOOL = "omni.asset_validator"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Check portable physics validation dependencies.")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args(argv)
    executable = shutil.which(TOOL)
    module_available = importlib.util.find_spec(MODULE_TOOL) is not None
    runtime = executable if executable is not None else (f"{sys.executable} -m {MODULE_TOOL}" if module_available else "not found")
    checks = [
        _check("python_available", True, f"Python executable: {sys.executable}"),
        _check(f"{TOOL}_available", executable is not None or module_available, f"{TOOL} runtime: {runtime}"),
    ]
    errors = [check["message"] for check in checks if not check["passed"]]
    payload = {"skill": SKILL, "passed": not errors, "checks": checks, "errors": errors}
    emit_json_report(payload, args.report)
    return 0 if payload["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
