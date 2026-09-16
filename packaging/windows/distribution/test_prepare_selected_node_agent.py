# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

import importlib.util
import hashlib
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
        self.check_preparation()

    def test_modified_compiled_payload_or_source_is_rejected(self):
        for fault in ("payload", "source", "package-set"):
            with self.subTest(fault=fault):
                self.check_preparation(fault)

    def check_preparation(self, fault=None):
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
                sdk_names = ("@mistralai/mistralai", "@aws-sdk/client-bedrock-runtime", "@aws-sdk/core", "@aws-sdk/nested-clients", "@smithy/core")
                if "--experimental-strip-types" in _args[0]:
                    compiled = output.with_name(output.name + "-compiled-sdks")
                    packages = []
                    for name in sdk_names:
                        original = package / "node_modules" / name / "package.json"
                        data = original.read_bytes()
                        target = compiled / name
                        target.mkdir(parents=True)
                        (target / "package.json").write_bytes(data)
                        sha = hashlib.sha256(data).hexdigest()
                        packages.append({"name": name, "sourcePackageSha256": sha, "files": [{"path": "package.json", "sha256": sha}]})
                    if fault == "payload":
                        packages[0]["files"][0]["sha256"] = "0" * 64
                    elif fault == "source":
                        packages[0]["sourcePackageSha256"] = "0" * 64
                    elif fault == "package-set":
                        packages.pop()
                    (compiled / "build.json").write_text(json.dumps({"classification": "pi-compiled-sdk-paths", "compilerVersion": "0.27.4", "packages": packages}))
                    return
                package.mkdir(parents=True)
                for name in sdk_names:
                    target = package / "node_modules" / name
                    target.mkdir(parents=True)
                    (target / "package.json").write_text(json.dumps({"name": name, "version": "fixture"}))
                package.joinpath("package.json").write_text(
                    json.dumps({"name": "@earendil-works/pi-coding-agent", "version": "0.84.1"})
                )
                package.joinpath("dist").mkdir()
                package.joinpath("dist/cli.js").write_text("runtime")
                package.joinpath("dist/cli.js.map").write_text("development")
                package.joinpath("dist/doc").mkdir()
                package.joinpath("dist/doc/runtime.js").write_text("required")
                package.joinpath("docs").mkdir()
                package.joinpath("docs/guide.md").write_text("development")
                package.joinpath("LICENSE").write_text("license")

            with mock.patch.object(MODULE.subprocess, "run", side_effect=install):
                if fault:
                    with self.assertRaises(ValueError):
                        MODULE.prepare("pi", root / "source", node, npm, output, root / "tools")
                    self.assertFalse((output / "selected-agent-build.json").exists())
                    self.assertTrue((output / "node_modules/@earendil-works/pi-coding-agent/node_modules/@mistralai/mistralai/package.json").is_file())
                    return
                receipt = MODULE.prepare("pi", root / "source", node, npm, output, root / "tools")
            self.assertFalse((output / "package-lock.json").exists())
            package = output / "node_modules/@earendil-works/pi-coding-agent"
            self.assertFalse((package / "dist/cli.js.map").exists())
            self.assertFalse((package / "docs").exists())
            self.assertTrue((package / "dist/doc/runtime.js").is_file())
            self.assertTrue((package / "dist/cli.js").is_file())
            self.assertEqual(receipt["npmVersion"], "10.9.8")
            self.assertEqual(receipt["licenseArchive"]["sourceFiles"], 1)
            self.assertFalse(receipt["customerBuildRequired"])
            self.assertEqual(receipt["compiledSdkBuildSha256"], MODULE.digest(output / "compiled-sdk-build.json"))


if __name__ == "__main__":
    unittest.main()
