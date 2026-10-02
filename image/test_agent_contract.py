# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Black-box command conformance inside a disposable, network-isolated image."""

import json
import os
import subprocess
import time
import unittest
from pathlib import Path

from qualify_native import local_inference

COMMAND = ["/usr/local/bin/fabric-agent"]
ROOT = Path("/sandbox")
NAME = "contract"
REFERENCE = os.environ.get("NEMOCLAW_TEST_REFERENCE") == "dummy"
CONFIG = {"metadata": {"name": NAME}, "harness": {"adapter_id": "org.nemoclaw.dummy"}}
PROFILE = os.environ.get("NEMOCLAW_TEST_LIFECYCLE") or ("dummy" if REFERENCE else "")


class AgentContract(unittest.TestCase):
    def setUp(self):
        self.host = None
        self.addCleanup(self.stop_host)

    def lifecycle_fixture(self):
        if not PROFILE:
            self.skipTest("no native lifecycle profile selected; command conformance only")
        if PROFILE == "dummy":
            self.assertTrue(REFERENCE, "dummy profile requires the reference image")
            return CONFIG, {"message": "hello"}, "hello", None
        self.assertFalse(REFERENCE, "native profile requires a production image")
        settings = {
            "openclaw": {"cli": "/app/openclaw.mjs"},
            "hermes": {"mode": "service"},
            "pi": {},
        }[PROFILE]
        inference = self.enterContext(local_inference())
        # Stop the runtime before shutting down its inference dependency.
        self.addCleanup(self.stop_host)
        config = {
            "metadata": {"name": NAME},
            "harness": {"adapter_id": "nvidia.fabric." + PROFILE, "settings": settings},
            "models": {
                "default": {
                    "provider": "openai",
                    "api": "openai-completions",
                    "model": "gpt-4.1-mini",
                    "api_key_env": "FABRIC_NATIVE_TEST_KEY",
                    "base_url": f"http://127.0.0.1:{inference.server_port}/v1",
                }
            },
        }
        prompt = "Say hello."
        invocation = (
            {"agent": "main", "message": prompt}
            if PROFILE == "openclaw"
            else {"prompt": prompt, "model": "default"}
            if PROFILE == "pi"
            else prompt
        )
        return config, invocation, "fabric-native-ok", inference

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
            timeout=90 if operation in ("configure", "invoke") else 20,
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
        self.assertEqual(advertised["input_sources"], ["file", "stdin"])

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

    def test_validate_configure_invoke_prepare_and_generation(self):
        configuration, invocation, expected_reply, inference = self.lifecycle_fixture()
        config = self.file("config.json", configuration)
        self.assertEqual(self.call("validate", "--config", config)["status"], "succeeded")
        before = self.start_host()
        flags = ["--config", config, "--expected-generation", before["generation"]]
        started = self.call("configure", *flags)
        self.assertEqual(started["status"], "succeeded", started)
        self.assertTrue(started["changed"])
        state = started["result"]
        self.assertEqual(state["applied_config"], configuration)
        self.assertEqual(state["runtime_state"], "running")
        self.assertNotEqual(state["generation"], before["generation"])
        stale = self.call("configure", *flags)
        self.assertEqual(stale["error"]["code"], "stale_generation")
        flags[-1] = state["generation"]
        same = self.call("configure", "--config", "-", *flags[2:], stdin=json.dumps(configuration))
        self.assertFalse(same["changed"])
        self.assertEqual(same["result"], state)
        checked = self.call("check", "--ready")
        supported = json.loads(Path("/opt/nemoclaw/bridge.json").read_text())["health_checks"]
        self.assertEqual(checked["status"], "succeeded" if "ready" in supported else "unsupported")
        for key, value in state.items():
            self.assertEqual(checked["result"][key], value)
        if "ready" not in supported:
            self.assertIsNone(checked["result"]["health"])
            self.assertEqual(checked["error"]["code"], "fabric_health_unsupported")
        if inference is not None:
            self.assertEqual(inference.requests, [], "configure must not request inference")
        for use_stdin in (False, True):
            before = len(inference.requests) if inference is not None else 0
            invoked = (
                self.call("invoke", "--input", "-", stdin=json.dumps(invocation))
                if use_stdin
                else self.call("invoke", "--input", self.file("invocation.json", invocation))
            )
            self.assertEqual(invoked["status"], "succeeded", invoked)
            self.assertIsNone(invoked["changed"])
            self.assertEqual(invoked["result"]["runtime_id"], state["runtime_id"])
            native = invoked["result"]["fabric_result"]
            self.assertEqual(native["status"], "succeeded")
            self.assertIn(expected_reply, json.dumps(native["output"]))
            if REFERENCE:
                self.assertEqual(native["output"], {"message": expected_reply})
            if inference is not None:
                self.assertGreater(len(inference.requests), before, "native inference was bypassed")
        prepared = self.call("prepare", *flags)
        self.assertEqual(prepared["status"], "succeeded", prepared)
        self.assertTrue(prepared["result"]["prepared"])
        self.assertIsNone(prepared["result"]["applied_config"])
        flags[-1] = prepared["result"]["generation"]
        self.assertFalse(self.call("prepare", *flags)["changed"])
        self.assertEqual(
            self.call("invoke", "--input", "-", stdin=json.dumps(invocation))["status"], "failed"
        )

    def test_configured_runtime_is_ready(self):
        supported = json.loads(Path("/opt/nemoclaw/bridge.json").read_text())["health_checks"]
        if os.environ.get("NEMOCLAW_TEST_REQUIRE_READY") == "1":
            self.assertIn("ready", supported, "selected image cannot qualify native readiness")
        elif "ready" not in supported:
            self.skipTest("native readiness is unsupported; lifecycle success does not qualify it")
        configuration, _, _, _ = self.lifecycle_fixture()
        before = self.start_host()
        started = self.call(
            "configure",
            "--config",
            "-",
            "--expected-generation",
            before["generation"],
            stdin=json.dumps(configuration),
        )
        self.assertEqual(started["status"], "succeeded", started)
        checked = self.call("check", "--ready")
        self.assertEqual(checked["status"], "succeeded", checked)
        self.assertEqual(checked["result"]["runtime_id"], started["result"]["runtime_id"])
        self.assertIsInstance(checked["result"]["health"], dict)
        if REFERENCE:
            self.assertEqual(len(checked["result"]["health"]["checks"]), 3)

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
