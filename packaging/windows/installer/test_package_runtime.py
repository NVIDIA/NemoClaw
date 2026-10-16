# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Package real fixture files; native binaries and MSI execution are not simulated as proof."""

import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import unittest.mock
import xml.etree.ElementTree as ET

import test_assemble_runtime as fixtures
import package_runtime as package
from build_runtime_manifest import build as build_manifest


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

    def compose(self, selection=None):
        return package.compose(
            self.host,
            self.fixture.output,
            self.launcher,
            self.capabilities,
            self.output,
            selection,
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
            [row["id"] for row in catalog["agents"] if row["selectable"]], []
        )
        self.assertEqual(
            catalog["agents"][0]["limitation"],
            "Unavailable: runtime qualification is pending.",
        )
        self.assertFalse((self.output / "runtime-current").exists())

    def test_feature_off_launcher_cannot_enter_opt_in_package(self):
        value = json.loads(self.capabilities.read_text())
        value["capabilities"]["guardianEnabled"] = False
        self.capabilities.write_text(json.dumps(value))
        with self.assertRaisesRegex(ValueError, "connected immutable guardian"):
            self.compose()
        self.assertFalse(self.output.exists())

    def test_composition_retains_declared_inspection_without_granting_acceptance(self):
        value = json.loads(self.capabilities.read_text())
        value["capabilities"]["supportedCommands"] = ["native-state-inspection-v1"]
        self.capabilities.write_text(json.dumps(value))
        self.compose()
        inputs = json.loads((self.output / "immutable-package-inputs.json").read_text())
        self.assertEqual(inputs["launcher"], value)
        self.assertFalse(inputs["installedAcceptance"])
        self.assertFalse(inputs["completePackage"])
        self.assertEqual(package.validate_launcher_capabilities(value, value["launcherSha256"]),
                         ["native-state-inspection-v1"])

    def test_capability_validation_rejects_unknown_commands_and_untyped_guardians(self):
        original = json.loads(self.capabilities.read_text())
        self.assertEqual(package.validate_launcher_capabilities(original, original["launcherSha256"]), [])
        mutations = [
            {"supportedCommands": None}, {"supportedCommands": []},
            {"supportedCommands": "native-state-inspection-v1"},
            {"supportedCommands": ["native-state-inspection-v1", "native-state-inspection-v1"]},
            {"supportedCommands": ["state-remove"]}, {"unknown": True},
            {"schemaVersion": True}, {"schemaVersion": 1.0},
            {"immutableRuntime": 1}, {"guardianEnabled": "true"},
        ]
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                value = {**original, "capabilities": {**original["capabilities"], **mutation}}
                self.capabilities.write_text(json.dumps(value))
                with self.assertRaisesRegex(ValueError, "connected immutable guardian"):
                    self.compose()
                self.assertFalse(self.output.exists())
        for value in (None, [], {**original, "schemaVersion": True},
                      {**original, "launcherSha256": "b" * 64},
                      {**original, "capabilities": None}):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "connected immutable guardian"):
                package.validate_launcher_capabilities(value, original["launcherSha256"])

    def test_build_presence_does_not_become_qualification(self):
        document, references = package.availability(self.assembly, None)
        self.assertFalse(document["bundledLocalInferenceAvailable"])
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

    def test_host_z3_notice_reaches_the_composed_payload_and_msi_file_inventory(self):
        source_notice = Path(package.__file__).parents[1] / "Z3-LICENSE.txt"
        shutil.copy2(source_notice, self.host / source_notice.name)
        self.compose()
        self.assertEqual(
            (self.output / source_notice.name).read_bytes(), source_notice.read_bytes()
        )
        authoring = self.fixture.root / "host-notice.wxs"
        package.payload_authoring(self.output, authoring)
        root = ET.parse(authoring).getroot()
        notices = root.findall(f".//{{{package.NAMESPACE}}}File[@Name='Z3-LICENSE.txt']")
        self.assertEqual(len(notices), 1)
        self.assertEqual(
            Path(notices[0].attrib["Source"]).read_bytes(), source_notice.read_bytes()
        )

    def test_both_included_agents_can_receive_a_runtime_bound_reviewed_decision(self):
        assembly = {**self.assembly, "agents": [{"agent": agent} for agent in package.LAYOUT]}
        decision = {
            "schemaVersion": 1,
            "classification": "reviewed-native-runtime-availability",
            "runtime": assembly["runtime"],
            "agents": [{"agent": agent, "evidenceSha256": "d" * 64} for agent in package.LAYOUT],
        }
        document, references = package.availability(assembly, decision)
        self.assertEqual(document["agents"], [
            {"agent": agent, "status": "qualified"} for agent in package.LAYOUT
        ])
        self.assertEqual(references, decision["agents"])
        for rows in (
            [{"agent": "pi", "evidenceSha256": "d" * 64}],
            [{"agent": "hermes", "evidenceSha256": "invalid"}],
            [decision["agents"][1], decision["agents"][1]],
        ):
            with self.subTest(rows=rows), self.assertRaisesRegex(ValueError, "unavailable, duplicate or unbound"):
                package.availability(assembly, {**decision, "agents": rows})
        with self.assertRaisesRegex(ValueError, "unavailable, duplicate or unbound"):
            package.availability(self.assembly, {**decision, "agents": [decision["agents"][1]]})

    def test_only_reviewed_included_profiles_are_selectable_in_the_package_catalog(self):
        decision = self.fixture.root / "reviewed-availability.json"
        decision.write_text(json.dumps({
            "schemaVersion": 1,
            "classification": "reviewed-native-runtime-availability",
            "runtime": self.assembly["runtime"],
            "agents": [{"agent": "openclaw", "evidenceSha256": "d" * 64}],
        }))
        self.compose(decision)
        catalog = json.loads((self.output / "agent-support.json").read_text())
        self.assertEqual([row["id"] for row in catalog["agents"] if row["selectable"]], ["openclaw"])
        self.assertNotIn("limitation", catalog["agents"][0])
        self.assertEqual(catalog["agents"][1]["limitation"], "Unavailable in this preview")

    def test_engine_presence_enables_model_selection_without_granting_qualification(self):
        assembly = {**self.assembly, "localInference": {
            "engineVersion": "fixture", "bundleSha256": "a" * 64,
            "modelsBundled": False,
        }}
        document, references = package.availability(assembly, None)
        self.assertTrue(document["bundledLocalInferenceAvailable"])
        self.assertFalse(document["prebuiltLocalModelAvailable"])
        self.assertEqual(references, [])
        self.assertEqual(document["agents"][0], {
            "agent": "openclaw", "status": "unqualified",
        })

    def reviewed_recomposition_inputs(self, image=False, agent="openclaw"):
        if image:
            self.compose_image()
        else:
            self.compose()
        (self.output / "native-ui").mkdir()
        (self.output / "native-ui/fixture-bootstrapper.exe").write_bytes(b"old embedded availability")
        decision = self.fixture.root / "reviewed-availability.json"
        decision.write_text(json.dumps({
            "schemaVersion": 1,
            "classification": "reviewed-native-runtime-availability",
            "runtime": self.assembly["runtime"],
            "agents": [{"agent": agent, "evidenceSha256": "d" * 64}],
        }))
        return decision, self.fixture.root / "reviewed-package"

    def recompose_reviewed(self, decision, output):
        return package.recompose_reviewed(
            self.output, self.fixture.output / "assembly.json", decision, output
        )

    def hermes_recomposition_inputs(self, image=False):
        # A separate sealed fixture tests packaging, not Hermes runtime admission.
        self.fixture.output = self.fixture.root / "hermes-assembly"
        runtime_id = "c" * 64
        root = self.fixture.output / "runtimes" / runtime_id
        (root / "hermes").mkdir(parents=True)
        (root / "hermes/LICENSE").write_text("Hermes packaging fixture; not executable\n")
        manifest, identity = build_manifest(root, self.fixture.node, "a" * 40, "22.23.2", runtime_id)
        (root / "runtime.manifest").write_bytes(manifest)
        fields = ("runtimeId", "manifestSha256", "sourceRevision", "nodeSha256", "nodeVersion")
        (root / "runtime.ready").write_bytes(
            ("NEMOCLAW_RUNTIME_V1\n" + "\n".join(identity[key] for key in fields) + "\n").encode("ascii")
        )
        self.assembly = {
            "classification": "windows-immutable-runtime-assembly",
            "buildCompleteForSelectedAgents": True,
            "deliveryContract": "finished-native-app-v1",
            "runtime": identity,
            "agents": [{"agent": "hermes"}],
        }
        package.write_json(self.fixture.output / "assembly.json", self.assembly)
        return self.reviewed_recomposition_inputs(image=image, agent="hermes")

    def test_reviewed_hermes_recomposition_preserves_the_sealed_runtime_and_host(self):
        decision, output = self.hermes_recomposition_inputs()
        before = package.inventory(self.output)
        identity = self.recompose_reviewed(decision, output)
        self.assertEqual(identity, self.assembly["runtime"])
        package.verify_seal(output / "runtimes" / identity["runtimeId"], identity)
        self.assertEqual(package.inventory(self.output), before)
        mutable = {"agent-support.json", "runtime-package-availability.json", "immutable-package-inputs.json"}
        self.assertEqual(
            [row for row in package.inventory(output) if row["path"] not in mutable],
            [row for row in before if row["path"] not in mutable and row["path"].split("/", 1)[0] != "native-ui"],
        )
        catalog = package.read_json(output / "agent-support.json")
        self.assertEqual([row["id"] for row in catalog["agents"] if row["selectable"]], ["hermes"])
        self.assertEqual(package.read_json(output / "runtime-package-availability.json")["agents"], [
            {"agent": agent, "status": "qualified" if agent == "hermes" else "not-included"}
            for agent in package.LAYOUT
        ])
        inputs = package.read_json(output / "immutable-package-inputs.json")
        self.assertEqual(inputs["availabilityEvidence"], package.read_json(decision)["agents"])
        self.assertIs(inputs["installedAcceptance"], False)
        self.assertIs(inputs["completePackage"], False)
        self.assertFalse((output / "native-ui").exists())
        self.assertEqual(package.read_json(self.output / "runtime-package-availability.json")["agents"][1]["status"], "unqualified")

    def test_reviewed_hermes_image_recomposition_preserves_image_bytes_without_acceptance(self):
        decision, output = self.hermes_recomposition_inputs(image=True)
        before = package.inventory(self.output)
        self.recompose_reviewed(decision, output)
        self.assertEqual(package.inventory(self.output), before)
        self.assertEqual(package.inventory(output / "images"), package.inventory(self.output / "images"))
        inputs = package.read_json(output / "immutable-package-inputs.json")
        self.assertEqual(inputs["deliveryContract"], "finished-native-image-v1")
        self.assertEqual(inputs["availabilityEvidence"], package.read_json(decision)["agents"])
        self.assertIs(inputs["installedAcceptance"], False)
        self.assertIs(inputs["completePackage"], False)
        self.assertFalse((output / "native-ui").exists())
        self.assertEqual(list((output / "runtimes" / self.assembly["runtime"]["runtimeId"]).iterdir()), [])

    def test_reviewed_hermes_recomposition_rejects_missing_wrong_duplicate_and_unbound_review(self):
        decision, output = self.hermes_recomposition_inputs()
        value = package.read_json(decision)
        before = package.inventory(self.output)
        for change in (
            {"runtime": {**value["runtime"], "sourceRevision": "e" * 40}},
            {"runtime": {**value["runtime"], "manifestSha256": "e" * 64}},
            {"classification": "startup-only"},
            {"agents": []},
            {"agents": [{"agent": "openclaw", "evidenceSha256": "d" * 64}]},
            {"agents": [{"agent": "hermes", "evidenceSha256": "invalid"}]},
            {"agents": value["agents"] * 2},
        ):
            with self.subTest(change=change):
                decision.write_text(json.dumps({**value, **change}))
                with self.assertRaises(ValueError):
                    self.recompose_reviewed(decision, output)
                self.assertFalse(output.exists())
                self.assertEqual(package.inventory(self.output), before)

    def test_reviewed_hermes_recomposition_rejects_changed_runtime_and_premature_acceptance(self):
        decision, output = self.hermes_recomposition_inputs()
        runtime = self.output / "runtimes" / self.assembly["runtime"]["runtimeId"]
        inputs_path = self.output / "immutable-package-inputs.json"
        for path, changed in (
            (runtime / "hermes/LICENSE", b"changed runtime"),
            (self.output / "bin/node.exe", b"changed Node"),
            (self.output / "bin/NemoClaw.exe", b"changed launcher"),
            (inputs_path, json.dumps({**package.read_json(inputs_path), "installedAcceptance": True}).encode()),
            (inputs_path, json.dumps({**package.read_json(inputs_path), "completePackage": True}).encode()),
        ):
            with self.subTest(path=path, changed=changed):
                original = path.read_bytes()
                try:
                    path.write_bytes(changed)
                    before = package.inventory(self.output)
                    with self.assertRaises(ValueError):
                        self.recompose_reviewed(decision, output)
                    self.assertFalse(output.exists())
                    self.assertEqual(package.inventory(self.output), before)
                finally:
                    path.write_bytes(original)

    def test_reviewed_recomposition_rejects_unknown_multiple_or_malformed_included_agents(self):
        decision, output = self.hermes_recomposition_inputs()
        path = self.fixture.output / "assembly.json"
        inputs_path = self.output / "immutable-package-inputs.json"
        inputs = package.read_json(inputs_path)
        for agents in (None, {}, [], [None], [{}], [{"agent": "pi"}],
                       [{"agent": "hermes"}, {"agent": "openclaw"}], [{"agent": "hermes"}] * 2):
            with self.subTest(agents=agents):
                path.write_text(json.dumps({**self.assembly, "agents": agents}))
                inputs_path.write_text(json.dumps({**inputs, "assemblyReceiptSha256": package.hash_file(path)[1]}))
                before = package.inventory(self.output)
                with self.assertRaisesRegex(ValueError, "original unqualified single-agent"):
                    self.recompose_reviewed(decision, output)
                self.assertFalse(output.exists())
                self.assertEqual(package.inventory(self.output), before)

    def test_reviewed_recomposition_preserves_every_runtime_and_host_byte(self):
        decision, output = self.reviewed_recomposition_inputs()
        original = package.inventory(self.output)
        result = self.recompose_reviewed(decision, output)
        self.assertEqual(result, self.assembly["runtime"])
        self.assertEqual(package.inventory(self.output), original)
        self.assertFalse((output / "native-ui").exists())
        mutable = {"agent-support.json", "runtime-package-availability.json", "immutable-package-inputs.json"}
        self.assertEqual(
            [row for row in package.inventory(output) if row["path"] not in mutable],
            [row for row in original if row["path"] not in mutable and row["path"].split("/", 1)[0] != "native-ui"],
        )
        inputs = json.loads((output / "immutable-package-inputs.json").read_text())
        self.assertEqual(inputs["availabilityEvidence"], json.loads(decision.read_text())["agents"])
        self.assertIs(inputs["installedAcceptance"], False)
        self.assertIs(inputs["completePackage"], False)
        catalog = json.loads((output / "agent-support.json").read_text())
        self.assertEqual([row["id"] for row in catalog["agents"] if row["selectable"]], ["openclaw"])
        self.assertNotIn("limitation", catalog["agents"][0])
        self.assertEqual(json.loads((self.output / "runtime-package-availability.json").read_text())["agents"][0]["status"], "unqualified")

    def test_reviewed_recomposition_cli_produces_a_fresh_payload_not_an_installer_pass(self):
        decision, output = self.reviewed_recomposition_inputs()
        result = subprocess.run([
            sys.executable, package.__file__, "recompose-reviewed",
            "--payload", str(self.output), "--assembly", str(self.fixture.output / "assembly.json"),
            "--reviewed-availability", str(decision), "--output", str(output),
        ], capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), self.assembly["runtime"])
        self.assertFalse((output / "native-ui").exists())
        self.assertIs(json.loads((output / "immutable-package-inputs.json").read_text())["completePackage"], False)

    def test_reviewed_recomposition_preserves_the_exact_finished_image(self):
        decision, output = self.reviewed_recomposition_inputs(image=True)
        original = package.inventory(self.output)
        self.recompose_reviewed(decision, output)
        self.assertEqual(package.inventory(self.output), original)
        self.assertEqual(package.inventory(output / "images"), package.inventory(self.output / "images"))
        inputs = json.loads((output / "immutable-package-inputs.json").read_text())
        self.assertEqual(inputs["deliveryContract"], "finished-native-image-v1")
        self.assertIs(inputs["completePackage"], False)
        self.assertIs(inputs["installedAcceptance"], False)
        self.assertFalse((output / "native-ui").exists())
        self.assertEqual(list((output / "runtimes" / self.assembly["runtime"]["runtimeId"]).iterdir()), [])
        authored = package.payload_authoring(output, self.fixture.root / "reviewed-image.wxs")
        self.assertLess(authored["files"], 100)

    def test_reviewed_recomposition_rejects_changed_image_and_image_receipt(self):
        decision, output = self.reviewed_recomposition_inputs(image=True)
        base = self.output / "images" / self.assembly["runtime"]["runtimeId"]
        for suffix in (".vhdx", ".json"):
            source = base.with_suffix(suffix)
            original = source.read_bytes()
            with self.subTest(suffix=suffix):
                try:
                    source.write_bytes(b"changed-image" if suffix == ".vhdx" else b"{}")
                    with self.assertRaisesRegex(ValueError, "image differs"):
                        self.recompose_reviewed(decision, output)
                    self.assertFalse(output.exists())
                finally:
                    source.write_bytes(original)

    def test_reviewed_recomposition_rejects_changed_image_binding_or_nonempty_mount(self):
        decision, output = self.reviewed_recomposition_inputs(image=True)
        path = self.output / "immutable-package-inputs.json"
        original = path.read_bytes()
        inputs = json.loads(original)
        inputs["runtimeImage"]["sha256"] = "f" * 64
        path.write_text(json.dumps(inputs))
        with self.assertRaisesRegex(ValueError, "image binding changed"):
            self.recompose_reviewed(decision, output)
        self.assertFalse(output.exists())
        path.write_bytes(original)
        (self.output / "runtimes" / self.assembly["runtime"]["runtimeId"] / "unexpected").write_bytes(b"not empty")
        with self.assertRaisesRegex(ValueError, "empty runtime mount point"):
            self.recompose_reviewed(decision, output)
        self.assertFalse(output.exists())

    def test_reviewed_recomposition_refuses_missing_or_wrong_runtime_review(self):
        decision, output = self.reviewed_recomposition_inputs()
        value = json.loads(decision.read_text())
        original = package.inventory(self.output)
        for change in (
            {"runtime": {**value["runtime"], "runtimeId": "e" * 64}},
            {"runtime": {**value["runtime"], "manifestSha256": "e" * 64}},
            {"classification": "startup-only"},
            {"agents": []},
            {"agents": [{"agent": "hermes", "evidenceSha256": "d" * 64}]},
            {"agents": [{"agent": "openclaw", "evidenceSha256": "invalid"}]},
        ):
            with self.subTest(change=change):
                decision.write_text(json.dumps({**value, **change}))
                with self.assertRaises(ValueError):
                    self.recompose_reviewed(decision, output)
                self.assertFalse(output.exists())
                self.assertEqual(package.inventory(self.output), original)

    def test_reviewed_recomposition_refuses_changed_assembly_receipt(self):
        decision, output = self.reviewed_recomposition_inputs()
        assembly = self.fixture.output / "assembly.json"
        assembly.write_text(assembly.read_text() + "\n")
        with self.assertRaisesRegex(ValueError, "original unqualified single-agent"):
            self.recompose_reviewed(decision, output)
        self.assertFalse(output.exists())

    def test_reviewed_recomposition_refuses_changed_runtime_node_or_launcher(self):
        decision, output = self.reviewed_recomposition_inputs()
        paths = [
            self.output / "runtimes" / self.assembly["runtime"]["runtimeId"] / "openclaw/LICENSE",
            self.output / "bin/node.exe", self.output / "bin/NemoClaw.exe",
        ]
        for path in paths:
            with self.subTest(path=path.name):
                original = path.read_bytes()
                path.write_bytes(original + b"changed")
                try:
                    with self.assertRaises(ValueError):
                        self.recompose_reviewed(decision, output)
                    self.assertFalse(output.exists())
                finally:
                    path.write_bytes(original)

    def test_reviewed_recomposition_rejects_premature_acceptance_or_prior_qualification(self):
        decision, output = self.reviewed_recomposition_inputs()
        path = self.output / "immutable-package-inputs.json"
        value = json.loads(path.read_text())
        for change in (
            {"installedAcceptance": True}, {"completePackage": True},
            {"customerBuildRequired": True}, {"runtimeLaunchCopiesRequired": True},
            {"availabilityEvidence": [{"agent": "openclaw", "evidenceSha256": "a" * 64}]},
        ):
            with self.subTest(change=change):
                path.write_text(json.dumps({**value, **change}))
                with self.assertRaisesRegex(ValueError, "original unqualified single-agent"):
                    self.recompose_reviewed(decision, output)
                self.assertFalse(output.exists())
        path.write_text(json.dumps(value))
        availability = self.output / "runtime-package-availability.json"
        document = json.loads(availability.read_text())
        document["agents"][0]["status"] = "qualified"
        availability.write_text(json.dumps(document))
        with self.assertRaisesRegex(ValueError, "availability is not unqualified"):
            self.recompose_reviewed(decision, output)
        self.assertFalse(output.exists())

    def test_reviewed_recomposition_never_overwrites_or_nests_in_its_source(self):
        decision, output = self.reviewed_recomposition_inputs()
        output.mkdir()
        (output / "keep.txt").write_text("existing")
        original = package.inventory(self.output)
        for destination in (self.output, output, self.output / "nested-output"):
            with self.subTest(destination=destination):
                with self.assertRaisesRegex(ValueError, "fresh and separate"):
                    self.recompose_reviewed(decision, destination)
        self.assertEqual((output / "keep.txt").read_text(), "existing")
        self.assertEqual(package.inventory(self.output), original)

    def test_reviewed_recomposition_write_failure_removes_only_its_new_output(self):
        decision, output = self.reviewed_recomposition_inputs()
        original = package.inventory(self.output)
        with unittest.mock.patch.object(package, "write_json", side_effect=OSError("fixture write failure")):
            with self.assertRaisesRegex(OSError, "fixture write failure"):
                self.recompose_reviewed(decision, output)
        self.assertFalse(output.exists())
        self.assertEqual(package.inventory(self.output), original)

    def test_reviewed_recomposition_copy_failure_removes_only_its_partial_output(self):
        decision, output = self.reviewed_recomposition_inputs()
        original = package.inventory(self.output)
        with unittest.mock.patch.object(package.shutil, "copy2", side_effect=OSError("fixture copy failure")):
            with self.assertRaisesRegex(OSError, "fixture copy failure"):
                self.recompose_reviewed(decision, output)
        self.assertFalse(output.exists())
        self.assertEqual(package.inventory(self.output), original)

    def test_reviewed_recomposition_does_not_delete_a_concurrently_created_output(self):
        decision, output = self.reviewed_recomposition_inputs()
        copy = package.exact_copy

        def raced_copy(source, destination, **kwargs):
            destination.mkdir()
            (destination / "keep.txt").write_text("not owned by recomposition")
            return copy(source, destination, **kwargs)

        with unittest.mock.patch.object(package, "exact_copy", side_effect=raced_copy):
            with self.assertRaises(FileExistsError):
                self.recompose_reviewed(decision, output)
        self.assertEqual((output / "keep.txt").read_text(), "not owned by recomposition")

    def test_modified_sealed_file_is_refused_before_package_copy(self):
        content = (
            self.fixture.output / "runtimes" / self.assembly["runtime"]["runtimeId"]
        )
        (content / "openclaw/LICENSE").write_text("changed\n")
        with self.assertRaisesRegex(ValueError, "sealed inventory"):
            self.compose()
        self.assertFalse(self.output.exists())

    def compose_image(self):
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
        return image, image_bytes

    def test_finished_image_replaces_the_per_file_runtime_payload(self):
        identity = self.assembly["runtime"]
        image, image_bytes = self.compose_image()
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
