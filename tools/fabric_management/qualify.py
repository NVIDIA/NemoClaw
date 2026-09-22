# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Run the same management scenario against a caller-supplied native Fabric config."""

import asyncio
import copy
import json
import os
import sys
import tempfile
from pathlib import Path

from controller import Controller, ManagementError
from nemo_fabric import Fabric, FabricConfig
from nemo_fabric.errors import FabricConfigError


class RecordingFabric(Fabric):
    def __init__(self):
        super().__init__()
        self.runtimes = []

    async def start_runtime(self, *args, **kwargs):
        runtime = await super().start_runtime(*args, **kwargs)
        self.runtimes.append(runtime)
        return runtime


async def qualify(document, directory):
    fabric = RecordingFabric()
    host = Controller(fabric, FabricConfig, base_dir=directory)
    document["environment"] = {"workspace": directory}
    document["runtime"] = {"artifacts": str(Path(directory) / "artifacts")}
    os.environ["FABRIC_EXPERIMENT_KEY"] = "offline-fixture-key"
    try:
        empty = await host.observe()
        plan = await host.plan(document)
        assert plan["action"] == "start"
        assert await host.observe() == empty
        assert not fabric.runtimes
        first = await host.apply(document, expected_revision=empty["revision"])
        assert first["lifecycle"] == "active"
        assert first["health"] == {"supported": False}
        assert await host.plan(document) == {
            **first,
            "desired_digest": first["config_digest"],
            "action": "none",
        }
        assert await host.apply(document, expected_revision=first["revision"]) == first
        assert len(fabric.runtimes) == 1

        invalid = copy.deepcopy(document)
        invalid["harness"]["adapter_id"] = "nonexistent.management.fixture"
        try:
            await host.apply(invalid, expected_revision=first["revision"], allow_session_reset=True)
        except FabricConfigError:
            pass
        else:
            raise AssertionError("Fabric accepted an unknown adapter")
        assert await host.observe() == first
        assert fabric.runtimes[0].status == "active"

        changed = copy.deepcopy(document)
        changed["models"]["default"]["model"] = "gpt-4.1-mini"
        assert (await host.plan(changed))["action"] == "restart"
        try:
            await host.apply(changed, expected_revision=first["revision"])
        except ManagementError as error:
            assert str(error) == "session_reset_required"
        else:
            raise AssertionError("configuration changed without restart consent")
        assert await host.observe() == first
        # Discard the response, then recover the result through observation.
        await host.apply(changed, expected_revision=first["revision"], allow_session_reset=True)
        second = await host.observe()
        assert first["runtime_id"] != second["runtime_id"]
        assert fabric.runtimes[0].status == "stopped"
        assert (await host.plan(changed))["action"] == "none"
        assert await host.apply(changed, expected_revision=second["revision"]) == second
        stopped = await host.stop(expected_revision=second["revision"])
        assert stopped["runtime_id"] == second["runtime_id"]
        assert stopped["lifecycle"] == "stopped"
        assert await host.stop(expected_revision=stopped["revision"]) == stopped
        recovered = await host.apply(
            changed, expected_revision=stopped["revision"], allow_session_reset=True
        )
        assert recovered["runtime_id"] != second["runtime_id"]
        assert len(fabric.runtimes) == 3
        assert all(not runtime.invocations for runtime in fabric.runtimes)
        print(
            json.dumps(
                {
                    "adapter": document["harness"]["adapter_id"],
                    "result": "passed",
                    "starts": 3,
                    "invocations": 0,
                    "health_supported": False,
                }
            )
        )
    finally:
        for runtime in reversed(fabric.runtimes):
            if runtime.status != "stopped":
                await runtime.stop()


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="fabric-management-") as directory:
        asyncio.run(qualify(json.loads(Path(sys.argv[1]).read_text()), directory))
