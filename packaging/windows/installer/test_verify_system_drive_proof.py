# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Real-file proof-consumption controls; synthetic receipts do not prove Windows execution."""

import copy
import importlib.util
import json
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

MODULE = Path(__file__).with_name("verify-system-drive-proof.py")
SPEC = importlib.util.spec_from_file_location("system_drive_gate", MODULE)
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)


# Exact raw Node SDDL from verified artifact10174112763, source8dfce157.
# The original receipt remains failed; these controls do not relabel it.
NODE_8DF_BEFORE = "O:BAG:S-1-5-21-3786388951-2809471854-1607369026-513D:(A;ID;0x1301bf;;;AU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;0x1200a9;;;BU)"
NODE_8DF_AFTER = "O:BAG:S-1-5-21-3786388951-2809471854-1607369026-513D:AI(A;ID;0x1301bf;;;AU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;0x1200a9;;;BU)"


class SystemDriveProofTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="system-drive-gate-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.source = self.root / "source"
        self.owner = self.source / "packaging/windows/host-preparation"
        self.owner.mkdir(parents=True)
        for name in (
            "main.rs",
            "Cargo.toml",
            "Cargo.lock",
            "build-helper.ps1",
            "test-system-root-mxc.ps1",
        ):
            (self.owner / name).write_text("fixture " + name)
        self.helper = self.root / "NemoClawHostPreparation.exe"
        binary = bytearray(128)
        binary[:2] = b"MZ"
        struct.pack_into("<I", binary, 0x3C, 64)
        binary[64:68] = b"PE\0\0"
        struct.pack_into("<H", binary, 68, 0xAA64)
        self.helper.write_bytes(binary)
        self.build_path = self.root / "build.json"
        self.proof_dir = self.root / "proof"
        self.proof_dir.mkdir()
        self.revision = "a" * 40
        self.node_path = r"D:\host\bin\node.exe"
        self.build = {
            "schemaVersion": 1,
            "classification": "native-system-drive-preparation-build",
            "architecture": "arm64",
            "rustToolchain": "1.95.0-aarch64-pc-windows-msvc",
            "file": self.helper.name,
            "bytes": len(binary),
            "sha256": gate.sha(binary),
            "sources": [
                {"file": path.name, "sha256": gate.sha(path.read_bytes())}
                for path in self.owner.iterdir()
                if path.name != "test-system-root-mxc.ps1"
            ],
            "systemRootProofRequired": True,
            "mxcLaunchProofRequired": True,
            "admissionAllowed": False,
        }
        self.policy = {
            "version": "0.6.0-alpha",
            "containment": "processcontainer",
            "processContainer": {
                "leastPrivilege": False,
                "capabilities": gate.PROFILE["capabilities"],
            },
            "ui": {"disable": False},
            "network": {
                "defaultPolicy": "allow",
                "allowedHosts": [],
                "blockedHosts": [],
                "allowLocalNetwork": True,
            },
            "process": {
                "timeout": 30000,
                "cwd": r"C:\NemoClawHostPrepProof-0123456789ab",
            },
            "filesystem": {
                "readonlyPaths": [self.node_path],
                "readwritePaths": [r"C:\NemoClawHostPrepProof-0123456789ab"],
            },
        }
        helper_record = {
            "schemaVersion": 1,
            "classification": "nemoclaw-system-drive-metadata",
            "systemDriveRoot": "C:\\",
            "verified": True,
            "saclWriteRequested": False,
            "customerPathRegistryChanged": False,
            "beforeDescriptorHex": "0001",
            "afterDescriptorHex": "0102",
            "writeCalls": 1,
            "addedAces": 2,
        }
        self.proof = {
            "schemaVersion": 1,
            "classification": "actual-system-root-and-mxc-proof",
            "status": "pass",
            "sourceRevision": self.revision,
            "helperSha256": gate.sha(binary),
            "systemDriveRoot": "C:\\",
            "requestProfile": "existing-personal-node-compatibility",
            "stdio": "explicit-pipes-with-closed-input",
            "requestPolicy": copy.deepcopy(gate.PROFILE),
            "admissionAllowed": False,
            "first": helper_record,
            "repeat": {
                **helper_record,
                "beforeDescriptorHex": "0102",
                "writeCalls": 0,
                "addedAces": 0,
            },
            "guest": {
                "marker": "NEMOCLAW_SYSTEM_METADATA_MXC_OK",
                "platform": "win32",
                "architecture": "arm64",
                "node": "22.23.2",
                "allowedRead": True,
                "deniedRead": True,
                "ownedWrite": True,
            },
            "nodeAclRestored": True,
            "nodeFileKind": "regular-file",
            "nodeFileAttributesBefore": 32,
            "nodeFileAttributesAfter": 32,
            "nodeAclComparison": {
                "restored": True,
                "exactRestored": True,
                "metadataChange": None,
            },
            "nodeSddlBefore": "O:SYD:AI",
            "nodeSddlAfter": "O:SYD:AI",
            "rootSddlAfterPreparation": "O:SYD:",
            "rootSddlAfterMxc": "O:SYD:",
            "mxcStopped": True,
            "workspaceRemoved": True,
            "cleanupErrors": [],
            "commands": [
                {
                    "label": label,
                    "exitCode": 0,
                    "stopped": True,
                    "elapsedMilliseconds": 12.5,
                }
                for label in (
                    "metadata-first",
                    "metadata-repeat",
                    "upstream-null-device",
                    "mxc-execution",
                    "owned-profile-delete",
                )
            ],
        }
        self.save()

    def save(self):
        self.build_path.write_text(json.dumps(self.build))
        policy_path = self.proof_dir / "policy.json"
        policy_path.write_text(json.dumps(self.policy))
        self.proof["policySha256"] = gate.sha(policy_path.read_bytes())
        (self.proof_dir / "system-root-mxc-proof.json").write_text(
            json.dumps(self.proof)
        )

    def verify(self):
        return gate.verify(
            self.helper,
            self.build_path,
            self.proof_dir,
            self.source,
            self.revision,
            self.node_path,
        )

    def command(self, output):
        return [
            sys.executable,
            str(MODULE),
            "--helper",
            str(self.helper),
            "--build-receipt",
            str(self.build_path),
            "--proof-directory",
            str(self.proof_dir),
            "--source-root",
            str(self.source),
            "--source-revision",
            self.revision,
            "--node-path",
            self.node_path,
            "--output",
            str(output),
        ]

    def test_actual_cli_binds_exact_files_without_claiming_publication(self):
        output = self.root / "gate.json"
        run = subprocess.run(self.command(output), capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stderr)
        result = json.loads(output.read_text())
        self.assertEqual(result["helperSha256"], gate.sha(self.helper.read_bytes()))
        self.assertEqual(
            result["proofSha256"],
            gate.sha((self.proof_dir / "system-root-mxc-proof.json").read_bytes()),
        )
        self.assertTrue(result["systemDriveMetadataPreparation"])
        self.assertFalse(result["publicationApproved"])
        self.assertFalse(result["installedAcceptance"])

    def test_changed_executable_rejected(self):
        with self.helper.open("ab") as stream:
            stream.write(b"changed")
        with self.assertRaisesRegex(ValueError, "exact executable"):
            self.verify()

    def test_non_arm64_rejected(self):
        binary = bytearray(self.helper.read_bytes())
        struct.pack_into("<H", binary, 68, 0x8664)
        self.helper.write_bytes(binary)
        with self.assertRaisesRegex(ValueError, "ARM64"):
            self.verify()

    def test_changed_or_incomplete_source_inventory_rejected(self):
        self.build["sources"][0] = {"file": "unknown"}
        self.save()
        with self.assertRaisesRegex(ValueError, "sources differ"):
            self.verify()
        self.setUp()
        (self.owner / "main.rs").write_text("changed")
        with self.assertRaisesRegex(ValueError, "sources differ"):
            self.verify()

    def test_source_status_profile_and_self_approval_rejected(self):
        for field, value in (
            ("sourceRevision", "b" * 40),
            ("status", "failed"),
            ("requestProfile", "stronger-unproven"),
            ("stdio", "inherited"),
            ("admissionAllowed", True),
            ("helperSha256", "c" * 64),
        ):
            with self.subTest(field=field):
                saved = self.proof[field]
                self.proof[field] = value
                self.save()
                with self.assertRaisesRegex(ValueError, "Same-source"):
                    self.verify()
                self.proof[field] = saved

    def test_first_write_and_exact_repeat_required(self):
        for record, field, value in (
            ("first", "writeCalls", 0),
            ("first", "addedAces", 3),
            ("repeat", "writeCalls", 1),
            ("repeat", "afterDescriptorHex", "0000"),
            ("first", "saclWriteRequested", True),
        ):
            with self.subTest(record=record, field=field):
                saved = self.proof[record][field]
                self.proof[record][field] = value
                self.save()
                with self.assertRaises(ValueError):
                    self.verify()
                self.proof[record][field] = saved

    def test_guest_access_and_cleanup_cannot_be_skipped(self):
        for field in ("allowedRead", "deniedRead", "ownedWrite"):
            with self.subTest(field=field):
                self.proof["guest"][field] = False
                self.save()
                with self.assertRaisesRegex(ValueError, "read/deny/write"):
                    self.verify()
                self.proof["guest"][field] = True
        for field, value in (
            ("nodeAclRestored", False),
            ("nodeSddlAfter", "changed"),
            ("rootSddlAfterMxc", "changed"),
            ("mxcStopped", False),
            ("workspaceRemoved", False),
            ("cleanupErrors", ["failed"]),
        ):
            with self.subTest(field=field):
                saved = self.proof[field]
                self.proof[field] = value
                self.save()
                with self.assertRaisesRegex(ValueError, "owned cleanup"):
                    self.verify()
                self.proof[field] = saved

    def test_actual_policy_hash_and_contents_required(self):
        (self.proof_dir / "policy.json").write_text("{}")
        with self.assertRaisesRegex(ValueError, "Same-source"):
            self.verify()
        self.policy["processContainer"]["leastPrivilege"] = True
        self.save()
        with self.assertRaisesRegex(ValueError, "hashed actual request"):
            self.verify()

    def test_links_and_oversized_records_rejected(self):
        target = self.root / "actual-build.json"
        self.build_path.rename(target)
        self.build_path.symlink_to(target)
        with self.assertRaisesRegex(ValueError, "link or reparse"):
            self.verify()
        self.build_path.unlink()
        self.build_path.write_bytes(b" " * (1024 * 1024 + 1))
        with self.assertRaisesRegex(ValueError, "size/type"):
            self.verify()

    def test_every_owned_command_must_complete(self):
        self.proof["commands"][3]["exitCode"] = 1
        self.save()
        with self.assertRaisesRegex(ValueError, "finish successfully"):
            self.verify()
        self.proof["commands"].pop()
        self.save()
        with self.assertRaisesRegex(ValueError, "command sequence"):
            self.verify()

    def test_broader_hashed_filesystem_grants_are_rejected(self):
        original = copy.deepcopy(self.policy)
        alternatives = [
            {
                "readonlyPaths": [self.node_path, "C:\\"],
                "readwritePaths": original["filesystem"]["readwritePaths"],
            },
            {
                "readonlyPaths": [r"D:\other\node.exe"],
                "readwritePaths": original["filesystem"]["readwritePaths"],
            },
            {"readonlyPaths": [self.node_path], "readwritePaths": ["C:\\"]},
            {**original["filesystem"], "allowAll": True},
        ]
        for value in alternatives:
            with self.subTest(filesystem=value):
                self.policy["filesystem"] = value
                self.save()
                with self.assertRaisesRegex(ValueError, "filesystem grants"):
                    self.verify()
        self.policy = original
        self.policy["process"]["cwd"] = "C:\\"
        self.policy["filesystem"]["readwritePaths"] = ["C:\\"]
        self.save()
        with self.assertRaisesRegex(ValueError, "filesystem grants"):
            self.verify()

    def test_actual_8df_node_metadata_requires_explicit_nonexact_annotation(self):
        self.proof["nodeSddlBefore"] = NODE_8DF_BEFORE
        self.proof["nodeSddlAfter"] = NODE_8DF_AFTER
        self.save()
        with self.assertRaisesRegex(ValueError, "owned cleanup"):
            self.verify()
        self.proof["nodeAclComparison"] = {
            "restored": True,
            "exactRestored": False,
            "metadataChange": "dacl-auto-inherited-added",
        }
        self.save()
        self.assertEqual(
            self.verify()["nodeAclComparison"], self.proof["nodeAclComparison"]
        )
        self.proof["rootSddlAfterMxc"] += "AI"
        self.save()
        with self.assertRaisesRegex(ValueError, "owned cleanup"):
            self.verify()

    def test_node_metadata_refuses_reverse_access_owner_flags_and_file_kind_changes(
        self,
    ):
        changes = [
            (NODE_8DF_AFTER, NODE_8DF_BEFORE, 32, 32),
            (NODE_8DF_BEFORE, NODE_8DF_AFTER.replace("O:BA", "O:SY"), 32, 32),
            (
                NODE_8DF_BEFORE,
                NODE_8DF_AFTER.replace("G:S-1-5-21", "G:S-1-5-22"),
                32,
                32,
            ),
            (NODE_8DF_BEFORE, NODE_8DF_AFTER.replace("0x1301bf", "FA"), 32, 32),
            (NODE_8DF_BEFORE, NODE_8DF_AFTER.replace(";ID;", ";;", 1), 32, 32),
            (NODE_8DF_BEFORE, NODE_8DF_AFTER.replace("D:AI", "D:PAI"), 32, 32),
            (NODE_8DF_BEFORE, NODE_8DF_AFTER.replace("D:AI", "D:ARAI"), 32, 32),
            (
                NODE_8DF_BEFORE,
                NODE_8DF_AFTER.replace(
                    "(A;ID;FA;;;SY)(A;ID;FA;;;BA)", "(A;ID;FA;;;BA)(A;ID;FA;;;SY)"
                ),
                32,
                32,
            ),
            (NODE_8DF_BEFORE, NODE_8DF_AFTER, 16, 32),
            (NODE_8DF_BEFORE, NODE_8DF_AFTER, 32, 16),
            (NODE_8DF_BEFORE, NODE_8DF_AFTER, 32, 1024),
        ]
        for before, after, prior_attributes, attributes in changes:
            with self.subTest(after=after, attributes=attributes):
                self.assertFalse(
                    gate.compare_node_acl(before, after, prior_attributes, attributes)[
                        "restored"
                    ]
                )
        self.proof["nodeFileKind"] = "directory"
        self.save()
        with self.assertRaisesRegex(ValueError, "owned cleanup"):
            self.verify()

    def test_actual_powershell_comparator_and_regular_file_check(self):
        powershell = shutil.which("pwsh") or shutil.which("powershell.exe")
        self.assertIsNotNone(
            powershell, "These controls require the available PowerShell runtime."
        )
        producer = MODULE.parent.parent / "host-preparation/test-system-root-mxc.ps1"
        cases = [
            [NODE_8DF_BEFORE, NODE_8DF_AFTER, 32, 32],
            [NODE_8DF_BEFORE, NODE_8DF_BEFORE, 32, 32],
            [NODE_8DF_AFTER, NODE_8DF_BEFORE, 32, 32],
            [NODE_8DF_BEFORE, NODE_8DF_AFTER.replace("O:BA", "O:SY"), 32, 32],
            [NODE_8DF_BEFORE, NODE_8DF_AFTER.replace(";ID;", ";;", 1), 32, 32],
            [NODE_8DF_BEFORE, NODE_8DF_AFTER.replace("D:AI", "D:PAI"), 32, 32],
            [NODE_8DF_BEFORE, NODE_8DF_AFTER, 16, 32],
            [NODE_8DF_BEFORE, NODE_8DF_AFTER, 32, 1024],
        ]
        cases_path = self.root / "cases.json"
        cases_path.write_text(json.dumps(cases))
        link = self.root / "node-link.exe"
        link.symlink_to(self.helper)
        script = self.root / "compare.ps1"
        script.write_text(r"""param([string]$Source,[string]$Cases,[string]$File,[string]$Directory,[string]$Link)
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'The actual producer did not parse.'}
foreach($name in @('Compare-ProofNodeAcl','Get-ProofNodeAttributes')) {
  $function=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name},$true))
  if($function.Count -ne 1){throw 'The exact producer function is missing.'}
  . ([ScriptBlock]::Create($function[0].Extent.Text))
}
$rows=@(Get-Content -LiteralPath $Cases -Raw|ConvertFrom-Json)
$results=@(foreach($row in $rows){Compare-ProofNodeAcl $row[0] $row[1] $row[2] $row[3]})
$attributes=Get-ProofNodeAttributes $File
$directoryRejected=$false;$linkRejected=$false
try{$null=Get-ProofNodeAttributes $Directory}catch{$directoryRejected=$true}
try{$null=Get-ProofNodeAttributes $Link}catch{$linkRejected=$true}
@{results=$results;fileAttributes=$attributes;directoryRejected=$directoryRejected;linkRejected=$linkRejected}|ConvertTo-Json -Depth 6
""")
        result = subprocess.run(
            [
                powershell,
                "-NoProfile",
                "-File",
                str(script),
                str(producer),
                str(cases_path),
                str(self.helper),
                str(self.root),
                str(link),
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        actual = json.loads(result.stdout)
        self.assertEqual(
            actual["results"], [gate.compare_node_acl(*row) for row in cases]
        )
        self.assertTrue(actual["directoryRejected"])
        self.assertTrue(actual["linkRejected"])
        self.assertEqual(actual["fileAttributes"] & 0x410, 0)

    def test_failure_never_overwrites_existing_gate_receipt(self):
        output = self.root / "gate.json"
        output.write_text("keep original")
        run = subprocess.run(self.command(output), capture_output=True, text=True)
        self.assertNotEqual(run.returncode, 0)
        self.assertEqual(output.read_text(), "keep original")


if __name__ == "__main__":
    unittest.main()
