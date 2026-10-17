# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""NemoClaw's test-only Fabric adapter.

A deterministic agent with no model. It echoes each invocation's message, or
replies with fixed text, and fails a start, stop, or invocation when told to.
The dummy reference image installs it so NemoClaw's tests run Fabric's own
runtime and fabric-agent-ctl. Never use it in place of a real adapter.
"""

from __future__ import annotations

import asyncio
from typing import Any

from nemo_fabric_adapter_contract.models import (
    AgentConfig,
    AgentRunError,
    AgentRunRequest,
    AgentRunResult,
    AgentRunStatus,
    RuntimeContext,
)
from nemo_fabric_adapters.common import lifecycle

INPUT_FIELDS = {"message", "delay_ms", "fail"}
MAX_DELAY_MS = 10_000


def parse_input(value: Any) -> tuple[str, int, bool]:
    """Return the message, delay, and failure an invocation asks for.

    Input is text, or an object with an optional message, a delay in
    milliseconds of at most ten seconds, and whether to fail.
    """
    if isinstance(value, str):
        return value, 0, False
    if not isinstance(value, dict) or set(value) - INPUT_FIELDS:
        raise lifecycle.LifecycleError(
            "dummy_invalid_input",
            "input must be text or an object with message, delay_ms, and fail",
        )
    message = value.get("message", "")
    delay_ms = value.get("delay_ms", 0)
    fail = value.get("fail", False)
    if (
        not isinstance(message, str)
        or type(delay_ms) is not int
        or not 0 <= delay_ms <= MAX_DELAY_MS
        or type(fail) is not bool
    ):
        raise lifecycle.LifecycleError(
            "dummy_invalid_input",
            "message must be text, delay_ms a whole number from 0 to 10000, and fail a boolean",
        )
    return message, delay_ms, fail


class DummyRuntime:
    """One deterministic runtime per Fabric host."""

    def __init__(self) -> None:
        self.settings: dict[str, Any] = {}

    async def start(self, payload: dict[str, Any]) -> None:
        config = payload["config"]
        harness = config.harness
        self.settings = dict(harness.settings) if harness is not None else {}
        if self.settings.get("fail_start", False):
            raise lifecycle.LifecycleError(
                "dummy_start_failed", "the dummy adapter was told to fail starting"
            )

    async def invoke(
        self,
        request: AgentRunRequest,
        context: RuntimeContext,
    ) -> AgentRunResult:
        message, delay_ms, fail = parse_input(request.input)
        await asyncio.sleep(delay_ms / 1000)
        if fail:
            return AgentRunResult(
                status=AgentRunStatus.FAILED,
                output=None,
                error=AgentRunError(
                    code="dummy_invocation_failed",
                    message="the dummy adapter was told to fail this invocation",
                ),
            )
        return AgentRunResult(
            status=AgentRunStatus.SUCCEEDED,
            output={"message": self.settings.get("reply", message)},
        )

    async def stop(self) -> None:
        if self.settings.get("fail_stop", False):
            raise lifecycle.LifecycleError(
                "dummy_stop_failed", "the dummy adapter was told to fail stopping"
            )


def main() -> None:
    """Serve Fabric's adapter lifecycle protocol."""
    lifecycle.serve(DummyRuntime, config_loader=AgentConfig.from_mapping)


if __name__ == "__main__":
    main()
