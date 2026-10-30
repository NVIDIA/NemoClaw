# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Data-only lifecycle controls; no Windows APIs, registry, or application execution."""

import importlib.util
import json
import hashlib
import ctypes as c
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "postmortem", Path(__file__).with_name("prepare-renderer-postmortem.py")
)
owner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owner)


class OwnerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.root = self.base / "owned"
        self.root.mkdir()
        for directory in ("reports", "dumps"):
            (self.root / directory).mkdir()
        config = self.root / "gate-config.json"
        config.write_text(
            json.dumps({"pythonIdentity": {"path": r"C:\Python\python.exe"}})
        )
        self.receipt = {
            "nonce": "a" * 24,
            "sourceRevision": "b" * 40,
            "root": str(self.root),
            "reportsRoot": str(self.root / "reports"),
            "dumpsRoot": str(self.root / "dumps"),
            "rootCreated": True,
            "registry": {"owned": True},
            "cleanupErrors": [],
            "config": owner.file_tuple(config),
            "stagedFiles": {},
        }
        self.args = SimpleNamespace(
            executor_closed=True,
            executor_not_started=False,
            output=str(self.base / "cleanup.json"),
        )
        self.windows = SimpleNamespace(close_errors=[])
        self.restored = []
        self.registry = SimpleNamespace(
            cleanup=lambda receipt: self.restored.append(receipt) or {"passed": True}
        )
        self.addCleanup(patch.stopall)
        patch.object(owner, "load", return_value=self.registry).start()
        patch.object(
            owner,
            "host_closed",
            return_value={"closed": True, "handleClosed": True, "error": None},
        ).start()

    def records(self):
        host = {
            "pid": 123,
            "creationFiletime": "123456",
            "image": r"C:\Python\python.exe",
        }
        value = {
            "schemaVersion": 1,
            "sourceRevision": "b" * 40,
            "nonce": "a" * 12,
            "configSha256": self.receipt["config"]["sha256"],
            "host": host,
            "eventHandleClosed": True,
            "ownedHandlesClosed": True,
            "cleanupErrors": [],
            "cdb": {
                "childrenClosed": True,
                "childClosed": True,
                "handlesClosed": True,
                "captureClosed": True,
                "jobActiveAfterCleanup": 0,
                "cleanupErrors": [],
                "operationSucceeded": False,
                "exitCode": 1,
            },
            "error": {"message": "No dump"},
        }
        for kind in ("host", "gate"):
            row = {
                **value,
                "classification": "renderer-postmortem-gate"
                + ("-host" if kind == "host" else ""),
            }
            (self.root / "reports" / f"{kind}-123-123456.json").write_text(
                json.dumps(row)
            )
        return self.root / "reports" / "gate-123-123456.json"

    def test_executor_not_started_cleans_without_claiming_capture(self):
        self.args.executor_closed = False
        self.args.executor_not_started = True
        result = owner.cleanup(self.args, self.receipt, self.windows)
        self.assertTrue(result["cleanupComplete"])
        self.assertEqual(result["dumpObservations"], [])
        self.assertEqual(result["hostObservations"], [])
        self.assertEqual(len(self.restored), 1)
        self.assertFalse(self.root.exists())
        self.assertTrue(Path(self.args.output).exists())

    def test_executed_without_gate_record_retains_root_and_restores_registry(self):
        result = owner.cleanup(self.args, self.receipt, self.windows)
        self.assertFalse(result["hostsClosed"])
        self.assertFalse(result["cleanupComplete"])
        self.assertTrue(result["registryRestored"])
        self.assertTrue(self.root.exists())
        self.assertIn("No gate host record", result["errors"][0]["message"])

    def test_capture_failure_does_not_replace_actual_closure(self):
        self.records()
        result = owner.cleanup(self.args, self.receipt, self.windows)
        self.assertTrue(result["cleanupComplete"])
        self.assertFalse(
            result["finalReports"]["gates"][0]["value"]["cdb"]["operationSucceeded"]
        )
        self.assertTrue(result["hostObservations"][0]["closed"])

    def test_unclosed_cdb_retains_root_but_restores_registry(self):
        file = self.records()
        row = json.loads(file.read_text())
        row["cdb"]["childrenClosed"] = False
        file.write_text(json.dumps(row))
        result = owner.cleanup(self.args, self.receipt, self.windows)
        self.assertFalse(result["cleanupComplete"])
        self.assertFalse(result["hostsClosed"])
        self.assertTrue(result["registryRestored"])
        self.assertTrue(self.root.exists())

    def test_changed_config_binding_restores_registry_independently(self):
        file = self.records()
        row = json.loads(file.read_text())
        row["configSha256"] = "0" * 64
        file.write_text(json.dumps(row))
        result = owner.cleanup(self.args, self.receipt, self.windows)
        self.assertFalse(result["hostsClosed"])
        self.assertTrue(result["registryRestored"])
        self.assertTrue(result["initialReports"]["errors"])
        self.assertTrue(self.root.exists())

    def test_unreported_dump_is_retained(self):
        self.records()
        file = self.root / "dumps" / "renderer-999-123_1.dmp"
        file.write_bytes(b"unreported")
        result = owner.cleanup(self.args, self.receipt, self.windows)
        self.assertTrue(result["hostsClosed"])
        self.assertFalse(result["cleanupComplete"])
        self.assertTrue(file.exists())
        self.assertTrue(result["registryRestored"])

    def test_sanitized_evidence_must_save_before_raw_dump_removal(self):
        gate_file = self.records()
        gate = json.loads(gate_file.read_text())
        prefix = self.root / "dumps" / "renderer-456-98765"
        dump = prefix.with_name(prefix.name + "_2026_09_13.dmp")
        dump.write_bytes(b"bounded fixture")
        gate.update(
            target={"pid": 456, "creationFiletime": "98765"},
            admitted=True,
            dumpPrefix=str(prefix),
            dumps=[{"name": dump.name, "bytes": dump.stat().st_size}],
        )
        gate_file.write_text(json.dumps(gate))
        parser_file = self.root / "parse-chrome-minidump.py"
        parser_file.write_text("# Bound parser fixture\n")
        reference = owner.file_tuple(parser_file)
        config_file = self.root / "gate-config.json"
        config = json.loads(config_file.read_text())
        config["parserIdentity"] = reference
        config_file.write_text(json.dumps(config))
        self.receipt["config"] = owner.file_tuple(config_file)
        self.receipt["stagedFiles"] = {parser_file.name: reference}
        for file in (self.root / "reports").iterdir():
            row = json.loads(file.read_text())
            row["configSha256"] = self.receipt["config"]["sha256"]
            file.write_text(json.dumps(row))
        parser = SimpleNamespace(
            parse_minidump=lambda path, deadline: {"exception": {"code": "0xc0000008"}}
        )
        owner.load.side_effect = lambda name, *args: (
            self.registry if name == "renderer-aedebug-registry.py" else parser
        )
        with patch.object(owner, "save", side_effect=OSError("receipt-save-failed")):
            result = owner.cleanup(self.args, self.receipt, self.windows)
        self.assertFalse(result["cleanupComplete"])
        self.assertTrue(result["registryRestored"])
        self.assertTrue(dump.exists())
        self.assertEqual(
            result["dumpObservations"][0]["parsed"]["exception"]["code"], "0xc0000008"
        )
        self.assertFalse(result["dumpObservations"][0]["rawUploadAllowed"])

    def test_no_executor_closure_does_not_restore_or_remove(self):
        self.args.executor_closed = False
        result = owner.cleanup(self.args, self.receipt, self.windows)
        self.assertFalse(result["cleanupComplete"])
        self.assertEqual(self.restored, [])
        self.assertTrue(self.root.exists())


class DebuggerDiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for architecture, machine in (("x64", 0x8664), ("arm64", 0xAA64)):
            directory = self.root / "Windows Kits/10/Debuggers" / architecture
            directory.mkdir(parents=True)
            data = bytearray(128)
            data[:2] = b"MZ"
            data[60:64] = (64).to_bytes(4, "little")
            data[64:68] = b"PE\0\0"
            data[68:70] = machine.to_bytes(2, "little")
            for name in (
                "cdb.exe",
                "dbgeng.dll",
                "dbghelp.dll",
                "dbgcore.dll",
                "dbgmodel.dll",
            ):
                (directory / name).write_bytes(data)
        self.metadata = SimpleNamespace(
            known_folders=lambda: [
                {"name": "ProgramFilesX86", "path": str(self.root), "error": None}
            ],
            file_version=lambda path: "10.0.26100.1",
        )

    def test_native_discovery_records_unexecuted_preinstalled_files_without_signature_claim(
        self,
    ):
        with (
            patch.object(owner, "DebuggerMetadata", return_value=self.metadata),
            patch.object(owner.subprocess, "run") as process,
        ):
            receipt = owner.inspect_tools(self.root / "inspection.json", None)
            process.assert_not_called()
        record = receipt["value"]
        self.assertEqual(record["status"], "available")
        self.assertEqual(record["selected"]["architecture"], "x64")
        self.assertEqual(len(record["candidates"]), 2)
        self.assertFalse(record["executedDebugger"])
        self.assertFalse(receipt["execution"]["subprocessStarted"])
        for candidate in record["candidates"]:
            self.assertEqual(candidate["status"], "available")
            self.assertEqual(len(candidate["files"]), 5)
            for file in candidate["files"]:
                self.assertEqual(
                    file["sha256"],
                    hashlib.sha256(Path(file["path"]).read_bytes()).hexdigest(),
                )
                self.assertEqual(file["version"], "10.0.26100.1")
                self.assertEqual(file["signatureStatus"], "not-collected")
                self.assertEqual(file["provenance"], "preinstalled-windows-sdk")
                self.assertFalse(file["executed"])

    def test_missing_and_mismatched_sdk_inputs_retain_the_exact_failure(self):
        x64 = self.root / "Windows Kits/10/Debuggers/x64/cdb.exe"
        data = bytearray(x64.read_bytes())
        data[68:70] = (0xAA64).to_bytes(2, "little")
        x64.write_bytes(data)
        arm64 = self.root / "Windows Kits/10/Debuggers/arm64/dbgmodel.dll"
        arm64.unlink()
        with (
            patch.object(owner, "DebuggerMetadata", return_value=self.metadata),
            patch.object(owner.subprocess, "run") as process,
        ):
            receipt = owner.inspect_tools(self.root / "inspection.json", None)
            process.assert_not_called()
        record = receipt["value"]
        self.assertEqual(record["status"], "unavailable")
        self.assertIsNone(record["selected"])
        self.assertEqual(record["candidates"][0]["files"][0]["path"], str(x64))
        self.assertEqual(record["candidates"][0]["files"][0]["machine"], 0xAA64)
        self.assertIn(
            "architecture differs", record["candidates"][0]["error"]["message"]
        )
        self.assertEqual(record["candidates"][1]["files"][-1]["path"], str(arm64))
        self.assertEqual(record["candidates"][1]["error"]["name"], "FileNotFoundError")

    def test_native_fixed_version_resource_layout_and_pointer_bound(self):
        api = owner.DebuggerMetadata.__new__(owner.DebuggerMetadata)
        words = (c.c_uint32 * 13)(0xFEEF04BD, 0x10000, 0xA0000, 0x65F40001)
        saved = {}

        def read(path, unused, size, buffer):
            self.assertEqual((unused, size), (0, 52))
            c.memmove(buffer, words, 52)
            saved["buffer"] = buffer
            return 1

        def query(buffer, key, pointer, size):
            self.assertEqual(key, "\\")
            c.cast(pointer, c.POINTER(c.c_void_p))[0] = c.addressof(buffer)
            c.cast(size, c.POINTER(c.c_uint32))[0] = 52
            return 1

        api.version = SimpleNamespace(
            GetFileVersionInfoSizeW=lambda path, unused: 52,
            GetFileVersionInfoW=read,
            VerQueryValueW=query,
        )
        self.assertEqual(api.file_version("fixture.dll"), "10.0.26100.1")

        def invalid(buffer, key, pointer, size):
            query(buffer, key, pointer, size)
            c.cast(pointer, c.POINTER(c.c_void_p))[0] = c.addressof(buffer) + 1
            return 1

        api.version.VerQueryValueW = invalid
        with self.assertRaisesRegex(ValueError, "Invalid fixed version"):
            api.file_version("fixture.dll")


if __name__ == "__main__":
    unittest.main()
