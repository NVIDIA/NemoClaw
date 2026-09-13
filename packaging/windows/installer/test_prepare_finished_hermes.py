# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Synthetic admission controls only; no native qualification or artifact download."""

import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import unittest
import zipfile

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location(
    "finished_hermes", HERE / "prepare-finished-hermes.py"
)
owner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owner)


class FinishedHermesIntake(unittest.TestCase):
    def setUp(self):
        self.pin = {
            "schemaVersion": 1,
            "classification": "personal-passing-hermes-installer-input",
            "status": "personal-passed",
            "sourceRevision": "a" * 40,
            "runId": 1,
            "candidateArtifact": {"id": 2, "bytes": 100, "sha256": "b" * 64},
            "personalEvidenceArtifact": {"id": 3, "bytes": 100, "sha256": "c" * 64},
            "candidateReceiptSha256": "d" * 64,
            "personalReceiptSha256": "e" * 64,
        }
        self.personal = {
            "schemaVersion": 1,
            "classification": "canonical-personal-mxc-feasibility",
            "sourceRevision": self.pin["sourceRevision"],
            "feasibilityPassed": True,
            "installedAcceptance": False,
            "fullAgentQualified": False,
            "cleanupErrors": [],
            "cleanup": dict.fromkeys(
                [
                    "executorClosed",
                    "hostDiagnosticChildrenClosed",
                    "profileDeleted",
                    "ownedRootsRemoved",
                ],
                True,
            ),
            "workload": {
                "passed": True,
                "components": [
                    {
                        "component": name,
                        "passed": True,
                        "execution": {
                            "exitCode": 0,
                            "childClosed": True,
                            "timedOut": False,
                            "outputExceeded": False,
                        },
                    }
                    for name in ["python", "bash", "conpty", "browser"]
                ],
            },
            "derivedRuntime": {
                "candidate": {"sha256": self.pin["candidateReceiptSha256"]}
            },
        }

    def test_published_edge_inputs_and_exact_bounded_fixture_are_admitted(self):
        published = owner.validate_pin(
            json.loads((HERE / "finished-hermes-inputs.json").read_text())
        )
        self.assertEqual(published["schemaVersion"], 3)
        self.assertEqual(published["browserMode"], "host-native-edge-cdp")
        owner.validate_pin(self.pin)
        for key, cap in [
            ("candidateArtifact", 2_000_000_000),
            ("personalEvidenceArtifact", 200_000_000),
        ]:
            changed = copy.deepcopy(self.pin)
            changed[key]["bytes"] = cap + 1
            with self.assertRaises(ValueError):
                owner.validate_pin(changed)

    def test_personal_requires_every_component_and_exact_candidate(self):
        owner.validate_personal(self.personal, self.pin)
        for index in range(4):
            value = copy.deepcopy(self.personal)
            value["workload"]["components"][index]["passed"] = False
            with self.assertRaises(ValueError):
                owner.validate_personal(value, self.pin)
        changed = copy.deepcopy(self.personal)
        changed["derivedRuntime"]["candidate"]["sha256"] = "f" * 64
        with self.assertRaises(ValueError):
            owner.validate_personal(changed, self.pin)

    def test_cleanup_and_unqualified_claims_are_required(self):
        for key in self.personal["cleanup"]:
            changed = copy.deepcopy(self.personal)
            changed["cleanup"][key] = False
            with self.assertRaises(ValueError):
                owner.validate_personal(changed, self.pin)

        for key in ["installedAcceptance", "fullAgentQualified"]:
            changed = {**self.personal, key: True}
            with self.assertRaises(ValueError):
                owner.validate_personal(changed, self.pin)

    def replay_fixture(self):
        pin = copy.deepcopy(self.pin)
        pin.update(
            schemaVersion=2,
            evidenceMode="immutable-replay",
            candidateSourceRevision=owner.REPLAY_BASE["sourceRevision"],
            candidateRunId=owner.REPLAY_BASE["runId"],
            personalSourceRevision=pin.pop("sourceRevision"),
            personalRunId=pin.pop("runId"),
        )
        pin["candidateArtifact"] = {
            "id": owner.REPLAY_BASE["artifactId"],
            "bytes": owner.REPLAY_BASE["bytes"],
            "sha256": owner.REPLAY_BASE["sha256"],
        }
        pin["candidateReceiptSha256"] = owner.REPLAY_BASE["candidateReceiptSha256"]
        candidate = {
            "controllerSource": owner.REPLAY_BASE["sourceRevision"],
            "inventorySha256": owner.REPLAY_BASE["inventorySha256"],
            "startupAdapterSha256": owner.REPLAY_BASE["startupAdapterSha256"],
            "fileCount": 2,
            "logicalBytes": 10,
        }
        raw = json.dumps(candidate).encode()
        record = copy.deepcopy(self.personal)
        record.update(
            candidateSource=owner.REPLAY_BASE["sourceRevision"],
            runtime=owner.REPLAY_BASE["runtimeRoot"],
        )
        record["derivedRuntime"]["candidate"] = {
            "sha256": hashlib.sha256(raw).hexdigest(),
            "bytes": len(raw),
            "value": candidate,
        }
        observed = {
            "allFilesAndDirectoriesVerified": True,
            "inventorySha256": owner.REPLAY_BASE["inventorySha256"],
            "files": 2,
            "logicalBytes": 10,
        }
        record["runtimeReplay"] = {
            "schemaVersion": 1,
            "classification": "immutable-canonical-hermes-personal-replay",
            "base": copy.deepcopy(owner.REPLAY_BASE),
            "controllerSource": pin["personalSourceRevision"],
            "runtimeRoot": owner.REPLAY_BASE["runtimeRoot"],
            **dict.fromkeys(
                [
                    "completeZipVerified",
                    "completeNestedArchiveVerified",
                    "sourceBuildProvenanceVerified",
                    "nativeComponentUnchanged",
                ],
                True,
            ),
            **dict.fromkeys(
                [
                    "runtimeRebuilt",
                    "runtimeRelocated",
                    "runtimeExported",
                    "runtimeExecutionQualified",
                    "installedAcceptance",
                ],
                False,
            ),
            "before": copy.deepcopy(observed),
            "after": copy.deepcopy(observed),
            "publicRuntimeAccess": {
                "classification": "fresh-public-runtime-rx-preparation",
                "sourceRevision": pin["personalSourceRevision"],
                "runtimeRoot": owner.REPLAY_BASE["runtimeRoot"],
                "status": "prepared",
                "emptyBeforeExtraction": True,
                "exactDeltaVerified": True,
                "handleClosed": True,
                "setSecurityStatus": 0,
                "error": None,
                "cleanupErrors": [],
                "before": {"descriptorHex": "synthetic-before"},
                "after": {"descriptorHex": "synthetic-after"},
                "sourceSha256": "a" * 64,
                "addedAce": {
                    "sid": "S-1-15-2-1",
                    "mask": 0x1200A9,
                    "flags": 3,
                    "hex": "00031800a9001200010200000000000f0200000001000000",
                },
            },
        }
        relative = "tools/browser-use/Lib/site-packages/browser_use/cli.py"
        record["workload"]["components"][0]["result"] = {
            "runtimeAccess": {
                "relativePath": relative,
                "path": owner.REPLAY_BASE["runtimeRoot"]
                + "\\"
                + relative.replace("/", "\\"),
                "passed": True,
                "creationDisposition": 3,
                "shareMode": 7,
                "fileFlags": 0x200000,
                "contentWriteAttempted": False,
                "operations": {
                    "read": {
                        "accessMask": 0x80000000,
                        "openSucceeded": True,
                        "readSucceeded": True,
                        "bytesRead": 64,
                        "handleClosed": True,
                        "closeError": 0,
                        "prefixSha256": "b" * 64,
                    },
                    "write": {
                        "accessMask": 2,
                        "openSucceeded": False,
                        "invalidHandleReturned": True,
                        "openError": 5,
                    },
                },
            }
        }
        return (
            pin,
            record,
            candidate,
            raw,
            {"runtimeRootAtExport": owner.REPLAY_BASE["runtimeRoot"]},
        )

    def test_replay_pin_separates_runs_and_remains_fixed_to_8d78(self):
        pin, record, *_ = self.replay_fixture()
        owner.validate_pin(pin)
        self.assertNotEqual(
            owner.source_run(pin, "candidate"), owner.source_run(pin, "personal")
        )
        record["derivedRuntime"]["candidate"]["sha256"] = pin["candidateReceiptSha256"]
        owner.validate_personal(record, pin)
        for key in [
            "candidateSourceRevision",
            "candidateRunId",
            "candidateReceiptSha256",
            "evidenceMode",
        ]:
            changed = copy.deepcopy(pin)
            changed[key] = "f" * 40 if "Revision" in key else 123
            with self.assertRaises(ValueError):
                owner.validate_pin(changed)
        for key in ["id", "bytes", "sha256"]:
            changed = copy.deepcopy(pin)
            changed["candidateArtifact"][key] = "f" * 64 if key == "sha256" else 123
            with self.assertRaises(ValueError):
                owner.validate_pin(changed)
        changed = copy.deepcopy(record)
        changed["sourceRevision"] = pin["candidateSourceRevision"]
        with self.assertRaises(ValueError):
            owner.validate_personal(changed, pin)
        with self.assertRaises(ValueError):
            owner.validate_personal(record, self.pin)
        with self.assertRaises(ValueError):
            owner.validate_personal(self.personal, pin)

    def test_replay_requires_exact_base_identity_and_complete_before_after(self):
        pin, record, candidate, raw, derivation = self.replay_fixture()
        owner.validate_replay(record, pin, candidate, raw, derivation)
        for section, field, value in [
            ("preparation", "exactDeltaVerified", False),
            ("preparation", "handleClosed", False),
            ("preparation", "runtimeRoot", r"C:\foreign"),
            ("preparation", "status", "failed"),
            ("read", "handleClosed", False),
            ("write", "openError", 32),
            ("write", "openSucceeded", True),
        ]:
            changed = copy.deepcopy(record)
            target = (
                changed["runtimeReplay"]["publicRuntimeAccess"]
                if section == "preparation"
                else changed["workload"]["components"][0]["result"]["runtimeAccess"][
                    "operations"
                ][section]
            )
            target[field] = value
            with self.assertRaises(ValueError):
                owner.validate_replay(changed, pin, candidate, raw, derivation)
        for phase in ["before", "after"]:
            for key, value in [
                ("allFilesAndDirectoriesVerified", False),
                ("inventorySha256", "f" * 64),
                ("files", 1),
                ("logicalBytes", 9),
            ]:
                changed = copy.deepcopy(record)
                changed["runtimeReplay"][phase][key] = value
                with self.assertRaises(ValueError):
                    owner.validate_replay(changed, pin, candidate, raw, derivation)
        for key in [
            "completeZipVerified",
            "completeNestedArchiveVerified",
            "sourceBuildProvenanceVerified",
            "nativeComponentUnchanged",
            "runtimeRebuilt",
            "runtimeRelocated",
            "runtimeExported",
            "runtimeExecutionQualified",
            "installedAcceptance",
        ]:
            changed = copy.deepcopy(record)
            changed["runtimeReplay"][key] = not changed["runtimeReplay"][key]
            with self.assertRaises(ValueError):
                owner.validate_replay(changed, pin, candidate, raw, derivation)
        for key in ["base", "controllerSource", "runtimeRoot"]:
            changed = copy.deepcopy(record)
            changed["runtimeReplay"][key] = {}
            with self.assertRaises(ValueError):
                owner.validate_replay(changed, pin, candidate, raw, derivation)
        for key in ["bytes", "sha256", "value"]:
            changed = copy.deepcopy(record)
            changed["derivedRuntime"]["candidate"][key] = None
            with self.assertRaises(ValueError):
                owner.validate_replay(changed, pin, candidate, raw, derivation)

    def test_only_personal_run_must_pass_for_the_fixed_failed_base(self):
        pin, *_ = self.replay_fixture()
        base = {
            "id": pin["candidateRunId"],
            "head_sha": pin["candidateSourceRevision"],
            "status": "completed",
            "conclusion": "failure",
            "path": ".github/workflows/windows-native-installer.yaml",
        }
        owner.validate_run(base, *owner.source_run(pin, "candidate"), passing=False)
        with self.assertRaises(ValueError):
            owner.validate_run(base, *owner.source_run(pin, "candidate"), passing=True)
        personal = {
            **base,
            "id": pin["personalRunId"],
            "head_sha": pin["personalSourceRevision"],
            "conclusion": "success",
        }
        owner.validate_run(personal, *owner.source_run(pin, "personal"), passing=True)
        for key, value in [
            ("id", 2),
            ("head_sha", pin["candidateSourceRevision"]),
            ("status", "in_progress"),
            ("conclusion", "failure"),
        ]:
            with self.assertRaises(ValueError):
                owner.validate_run(
                    {**personal, key: value},
                    *owner.source_run(pin, "personal"),
                    passing=True,
                )

    def test_replay_native_raw_documents_bind_staged_files_and_executor(self):
        _, record, *_ = self.replay_fixture()
        names = [
            "NemoClawMsysLauncher.exe",
            "NemoClawMsysCompat-arm64.dll",
            "NemoClawMsysCompat-x64.dll",
        ]
        build = {
            "sourceRevision": "b" * 40,
            "status": "built",
            "files": [{"file": n, "bytes": 10, "sha256": "c" * 64} for n in names],
            "license": {"file": "DETOURS-LICENSE.txt", "bytes": 20, "sha256": "d" * 64},
        }
        executor = {"file": "wxc-exec.exe", "bytes": 30, "sha256": "e" * 64}
        mxc = {"candidateRevision": "b" * 40, "status": "built", "files": [executor]}
        proof = {
            "passed": True,
            "normalCleanup": True,
            "phase": "two-container-isolation",
            "sourceRevision": "b" * 40,
            "inputs": {
                "compatibility": build,
                "mxcBuild": mxc,
                "mxcSha256": executor["sha256"],
            },
        }
        data = {
            "current-native-proof.json": json.dumps(proof).encode(),
            "current-msys-build.json": json.dumps(build).encode(),
            "current-mxc-build.json": json.dumps(mxc).encode(),
        }
        refs = {
            key: {
                "file": name,
                "bytes": len(data[name]),
                "sha256": hashlib.sha256(data[name]).hexdigest(),
            }
            for key, name in [
                ("proof", "current-native-proof.json"),
                ("compatibility", "current-msys-build.json"),
                ("mxc", "current-mxc-build.json"),
            ]
        }
        native_root = r"C:\NemoClawPersonalCompat-0123456789ab"
        staged = build["files"] + [
            build["license"],
            {
                "file": "build-receipt.json",
                **{k: refs["compatibility"][k] for k in ["bytes", "sha256"]},
            },
        ]
        native = {
            "sourceRevision": "b" * 40,
            "root": native_root,
            "documents": refs,
            "proof": refs["proof"],
            "build": refs["compatibility"],
            "executor": executor,
            "files": [{**r, "path": native_root + "\\" + r["file"]} for r in staged],
        }
        record["runtimeReplay"]["nativeComponent"] = native
        data["personal-request.json"] = json.dumps(
            {"process": {"commandLine": native_root + "\\NemoClawMsysLauncher.exe"}}
        ).encode()
        record["requestSha256"] = hashlib.sha256(
            data["personal-request.json"]
        ).hexdigest()
        spec = importlib.util.spec_from_file_location(
            "shared_candidate", HERE.parent / "hermes/verify-personal-candidate.py"
        )
        shared = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(shared)

        def collect(value, archived=data):
            stream = io.BytesIO()
            with zipfile.ZipFile(stream, "w") as z:
                for name, raw in archived.items():
                    z.writestr("personal-mxc/" + name, raw)
            with zipfile.ZipFile(stream) as z:
                return owner.replay_native_documents(z, shared, value)

        self.assertEqual(collect(record), data)
        # These are synthetic document controls, never a Windows success receipt.
        for key in ["proof", "compatibility", "mxc"]:
            changed = copy.deepcopy(record)
            changed["runtimeReplay"]["nativeComponent"]["documents"][key]["sha256"] = (
                "f" * 64
            )
            with self.assertRaises(ValueError):
                collect(changed)
        changed = copy.deepcopy(record)
        changed["runtimeReplay"]["nativeComponent"]["executor"]["sha256"] = "f" * 64
        with self.assertRaises(ValueError):
            collect(changed)
        changed = copy.deepcopy(record)
        changed["runtimeReplay"]["nativeComponent"]["files"][0]["path"] = (
            r"C:\elsewhere\NemoClawMsysLauncher.exe"
        )
        with self.assertRaises(ValueError):
            collect(changed)
        with self.assertRaises(ValueError):
            collect(record, {**data, "current-msys-build.json": b"{}"})
        with self.assertRaises(ValueError):
            collect(record, {**data, "personal-request.json": b"{}"})


if __name__ == "__main__":
    unittest.main()
