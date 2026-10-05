# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""A deterministic reference agent; never used as a fallback for a real adapter."""

import asyncio
import copy
import uuid
from datetime import UTC, datetime
from types import SimpleNamespace

ADAPTER_ID = "org.nemoclaw.dummy"
HEALTH_CHECKS = ("live", "active", "ready")


class InvalidConfiguration(ValueError):
    pass


class Runtime:
    def __init__(self, settings):
        self.settings = settings
        self.runtime_id = uuid.uuid4().hex
        self.status = "active"
        self.invocations = 0

    async def stop(self):
        self.status = "unknown"
        if self.settings.get("fail_stop", False):
            raise RuntimeError("reference stop failure")
        self.status = "stopped"

    async def invoke(self, *, input):
        if (
            set(input) - {"message", "delay_ms", "fail"}
            or not isinstance(input.get("message", ""), str)
            or type(input.get("delay_ms", 0)) is not int
            or not 0 <= input.get("delay_ms", 0) <= 10000
            or type(input.get("fail", False)) is not bool
        ):
            raise ValueError("invalid reference input")
        self.invocations += 1
        await asyncio.sleep(input.get("delay_ms", 0) / 1000)
        result = {
            "status": "failed" if input.get("fail", False) else "succeeded",
            "output": {"message": self.settings.get("reply", input.get("message", ""))},
        }
        return SimpleNamespace(to_mapping=lambda: result)


class Backend:
    health_checks = HEALTH_CHECKS

    def validate(self, config, *, base_dir):
        harness = config.get("harness")
        if not isinstance(harness, dict) or harness.get("adapter_id") != ADAPTER_ID:
            raise InvalidConfiguration("unknown reference adapter")
        if set(harness) - {"adapter_id", "settings"}:
            raise InvalidConfiguration("unknown reference harness field")
        settings = harness.get("settings", {})
        types = {"reply": str, "ready": bool, "fail_start": bool, "fail_stop": bool}
        if not isinstance(settings, dict) or any(
            key not in types or type(value) is not types[key] for key, value in settings.items()
        ):
            raise InvalidConfiguration("invalid reference settings")
        return copy.deepcopy(config)

    async def start_runtime(self, config, *, base_dir):
        settings = config["harness"].get("settings", {})
        if settings.get("fail_start", False):
            raise RuntimeError("reference start failure")
        return Runtime(copy.deepcopy(settings))

    @staticmethod
    def error_details(error):
        return None, isinstance(error, InvalidConfiguration), False

    async def check(self, runtime, level):
        running = runtime is not None and runtime.status == "active"
        checks = [
            {
                "level": name,
                "status": "passed"
                if running and (name != "ready" or runtime.settings.get("ready", True))
                else "unknown"
                if runtime is not None and runtime.status == "unknown"
                else "failed",
            }
            for name in HEALTH_CHECKS[: HEALTH_CHECKS.index(level) + 1]
        ]
        passed = all(check["status"] == "passed" for check in checks)
        return passed, {
            "source": ADAPTER_ID,
            "observed_at": datetime.now(UTC).isoformat(),
            "runtime_id": runtime.runtime_id if runtime else None,
            "level": level,
            "checks": checks,
        }
