#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Keep explicitly disabled Hermes platforms inert under ambient credentials.

Hermes v0.20.6 honors ``enabled: false`` in its shared and plugin-driven
environment enablement paths, but several built-in adapters still assign
``enabled = True`` directly when credentials are present. A neutral managed
image explicitly disables every packaged optional platform. Preserve those
complete platform objects across environment processing so credentials cannot
activate an adapter or become part of its runtime configuration before a
validated NemoClaw plan writes ``enabled: true``.

The Dockerfile binds this patch to the exact pinned ``gateway/config.py`` hash.
Remove it when the minimum supported Hermes release consistently honors an
explicit disable across every environment override path.
"""

from __future__ import annotations

import argparse
from pathlib import Path

IMPORT_ANCHOR = """import logging
import math
import os
import json
"""
PATCHED_IMPORT_ANCHOR = """from copy import deepcopy
import logging
import math
import os
import json
"""

FUNCTION_ANCHOR = '''def _apply_env_overrides(config: GatewayConfig) -> None:
    """Apply environment variable overrides to config."""
    getenv = _getenv_str
    getenv_int = _getenv_int
'''
PATCHED_FUNCTION_ANCHOR = '''def _apply_env_overrides(config: GatewayConfig) -> None:
    """Apply environment variable overrides to config."""
    explicitly_disabled_platforms = {
        platform: deepcopy(platform_config)
        for platform, platform_config in config.platforms.items()
        if not platform_config.enabled
        and bool(platform_config.extra.get("_enabled_explicit", False))
    } if os.getenv("NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION") == "1" else {}
    getenv = _getenv_str
    getenv_int = _getenv_int
'''

CLEANUP_ANCHOR = '''    for platform_config in config.platforms.values():
        platform_config.extra.pop("_enabled_explicit", None)
'''
PATCHED_CLEANUP_ANCHOR = '''    # Environment variables may populate credentials and directly enable some
    # built-in adapters. Restore every explicit disable as a complete object;
    # validated configurations with enabled=True are deliberately not captured.
    for platform, platform_config in explicitly_disabled_platforms.items():
        config.platforms[platform] = platform_config

    for platform_config in config.platforms.values():
        platform_config.extra.pop("_enabled_explicit", None)
'''


def patch_file(path: Path) -> None:
    source = path.read_text(encoding="utf-8")
    replacements = (
        ("import", IMPORT_ANCHOR, PATCHED_IMPORT_ANCHOR),
        ("function", FUNCTION_ANCHOR, PATCHED_FUNCTION_ANCHOR),
        ("cleanup", CLEANUP_ANCHOR, PATCHED_CLEANUP_ANCHOR),
    )

    if all(source.count(new) == 1 for _, _, new in replacements):
        return

    for label, old, new in replacements:
        old_count = source.count(old)
        new_count = source.count(new)
        if old_count != 1 or new_count != 0:
            raise SystemExit(
                "ERROR: Hermes neutral platform environment source shape changed; "
                f"expected one unpatched {label} anchor, found {old_count} "
                f"(already patched anchors: {new_count})"
            )

    for _, old, new in replacements:
        source = source.replace(old, new)
    path.write_text(source, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "path",
        nargs="?",
        default="/opt/hermes/gateway/config.py",
        help="Hermes gateway configuration module to patch",
    )
    args = parser.parse_args()
    patch_file(Path(args.path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
