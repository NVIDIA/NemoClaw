# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fabric import client, configuration
from pi_host import PiHost


class PiModelConfiguration(unittest.TestCase):
    def test_yaml_model_reaches_pi_without_a_catalog_substitution(self):
        for model in ("gpt-4o-mini", "qwen3:4b", "my-model"):
            config = configuration("main", "pi", {"model": model})
            self.assertEqual(config["models"]["default"]["model"], model)

    def test_custom_model_metadata_reaches_the_adapter(self):
        options = {
            "futureOption": {"nested": [None, 7, True]},
            "thinkingLevelMap": {"off": None},
            "contextWindow": "Pi validates this",
        }
        config = configuration("main", "pi", {"model": "qwen3:4b", "piModel": options})
        self.assertEqual(config["models"]["default"]["settings"]["model_metadata"], options)

    def test_pi_requires_an_explicit_model(self):
        with self.assertRaisesRegex(ValueError, "Pi requires"):
            configuration("main", "pi")


class PiRuntimeConfiguration(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.starts = []
        self.stops = []
        self.fail_start = False

        async def start(config):
            if self.fail_start:
                raise RuntimeError("adapter rejected configuration")
            self.starts.append(config)
            runtime = type(
                "Runtime", (), {"runtime_id": str(len(self.starts)), "status": "active"}
            )()

            async def stop():
                self.stops.append(runtime.runtime_id)

            runtime.stop = stop
            return runtime

        self.host = PiHost("main", configuration, start, Path(self.directory.name) / "model.json")

    async def test_provider_collector_reads_host_status_without_mutations(self):
        import importlib.util

        source = Path(__file__).resolve().parents[2] / "crates/nemoclaw-sdk/src/openshell/pi_status.py"
        spec = importlib.util.spec_from_file_location("pi_status", source)
        collector = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(collector)
        socket = str(Path(self.directory.name) / "status.sock")
        requests = []

        async def handle(reader, writer):
            request = json.loads(await reader.readline())
            requests.append(request)
            writer.write(json.dumps(self.host.status()).encode() + b"\n")
            await writer.drain()
            writer.close()
            await writer.wait_closed()

        async with await asyncio.start_unix_server(handle, socket):
            self.assertFalse((await collector.observe(socket))["ready"])
            model = {"model": "custom-model", "piModel": {"nested": [None, 7]}}
            await self.host.configure(model)
            status = await collector.observe(socket)
            self.assertTrue(status["ready"])
            self.assertEqual(status["config"]["models"]["default"]["model"], model["model"])
            self.assertEqual(status["config"]["models"]["default"]["settings"]["model_metadata"], model["piModel"])
            await self.host.stop()
            self.assertFalse((await collector.observe(socket))["ready"])
        self.assertEqual(requests, [{"operation": "check"}] * 3)
        self.assertEqual(len(self.starts), 1)

    async def test_unchanged_apply_keeps_runtime_and_change_stops_before_restart(self):
        first = {"model": "gpt-4o-mini"}
        second = {"model": "gpt-4.1-mini"}
        self.assertFalse(self.host.status()["ready"])
        await self.host.configure(first)
        await self.host.prepare(first)
        await self.host.configure(first)
        self.assertEqual(len(self.starts), 1)
        self.assertEqual(self.stops, [])
        await self.host.prepare(second)
        self.assertFalse(self.host.status()["ready"])
        self.assertEqual(self.stops, ["1"])
        self.assertEqual(len(self.starts), 1)
        await self.host.configure(second)
        self.assertEqual(
            self.host.status()["config"]["models"]["default"]["model"], second["model"]
        )
        self.assertEqual(json.loads(self.host.model_path.read_text()), second)
        self.assertEqual(len(self.starts), 2)

    async def test_client_accepts_configured_inference_and_rejects_drift(self):
        model = {"model": "qwen3:4b"}
        inference = {"api": "openai-completions", "tuning": {}}
        socket = str(Path(self.directory.name) / "fabric.sock")

        async def handle(reader, writer):
            request = json.loads(await reader.readline())
            response = (
                await self.host.configure(request["model"])
                if request["operation"] == "configure"
                else self.host.status()
            )
            writer.write(json.dumps(response).encode() + b"\n")
            await writer.drain()
            writer.close()
            await writer.wait_closed()

        with (
            patch.dict("os.environ", {"NEMOCLAW_INFERENCE_CONFIG": json.dumps(inference)}),
            patch("fabric.SOCKET", socket),
        ):
            async with await asyncio.start_unix_server(handle, socket):
                self.assertEqual(await client("configure", "main", "pi", model, inference), 0)
                self.assertEqual(await client("check", "main", "pi", model, inference), 0)
                drift = {**inference, "tuning": {"maxTokens": 123}}
                self.assertEqual(await client("check", "main", "pi", model, drift), 2)
                self.assertEqual(len(self.starts), 1)

    async def test_client_uses_inference_from_environment_when_argument_is_omitted(self):
        model = {"model": "qwen3:4b"}
        inference = {"api": "openai-completions", "tuning": {}}
        socket = str(Path(self.directory.name) / "fabric.sock")

        async def handle(reader, writer):
            request = json.loads(await reader.readline())
            response = await self.host.configure(request["model"])
            writer.write(json.dumps(response).encode() + b"\n")
            await writer.drain()
            writer.close()
            await writer.wait_closed()

        with (
            patch.dict("os.environ", {"NEMOCLAW_INFERENCE_CONFIG": json.dumps(inference)}),
            patch("fabric.SOCKET", socket),
        ):
            async with await asyncio.start_unix_server(handle, socket):
                self.assertEqual(await client("configure", "main", "pi", model), 0)

    async def test_failed_start_is_not_ready_and_explicit_apply_can_recover(self):
        self.fail_start = True
        with self.assertRaises(RuntimeError):
            await self.host.configure({"model": "custom-model"})
        self.assertFalse(self.host.status()["ready"])
        self.fail_start = False
        await self.host.configure({"model": "custom-model"})
        self.assertTrue(self.host.status()["ready"])

    async def test_failed_stop_cannot_start_an_overlapping_runtime(self):
        await self.host.configure({"model": "gpt-4o-mini"})

        async def fail_stop():
            raise RuntimeError("stop not confirmed")

        self.host.runtime.stop = fail_stop
        for _ in range(2):
            with self.assertRaisesRegex(RuntimeError, "stop not confirmed"):
                await self.host.configure({"model": "gpt-4.1-mini"})
        self.assertFalse(self.host.status()["ready"])
        self.assertEqual(len(self.starts), 1)


if __name__ == "__main__":
    unittest.main()
