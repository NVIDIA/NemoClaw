# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Exercise the packaged OpenClaw lifecycle in an explicitly selected owned image.

Run with network disabled. Native startup and configuration use no inference.
"""

import asyncio
import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fabric import RuntimeHost
from nemo_fabric_adapters.openclaw.adapter import OpenClawRuntime


class OpenClawReconfiguration(unittest.IsolatedAsyncioTestCase):
    async def configure(self, host, config, status="succeeded"):
        response = await host.handle(
            {
                "operation": "configure",
                "agent": "main",
                "config": config,
                "expected_generation": host.snapshot()["generation"],
            }
        )
        self.assertEqual(response["status"], status, response["error"])
        return response

    async def test_owned_process_stops_when_the_sandbox_denies_group_signals(self):
        runtime = OpenClawRuntime()
        runtime.process = await asyncio.create_subprocess_exec(
            sys.executable, "-c", "import time; time.sleep(60)", start_new_session=True
        )
        try:
            with patch("os.killpg", side_effect=PermissionError("sandbox denies group signals")):
                await runtime.stop_gateway()
            self.assertIsNotNone(runtime.process.returncode)
        finally:
            if runtime.process.returncode is None:
                runtime.process.kill()
                await runtime.process.wait()

    async def test_model_and_settings_changes_preserve_native_state_across_host_restarts(self):
        with tempfile.TemporaryDirectory(prefix="nemoclaw-openclaw-reconfigure-") as directory:
            root = Path(directory)
            history = root / "workspace-history.txt"
            history.write_text("retained workspace data")
            config = {
                "metadata": {"name": "main"},
                "harness": {
                    "adapter_id": "nvidia.fabric.openclaw",
                    "settings": {"cli": "/app/openclaw.mjs"},
                },
                "models": {
                    "default": {
                        "provider": "openai",
                        "api": "openai-completions",
                        "model": "stub-a",
                        "base_url": "http://127.0.0.1:9/v1",
                    }
                },
                "environment": {"workspace": directory},
                "runtime": {"artifacts": str(root / "artifacts")},
            }
            host = RuntimeHost("main", root)
            try:
                await self.configure(host, config)
                original_id = host.snapshot()["runtime_id"]
                home = root / ".openclaw"
                retained = home / "retained-channel-state"
                retained.write_text("retained native data")
                changed = copy.deepcopy(config)
                changed["models"]["default"]["model"] = "stub-b"
                await self.configure(host, changed)
                self.assertEqual(host.snapshot()["runtime_state"], "running")
                self.assertNotEqual(host.snapshot()["runtime_id"], original_id)
                native = json.loads((home / "openclaw.json").read_text())
                model = native["models"]["providers"]["fabric_default"]["models"][0]
                self.assertEqual(model["id"], "stub-b")
                changed["models"]["default"]["max_tokens"] = 2048
                changed["tools"] = {"blocked": ["browser"]}
                await self.configure(host, changed)
                native = json.loads((home / "openclaw.json").read_text())
                self.assertEqual(
                    native["models"]["providers"]["fabric_default"]["models"][0]["maxTokens"], 2048
                )
                self.assertEqual(native["agents"]["entries"]["main"]["tools"]["deny"], ["browser"])
                stable_id = host.snapshot()["runtime_id"]
                await self.configure(host, changed)
                self.assertEqual(host.snapshot()["runtime_id"], stable_id)
                await host.stop()
                host = RuntimeHost("main", root)
                await self.configure(host, config)
                self.assertEqual(host.snapshot()["runtime_state"], "running")
                failed = copy.deepcopy(config)
                failed["harness"]["settings"]["cli"] = "/missing/openclaw.mjs"
                response = await self.configure(host, failed, status="failed")
                self.assertEqual(response["error"]["stage"], "start")
                self.assertEqual(response["error"]["code"], "lifecycle_adapter_start_failed")
                self.assertEqual(response["error"]["effects"], "unknown")
                self.assertEqual(response["result"]["runtime_state"], "unknown")
                self.assertIsNone(response["result"]["runtime_id"])
                self.assertIsNone(response["result"]["applied_config"])
                self.assertEqual(history.read_text(), "retained workspace data")
                self.assertEqual(retained.read_text(), "retained native data")
            finally:
                if host.runtime is not None:
                    await host.stop()


if __name__ == "__main__":
    unittest.main()
