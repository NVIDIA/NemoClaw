#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "shared"))

from script_utils import check_result as _check, emit_json_report


SKILL = "simready-conform-profile"
HELPER_SCRIPTS = [
    Path("references/FET_000_CORE/scripts/run.py"),
    Path("references/FET_001_MINIMAL/scripts/run.py"),
    Path("references/FET_004_SIMULATE_MULTI_BODY_PHYSICS/scripts/run.py"),
    Path("references/FET_005_SIMULATE_GRASP_PHYSICS/scripts/author_grasp_line.py"),
]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Check simready-conform-profile helper dependencies.")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args(argv)

    skill_root = Path(__file__).resolve().parents[1]
    checks = [_check("python_available", True, f"Python executable: {sys.executable}")]
    for relative in HELPER_SCRIPTS:
        path = skill_root / relative
        checks.append(_check(f"helper_{relative.parent.parent.name.lower()}_exists", path.exists(), f"Helper script: {path}"))
    try:
        from pxr import Usd  # noqa: F401
    except Exception as exc:
        checks.append(_check("openusd_python_available", False, f"OpenUSD Python modules are unavailable: {exc}"))
    else:
        checks.append(_check("openusd_python_available", True, "OpenUSD Python modules are available"))

    errors = [check["message"] for check in checks if not check["passed"]]
    payload = {
        "skill": SKILL,
        "passed": not errors,
        "checks": checks,
        "errors": errors,
    }
    emit_json_report(payload, args.report)
    return 0 if payload["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
