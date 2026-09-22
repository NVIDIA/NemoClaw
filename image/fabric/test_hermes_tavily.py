# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
import io
import json
import os
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

if os.environ.get("NEMOCLAW_TEST_NATIVE_TAVILY") == "1":
    from plugins.web import tavily
else:
    import hermes_tavily as tavily


class TavilyRequests(unittest.TestCase):
    def test_search_uses_fixed_endpoint_and_bearer_placeholder(self):
        response = {
            "results": [{"url": "https://example.com", "title": "Example", "content": "Text"}]
        }
        with (
            patch.dict(os.environ, {"TAVILY_API_KEY": "fixture-placeholder"}),
            patch.object(tavily.urllib.request, "build_opener") as opener,
        ):
            opener.return_value.open.return_value = io.BytesIO(json.dumps(response).encode())
            provider = tavily.Tavily()
            self.assertTrue(provider.is_available())
            opener.assert_not_called()
            result = provider.search("owned query", limit=2)
            request = opener.return_value.open.call_args.args[0]
            self.assertEqual(request.full_url, "https://api.tavily.com/search")
            self.assertEqual(request.get_method(), "POST")
            self.assertEqual(request.get_header("Authorization"), "Bearer fixture-placeholder")
            self.assertEqual(json.loads(request.data), {"query": "owned query", "max_results": 2})
            self.assertEqual(
                result,
                {
                    "success": True,
                    "data": {
                        "web": [
                            {
                                "title": "Example",
                                "url": "https://example.com",
                                "description": "Text",
                                "position": 1,
                            }
                        ]
                    },
                },
            )

    def test_extract_preserves_successes_and_reports_failed_urls_without_echoing_errors(self):
        response = {
            "results": [{"url": "https://example.com", "raw_content": "Extracted text"}],
            "failed_results": [
                {"url": "https://example.org", "error": "untrusted-secret\u001b[2J"}
            ],
        }
        with (
            patch.dict(os.environ, {"TAVILY_API_KEY": "fixture-placeholder"}),
            patch.object(tavily.urllib.request, "build_opener") as opener,
        ):
            opener.return_value.open.return_value = io.BytesIO(json.dumps(response).encode())
            urls = ["https://example.com", "https://example.org"]
            result = tavily.Tavily().extract(urls)
            request = opener.return_value.open.call_args.args[0]
            self.assertEqual(request.full_url, "https://api.tavily.com/extract")
            self.assertEqual(request.get_header("Authorization"), "Bearer fixture-placeholder")
            self.assertEqual(json.loads(request.data), {"urls": urls})
            self.assertEqual(result[0]["content"], "Extracted text")
            self.assertEqual(result[0]["raw_content"], "Extracted text")
            self.assertEqual(
                result[1], {"url": urls[1], "error": "Tavily could not extract this URL"}
            )
            self.assertNotIn("untrusted-secret", json.dumps(result))

    def test_missing_key_invalid_responses_and_redirects_do_not_fall_back(self):
        with (
            patch.dict(os.environ, {}, clear=True),
            patch.object(tavily.urllib.request, "build_opener") as opener,
        ):
            provider = tavily.Tavily()
            self.assertFalse(provider.is_available())
            self.assertFalse(provider.search("query")["success"])
            self.assertIn("error", provider.extract(["https://example.com"])[0])
            opener.assert_not_called()
        for raw in (b"not-json", b"{}", b'{"results":null}', b"x" * (4 * 1024 * 1024 + 1)):
            with (
                self.subTest(response_length=len(raw)),
                patch.dict(os.environ, {"TAVILY_API_KEY": "fixture-placeholder"}),
                patch.object(tavily.urllib.request, "build_opener") as opener,
            ):
                opener.return_value.open.return_value = io.BytesIO(raw)
                self.assertFalse(tavily.Tavily().search("query")["success"])
                self.assertEqual(opener.return_value.open.call_count, 1)
        self.assertIsNone(
            tavily.NoRedirect().redirect_request(None, None, 302, "", {}, "https://other.example")
        )
        with (
            patch.dict(os.environ, {"TAVILY_API_KEY": "fixture-placeholder"}),
            patch.object(tavily.urllib.request, "build_opener") as opener,
        ):
            opener.return_value.open.side_effect = urllib.error.HTTPError(
                "https://api.tavily.com/search", 401, "untrusted-secret\u001b[2J", {}, None
            )
            result = tavily.Tavily().search("query")
            self.assertEqual(result, {"success": False, "error": "Tavily search failed"})
            self.assertEqual(opener.return_value.open.call_count, 1)


@unittest.skipUnless(
    os.environ.get("NEMOCLAW_TEST_NATIVE_TAVILY") == "1", "requires the pinned Hermes image"
)
class NativeTavilyRegistration(unittest.TestCase):
    def test_hermes_discovers_and_selects_tavily_for_both_tools(self):
        import hermes_adapter

        with (
            tempfile.TemporaryDirectory() as directory,
            patch.dict(
                os.environ, {"HERMES_HOME": directory, "TAVILY_API_KEY": "fixture-placeholder"}
            ),
        ):
            inference = {
                "api": "openai-completions",
                "agents": [{"name": "main"}],
                "webSearch": {
                    "provider": "tavily",
                    "agentRefs": ["main"],
                    "credential": {"env": "SEARCH_KEY"},
                },
            }
            hermes_adapter.initialize(inference, Path(directory))
            from agent.web_search_provider import WebSearchProvider
            from agent.web_search_registry import (
                get_active_extract_provider,
                get_active_search_provider,
            )
            from hermes_cli.plugins import discover_plugins

            discover_plugins(force=True)
            for provider in (get_active_search_provider(), get_active_extract_provider()):
                self.assertIsInstance(provider, WebSearchProvider)
                self.assertEqual(provider.name, "tavily")
                self.assertTrue(provider.is_available())
                with patch.object(tavily.urllib.request, "build_opener") as opener:
                    opener.return_value.open.return_value = io.BytesIO(b'{"results":[]}')
                    self.assertEqual(
                        provider.search("query"), {"success": True, "data": {"web": []}}
                    )
                with patch.dict(os.environ, {"TAVILY_API_KEY": ""}):
                    self.assertEqual(get_active_search_provider().name, "tavily")
                    self.assertFalse(provider.is_available())


if __name__ == "__main__":
    unittest.main()
