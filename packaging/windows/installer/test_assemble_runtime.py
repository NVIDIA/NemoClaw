# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Build real trees and manifests; placeholder Windows binaries are not executed."""

import hashlib
import json
import os
from pathlib import Path, PureWindowsPath
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from assign_runtime_namespace import assign
import assemble_runtime as assembler


class RuntimeAssembly(unittest.TestCase):
    def test_hermes_final_path_upgrades_the_pinned_adapter_before_relocation(self):
        calls = []

        class Module:
            @staticmethod
            def prepare_plan(root, source, target, environments, **options):
                calls.append((root, source, target, environments, options))
                name = "upgrade" if options.get("ci_upgrade_startup_adapter") else "relocate"
                return ({Path(root) / name: b"x"}, {})

            @staticmethod
            def apply_plan(changes):
                calls.append(("apply", changes))

        root = self.root / "runtime"
        target = PureWindowsPath(r"C:\Program Files\NVIDIA\NemoClaw\runtime")
        browser = {"bytes": 10, "sha256": "a" * 64}
        changes, _ = assembler.hermes_final_path_plan(Module, root, target, browser)
        self.assertEqual(calls[0][2], root)
        self.assertEqual(calls[0][4], {"ci_upgrade_edge_adapter": True})
        self.assertEqual(calls[1][0], "apply")
        self.assertEqual(calls[2][2], Path(str(target)))
        self.assertEqual(calls[2][4], {"ci_browser_use_adapter": browser})
        self.assertIn(root / "relocate", changes)

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

    def test_hermes_worker_receipt_binds_the_actual_shipping_core_python(self):
        hermes = self.root / "prepared/hermes"
        python = hermes / assembler.HERMES_CORE_PYTHON
        python.parent.mkdir(parents=True)
        shutil.copy2(self.node, python)
        inputs = self.workers / "python-build-inputs"
        output = self.workers / "python/hermes"
        inputs.mkdir()
        output.mkdir(parents=True)
        receipt = {
            "classification": "ci-prepared-python-bytecode",
            "agent": "hermes",
            "pythonVersion": "3.11.16",
            "platform": "win32",
            "architecture": "arm64",
            "invalidationMode": "unchecked-hash",
            "pythonSha256": assembler.hash_file(python)[1],
            "magicHex": "a70d0d0a",
            "workers": [],
        }
        for name in assembler.PYTHON_WORKERS["hermes"][1]:
            source = inputs / (name + ".py")
            source.write_text("# source-bound worker fixture\n")
            bytecode = bytes.fromhex("a70d0d0a01000000") + b"\0" * 8 + b"fixture"
            (output / (name + ".pyc")).write_bytes(bytecode)
            receipt["workers"].append(
                {
                    "worker": name + ".pyc",
                    "sourceSha256": assembler.hash_file(source)[1],
                    "bytecodeSha256": hashlib.sha256(bytecode).hexdigest(),
                    "bytecodeBytes": len(bytecode),
                }
            )
        report = output / "bytecode.json"
        report.write_text(json.dumps(receipt))
        self.assertEqual(
            len(assembler.python_workers(self.workers, {"hermes": hermes})), 5
        )
        for observed in (None, "f" * 64):
            report.write_text(json.dumps({**receipt, "pythonSha256": observed}))
            with self.assertRaisesRegex(ValueError, "exact shipping Python"):
                assembler.python_workers(self.workers, {"hermes": hermes})
        report.write_text(json.dumps(receipt))
        with python.open("ab") as stream:
            stream.write(b"changed interpreter")
        with self.assertRaisesRegex(ValueError, "exact shipping Python"):
            assembler.python_workers(self.workers, {"hermes": hermes})

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

    def executor_fixture(self):
        directory = self.root / "hermes-executor"
        directory.mkdir()
        shutil.copyfile(self.node, directory / "wxc-exec.exe")
        for name in ("MXC-LICENSE.txt", "NEMOCLAW-LICENSE.txt"):
            (directory / name).write_text(name + " retained fixture\n")
        size, sha = assembler.hash_file(directory / "wxc-exec.exe")
        build = {
            "classification": "mxc-owned-token-inspection-build",
            "status": "built",
            "candidateRevision": "a" * 40,
            "tokenQueryRepairSupported": True,
            "tokenAccessMode": "owned-child-query-only",
            "sourceCommit": "7dac1a952f0c9ad13f0a4cb089c4e0e8b3e0013a",
            "sourceSha256": "814659a1db0b4cd06854066705f274bba2b2702f563735d69ba72a407c0ad258",
            "target": "aarch64-pc-windows-msvc",
            "compilerClosed": True,
            "compilerForced": False,
            "compilerExitCode": 0,
            "compilerCleanupErrors": [],
            "files": [
                {
                    "file": "wxc-exec.exe",
                    "bytes": size,
                    "sha256": sha,
                    "machine": 0xAA64,
                }
            ],
            "licenseSha256": assembler.hash_file(directory / "MXC-LICENSE.txt")[1],
            "nemoClawLicenseSha256": assembler.hash_file(
                directory / "NEMOCLAW-LICENSE.txt"
            )[1],
        }
        metadata = self.root / "hermes-provenance"
        metadata.mkdir()

        def save(name, value):
            file = metadata / name
            file.write_text(json.dumps(value))
            size, sha = assembler.hash_file(file)
            return {"file": name, "bytes": size, "sha256": sha}

        save("mxc-token-inspection-build.json", build)
        return directory, metadata / "mxc-token-inspection-build.json"

    def test_hermes_executor_and_licenses_are_bound_to_current_source(self):
        directory, receipt = self.executor_fixture()
        build, files = assembler.hermes_executor_files(directory, receipt, "a" * 40)
        self.assertEqual(build["candidateRevision"], "a" * 40)
        self.assertEqual(
            [relative for _, relative, _, _ in files],
            [
                "mxc-compat/" + name
                for name in (
                    "wxc-exec.exe",
                    "MXC-LICENSE.txt",
                    "NEMOCLAW-LICENSE.txt",
                    "mxc-build.json",
                )
            ],
        )
        for source, _, expected, previous in files:
            self.assertEqual(assembler.hash_file(source), expected)
            self.assertIsNone(previous)
        (directory / "wxc-exec.exe").write_bytes(b"different runtime")
        with self.assertRaisesRegex(ValueError, "input changed"):
            assembler.hermes_executor_files(directory, receipt, "a" * 40)

    def test_hermes_executor_rejects_other_source_and_missing_license(self):
        directory, receipt = self.executor_fixture()
        with self.assertRaisesRegex(ValueError, "same-source"):
            assembler.hermes_executor_files(directory, receipt, "b" * 40)
        (directory / "MXC-LICENSE.txt").unlink()
        with self.assertRaises((ValueError, FileNotFoundError)):
            assembler.hermes_executor_files(directory, receipt, "a" * 40)

    def composition_fixture(self):
        executor, build_file = self.executor_fixture()
        shutil.copy2(build_file, executor / build_file.name)
        native = self.root / "native-source"
        native.mkdir()
        for name in assembler.NATIVE_SOURCE_FILES | {"mxc-token-inspection.patch"}:
            (native / name).write_text("source fixture " + name)
        patcher = mock.patch.object(assembler, "NATIVE_SOURCE_ROOT", native)
        patcher.start()
        self.addCleanup(patcher.stop)
        build = json.loads(build_file.read_text())
        build["patchSha256"] = assembler.hash_file(
            native / "mxc-token-inspection.patch"
        )[1]
        (executor / build_file.name).write_text(json.dumps(build))
        compatibility = self.root / "native-compatibility"
        compatibility.mkdir()
        files = []
        for name, machine in assembler.COMPATIBILITY_MEMBERS.items():
            data = bytearray(self.node.read_bytes())
            if machine == "x64":
                data[132:134] = b"\x64\x86"
            data.extend(name.encode())
            (compatibility / name).write_bytes(data)
            size, sha = assembler.hash_file(compatibility / name)
            files.append(
                {"file": name, "machine": machine, "bytes": size, "sha256": sha}
            )
        (compatibility / "DETOURS-LICENSE.txt").write_text("Detours fixture license")
        size, sha = assembler.hash_file(compatibility / "DETOURS-LICENSE.txt")
        compiled = {
            "classification": "mxc-msys-compatibility-prototype-build",
            "status": "built",
            "sourceRevision": "a" * 40,
            "cleanupErrors": [],
            "files": files,
            "sourceFiles": [
                {"path": name, "sha256": assembler.hash_file(native / name)[1]}
                for name in sorted(assembler.NATIVE_SOURCE_FILES)
            ],
            "license": {"file": "DETOURS-LICENSE.txt", "bytes": size, "sha256": sha},
        }
        (compatibility / "build-receipt.json").write_text(json.dumps(compiled))
        canonical = self.root / "canonical-hermes"
        (canonical / "mxc-compat").mkdir(parents=True)
        for name in [
            *assembler.COMPATIBILITY_MEMBERS,
            "DETOURS-LICENSE.txt",
            "build-receipt.json",
        ]:
            if name == "DETOURS-LICENSE.txt":
                shutil.copy2(compatibility / name, canonical / "mxc-compat" / name)
            else:
                (canonical / "mxc-compat" / name).write_text(
                    "old recorded compatibility " + name
                )
        git = {}
        for name in [
            "bin/bash.exe",
            "bin/sh.exe",
            "usr/bin/bash.exe",
            "usr/bin/sh.exe",
            "usr/bin/msys-2.0.dll",
        ]:
            file = canonical / "git" / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text("canonical image " + name)
            git[name] = assembler.hash_file(file)[1]
        for name in [
            "hermes-agent/venv/Lib/site-packages/tool.py",
            "hermes-agent/LICENSE",
            "plugins/runtime.json",
            *assembler.LAYOUT["hermes"][1],
        ]:
            file = canonical / name
            file.parent.mkdir(parents=True, exist_ok=True)
            if not file.exists():
                file.write_text("official dynamic resource " + name)
        (canonical / "nemoclaw-windows-runtime.json").write_text(
            json.dumps(
                {
                    "manager": "nemoclaw-windows",
                    "hermesRevision": assembler.OFFICIAL_HERMES,
                }
            )
        )
        rows = assembler.inventory(canonical)
        metadata = self.root / "base-provenance"
        metadata.mkdir()

        def save(name, value):
            file = metadata / name
            file.write_text(json.dumps(value))
            size, sha = assembler.hash_file(file)
            return {"file": name, "bytes": size, "sha256": sha}

        inventory = save(
            "payload-inventory.json",
            {
                "files": [
                    {k: v for k, v in row.items() if k != "kind"}
                    for row in rows
                    if row["kind"] == "file"
                ],
                "directories": [r["path"] for r in rows if r["kind"] == "directory"],
            },
        )
        derivation = {
            key: save(name, {"fixture": name})
            for key, name in [
                ("pywinpty", "pywinpty-rebuild.json"),
                ("git", "canonical-git-derivation.json"),
                ("compatibility", "msys-build.json"),
                ("compatibilityProof", "bash-compatibility-proof.json"),
                ("mxc", "mxc-build.json"),
            ]
        }
        derivation_ref = save("candidate-derivation.json", derivation)
        candidate = {
            "classification": "official-hermes-runtime-candidate-build",
            "status": "candidate-bytes-exported",
            "controllerSource": "b" * 40,
            "completeByteInventory": True,
            "upstreamCommit": assembler.OFFICIAL_HERMES,
            "profile": "official-cli-web-tui-and-browser-use",
            "runtimeExecutionQualified": False,
            "sourceArchiveSha256": "c1f2401c8096e9372c46fa4ef8bdada18ed3cc84c0f5274562b86b7646ed3a87",
            "inventorySha256": inventory["sha256"],
            "derivation": derivation_ref,
        }
        candidate_ref = save("runtime-candidate.json", candidate)
        execution = {
            "exitCode": 0,
            "childClosed": True,
            "timedOut": False,
            "outputExceeded": False,
        }
        personal = {
            "classification": "canonical-personal-mxc-feasibility",
            "sourceRevision": "b" * 40,
            "candidateSource": "b" * 40,
            "feasibilityPassed": True,
            "privateStateLeaseTested": False,
            "installedAcceptance": False,
            "fullAgentQualified": False,
            "cleanupErrors": [],
            "error": None,
            "execution": execution,
            "cleanup": dict.fromkeys(
                [
                    "executorClosed",
                    "hostDiagnosticChildrenClosed",
                    "profileDeleted",
                    "ownedRootsRemoved",
                ],
                True,
            ),
            "derivedRuntime": {
                "candidate": {**candidate_ref, "value": candidate},
                "derivation": {"value": derivation},
            },
            "workload": {
                "passed": True,
                "components": [
                    {
                        "component": name,
                        "passed": True,
                        "execution": execution,
                        "result": {"component": name, "passed": True},
                    }
                    for name in ["python", "bash", "conpty", "browser"]
                ],
            },
        }
        helper = Path(assembler.__file__).parents[1] / "hermes/nemoclaw_browser_use.py"
        helper_bytes, helper_sha = assembler.hash_file(helper)
        identity = {"bytes": helper_bytes, "sha256": helper_sha}
        personal["browserUseLaunchAdapter"] = {
            key: dict(identity) for key in ("source", "staged", "document")
        }
        personal["workload"]["components"][-1]["result"][
            "browserLauncherAdaptation"
        ] = {
            "classification": "owned-browser-use-module-launch",
            "source": dict(identity),
            "trampolineBypassed": True,
            "runtimeBytesModified": False,
            "entryPointsSha256": "4" * 64,
            "moduleSha256": "9" * 64,
        }
        save("personal-feasibility.json", personal)
        proof = {
            "classification": "small-msys-appcontainer-compatibility-proof",
            "sourceRevision": "a" * 40,
            "passed": True,
            "normalCleanup": True,
            "phase": "two-container-isolation",
            "inputs": {
                "compatibility": compiled,
                "mxcBuild": build,
                "mxcSha256": build["files"][0]["sha256"],
                "git": git,
            },
        }
        proof_file = self.root / "native-proof.json"
        proof_file.write_text(json.dumps(proof))
        return (
            canonical,
            rows,
            metadata / "runtime-candidate.json",
            metadata / "personal-feasibility.json",
            compatibility,
            proof_file,
            executor,
            "a" * 40,
        )

    def test_compose_finished_native_bytes_preserves_canonical_runtime_and_both_lineages(
        self,
    ):
        args = self.composition_fixture()
        files, receipt = assembler.hermes_composition(*args)
        output = self.root / "composed"
        shutil.copytree(args[0], output)
        assembler.copy_hermes_composition(output, files)
        for row in args[1]:
            if row["kind"] == "file" and not row["path"].startswith("mxc-compat/"):
                self.assertEqual(
                    assembler.hash_file(output / row["path"]),
                    (row["bytes"], row["sha256"]),
                )
        self.assertEqual(receipt["sourceRevision"], "a" * 40)
        self.assertEqual(receipt["canonicalSource"], "b" * 40)
        self.assertFalse(receipt["installedAcceptance"])
        self.assertFalse(receipt["privateStateLeaseTested"])
        self.assertEqual(
            len([r for r in receipt["files"] if r["before"] is not None]), 4
        )
        self.assertEqual(
            (
                output / "mxc-compat/provenance/canonical/runtime-candidate.json"
            ).read_bytes(),
            args[2].read_bytes(),
        )
        self.assertEqual(
            (output / "mxc-compat/native-compatibility-proof.json").read_bytes(),
            args[5].read_bytes(),
        )

    def test_host_edge_admission_keeps_passing_personal_tools_and_requires_installed_acceptance(
        self,
    ):
        args = self.composition_fixture()
        personal = json.loads(args[3].read_text())
        personal.update(
            browserMode="host-native-edge-cdp",
            feasibilityPassed=False,
            installedAcceptanceRequired=True,
            edgePrerequisite={
                "classification": "native-arm64-microsoft-edge",
                "architecture": "arm64",
                "machine": 0xAA64,
                "signatureStatus": "Valid",
                "provenance": "standard-windows-microsoft-edge-installation",
                "executed": False,
            },
        )
        personal["workload"]["passed"] = False
        personal["execution"]["exitCode"] = 1
        browser = personal["workload"]["components"][-1]
        browser["passed"] = False
        browser["execution"] = {**browser["execution"], "exitCode": 1}
        args[3].write_text(json.dumps(personal))
        _, receipt = assembler.hermes_composition(*args)
        self.assertFalse(receipt["installedAcceptance"])
        self.assertEqual(receipt["browserMode"], "host-native-edge-cdp")
        personal["edgePrerequisite"]["architecture"] = "x64"
        args[3].write_text(json.dumps(personal))
        with self.assertRaisesRegex(ValueError, "host Edge build admission"):
            assembler.hermes_composition(*args)

    def test_browser_helper_must_match_actual_personal_source_and_application(self):
        args = self.replay_fixture()
        original = args[3].read_text()
        for section in ("source", "staged", "document"):
            record = json.loads(original)
            record["browserUseLaunchAdapter"][section]["sha256"] = "0" * 64
            args[3].write_text(json.dumps(record))
            with (
                self.subTest(section=section),
                self.assertRaisesRegex(ValueError, "same helper"),
            ):
                assembler.hermes_composition(*args)
        record = json.loads(original)
        record["workload"]["components"][-1]["result"]["browserLauncherAdaptation"][
            "source"
        ]["sha256"] = "0" * 64
        args[3].write_text(json.dumps(record))
        with self.assertRaisesRegex(ValueError, "same helper"):
            assembler.hermes_composition(*args)
        args[3].write_text(original)
        _, receipt = assembler.hermes_composition(*args)
        self.assertEqual(
            receipt["browserUseAdapter"]["personalProofSha256"],
            assembler.hash_file(args[3])[1],
        )

    def replay_fixture(self):
        args = self.composition_fixture()
        parent = args[3].parent

        def save(name, value):
            file = parent / name
            file.write_text(json.dumps(value))
            size, sha = assembler.hash_file(file)
            return {"file": name, "bytes": size, "sha256": sha}

        candidate = json.loads(args[2].read_text())
        candidate.update(
            fileCount=sum(row["kind"] == "file" for row in args[1]),
            logicalBytes=sum(row.get("bytes", 0) for row in args[1]),
            startupAdapterSha256=assembler.PERSONAL_REPLAY_BASE["startupAdapterSha256"],
        )
        reference = save(args[2].name, candidate)
        # The unit fixture contains tiny inert files. Only this test replaces
        # their immutable identities; production has no alternate pin option.
        pin = {
            **assembler.PERSONAL_REPLAY_BASE,
            "sourceRevision": candidate["controllerSource"],
            "candidateReceiptSha256": reference["sha256"],
            "inventorySha256": candidate["inventorySha256"],
        }
        patcher = mock.patch.object(assembler, "PERSONAL_REPLAY_BASE", pin)
        patcher.start()
        self.addCleanup(patcher.stop)
        personal = json.loads(args[3].read_text())
        personal["sourceRevision"] = "c" * 40
        personal["runtime"] = pin["runtimeRoot"]
        personal["derivedRuntime"]["candidate"] = {**reference, "value": candidate}
        nonce = "1234567890abcdef12345678"
        personal["workload"]["nonce"] = nonce
        native_root = "C:\\NemoClawPersonalCompat-" + nonce[:12]
        proof = json.loads(args[5].read_text())
        build = proof["inputs"]["compatibility"]
        mxc = proof["inputs"]["mxcBuild"]
        documents = {
            key: save(name, value)
            for key, name, value in (
                ("proof", "current-native-proof.json", proof),
                ("compatibility", "current-msys-build.json", build),
                ("mxc", "current-mxc-build.json", mxc),
            )
        }
        executor = {
            "path": r"C:\proof\wxc-exec.exe",
            "bytes": mxc["files"][0]["bytes"],
            "sha256": mxc["files"][0]["sha256"],
            "peMachine": 0xAA64,
            "architecture": "arm64",
        }
        personal["hostInputs"] = {
            "mxc": executor,
            "compatibility": {
                "sourceRevision": proof["sourceRevision"],
                "files": build["files"],
                "license": build["license"],
                "mxcFile": mxc["files"][0],
                "gitPins": proof["inputs"]["git"],
            },
        }
        personal["execution"]["executable"] = executor["path"]
        scan = {
            "allFilesAndDirectoriesVerified": True,
            "files": candidate["fileCount"],
            "logicalBytes": candidate["logicalBytes"],
            "inventorySha256": candidate["inventorySha256"],
            "elapsedMs": 1,
        }
        personal["runtimeReplay"] = {
            "schemaVersion": 1,
            "classification": "immutable-canonical-hermes-personal-replay",
            "controllerSource": personal["sourceRevision"],
            "base": pin,
            "runtimeRoot": pin["runtimeRoot"],
            "completeZipVerified": True,
            "completeNestedArchiveVerified": True,
            "sourceBuildProvenanceVerified": True,
            "before": scan,
            "after": scan,
            "runtimeRebuilt": False,
            "runtimeRelocated": False,
            "runtimeExported": False,
            "runtimeExecutionQualified": False,
            "installedAcceptance": False,
            "nativeComponentUnchanged": True,
            "nativeComponent": {
                "root": native_root,
                "sourceRevision": proof["sourceRevision"],
                "proof": documents["proof"],
                "build": documents["compatibility"],
                "executor": executor,
                "documents": documents,
                "files": [
                    {**row, "path": native_root + "\\" + row["file"]}
                    for row in [
                        *build["files"],
                        build["license"],
                        {**documents["compatibility"], "file": "build-receipt.json"},
                    ]
                ],
            },
        }
        request = {
            "containerId": "nm-" + nonce[:12] + "-start",
            "process": {
                "commandLine": '"'
                + native_root
                + '\\NemoClawMsysLauncher.exe" "--" "node.exe"',
                "cwd": "C:\\NemoClawMsysProof-" + nonce[:12] + "-state-start",
            },
            "filesystem": {
                "readonlyPaths": [pin["runtimeRoot"], native_root],
                "readwritePaths": [
                    "C:\\NemoClawMsysProof-" + nonce[:12] + "-state-start"
                ],
            },
        }
        personal["requestSha256"] = save("personal-request.json", request)["sha256"]
        save(args[3].name, personal)
        return args

    def test_replay_composes_three_separate_lineages_with_unchanged_canonical_bytes(
        self,
    ):
        args = self.replay_fixture()
        files, receipt = assembler.hermes_composition(*args)
        output = self.root / "replay-composed"
        shutil.copytree(args[0], output)
        assembler.copy_hermes_composition(output, files)
        self.assertEqual(receipt["canonicalSource"], "b" * 40)
        self.assertEqual(receipt["personalSource"], "c" * 40)
        self.assertEqual(receipt["sourceRevision"], "a" * 40)
        self.assertFalse(receipt["installedAcceptance"])
        for row in args[1]:
            if row["kind"] == "file" and not row["path"].startswith("mxc-compat/"):
                self.assertEqual(
                    assembler.hash_file(output / row["path"]),
                    (row["bytes"], row["sha256"]),
                )
        prefix = output / "mxc-compat/provenance/canonical"
        for name in (
            "current-native-proof.json",
            "current-msys-build.json",
            "current-mxc-build.json",
            "personal-request.json",
        ):
            self.assertEqual(
                (prefix / "personal-replay" / name).read_bytes(),
                (args[3].parent / name).read_bytes(),
            )
        self.assertEqual(
            (prefix / "mxc-build.json").read_bytes(),
            (args[2].parent / "mxc-build.json").read_bytes(),
        )

    def test_replay_rejects_unbound_controller_base_and_incomplete_post_inventory(self):
        args = self.replay_fixture()
        original = args[3].read_text()
        cases = (
            lambda p: p.pop("runtimeReplay"),
            lambda p: p["runtimeReplay"]["base"].update(artifactId=1),
            lambda p: p["runtimeReplay"]["base"].update(
                candidateReceiptSha256="0" * 64
            ),
            lambda p: p["runtimeReplay"].update(controllerSource="d" * 40),
            lambda p: p["runtimeReplay"].update(runtimeRebuilt=True),
            lambda p: p["runtimeReplay"].update(after=None),
            lambda p: p["runtimeReplay"]["after"].update(
                allFilesAndDirectoriesVerified=False
            ),
            lambda p: p["runtimeReplay"]["before"].update(inventorySha256="0" * 64),
            lambda p: p["runtimeReplay"]["after"].update(files=0),
            lambda p: p["runtimeReplay"].update(nativeComponentUnchanged=False),
        )
        for index, mutate in enumerate(cases):
            with self.subTest(case=index):
                personal = json.loads(original)
                mutate(personal)
                args[3].write_text(json.dumps(personal))
                with self.assertRaises(ValueError):
                    assembler.hermes_composition(*args)

    def test_replay_requires_bound_current_documents_and_executed_identities(self):
        args = self.replay_fixture()
        original = args[3].read_text()
        cases = (
            lambda p: p["runtimeReplay"]["nativeComponent"]["documents"].pop("proof"),
            lambda p: p["runtimeReplay"]["nativeComponent"]["documents"]["mxc"].update(
                sha256="0" * 64
            ),
            lambda p: p["runtimeReplay"]["nativeComponent"]["proof"].update(bytes=1),
            lambda p: p["runtimeReplay"]["nativeComponent"]["executor"].update(
                sha256="0" * 64
            ),
            lambda p: p["runtimeReplay"]["nativeComponent"]["files"][0].update(
                path=r"C:\host\launcher.exe"
            ),
            lambda p: p["runtimeReplay"]["nativeComponent"]["files"][0].update(
                sha256="0" * 64
            ),
            lambda p: p["hostInputs"]["compatibility"].update(sourceRevision="d" * 40),
            lambda p: p["execution"].update(executable=r"C:\host\wxc-exec.exe"),
            lambda p: p.update(requestSha256="0" * 64),
        )
        for index, mutate in enumerate(cases):
            with self.subTest(case=index):
                personal = json.loads(original)
                mutate(personal)
                args[3].write_text(json.dumps(personal))
                with self.assertRaises(ValueError):
                    assembler.hermes_composition(*args)

    def test_replay_requires_real_component_passes_cleanup_and_final_same_source_proof(
        self,
    ):
        args = self.replay_fixture()
        original = args[3].read_text()
        cases = [
            lambda p, i=i: p["workload"]["components"][i]["result"].update(passed=False)
            for i in range(4)
        ]
        cases += [
            lambda p, key=key: p["cleanup"].update({key: False})
            for key in (
                "executorClosed",
                "hostDiagnosticChildrenClosed",
                "profileDeleted",
                "ownedRootsRemoved",
            )
        ]
        for index, mutate in enumerate(cases):
            with self.subTest(case=index):
                personal = json.loads(original)
                mutate(personal)
                args[3].write_text(json.dumps(personal))
                with self.assertRaisesRegex(ValueError, "Personal component"):
                    assembler.hermes_composition(*args)
        args[3].write_text(original)
        with self.assertRaisesRegex(ValueError, "same-source"):
            assembler.hermes_composition(*args[:-1], "d" * 40)

    def test_replay_rejects_a_bound_but_failed_native_proof_or_different_launch(self):
        args = self.replay_fixture()
        original = args[3].read_text()
        for name, field in (
            ("current-native-proof.json", "passed"),
            ("personal-request.json", "commandLine"),
            ("personal-request.json", "cwd"),
            ("personal-request.json", "readwritePaths"),
        ):
            with self.subTest(document=name, field=field):
                personal = json.loads(original)
                file = args[3].parent / name
                original_document = file.read_bytes()
                value = json.loads(original_document)
                if name == "current-native-proof.json":
                    value["passed"] = False
                elif field == "commandLine":
                    value["process"]["commandLine"] = (
                        '"C:\\host\\launcher.exe" "--" "node.exe"'
                    )
                elif field == "cwd":
                    value["process"]["cwd"] = r"C:\host"
                else:
                    value["filesystem"]["readwritePaths"].append(r"C:\host")
                file.write_text(json.dumps(value))
                size, sha = assembler.hash_file(file)
                if name == "current-native-proof.json":
                    personal["runtimeReplay"]["nativeComponent"]["documents"][
                        "proof"
                    ].update(bytes=size, sha256=sha)
                    personal["runtimeReplay"]["nativeComponent"]["proof"].update(
                        bytes=size, sha256=sha
                    )
                else:
                    personal["requestSha256"] = sha
                args[3].write_text(json.dumps(personal))
                with self.assertRaises(ValueError):
                    assembler.hermes_composition(*args)
                file.write_bytes(original_document)

    def test_actual_assembler_uses_verified_copied_provenance_before_partition_bytecode_seal(
        self,
    ):
        args = self.composition_fixture()
        stages = []

        def finalized(root, target, inventory_file, diagnostics, browser_use_adapter):
            self.assertEqual(
                inventory_file,
                root / "mxc-compat/provenance/canonical/payload-inventory.json",
            )
            self.assertEqual(
                inventory_file.read_bytes(),
                args[2].with_name("payload-inventory.json").read_bytes(),
            )
            self.assertEqual(
                (root / "mxc-compat/NemoClawMsysLauncher.exe").read_bytes(),
                (args[4] / "NemoClawMsysLauncher.exe").read_bytes(),
            )
            self.assertEqual(
                browser_use_adapter["sha256"],
                assembler.hash_file(
                    Path(assembler.__file__).parents[1]
                    / "hermes/nemoclaw_browser_use.py"
                )[1],
            )
            stages.append("partition")
            return {"productionPartition": {"fixture": True}}

        def bytecode(root, evidence):
            self.assertEqual(stages, ["partition"])
            composition = json.loads((root / "mxc-compat/composition.json").read_text())
            self.assertEqual(composition["sourceRevision"], "a" * 40)
            self.assertEqual(
                (root / "mxc-compat/wxc-exec.exe").read_bytes(),
                (args[6] / "wxc-exec.exe").read_bytes(),
            )
            self.assertTrue(
                (
                    root / "mxc-compat/provenance/canonical/personal-feasibility.json"
                ).is_file()
            )
            stages.append("bytecode")
            return {"fixture": True}

        with (
            mock.patch.object(assembler, "python_workers", return_value=[]),
            mock.patch.object(assembler, "finalize_hermes", side_effect=finalized),
            mock.patch.object(
                assembler, "prepare_hermes_bytecode", side_effect=bytecode
            ),
        ):
            receipt = assembler.assemble(
                self.output,
                {"hermes": args[0]},
                self.node,
                "22.23.2",
                "a" * 40,
                "b" * 64,
                self.namespace,
                worker_build=self.workers,
                executable_build=self.sea,
                hermes_receipt=args[2],
                hermes_personal_proof=args[3],
                hermes_compatibility=args[4],
                hermes_compatibility_proof=args[5],
                hermes_executor=args[6],
                target_install_root=r"C:\Program Files\NVIDIA\NemoClaw",
            )
        self.assertEqual(stages, ["partition", "bytecode"])
        root = self.output / receipt["runtimeInstalledPath"]
        self.assertFalse((root / "openclaw").exists())
        self.assertIn(
            b"hermes/mxc-compat/composition.json".hex().encode(),
            (root / "runtime.manifest").read_bytes(),
        )
        self.assertFalse(receipt["installedAcceptance"])

    def test_compose_rejects_failed_personal_components_or_wrong_native_source(self):
        args = self.composition_fixture()
        personal = json.loads(args[3].read_text())
        personal["workload"]["components"][1]["result"]["passed"] = False
        args[3].write_text(json.dumps(personal))
        with self.assertRaisesRegex(ValueError, "Personal component"):
            assembler.hermes_composition(*args)
        personal["workload"]["components"][1]["result"]["passed"] = True
        args[3].write_text(json.dumps(personal))
        proof = json.loads(args[5].read_text())
        proof["sourceRevision"] = "c" * 40
        args[5].write_text(json.dumps(proof))
        with self.assertRaisesRegex(ValueError, "same-source"):
            assembler.hermes_composition(*args)

    def test_compose_rejects_changed_base_native_source_and_git_identity(self):
        args = self.composition_fixture()
        original = (args[0] / "plugins/runtime.json").read_bytes()
        (args[0] / "plugins/runtime.json").write_bytes(b"changed canonical plugin")
        with self.assertRaisesRegex(ValueError, "complete official runtime bytes"):
            assembler.hermes_composition(
                args[0], assembler.inventory(args[0]), *args[2:]
            )
        (args[0] / "plugins/runtime.json").write_bytes(original)
        source = assembler.NATIVE_SOURCE_ROOT / "process-propagation.cpp"
        source.write_bytes(b"changed after native proof")
        with self.assertRaisesRegex(ValueError, "source differs"):
            assembler.hermes_composition(*args)
        source.write_text("source fixture process-propagation.cpp")
        proof = json.loads(args[5].read_text())
        proof["inputs"]["git"]["usr/bin/bash.exe"] = "0" * 64
        args[5].write_text(json.dumps(proof))
        with self.assertRaisesRegex(ValueError, "different canonical Git"):
            assembler.hermes_composition(*args)

    def test_compose_rejects_changes_after_preflight_and_during_copy(self):
        args = self.composition_fixture()
        files, _ = assembler.hermes_composition(*args)
        output = self.root / "composed"
        shutil.copytree(args[0], output)
        binary = files[0][0]
        original = binary.read_bytes()
        binary.write_bytes(b"changed after preflight")
        with self.assertRaisesRegex(ValueError, "after preflight"):
            assembler.copy_hermes_composition(output, files)
        self.assertFalse((output / files[0][1]).exists())
        binary.write_bytes(original)
        copy = assembler.shutil.copyfileobj

        def changed(incoming, outgoing):
            copy(incoming, outgoing)
            binary.write_bytes(b"changed during copy")

        with mock.patch.object(assembler.shutil, "copyfileobj", side_effect=changed):
            with self.assertRaisesRegex(ValueError, "during copy"):
                assembler.copy_hermes_composition(output, files)

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
