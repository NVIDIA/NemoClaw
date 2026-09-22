# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Qualify the SDK collector against the repository's Pi host implementation."""
import asyncio
import importlib
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "image/fabric"))
pi_tests = importlib.import_module("test_pi_model")


class Collector(pi_tests.PiRuntimeConfiguration):
    async def test_provider_collector_reads_host_status_without_mutations(self):
        import importlib.util

        source = ROOT / "crates/nemoclaw-sdk/src/openshell/pi_status.py"
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


if __name__ == "__main__":
    unittest.main()
