#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Compatibility name. Use e2e-openclaw-ollama-load-test.py."""
from __future__ import annotations

import runpy
import sys
from pathlib import Path

print(
    "OpenClaw + Ollama e2e driver moved to e2e-openclaw-ollama-load-test.py",
    file=sys.stderr,
)
runpy.run_path(
    str(Path(__file__).resolve().parent / "e2e-openclaw-ollama-load-test.py"),
    run_name="__main__",
)
