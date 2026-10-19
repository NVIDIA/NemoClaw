# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Run an agent image's adapter through Fabric's fabric-agent-ctl, offline.

An OpenShell sandbox runs `fabric-agent-ctl serve` from the image's runtime
command, and NemoClaw's provider starts, invokes, and stops one runtime
through it. This suite does the same inside a disposable, network-isolated
container. fabric-agent-ctl's own behavior is Fabric's to test.
"""

import json
import os
import subprocess
import time
import unittest
from pathlib import Path

from qualify_native import local_inference

CTL = "/opt/fabric/bin/fabric-agent-ctl"
ROOT = Path("/sandbox")
NAME = "contract"
REFERENCE = os.environ.get("NEMOCLAW_TEST_REFERENCE") == "dummy"
PROFILE = os.environ.get("NEMOCLAW_TEST_LIFECYCLE") or ("dummy" if REFERENCE else "")


class AgentContract(unittest.TestCase):
    def setUp(self):
        self.host = None
        self.addCleanup(self.stop_host)

    def lifecycle_fixture(self):
        """Return the configuration, input, and expected reply for PROFILE."""
        if not PROFILE:
            self.skipTest("no native lifecycle profile selected")
        if PROFILE == "dummy":
            self.assertTrue(REFERENCE, "dummy profile requires the reference image")
            config = {
                "schema_version": "fabric.agent/v1alpha1",
                "metadata": {"name": NAME},
                "harness": {"adapter_id": "org.nemoclaw.dummy"},
            }
            return config, {"message": "hello"}, "hello"
        self.assertFalse(REFERENCE, "native profile requires a production image")
        inference = self.enterContext(local_inference())
        # Stop the runtime before shutting down its inference dependency.
        self.addCleanup(self.stop_host)
        config = {
            "schema_version": "fabric.agent/v1alpha1",
            "metadata": {"name": NAME},
            "harness": {"adapter_id": "nvidia.fabric." + PROFILE, "settings": {}},
            "models": {
                "default": {
                    "provider": "openai",
                    "model": "gpt-4.1-mini",
                    "api_key_env": "FABRIC_NATIVE_TEST_KEY",
                    "base_url": f"http://127.0.0.1:{inference.server_port}/v1",
                }
            },
        }
        if PROFILE == "pi":
            # Pi needs its wire protocol and limits for a model it does not ship.
            config["models"]["default"].update(
                {"api": "openai-completions", "context_window": 32768, "max_tokens": 1024}
            )
        # Fabric's adapters take the prompt as plain text.
        return config, "Say hello.", "fabric-native-ok"

    def stop_host(self):
        if self.host is not None:
            if self.host.poll() is None:
                self.host.terminate()
                try:
                    self.host.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    self.host.kill()
                    self.host.wait(timeout=5)
            self.host = None

    def start_host(self):
        self.host = subprocess.Popen(
            [CTL, "serve"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        deadline = time.monotonic() + 30
        while not (ROOT / "fabric.sock").exists():
            self.assertIsNone(self.host.poll(), "serve exited before creating its socket")
            if time.monotonic() >= deadline:
                self.fail("serve did not create its socket")
            time.sleep(0.05)

    def call(self, operation, *flags, stdin=None):
        output = subprocess.run(
            [CTL, operation, "--agent", NAME, *flags],
            input=json.dumps(stdin) if stdin is not None else None,
            capture_output=True,
            text=True,
            timeout=300,
        )
        result = json.loads(output.stdout)
        self.assertEqual(result["operation"], operation)
        self.assertEqual(output.returncode, 0 if result["status"] == "succeeded" else 1)
        return result

    def test_one_runtime_starts_answers_and_stops(self):
        config, invocation, expected_reply = self.lifecycle_fixture()
        self.start_host()
        started = self.call("start", "--config", "-", stdin=config)
        self.assertEqual(started["status"], "succeeded", started)
        runtime_id = started["result"]["runtime_id"]

        invoked = self.call("invoke", "--runtime-id", runtime_id, "--input", "-", stdin=invocation)
        self.assertEqual(invoked["status"], "succeeded", invoked)
        self.assertEqual(invoked["result"]["status"], "succeeded", invoked)
        if PROFILE == "dummy":
            self.assertEqual(invoked["result"]["output"], {"message": expected_reply})
        else:
            self.assertIn(expected_reply, json.dumps(invoked["result"]["output"]))

        self.assertEqual(self.call("stop", "--runtime-id", runtime_id)["status"], "succeeded")
        # A sandbox runs one runtime lifecycle; a new one needs a new sandbox.
        again = self.call("start", "--config", "-", stdin=config)
        self.assertEqual(again["error"]["code"], "runtime_exists")


if __name__ == "__main__":
    unittest.main()
