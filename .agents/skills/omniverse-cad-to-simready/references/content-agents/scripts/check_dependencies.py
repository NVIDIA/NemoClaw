#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
from pathlib import Path
import sys
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "shared"))

from script_utils import check_result as _check


REFERENCES = ("material-agent-client", "physics-agent-client", "texture-agent-client")


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    checks: list[dict[str, Any]] = []
    for reference in REFERENCES:
        script = root / "references" / reference / "scripts" / "run.py"
        checks.append(_check(f"{reference}.run_py", script.exists(), f"{script} {'exists' if script.exists() else 'is missing'}"))
    payload = {
        "skill": "content-agents",
        "passed": all(check["passed"] for check in checks),
        "status": "PASS" if all(check["passed"] for check in checks) else "BLOCKED",
        "checks": checks,
        "errors": [check["message"] for check in checks if not check["passed"]],
        "next_step": "content-agents/scripts/run.py",
    }
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0 if payload["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
