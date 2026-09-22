# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
import copy
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import openclaw_adapter as adapter
from fabric import configuration
from test_openclaw_adapter import FakeRuntime


class ExecutionConfiguration(unittest.TestCase):
    def test_default_timeout_and_native_heartbeat(self):
        config = adapter.native_configuration("main")
        self.assertEqual(config["models"]["providers"]["openshell"]["timeoutSeconds"], 600)
        native = config["agents"]["defaults"]
        self.assertEqual(native["timeoutSeconds"], 600)
        self.assertNotIn("heartbeat", native)
        self.assertEqual(configuration("main", "openclaw")["runtime"]["timeout_seconds"], 660)
        self.assertEqual(configuration("main", "deepagents")["runtime"]["timeout_seconds"], 300)

    def test_other_harnesses_receive_fabric_timeout_without_heartbeat(self):
        for harness in ("deepagents", "hermes", "pi", "claude", "codex"):
            options = {"api": "openai-completions", "execution": {"timeoutSeconds": 45}}
            config = configuration("main", harness, {"model": "custom"}, inference=options)
            self.assertEqual(config["runtime"]["timeout_seconds"], 45)
            options["execution"]["heartbeatEvery"] = "1m"
            with self.assertRaises(ValueError):
                configuration("main", harness, {"model": "custom"}, inference=options)

    def test_execution_and_default_drift_never_overwrite_native_state(self):
        for execution in [
            None,
            {"timeoutSeconds": 900},
            {"heartbeatEvery": "30m"},
            {"heartbeatEvery": "0m"},
        ]:
            options = {"api": "openai-completions", "tuning": {}}
            if execution is not None:
                options["execution"] = execution
            with (
                tempfile.TemporaryDirectory() as directory,
                patch.object(adapter, "ROOT", Path(directory)),
            ):
                runtime = adapter.OpenClawRuntime()
                runtime.name, runtime.home, runtime.inference = "main", Path(directory), options
                runtime.initialize_configuration()
                path = Path(directory) / "openclaw.json"
                original = json.loads(path.read_text())
                defaults = original["agents"]["defaults"]
                timeout = (execution or {}).get("timeoutSeconds", 600)
                self.assertEqual(defaults["timeoutSeconds"], timeout)
                self.assertEqual(
                    original["models"]["providers"]["openshell"]["timeoutSeconds"], timeout
                )
                self.assertEqual(
                    configuration("main", "openclaw", inference=options)["runtime"][
                        "timeout_seconds"
                    ],
                    timeout + 60,
                )
                if execution and "heartbeatEvery" in execution:
                    self.assertEqual(
                        defaults["heartbeat"],
                        {"every": execution["heartbeatEvery"], "isolatedSession": True},
                    )
                else:
                    self.assertNotIn("heartbeat", defaults)
                self.assertTrue(adapter.configuration_matches("main", options))
                for key, changed in [
                    ("timeoutSeconds", timeout + 1),
                    ("heartbeat", {"every": "1s"}),
                ]:
                    drift = copy.deepcopy(original)
                    drift["agents"]["defaults"][key] = changed
                    path.write_text(json.dumps(drift))
                    before = path.read_bytes()
                    self.assertFalse(adapter.configuration_matches("main", options))
                    with self.assertRaises(RuntimeError):
                        runtime.initialize_configuration()
                    self.assertEqual(path.read_bytes(), before)
                drift = copy.deepcopy(original)
                drift["models"]["providers"]["openshell"]["timeoutSeconds"] = timeout + 1
                path.write_text(json.dumps(drift))
                before = path.read_bytes()
                self.assertFalse(adapter.configuration_matches("main", options))
                with self.assertRaises(RuntimeError):
                    runtime.initialize_configuration()
                self.assertEqual(path.read_bytes(), before)


