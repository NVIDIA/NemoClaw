# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Real-file proof-consumption controls; synthetic receipts do not prove Windows execution."""

import copy
import importlib.util
import json
import ntpath
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
import unittest.mock
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
        (self.proof_dir / "mxc-native.log").write_text(
            "[1789582933] selected isolation tier: [1789582933] appcontainer-dacl[1789582933] \n"
        )
        self.revision = "a" * 40
        self.run_id, self.run_attempt = "123456", "1"
        self.enterContext(unittest.mock.patch.dict(os.environ, {
            "GITHUB_RUN_ID": self.run_id, "GITHUB_RUN_ATTEMPT": self.run_attempt,
        }))
        self.host_root = self.root / "host"
        (self.host_root / "mxc").mkdir(parents=True)
        mxc_files = []
        for name in ("wxc-exec.exe", "wxc-host-prep.exe"):
            data = binary + name.encode()
            (self.host_root / "mxc" / name).write_bytes(data)
            mxc_files.append({"file": name, "bytes": len(data), "sha256": gate.sha(data)})
        self.host = {
            "schemaVersion": 1,
            "classification": "finished-native-host-components",
            "sourceRevision": self.revision,
            "mxcSourceRevision": gate.MXC_SOURCE,
            "mxcBuild": {
                "schemaVersion": 1,
                "classification": "ci-built-mxc-host-binaries",
                "requestedSourceRevision": self.revision,
                "mxcRevision": gate.MXC_SOURCE,
                "workflowRunId": self.run_id,
                "workflowRunAttempt": self.run_attempt,
                "sourceUnchanged": True,
                "currentPackageQualification": False,
                "rustToolchain": "1.93.0-aarch64-pc-windows-msvc",
                "rustTarget": "aarch64-pc-windows-msvc",
                "licenseSha256": "d9a1b1e30d633d5732ea18e3cba9538d293ebc53e1a9e4e96ab739e0c5c4f1cb",
                "files": mxc_files,
            },
            "files": [{**row, "file": "mxc/" + row["file"]} for row in mxc_files],
        }
        self.host_receipt = self.host_root / "runtime-payload-receipt.json"
        self.host_receipt.write_text(json.dumps(self.host))
        self.node_path = r"D:\host\bin\node.exe"
        self.preauthorized_path = ntpath.join(
            ntpath.normpath(str(self.proof_dir.absolute())),
            "preauthorized-runtime-mount",
            "workers",
        )
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
            "version": "1.0.0",
            "containment": "processcontainer",
            "processContainer": {
                "leastPrivilege": False,
                "capabilities": gate.PROFILE["capabilities"],
            },
            "ui": {"disable": False},
            "network": copy.deepcopy(gate.MXC_NETWORK),
            "process": {
                "timeout": 30000,
                "cwd": r"C:\NemoClawHostPrepProof-0123456789ab",
            },
            "filesystem": {
                "readonlyPaths": [self.node_path, self.preauthorized_path],
                "readwritePaths": [r"C:\NemoClawHostPrepProof-0123456789ab"],
            },
        }
        workers_sddl = (
            "O:BAG:SYD:PAI(A;OICI;0x1200a9;;;AU)(A;OICI;FA;;;SY)"
            "(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;AC)"
            "(A;OICI;0x1200a9;;;S-1-15-2-2)"
        )
        detailed_access = [
            {
                "sid": sid,
                "mask": mask,
                "inherited": False,
                "inheritanceFlags": "ContainerInherit, ObjectInherit",
                "propagationFlags": "None",
                "accessControlType": "Allow",
            }
            for sid, mask in gate.ACL_MASKS.items()
        ]
        image_access = [
            {
                "sid": sid,
                "mask": mask,
                "inherited": False,
                "accessControlType": "Allow",
            }
            for sid, mask in gate.ACL_MASKS.items()
        ]
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
            "requestProfile": "same-run-node-file-access",
            "networkAccessTested": False,
            "mxcInput": gate.verify_mxc_input(self.host_root, self.revision, self.run_id, self.run_attempt),
            "selectedIsolationTier": "appcontainer-dacl",
            "needsDaclAugmentation": True,
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
                "preservedMainPath": True,
                "allowedRead": True,
                "preauthorizedRead": True,
                "deniedRead": True,
                "ownedWrite": True,
            },
            "preauthorizedRuntime": {
                "imageReceipt": {
                    "schemaVersion": 1,
                    "classification": "finished-runtime-application-image",
                    "runtimeId": "a" * 64,
                    "status": "built-detached-and-verified",
                    "format": "vhdx",
                    "filesystem": "ntfs",
                    "payloadObjects": 1,
                    "source": {"logicalBytes": 91, "files": 3},
                    "customerExtractionRequired": False,
                    "runtimeLaunchCopiesRequired": False,
                    "mountedReadOnly": True,
                    "population": {
                        "status": 3,
                        "log": "preauthorized-runtime-image.robocopy.log",
                    },
                    "appContainerReadRoots": [
                        {
                            "name": ".",
                            "sddl": workers_sddl,
                            "access": copy.deepcopy(image_access),
                        },
                        {
                            "name": "workers",
                            "sddl": workers_sddl,
                            "access": image_access,
                        }
                    ],
                    "image": {
                        "maximumMiB": 4096,
                        "sha256": "b" * 64,
                        "file": "preauthorized-runtime.vhdx",
                        "bytes": 138412032,
                    },
                    "innerFilesystemCompression": "ntfs-inherited-before-population",
                    "innerFilesystemAcl": gate.IMAGE_ACL,
                    "manifestSha256": "c" * 64,
                },
                "mountPointSddl": workers_sddl,
                "mountPointAccess": copy.deepcopy(detailed_access),
                "volumeRootSddl": workers_sddl,
                "volumeRootAccess": copy.deepcopy(detailed_access),
                "workersSddl": workers_sddl,
                "workersAccess": detailed_access,
                "readMask": gate.READ_MASK,
                "readOnlyAttachment": True,
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
                    "mxc-tier-probe",
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

    def verify(self, *, legacy=False):
        return gate.verify(
            self.helper,
            self.build_path,
            self.proof_dir,
            self.source,
            self.revision,
            self.node_path,
            None if legacy else self.host_root,
            self.run_id,
            self.run_attempt,
            legacy_mxc_directory=self.host_root / "mxc" if legacy else None,
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
            "--host-payload-root",
            str(self.host_root),
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
        self.assertTrue(result["preauthorizedRuntimeReadOnly"])
        self.assertFalse(result["publicationApproved"])
        self.assertFalse(result["installedAcceptance"])

    def test_changed_executable_rejected(self):
        with self.helper.open("ab") as stream:
            stream.write(b"changed")
        with self.assertRaisesRegex(ValueError, "exact executable"):
            self.verify()

    def test_current_mxc_requires_source_run_attempt_and_build_provenance(self):
        changes = {
            "requestedSourceRevision": "b" * 40,
            "mxcRevision": "b" * 40,
            "workflowRunId": "123457",
            "workflowRunAttempt": "2",
            "sourceUnchanged": False,
            "currentPackageQualification": True,
            "rustToolchain": "unbound",
            "rustTarget": "x86_64-pc-windows-msvc",
            "licenseSha256": "b" * 64,
        }
        for field, value in changes.items():
            with self.subTest(field=field):
                changed = copy.deepcopy(self.host)
                changed["mxcBuild"][field] = value
                self.host_receipt.write_text(json.dumps(changed))
                with self.assertRaisesRegex(ValueError, "same-source, same-run"):
                    self.verify()
        self.host_receipt.write_text(json.dumps(self.host))
        for identity in ("", "0", "123456:1"):
            with self.subTest(run_id=identity):
                with self.assertRaises(ValueError):
                    gate.verify_mxc_input(self.host_root, self.revision, identity, self.run_attempt)

    def test_both_mxc_binaries_and_staged_inventory_must_match_proof(self):
        for index in range(2):
            for field, value in (("sha256", "b" * 64), ("bytes", 1)):
                with self.subTest(index=index, field=field):
                    changed = copy.deepcopy(self.host)
                    changed["files"][index][field] = value
                    self.host_receipt.write_text(json.dumps(changed))
                    with self.assertRaisesRegex(ValueError, "staging identities"):
                        self.verify()
            self.host_receipt.write_text(json.dumps(self.host))
            file = self.host_root / "mxc" / self.host["mxcBuild"]["files"][index]["file"]
            original = file.read_bytes()
            file.write_bytes(original + b"changed")
            with self.assertRaisesRegex(ValueError, "executable differs"):
                self.verify()
            file.write_bytes(original)
        for files in ([], self.host["mxcBuild"]["files"] * 2,
                      [self.host["mxcBuild"]["files"][0]] * 2):
            changed = copy.deepcopy(self.host)
            changed["mxcBuild"]["files"] = files
            self.host_receipt.write_text(json.dumps(changed))
            with self.assertRaises(ValueError):
                self.verify()

    def test_old_or_cross_run_proof_cannot_qualify_current_mxc(self):
        for field, value in (
            ("requestProfile", "existing-personal-node-compatibility"),
            ("mxcInput", {}),
            ("networkAccessTested", True),
        ):
            original = self.proof[field]
            self.proof[field] = value
            self.save()
            with self.assertRaisesRegex(ValueError, "Same-source"):
                self.verify()
            self.proof[field] = original
        self.policy["version"] = "0.6.0-alpha"
        self.save()
        with self.assertRaisesRegex(ValueError, "hashed actual request"):
            self.verify()
        self.policy["version"] = "1.0.0"
        self.policy["network"] = {
            "defaultPolicy": "allow", "allowedHosts": [],
            "blockedHosts": [], "allowLocalNetwork": True,
        }
        self.save()
        with self.assertRaisesRegex(ValueError, "hashed actual request"):
            self.verify()

    def test_file_only_proof_rejects_network_grants_and_old_profile(self):
        for section, field in (("egress", "default"), ("ingress", "default"),
                               ("ingress", "hostLoopback")):
            with self.subTest(section=section, field=field):
                self.policy["network"][section][field] = "allow"
                self.save()
                with self.assertRaisesRegex(ValueError, "hashed actual request"):
                    self.verify()
                self.policy["network"][section][field] = "deny"
        self.proof["requestPolicy"] = copy.deepcopy(gate.LEGACY_PROFILE)
        self.save()
        with self.assertRaisesRegex(ValueError, "Same-source"):
            self.verify()

    def test_actual_powershell_file_only_policy_denies_network(self):
        powershell = shutil.which("pwsh") or shutil.which("powershell.exe")
        self.assertIsNotNone(powershell, "These controls require PowerShell.")
        producer = MODULE.parent.parent / "host-preparation/test-system-root-mxc.ps1"
        script = self.root / "file-only-network.ps1"
        script.write_text(r'''param([string]$Source)
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'The proof producer does not parse.'}
$statements=@($ast.FindAll({param($node)
    if($node -is [Management.Automation.Language.AssignmentStatementAst]){
        return $node.Left.Extent.Text -cin @('$request','$receipt.requestPolicy')
    }
    return $node -is [Management.Automation.Language.IfStatementAst] -and
        $node.Clauses[0].Item1.Extent.Text -ceq '$HostPayloadReceipt' -and
        ($node.Extent.Text.Contains('$request.version =') -or
         $node.Extent.Text.Contains('$receipt.requestPolicy.Remove('))
},$true)|Sort-Object {$_.Extent.StartOffset})
if($statements.Count -ne 4){throw 'The actual proof policy construction is ambiguous.'}
$rows=@(foreach($current in @($false,$true)){
    $HostPayloadReceipt=$current;$receipt=[ordered]@{};$childEnvironment=[ordered]@{}
    foreach($statement in $statements){. ([ScriptBlock]::Create($statement.Extent.Text))}
    @{network=$request.network;profile=$receipt.requestPolicy}
})
$rows|ConvertTo-Json -Depth 6 -Compress
''')
        result = subprocess.run(
            [powershell, "-NoProfile", "-File", str(script), str(producer)],
            capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        expected = {"egress": {"default": "deny"},
                    "ingress": {"default": "deny", "hostLoopback": "deny"}}
        actual = json.loads(result.stdout)
        self.assertEqual(actual[0], {"network": gate.LEGACY_MXC_NETWORK,
                                     "profile": gate.LEGACY_PROFILE})
        self.assertEqual(actual[1], {"network": expected, "profile": gate.PROFILE})
        self.assertEqual(gate.MXC_NETWORK, expected)
        self.assertEqual(gate.PROFILE["network"], expected)

    def test_cli_requires_current_run_identity_without_creating_gate(self):
        output = self.root / "missing-run.json"
        environment = {key: value for key, value in os.environ.items()
                       if key not in {"GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"}}
        run = subprocess.run(self.command(output), capture_output=True, text=True, env=environment)
        self.assertNotEqual(run.returncode, 0)
        self.assertIn("same-source, same-run", run.stderr)
        self.assertFalse(output.exists())

    def legacy_fixture(self):
        self.proof["requestProfile"] = "existing-personal-node-compatibility"
        self.proof["requestPolicy"] = copy.deepcopy(gate.LEGACY_PROFILE)
        del self.proof["mxcInput"]
        self.policy["version"] = "0.6.0-alpha"
        self.policy["network"] = copy.deepcopy(gate.LEGACY_MXC_NETWORK)
        self.save()
        # Synthetic PE bytes remain inert; only the fixture's expected hashes change.
        return unittest.mock.patch.object(gate, "LEGACY_MXC_FILES", {
            row["file"]: row["sha256"] for row in self.host["mxcBuild"]["files"]
        })

    def test_legacy_evidence_cannot_be_reported_as_current_package_admission(self):
        with self.legacy_fixture():
            result = self.verify(legacy=True)
        self.assertEqual(result["classification"], "historical-sdk-system-drive-proof")
        self.assertEqual(result["mxcInput"]["sdkVersion"], "0.8.0")
        self.assertFalse(result["sameJobHostAlreadyPrepared"])
        self.assertFalse(result["installedAcceptance"])
        self.assertFalse(result["publicationApproved"])
        with self.assertRaisesRegex(ValueError, "Same-source"):
            self.verify()

    def test_legacy_still_requires_profile_denial_and_cleanup_evidence(self):
        with self.legacy_fixture():
            cases = (
                (self.proof, "mxcInput", {}),
                (self.proof, "requestProfile", "same-run-node-file-access"),
                (self.proof, "networkAccessTested", True),
                (self.policy, "version", "1.0.0"),
                (self.policy, "network", gate.MXC_NETWORK),
                (self.proof["guest"], "deniedRead", False),
                (self.proof, "workspaceRemoved", False),
                (self.proof, "mxcStopped", False),
            )
            for owner, field, value in cases:
                with self.subTest(field=field):
                    present, original = field in owner, owner.get(field)
                    owner[field] = value
                    self.save()
                    with self.assertRaises(ValueError):
                        self.verify(legacy=True)
                    if present:
                        owner[field] = original
                    else:
                        del owner[field]

    def test_legacy_rejects_substitution_of_either_binary(self):
        with self.legacy_fixture():
            for name in gate.LEGACY_MXC_FILES:
                path = self.host_root / "mxc" / name
                original = path.read_bytes()
                path.write_bytes(original + b"substitution")
                with self.assertRaisesRegex(ValueError, "immutable input"):
                    self.verify(legacy=True)
                path.write_bytes(original)

    def test_legacy_cli_checks_real_sdk_pins_without_creating_output(self):
        self.assertEqual(gate.LEGACY_MXC_FILES, {
            "wxc-exec.exe": "dde1c592270e9a659b01dccad70362da7b99fec114885fa4d625507aa775a503",
            "wxc-host-prep.exe": "c8ddcf0461ae3d7ddff4656abb87b51236146742bb711a2e03fdc23cb8a966b0",
        })
        output = self.root / "legacy.json"
        command = self.command(output)[:-2] + [
            "--legacy-mxc-directory", str(self.host_root / "mxc"),
        ]
        run = subprocess.run(command, capture_output=True, text=True)
        self.assertNotEqual(run.returncode, 0)
        self.assertIn("immutable input", run.stderr)
        self.assertFalse(output.exists())

    def test_cli_rejects_absent_or_ambiguous_input_mode(self):
        output = self.root / "ambiguous.json"
        for command in (
            self.command(output)[:-2],
            self.command(output) + ["--legacy-mxc-directory", str(self.host_root / "mxc")],
        ):
            run = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(run.returncode, 2, run.stderr)
            self.assertFalse(output.exists())

    def test_proof_cannot_be_reused_for_rebuilt_same_run_mxc(self):
        for row in self.host["mxcBuild"]["files"]:
            file = self.host_root / "mxc" / row["file"]
            data = file.read_bytes() + b"rebuilt"
            file.write_bytes(data)
            row.update(bytes=len(data), sha256=gate.sha(data))
        self.host["files"] = [{**row, "file": "mxc/" + row["file"]}
                              for row in self.host["mxcBuild"]["files"]]
        self.host_receipt.write_text(json.dumps(self.host))
        with self.assertRaisesRegex(ValueError, "Same-source"):
            self.verify()
        self.proof["mxcInput"] = gate.verify_mxc_input(
            self.host_root, self.revision, self.run_id, self.run_attempt,
        )
        self.save()
        self.assertEqual(self.verify()["mxcInput"], self.proof["mxcInput"])

    def test_base_container_is_not_reported_as_appcontainer_dacl_evidence(self):
        self.proof["selectedIsolationTier"] = "base-container"
        self.proof["needsDaclAugmentation"] = False
        (self.proof_dir / "mxc-native.log").write_text(
            "[1789582933] selected isolation tier: [1789582933] base-container[1789582933] \n"
        )
        self.save()
        result = self.verify()
        self.assertEqual(result["selectedIsolationTier"], "base-container")
        self.assertFalse(result["appContainerDaclExecution"])
        self.assertFalse(result["installedAcceptance"])
        self.proof["guest"]["deniedRead"] = False
        self.save()
        with self.assertRaisesRegex(ValueError, "read/deny/write"):
            self.verify()

    def test_missing_unknown_ambiguous_or_mismatched_tier_is_rejected(self):
        for log in (
            "missing selection",
            "selected isolation tier: none\n",
            "selected isolation tier: base-container\n",
            "selected isolation tier: appcontainer-dacl\nselected isolation tier: appcontainer-dacl\n",
            "selected isolation tier: appcontainer-dacl\nWin32k mitigation applied to child process\n",
        ):
            with self.subTest(log=log):
                (self.proof_dir / "mxc-native.log").write_text(log)
                with self.assertRaises(ValueError):
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
            ("selectedIsolationTier", "unknown"),
            ("needsDaclAugmentation", False),
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
        for field in (
            "allowedRead",
            "preservedMainPath",
            "preauthorizedRead",
            "deniedRead",
            "ownedWrite",
        ):
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
                "readonlyPaths": [
                    self.node_path,
                    self.preauthorized_path,
                    "C:\\",
                ],
                "readwritePaths": original["filesystem"]["readwritePaths"],
            },
            {
                "readonlyPaths": [
                    r"D:\other\node.exe",
                    self.preauthorized_path,
                ],
                "readwritePaths": original["filesystem"]["readwritePaths"],
            },
            {
                "readonlyPaths": [self.node_path, r"D:\other\workers"],
                "readwritePaths": original["filesystem"]["readwritePaths"],
            },
            {
                "readonlyPaths": [self.preauthorized_path, self.node_path],
                "readwritePaths": original["filesystem"]["readwritePaths"],
            },
            {
                "readonlyPaths": [self.node_path],
                "readwritePaths": original["filesystem"]["readwritePaths"],
            },
            {
                "readonlyPaths": [self.node_path, self.preauthorized_path],
                "readwritePaths": ["C:\\"],
            },
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

    def test_preauthorized_runtime_identity_cannot_be_weakened(self):
        changes = (
            ("readOnlyAttachment", False, "not read-only"),
            ("readMask", gate.READ_MASK - 1, "incomplete"),
        )
        for field, value, message in changes:
            with self.subTest(field=field):
                saved = self.proof["preauthorizedRuntime"][field]
                self.proof["preauthorizedRuntime"][field] = value
                self.save()
                with self.assertRaisesRegex(ValueError, message):
                    self.verify()
                self.proof["preauthorizedRuntime"][field] = saved
        access = self.proof["preauthorizedRuntime"]["workersAccess"]
        access[-1]["mask"] -= 1
        self.save()
        with self.assertRaisesRegex(ValueError, "exact package read grants"):
            self.verify()
        access[-1]["mask"] += 1
        mount_access = self.proof["preauthorizedRuntime"]["mountPointAccess"]
        mount_access[-1]["mask"] -= 1
        self.save()
        with self.assertRaisesRegex(ValueError, "exact package read grants"):
            self.verify()
        mount_access[-1]["mask"] += 1
        volume_access = self.proof["preauthorizedRuntime"]["volumeRootAccess"]
        volume_access[-1]["mask"] -= 1
        self.save()
        with self.assertRaisesRegex(ValueError, "exact package read grants"):
            self.verify()
        volume_access[-1]["mask"] += 1
        image = self.proof["preauthorizedRuntime"]["imageReceipt"]
        image["mountedReadOnly"] = False
        self.save()
        with self.assertRaisesRegex(ValueError, "image receipt"):
            self.verify()
        image["mountedReadOnly"] = True
        image["appContainerReadRoots"][0]["access"].pop()
        self.save()
        with self.assertRaisesRegex(ValueError, "exact package read grants"):
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
        tier_cases = [
            "[1789582933] selected isolation tier: [1789582933] base-container[1789582933] \r\n",
            "selected isolation tier: appcontainer-dacl\n",
            "selected isolation tier: none\n",
            "no tier",
            "selected isolation tier: base-container\nselected isolation tier: appcontainer-dacl\n",
            "selected isolation tier: base-container\nWin32k mitigation applied to child process\n",
        ]
        tier_path = self.root / "tiers.json"
        tier_path.write_text(json.dumps(tier_cases))
        link = self.root / "node-link.exe"
        link.symlink_to(self.helper)
        script = self.root / "compare.ps1"
        script.write_text(r"""param([string]$Source,[string]$Cases,[string]$File,[string]$Directory,[string]$Link,[string]$Tiers)
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'The actual producer did not parse.'}
foreach($name in @('Compare-ProofNodeAcl','Get-ProofNodeAttributes','Get-ProofIsolationTier')) {
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
$tierResults=@(foreach($log in (Get-Content -LiteralPath $Tiers -Raw|ConvertFrom-Json)){
  try{Get-ProofIsolationTier $log}catch{'rejected'}
})
@{results=$results;fileAttributes=$attributes;directoryRejected=$directoryRejected;linkRejected=$linkRejected;tiers=$tierResults}|ConvertTo-Json -Depth 6
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
                str(tier_path),
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
        self.assertEqual(
            actual["tiers"],
            ["base-container", "appcontainer-dacl", *(["rejected"] * 4)],
        )
        for log, expected in zip(tier_cases, actual["tiers"]):
            if expected == "rejected":
                with self.assertRaises(ValueError):
                    gate.isolation_tier(log)
            else:
                self.assertEqual(gate.isolation_tier(log), expected)

    def test_actual_powershell_mxc_admission_matches_packaging_verifier(self):
        powershell = shutil.which("pwsh") or shutil.which("powershell.exe")
        self.assertIsNotNone(powershell, "These controls require PowerShell.")
        producer = MODULE.parent.parent / "host-preparation/test-system-root-mxc.ps1"
        script = self.root / "mxc-input.ps1"
        script.write_text(r'''param([string]$Source,[string]$Receipt,[string]$Directory,[string]$Revision)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'The proof producer does not parse.'}
$owner=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Get-ProofMxcInput'},$true))
if($owner.Count -ne 1){throw 'The proof input owner is missing.'}
. ([ScriptBlock]::Create($owner[0].Extent.Text))
$accepted=Get-ProofMxcInput $Receipt $Directory $Revision '123456' '1'
$rejected=0
foreach($case in @(@(('b'*40),'123456','1'),@($Revision,'123457','1'),@($Revision,'123456','2'),@($Revision,'','1'))){
    try{$null=Get-ProofMxcInput $Receipt $Directory $case[0] $case[1] $case[2]}
    catch{$rejected++;continue}
    throw 'An unbound MXC input was accepted.'
}
@{accepted=$accepted;rejected=$rejected}|ConvertTo-Json -Depth 8
''')
        result = subprocess.run(
            [powershell, "-NoProfile", "-File", str(script), str(producer),
             str(self.host_receipt), str(self.host_root / "mxc"), self.revision],
            capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        actual = json.loads(result.stdout)
        self.assertEqual(actual["accepted"], self.proof["mxcInput"])
        self.assertEqual(actual["rejected"], 4)

    def test_failure_never_overwrites_existing_gate_receipt(self):
        output = self.root / "gate.json"
        output.write_text("keep original")
        run = subprocess.run(self.command(output), capture_output=True, text=True)
        self.assertNotEqual(run.returncode, 0)
        self.assertEqual(output.read_text(), "keep original")


if __name__ == "__main__":
    unittest.main()
