# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Exercise the reference backend through the same host used by real images."""

import asyncio
import copy
import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

import fabric
from dummy_backend import Backend

CONFIG = {"metadata": {"name": "main"}, "harness": {"adapter_id": "org.nemoclaw.dummy"}}


class ReferenceContract(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.host = fabric.RuntimeHost("main", backend=Backend())

    async def call(self, operation, **fields):
        if operation in ("validate", "prepare", "configure"):
            fields.setdefault("config", copy.deepcopy(CONFIG))
        if operation in ("prepare", "configure"):
            fields.setdefault("expected_generation", self.host.generation)
        return await self.host.handle({"operation": operation, "agent": "main", **fields})

    async def test_validation_needs_neither_fabric_revision_nor_runtime(self):
        before = self.host.snapshot()
        response = await self.call("validate")
        self.assertEqual(response["status"], "succeeded")
        self.assertTrue(response["result"]["valid"])
        self.assertEqual(self.host.snapshot(), before)
        invalid = await self.call(
            "validate", config={**CONFIG, "harness": {"adapter_id": "absent"}}
        )
        self.assertIs(invalid["result"]["valid"], False)
        self.assertEqual(invalid["error"]["effects"], "none")

    async def test_lifecycle_readiness_invocation_and_noops(self):
        stopped = await self.call("check", level="ready")
        self.assertEqual(stopped["status"], "failed")
        self.assertEqual(stopped["result"]["runtime_state"], "stopped")
        started = await self.call("configure")
        self.assertEqual(started["status"], "succeeded")
        for level in ("live", "active", "ready"):
            checked = await self.call("check", level=level)
            self.assertEqual(checked["status"], "succeeded")
            self.assertEqual(checked["result"]["runtime_id"], started["result"]["runtime_id"])
            self.assertEqual(checked["result"]["health"]["source"], "org.nemoclaw.dummy")
            self.assertEqual(checked["result"]["health"]["level"], level)
            self.assertFalse(checked["changed"])
        same = await self.call("configure")
        self.assertFalse(same["changed"])
        self.assertEqual(same["result"], started["result"])
        invoked = await self.call("invoke", input={"message": "hello"})
        self.assertEqual(invoked["result"]["fabric_result"]["output"], {"message": "hello"})
        self.assertIsNone(invoked["changed"])
        prepared = await self.call("prepare")
        self.assertTrue(prepared["result"]["prepared"])
        self.assertIsNone(prepared["result"]["applied_config"])
        self.assertNotEqual(prepared["result"]["generation"], started["result"]["generation"])
        self.assertFalse((await self.call("prepare"))["changed"])

    async def test_rejected_and_stale_changes_preserve_the_running_runtime(self):
        before = (await self.call("configure"))["result"]
        bad = copy.deepcopy(CONFIG)
        bad["harness"]["settings"] = {"ready": "PRIVATE"}
        rejected = await self.call("configure", config=bad)
        self.assertEqual(rejected["status"], "failed")
        self.assertFalse(rejected["changed"])
        self.assertNotIn("PRIVATE", json.dumps(rejected))
        stale = await self.call("prepare", expected_generation="old")
        self.assertEqual(stale["error"]["code"], "stale_generation")
        self.assertEqual(self.host.snapshot(), before)

    async def test_failed_start_advances_generation_and_never_publishes_configuration(self):
        before = self.host.generation
        config = copy.deepcopy(CONFIG)
        config["harness"]["settings"] = {"fail_start": True}
        failed = await self.call("configure", config=config)
        self.assertEqual(failed["status"], "failed")
        self.assertEqual(failed["error"]["effects"], "unknown")
        self.assertNotEqual(failed["result"]["generation"], before)
        self.assertIsNone(failed["result"]["applied_config"])
        self.assertEqual(failed["result"]["runtime_state"], "unknown")

    async def test_failed_health_preserves_configuration_and_never_invokes(self):
        config = copy.deepcopy(CONFIG)
        config["harness"]["settings"] = {"ready": False}
        before = (await self.call("configure", config=config))["result"]
        self.assertEqual((await self.call("check", level="active"))["status"], "succeeded")
        failed = await self.call("check", level="ready")
        self.assertEqual(failed["status"], "failed")
        self.assertEqual(failed["error"]["code"], "fabric_health_failed")
        self.assertEqual(self.host.snapshot(), before)
        self.assertEqual(self.host.runtime.invocations, 0)
        self.assertEqual((await self.call("check", level="operational"))["status"], "unsupported")
        self.assertEqual(self.host.runtime.invocations, 0)

    async def test_failed_stop_keeps_association_and_prevents_a_second_runtime(self):
        config = copy.deepcopy(CONFIG)
        config["harness"]["settings"] = {"fail_stop": True}
        before = (await self.call("configure", config=config))["result"]
        stopped = await self.call("prepare")
        self.assertEqual(stopped["status"], "failed")
        self.assertEqual(stopped["result"]["runtime_state"], "unknown")
        self.assertEqual(stopped["result"]["runtime_id"], before["runtime_id"])
        self.assertEqual(stopped["result"]["applied_config"], config)
        self.assertNotEqual(stopped["result"]["generation"], before["generation"])
        restarted = await self.call("configure")
        self.assertEqual(restarted["status"], "failed")
        self.assertEqual(restarted["result"]["runtime_id"], before["runtime_id"])
        checked = await self.call("check", level="ready")
        self.assertEqual(checked["status"], "failed")
        self.assertEqual(checked["result"]["health"]["checks"][0]["status"], "unknown")

    async def test_health_deadline_preserves_snapshot_and_does_not_retry(self):
        await self.call("configure")
        calls = []

        async def check(runtime, level):
            calls.append((runtime, level))
            await asyncio.Event().wait()

        self.host.backend.check = check
        before = self.host.snapshot()
        with patch("fabric.HEALTH_SECONDS", 0.01):
            result = await asyncio.wait_for(self.call("check", level="ready"), 1)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["error"]["code"], "fabric_health_failed")
        self.assertEqual(result["result"], {**before, "health": None})
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.host.snapshot(), before)

    async def test_health_during_invocation_does_not_wait_for_the_mutation_lock(self):
        await self.call("configure")
        runtime = self.host.runtime
        entered, finish = asyncio.Event(), asyncio.Event()
        original = runtime.invoke

        async def invoke(**kwargs):
            entered.set()
            await finish.wait()
            return await original(**kwargs)

        runtime.invoke = invoke
        task = asyncio.create_task(self.call("invoke", input={"message": "hello"}))
        try:
            await asyncio.wait_for(entered.wait(), 1)
            checked = await asyncio.wait_for(self.call("check", level="ready"), 1)
            self.assertEqual(checked["status"], "succeeded")
            finish.set()
            self.assertEqual((await task)["status"], "succeeded")
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def test_health_cannot_be_associated_with_a_replaced_runtime(self):
        await self.call("configure")
        entered, finish = asyncio.Event(), asyncio.Event()
        original = self.host.backend.check

        async def check(runtime, level):
            report = await original(runtime, level)
            entered.set()
            await finish.wait()
            return report

        self.host.backend.check = check
        task = asyncio.create_task(self.call("check", level="ready"))
        try:
            await asyncio.wait_for(entered.wait(), 1)
            await self.call("prepare")
            finish.set()
            checked = await task
            self.assertEqual(checked["status"], "failed")
            self.assertIsNone(checked["result"]["health"])
            self.assertEqual(checked["result"]["runtime_state"], "stopped")
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