class ExecutionInvocation(unittest.IsolatedAsyncioTestCase):
    async def test_configured_timeout_reaches_agent_request_and_rpc_wait(self):
        for execution in [None, {"timeoutSeconds": 900}]:
            runtime = FakeRuntime({"status": "ok", "result": {}})
            runtime.inference = {"api": "openai-completions", "tuning": {}}
            if execution is not None:
                runtime.inference["execution"] = execution
            timeouts = []
            rpc = runtime.rpc

            async def recording_rpc(method, params, timeout=280, *, calls=timeouts, invoke=rpc):
                calls.append(timeout)
                return await invoke(method, params, timeout)

            runtime.rpc = recording_rpc
            with patch.object(adapter, "configuration_matches", return_value=True):
                await runtime.invoke(
                    SimpleNamespace(input="hello"),
                    SimpleNamespace(runtime_id="runtime-test", invocation_id="turn-one"),
                )
            seconds = (execution or {}).get("timeoutSeconds", 600)
            self.assertEqual(runtime.calls[0][1]["timeout"], seconds)
            self.assertEqual(timeouts, [seconds + 20, 15])


@unittest.skipUnless(
    os.environ.get("NEMOCLAW_TEST_NATIVE_EXECUTION") == "1",
    "requires an explicitly selected disposable OpenClaw container",
)
class NativeExecution(unittest.IsolatedAsyncioTestCase):
    async def test_native_defaults_and_explicit_execution_survive_gateway_restart(self):
        # Resolve the generated settings with the pinned runtime's own functions.
        resolver = """
import fs from 'node:fs';
const modulePath = prefix => '/app/dist/' + fs.readdirSync('/app/dist').find(f => f.startsWith(prefix) && f.endsWith('.mjs'));
const { n: timeout } = await import(modulePath('timeout-'));
const { i: heartbeat } = await import(modulePath('heartbeat-config-'));
const cfg = JSON.parse(fs.readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify([timeout({cfg}), heartbeat(cfg)]));
"""
        for execution, expected in [
            (None, [600000, 1800000]),
            ({"timeoutSeconds": 900, "heartbeatEvery": "0m"}, [900000, None]),
            ({"heartbeatEvery": "1h"}, [600000, 3600000]),
        ]:
            options = {"api": "openai-completions", "tuning": {}}
            if execution is not None:
                options["execution"] = execution
            native = adapter.native_configuration("main", options)
            result = subprocess.run(
                [adapter.NODE, "--input-type=module", "-e", resolver],
                input=json.dumps(native),
                text=True,
                capture_output=True,
                check=True,
                timeout=15,
            )
            self.assertEqual(json.loads(result.stdout), expected)
            with (
                tempfile.TemporaryDirectory(dir="/sandbox") as directory,
                patch.object(adapter, "ROOT", Path(directory)),
            ):
                for runtime_id in ["execution-first", "execution-restarted"]:
                    runtime = adapter.OpenClawRuntime()
                    try:
                        await runtime.start(
                            {
                                "config": configuration("main", "openclaw", inference=options),
                                "runtime_context": {"runtime_id": runtime_id},
                            }
                        )
                        self.assertTrue(adapter.healthy("main", runtime_id, options))
                        actual = json.loads((Path(directory) / "openclaw.json").read_text())
                        self.assertEqual(actual["agents"]["defaults"], native["agents"]["defaults"])
                    finally:
                        await runtime.stop()


class NativeToolConfiguration(unittest.TestCase):
    def test_read_policy_uses_each_adapters_native_tool_name(self):
        for harness, tool in (("deepagents", "read_file"), ("pi", "read")):
            route = {
                "connection": {
                    "provider": "openai",
                    "base_url": "http://127.0.0.1:8000/v1",
                    "model": "custom",
                    "api_key_env": "NEMOCLAW_ANONYMOUS_API_KEY",
                },
                "pi": {"model": "custom"},
            }
            inference = {
                "api": "openai-completions",
                "agents": [
                    {
                        "name": "main",
                        "tools": {"allow": ["read"]},
                        "inference": {"default": "primary", "models": {"primary": route}},
                    }
                ],
            }
            config = configuration("main", harness, {"model": "custom"}, inference)
            self.assertEqual(config["tools"], {"enabled": [tool]})
            inference["agents"][0]["tools"] = {"disclosure": "direct"}
            with self.assertRaises(ValueError):
                configuration("main", harness, {"model": "custom"}, inference)


if __name__ == "__main__":
    unittest.main()
