# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Run the dummy reference agent through Fabric's own fabric-agent-ctl.

The reference image installs NemoClaw's test-only adapter into Fabric. These
tests start a real fabric-agent-ctl server, as an OpenShell sandbox does, and
drive it as NemoClaw's provider does. They cover the test adapter and its
packaging; fabric-agent-ctl's own behavior is Fabric's to test.
"""

import json
import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

CTL = "/opt/fabric/bin/fabric-agent-ctl"
AGENT = "main"


def config(**settings):
    harness = {"adapter_id": "org.nemoclaw.dummy"}
    if settings:
        harness["settings"] = settings
    return {
        "schema_version": "fabric.agent/v1alpha1",
        "metadata": {"name": AGENT},
        "harness": harness,
    }


@unittest.skipUnless(os.environ.get("NEMOCLAW_REFERENCE_TESTS"), "runs in the reference image only")
class ReferenceAgent(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        socket = Path(self.directory.name) / "fabric.sock"
        self.environment = {**os.environ, "FABRIC_HOST_SOCKET": str(socket)}
        self.server = subprocess.Popen(
            [CTL, "serve"],
            env=self.environment,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        self.addCleanup(self.stop_server)
        deadline = time.monotonic() + 30
        while not socket.exists():
            if self.server.poll() is not None or time.monotonic() > deadline:
                self.fail("fabric-agent-ctl serve did not create its socket")
            time.sleep(0.05)

    def stop_server(self):
        self.server.terminate()
        try:
            self.server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.server.kill()
            self.server.wait()

    def ctl(self, *arguments, stdin=None):
        completed = subprocess.run(
            [CTL, *arguments],
            env=self.environment,
            input=json.dumps(stdin).encode() if stdin is not None else None,
            capture_output=True,
            timeout=120,
        )
        envelope = json.loads(completed.stdout)
        self.assertEqual(completed.returncode, 0 if envelope["status"] == "succeeded" else 1)
        return envelope

    def start(self, agent_config):
        return self.ctl("start", "--agent", AGENT, "--config", "-", stdin=agent_config)

    def invoke(self, runtime_id, value):
        return self.ctl(
            "invoke", "--agent", AGENT, "--runtime-id", runtime_id, "--input", "-", stdin=value
        )

    def stop(self, runtime_id):
        return self.ctl("stop", "--agent", AGENT, "--runtime-id", runtime_id)

    def test_echoes_invocations_until_stopped(self):
        started = self.start(config())
        self.assertEqual(started["status"], "succeeded", started["error"])
        self.assertEqual(started["result"]["adapter_id"], "org.nemoclaw.dummy")
        runtime_id = started["result"]["runtime_id"]

        text = self.invoke(runtime_id, "hello")
        self.assertEqual(text["status"], "succeeded", text["error"])
        self.assertEqual(text["result"]["status"], "succeeded")
        self.assertEqual(text["result"]["output"], {"message": "hello"})
        message = self.invoke(runtime_id, {"message": "again"})
        self.assertEqual(message["result"]["output"], {"message": "again"})
        failed = self.invoke(runtime_id, {"fail": True})
        self.assertEqual(failed["result"]["status"], "failed")
        self.assertEqual(failed["result"]["error"]["code"], "dummy_invocation_failed")

        self.assertEqual(self.stop(runtime_id)["status"], "succeeded")
        # Fabric's server starts another runtime once the previous one stops.
        restarted = self.start(config())
        self.assertEqual(restarted["status"], "succeeded", restarted["error"])
        self.assertNotEqual(restarted["result"]["runtime_id"], runtime_id)

    def test_replies_with_the_configured_text(self):
        runtime_id = self.start(config(reply="fixed"))["result"]["runtime_id"]
        self.assertEqual(self.invoke(runtime_id, "hello")["result"]["output"], {"message": "fixed"})

    def test_fabric_validates_settings_against_the_descriptor(self):
        response = self.start(config(unknown=True))
        self.assertEqual(response["status"], "failed")
        self.assertEqual(response["error"]["code"], "validation_failed")
        self.assertEqual(response["error"]["effects"], "none")

    def test_reports_a_failed_start(self):
        response = self.start(config(fail_start=True))
        self.assertEqual(response["status"], "failed")
        self.assertEqual(response["error"]["code"], "start_failed")

    def test_reports_a_failed_stop(self):
        runtime_id = self.start(config(fail_stop=True))["result"]["runtime_id"]
        response = self.stop(runtime_id)
        self.assertEqual(response["status"], "failed")
        self.assertEqual(response["error"]["code"], "stop_failed")


if __name__ == "__main__":
    unittest.main()
