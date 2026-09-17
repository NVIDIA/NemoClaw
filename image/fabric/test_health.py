# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock

from health import runtime_health


class RuntimeHealthTests(unittest.IsolatedAsyncioTestCase):
    async def test_existing_runtime_report_is_preserved_without_invocation(self):
        report = {"runtime_id": "owned", "activity": "busy", "readiness": "ready"}
        runtime = SimpleNamespace(
            runtime_id="owned",
            check_health=AsyncMock(return_value=SimpleNamespace(to_mapping=lambda: report)),
        )
        result = await runtime_health(runtime)
        self.assertEqual(result, {"supported": True, "report": report, "reason_code": None})
        runtime.check_health.assert_awaited_once_with(timeout_seconds=3.0)

    async def test_old_runtime_is_unsupported_not_healthy(self):
        result = await runtime_health(SimpleNamespace(runtime_id="old", status="active"))
        self.assertEqual(result["reason_code"], "fabric_health_unsupported")
        self.assertFalse(result["supported"])
        self.assertIsNone(result["report"])

    async def test_no_runtime_is_unknown_not_unsupported(self):
        result = await runtime_health(None)
        self.assertTrue(result["supported"])
        self.assertEqual(result["reason_code"], "runtime_unavailable")

    async def test_timeout_is_bounded_and_does_not_wait_for_invocation(self):
        async def stalled(**kwargs):
            await asyncio.Event().wait()

        runtime = SimpleNamespace(runtime_id="owned", check_health=stalled)
        result = await asyncio.wait_for(runtime_health(runtime, timeout_seconds=0.01), 0.2)
        self.assertEqual(result["reason_code"], "fabric_health_timeout")
        self.assertIsNone(result["report"])

    async def test_errors_are_not_exposed_and_cancellation_propagates(self):
        runtime = SimpleNamespace(
            runtime_id="owned", check_health=AsyncMock(side_effect=ValueError("secret-sentinel"))
        )
        result = await runtime_health(runtime)
        self.assertNotIn("secret-sentinel", str(result))
        self.assertEqual(result["reason_code"], "fabric_health_error")
        runtime.check_health.side_effect = asyncio.CancelledError()
        with self.assertRaises(asyncio.CancelledError):
            await runtime_health(runtime)

    async def test_report_for_another_runtime_is_rejected(self):
        runtime = SimpleNamespace(
            runtime_id="owned",
            check_health=AsyncMock(
                return_value=SimpleNamespace(to_mapping=lambda: {"runtime_id": "other"})
            ),
        )
        self.assertEqual((await runtime_health(runtime))["reason_code"], "fabric_health_error")
