# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Compute the image seal with the runtime guard's canonical MCP function."""

from __future__ import annotations

import argparse
import importlib.util
import sys
from pathlib import Path
from types import ModuleType
from typing import Callable, cast


def _load_guard(path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location("hermes_runtime_config_guard", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Hermes runtime config guard cannot be loaded")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--guard", required=True, type=Path)
    parser.add_argument("--config", required=True, type=Path)
    args = parser.parse_args()

    guard = _load_guard(args.guard)
    canonicalizer = cast(Callable[[str], str], guard._canonical_mcp_servers_digest)
    print(canonicalizer(args.config.read_text(encoding="utf-8")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
