#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import argparse
from pathlib import Path
import sys
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "shared"))

from script_utils import emit_json_report, run_asset_validator_category


SKILL = "omni-asset-validate-physics"
TOOL = "omni_asset_validate"
MODULE_TOOL = "omni.asset_validator"
CATEGORY = "Physics"
NEXT_STEP = "simready-validate"
SEVERITIES = ("ERROR", "FAILURE", "WARNING", "INFO")


def validate(asset_path: Path, next_step: str, timeout: int = 120) -> dict[str, Any]:
    return run_asset_validator_category(
        asset_path=asset_path,
        validator_skill=SKILL,
        validator_tool=TOOL,
        module_tool=MODULE_TOOL,
        category=CATEGORY,
        next_step=next_step,
        timeout=timeout,
        severities=SEVERITIES,
    )


def emit(payload: dict[str, Any], report_path: Path | None, markdown_report_path: Path | None) -> None:
    emit_json_report(
        payload,
        report_path,
        markdown_report_path,
        f"# Asset Validator Report\n\n- Passed: `{payload['passed']}`",
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Validate OpenUSD physics with NVIDIA Omniverse Asset Validator.")
    parser.add_argument("asset_path", type=Path)
    parser.add_argument("--next-step", default=NEXT_STEP)
    parser.add_argument("--timeout", type=int, default=120, help="Seconds to wait for Asset Validator before returning a timeout report.")
    parser.add_argument("--report", type=Path)
    parser.add_argument("--markdown-report", type=Path)
    args = parser.parse_args(argv)
    payload = validate(args.asset_path, args.next_step, timeout=args.timeout)
    emit(payload, args.report, args.markdown_report)
    return 0 if payload["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
