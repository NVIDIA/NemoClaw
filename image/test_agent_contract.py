# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Run the reference image's runtime through Fabric's fabric-agent-ctl, offline.

An OpenShell sandbox runs `fabric-agent-ctl serve` from the image's runtime
command, and NemoClaw's provider starts, invokes, and stops one runtime through
it. This suite does the same with NemoClaw's test adapter, inside a disposable,
network-isolated, read-only container. Fabric's runtime and its native adapters
are Fabric's to test.
"""

import json
import subprocess
import time
import unittest
from pathlib import Path

CTL = "/opt/fabric/bin/fabric-agent-ctl"
ROOT = Path("/sandbox")
NAME = "contract"
CONFIG = {
    "schema_version": "fabric.agent/v1alpha1",
    "metadata": {"name": NAME},
    "harness": {"adapter_id": "org.nemoclaw.dummy"},
}


class ReferenceRuntime(unittest.TestCase):
    def setUp(self):
        self.host = None
        self.addCleanup(self.stop_host)

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
            timeout=60,
        )
        result = json.loads(output.stdout)
        self.assertEqual(result["operation"], operation)
        self.assertEqual(output.returncode, 0 if result["status"] == "succeeded" else 1)
        return result

    def test_one_runtime_starts_answers_and_stops(self):
        self.start_host()
        started = self.call("start", "--config", "-", stdin=CONFIG)
        self.assertEqual(started["status"], "succeeded", started)
        runtime_id = started["result"]["runtime_id"]

        invoked = self.call(
            "invoke", "--runtime-id", runtime_id, "--input", "-", stdin={"message": "hello"}
        )
        self.assertEqual(invoked["status"], "succeeded", invoked)
        self.assertEqual(invoked["result"]["status"], "succeeded", invoked)
        self.assertEqual(invoked["result"]["output"], {"message": "hello"})

        self.assertEqual(self.call("stop", "--runtime-id", runtime_id)["status"], "succeeded")


if __name__ == "__main__":
    unittest.main()
