# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Management contract tests; no harness or native SDK dependency."""

import asyncio
import copy
import unittest
from types import SimpleNamespace

from controller import Controller, ManagementError


class Config:
    def __init__(self, value):
        self.value = copy.deepcopy(value)

    @classmethod
    def model_validate(cls, value):
        if value.get("invalid"):
            raise ValueError("invalid config")
        return cls(value)

    def to_mapping(self):
        return copy.deepcopy(self.value)


class Fabric:
    def __init__(self):
        self.starts = 0
        self.stops = 0
        self.fail_start = False
        self.fail_stop = False

    def plan(self, config, *, base_dir):
        return SimpleNamespace(config=config)

    async def start_runtime(self, config, *, base_dir):
        self.starts += 1
        if self.fail_start:
            raise TimeoutError("response lost after possible startup")
        runtime = SimpleNamespace(runtime_id=f"runtime-{self.starts}", status="active")

        async def stop():
            self.stops += 1
            if self.fail_stop:
                raise TimeoutError("response lost after possible stop")
            runtime.status = "stopped"

        runtime.stop = stop
        return runtime


class ManagementContract(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.fabric = Fabric()
        self.host = Controller(self.fabric, Config, base_dir="/workspace")
        self.config = {"harness": {"adapter_id": "example.adapter"}, "settings": {"x": 1}}

    async def apply(self, config=None, **kwargs):
        snapshot = await self.host.observe()
        return await self.host.apply(
            config or self.config, expected_revision=snapshot["revision"], **kwargs
        )

    async def test_plan_and_observe_never_start_or_stop_a_runtime(self):
        before = await self.host.observe()
        plan = await self.host.plan(self.config)
        self.assertEqual(plan["action"], "start")
        self.assertEqual(before, await self.host.observe())
        self.assertEqual((self.fabric.starts, self.fabric.stops), (0, 0))

    async def test_unchanged_apply_preserves_runtime_and_revision(self):
        first = await self.apply()
        self.assertEqual(first, await self.apply())
        self.assertEqual((self.fabric.starts, self.fabric.stops), (1, 0))
        self.assertEqual(first["health"], {"supported": False})

    async def test_changed_configuration_requires_explicit_session_reset(self):
        first = await self.apply()
        changed = {**self.config, "settings": {"unknown_future_field": [1, None]}}
        self.assertEqual((await self.host.plan(changed))["action"], "restart")
        with self.assertRaisesRegex(ManagementError, "session_reset_required"):
            await self.apply(changed)
        self.assertEqual(first, await self.host.observe())
        second = await self.apply(changed, allow_session_reset=True)
        self.assertNotEqual(first["runtime_id"], second["runtime_id"])
        self.assertNotEqual(first["config_digest"], second["config_digest"])
        self.assertEqual((self.fabric.starts, self.fabric.stops), (2, 1))

    async def test_invalid_configuration_does_not_stop_the_current_runtime(self):
        first = await self.apply()
        with self.assertRaises(ValueError):
            await self.apply({"invalid": True}, allow_session_reset=True)
        self.assertEqual(first, await self.host.observe())
        self.assertEqual(self.fabric.stops, 0)

    async def test_stale_or_foreign_revision_cannot_mutate(self):
        old = (await self.host.observe())["revision"]
        await self.apply()
        other = Controller(self.fabric, Config, base_dir="/workspace")
        for revision in (old, (await other.observe())["revision"]):
            with self.assertRaisesRegex(ManagementError, "stale_revision"):
                await self.host.apply(self.config, expected_revision=revision)
        self.assertEqual(self.fabric.starts, 1)

    async def test_concurrent_writers_cannot_both_apply_the_same_revision(self):
        revision = (await self.host.observe())["revision"]
        results = await asyncio.gather(
            *[self.host.apply(self.config, expected_revision=revision) for _ in range(2)],
            return_exceptions=True,
        )
        self.assertEqual(sum(isinstance(result, ManagementError) for result in results), 1)
        self.assertEqual(self.fabric.starts, 1)

    async def test_lost_successful_response_is_recoverable_by_observation(self):
        await self.apply()  # Pretend the caller loses this response.
        self.assertEqual((await self.host.plan(self.config))["action"], "none")
        await self.apply()
        self.assertEqual(self.fabric.starts, 1)

    async def test_ambiguous_start_is_quarantined_without_retry_or_absence_claim(self):
        self.fabric.fail_start = True
        with self.assertRaises(TimeoutError):
            await self.apply()
        snapshot = await self.host.observe()
        self.assertEqual(snapshot["phase"], "unknown")
        self.assertIsNone(snapshot["runtime_id"])
        with self.assertRaisesRegex(ManagementError, "outcome_unknown"):
            await self.apply()
        self.assertEqual(self.fabric.starts, 1)

    async def test_ambiguous_stop_preserves_binding_and_blocks_replacement(self):
        first = await self.apply()
        self.fabric.fail_stop = True
        with self.assertRaises(TimeoutError):
            await self.apply({"settings": {"x": 2}}, allow_session_reset=True)
        snapshot = await self.host.observe()
        self.assertEqual(snapshot["phase"], "unknown")
        self.assertEqual(snapshot["runtime_id"], first["runtime_id"])
        self.assertEqual(snapshot["config_digest"], first["config_digest"])
        with self.assertRaisesRegex(ManagementError, "outcome_unknown"):
            await self.host.stop(expected_revision=snapshot["revision"])
        self.assertEqual((self.fabric.starts, self.fabric.stops), (1, 1))

    async def test_stop_keeps_binding_and_recovery_requires_session_reset(self):
        first = await self.apply()
        stopped = await self.host.stop(expected_revision=first["revision"])
        self.assertEqual(stopped["runtime_id"], first["runtime_id"])
        self.assertEqual(stopped["lifecycle"], "stopped")
        with self.assertRaisesRegex(ManagementError, "session_reset_required"):
            await self.apply()
        await self.apply(allow_session_reset=True)
        self.assertEqual(self.fabric.starts, 2)

    async def test_cancellation_marks_uncertain_outcome_and_preserves_identity(self):
        first = await self.apply()

        async def interrupted():
            raise asyncio.CancelledError()

        self.host.runtime.stop = interrupted
        with self.assertRaises(asyncio.CancelledError):
            await self.host.stop(expected_revision=first["revision"])
        self.assertEqual((await self.host.observe())["phase"], "unknown")
        self.assertEqual((await self.host.observe())["runtime_id"], first["runtime_id"])


if __name__ == "__main__":
    unittest.main()
