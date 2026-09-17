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

    def test_all_supported_harnesses_build_locally_from_one_recipe(self):
        targets = self.plan("agents")["target"]
        self.assertEqual(set(targets), HARNESSES)
        for name, target in targets.items():
            self.assertEqual(target["args"]["HARNESS"], name)
            self.assertEqual(target["dockerfile"], "image/fabric/Dockerfile")
            self.assertEqual(target["platforms"], ["linux/arm64"])
            self.assertFalse(any("registry" in str(output) for output in target.get("output", [])))

    def test_individual_selection_does_not_build_other_harnesses(self):
        self.assertEqual(set(self.plan("pi")["target"]), {"pi"})

    def test_linux_amd64_selects_every_qualified_harness(self):
        targets = self.plan("agents", platform="linux/amd64")["target"]
        self.assertEqual(set(targets), AMD64_HARNESSES)
        for name, target in targets.items():
            self.assertEqual(target["platforms"], ["linux/amd64"])
            self.assertTrue(target["args"]["LOCKFILE"].endswith("-linux-amd64.lock"))

    def test_individual_harness_uses_selected_platform(self):
        target = self.plan("deepagents", platform="linux/amd64")["target"]["deepagents"]
        self.assertEqual(target["platforms"], ["linux/amd64"])
        self.assertEqual(target["args"]["LOCKFILE"], "dependencies-linux-amd64.lock")

    def test_proxy_has_an_independent_build(self):
        targets = self.plan("ollama-proxy")["target"]
        self.assertEqual(set(targets), {"ollama-proxy"})
        self.assertEqual(targets["ollama-proxy"]["dockerfile"], "image/ollama-proxy/Dockerfile")


if __name__ == "__main__":
    unittest.main()
