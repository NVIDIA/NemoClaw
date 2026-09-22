# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Check the public build interface without a daemon or downloaded source tree."""

import json
import os
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HARNESSES = {
    "deepagents",
    "hermes",
    "openclaw",
    "claude",
    "codex",
    "mini-swe-agent",
    "nooa",
    "nooa-bench",
    "remote-agent",
    "pi",
}
AMD64_HARNESSES = {"deepagents", "openclaw"}


class ImageBuilds(unittest.TestCase):
    def plan(self, *targets, platform=None):
        environment = os.environ.copy()
        environment["AGENT_PLATFORM"] = platform or "linux/arm64"
        result = subprocess.run(
            ["docker", "buildx", "bake", "--print", *targets],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
            env=environment,
        )
        return json.loads(result.stdout)

    def test_all_supported_harnesses_build_locally(self):
        targets = self.plan("agents")["target"]
        self.assertEqual(set(targets), HARNESSES)
        for name, target in targets.items():
            self.assertEqual(target["args"]["HARNESS"], name)
            self.assertEqual(target["platforms"], ["linux/arm64"])
            self.assertFalse(any("registry" in str(output) for output in target.get("output", [])))

    def test_individual_selection_does_not_build_other_harnesses(self):
        self.assertEqual(set(self.plan("pi")["target"]), {"pi"})

    def test_linux_amd64_selects_every_qualified_harness(self):
        targets = self.plan("agents", platform="linux/amd64")["target"]
        self.assertEqual(set(targets), AMD64_HARNESSES)
        for target in targets.values():
            self.assertEqual(target["platforms"], ["linux/amd64"])

    def test_individual_harness_uses_selected_platform(self):
        target = self.plan("deepagents", platform="linux/amd64")["target"]["deepagents"]
        self.assertEqual(target["platforms"], ["linux/amd64"])

    def test_kubernetes_image_inherits_the_selected_openclaw_build(self):
        for platform in ("linux/arm64", "linux/amd64"):
            targets = self.plan("openclaw", "openclaw-kubernetes", platform=platform)["target"]
            ordinary = targets["openclaw"]
            adapted = targets["openclaw-kubernetes"]
            self.assertEqual(adapted["args"], ordinary["args"])
            self.assertEqual(adapted["platforms"], [platform])
            self.assertEqual(adapted["target"], "openclaw-kubernetes")
            self.assertNotEqual(adapted["tags"], ordinary["tags"])

    def test_proxy_has_an_independent_build(self):
        targets = self.plan("ollama-proxy")["target"]
        self.assertEqual(set(targets), {"ollama-proxy"})

    def test_proxy_and_its_tests_use_the_selected_platform(self):
        for platform in ("linux/arm64", "linux/amd64"):
            targets = self.plan("ollama-proxy", "proxy-tests", platform=platform)["target"]
            for target in targets.values():
                self.assertEqual(target["platforms"], [platform])

    def test_builds_require_an_explicit_platform(self):
        environment = os.environ.copy()
        environment.pop("AGENT_PLATFORM", None)
        result = subprocess.run(
            ["docker", "buildx", "bake", "--print", "agents"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            env=environment,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("AGENT_PLATFORM", result.stderr)


if __name__ == "__main__":
    unittest.main()
