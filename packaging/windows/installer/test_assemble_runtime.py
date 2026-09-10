# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Build real trees and manifests; placeholder Windows binaries are not executed."""

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from assign_runtime_namespace import assign
import assemble_runtime as assembler


class RuntimeAssembly(unittest.TestCase):
    def setUp(self):
        fixture = tempfile.TemporaryDirectory()
        self.addCleanup(fixture.cleanup)
        self.root = Path(fixture.name)
        self.source = self.root / "prepared/openclaw"
        self.entry = self.source / "openclaw-app.cjs"
        self.entry.parent.mkdir(parents=True)
        self.entry.write_text("export const sourceIdentity = 'selected-agent';\n")
        (self.source / "LICENSE").write_text("Retained license fixture\n")
        (self.source / "empty").mkdir()
        self.node = self.root / "node.exe"
        pe = bytearray(256)
        pe[:2] = b"MZ"
        pe[60:64] = (128).to_bytes(4, "little")
        pe[128:134] = b"PE\0\0\x64\xaa"
        self.node.write_bytes(pe)
        self.namespace = self.root / "namespace.json"
        self.identity = assign(self.namespace, "a" * 40, "b" * 64)
        self.workers = self.root / "workers"
        self.workers.mkdir()
        compiled = []
        for name in (
            "native-runtime.cjs",
            "openclaw-invoke.cjs",
            "native-inference-manifest.json",
        ):
            (self.workers / name).write_text("fixture\n")
            data = (self.workers / name).read_bytes()
            compiled.append(
                {
                    "file": name,
                    "bytes": len(data),
                    "sha256": hashlib.sha256(data).hexdigest(),
                }
            )
        (self.workers / "onboarding").mkdir()
        frontend = []
        for name in ("index.html", "app.js", "styles.css"):
            (self.workers / "onboarding" / name).write_text("prebuilt fixture\n")
            data = (self.workers / "onboarding" / name).read_bytes()
            frontend.append(
                {
                    "file": name,
                    "bytes": len(data),
                    "sha256": hashlib.sha256(data).hexdigest(),
                }
            )
        (self.workers / "build.json").write_text(
            json.dumps(
                {
                    "classification": "prebuilt-windows-runtime-bundles",
                    "deliveryContract": "finished-native-app-v1",
                    "sourceRevision": "a" * 40,
                    "userSideSourceGenerationRequired": False,
                    "modes": assembler.GUEST_MODES,
                    "files": compiled,
                    "onboarding": frontend,
                }
            )
        )
        self.sea = self.root / "sea"
        self.sea.mkdir()
        shutil.copy2(self.node, self.sea / "NemoClaw.Runtime.exe")
        (self.sea / "build.json").write_text(
            json.dumps(
                {
                    "classification": "windows-prebuilt-runtime-executable",
                    "status": "built-and-executed",
                    "platform": "win32",
                    "architecture": "arm64",
                    "node": "v22.23.2",
                    "stockNodeSha256": hashlib.sha256(pe).hexdigest(),
                    "compiledSourceSha256": compiled[0]["sha256"],
                    "useCodeCache": True,
                    "useSnapshot": False,
                    "execution": {
                        "schemaVersion": 1,
                        "kind": "prebuilt-native-runtime",
                        "sea": True,
                        "node": "v22.23.2",
                        "hostModes": assembler.HOST_MODES,
                        "guestModes": assembler.GUEST_MODES,
                    },
                    "executable": {
                        "file": "NemoClaw.Runtime.exe",
                        "bytes": len(pe),
                        "sha256": hashlib.sha256(pe).hexdigest(),
                    },
                }
            )
        )
        (self.source / "openclaw-dynamic-import.cjs").write_text(
            "module.exports = {};\n"
        )
        (self.source / "package.json").write_text(
            '{"name":"openclaw","version":"2026.7.1"}\n'
        )
        (self.source / "dist/control-ui").mkdir(parents=True)
        (self.source / "dist/control-ui/index.html").write_text(
            "<html>compiled fixture</html>\n"
        )
        resources = [
            {
                "path": row["path"],
                "bytes": row["bytes"],
                "sha256": row["sha256"],
                "role": "metadata",
            }
            for row in assembler.inventory(self.source)
            if row["kind"] == "file"
        ]
        (self.source / "openclaw-resource-closure.json").write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "classification": "compiled-openclaw-resource-closure",
                    "closureAdmitted": True,
                    "controlUiRoot": "dist/control-ui",
                    "package": {"name": "openclaw", "version": "2026.7.1"},
                    "compiler": {
                        "mainSha256": hashlib.sha256(
                            self.entry.read_bytes()
                        ).hexdigest(),
                        "bridgeSha256": hashlib.sha256(
                            (self.source / "openclaw-dynamic-import.cjs").read_bytes()
                        ).hexdigest(),
                    },
                    "files": resources,
                }
            )
        )
        self.output = self.root / "output"

    def assemble(self, sources=None):
        return assembler.assemble(
            self.output,
            sources or {"openclaw": self.source},
            self.node,
            "22.23.2",
            "a" * 40,
            "b" * 64,
            self.namespace,
            worker_build=self.workers,
            executable_build=self.sea,
        )

    def test_selected_openclaw_build_has_exact_seal_without_other_agents_or_node_copy(
        self,
    ):
        before = assembler.inventory(self.source)
        result = self.assemble()
        content = self.output / "runtimes" / self.identity["runtimeId"]
        self.assertEqual(assembler.inventory(content / "openclaw"), before)
        self.assertEqual(assembler.inventory(self.source), before)
        self.assertFalse((self.output / "bin").exists())
        self.assertFalse(list(content.rglob("node.exe")))
        self.assertFalse((content / "hermes").exists())
        self.assertEqual(
            result["runtime"]["manifestSha256"],
            hashlib.sha256((content / "runtime.manifest").read_bytes()).hexdigest(),
        )
        self.assertEqual(
            result["runtime"]["nodeSha256"],
            hashlib.sha256(self.node.read_bytes()).hexdigest(),
        )
        availability = json.loads((content / "agent-availability.json").read_text())
        self.assertEqual(
            [row["agent"] for row in availability["agents"] if row["included"]],
            ["openclaw"],
        )
        self.assertTrue(result["buildCompleteForSelectedAgents"])
        self.assertFalse(result["completePackage"])
        self.assertFalse(result["activationAllowed"])
        self.assertFalse(result["installedAcceptance"])
        self.assertFalse(result["agents"][0]["executionQualified"])
        self.assertFalse((self.output / "runtime-current").exists())

    def test_missing_selected_agent_fails_before_output(self):
        with self.assertRaises(FileNotFoundError):
            self.assemble({"pi": self.root / "absent"})
        self.assertFalse(self.output.exists())

    def test_changed_executable_cannot_enter_the_sealed_application(self):
        with (self.sea / "NemoClaw.Runtime.exe").open("ab") as stream:
            stream.write(b"changed")
        with self.assertRaisesRegex(ValueError, "exact Windows build"):
            self.assemble()
        self.assertFalse(self.output.exists())

    def test_compiler_only_prototype_is_not_a_finished_delivery(self):
        record = json.loads((self.workers / "build.json").read_text())
        record.pop("deliveryContract")
        (self.workers / "build.json").write_text(json.dumps(record))
        with self.assertRaisesRegex(ValueError, "compiled source contract"):
            self.assemble()
        self.assertFalse(self.output.exists())

    def test_closed_files_can_be_packaged_as_an_unqualified_preview(self):
        receipt = self.source / "openclaw-resource-closure.json"
        value = json.loads(receipt.read_text())
        value["closureAdmitted"] = False
        receipt.write_text(json.dumps(value))
        result = self.assemble()
        self.assertTrue(result["buildCompleteForSelectedAgents"])
        self.assertFalse(result["agents"][0]["executionQualified"])
        self.assertFalse(result["installedAcceptance"])

    def test_redirected_directory_is_not_flattened(self):
        target = self.root / "external"
        target.mkdir()
        (target / "secret").write_text("outside fixture\n")
        (self.source / "redirect").symlink_to(target, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "nonredirected"):
            self.assemble()
        self.assertFalse(self.output.exists())

    def test_hardlinked_input_is_refused(self):
        os.link(self.entry, self.source / "hardlink.mjs")
        with self.assertRaisesRegex(ValueError, "single-link"):
            self.assemble()
        self.assertFalse(self.output.exists())

    def test_source_drift_preserves_primary_and_removes_only_owned_output(self):
        copy = shutil.copy2

        def changed(source, target):
            result = copy(source, target)
            if Path(source) == self.entry:
                self.entry.write_text("changed after copy\n")
            return result

        with mock.patch.object(assembler.shutil, "copy2", side_effect=changed):
            with self.assertRaisesRegex(
                ValueError, "changed during its exact build copy"
            ):
                self.assemble()
        self.assertFalse(self.output.exists())
        self.assertTrue(self.source.exists())
        self.assertTrue(self.node.exists())

    def test_namespace_cannot_be_reused_with_changed_inputs(self):
        with self.assertRaisesRegex(ValueError, "changed inputs"):
            assembler.assemble(
                self.output,
                {"openclaw": self.source},
                self.node,
                "22.23.2",
                "c" * 40,
                "b" * 64,
                self.namespace,
                worker_build=self.workers,
                executable_build=self.sea,
            )
        self.assertFalse(self.output.exists())

    def test_curated_hermes_cannot_be_used_as_fallback(self):
        with self.assertRaisesRegex(ValueError, "Curated or provenance-free Hermes"):
            self.assemble({"hermes": self.root / "curated-hermes"})
        self.assertFalse(self.output.exists())

    def test_actual_builder_cli_publishes_selected_manifest(self):
        child = subprocess.run(
            [
                sys.executable,
                str(Path(assembler.__file__)),
                "--output",
                str(self.output),
                "--agent",
                "openclaw=" + str(self.source),
                "--shared-node",
                str(self.node),
                "--node-version",
                "22.23.2",
                "--source-revision",
                "a" * 40,
                "--component-identity",
                "b" * 64,
                "--namespace-receipt",
                str(self.namespace),
                "--worker-build",
                str(self.workers),
                "--executable-build",
                str(self.sea),
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertEqual(child.returncode, 0, child.stderr)
        receipt = json.loads(child.stdout)
        self.assertEqual(receipt["runtime"]["runtimeId"], self.identity["runtimeId"])
        self.assertFalse(receipt["activationAllowed"])
        self.assertTrue((self.output / "runtime-identity.json").is_file())


if __name__ == "__main__":
    unittest.main()