class StandaloneValidation(unittest.TestCase):
    def test_invocation_accepts_text_from_files_and_stdin_but_configuration_stays_an_object(self):
        prompt = "Hello\n世界"
        encoded = json.dumps(prompt).encode()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "prompt.json"
            path.write_bytes(encoded)
            request = fabric.parse_command(["invoke", "--agent", "main", "--input", str(path)])
            self.assertEqual(request["input"], prompt)
            with io.TextIOWrapper(io.BytesIO(encoded)) as stream, patch("sys.stdin", stream):
                request = fabric.parse_command(["invoke", "--agent", "main", "--input", "-"])
            self.assertEqual(request["input"], prompt)
            with self.assertRaises(fabric.ProtocolError):
                fabric.parse_command(["validate", "--agent", "main", "--config", str(path)])
            for value in ([], None, 42, True):
                path.write_text(json.dumps(value))
                with self.subTest(value=value), self.assertRaises(fabric.ProtocolError):
                    fabric.parse_command(["invoke", "--agent", "main", "--input", str(path)])

    def test_validate_does_not_connect_to_a_host_or_start_a_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "config.json"
            config.write_text(json.dumps(CONFIG))
            output = io.StringIO()
            with (
                patch("fabric.load_backend", return_value=Backend()),
                patch("fabric.client", side_effect=AssertionError("must not connect")),
                redirect_stdout(output),
            ):
                code = fabric.main(["validate", "--agent", "main", "--config", str(config)])
            self.assertEqual(code, 0)
            self.assertTrue(json.loads(output.getvalue())["result"]["valid"])
            self.assertEqual(sorted(p.name for p in Path(directory).iterdir()), ["config.json"])


if __name__ == "__main__":
    unittest.main()
