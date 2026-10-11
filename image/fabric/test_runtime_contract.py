# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Readback and error propagation around Fabric's public runtime API."""

import asyncio
import copy
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from bridge_protocol import parse_command
from fabric import RuntimeHost, client
from nemo_fabric import Fabric, FabricConfigError, FabricRuntimeError

CONFIG = {
    "metadata": {"name": "main"},
    "harness": {"adapter_id": "vendor.new", "settings": {"nested": [1, 2]}},
}


async def configure(host, config):
    return await host.handle(
        {
            "operation": "configure",
            "agent": "main",
            "config": config,
            "expected_generation": host.snapshot()["generation"],
        }
    )


class RuntimeReadback(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.runtime = SimpleNamespace(runtime_id="owned", status="active", stop=AsyncMock())
        self.api = SimpleNamespace(plan=Mock(), start_runtime=AsyncMock(return_value=self.runtime))
        mock = patch("backend.Fabric", return_value=self.api)
        mock.start()
        self.addCleanup(mock.stop)
        self.host = RuntimeHost("main")

    async def test_check_returns_applied_configuration_without_invoking_or_reconfiguring(self):
        await configure(self.host, CONFIG)
        self.runtime.invoke = AsyncMock()
        before = self.host.snapshot()
        requests = []
        with tempfile.TemporaryDirectory() as directory:
            socket = str(Path(directory) / "fabric.sock")

            async def respond(reader, writer):
                request = json.loads(await reader.readline())
                requests.append(request)
                response = await self.host.handle(request)
                writer.write(json.dumps(response).encode() + b"\n")
                await writer.drain()
                writer.close()
                await writer.wait_closed()

            async with await asyncio.start_unix_server(respond, socket):
                with patch("fabric.SOCKET", socket):
                    response = await client(parse_command(["check", "--agent", "main", "--live"]))
        self.assertEqual(requests, [{"operation": "check", "agent": "main", "level": "live"}])
        self.assertEqual(response["status"], "unsupported")
        self.assertFalse(response["changed"])
        self.assertEqual(response["result"], {**before, "health": None})
        self.assertEqual(self.host.snapshot(), before)
        self.api.start_runtime.assert_awaited_once()
        self.runtime.stop.assert_not_awaited()
        self.runtime.invoke.assert_not_awaited()

    async def test_readback_is_reconstructible_and_unchanged_apply_does_not_restart(self):
        self.assertIsNone(self.host.snapshot()["applied_config"])
        await configure(self.host, CONFIG)
        await configure(self.host, copy.deepcopy(CONFIG))
        self.assertEqual(self.host.snapshot()["applied_config"], CONFIG)
        self.assertEqual(self.host.snapshot()["runtime_state"], "running")
        self.api.start_runtime.assert_awaited_once()
        self.runtime.stop.assert_not_awaited()
        restarted = RuntimeHost("main")
        self.assertEqual(restarted.snapshot()["runtime_state"], "stopped")
        self.assertIsNone(restarted.snapshot()["applied_config"])
        await self.host.stop()
        self.runtime.stop.assert_awaited_once()
        self.assertIsNone(self.host.snapshot()["applied_config"])
        self.assertIsNone(self.host.snapshot()["runtime_id"])

    async def test_starting_runtime_does_not_publish_configuration_before_success(self):
        config = copy.deepcopy(CONFIG)
        entered, finish = asyncio.Event(), asyncio.Event()

        async def start(*args, **kwargs):
            entered.set()
            await finish.wait()
            return self.runtime

        self.api.start_runtime.side_effect = start
        configuring = asyncio.create_task(configure(self.host, config))
        try:
            await asyncio.wait_for(entered.wait(), 1)
            response = await asyncio.wait_for(
                self.host.handle({"operation": "check", "agent": "main", "level": "live"}), 1
            )
            snapshot = response["result"]
            self.assertIsNone(snapshot["applied_config"])
            self.assertIsNone(snapshot["runtime_id"])
            self.assertEqual(snapshot["runtime_state"], "unknown")
            config["harness"]["settings"]["nested"].append(3)
            finish.set()
            response = await asyncio.wait_for(configuring, 1)
            self.assertEqual(response["result"]["applied_config"], CONFIG)
            self.assertEqual(response["result"]["runtime_id"], "owned")
            self.assertEqual(response["result"]["runtime_state"], "running")
        finally:
            configuring.cancel()
            await asyncio.gather(configuring, return_exceptions=True)

    async def test_reading_a_snapshot_cannot_change_the_applied_configuration(self):
        response = await configure(self.host, CONFIG)
        response["result"]["applied_config"]["harness"]["settings"]["nested"].append(3)
        self.assertEqual(self.host.snapshot()["applied_config"], CONFIG)
        await configure(self.host, CONFIG)
        self.api.start_runtime.assert_awaited_once()
        self.runtime.stop.assert_not_awaited()

    async def test_rejected_configuration_preserves_running_runtime_and_association(self):
        await configure(self.host, CONFIG)
        before = self.host.snapshot()
        self.api.plan.side_effect = FabricConfigError("PRIVATE_NATIVE_SETTINGS")
        response = await configure(self.host, {**CONFIG, "tools": {"enabled": ["changed"]}})
        self.assertEqual(response["status"], "failed")
        self.assertEqual(self.host.snapshot(), before)
        self.runtime.stop.assert_not_awaited()
        self.assertNotIn("PRIVATE", json.dumps(response))

    async def test_failed_stop_preserves_runtime_association_without_claiming_running(self):
        await configure(self.host, CONFIG)
        self.runtime.stop.side_effect = FabricRuntimeError(
            "PRIVATE", stage="stop", code="lifecycle_adapter_stop_failed"
        )
        response = await configure(self.host, {**CONFIG, "tools": {"enabled": ["changed"]}})
        self.assertEqual(response["status"], "failed")
        self.assertEqual(response["error"]["code"], "lifecycle_adapter_stop_failed")
        self.assertEqual(response["error"]["effects"], "unknown")
        self.assertEqual(response["result"]["runtime_state"], "unknown")
        self.assertEqual(response["result"]["runtime_id"], "owned")
        self.assertEqual(response["result"]["applied_config"], CONFIG)
        self.api.start_runtime.assert_awaited_once()

    async def test_failed_replacement_does_not_publish_configuration_or_restore_the_old_one(self):
        await configure(self.host, CONFIG)
        self.api.start_runtime.side_effect = FabricRuntimeError(
            "PRIVATE_MESSAGE", stage="start", code="PRIVATE_CODE", details={"token": "PRIVATE"}
        )
        response = await configure(self.host, {**CONFIG, "tools": {"enabled": ["changed"]}})
        self.assertEqual(response["error"]["code"], "fabric_start_failed")
        self.assertIsNone(response["result"]["applied_config"])
        self.assertIsNone(response["result"]["runtime_id"])
        self.assertEqual(response["result"]["runtime_state"], "unknown")
        self.runtime.stop.assert_awaited_once()
        self.assertEqual(self.api.start_runtime.await_count, 2)
        self.assertNotIn("PRIVATE", json.dumps(response))


class NativeFailure(unittest.IsolatedAsyncioTestCase):
    async def test_native_planner_distinguishes_missing_descriptor_evidence_from_invalid_settings(
        self,
    ):
        descriptor = copy.deepcopy(Fabric().discover()[0].to_mapping()["descriptor"])
        descriptor["adapter_id"] = "org.nemoclaw.test.validation"
        descriptor.pop("settings_schema", None)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "validation.fabric-adapter.json"
            path.write_text(json.dumps(descriptor))
            config = {
                "metadata": {"name": "main"},
                "harness": {
                    "adapter_id": descriptor["adapter_id"],
                    "settings": {"evidence": "PRIVATE"},
                },
                "discovery": {"local_paths": [str(path)]},
            }
            host = RuntimeHost("main", root)
            for schema, valid, code in (
                (None, None, "validation_unavailable"),
                (
                    {"type": "object", "additionalProperties": False},
                    False,
                    "fabric_validate_failed",
                ),
            ):
                if schema is not None:
                    descriptor["settings_schema"] = schema
                    path.write_text(json.dumps(descriptor))
                response = await host.handle(
                    {"operation": "validate", "agent": "main", "config": config}
                )
                self.assertIs(response["result"]["valid"], valid)
                self.assertEqual(response["error"]["code"], code)
                self.assertEqual(response["error"]["effects"], "none")
                self.assertFalse(response["changed"])
                self.assertNotIn("PRIVATE", json.dumps(response))
                self.assertIsNone(host.snapshot()["runtime_id"])
                self.assertEqual(set(root.iterdir()), {path})

    async def test_native_lifecycle_code_survives_the_real_sdk_start_wrapper(self):
        native_error = RuntimeError("PRIVATE_NATIVE_MESSAGE")
        native_error.code = "pi_model_unknown"
        native = SimpleNamespace(start_runtime=Mock(side_effect=native_error))
        with tempfile.TemporaryDirectory() as directory:
            host = RuntimeHost("main", Path(directory))
            with (
                patch.object(
                    host.backend.fabric, "plan", return_value=SimpleNamespace(to_mapping=lambda: {})
                ),
                patch.object(host.backend.fabric, "_require_native_module", return_value=native),
            ):
                response = await configure(host, CONFIG)
        self.assertEqual(response["error"]["code"], "pi_model_unknown")
        self.assertEqual(response["error"]["stage"], "start")
        self.assertNotIn("PRIVATE", json.dumps(response))


@unittest.skipUnless(
    os.environ.get("NEMOCLAW_TEST_FABRIC_DESCRIPTOR"), "requires installed Fabric-only fixture"
)
class InstalledAdapterExecution(unittest.IsolatedAsyncioTestCase):
    async def test_native_adapter_failure_survives_every_error_boundary_without_details(self):
        import importlib.util

        descriptor = json.loads(Path(os.environ["NEMOCLAW_TEST_FABRIC_DESCRIPTOR"]).read_text())
        original = Path(importlib.util.find_spec("fabric_discovery_fixture").origin).read_text()
        for code, failure in (
            (
                "pi_model_unknown",
                'raise lifecycle.LifecycleError("pi_model_unknown", "PRIVATE_SENTINEL", metadata={"token": "PRIVATE_SENTINEL"})',
            ),
            ("lifecycle_adapter_start_failed", 'raise ValueError("PRIVATE_SENTINEL")'),
        ):
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                replaced = original.replace('self.config = payload["config"]', failure)
                self.assertNotEqual(original, replaced)
                (root / "fabric_discovery_fixture.py").write_text(
                    "# NeMo Fabric fixture at 24f068c895e5cbc30286bc743498be4e5014d658.\n"
                    "# 2026-09-30: replace startup with a controlled error for this test.\n"
                    + replaced
                )
                config = self.configuration(descriptor, directory)
                host = RuntimeHost("main", root)
                with patch.dict(os.environ, {"PYTHONPATH": directory}):
                    response = await configure(host, config)
                self.assertEqual(response["error"]["stage"], "start")
                self.assertEqual(response["error"]["code"], code)
                self.assertNotIn("PRIVATE", json.dumps(response))

    @staticmethod
    def configuration(descriptor, directory):
        return {
            "metadata": {"name": "main"},
            "harness": {
                "adapter_id": descriptor["adapter_id"],
                "settings": {"mode": "advanced", "budget": 4},
            },
            "models": {"default": {"provider": "openai", "model": "fixture-model"}},
            "environment": {"workspace": directory},
            "runtime": {"artifacts": directory},
        }

    async def test_installed_discovery_settings_reach_actual_fabric_execution(self):
        from catalog import snapshot

        descriptor = json.loads(Path(os.environ["NEMOCLAW_TEST_FABRIC_DESCRIPTOR"]).read_text())
        records = snapshot("a" * 40, "b" * 64)["adapters"]
        record = next(
            item for item in records if item["descriptor"]["adapter_id"] == descriptor["adapter_id"]
        )
        self.assertEqual(record["descriptor"]["settings_schema"], descriptor["settings_schema"])
        self.assertTrue(any(item["source"] == "installed_package" for item in record["provenance"]))
        with tempfile.TemporaryDirectory() as directory:
            config = self.configuration(descriptor, directory)
            host = RuntimeHost("main", Path(directory))
            try:
                self.assertEqual((await configure(host, config))["status"], "succeeded")
                response = await host.handle(
                    {"operation": "invoke", "agent": "main", "input": {"request": "unchanged"}}
                )
                self.assertEqual(response["status"], "succeeded")
                result = response["result"]["fabric_result"]
                self.assertEqual(result["output"]["settings"], config["harness"]["settings"])
                self.assertEqual(result["output"]["input"], {"request": "unchanged"})
                invalid = copy.deepcopy(config)
                del invalid["harness"]["settings"]["budget"]
                self.assertEqual((await configure(host, invalid))["status"], "failed")
                self.assertEqual(host.snapshot()["applied_config"], config)
                self.assertEqual(host.snapshot()["runtime_state"], "running")
            finally:
                await host.stop()
