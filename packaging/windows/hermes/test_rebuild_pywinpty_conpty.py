# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Portable wheel/closure controls; no package build or Windows payload execution."""

import ast
import base64
import copy
import csv
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location(
    "targeted_pywinpty", HERE / "rebuild-pywinpty-conpty.py"
)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


def identity(data):
    return {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}


class TargetedPywinpty(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.evidence = self.root / "evidence"
        (self.evidence / "wheels").mkdir(parents=True)
        self.runtime = self.root / "runtime"
        self.runtime.mkdir()
        binary = bytearray(80)
        binary[:2] = b"MZ"
        binary[60:64] = (64).to_bytes(4, "little")
        binary[64:70] = b"PE\0\0\x64\xaa"
        self.payload = {
            "winpty/__init__.py": b"# source fixture, not executed\n",
            "winpty/winpty.cp311-win_arm64.pyd": bytes(binary),
            helper.DIST + "METADATA": b"Name: pywinpty\nVersion: 2.0.15\n",
            helper.DIST
            + "WHEEL": b"Wheel-Version: 1.0\nRoot-Is-Purelib: false\nTag: cp311-cp311-win_arm64\n",
            helper.DIST + "licenses/LICENSE.txt": b"retained MIT license fixture\n",
        }
        self.wheel = self.evidence / "wheels/pywinpty-2.0.15-cp311-cp311-win_arm64.whl"
        self.write_wheel()
        self.wheel_files = helper.verify_wheel(self.wheel)
        outside = {
            "git/etc/hosts": b"existing initialized Git state",
            "other-package/module.py": b"unchanged",
        }
        self.before = {
            "files": [
                {"path": name, **identity(data)} for name, data in outside.items()
            ],
            "directories": ["git", "git/etc", "other-package", "retained-empty"],
            "licenseFiles": [helper.SITE + helper.DIST + "licenses/LICENSE.txt"],
        }
        self.before["files"] += [
            {"path": helper.NATIVE, **identity(b"old extension fixture")},
            {
                "path": helper.SITE + helper.DIST + "licenses/LICENSE.txt",
                **identity(self.payload[helper.DIST + "licenses/LICENSE.txt"]),
            },
        ]
        self.after = {
            **self.before,
            "files": [
                row
                for row in self.before["files"]
                if not helper.in_package(row["path"])
            ]
            + [{"path": name, **value} for name, value in self.wheel_files.items()],
        }
        for name, data in {
            **outside,
            **{helper.SITE + name: data for name, data in self.payload.items()},
        }.items():
            file = self.runtime / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(data)
        package_dirs = {
            str(parent)
            for name in self.wheel_files
            for parent in Path(name).parents
            if helper.in_package(str(parent))
        }
        self.before["directories"] = sorted(
            set(self.before["directories"]) | package_dirs
        )
        self.after["directories"] = list(self.before["directories"])
        self.replacement = helper.validate_delta(
            self.before, self.after, self.wheel_files
        )

    def write_wheel(self, extra=None, stale_record=False):
        output = io.StringIO()
        writer = csv.writer(output, lineterminator="\n")
        for name, data in self.payload.items():
            if name == helper.DIST + "RECORD":
                continue
            encoded = (
                base64.urlsafe_b64encode(hashlib.sha256(data).digest())
                .decode()
                .rstrip("=")
            )
            writer.writerow([name, "sha256=" + encoded, len(data)])
        writer.writerow([helper.DIST + "RECORD", "", ""])
        if not stale_record:
            self.payload[helper.DIST + "RECORD"] = output.getvalue().encode()
        with zipfile.ZipFile(self.wheel, "w") as archive:
            for name, data in self.payload.items():
                archive.writestr(name, data)
            if extra:
                archive.writestr(*extra)

    def successful_receipt(self):
        helper.save(self.evidence / "before-inventory.json", self.before)
        helper.save(self.evidence / "after-inventory.json", self.after)
        config = b'[config-settings-package.pywinpty]\nbuild-args = "--features winpty-rs/conpty --locked"\n'
        (self.evidence / "pywinpty-build.uv.toml").write_bytes(config)
        smoke = {
            "classification": "ci-built-pywinpty-conpty-smoke",
            "status": "pass",
            "backend": "ConPTY",
            "pythonVersion": "3.11.16",
            "pywinptyVersion": "2.0.15",
            "nativeModuleMachine": "0xaa64",
            "nativeModule": "C:\\owned\\" + helper.NATIVE.replace("/", "\\"),
            "nativeModuleSha256": self.wheel_files[helper.NATIVE]["sha256"],
            "exitCode": 0,
            **dict.fromkeys(
                [
                    "constructorSucceeded",
                    "spawnSucceeded",
                    "outputContainsSentinel",
                    "childExitObserved",
                    "cleanupPassed",
                ],
                True,
            ),
        }
        helper.save(self.evidence / "conpty-smoke.json", smoke)
        processes = []
        for name in [
            "rust-version",
            "cargo-version",
            "build-environment",
            "build-requirements",
            "build-wheel",
            "replace-pywinpty",
            "conpty-smoke",
        ]:
            file = self.evidence / (name + ".process.json")
            helper.save(file, {"passed": True, "exitCode": 0, "cleanupErrors": []})
            processes.append({"file": file.name, "sha256": helper.digest(file)})
        return {
            "schemaVersion": 1,
            "classification": "ci-targeted-pywinpty-conpty-rebuild",
            "status": "pass",
            "runtimeRoot": "C:\\owned",
            "base": {
                "zipSha256": helper.BASE_ZIP_SHA,
                "artifactId": 10181796438,
                "runId": 34551706967,
                "sourceRevision": helper.BASE_HEAD,
            },
            "source": {
                **helper.SOURCE,
                "cargoLockSha256": helper.CARGO_LOCK_SHA,
                "sourceUnchanged": True,
            },
            "configuration": {
                "maturinBuildArgs": "--features winpty-rs/conpty --locked",
                "configurationSha256": identity(config)["sha256"],
                "upstreamUvSettingsPreserved": True,
                "globalRustFlagsChanged": False,
                "upstreamSourcesChanged": False,
            },
            "beforeInventorySha256": helper.digest(
                self.evidence / "before-inventory.json"
            ),
            "afterInventorySha256": helper.digest(
                self.evidence / "after-inventory.json"
            ),
            "wheel": {
                "file": "wheels/" + self.wheel.name,
                **identity(self.wheel.read_bytes()),
            },
            "replacement": self.replacement,
            "smoke": {
                "file": "conpty-smoke.json",
                "sha256": helper.digest(self.evidence / "conpty-smoke.json"),
                "nativeModuleSha256": smoke["nativeModuleSha256"],
            },
            "processReceipts": processes,
            "allOwnedProcessesClosed": True,
            "installedAcceptance": False,
            "fullAgentQualified": False,
            **dict.fromkeys(
                [
                    "allOtherFilesUnchanged",
                    "allOtherDirectoriesUnchanged",
                    "buildToolsOutsideRuntime",
                    "noRuntimeDependencyResolution",
                ],
                True,
            ),
        }

    def test_complete_wheel_record_and_exact_distribution_replacement(self):
        self.assertEqual(helper.verify_wheel(self.wheel), self.wheel_files)
        helper.validate_installed_record(
            self.runtime, self.replacement["installedFiles"]
        )
        self.assertIn(helper.NATIVE, self.replacement["changed"])
        self.assertFalse(
            any(path.startswith("git/") for path in self.replacement["changed"])
        )

    def test_wheel_rejects_foreign_paths_duplicate_members_and_changed_record(self):
        for extra in [
            ("../outside", b"x"),
            ("other-package/file.py", b"x"),
            ("../outside/", b""),
            ("winpty/__init__.py", b"duplicate"),
        ]:
            with self.subTest(extra=extra[0]):
                self.write_wheel(extra)
                with self.assertRaises(ValueError):
                    helper.verify_wheel(self.wheel)
        self.payload["winpty/__init__.py"] += b"changed"
        self.write_wheel(stale_record=True)
        with self.assertRaisesRegex(ValueError, "RECORD hash/size"):
            helper.verify_wheel(self.wheel)

    def test_wrong_wheel_platform_and_extension_architecture_are_refused(self):
        original = copy.deepcopy(self.payload)
        for name, data in [
            (
                helper.DIST + "WHEEL",
                b"Root-Is-Purelib: false\nTag: cp311-cp311-win_amd64\n",
            ),
            ("winpty/winpty.cp311-win_arm64.pyd", b"not an ARM64 PE"),
        ]:
            self.payload = copy.deepcopy(original)
            self.payload[name] = data
            self.write_wheel()
            with self.subTest(name=name), self.assertRaises(ValueError):
                helper.verify_wheel(self.wheel)

    def test_other_files_empty_directories_unlisted_package_files_and_licenses_are_preserved(
        self,
    ):
        mutations = [
            lambda value: value["files"][0].update(sha256="0" * 64),
            lambda value: value["directories"].remove("retained-empty"),
            lambda value: value["files"].append(
                {"path": helper.SITE + "winpty/unlisted.py", **identity(b"x")}
            ),
            lambda value: value["files"].remove(
                next(
                    row for row in value["files"] if row["path"].endswith("LICENSE.txt")
                )
            ),
        ]
        for mutate in mutations:
            changed = copy.deepcopy(self.after)
            mutate(changed)
            with self.assertRaises(ValueError):
                helper.validate_delta(self.before, changed, self.wheel_files)

    def test_export_validator_checks_current_package_and_keeps_later_git_composition_separate(
        self,
    ):
        receipt = self.successful_receipt()
        self.assertIs(
            helper.validate_rebuild_receipt(self.runtime, receipt, self.evidence),
            receipt,
        )
        (self.runtime / "git/etc/hosts").write_bytes(
            b"separately recorded later composition"
        )
        helper.validate_rebuild_receipt(self.runtime, receipt, self.evidence)
        extra = self.runtime / (helper.SITE + "winpty/unlisted.py")
        extra.write_bytes(b"unlisted later change")
        with self.assertRaises(ValueError):
            helper.validate_rebuild_receipt(self.runtime, receipt, self.evidence)
        extra.unlink()
        (self.runtime / helper.NATIVE).write_bytes(b"changed after wheel proof")
        with self.assertRaises(ValueError):
            helper.validate_rebuild_receipt(self.runtime, receipt, self.evidence)

    def test_failed_process_smoke_or_mutated_evidence_cannot_qualify(self):
        receipt = self.successful_receipt()
        for key in [
            "allOwnedProcessesClosed",
            "allOtherFilesUnchanged",
            "buildToolsOutsideRuntime",
            "noRuntimeDependencyResolution",
        ]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                helper.validate_rebuild_receipt(
                    self.runtime, {**receipt, key: False}, self.evidence
                )
        process = self.evidence / receipt["processReceipts"][0]["file"]
        original = process.read_bytes()
        process.write_text(
            json.dumps({"passed": False, "exitCode": 1, "cleanupErrors": []})
        )
        changed = copy.deepcopy(receipt)
        changed["processReceipts"][0]["sha256"] = helper.digest(process)
        with self.assertRaisesRegex(ValueError, "Build process failed"):
            helper.validate_rebuild_receipt(self.runtime, changed, self.evidence)
        process.write_bytes(original)
        (self.evidence / "conpty-smoke.json").write_text("{}")
        with self.assertRaises(ValueError):
            helper.validate_rebuild_receipt(self.runtime, receipt, self.evidence)

    def test_platform_guard_prevents_any_local_build_or_runtime_mutation(self):
        if sys.platform == "win32":
            self.skipTest("This control observes the non-Windows refusal")
        output = self.root / "must-not-be-created"
        result = subprocess.run(
            [
                sys.executable,
                "-I",
                "-B",
                str(HERE / "rebuild-pywinpty-conpty.py"),
                "--runtime-root",
                str(self.runtime),
                "--base-zip",
                str(self.root / "not-read.zip"),
                "--adaptation-receipt",
                str(self.root / "not-read.json"),
                "--artifact-directory",
                str(output),
                "--rust-bin-directory",
                str(self.root / "not-read"),
            ],
            capture_output=True,
            timeout=10,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(output.exists())

    def test_reused_conpty_child_disables_bytecode_without_changing_smoke_gate(self):
        tree = ast.parse((HERE / "pywinpty-conpty.py").read_text())
        commands = [
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "list2cmdline"
        ]
        self.assertEqual(len(commands), 1)
        self.assertEqual(
            [item.value for item in commands[0].args[0].elts[:3]], ["-I", "-B", "-c"]
        )


if __name__ == "__main__":
    unittest.main()
