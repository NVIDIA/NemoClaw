# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Browser private-URL opt-in behavior for the NemoClaw Hermes plugin (#8614)."""

from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
import types
import unittest


def _load_plugin_module():
    path = os.path.join(os.path.dirname(__file__), "__init__.py")
    spec = importlib.util.spec_from_file_location("nemoclaw_hermes_plugin_private_url", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class PrivateUrlOptInTest(unittest.TestCase):
    def _install_patch(self, config):
        plugin = _load_plugin_module()
        browser_tool = types.SimpleNamespace(
            _is_safe_url=lambda _url: False,
            _allow_private_urls_resolved=None,
        )
        original = sys.modules.get("tools.browser_tool")
        sys.modules["tools.browser_tool"] = browser_tool
        plugin._broker_mode_enabled = lambda: True
        plugin._load_hermes_config = lambda: config
        try:
            self.assertTrue(plugin._install_broker_url_safety_patch())
            return browser_tool._allow_private_urls_resolved
        finally:
            if original is None:
                del sys.modules["tools.browser_tool"]
            else:
                sys.modules["tools.browser_tool"] = original

    def test_denies_private_urls_by_default(self):
        self.assertFalse(self._install_patch({}))
        self.assertFalse(self._install_patch({"security": {"allow_private_urls": False}}))
        self.assertFalse(self._install_patch({"security": {"allow_private_urls": "true"}}))

    def test_allows_private_urls_only_for_explicit_boolean_opt_in(self):
        self.assertTrue(self._install_patch({"security": {"allow_private_urls": True}}))


if __name__ == "__main__":
    unittest.main()
