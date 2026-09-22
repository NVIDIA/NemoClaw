# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import hermes_adapter as adapter
from fabric import configuration, hermes_relay_enabled


class HermesServerConfiguration(unittest.TestCase):
    def test_tavily_keeps_explicit_search_and_extract_selection_without_storing_keys(self):
        inference = {
            "api": "openai-completions",
            "agents": [{"name": "main"}],
            "webSearch": {
                "provider": "tavily",
                "agentRefs": ["main"],
                "credential": {"env": "SEARCH_KEY"},
            },
        }
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            adapter.initialize(inference, home)
            path = home / "config.yaml"
            original = path.read_bytes()
            config = json.loads(original)
            self.assertEqual(
                config["web"],
                {
                    "backend": "tavily",
                    "search_backend": "tavily",
                    "extract_backend": "tavily",
                    "keyless_fallback": False,
                },
            )
            self.assertNotIn("SEARCH_KEY", original.decode())
            self.assertNotIn("TAVILY_API_KEY", original.decode())
            adapter.initialize(inference, home)
            self.assertEqual(path.read_bytes(), original)
            config["web"]["backend"] = "exa"
            path.write_text(json.dumps(config))
            changed = path.read_bytes()
            with self.assertRaises(RuntimeError):
                adapter.initialize(inference, home)
            self.assertEqual(path.read_bytes(), changed)

        for provider, refs in (("brave", ["main"]), ("tavily", ["missing"])):
            inference["webSearch"].update(provider=provider, agentRefs=refs)
            with self.assertRaises(ValueError):
                adapter.native_configuration(inference)

    def test_relay_with_tavily_keeps_native_search_configuration_and_telemetry(self):
        inference = {
            "api": "openai-completions",
            "agents": [{"name": "main"}],
            "webSearch": {
                "provider": "tavily",
                "agentRefs": ["main"],
                "credential": {"env": "SEARCH_KEY"},
            },
            "observability": {"relay": {"enabled": True}},
        }
        config = configuration("main", "hermes", inference=inference)
        self.assertEqual(config["harness"]["adapter_id"], "nemoclaw.local.hermes")
        self.assertEqual(config["harness"]["settings"]["inference"], inference)
        self.assertEqual(config["telemetry"], {"providers": {"relay": {}}})
        self.assertNotIn("max_turns", config["runtime"])
        self.assertEqual(adapter.native_configuration(inference)["approvals"], {"mode": "manual"})

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
    async def test_runtime_owned_health_keeps_credentials_out_of_the_probe(self):
        import asyncio

        import fabric

        inference = {
            "api": "openai-completions",
            "connection": {
                "provider": "openai",
                "model": "primary",
                "base_url": "https://models.example.test/v1",
                "api_key_env": "NEMOCLAW_INFERENCE_TEST_KEY",
            },
            "interfaces": {"dashboard": {"enabled": False}},
            "provider": "test",
            "tuning": {},
        }
        config = fabric.configuration("primary", "hermes", inference=inference)
        with patch.object(adapter, "healthy", return_value=True) as healthy:
            self.assertTrue(await fabric.native_health(config, inference))
            healthy.assert_called_once_with(inference)

        responses = [True, False]

        async def handle(reader, writer):
            self.assertEqual(json.loads(await reader.readline()), {"operation": "check"})
            writer.write(
                json.dumps(
                    {
                        "config": config,
                        "runtime_id": "fixture",
                        "ready": True,
                        "inference": inference,
                        "native_healthy": responses.pop(0),
                    }
                ).encode()
                + b"\n"
            )
            await writer.drain()
            writer.close()
            await writer.wait_closed()

        with tempfile.TemporaryDirectory() as directory:
            socket = str(Path(directory) / "fabric.sock")
            with (
                patch.object(fabric, "SOCKET", socket),
                patch.dict(os.environ, {"NEMOCLAW_INFERENCE_TEST_KEY": ""}),
            ):
                async with await asyncio.start_unix_server(handle, socket):
                    self.assertEqual(
                        await fabric.client("check", "primary", "hermes", inference=inference), 0
                    )
                    self.assertEqual(
                        await fabric.client("check", "primary", "hermes", inference=inference), 2
                    )

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
