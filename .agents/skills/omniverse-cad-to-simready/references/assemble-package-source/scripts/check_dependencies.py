#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
import sys


def main() -> int:
    checks: list[dict[str, object]] = []
    try:
        from pxr import Sdf, Usd, UsdUtils  # noqa: F401
    except Exception as exc:
        checks.append(
            {
                "name": "openusd_python",
                "passed": False,
                "message": f"OpenUSD Python APIs are unavailable: {exc}",
            }
        )
    else:
        checks.append(
            {
                "name": "openusd_python",
                "passed": True,
                "message": "OpenUSD Python APIs are available",
            }
        )

    payload = {
        "skill": "assemble-package-source",
        "passed": all(bool(check["passed"]) for check in checks),
        "checks": checks,
    }
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0 if payload["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
