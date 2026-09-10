# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Package real fixture files; native binaries and MSI execution are not simulated as proof."""

import hashlib
import json
from pathlib import Path
import shutil
import unittest
import xml.etree.ElementTree as ET

import test_assemble_runtime as fixtures
import package_runtime as package


class PackageComposition(unittest.TestCase):
    def setUp(self):
        fixture = fixtures.RuntimeAssembly()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        self.fixture = fixture
        self.assembly = fixture.assemble()
        self.host = fixture.root / "host"
        self.host.mkdir()
        for name in package.COMMON_DIRECTORIES:
            (self.host / name).mkdir()
        shutil.copy2(fixture.node, self.host / "bin/node.exe")
        (self.host / "nemoclaw/app/bin").mkdir(parents=True)
        (self.host / "nemoclaw/app/bin/nemoclaw.js").write_text("legacy generic CLI\n")
        (self.host / "bin/nemoclaw.cmd").write_text("legacy generic CLI alias\n")
        (self.host / "hermes/site-packages").mkdir(parents=True)
        (self.host / "hermes/site-packages/old-curated.py").write_text("not selected\n")
        (self.host / "qualification").mkdir()
        (self.host / "qualification/run-installed-native-web-ui.mts").write_text(
            "old source helper\n"
        )
        (self.host / "onboarding").mkdir()
        (self.host / "onboarding/app.ts").write_text("old uncompiled frontend\n")
        (self.host / "runtime-payload-receipt.json").write_text('{"fixture":true}\n')
        (self.host / "agent-support.json").write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "platform": "windows-arm64",
                    "agents": [
                        {"id": agent, "version": "fixture", "selectable": True}
                        for agent in package.LAYOUT
                    ],
                }
            )
        )
        self.launcher = fixture.root / "launcher.exe"
        shutil.copy2(fixture.node, self.launcher)
        self.capabilities = fixture.root / "capabilities.json"
        self.capabilities.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "launcherSha256": hashlib.sha256(
                        self.launcher.read_bytes()
                    ).hexdigest(),
                    "capabilities": {
                        "schemaVersion": 1,
                        "kind": "native-runtime-capabilities",
                        "immutableRuntime": True,
                        "guardianEnabled": True,
                    },
                }
            )
        )
        self.sources = Path(package.__file__).parents[1] / "runtime"
        self.output = fixture.root / "package"

    def compose(self):
        return package.compose(
            self.host,
            self.fixture.output,
            self.launcher,
            self.capabilities,
            self.output,
            None,
        )

    def test_composition_keeps_shared_node_and_uses_fixed_guardian_wrappers(self):
        identity = self.compose()
        package.verify_seal(self.output / "runtimes" / identity["runtimeId"], identity)
        self.assertEqual(
            (self.output / "bin/node.exe").read_bytes(), self.fixture.node.read_bytes()
        )
        self.assertFalse((self.output / "hermes").exists())
        self.assertFalse((self.output / "openclaw").exists())
        self.assertFalse((self.output / "bin/openclaw.cmd").exists())
        self.assertFalse((self.output / "bin/nemoclaw.cmd").exists())
        self.assertFalse((self.output / "nemoclaw").exists())
        self.assertTrue((self.output / "bin/NemoClaw.exe").is_file())
        self.assertFalse((self.output / "qualification").exists())
        self.assertFalse((self.output / "onboarding").exists())
        self.assertTrue(
            (
                self.output
                / "runtimes"
                / identity["runtimeId"]
                / "app/NemoClaw.Runtime.exe"
            ).is_file()
        )
        self.assertTrue(
            (
                self.output
                / "runtimes"
                / identity["runtimeId"]
                / "workers/native-runtime.cjs"
            ).is_file()
        )
        catalog = json.loads((self.output / "agent-support.json").read_text())
        self.assertEqual(
            [row["id"] for row in catalog["agents"] if row["selectable"]], ["openclaw"]
        )
        self.assertEqual(
            catalog["agents"][0]["limitation"],
            "Preview: full runtime checks are pending.",
        )
        self.assertFalse((self.output / "runtime-current").exists())

    def test_feature_off_launcher_cannot_enter_opt_in_package(self):
        value = json.loads(self.capabilities.read_text())
        value["capabilities"]["guardianEnabled"] = False
        self.capabilities.write_text(json.dumps(value))
        with self.assertRaisesRegex(ValueError, "connected immutable guardian"):
            self.compose()
        self.assertFalse(self.output.exists())

    def test_build_presence_does_not_become_qualification(self):
        document, references = package.availability(self.assembly, None)
        self.assertEqual(references, [])
        self.assertEqual(
            document["agents"][0], {"agent": "openclaw", "status": "unqualified"}
        )
        decision = {
            "schemaVersion": 1,
            "classification": "reviewed-native-runtime-availability",
            "runtime": self.assembly["runtime"],
            "agents": [{"agent": "openclaw", "evidenceSha256": "d" * 64}],
        }
        document, references = package.availability(self.assembly, decision)
        self.assertEqual(document["agents"][0]["status"], "qualified")
        self.assertEqual(references, decision["agents"])
        decision["runtime"] = {**decision["runtime"], "manifestSha256": "e" * 64}
        with self.assertRaisesRegex(ValueError, "different runtime"):
            package.availability(self.assembly, decision)

    def test_modified_sealed_file_is_refused_before_package_copy(self):
        content = (
            self.fixture.output / "runtimes" / self.assembly["runtime"]["runtimeId"]
        )
        (content / "openclaw/LICENSE").write_text("changed\n")
        with self.assertRaisesRegex(ValueError, "sealed inventory"):
            self.compose()
        self.assertFalse(self.output.exists())

    def test_shared_node_identity_change_is_refused(self):
        (self.host / "bin/node.exe").write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "shared Node differs"):
            self.compose()
        self.assertFalse(self.output.exists())

    def test_grouped_authoring_covers_exact_files_and_component_references(self):
        self.compose()
        authoring = self.fixture.root / "payload.wxs"
        result = package.payload_authoring(self.output, authoring)
        tree = ET.parse(authoring)
        ns = {"w": package.NAMESPACE}
        files = tree.findall(".//w:File", ns)
        actual = {
            Path(row.attrib["Source"]).relative_to(self.output.resolve()).as_posix()
            for row in files
        }
        expected = {
            row["path"]
            for row in package.inventory(self.output)
            if row["kind"] == "file"
        }
        self.assertEqual(actual, expected)
        self.assertEqual(result["files"], len(expected))
        components = tree.findall(".//w:Component", ns)
        refs = tree.findall(".//w:ComponentRef", ns)
        self.assertEqual(
            {row.attrib["Id"] for row in components}, {row.attrib["Id"] for row in refs}
        )
        self.assertTrue(tree.findall(".//w:CreateFolder", ns))
        self.assertTrue(all(len(row.findall("w:File", ns)) <= 64 for row in components))


if __name__ == "__main__":
    unittest.main()
