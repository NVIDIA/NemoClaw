# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import tomllib
import unittest
import unittest.mock

SPEC = importlib.util.spec_from_file_location(
    "host_builder", Path(__file__).with_name("prepare-finished-host.py")
)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def executable(machine=b"\x64\xaa"):
    result = bytearray(256)
    result[:2] = b"MZ"
    result[60:64] = (128).to_bytes(4, "little")
    result[128:134] = b"PE\0\0" + machine
    return bytes(result)


class NativeHostInputs(unittest.TestCase):
    def openshell_build(self, root):
        native = root / "native"
        native.mkdir()
        source = Path(__file__).resolve().parents[3]
        files = []
        for name in MODULE.OPENSHELL_FILES:
            binary = native / name
            binary.write_bytes(executable())
            files.append(
                {
                    "file": name,
                    "bytes": binary.stat().st_size,
                    "sha256": MODULE.digest(binary),
                }
            )
        build = {
            "schemaVersion": 1,
            "classification": "ci-built-openshell-host-binaries",
            "requestedSourceRevision": "a" * 40,
            "openshellRevision": MODULE.OPENSHELL_SOURCE,
            "derivativePatchSha256": MODULE._SOURCE_MODULE.load_lock()["patchSha256"],
            "sourceTree": MODULE._SOURCE_MODULE.load_lock()["patchedTree"],
            "sourceUnchanged": True,
            "rustToolchain": "1.95.0-aarch64-pc-windows-msvc",
            "rustTarget": "aarch64-pc-windows-msvc",
            "workflowRunId": "1234",
            "workflowRunAttempt": "2",
            "currentPackageQualification": False,
            "files": files,
        }
        return native, source, build

    def verify_build(self, native, source, build, run_id="1234", attempt="2"):
        (native / "openshell-build.json").write_text(
            json.dumps(build), encoding="utf-8"
        )
        return MODULE.verify_openshell_build(native, "a" * 40, run_id, attempt)

    def test_openshell_admission_requires_the_same_source_build_and_workflow_attempt(self):
        with tempfile.TemporaryDirectory() as value:
            native, source, build = self.openshell_build(Path(value))
            self.assertEqual(self.verify_build(native, source, build), build)
            replacements = {
                "schemaVersion": 2,
                "classification": "downloaded-binaries",
                "requestedSourceRevision": "b" * 40,
                "openshellRevision": "b" * 40,
                "derivativePatchSha256": "0" * 64,
                "sourceTree": "0" * 40,
                "sourceUnchanged": False,
                "rustToolchain": "stable",
                "rustTarget": "x86_64-pc-windows-msvc",
                "workflowRunId": "1235",
                "workflowRunAttempt": "1",
                "currentPackageQualification": True,
            }
            for key, replacement in replacements.items():
                for omit in (False, True):
                    with self.subTest(field=key, missing=omit):
                        changed = copy.deepcopy(build)
                        if omit:
                            del changed[key]
                        else:
                            changed[key] = replacement
                        with self.assertRaisesRegex(ValueError, "same-run ARM64"):
                            self.verify_build(native, source, changed)
            for run_id, attempt in (("", "2"), ("1234", "")):
                with self.assertRaisesRegex(ValueError, "same-run ARM64"):
                    self.verify_build(native, source, build, run_id, attempt)
            changed = copy.deepcopy(build)
            changed["derivativePatchSha256"] = None
            with self.assertRaisesRegex(ValueError, "same-run ARM64"):
                self.verify_build(native, source, changed)

    def test_openshell_admission_rejects_missing_duplicate_and_unexpected_components(self):
        with tempfile.TemporaryDirectory() as value:
            native, source, build = self.openshell_build(Path(value))
            files = build["files"]
            for replacement in (
                None, [], files[:-1], files + [files[0]], [files[0]] * len(files)
            ):
                with self.subTest(files=replacement):
                    changed = copy.deepcopy(build)
                    changed["files"] = replacement
                    with self.assertRaises(ValueError):
                        self.verify_build(native, source, changed)
            for name in ("../outside.exe", "unreviewed.dll", files[0]["file"].upper()):
                changed = copy.deepcopy(build)
                changed["files"][0]["file"] = name
                with self.subTest(name=name), self.assertRaisesRegex(
                    ValueError, "unexpected or duplicate"
                ):
                    self.verify_build(native, source, changed)

    def test_openshell_admission_rejects_substituted_bytes_size_and_architecture(self):
        with tempfile.TemporaryDirectory() as value:
            native, source, build = self.openshell_build(Path(value))
            for key, replacement in (("bytes", 1), ("sha256", "0" * 64)):
                changed = copy.deepcopy(build)
                changed["files"][0][key] = replacement
                with self.subTest(field=key), self.assertRaisesRegex(
                    ValueError, "differs from its current build receipt"
                ):
                    self.verify_build(native, source, changed)
            binary = native / build["files"][0]["file"]
            binary.write_bytes(executable(b"\x64\x86"))
            build["files"][0]["sha256"] = MODULE.digest(binary)
            with self.assertRaisesRegex(ValueError, "not Windows ARM64"):
                self.verify_build(native, source, build)

    def test_openshell_admission_rejects_a_hardlinked_component(self):
        with tempfile.TemporaryDirectory() as value:
            root = Path(value)
            native, source, build = self.openshell_build(root)
            (root / "retained-link.exe").hardlink_to(
                native / build["files"][0]["file"]
            )
            with self.assertRaisesRegex(ValueError, "ordinary single-link"):
                self.verify_build(native, source, build)

    def test_staging_copies_each_approved_component_including_a_runtime_dll(self):
        with tempfile.TemporaryDirectory() as value:
            root = Path(value)
            native, source, build = self.openshell_build(root)
            self.verify_build(native, source, build)
            destination = root / "staged"
            destination.mkdir()
            MODULE.copy_openshell_build(native, destination, build)
            self.assertEqual(
                sorted(path.name for path in destination.iterdir()),
                sorted((
                    "openshell.exe", "openshell-gateway.exe", "openshell-supervisor.exe",
                    "openshell-windows-sandbox.exe", "libz3.dll",
                )),
            )
            for item in build["files"]:
                copied = destination / item["file"]
                self.assertEqual(copied.stat().st_size, item["bytes"])
                self.assertEqual(MODULE.digest(copied), item["sha256"])
                self.assertEqual(copied.stat().st_nlink, 1)

    def test_each_host_supervisor_component_is_required_and_architecture_checked(self):
        for name in MODULE.OPENSHELL_FILES:
            with self.subTest(component=name), tempfile.TemporaryDirectory() as value:
                native, source, build = self.openshell_build(Path(value))
                missing = copy.deepcopy(build)
                missing["files"] = [item for item in build["files"] if item["file"] != name]
                with self.assertRaisesRegex(ValueError, "every approved host component"):
                    self.verify_build(native, source, missing)
                binary = native / name
                binary.write_bytes(executable(b"\x64\x86"))
                for item in build["files"]:
                    if item["file"] == name:
                        item["sha256"] = MODULE.digest(binary)
                with self.assertRaisesRegex(ValueError, "not Windows ARM64"):
                    self.verify_build(native, source, build)

    def test_staging_rejects_an_unapproved_inventory_before_copying(self):
        with tempfile.TemporaryDirectory() as value:
            root = Path(value)
            native, source, build = self.openshell_build(root)
            self.verify_build(native, source, build)
            build["files"][0]["file"] = "../outside.exe"
            destination = root / "staged"
            destination.mkdir()
            with self.assertRaisesRegex(ValueError, "unexpected or duplicate"):
                MODULE.copy_openshell_build(native, destination, build)
            self.assertEqual(list(destination.iterdir()), [])

    def test_staging_rejects_component_changes_after_admission(self):
        with tempfile.TemporaryDirectory() as value:
            root = Path(value)
            native, source, build = self.openshell_build(root)
            self.verify_build(native, source, build)
            (native / build["files"][0]["file"]).write_bytes(b"substituted")
            destination = root / "staged"
            destination.mkdir()
            with self.assertRaisesRegex(ValueError, "changed during its build copy"):
                MODULE.copy_openshell_build(native, destination, build)

    def test_z3_notice_is_preserved_and_substitution_is_rejected(self):
        source = Path(__file__).resolve().parents[3]
        with tempfile.TemporaryDirectory() as value:
            root = Path(value)
            MODULE.copy_z3_license(source, root)
            self.assertEqual(
                (root / "Z3-LICENSE.txt").read_bytes(),
                (source / "packaging/windows/Z3-LICENSE.txt").read_bytes(),
            )
            self.assertEqual(MODULE.digest(root / "Z3-LICENSE.txt"), MODULE.Z3_LICENSE_SHA256)
            with self.assertRaises(FileExistsError):
                MODULE.copy_z3_license(source, root)
            changed = root / "changed-source"
            (changed / "packaging/windows").mkdir(parents=True)
            (changed / "packaging/windows/Z3-LICENSE.txt").write_text("wrong notice")
            destination = root / "rejected"
            destination.mkdir()
            with self.assertRaisesRegex(ValueError, "reviewed notice"):
                MODULE.copy_z3_license(changed, destination)
            self.assertEqual(list(destination.iterdir()), [])

    def test_gateway_template_uses_v2_without_legacy_capabilities_and_preserves_paths(self):
        executor = "C:\\Program Files\\NVIDIA\\NemoClaw\\mxc\\wxc-exec.exe"
        for value in (executor, executor + "\u007f", executor + '"\n'):
            document = tomllib.loads(MODULE.gateway_template(value))
            self.assertEqual(
                document,
                {
                    "openshell": {
                        "version": 2,
                        "drivers": {
                            "mxc": {
                                "wxc_exec_path": value,
                                "backend": "process_container",
                                "pc_least_privilege": False,
                                "pc_capabilities": [],
                                "debug": False,
                            }
                        }
                    }
                },
            )

    def test_x64_binary_cannot_be_labeled_arm64(self):
        with tempfile.TemporaryDirectory() as value:
            path = Path(value) / "wrong.exe"
            path.write_bytes(executable(b"\x64\x86"))
            with self.assertRaisesRegex(ValueError, "not Windows ARM64"):
                MODULE.arm64(path)

    def mxc_build(self, native):
        (native / "LICENSE.md").write_text("fixture license", encoding="utf-8")
        files = []
        for name in MODULE.MXC_FILES:
            binary = native / name
            binary.write_bytes(executable())
            files.append({
                "file": name,
                "bytes": binary.stat().st_size,
                "sha256": MODULE.digest(binary),
            })
        return {
            "schemaVersion": 1,
            "classification": "ci-built-mxc-host-binaries",
            "requestedSourceRevision": "a" * 40,
            "mxcRevision": MODULE.MXC_SOURCE,
            "sourceUnchanged": True,
            "rustToolchain": "1.93.0-aarch64-pc-windows-msvc",
            "rustTarget": "aarch64-pc-windows-msvc",
            "workflowRunId": "1234",
            "workflowRunAttempt": "2",
            "currentPackageQualification": False,
            "licenseSha256": MODULE.digest(native / "LICENSE.md"),
            "files": files,
        }

    def verify_mxc(self, native, build, run_id="1234", attempt="2"):
        (native / "mxc-build.json").write_text(json.dumps(build), encoding="utf-8")
        return MODULE.verify_mxc_build(native, "a" * 40, run_id, attempt)

    def test_mxc_requires_same_run_source_build_and_original_license(self):
        with tempfile.TemporaryDirectory() as value:
            native = Path(value)
            build = self.mxc_build(native)
            with unittest.mock.patch.object(MODULE, "MXC_LICENSE_SHA256", build["licenseSha256"]):
                self.assertEqual(self.verify_mxc(native, build), build)
                for key in set(build) - {"files"}:
                    for replacement in (None, "substituted"):
                        changed = copy.deepcopy(build)
                        if replacement is None:
                            del changed[key]
                        else:
                            changed[key] = replacement
                        with self.subTest(field=key, value=replacement), self.assertRaisesRegex(
                            ValueError, "same-run ARM64"
                        ):
                            self.verify_mxc(native, changed)
                for run_id, attempt in (("", "2"), ("1234", ""), ("1235", "2"), ("1234", "3")):
                    with self.assertRaisesRegex(ValueError, "same-run ARM64"):
                        self.verify_mxc(native, build, run_id, attempt)
                (native / "LICENSE.md").write_text("substituted license")
                with self.assertRaisesRegex(ValueError, "same-run ARM64"):
                    self.verify_mxc(native, build)

    def test_mxc_rejects_missing_duplicate_and_unapproved_files(self):
        with tempfile.TemporaryDirectory() as value:
            native = Path(value)
            build = self.mxc_build(native)
            with unittest.mock.patch.object(MODULE, "MXC_LICENSE_SHA256", build["licenseSha256"]):
                for files in (
                    [], build["files"][:1], [build["files"][0]] * 2,
                    [{**item, "file": "../outside.exe"} for item in build["files"]],
                ):
                    with self.subTest(files=files), self.assertRaises(ValueError):
                        self.verify_mxc(native, {**build, "files": files})

    def test_mxc_checks_both_binaries_and_stages_only_approved_bytes(self):
        for name in MODULE.MXC_FILES:
            with self.subTest(component=name), tempfile.TemporaryDirectory() as value:
                native = Path(value)
                build = self.mxc_build(native)
                with unittest.mock.patch.object(MODULE, "MXC_LICENSE_SHA256", build["licenseSha256"]):
                    self.verify_mxc(native, build)
                    destination = native / "staged"
                    destination.mkdir()
                    MODULE.copy_build_files(
                        native, destination,
                        MODULE.build_files(build, MODULE.MXC_FILES, "MXC"), "MXC",
                    )
                    self.assertEqual(
                        sorted(p.name for p in destination.iterdir()), sorted(MODULE.MXC_FILES),
                    )
                    for item in build["files"]:
                        self.assertEqual(MODULE.digest(destination / item["file"]), item["sha256"])
                    binary = native / name
                    binary.write_bytes(executable() + b"substitution")
                    with self.assertRaisesRegex(ValueError, "current build receipt"):
                        self.verify_mxc(native, build)
                    with self.assertRaisesRegex(ValueError, "changed during its build copy"):
                        MODULE.copy_build_files(native, destination, build["files"], "MXC")
                    binary.write_bytes(executable(b"\x64\x86"))
                    for item in build["files"]:
                        if item["file"] == name:
                            item["sha256"] = MODULE.digest(binary)
                    with self.assertRaisesRegex(ValueError, "not Windows ARM64"):
                        self.verify_mxc(native, build)
                    binary.write_bytes(executable())
                    (native / "alias.exe").hardlink_to(binary)
                    with self.assertRaisesRegex(ValueError, "ordinary single-link"):
                        self.verify_mxc(native, build)


if __name__ == "__main__":
    unittest.main()
