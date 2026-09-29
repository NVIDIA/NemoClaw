# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

import hermes_adapter as adapter
from fabric import configuration, hermes_relay_enabled


class HermesServerConfiguration(unittest.TestCase):
    @staticmethod
    def switchyard_inference(algorithm=None):
        algorithm = algorithm or {
            "kind": "llm-classifier",
            "classifierRoute": "judge",
            "weakRoute": "weak",
            "strongRoute": "strong",
            "baseThreshold": 0.5,
            "thresholdStep": 0.1,
        }
        models = {
            name: {
                "provider": f"sandbox-{name}",
                "connection": {
                    "provider": "openai",
                    "model": f"provider/{name}",
                    "base_url": f"https://{name}.example/v1",
                    "api_key_env": f"NEMOCLAW_INFERENCE_{name.upper()}_KEY",
                },
                "api": "openai-completions",
                "tuning": {},
            }
            for name in ("judge", "weak", "strong")
        }
        return {
            **models["weak"],
            "agents": [
                {
                    "name": "main",
                    "inference": {"default": "weak", "models": models},
                }
            ],
            "routing": {
                "kind": "switchyard",
                "routeId": "smart",
                "algorithm": algorithm,
            },
        }

    def test_fabric_selects_owned_native_server(self):
        config = configuration("main", "hermes")
        self.assertEqual(config["harness"]["adapter_id"], "nemoclaw.local.hermes")
        self.assertEqual(config["harness"]["settings"]["agent_name"], "main")

    def test_relay_tracing_selects_upstream_adapter_without_sidecar(self):
        inference = {
            "api": "openai-completions",
            "tuning": {},
            "observability": {"relay": {"enabled": True}},
        }
        config = configuration("main", "hermes", inference=inference)
        self.assertEqual(config["harness"]["adapter_id"], "nvidia.fabric.hermes")
        self.assertNotIn("discovery", config)
        self.assertNotIn("agent_name", config["harness"]["settings"])
        self.assertEqual(config["harness"]["settings"]["api_mode"], "chat_completions")
        self.assertEqual(config["telemetry"], {"providers": {"relay": {}}})
        self.assertEqual(config["relay"]["project"], "main")
        self.assertEqual(config["relay"]["output_dir"], "/sandbox/artifacts/relay")
        self.assertTrue(config["relay"]["observability"]["atof"]["enabled"])
        self.assertTrue(config["relay"]["observability"]["atif"]["enabled"])
        self.assertFalse(config["relay"]["observability"]["enable_full_payloads"])

    def test_relay_tracing_rejects_ambiguous_configuration(self):
        self.assertFalse(hermes_relay_enabled(None))
        for inference in (
            {"observability": {"relay": {"enabled": False}}},
            {"observability": {"relay": {"enabled": True}, "otlp": {}}},
        ):
            with self.assertRaises(ValueError):
                configuration("main", "hermes", inference=inference)

    def test_relay_with_interfaces_keeps_native_server_and_telemetry(self):
        inference = {
            "api": "openai-completions",
            "observability": {"relay": {"enabled": True}},
            "interfaces": {"dashboard": {"enabled": False}},
        }
        config = configuration("main", "hermes", inference=inference)
        self.assertEqual(config["harness"]["adapter_id"], "nemoclaw.local.hermes")
        self.assertEqual(config["harness"]["settings"]["inference"], inference)
        self.assertNotIn("max_turns", config["runtime"])
        self.assertEqual(config["telemetry"], {"providers": {"relay": {}}})

    def test_switchyard_uses_the_owned_hermes_adapter_and_a_fail_closed_model(self):
        inference = self.switchyard_inference()
        config = configuration("main", "hermes", inference=inference)
        self.assertEqual(config["harness"]["adapter_id"], "nemoclaw.local.hermes")
        self.assertEqual(config["harness"]["settings"]["inference"], inference)
        self.assertEqual(config["models"]["default"]["model"], "switchyard/smart")
        self.assertEqual(config["models"]["default"]["base_url"], "http://127.0.0.1:1/v1")
        self.assertEqual(config["models"]["default"]["api_key_env"], "OPENAI_API_KEY")
        self.assertEqual(config["telemetry"], {"providers": {"relay": {}}})

    def test_switchyard_classifier_maps_named_routes_to_the_released_v1_schema(self):
        deployment = adapter.switchyard_deployment(self.switchyard_inference())
        self.assertEqual(deployment["schema_version"], 1)
        self.assertEqual(
            deployment["llm_clients"]["judge"],
            {
                "format": "openai_chat",
                "base_url": "https://judge.example/v1",
                "api_key_env": "NEMOCLAW_INFERENCE_JUDGE_KEY",
                "max_retries": 0,
                "timeout_ms": 300000,
            },
        )
        self.assertEqual(
            deployment["targets"]["strong"],
            {"id": "provider/strong", "llm_client": "strong"},
        )
        self.assertEqual(
            deployment["routes"]["smart"],
            {
                "id": "switchyard/smart",
                "type": "llm_classifier",
                "mode": "capability",
                "classifier_target": "judge",
                "weak_target": "weak",
                "strong_target": "strong",
                "base_threshold": 0.5,
                "threshold_step": 0.1,
            },
        )
        self.assertNotIn("credential", json.dumps(deployment).lower())

    def test_switchyard_seeded_weighted_random_preserves_weights(self):
        inference = self.switchyard_inference(
            {
                "kind": "weighted-random",
                "seed": 42,
                "targets": [
                    {"routeRef": "weak", "weight": 7},
                    {"routeRef": "strong", "weight": 3},
                ],
            }
        )
        deployment = adapter.switchyard_deployment(inference)
        self.assertEqual(
            deployment["routes"]["smart"],
            {
                "id": "switchyard/smart",
                "type": "random",
                "targets": ["weak", "strong"],
                "weights": [7, 3],
                "seed": 42,
            },
        )
        self.assertNotIn("judge", deployment["llm_clients"])

    def test_switchyard_plugin_document_is_manifest_backed_and_startup_required(self):
        self.assertEqual(
            adapter.switchyard_plugin_configuration(Path("/run/nemoclaw/switchyard.toml")),
            {
                "version": 1,
                "plugins": {
                    "policy": {
                        "overrides": {
                            "nvidia.switchyard": {
                                "startup": "required",
                                "attestation": "integrity_only",
                            }
                        }
                    },
                    "dynamic": [
                        {
                            "manifest": "/opt/nemoclaw/switchyard-plugin/relay-plugin.toml",
                            "config": {
                                "priority": 0,
                                "switchyard_config_path": "/run/nemoclaw/switchyard.toml",
                            },
                        }
                    ],
                },
            },
        )

    def test_switchyard_readiness_requires_active_hermes_managed_execution(self):
        relay_runtime = types.ModuleType("agent.relay_runtime")
        agent = types.ModuleType("agent")
        runtime = types.SimpleNamespace(managed_execution_enabled=lambda: False)
        relay_runtime.get_runtime = lambda: runtime
        with (
            patch.dict(
                sys.modules,
                {"agent": agent, "agent.relay_runtime": relay_runtime},
            ),
            self.assertRaisesRegex(RuntimeError, "Switchyard Relay plugin is not active"),
        ):
            adapter.require_switchyard_relay(True)
        runtime.managed_execution_enabled = lambda: True
        with patch.dict(
            sys.modules,
            {"agent": agent, "agent.relay_runtime": relay_runtime},
        ):
            adapter.require_switchyard_relay(True)

    def test_switchyard_writes_two_private_files_and_rejects_retained_drift(self):
        import tomllib

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            relay_plugins = root / "relay.toml"
            relay_plugins.write_text(
                'version = 1\n\n[[components]]\nkind = "observability"\nenabled = true\n'
            )
            plugins_path = adapter.write_switchyard_plugin_config(
                self.switchyard_inference(), relay_plugins, root
            )
            deployment_path = root / "nemoclaw-switchyard/switchyard.toml"
            with plugins_path.open("rb") as source:
                plugins = tomllib.load(source)
            with deployment_path.open("rb") as source:
                deployment = tomllib.load(source)
            self.assertEqual(
                plugins["plugins"]["dynamic"][0]["config"]["switchyard_config_path"],
                str(deployment_path),
            )
            self.assertEqual(
                deployment,
                adapter.switchyard_deployment(self.switchyard_inference()),
            )
            self.assertEqual(plugins_path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(deployment_path.stat().st_mode & 0o777, 0o600)
            adapter.write_switchyard_plugin_config(self.switchyard_inference(), relay_plugins, root)
            deployment_path.write_text("schema_version = 1\n")
            with self.assertRaisesRegex(RuntimeError, "conflicts with deployment intent"):
                adapter.write_switchyard_plugin_config(
                    self.switchyard_inference(), relay_plugins, root
                )

    def test_retained_configuration_and_credential_reject_drift(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(adapter, "ROOT", Path(directory)),
        ):
            adapter.initialize(None)
            original = adapter.token(Path(directory))
            adapter.initialize(None)
            self.assertEqual(original, adapter.token(Path(directory)))
            p = Path(directory) / "config.yaml"
            config = json.loads(p.read_text())
            config["model"]["base_url"] = "https://unexpected.invalid"
            p.write_text(json.dumps(config))
            before = p.read_bytes()
            with self.assertRaises(RuntimeError):
                adapter.initialize(None)
            self.assertEqual(before, p.read_bytes())


class HermesInvocation(unittest.IsolatedAsyncioTestCase):
    async def test_uncertain_response_stops_runtime_and_is_never_replayed(self):
        from types import SimpleNamespace
        from unittest.mock import AsyncMock

        runtime = adapter.HermesRuntime()
        runtime.runtime_id = "fixture"
        runtime.inference = None
        runtime.process = SimpleNamespace(returncode=None)
        runtime.stop = AsyncMock()
        with (
            patch.object(adapter, "configuration_matches", return_value=True),
            patch.object(adapter, "api_request", side_effect=TimeoutError) as request,
        ):
            result = await runtime.invoke(
                SimpleNamespace(input="hello"), SimpleNamespace(runtime_id="fixture")
            )
            self.assertEqual(str(result.status), "failed")
            runtime.stop.assert_awaited_once()
            with self.assertRaises(RuntimeError):
                await runtime.invoke(
                    SimpleNamespace(input="hello"), SimpleNamespace(runtime_id="fixture")
                )
            self.assertEqual(request.call_count, 1)


class HermesInterfaces(unittest.TestCase):
    def test_default_and_explicit_native_services_are_distinct(self):
        defaults = adapter.interface_settings(None)
        self.assertEqual(
            defaults,
            {
                "apiPort": 8642,
                "dashboard": {
                    "enabled": True,
                    "port": 18789,
                    "internalPort": 19119,
                    "tui": {"enabled": True},
                },
            },
        )
        settings = adapter.interface_settings(
            {"interfaces": {"api": {"port": 8643}, "dashboard": {"enabled": False}}}
        )
        self.assertEqual(settings["apiPort"], 8643)
        self.assertFalse(settings["dashboard"]["enabled"])


class HermesLocalTransport(unittest.TestCase):
    def test_local_api_credentials_bypass_configured_egress_proxy(self):
        import http.server
        import os
        import threading

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"data":[{"id":"primary"}]}')

            def log_message(self, *_args):
                pass

        with http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                with (
                    tempfile.TemporaryDirectory() as directory,
                    patch.object(adapter, "ROOT", Path(directory)),
                ):
                    adapter.initialize(None)
                    with patch.dict(
                        os.environ,
                        {
                            "http_proxy": "http://127.0.0.1:1",
                            "HTTP_PROXY": "http://127.0.0.1:1",
                            "no_proxy": "",
                            "NO_PROXY": "",
                        },
                    ):
                        self.assertEqual(
                            adapter.api_request("/v1/models", port=server.server_port)["data"][0][
                                "id"
                            ],
                            "primary",
                        )
            finally:
                server.shutdown()
                thread.join()


if __name__ == "__main__":
    unittest.main()
