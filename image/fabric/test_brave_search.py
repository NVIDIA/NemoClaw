# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
import importlib.util
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from brave_search import web_search
from fabric import configuration, configuration_matches


class BraveSearch(unittest.TestCase):
    def test_only_attached_deep_agent_receives_the_mcp_tool(self):
        inference = {
            "api": "openai-completions",
            "webSearch": {"agentRefs": ["main"]},
            "agents": [{"name": "main"}],
        }
        with patch.dict("os.environ", {"BRAVE_API_KEY": "placeholder"}):
            config = configuration("main", "deepagents", inference=inference)
            self.assertEqual(
                config["mcp"]["servers"]["brave"]["env"]["BRAVE_API_KEY"], "placeholder"
            )
            inference.pop("webSearch")
            self.assertNotIn("mcp", configuration("main", "deepagents", inference=inference))

    def test_refresh_compares_credential_references_not_snapshot_revisions(self):
        inference = {
            "api": "openai-completions",
            "webSearch": {"agentRefs": ["main"]},
            "agents": [{"name": "main"}],
        }
        with patch.dict("os.environ", {"BRAVE_API_KEY": "openshell:resolve:env:v1_BRAVE_API_KEY"}):
            hosted = configuration("main", "deepagents", inference=inference)
        with patch.dict("os.environ", {"BRAVE_API_KEY": "openshell:resolve:env:v2_BRAVE_API_KEY"}):
            expected = configuration("main", "deepagents", inference=inference)
        self.assertTrue(configuration_matches(hosted, expected))
        for wrong in ("openshell:resolve:env:v2_OTHER_KEY", "plain-key"):
            hosted["mcp"]["servers"]["brave"]["env"]["BRAVE_API_KEY"] = wrong
            self.assertFalse(configuration_matches(hosted, expected))

    def test_request_is_bounded_and_credentials_are_not_error_details(self):
        response = MagicMock()
        response.iter_bytes.return_value = [b'{"web":{"results":[]}}']
        stream = MagicMock()
        with (
            patch.dict("os.environ", {"BRAVE_API_KEY": "placeholder"}),
            patch.dict("sys.modules", {"httpx": SimpleNamespace(stream=stream)}),
        ):
            stream.return_value.__enter__.return_value = response
            self.assertEqual(web_search("question"), {"web": {"results": []}})
            self.assertFalse(stream.call_args.kwargs["follow_redirects"])
            self.assertEqual(
                stream.call_args.kwargs["headers"]["X-Subscription-Token"], "placeholder"
            )
            for chunks in ([b"x" * (1024 * 1024 + 1)], [b"[]"], [b"not json"]):
                response.iter_bytes.return_value = chunks
                with self.assertRaisesRegex(RuntimeError, "Brave search failed"):
                    web_search("question")
            response.raise_for_status.side_effect = RuntimeError("secret response")
            with self.assertRaisesRegex(
                RuntimeError, "^Brave search failed; check the integration credential and service$"
            ):
                web_search("question")
        for query, count in [("", 5), ("x", 0), ("x", True), ("x" * 2049, 1)]:
            with self.assertRaises(ValueError):
                web_search(query, count)


@unittest.skipUnless(
    importlib.util.find_spec("langchain_mcp_adapters"), "requires Deep Agents image"
)
class NativeSearchDiscovery(unittest.IsolatedAsyncioTestCase):
    async def test_native_mcp_client_discovers_search_without_inference_or_network(self):
        from langchain_mcp_adapters.client import MultiServerMCPClient

        client = MultiServerMCPClient(
            {
                "brave": {
                    "transport": "stdio",
                    "command": sys.executable,
                    "args": [str(Path(__file__).with_name("brave_search.py"))],
                }
            }
        )
        tools = await client.get_tools()
        self.assertEqual([tool.name for tool in tools], ["web_search"])
        self.assertIn("query", tools[0].args)
