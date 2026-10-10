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
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
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

    def test_exact_uv_cache_metadata_requires_valid_record_and_rejects_other_extras(
        self,
    ):
        relative = helper.DIST + "uv_cache.json"
        name = helper.SITE + relative
        cache = self.runtime / name
        content = b'{"timestamp":{"secs_since_epoch":1,"nanos_since_epoch":0}}'
        cache.write_bytes(content)
        record = self.runtime / (helper.SITE + helper.DIST + "RECORD")
        output = io.StringIO()
        encoded = "sha256=" + base64.urlsafe_b64encode(
            hashlib.sha256(content).digest()
        ).decode().rstrip("=")
        csv.writer(output, lineterminator="\n").writerow(
            [relative, encoded, len(content)]
        )
        record.write_text(record.read_text() + output.getvalue())
        self.after["files"].append({"path": name, **identity(content)})
        next(
            row
            for row in self.after["files"]
            if row["path"] == helper.SITE + helper.DIST + "RECORD"
        ).update(identity(record.read_bytes()))
        self.replacement = helper.validate_delta(
            self.before, self.after, self.wheel_files
        )
        receipt = self.successful_receipt()
        helper.validate_rebuild_receipt(self.runtime, receipt, self.evidence)
        cache.write_bytes(content + b" ")
        with self.assertRaisesRegex(ValueError, "Current pywinpty closure changed"):
            helper.validate_rebuild_receipt(self.runtime, receipt, self.evidence)
        cache.write_bytes(content)
        original_record = record.read_text()
        for changed in [
            original_record.replace(encoded, "sha256=" + "A" * 43),
            original_record.replace(
                output.getvalue(),
                output.getvalue().replace(str(len(content)), str(len(content) + 1)),
            ),
        ]:
            record.write_text(changed)
            with self.assertRaisesRegex(
                ValueError, "Installed RECORD hash/size mismatch"
            ):
                helper.validate_installed_record(
                    self.runtime, self.replacement["installedFiles"]
                )
        record.write_text(original_record)
        changed = copy.deepcopy(self.after)
        changed["files"].append(
            {"path": helper.SITE + helper.DIST + "unrelated.json", **identity(b"{}")}
        )
        with self.assertRaisesRegex(ValueError, "Unlisted new pywinpty file"):
            helper.validate_delta(self.before, changed, self.wheel_files)

    def test_rejected_delta_retains_exact_after_inventory_and_installed_record(self):
        after = copy.deepcopy(self.after)
        unexpected = helper.SITE + helper.DIST + "unlisted-metadata.json"
        after["files"].append({"path": unexpected, **identity(b"unexpected")})
        tree = ast.parse((HERE / "rebuild-pywinpty-conpty.py").read_text())
        main = next(
            node
            for node in tree.body
            if isinstance(node, ast.FunctionDef) and node.name == "main"
        )
        body = next(node.body for node in main.body if isinstance(node, ast.Try))
        start = next(
            i
            for i, node in enumerate(body)
            if isinstance(node, ast.Assign) and ast.unparse(node.targets[0]) == "after"
        )
        end = next(
            i + 1
            for i, node in enumerate(body)
            if isinstance(node, ast.Assign)
            and ast.unparse(node.targets[0]) == "receipt['replacement']"
        )
        receipt = {}
        context = {
            "owner": SimpleNamespace(inventory=lambda runtime: after),
            "runtime": self.runtime,
            "output": self.evidence,
            "receipt": receipt,
            "before": self.before,
            "wheel_files": self.wheel_files,
            "save": helper.save,
            "digest": helper.digest,
            "validate_delta": helper.validate_delta,
            "SITE": helper.SITE,
            "DIST": helper.DIST,
        }
        with self.assertRaises(ValueError) as caught:
            exec(
                compile(
                    ast.Module(body=body[start:end], type_ignores=[]),
                    str(HERE / "rebuild-pywinpty-conpty.py"),
                    "exec",
                ),
                context,
            )
        self.assertIn(unexpected, str(caught.exception))
        self.assertNotIn("replacement", receipt)
        self.assertNotIn("status", receipt)
        inventory = self.evidence / "after-inventory.json"
        self.assertEqual(json.loads(inventory.read_text()), after)
        self.assertEqual(receipt["afterInventorySha256"], helper.digest(inventory))
        installed = self.evidence / receipt["installedRecord"]["file"]
        self.assertEqual(
            installed.read_bytes(),
            (self.runtime / (helper.SITE + helper.DIST + "RECORD")).read_bytes(),
        )
        self.assertEqual(receipt["installedRecord"]["bytes"], installed.stat().st_size)
        self.assertEqual(receipt["installedRecord"]["sha256"], helper.digest(installed))

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

    def test_bootstrap_install_excludes_runtime_overrides_until_target_build(self):
        provision = helper.load("provision-official-runtime")
        with patch.dict(
            os.environ,
            SystemRoot=str(self.root / "Windows"),
            UV_CONFIG_FILE="unrelated-host-config",
            UV_BUILD_CONSTRAINT="unrelated-host-constraints",
        ):
            environment = provision.clean_environment(self.runtime, self.evidence, [])
        self.assertNotIn("UV_CONFIG_FILE", environment)
        self.assertNotIn("UV_BUILD_CONSTRAINT", environment)
        tree = ast.parse((HERE / "rebuild-pywinpty-conpty.py").read_text())
        main = next(
            node
            for node in tree.body
            if isinstance(node, ast.FunctionDef) and node.name == "main"
        )
        body = next(node.body for node in main.body if isinstance(node, ast.Try))
        start = next(
            i + 1
            for i, node in enumerate(body)
            if isinstance(node, ast.Assign)
            and ast.unparse(node.targets[0]) == "receipt['configuration']"
        )

        def run_label(node):
            if (
                isinstance(node, ast.Expr)
                and isinstance(node.value, ast.Call)
                and isinstance(node.value.func, ast.Name)
                and node.value.func.id == "run"
            ):
                return node.value.args[2].value
            return None

        end = next(
            i + 1 for i, node in enumerate(body) if run_label(node) == "build-wheel"
        )
        config = self.evidence / "pywinpty-build.uv.toml"
        config_bytes = b'override-dependencies = ["pynacl>=1.6,<1.7"]\n[config-settings-package.pywinpty]\nbuild-args = "--features winpty-rs/conpty --locked"\n'
        config.write_bytes(config_bytes)
        lock = json.loads((HERE / "official-python.lock.json").read_text())
        calls = []

        def record(executable, arguments, label, **kwargs):
            calls.append((label, executable, arguments, dict(environment), kwargs))

        context = {
            "run": record,
            "environment": environment,
            "config": config,
            "HERE": HERE,
            "lock": lock,
            "uv": self.evidence / "tools/uv.exe",
            "bootstrap": self.root / "bootstrap/python.exe",
            "build_env": self.evidence / "build-env",
            "downloads": self.evidence / "downloads",
            "wheels": self.evidence / "wheels",
            "source": self.evidence / "source",
        }
        exec(
            compile(
                ast.Module(body=body[start:end], type_ignores=[]),
                str(HERE / "rebuild-pywinpty-conpty.py"),
                "exec",
            ),
            context,
        )
        self.assertEqual(
            [row[0] for row in calls],
            ["build-environment", "build-requirements", "build-wheel"],
        )
        for call in calls[:2]:
            self.assertNotIn("UV_CONFIG_FILE", call[3])
            self.assertNotIn("UV_BUILD_CONSTRAINT", call[3])
        requirements = HERE / lock["requirementsFile"]
        self.assertEqual(
            calls[1][2],
            [
                "pip",
                "install",
                "--python",
                context["build_env"] / "Scripts/python.exe",
                "--no-index",
                "--find-links",
                context["downloads"],
                "--require-hashes",
                "-r",
                requirements,
            ],
        )
        self.assertEqual(helper.digest(requirements), lock["requirementsSha256"])
        self.assertEqual(len(lock["artifacts"]), 4)
        self.assertEqual(calls[2][3]["UV_CONFIG_FILE"], str(config))
        self.assertEqual(calls[2][3]["UV_BUILD_CONSTRAINT"], str(requirements))
        self.assertEqual(calls[2][2][:3], ["-I", "-B", "-c"])
        self.assertEqual(calls[2][4], {"cwd": context["source"]})
        replacement = next(
            node for node in body if run_label(node) == "replace-pywinpty"
        )
        context.update(runtime=self.runtime, wheel=self.wheel)
        exec(
            compile(
                ast.Module(body=[replacement], type_ignores=[]), "replacement", "exec"
            ),
            context,
        )
        self.assertEqual(
            calls[3][2],
            [
                "pip",
                "install",
                "--python",
                self.runtime / "hermes-agent/venv/Scripts/python.exe",
                "--no-index",
                "--no-deps",
                "--reinstall-package",
                "pywinpty",
                self.wheel,
            ],
        )
        self.assertEqual(calls[3][3], calls[2][3])
        self.assertEqual(config.read_bytes(), config_bytes)

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
