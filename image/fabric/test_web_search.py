# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import openclaw_adapter as adapter
from fabric import configuration
from openclaw_adapter import native_configuration


class WebSearch(unittest.TestCase):
    def test_search_is_granted_only_to_the_unrestricted_agent(self):
        for provider in ("brave", "tavily"):
            with self.subTest(provider=provider):
                self.check_search_grant(provider)

    def check_search_grant(self, provider):
        options = {
            "api": "openai-completions",
            "tuning": {},
            "agents": [{"name": "main"}],
            "webSearch": {
                "provider": provider,
                "agentRefs": ["main"],
                "credential": {"env": "SEARCH_KEY"},
            },
        }
        native = native_configuration("main", options)
        self.assertEqual(
            native["plugins"]["entries"][provider]["config"]["webSearch"]["apiKey"],
            {"source": "env", "provider": "default", "id": f"{provider.upper()}_API_KEY"},
        )
        self.assertEqual(native["tools"]["web"]["search"], {"enabled": True, "provider": provider})
        self.assertEqual(native["plugins"]["allow"], [provider])
        self.assertEqual(native["plugins"]["load"]["paths"], [f"/opt/nemoclaw/plugins/{provider}"])
        self.assertEqual(
            native["agents"]["entries"]["main"]["tools"], {"alsoAllow": ["web_search"]}
        )
        options["agents"][0]["tools"] = {"allow": ["read"]}
        with self.assertRaises(ValueError):
            native_configuration("main", options)

    def test_search_rejects_inline_credentials_and_unknown_providers(self):
        for search in (
            {"provider": "tavily", "agentRefs": ["main"], "credential": {"value": "secret"}},
            {"provider": "../tavily", "agentRefs": ["main"], "credential": {"env": "SEARCH_KEY"}},
        ):
            with self.assertRaises(ValueError):
                native_configuration("main", {"agents": [{"name": "main"}], "webSearch": search})


@unittest.skipUnless(
    os.environ.get("NEMOCLAW_TEST_NATIVE_FEATURES") == "1",
    "requires an owned network-disabled OpenClaw image containing Brave and Tavily",
)
class NativeSearchStartup(unittest.IsolatedAsyncioTestCase):
    async def test_gateway_resolves_placeholder_and_preserves_search_grants(self):
        for provider in ("brave", "tavily"):
            with self.subTest(provider=provider):
                await self.check_startup(provider)

    async def check_startup(self, provider):
        options = {
            "api": "openai-completions",
            "tuning": {},
            "agents": [{"name": "main"}],
            "execution": {"heartbeatEvery": "0m"},
            "webSearch": {
                "provider": provider,
                "agentRefs": ["main"],
                "credential": {"env": "SEARCH_KEY"},
            },
        }
        with (
            tempfile.TemporaryDirectory(dir="/sandbox") as directory,
            patch.object(adapter, "ROOT", Path(directory)),
            patch.dict(os.environ, {f"{provider.upper()}_API_KEY": "fixture-placeholder"}),
        ):
            runtime = adapter.OpenClawRuntime()
            try:
                await runtime.start(
                    {
                        "config": configuration("main", "openclaw", inference=options),
                        "runtime_context": {"runtime_id": "search-fixture"},
                    }
                )
                self.assertTrue(adapter.configuration_matches("main", options))
                self.assertNotIn(
                    "fixture-placeholder", (Path(directory) / "openclaw.json").read_text()
                )
            finally:
                await runtime.stop()
