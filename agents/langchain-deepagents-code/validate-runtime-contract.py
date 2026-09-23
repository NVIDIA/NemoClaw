#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

import importlib
import re
import sys
from importlib.metadata import version
from pathlib import Path

EXPECTED_VERSIONS = {
    "deepagents": "0.7.5",
    "deepagents-code": "0.1.55",
}
REQUIRED_MODULES = ("deepagents", "deepagents_code")
SUCCESS_MARKER = "nemoclaw-dcode-runtime-contract-ok"


def validate_lock(path: Path) -> None:
    source = path.read_text(encoding="utf-8")
    for package, expected in EXPECTED_VERSIONS.items():
        match = re.search(rf"^{re.escape(package)}==([^\s\\]+)\s*\\$", source, re.MULTILINE)
        if match is None or match.group(1) != expected:
            raise SystemExit(f"Deep Agents Code runtime contract does not match {package} lock")


def main() -> None:
    if len(sys.argv) == 3 and sys.argv[1] == "--requirements-lock":
        validate_lock(Path(sys.argv[2]))
    elif len(sys.argv) != 1:
        raise SystemExit(
            "usage: validate-runtime-contract.py [--requirements-lock <requirements.lock>]"
        )
    for module in REQUIRED_MODULES:
        importlib.import_module(module)
    actual = {name: version(name) for name in EXPECTED_VERSIONS}
    if actual != EXPECTED_VERSIONS:
        raise SystemExit("Deep Agents Code runtime versions do not match the reviewed contract")
    print(SUCCESS_MARKER)


if __name__ == "__main__":
    main()
