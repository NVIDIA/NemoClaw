# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Deployment lifecycle around Fabric's public API, independent of adapter identity."""

import asyncio
import copy
import io
import json
import os
import runpy
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from fabric import RuntimeHost, client
from nemo_fabric import FabricConfigError, FabricRuntimeError


class HealthCommand(unittest.TestCase):
    def test_unsupported_health_does_not_contact_the_runtime_host(self):
        output = io.StringIO()
        with (
            patch("sys.argv", ["fabric.py", "health", "main"]),
            patch("asyncio.open_unix_connection", new_callable=AsyncMock) as connect,
            redirect_stdout(output),
        ):
            connect.side_effect = OSError("host is unavailable")
            runpy.run_path(str(Path(__file__).with_name("fabric.py")), run_name="__main__")
        self.assertEqual(
            json.loads(output.getvalue()),
            {"supported": False, "report": None, "reason_code": "fabric_health_unsupported"},
        )
        connect.assert_not_awaited()


class RuntimeLifecycle(unittest.IsolatedAsyncioTestCase):
    async def test_configuration_is_reconstructible_and_unchanged_apply_does_not_restart(self):
        config = {
            "metadata": {"name": "main"},
            "harness": {"adapter_id": "vendor.new", "settings": {"nested": [1, 2]}},
        }
        runtime = SimpleNamespace(runtime_id="owned", status="active", stop=AsyncMock())
        fabric = SimpleNamespace(plan=Mock(), start_runtime=AsyncMock(return_value=runtime))
        with (
            tempfile.TemporaryDirectory() as directory,
            patch("fabric.Fabric", return_value=fabric),
        ):
            host = RuntimeHost("main", Path(directory))
            self.assertFalse(host.status()["ready"])
            await host.configure(config)
            await host.configure(copy.deepcopy(config))
            self.assertEqual(host.status()["config"], config)
            self.assertTrue(host.status()["ready"])
            fabric.start_runtime.assert_awaited_once()
            runtime.stop.assert_not_awaited()
            # A process restart waits for apply to establish current routes.
            restarted = RuntimeHost("main", Path(directory))
            self.assertFalse(restarted.status()["ready"])
            await host.stop()
            runtime.stop.assert_awaited_once()

    async def test_invalid_configuration_preserves_the_running_runtime_and_saved_intent(self):
        config = {"metadata": {"name": "main"}, "harness": {"adapter_id": "vendor.new"}}
        runtime = SimpleNamespace(runtime_id="owned", status="active", stop=AsyncMock())
        fabric = SimpleNamespace(plan=Mock(), start_runtime=AsyncMock(return_value=runtime))
        with (
            tempfile.TemporaryDirectory() as directory,
            patch("fabric.Fabric", return_value=fabric),
        ):
            host = RuntimeHost("main", Path(directory))
            await host.configure(config)
            before = copy.deepcopy(host.config)
            fabric.plan.side_effect = ValueError("Fabric rejected native settings")
            with self.assertRaises(ValueError):
                await host.configure(
                    {**config, "harness": {"adapter_id": "vendor.new", "settings": {"bad": True}}}
                )
            self.assertEqual(host.config, before)
            self.assertTrue(host.status()["ready"])
            runtime.stop.assert_not_awaited()

    async def test_configuration_failure_reaches_the_provider_with_runtime_state(self):
        failure = {
            "error": {
                "stage": "start",
                "code": "lifecycle_adapter_start_failed",
                "runtime_state": "unavailable",
            }
        }
        with tempfile.TemporaryDirectory() as directory:
            socket = str(Path(directory) / "fabric.sock")

            async def respond(reader, writer):
                await reader.readline()
                writer.write(json.dumps(failure).encode() + b"\n")
                await writer.drain()
                writer.close()
                await writer.wait_closed()

            output = io.StringIO()
            async with await asyncio.start_unix_server(respond, socket):
                with patch("fabric.SOCKET", socket), redirect_stdout(output):
                    status = await client("configure", "main", {"metadata": {"name": "main"}})
            self.assertEqual(status, 2)
            self.assertEqual(json.loads(output.getvalue()), failure)

    async def test_failed_restart_reports_unavailable_without_exposing_exception_details(self):
        config = {"metadata": {"name": "main"}, "harness": {"adapter_id": "vendor.new"}}
        runtime = SimpleNamespace(runtime_id="owned", status="active", stop=AsyncMock())
        fabric = SimpleNamespace(plan=Mock(), start_runtime=AsyncMock(return_value=runtime))
        with (
            tempfile.TemporaryDirectory() as directory,
            patch("fabric.Fabric", return_value=fabric),
        ):
            host = RuntimeHost("main", Path(directory))
            await host.configure(config)
            fabric.start_runtime.side_effect = FabricRuntimeError(
                "secret-native-message",
                stage="start",
                code="secret-native-code",
                details={"token": "secret-value"},
            )
            revised = {**config, "models": {"default": {"provider": "openai", "model": "changed"}}}
            with self.assertRaises(FabricRuntimeError) as failed:
                await host.configure(revised)
            self.assertEqual(
                host.failure(failed.exception),
                {
                    "error": {
                        "stage": "start",
                        "code": "fabric_start_failed",
                        "runtime_state": "unavailable",
                    }
                },
            )
            self.assertFalse(host.status()["ready"])
            self.assertEqual(host.status()["config"], revised)
            runtime.stop.assert_awaited_once()
            self.assertEqual(fabric.start_runtime.await_count, 2)
            fabric.start_runtime.side_effect = None
            await host.configure(revised)
            self.assertTrue(host.status()["ready"])
            runtime.stop.side_effect = FabricRuntimeError(
                "secret", stage="stop", code="lifecycle_adapter_stop_failed"
            )
            with self.assertRaises(FabricRuntimeError) as failed:
                await host.stop()
            self.assertEqual(host.failure(failed.exception)["error"]["runtime_state"], "unknown")

    async def test_wrong_agent_identity_cannot_invoke_the_bound_runtime(self):
        result = {"status": "succeeded", "output": "native"}
        runtime = SimpleNamespace(
            runtime_id="owned",
            status="active",
            invoke=AsyncMock(return_value=SimpleNamespace(to_mapping=lambda: result)),
        )
        with tempfile.TemporaryDirectory() as directory:
            host = RuntimeHost("main", Path(directory))
            host.runtime = runtime
            socket = str(Path(directory) / "fabric.sock")

            async def respond(reader, writer):
                try:
                    response = await host.handle(json.loads(await reader.readline()))
                except ValueError:
                    response = {"error": "wrong identity"}
                writer.write(json.dumps(response).encode() + b"\n")
                await writer.drain()
                writer.close()
                await writer.wait_closed()

            async with await asyncio.start_unix_server(respond, socket):
                with patch("fabric.SOCKET", socket):
                    self.assertEqual(await client("invoke", "another", input="request"), 1)
            runtime.invoke.assert_not_awaited()

    async def test_explicit_invocation_preserves_fabric_result_without_assuming_output_shape(self):
        result = {"status": "succeeded", "output": {"arbitrary": [3, 4]}}
        runtime = SimpleNamespace(
            runtime_id="owned",
            status="active",
            invoke=AsyncMock(return_value=SimpleNamespace(to_mapping=lambda: result)),
        )
        with tempfile.TemporaryDirectory() as directory:
            host = RuntimeHost("main", Path(directory))
            host.runtime = runtime
            self.assertEqual(
                await host.handle(
                    {"operation": "invoke", "agent": "main", "input": {"native": "request"}}
                ),
                result,
            )
            runtime.invoke.assert_awaited_once_with(input={"native": "request"})


