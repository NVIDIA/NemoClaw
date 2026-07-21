# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Tool-registration schema shape for the NemoClaw Hermes plugin (#7067).

Hermes wraps each registered tool schema in a single
``{"type": "function", "function": {...}}`` envelope at request-build time.
The plugin must therefore hand ``register_tool`` the *bare* function object.
Pre-wrapping double-wraps the tool, which lenient providers tolerate but strict
ones (Google Gemini) reject with HTTP 400, and it also drops
``transcribe_audio``'s real ``parameters`` to ``{}`` at the outer level.

Runs standalone: ``python -m unittest`` from ``agents/hermes/plugin`` (stdlib +
PyYAML only; no Hermes runtime required).
"""

from __future__ import annotations

import importlib.util
import os
import unittest


def _load_plugin_module():
    """Import the plugin __init__.py as a standalone module."""
    path = os.path.join(os.path.dirname(__file__), "__init__.py")
    spec = importlib.util.spec_from_file_location("nemoclaw_hermes_plugin", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _FakeCtx:
    """Captures register_tool/register_hook calls made by register(ctx)."""

    def __init__(self):
        self.tools: dict[str, dict] = {}
        self.hooks: list[str] = []

    def register_tool(self, name, schema, **_kwargs):
        self.tools[name] = schema

    def register_hook(self, event, _handler=None, **_kwargs):
        self.hooks.append(event)


class RegisterToolSchemaShapeTest(unittest.TestCase):
    EXPECTED_TOOLS = (
        "nemoclaw_status",
        "nemoclaw_info",
        "nemoclaw_reload_skills",
        "transcribe_audio",
    )

    def setUp(self):
        self.plugin = _load_plugin_module()
        # register() first installs Hermes runtime patches; no-op them so the
        # test isolates tool-registration shape without a live Hermes.
        self.plugin._install_nous_tool_broker_patch = lambda *a, **k: None
        self.plugin._install_messaging_response_patch = lambda *a, **k: None
        self.ctx = _FakeCtx()
        self.plugin.register(self.ctx)

    def test_all_expected_tools_registered(self):
        self.assertEqual(set(self.EXPECTED_TOOLS), set(self.ctx.tools))

    def test_schemas_are_bare_function_objects_not_double_wrapped(self):
        for name in self.EXPECTED_TOOLS:
            schema = self.ctx.tools[name]
            with self.subTest(tool=name):
                # A bare function object exposes name/parameters at the top level
                # and carries no nested envelope.
                self.assertEqual(schema.get("name"), name)
                self.assertIn("parameters", schema)
                self.assertNotIn(
                    "function", schema, f"{name} schema is still wrapped in an envelope"
                )
                self.assertNotEqual(
                    schema.get("type"),
                    "function",
                    f"{name} schema is still wrapped in an envelope",
                )

    def test_transcribe_audio_keeps_its_real_parameters(self):
        # The destructive symptom of double-wrapping: transcribe_audio's real
        # parameters end up only in the inner wrapper and the outer becomes {}.
        params = self.ctx.tools["transcribe_audio"]["parameters"]
        self.assertEqual(params.get("type"), "object")
        self.assertIn("file_path", params.get("properties", {}))
        self.assertIn("model", params.get("properties", {}))
        self.assertEqual(params.get("required"), ["file_path"])


if __name__ == "__main__":
    unittest.main()
