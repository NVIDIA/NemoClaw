# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Read-only collector contract against an owned local socket."""
import asyncio
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[4]

class Collector(unittest.IsolatedAsyncioTestCase):
    async def test_status_read_does_not_configure_or_invoke(self):
        spec = importlib.util.spec_from_file_location("agent_status", ROOT / "crates/nemoclaw-sdk/src/openshell/agent_status.py")
        collector = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(collector)
        requests = []
        status = {"ready": True, "runtime_id": "fixture", "config": {"harness": {"adapter_id": "org.fixture.future"}}}
        async def handle(reader, writer):
            requests.append(json.loads(await reader.readline()))
            writer.write(json.dumps(status).encode() + b"\n")
            await writer.drain()
            writer.close()
            await writer.wait_closed()
        with tempfile.TemporaryDirectory() as directory:
            socket = str(Path(directory) / "status.sock")
            async with await asyncio.start_unix_server(handle, socket):
                self.assertEqual(await collector.observe(socket), status)
        self.assertEqual(requests, [{"operation": "status"}])

if __name__ == "__main__":
    unittest.main()
