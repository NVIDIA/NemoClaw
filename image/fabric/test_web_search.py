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
    def test_search_is_granted_only_to_selected_unrestricted_agents(self):
        options = {
            "api": "openai-completions",
            "tuning": {},
            "agents": [
                {"name": "main"},
                {"name": "reader", "tools": {"allow": ["read"]}},
                {"name": "writer"},
            ],
            "webSearch": {
                "provider": "brave",
                "agentRefs": ["main"],
                "credential": {"env": "SEARCH_KEY"},
            },
        }
        native = native_configuration("main", options)
        self.assertEqual(
            native["plugins"]["entries"]["brave"]["config"]["webSearch"]["apiKey"],
            {"source": "env", "provider": "default", "id": "BRAVE_API_KEY"},
        )
        self.assertEqual(native["tools"]["web"]["search"], {"enabled": True, "provider": "brave"})
        self.assertEqual(
            native["agents"]["entries"]["main"]["tools"], {"alsoAllow": ["web_search"]}
        )
        self.assertEqual(native["agents"]["entries"]["reader"]["tools"], {"allow": ["read"]})
        self.assertEqual(native["agents"]["entries"]["writer"]["tools"], {"deny": ["web_search"]})
        options["webSearch"]["agentRefs"] = ["reader"]
        with self.assertRaises(ValueError):
            native_configuration("main", options)


@unittest.skipUnless(
    os.environ.get("NEMOCLAW_TEST_NATIVE_FEATURES") == "1",
    "requires an owned network-disabled OpenClaw image containing Brave",
)
class NativeSearchStartup(unittest.IsolatedAsyncioTestCase):
    async def test_gateway_resolves_placeholder_and_preserves_search_grants(self):
        options = {
            "api": "openai-completions",
            "tuning": {},
            "agents": [
                {"name": "main"},
                {"name": "reader", "tools": {"allow": ["read"]}},
                {"name": "writer"},
            ],
            "execution": {"heartbeatEvery": "0m"},
            "webSearch": {
                "provider": "brave",
                "agentRefs": ["main"],
                "credential": {"env": "SEARCH_KEY"},
            },
        }
        with (
            tempfile.TemporaryDirectory(dir="/sandbox") as directory,
            patch.object(adapter, "ROOT", Path(directory)),
            patch.dict(os.environ, {"BRAVE_API_KEY": "fixture-placeholder"}),
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
