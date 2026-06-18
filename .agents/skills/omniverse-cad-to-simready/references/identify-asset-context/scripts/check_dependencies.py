#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from typing import Any


SKILL = "identify-asset-context"


def _write_report(payload: dict[str, Any], report_path: Path | None) -> None:
    text = json.dumps(payload, indent=2, sort_keys=True) + "\n"
    if report_path is not None:
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(text, encoding="utf-8")
    print(text, end="")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Check portable source asset inspection dependencies.")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args(argv)
    payload = {
        "skill": SKILL,
        "passed": True,
        "checks": [
            {
                "name": "python_available",
                "passed": True,
                "severity": "info",
                "message": f"Python executable: {sys.executable}",
            },
            {
                "name": "stdlib_available",
                "passed": True,
                "severity": "info",
                "message": "json, pathlib, and re are available",
            },
        ],
        "errors": [],
    }
    _write_report(payload, args.report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
