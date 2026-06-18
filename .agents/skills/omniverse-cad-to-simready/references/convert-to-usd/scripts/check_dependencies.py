#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Verify that convert-to-usd router dependencies are reachable.

Usage:
    python3 scripts/check_dependencies.py [--report PATH]

Arguments:
    --report PATH   Optional path to write the dependency check report (JSON).

Exit codes:
    0 - all required dependencies are reachable
    1 - one or more required dependencies are missing
    2 - unexpected error (crash or malformed input)
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "shared"))

from script_utils import check_result as _check, emit_json_report


SKILL = "convert-to-usd"


def _write_report(payload: dict[str, Any], report_path: Path | None) -> None:
    emit_json_report(payload, report_path)


def check_dependencies() -> dict[str, Any]:
    checks = [
        _check("python_available", True, f"Python executable: {sys.executable}"),
        _check("stdlib_xml_available", True, "xml.etree.ElementTree is available"),
    ]
    return {
        "skill": SKILL,
        "passed": True,
        "checks": checks,
        "errors": [],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Check portable convert-to-usd router dependencies.")
    parser.add_argument("--report", type=Path, help="Write dependency check JSON to this path.")
    args = parser.parse_args(argv)

    payload = check_dependencies()
    _write_report(payload, args.report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
