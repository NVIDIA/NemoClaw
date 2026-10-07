#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Contract: HPA helper reports 8 GPUs; 0/0 polls are not treated as 8."""

from __future__ import annotations

import importlib.util
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "e2e-openclaw-ollama-load-test.py"
spec = importlib.util.spec_from_file_location("e2e_openclaw_ollama_load_test", SCRIPT)
assert spec and spec.loader
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
reached = mod.hpa_replicas_reached_target

assert reached(0, 0, 8) is False, "failed HPA poll must not look like 8 GPUs"
assert reached(1, 1, 8) is False
assert reached(7, 7, 8) is False
assert reached(7, 8, 8) is True, "desired 8 is at the demo target"
assert reached(8, 7, 8) is True
assert reached(8, 8, 8) is True
assert reached(2, 3, 8) is False
print("OK: HPA helper reports the 8 GPU target without treating a failed poll as 8")
