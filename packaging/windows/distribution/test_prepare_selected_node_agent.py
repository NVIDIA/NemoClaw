# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location(
    "selected_node", Path(__file__).with_name("prepare-selected-node-agent.py")
)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class SelectedNodeAgent(unittest.TestCase):
    def test_pi_is_locked_pruned_and_license_archived(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source/agents/pi/pi-runtime"
            source.mkdir(parents=True)
            source.joinpath("package.json").write_text(
                json.dumps({"dependencies": {"@earendil-works/pi-coding-agent": "0.84.1"}})
            )
            source.joinpath("package-lock.json").write_text('{"lockfileVersion":3}\n')
            node, npm = root / "node.exe", root / "npm-cli.js"
            node.write_bytes(b"node")
            npm.write_bytes(b"npm")
            output = root / "output"

            def install(*_args, **_kwargs):
                package = output / "node_modules/@earendil-works/pi-coding-agent"
                package.mkdir(parents=True)
                package.joinpath("package.json").write_text(
                    json.dumps({"name": "@earendil-works/pi-coding-agent", "version": "0.84.1"})
                )
                package.joinpath("dist").mkdir()
                package.joinpath("dist/cli.js").write_text("runtime")
                package.joinpath("dist/cli.js.map").write_text("development")
                package.joinpath("LICENSE").write_text("license")

            with mock.patch.object(MODULE.subprocess, "run", side_effect=install):
                receipt = MODULE.prepare("pi", root / "source", node, npm, output)
            self.assertFalse((output / "package-lock.json").exists())
            self.assertFalse((output / "node_modules/@earendil-works/pi-coding-agent/dist/cli.js.map").exists())
            self.assertTrue((output / "node_modules/@earendil-works/pi-coding-agent/dist/cli.js").is_file())
            self.assertEqual(receipt["npmVersion"], "10.9.8")
            self.assertEqual(receipt["licenseArchive"]["sourceFiles"], 1)
            self.assertFalse(receipt["customerBuildRequired"])


if __name__ == "__main__":
    unittest.main()
