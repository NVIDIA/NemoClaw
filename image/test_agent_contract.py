# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Black-box command conformance inside a disposable, network-isolated image."""

import json
import os
import subprocess
import time
import unittest
from pathlib import Path

COMMAND = ["/usr/local/bin/fabric-agent"]
ROOT = Path("/sandbox")
NAME = "contract"
REFERENCE = os.environ.get("NEMOCLAW_TEST_REFERENCE") == "dummy"
CONFIG = {"metadata": {"name": NAME}, "harness": {"adapter_id": "org.nemoclaw.dummy"}}


class AgentContract(unittest.TestCase):
    def setUp(self):
        self.host = None
        self.addCleanup(self.stop_host)

    def stop_host(self):
        if self.host is not None:
            if self.host.poll() is None:
                self.host.terminate()
                try:
                    self.host.wait(timeout=6)
                except subprocess.TimeoutExpired:
                    self.host.kill()
                    self.host.wait(timeout=5)
                    self.fail("serve exceeded its advertised shutdown bound")
            self.host = None

    def start_host(self):
        self.host = subprocess.Popen(
            [*COMMAND, "serve", "--agent", NAME],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        deadline = time.monotonic() + 20
        while not (ROOT / "fabric.sock").exists():
            self.assertIsNone(self.host.poll(), "serve exited before creating its socket")
            if time.monotonic() >= deadline:
                self.fail("serve did not create its socket")
            time.sleep(0.02)
        return self.call("check")["result"]

    def file(self, name, value):
        path = ROOT / name
        path.write_text(json.dumps(value))
        path.chmod(0o600)
        return str(path)

    def call(self, operation, *flags, stdin="PRIVATE_STDIN_MUST_NOT_BE_READ"):
        # Text is written to a pipe; a descriptor, such as a terminal, is attached directly.
        source = {"input": stdin} if isinstance(stdin, str) else {"stdin": stdin}
        output = subprocess.run(
            [*COMMAND, operation, "--agent", NAME, *flags],
            **source,
            capture_output=True,
            text=True,
            timeout=20,
        )
        self.assertEqual(len(output.stdout.splitlines()), 1, output.stdout)
        self.assertTrue(output.stdout.endswith("\n"))
        result = json.loads(output.stdout)
        self.assertEqual(set(result), {"operation", "status", "changed", "result", "error"})
        self.assertEqual(result["operation"], operation)
        self.assertIn(result["status"], ("succeeded", "failed", "unsupported"))
        self.assertEqual(output.returncode, 0 if result["status"] == "succeeded" else 1)
        self.assertNotIn("PRIVATE", output.stdout)
        if result["error"] is not None:
            self.assertEqual(set(result["error"]), {"code", "stage", "message", "effects"})
        return result

    def test_image_advertises_the_same_versioned_contract_as_its_label(self):
        advertised = json.loads(Path("/opt/nemoclaw/bridge.json").read_text())
        self.assertEqual(advertised, json.loads(os.environ["NEMOCLAW_TEST_BRIDGE"]))
        self.assertEqual(advertised["interface_version"], 1)
        self.assertEqual(
            advertised["operations"],
            ["validate", "prepare", "configure", "check", "invoke", "serve"],
        )
        health = advertised["health_checks"]
        self.assertEqual(health, ["live", "active", "ready"][: len(health)])
        self.assertEqual(set(advertised), {"interface_version", "operations", "health_checks"})

    def test_validation_without_a_host_reports_owner_rejection(self):
        config = self.file(
            "invalid.json", {"metadata": {"name": NAME}, "harness": {"adapter_id": 7}}
        )
        result = self.call("validate", "--config", config)
        self.assertEqual(result["status"], "failed")
        self.assertIs(result["result"]["valid"], False)
        self.assertEqual(result["error"]["effects"], "none")
        self.assertFalse(result["changed"])
        self.assertFalse((ROOT / "fabric.sock").exists())

    def test_named_files_flags_and_streaming_reject_without_effects(self):
        config = self.file("input.json", {"stream": True})
        for operation, flags, status in (
            ("check", ["--unknown", "PRIVATE"], "failed"),
            ("check", ["--live", "--ready"], "failed"),
            ("invoke", ["--input", config], "unsupported"),
            ("validate", ["--config", "/does-not-exist-PRIVATE"], "failed"),
        ):
            result = self.call(operation, *flags)
            self.assertEqual(result["status"], status)
            self.assertFalse(result["changed"])
            self.assertEqual(result["error"]["effects"], "none")

    def test_dash_reads_stdin_and_rejects_unusable_stdin_without_effects(self):
        invalid = {"metadata": {"name": NAME}, "harness": {"adapter_id": 7}}
        result = self.call("validate", "--config", "-", stdin=json.dumps(invalid))
        self.assertEqual(result["status"], "failed")
        self.assertIs(result["result"]["valid"], False)
        streamed = self.call("invoke", "--input", "-", stdin=json.dumps({"stream": True}))
        self.assertEqual(streamed["status"], "unsupported")
        controller, terminal = os.openpty()
        self.addCleanup(os.close, controller)
        self.addCleanup(os.close, terminal)
        for stdin in ("PRIVATE", terminal):
            result = self.call("validate", "--config", "-", stdin=stdin)
            self.assertEqual(result["error"]["code"], "invalid_input")
            self.assertEqual(result["error"]["effects"], "none")
            self.assertFalse(result["changed"])

    def test_host_waits_for_configuration_and_retains_state_on_shutdown(self):
        sentinel = ROOT / "retained.txt"
        sentinel.write_text("retained")
        before = self.start_host()
        self.assertEqual(before["runtime_state"], "stopped")
        self.assertIsNone(before["applied_config"])
        self.assertIsNone(before["runtime_id"])
        self.assertTrue(before["generation"])
        for level in ("live", "active", "ready", "operational"):
            result = self.call("check", "--" + level)
            self.assertEqual(result["result"]["generation"], before["generation"])
            self.assertFalse(result["changed"])
            supported = json.loads(Path("/opt/nemoclaw/bridge.json").read_text())["health_checks"]
            if level not in supported:
                self.assertEqual(result["status"], "unsupported")
                self.assertIsNone(result["result"]["health"])
        self.stop_host()
        self.assertFalse((ROOT / "fabric.sock").exists())
        self.assertEqual(sentinel.read_text(), "retained")
        after = self.start_host()
        self.assertNotEqual(after["generation"], before["generation"])
        self.assertEqual(after["runtime_state"], "stopped")

    @unittest.skipUnless(REFERENCE, "successful native lifecycle belongs to adapter qualification")
    def test_reference_validate_configure_check_invoke_prepare_and_generation(self):
        config = self.file("config.json", CONFIG)
        self.assertEqual(self.call("validate", "--config", config)["status"], "succeeded")
        before = self.start_host()
        flags = ["--config", config, "--expected-generation", before["generation"]]
        started = self.call("configure", *flags)
        self.assertTrue(started["changed"])
        state = started["result"]
        self.assertEqual(state["applied_config"], CONFIG)
        self.assertEqual(state["runtime_state"], "running")
        self.assertNotEqual(state["generation"], before["generation"])
        stale = self.call("configure", *flags)
        self.assertEqual(stale["error"]["code"], "stale_generation")
        flags[-1] = state["generation"]
        same = self.call("configure", "--config", "-", *flags[2:], stdin=json.dumps(CONFIG))
        self.assertFalse(same["changed"])
        self.assertEqual(same["result"], state)
        checked = self.call("check", "--ready")
        self.assertEqual(checked["status"], "succeeded")
        self.assertEqual(checked["result"]["runtime_id"], state["runtime_id"])
        self.assertEqual(len(checked["result"]["health"]["checks"]), 3)
        invoked = self.call("invoke", "--input", "-", stdin=json.dumps({"message": "hello"}))
        self.assertIsNone(invoked["changed"])
        self.assertEqual(invoked["result"]["fabric_result"]["output"], {"message": "hello"})
        prepared = self.call("prepare", *flags)
        self.assertTrue(prepared["result"]["prepared"])
        self.assertIsNone(prepared["result"]["applied_config"])
        flags[-1] = prepared["result"]["generation"]
        self.assertFalse(self.call("prepare", *flags)["changed"])

    @unittest.skipUnless(REFERENCE, "reference failure controls are not real adapter settings")
    def test_reference_failed_readiness_preserves_the_configured_runtime(self):
        before = self.start_host()
        config = {**CONFIG, "harness": {**CONFIG["harness"], "settings": {"ready": False}}}
        started = self.call(
            "configure",
            "--config",
            self.file("config.json", config),
            "--expected-generation",
            before["generation"],
        )
        checked = self.call("check", "--ready")
        self.assertEqual(checked["status"], "failed")
        self.assertEqual(checked["error"]["code"], "fabric_health_failed")
        self.assertEqual(checked["result"]["applied_config"], config)
        self.assertEqual(checked["result"]["runtime_id"], started["result"]["runtime_id"])
        self.assertEqual(self.call("check", "--active")["status"], "succeeded")


if __name__ == "__main__":
    unittest.main()
