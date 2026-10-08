#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Contract: HPA helper reports 8 GPUs; 0/0 polls are not treated as 8."""

from __future__ import annotations

import importlib.util
import asyncio
import inspect
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

import subprocess
import sys

missing_host = subprocess.run(
    [sys.executable, str(SCRIPT), "--users", "1", "--output", "/tmp/e2e-openclaw-host-required"],
    check=False,
    capture_output=True,
    text=True,
)
assert missing_host.returncode == 2, missing_host.stderr
assert "in-sandbox load helpers" in missing_host.stderr
assert "KILL_OPENCLAW_EXEC" in mod.KILL_SANDBOX_HELPERS
assert "[e]2e-openclaw-load" in mod.KILL_SANDBOX_HELPERS
assert "KILL_OPENCLAW_EXEC" in mod.INTERRUPT_OPENCLAW_INFLIGHT
assert "[o]penclaw gateway run" in mod.INTERRUPT_OPENCLAW_INFLIGHT
assert 'or "nemoclaw-start" in cmd' in mod.INTERRUPT_OPENCLAW_INFLIGHT
source = inspect.getsource(mod.stop_sandbox_chats)
assert "kill_sandbox_load_helpers" in source
assert "interrupt_openclaw_inflight" in source
start_source = inspect.getsource(mod.run_test)
assert "kill_sandbox_load_helpers" in start_source
assert "interrupt_openclaw_inflight" in start_source
assert "publish_ramp_to_sandboxes" not in start_source
assert "Each user sends chats to that user's sandbox." not in start_source
# Start must not restart the gateway (that races the max_tokens pin).
start_only = start_source.split("print(\"=\" * 70)", 1)[0]
assert "interrupt_openclaw_inflight" not in start_only
try:
    asyncio.run(mod.simulate_user())
except RuntimeError as exc:
    assert "does not copy load helpers" in str(exc)
else:
    raise AssertionError("simulate_user must not copy e2e-openclaw-load into sandboxes")
helper = (Path(__file__).resolve().parent.parent / "files" / "openclaw-e2e-ws-prompt.py").read_text()
assert 'os.environ.get("E2E_DRAIN_SEC", "0")' in helper
assert 'os.environ.get("E2E_DRAIN_SEC", "8")' not in helper
print("OK: HPA helper reports the 8 GPU target without treating a failed poll as 8")
print("OK: OpenClaw client requires --host and does not start in-sandbox helpers")
print("OK: client stop kills leftover helpers and drops in-flight OpenClaw completions")
print("OK: WS helper does not drain chat.send after SIGTERM")
