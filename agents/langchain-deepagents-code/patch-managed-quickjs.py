# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Disable Wasmtime copy-on-write memory initialization in managed DCode."""

from __future__ import annotations

import importlib.metadata
import importlib.util
from pathlib import Path

EXPECTED_QUICKJS_RS_VERSION = "0.2.5"
PATCH_MARKER = "# NemoClaw-managed OpenShell memfd compatibility."
ENGINE_MARKER = "                _SHARED_ENGINE = wasmtime.Engine()\n"
ENGINE_PATCH = f"""                {PATCH_MARKER}
                config = wasmtime.Config()
                config.memory_init_cow = False
                _SHARED_ENGINE = wasmtime.Engine(config)
"""


def _package_root() -> Path:
    spec = importlib.util.find_spec("quickjs_rs")
    if spec is None or not spec.submodule_search_locations:
        raise RuntimeError("quickjs-rs package not found")
    roots = list(spec.submodule_search_locations)
    if len(roots) != 1:
        raise RuntimeError(f"Expected one quickjs-rs package root, found {roots}")
    return Path(roots[0])


def patch_wasmtime_engine(source: str) -> str:
    """Return the exact quickjs-rs 0.2.5 engine source with CoW disabled."""
    if PATCH_MARKER in source:
        if source.count(ENGINE_PATCH) != 1 or ENGINE_MARKER in source:
            raise RuntimeError("Installed quickjs-rs Wasmtime patch is inconsistent")
        return source
    if source.count(ENGINE_MARKER) != 1:
        raise RuntimeError(
            "Expected one quickjs-rs 0.2.5 default Wasmtime engine constructor"
        )
    patched = source.replace(ENGINE_MARKER, ENGINE_PATCH)
    compile(patched, "quickjs_rs/_wasmtime.py", "exec")
    return patched


def main() -> None:
    actual_version = importlib.metadata.version("quickjs-rs")
    if actual_version != EXPECTED_QUICKJS_RS_VERSION:
        raise RuntimeError(
            f"Expected quickjs-rs=={EXPECTED_QUICKJS_RS_VERSION}, found {actual_version}"
        )

    engine_path = _package_root() / "_wasmtime.py"
    if not engine_path.is_file() or engine_path.is_symlink():
        raise RuntimeError(
            f"Expected one regular quickjs-rs Wasmtime adapter at {engine_path}"
        )
    source = engine_path.read_text(encoding="utf-8")
    patched = patch_wasmtime_engine(source)
    if patched != source:
        engine_path.write_text(patched, encoding="utf-8")


if __name__ == "__main__":
    main()
