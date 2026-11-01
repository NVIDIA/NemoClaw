# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Named-connector source boundaries for Hermes (#6795242, #6903920)."""

from __future__ import annotations

import importlib.util
import os
import unittest


def _load_plugin_module():
    path = os.path.join(os.path.dirname(__file__), "__init__.py")
    spec = importlib.util.spec_from_file_location("nemoclaw_hermes_plugin_source_boundary", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ConnectorSourceBoundaryTest(unittest.TestCase):
    def setUp(self):
        self.plugin = _load_plugin_module()
        self.plugin._load_hermes_config = lambda: {
            "mcp_servers": {
                "jira": {"url": "https://example.invalid/jira"},
                "confluence": {"url": "https://example.invalid/confluence"},
                "glean": {"url": "https://example.invalid/glean"},
                "outlook": {"url": "https://example.invalid/outlook"},
            },
        }

    def _begin(self, message, *, session="session-1", turn="turn-1"):
        return self.plugin._begin_connector_source_boundary(
            session_id=session,
            turn_id=turn,
            user_message=message,
        )

    def test_recognizes_explicit_named_connector_requests_only(self):
        self.assertEqual(self._begin("Use Jira only. Read one issue."), ("jira",))
        self.assertEqual(self._begin("Using Glean, find the policy."), ("glean",))
        self.assertEqual(
            self._begin("Call jira_search exactly once with JQL ORDER BY updated DESC."),
            ("jira",),
        )
        self.assertEqual(self._begin("Compare Jira and Confluence as products."), ())

    def test_blocks_fallback_tools_but_allows_the_requested_connector(self):
        self._begin("Use Glean only to find the policy.")

        self.assertIsNone(
            self.plugin._connector_source_pre_tool_call(
                tool_name="mcp__glean__glean_search",
                session_id="session-1",
                turn_id="turn-1",
            ),
        )
        self.assertIsNone(
            self.plugin._connector_source_pre_tool_call(
                tool_name="tool_search",
                session_id="session-1",
                turn_id="turn-1",
            ),
        )

        for tool_name in (
            "mcp__confluence__confluence_search",
            "read_file",
            "execute_code",
            "web_search",
        ):
            with self.subTest(tool_name=tool_name):
                directive = self.plugin._connector_source_pre_tool_call(
                    tool_name=tool_name,
                    session_id="session-1",
                    turn_id="turn-1",
                )
                self.assertEqual(directive.get("action"), "block")
                self.assertIn("Glean", directive.get("message", ""))
                self.assertIn("permission", directive.get("message", ""))

    def test_replaces_false_success_after_a_failed_connector_call(self):
        self._begin("Use Jira only. Read one issue.")
        self.plugin._connector_source_post_tool_call(
            tool_name="mcp__jira__jira_search",
            session_id="session-1",
            turn_id="turn-1",
            status="error",
            result='{"success": false, "error": "Failed to connect to Jira API"}',
        )

        replacement = self.plugin._connector_source_transform_llm_output(
            response_text="JIRA_READ_OK 0",
            session_id="session-1",
        )

        self.assertNotIn("JIRA_READ_OK", replacement)
        self.assertIn("Jira", replacement)
        self.assertIn("failed", replacement)
        self.assertIn("did not use another source", replacement)

    def test_failed_connector_result_carries_the_source_boundary_into_model_context(self):
        self._begin("Use Jira only. Read one issue.")
        raw_result = '{"success": false, "error": "Failed to connect to Jira API"}'
        self.plugin._connector_source_post_tool_call(
            tool_name="mcp__jira__jira_search",
            session_id="session-1",
            turn_id="turn-1",
            status="ok",
            result=raw_result,
        )

        transformed = self.plugin._connector_source_transform_tool_result(
            tool_name="mcp__jira__jira_search",
            session_id="session-1",
            turn_id="turn-1",
            status="ok",
            result=raw_result,
        )

        self.assertIn(raw_result, transformed)
        self.assertIn("NemoClaw source boundary", transformed)
        self.assertIn("Jira connector request failed", transformed)
        self.assertIn("did not use another source", transformed)

    def test_replaces_unverified_success_when_the_connector_never_ran(self):
        self._begin("Call jira_search exactly once. Reply JIRA_READ_OK 0.")

        replacement = self.plugin._connector_source_transform_llm_output(
            response_text="JIRA_READ_OK 0",
            session_id="session-1",
        )

        self.assertNotIn("JIRA_READ_OK", replacement)
        self.assertIn("could not verify", replacement.lower())

    def test_preserves_the_response_only_when_every_named_connector_call_succeeded(self):
        self._begin("Using Outlook, read my latest email subject.")
        self.plugin._connector_source_post_tool_call(
            tool_name="mcp__outlook__get_latest_email",
            session_id="session-1",
            turn_id="turn-1",
            status="ok",
            result='{"success": true, "subject": "Release status"}',
        )

        self.assertIsNone(
            self.plugin._connector_source_transform_llm_output(
                response_text="Release status",
                session_id="session-1",
            ),
        )

    def test_any_failed_named_connector_call_fails_closed(self):
        self._begin("Use Jira only. Read the issue twice.")
        for status, result in (
            ("ok", '{"success": true, "key": "ABC-1"}'),
            ("error", '{"success": false, "error": "backend unavailable"}'),
        ):
            self.plugin._connector_source_post_tool_call(
                tool_name="mcp__jira__jira_get_issue",
                session_id="session-1",
                turn_id="turn-1",
                status=status,
                result=result,
            )

        self.assertIsNotNone(
            self.plugin._connector_source_transform_llm_output(
                response_text="ABC-1 Open Open Yes",
                session_id="session-1",
            ),
        )

    def test_post_llm_call_replaces_the_live_transcript_false_success(self):
        self._begin("Use Jira only. Read one issue.")
        self.plugin._connector_source_post_tool_call(
            tool_name="mcp__jira__jira_search",
            session_id="session-1",
            turn_id="turn-1",
            status="error",
            result='{"success": false, "error": "backend unavailable"}',
        )
        history = [
            {"role": "user", "content": "Use Jira only. Read one issue."},
            {
                "role": "assistant",
                "content": "JIRA_READ_OK 0",
                "_db_persisted": True,
            },
        ]

        self.plugin._connector_source_post_llm_call(
            assistant_response="The Jira connector request failed.",
            conversation_history=history,
            session_id="session-1",
        )

        self.assertNotIn("JIRA_READ_OK", history[-1]["content"])
        self.assertIn("Jira connector request failed", history[-1]["content"])
        self.assertNotIn("_db_persisted", history[-1])
        self.assertIsNone(
            self.plugin._connector_boundary_for_hook("session-1", "turn-1"),
        )

    def test_a_follow_up_turn_can_authorize_a_different_connector(self):
        self._begin("Use Jira only.", turn="turn-1")
        self._begin("Jira is unavailable. Use Glean instead.", turn="turn-2")

        self.assertIsNone(
            self.plugin._connector_source_pre_tool_call(
                tool_name="mcp__glean__glean_search",
                session_id="session-1",
                turn_id="turn-2",
            ),
        )
        self.assertEqual(
            self.plugin._connector_source_pre_tool_call(
                tool_name="mcp__jira__jira_search",
                session_id="session-1",
                turn_id="turn-2",
            ).get("action"),
            "block",
        )


if __name__ == "__main__":
    unittest.main()
