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
        self.assertTrue(
            (
                self.output
                / "runtimes"
                / identity["runtimeId"]
                / "workers/openclaw-sqlite-realpath-preload.cjs"
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
        self.assertFalse(document["bundledLocalInferenceAvailable"])
        bundled = {**self.assembly, "localInference": {"modelsBundled": False}}
        bundled_document, bundled_references = package.availability(bundled, None)
        self.assertTrue(bundled_document["bundledLocalInferenceAvailable"])
        self.assertFalse(bundled_document["prebuiltLocalModelAvailable"])
        self.assertEqual(bundled_document["agents"], document["agents"])
        self.assertEqual(bundled_references, [])
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

    def test_finished_image_replaces_the_per_file_runtime_payload(self):
        identity = self.assembly["runtime"]
        image = self.fixture.root / "runtime.vhdx"
        image_bytes = b"fixture-finished-runtime-image"
        image.write_bytes(image_bytes)
        receipt = self.fixture.root / "runtime-image.json"
        receipt.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "classification": "finished-runtime-application-image",
                    "runtimeId": identity["runtimeId"],
                    "status": "built-detached-and-verified",
                    "payloadObjects": 1,
                    "customerExtractionRequired": False,
                    "runtimeLaunchCopiesRequired": False,
                    "mountedReadOnly": True,
                    "manifestSha256": identity["manifestSha256"],
                    "image": {
                        "file": image.name,
                        "bytes": image.stat().st_size,
                        "sha256": hashlib.sha256(image_bytes).hexdigest(),
                    },
                }
            )
        )
        package.compose(
            self.host,
            self.fixture.output,
            self.launcher,
            self.capabilities,
            self.output,
            None,
            image,
            receipt,
        )
        inputs = json.loads((self.output / "immutable-package-inputs.json").read_text())
        installed_image = self.output / "images" / (identity["runtimeId"] + ".vhdx")
        self.assertEqual(inputs["deliveryContract"], "finished-native-image-v1")
        self.assertFalse(image.exists())
        self.assertEqual(installed_image.read_bytes(), image_bytes)
        self.assertEqual(
            list((self.output / "runtimes" / identity["runtimeId"]).iterdir()), []
        )
        self.assertLess(
            sum(row["kind"] == "file" for row in package.inventory(self.output)), 100
        )

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
        self.assertEqual(tree.findall(".//w:RemoveFolder", ns), [])
        root = tree.find(".//w:DirectoryRef[@Id='INSTALLFOLDER']", ns)
        owners = [
            row
            for row in root.findall("w:Component", ns)
            if row.find("w:CreateFolder", ns) is not None
        ]
        self.assertEqual(len(owners), 1)
        self.assertTrue(owners[0].findall("w:File", ns))

    def test_explicit_cabinet_alias_is_retained_in_source_paths(self):
        self.compose()
        alias = self.fixture.root / "p"
        try:
            alias.symlink_to(self.output, target_is_directory=True)
        except OSError as error:
            self.skipTest("Directory aliases are unavailable: " + str(error))
        authoring = self.fixture.root / "payload-short.wxs"
        inputs = package.read_json(self.output / "immutable-package-inputs.json")
        runtime = self.output / "runtimes" / inputs["runtime"]["runtimeId"]
        runtime_alias = self.fixture.root / "r"
        runtime_alias.symlink_to(runtime, target_is_directory=True)
        package.payload_authoring(self.output, authoring, alias, runtime_alias)
        tree = ET.parse(authoring)
        ns = {"w": package.NAMESPACE}
        sources = [row.attrib["Source"] for row in tree.findall(".//w:File", ns)]
        self.assertTrue(sources)
        self.assertTrue(
            all(
                Path(source).is_relative_to(alias.absolute())
                or Path(source).is_relative_to(runtime_alias.absolute())
                for source in sources
            )
        )
        self.assertTrue(any(Path(source).is_relative_to(runtime_alias.absolute()) for source in sources))


if __name__ == "__main__":
    unittest.main()
