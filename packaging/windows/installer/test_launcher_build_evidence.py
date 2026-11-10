# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


MODULE = Path(__file__).with_name("launcher-build-evidence.py")
SPEC = importlib.util.spec_from_file_location("launcher_build_evidence", MODULE)
evidence = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(evidence)


class LauncherBuildEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="launcher-evidence-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.source = self.root / "source"
        self.package = self.root / "package"
        for name in evidence.REQUIRED | {"src/runtime_host.rs", "src/nested/helper.rs", "build.rs"}:
            path = self.source / evidence.PREFIX / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("source fixture: " + name)
        self.retained = self.package / "build/compiled-native/NemoClaw.exe"
        self.packaged = self.package / "build/payload/bin/NemoClaw.exe"
        self.retained.parent.mkdir(parents=True)
        self.packaged.parent.mkdir(parents=True)
        data = bytearray(512)
        data[:2] = b"MZ"
        data[60:64] = (128).to_bytes(4, "little")
        data[128:132] = b"PE\0\0"
        data[132:134] = (0xAA64).to_bytes(2, "little")
        data[148:150] = (2).to_bytes(2, "little")
        data[150:152] = (2).to_bytes(2, "little")
        data[152:154] = (0x20B).to_bytes(2, "little")
        cargo = self.root / "cargo.exe"
        cargo.write_bytes(data)
        evidence.materializer.materialize(cargo, self.retained, self.package / "compiled-launcher.json")
        self.packaged.write_bytes(data)
        self.capability_path = self.package / "build/launcher-capabilities.json"
        self.capability_path.write_text(json.dumps({
            "schemaVersion": 1,
            "launcherSha256": evidence.materializer.digest(data),
            "capabilities": {
                "schemaVersion": 1, "kind": "native-runtime-capabilities",
                "immutableRuntime": True, "guardianEnabled": True,
            },
        }))

    def collect(self):
        return evidence.collect(self.source, self.package, "a" * 40, "123", "2")

    def test_binds_retained_and_selected_bytes_without_admitting_a_command(self):
        result = self.collect()
        self.assertEqual(result["classification"], "package-selected-launcher-build-inputs")
        self.assertEqual(result["retainedLauncher"]["sha256"], result["packagedLauncher"]["sha256"])
        self.assertEqual(result["retainedLauncher"]["bytes"], 512)
        self.assertEqual(result["target"], "aarch64-pc-windows-msvc")
        self.assertEqual(result["features"], ["immutable-runtime"])
        self.assertTrue(result["staticCrt"] and result["lockedDependencies"])
        self.assertFalse(result["commandSupportValidated"])
        self.assertFalse(result["invocationAdmitted"])
        self.assertFalse(result["installedAcceptance"])
        self.assertEqual(result["capabilityObservation"]["advertisedCommands"], [])
        self.assertEqual(result["capabilityObservation"]["sha256"],
                         evidence.materializer.digest(self.capability_path.read_bytes()))
        paths = {row["file"] for row in result["sources"]}
        self.assertEqual(len(paths), 8)
        self.assertIn(evidence.PREFIX + "src/nested/helper.rs", paths)
        self.assertIn(evidence.PREFIX + "build.rs", paths)

    def test_binds_declared_command_without_claiming_command_validation(self):
        value = json.loads(self.capability_path.read_text())
        value["capabilities"]["supportedCommands"] = ["native-state-inspection-v1"]
        self.capability_path.write_text(json.dumps(value))
        result = self.collect()
        self.assertEqual(result["capabilityObservation"], {
            "file": "build/launcher-capabilities.json",
            "bytes": len(self.capability_path.read_bytes()),
            "sha256": evidence.materializer.digest(self.capability_path.read_bytes()),
            "advertisedCommands": ["native-state-inspection-v1"],
        })
        self.assertFalse(result["commandSupportValidated"])
        self.assertFalse(result["invocationAdmitted"])
        self.assertFalse(result["installedAcceptance"])

    def test_rejects_missing_substituted_or_unrecognized_capability_observation(self):
        value = json.loads(self.capability_path.read_text())
        for changed in (
            {**value, "launcherSha256": "b" * 64},
            {**value, "capabilities": {**value["capabilities"], "supportedCommands": ["unknown"]}},
            {**value, "capabilities": {**value["capabilities"], "guardianEnabled": False}},
        ):
            with self.subTest(changed=changed):
                self.capability_path.write_text(json.dumps(changed))
                with self.assertRaisesRegex(ValueError, "connected immutable guardian"):
                    self.collect()
        self.capability_path.unlink()
        with self.assertRaises(FileNotFoundError):
            self.collect()

    def test_rejects_changed_packaged_bytes_and_materialization_receipt(self):
        original = self.packaged.read_bytes()
        self.packaged.write_bytes(original + b"changed")
        with self.assertRaisesRegex(ValueError, "package-selected"):
            self.collect()
        self.packaged.write_bytes(original)
        receipt = self.package / "compiled-launcher.json"
        record = json.loads(receipt.read_text())
        record["outputSha256"] = "b" * 64
        receipt.write_text(json.dumps(record))
        with self.assertRaisesRegex(ValueError, "materialization"):
            self.collect()

    def test_rejects_wrong_architecture_and_invalid_build_identity(self):
        for revision, run, attempt in [("main", "1", "1"), ("a" * 40, "0", "1"), ("a" * 40, "1", "latest")]:
            with self.subTest(revision=revision, run=run, attempt=attempt), self.assertRaises(ValueError):
                evidence.collect(self.source, self.package, revision, run, attempt)
        data = bytearray(self.retained.read_bytes())
        data[132:134] = (0x8664).to_bytes(2, "little")
        self.retained.write_bytes(data)
        self.packaged.write_bytes(data)
        with self.assertRaisesRegex(ValueError, "ARM64"):
            self.collect()

    def test_rejects_missing_required_source_and_redirected_source(self):
        path = self.source / evidence.PREFIX / "src/state_session.rs"
        data = path.read_bytes()
        path.unlink()
        with self.assertRaises(FileNotFoundError):
            self.collect()
        target = self.root / "outside.rs"
        target.write_bytes(data)
        path.symlink_to(target)
        with self.assertRaisesRegex(ValueError, "link or reparse"):
            self.collect()

    def test_rejects_hardlinked_retained_launcher_and_generated_source_output(self):
        alias = self.root / "alias.exe"
        os.link(self.retained, alias)
        with self.assertRaisesRegex(ValueError, "materialization"):
            self.collect()
        alias.unlink()
        (self.source / evidence.PREFIX / "target").mkdir()
        with self.assertRaisesRegex(ValueError, "generated output"):
            self.collect()

    def test_cli_writes_fresh_metadata_and_never_executes_the_fixture(self):
        output = self.package / "launcher-build-inputs.json"
        command = [sys.executable, str(MODULE), "--source-root", str(self.source),
                   "--package-root", str(self.package), "--source-revision", "a" * 40,
                   "--run-id", "123", "--run-attempt", "2", "--output", str(output)]
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        before = output.read_bytes()
        self.assertEqual(json.loads(before), self.collect())
        repeated = subprocess.run(command, capture_output=True, text=True)
        self.assertNotEqual(repeated.returncode, 0)
        self.assertEqual(output.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