@unittest.skipUnless(
    os.environ.get("NEMOCLAW_TEST_FABRIC_DESCRIPTOR"), "requires installed Fabric-only fixture"
)
class InstalledAdapterExecution(unittest.IsolatedAsyncioTestCase):
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
            config = {
                "metadata": {"name": "main"},
                "harness": {
                    "adapter_id": descriptor["adapter_id"],
                    "settings": {"mode": "advanced", "budget": 4},
                },
                "models": {"default": {"provider": "openai", "model": "fixture-model"}},
                "environment": {"workspace": directory},
                "runtime": {"artifacts": directory},
            }
            host = RuntimeHost("main", Path(directory))
            try:
                await host.configure(config)
                result = await host.handle(
                    {"operation": "invoke", "agent": "main", "input": {"request": "unchanged"}}
                )
                self.assertEqual(result["status"], "succeeded")
                self.assertEqual(result["output"]["settings"], config["harness"]["settings"])
                self.assertEqual(result["output"]["input"], {"request": "unchanged"})
                invalid = copy.deepcopy(config)
                del invalid["harness"]["settings"]["budget"]
                with self.assertRaises(FabricConfigError):
                    await host.configure(invalid)
                self.assertEqual(host.status()["config"], config)
                self.assertTrue(host.status()["ready"])
            finally:
                await host.stop()
