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
from nemo_fabric import FabricRuntimeError
from nemo_fabric_adapters.openclaw.adapter import OpenClawRuntime


class OpenClawReconfiguration(unittest.IsolatedAsyncioTestCase):
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
                await host.configure(config)
                original_id = host.status()["runtime_id"]
                home = root / ".openclaw"
                retained = home / "retained-channel-state"
                retained.write_text("retained native data")
                changed = copy.deepcopy(config)
                changed["models"]["default"]["model"] = "stub-b"
                await host.configure(changed)
                self.assertTrue(host.status()["ready"])
                self.assertNotEqual(host.status()["runtime_id"], original_id)
                native = json.loads((home / "openclaw.json").read_text())
                model = native["models"]["providers"]["fabric_default"]["models"][0]
                self.assertEqual(model["id"], "stub-b")
                changed["models"]["default"]["max_tokens"] = 2048
                changed["tools"] = {"blocked": ["browser"]}
                await host.configure(changed)
                native = json.loads((home / "openclaw.json").read_text())
                self.assertEqual(
                    native["models"]["providers"]["fabric_default"]["models"][0]["maxTokens"], 2048
                )
                self.assertEqual(native["agents"]["entries"]["main"]["tools"]["deny"], ["browser"])
                stable_id = host.status()["runtime_id"]
                await host.configure(changed)
                self.assertEqual(host.status()["runtime_id"], stable_id)
                failed = copy.deepcopy(changed)
                failed["harness"]["settings"]["cli"] = "/missing/openclaw.mjs"
                with self.assertRaises(FabricRuntimeError) as failure:
                    await host.configure(failed)
                self.assertEqual(
                    host.failure(failure.exception)["error"],
                    {
                        "stage": "start",
                        "code": "fabric_start_failed",
                        "runtime_state": "unavailable",
                    },
                )
                self.assertFalse(host.status()["ready"])
                await host.configure(changed)
                await host.stop()
                host = RuntimeHost("main", root)
                await host.configure(config)
                self.assertTrue(host.status()["ready"])
                self.assertEqual(history.read_text(), "retained workspace data")
                self.assertEqual(retained.read_text(), "retained native data")
            finally:
                await host.stop()


if __name__ == "__main__":
    unittest.main()
