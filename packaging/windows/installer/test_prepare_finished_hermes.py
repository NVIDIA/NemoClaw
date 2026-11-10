# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Synthetic admission controls only; no native qualification or artifact download."""

import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
import zipfile

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location(
    "finished_hermes", HERE / "prepare-finished-hermes.py"
)
owner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owner)


spec = importlib.util.spec_from_file_location(
    "native_export_fixtures", HERE.parent / "hermes/test_native_export_admission.py"
)
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


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
        self.native_pin = {**self.pin, "schemaVersion": 4,
                           "evidenceMode": "same-source-native-personal"}
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

    def test_native_pin_binds_current_workflow_without_rewriting_historical_routes(self):
        owner.validate_pin(self.native_pin)
        self.assertEqual(owner.source_run(self.native_pin, "personal"),
                         owner.source_run(self.native_pin, "candidate"))
        run = {"id": 1, "head_sha": self.pin["sourceRevision"], "status": "completed",
               "conclusion": "success", "path": ".github/workflows/windows-native-installer-v2.yaml"}
        owner.validate_run(run, self.pin["sourceRevision"], 1, passing=True, native_mode=True)
        with self.assertRaises(ValueError):
            owner.validate_run(run, self.pin["sourceRevision"], 1, passing=True)
        for key, value in (("path", ".github/workflows/windows-native-installer.yaml"),
                           ("path", ".github/workflows/foreign.yaml"),
                           ("head_sha", "f" * 40), ("id", 2), ("conclusion", "failure"),
                           ("status", "in_progress")):
            with self.subTest(field=key, value=value), self.assertRaises(ValueError):
                owner.validate_run({**run, key: value}, self.pin["sourceRevision"], 1,
                                   passing=True, native_mode=True)
        for key, value in (("schemaVersion", True), ("evidenceMode", "immutable-replay"),
                           ("candidateRunId", 2), ("personalSourceRevision", "f" * 40),
                           ("browserMode", "host-native-edge-cdp")):
            with self.assertRaises(ValueError):
                owner.validate_pin({**self.native_pin, key: value})
        with self.assertRaises(ValueError):
            owner.validate_personal(self.personal, self.native_pin)
        fields, request, log = native.personal_fixture(self.pin["sourceRevision"])
        with self.assertRaises(ValueError):
            owner.validate_personal({**self.personal, **fields}, self.pin, request, log)

    def test_edge_receipt_is_one_exact_bounded_root_document(self):
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w") as archive:
            archive.writestr("edge-identity.json", '{"architecture":"arm64"}')
        with zipfile.ZipFile(io.BytesIO(stream.getvalue())) as archive:
            raw, value = owner.exact_root_document(
                archive, "edge-identity.json", 64 * 1024
            )
        self.assertEqual(value["architecture"], "arm64")
        self.assertGreater(len(raw), 0)
        for name in ("nested/edge-identity.json", "other.json"):
            stream = io.BytesIO()
            with zipfile.ZipFile(stream, "w") as archive:
                archive.writestr(name, "{}")
            with zipfile.ZipFile(io.BytesIO(stream.getvalue())) as archive:
                with self.assertRaises(ValueError):
                    owner.exact_root_document(archive, "edge-identity.json", 64 * 1024)

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

    def test_current_native_proof_uses_shared_export_admission(self):
        proof, compatibility, mxc = native.fixture()
        owner.validate_current_compatibility(
            proof, native.SHA, compatibility, mxc, native.CURRENT
        )

    def test_composition_requires_matching_personal_backend_source_and_tested_binaries(self):
        proof, compatibility, mxc = native.fixture()
        personal, _, _ = native.personal_fixture()
        compatibility.update(files=[], license={"file": "DETOURS-LICENSE.txt"})
        personal["hostInputs"] = {
            "mxc": {**mxc["files"][0], "peMachine": 0xAA64,
                    "path": personal["execution"]["executable"]},
            "compatibility": {"sourceRevision": native.CURRENT,
                              "mxcFile": copy.deepcopy(mxc["files"][0]),
                              "files": compatibility["files"], "license": compatibility["license"]},
        }
        owner.validate_personal_composition(personal, proof, compatibility, mxc, native.CURRENT)
        legacy = {"classification": "small-msys-appcontainer-compatibility-proof"}
        owner.validate_personal_composition(self.personal, legacy, {}, {}, self.pin["sourceRevision"])
        for candidate, component in ((personal, legacy), (self.personal, proof)):
            with self.assertRaises(ValueError):
                owner.validate_personal_composition(candidate, component, compatibility, mxc, native.CURRENT)
        for mutate in (
            lambda r: r.update(sourceRevision="f" * 40),
            lambda r: r["hostInputs"]["mxc"].update(sha256="f" * 64),
            lambda r: r["hostInputs"]["compatibility"].update(sourceRevision="f" * 40),
            lambda r: r["hostInputs"]["compatibility"]["mxcFile"].update(bytes=124),
            lambda r: r["hostInputs"]["compatibility"].update(files=[{"file": "foreign.dll"}]),
        ):
            changed = copy.deepcopy(personal)
            mutate(changed)
            with self.assertRaises(ValueError):
                owner.validate_personal_composition(changed, proof, compatibility, mxc, native.CURRENT)

    def state_owner_fixture(self, root):
        launcher = root / "official-hermes-runtime-build/state-owner-helper/NemoClaw.exe"
        launcher.parent.mkdir(parents=True, exist_ok=True)
        # Parser fixture only: not an executable or native qualification evidence.
        executable = bytearray(128)
        executable[:2] = b"MZ"
        executable[60:64] = (64).to_bytes(4, "little")
        executable[64:70] = b"PE\0\0\x64\xaa"
        launcher.write_bytes(executable)
        source_root = HERE.parent / "launcher"
        sources = [{"file": file.relative_to(source_root).as_posix(),
                    "bytes": file.stat().st_size, "sha256": hashlib.sha256(file.read_bytes()).hexdigest()}
                   for file in [source_root / "Cargo.toml", source_root / "Cargo.lock",
                                *sorted((source_root / "src").rglob("*.rs"))]]
        build = {"schemaVersion": 1, "classification": "personal-native-state-owner-build",
                 "sourceRevision": self.pin["sourceRevision"], "workflowRunId": "123", "workflowRunAttempt": "2",
                 "target": "aarch64-pc-windows-msvc", "immutableRuntime": False, "buildProcessesClosed": True,
                 "file": str(launcher), "bytes": len(executable),
                 "sha256": hashlib.sha256(executable).hexdigest(), "sources": sources}
        raw = json.dumps(build).encode()
        (root / "state-owner-build.json").write_bytes(raw)
        sid = "S-1-5-21-111-222-333-1001"
        state_root = "C:\\NemoClawState-" + sid + "-hermes"
        personal = {
            "runtime": r"C:\NemoClawHermesProbe-001122334455",
            "workload": {"nonce": "00112233445566778899aabb"},
            "nativeStateBuild": {
                "launcher": str(launcher), "sources": copy.deepcopy(sources),
                "executable": {"path": str(launcher), "bytes": len(executable), "sha256": build["sha256"],
                               "peMachine": 0xAA64, "architecture": "arm64"},
                "receipt": {"path": str(root / "state-owner-build.json"), "bytes": len(raw),
                            "sha256": hashlib.sha256(raw).hexdigest(), "peMachine": None,
                            "architecture": "non-PE-or-unknown"}},
            "nativeState": {"schemaVersion": 1, "classification": "personal-native-state-owner",
                            "stateRoot": state_root, "inspectionClosed": True, "sessionAttempted": True,
                            "created": True, "sessionReleased": True, "removalAttempted": True,
                            "removed": True, "removalReleased": True, "ownerUnreferenced": False,
                            "retained": False, "complete": True},
            "cleanup": {"nativeStateComplete": True},
            "hostDesktopCleanup": {"postExecutorObservation": {
                "request": {"hostUserSid": sid}, "receipt": {"value": {"context": {"hostUserSid": sid}}}}},
        }
        environment = {key: state_root + "\\home" for key in
                       ("HERMES_HOME", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA")}
        environment.update(NEMOCLAW_AGENT_HOME=state_root, TEMP=state_root + "\\temp", TMP=state_root + "\\temp",
                           NEMOCLAW_MSYS_TOKEN_INSPECTION_HOLD="hermes-query")
        request = {"containerId": "nm-001122334455-start",
                   "process": {"cwd": state_root, "env": [key + "=" + value for key, value in environment.items()]},
                   "filesystem": {"readwritePaths": [state_root]}}
        return build, personal, request

    def test_native_state_admission_requires_typed_closed_custody_and_exact_host_authority(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            _, personal, request = self.state_owner_fixture(root)
            def check(p=personal, r=request):
                return owner.validate_same_run_state_owner(root, p, r, self.pin["sourceRevision"], "123", "2")
            self.assertEqual(check(), (root / "state-owner-build.json").read_bytes())
            for field, original in personal["nativeState"].items():
                invalid = [None, "invalid", not original] if type(original) is bool else [None, True, "invalid"]
                if type(original) is bool:
                    invalid.append(int(original))
                for value in invalid:
                    changed = copy.deepcopy(personal)
                    changed["nativeState"][field] = value
                    with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                        check(changed)
                changed = copy.deepcopy(personal)
                del changed["nativeState"][field]
                with self.subTest(missing=field), self.assertRaises(ValueError):
                    check(changed)
            for mutate in (
                lambda p: p.update(nativeState=None),
                lambda p: p["nativeState"].update(extra=True),
                lambda p: p["cleanup"].update(nativeStateComplete=1),
                lambda p: p.update(runtime=r"D:\NemoClawHermesProbe-001122334455"),
                lambda p: p["workload"].update(nonce="f" * 24),
                lambda p: p["hostDesktopCleanup"]["postExecutorObservation"]["request"].update(hostUserSid="S-1-5-18"),
                lambda p: p["hostDesktopCleanup"]["postExecutorObservation"]["receipt"]["value"]["context"].update(hostUserSid="S-1-5-18"),
                lambda p: p["nativeStateBuild"]["executable"].update(bytes=128.0),
                lambda p: p["nativeStateBuild"]["executable"].update(peMachine=float(0xAA64)),
                lambda p: p["nativeStateBuild"]["receipt"].update(sha256="f" * 64),
                lambda p: p["nativeStateBuild"]["sources"][0].update(bytes=float(p["nativeStateBuild"]["sources"][0]["bytes"])),
            ):
                changed = copy.deepcopy(personal)
                mutate(changed)
                with self.assertRaises(ValueError):
                    check(changed)
            for section in ("nativeStateBuild", "cleanup", "workload", "hostDesktopCleanup"):
                for value in (None, [], "invalid"):
                    with self.subTest(section=section, value=value), self.assertRaises(ValueError):
                        check({**personal, section: value})
            for mutate in (
                lambda r: r.update(containerId="nm-ffffffffffff-start"),
                lambda r: r["process"].update(cwd=r"C:\other"),
                lambda r: r["process"].update(cwd=r"C:\NemoClawMsysProof-001122334455-state-start"),
                lambda r: r["filesystem"].update(readwritePaths=["C:\\"]),
                lambda r: r["filesystem"]["readwritePaths"].insert(0, r"C:\NemoClawMsysProof-001122334455-state-start"),
                lambda r: r["process"]["env"].append("NEMOCLAW_MSYS_TOKEN_INSPECTION=hermes-query"),
                lambda r: r["process"]["env"].append("NEMOCLAW_HERMES_PRIVATE_DESKTOP=1"),
                lambda r: r["process"]["env"].append("home=C:\\foreign"),
                lambda r: r["process"].update(env=["INVALID"]),
                lambda r: r.update(process=None),
                lambda r: r.update(filesystem=[]),
            ):
                changed = copy.deepcopy(request)
                mutate(changed)
                with self.assertRaises(ValueError):
                    check(r=changed)
            for index in range(len(request["process"]["env"])):
                changed = copy.deepcopy(request)
                changed["process"]["env"][index] = changed["process"]["env"][index].split("=", 1)[0] + "=C:\\foreign"
                with self.subTest(environment=index), self.assertRaises(ValueError):
                    check(r=changed)

    def test_native_state_admission_binds_same_run_helper_bytes_and_sources(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            build, personal, request = self.state_owner_fixture(root)
            def check():
                return owner.validate_same_run_state_owner(root, personal, request, self.pin["sourceRevision"], "123", "2")
            for field, value in (
                ("schemaVersion", True), ("classification", "other"), ("sourceRevision", "f" * 40),
                ("workflowRunId", "124"), ("workflowRunAttempt", "3"), ("target", "x86_64-pc-windows-msvc"),
                ("immutableRuntime", 0), ("buildProcessesClosed", 1), ("file", "other.exe"),
                ("bytes", 128.0), ("sha256", "f" * 64), ("sources", []),
                ("sources", [{"file": 1}]),
            ):
                (root / "state-owner-build.json").write_text(json.dumps({**build, field: value}))
                with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                    check()
            for mutate in (
                lambda b: b["sources"][0].update(bytes=float(b["sources"][0]["bytes"])),
                lambda b: b["sources"][0].update(sha256="f" * 64),
                lambda b: b["sources"].append(b["sources"][0]),
            ):
                changed = copy.deepcopy(build)
                mutate(changed)
                (root / "state-owner-build.json").write_text(json.dumps(changed))
                with self.assertRaises(ValueError):
                    check()
            for value in (None, [], "invalid"):
                (root / "state-owner-build.json").write_text(json.dumps(value))
                with self.assertRaises(ValueError):
                    check()
            (root / "state-owner-build.json").write_text(json.dumps(build))
            launcher = Path(build["file"])
            original = launcher.read_bytes()
            for content in (b"MZ", original[:64] + b"PE\0\0\x64\x86" + original[70:], original + b"changed"):
                launcher.write_bytes(content)
                with self.assertRaises(ValueError):
                    check()
            launcher.write_bytes(original)
            os.link(launcher, root / "aliased-helper.exe")
            with self.assertRaises(ValueError):
                check()

    def test_same_run_archive_staging_requires_current_closed_production(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "producer"
            root.mkdir()
            candidate_root = root / "official-hermes-runtime-candidate"
            build_root = root / "official-hermes-runtime-build"
            personal_root = root / "personal-mxc"
            for directory in (candidate_root, build_root, personal_root):
                directory.mkdir()
            archive_name = "official-hermes-runtime-candidate.tar.gz"
            candidate_raw = json.dumps({"archive": {"file": archive_name}}).encode()
            candidate_sha = hashlib.sha256(candidate_raw).hexdigest()
            (candidate_root / "runtime-candidate.json").write_bytes(candidate_raw)
            (candidate_root / archive_name).write_bytes(b"synthetic archive; never executed or qualified")
            for name in ("official-runtime-build.json", "native-adaptation.json"):
                (build_root / name).write_text("{}")
            runtime = r"C:\NemoClawHermesProbe-001122334455"
            _, personal, request = self.state_owner_fixture(root)
            node = {"path": r"C:\bootstrap\node.exe", "bytes": 100,
                    "sha256": "97cce5301a815d2dce07ac5bfd1e6039eae88185ec1d10ae4f8cb712f1732878"}
            personal.update(feasibilityPassed=True, hostInputs={"node": node})
            nonce = personal["workload"]["nonce"]
            page = "data:text/html;base64," + owner.base64.b64encode(
                ('<!doctype html><title>Hermes Personal proof</title><p id="sentinel">' + nonce + '</p>').encode()
            ).decode()
            relay = personal["nativeState"]["stateRoot"] + "\\browser-relay-" + nonce
            launcher = personal["nativeStateBuild"]["executable"]
            personal["nativeBrowser"] = {
                "schemaVersion": 1, "classification": "personal-native-edge-browser", "nonce": nonce,
                "runtime": runtime, "transport": "guarded-file-native-pipe", "generalHostProxy": False,
                "inheritedKillOnCloseJob": True, "cleanupErrors": [],
                **dict.fromkeys(("closed", "relayClosed", "edgeClosed", "relayOwnerClosed"), True),
                "identityLauncher": {key: launcher[key] for key in ("path", "bytes", "sha256")},
                "identity": {"classification": "native-arm64-microsoft-edge", "architecture": "arm64",
                             "machine": 0xAA64, "productName": "Microsoft Edge", "signatureStatus": "Valid",
                             "provenance": "standard-windows-microsoft-edge-installation", "bytes": 123, "sha256": "e" * 64},
                "endpoint": {"port": 45678, "path": "/devtools/browser/owned"},
                "relayRoot": relay, "pageKind": "inline-html", "pageUrl": page,
            }
            personal["cleanup"]["nativeBrowserComplete"] = True
            personal["workload"].update(browserTransport={"attempted": True, "started": True, "closed": True},
                components=[{"component": "browser", "passed": True, "result": {"details": {
                    "nativeEdgeTransport": True, "pageServerOwner": None, "pageKind": "inline-html",
                    "canonicalBrowserCleanupCalled": True,
                    "browserHarnessShutdown": {"complete": True, "processExitObserved": True, "identityReconfirmed": True,
                                               "handleClosed": True, "transport": "native-hermes-browser-pipe"},
                    "pageObservation": {"visible": True, "actual": {"sentinel": nonce, "url": page}},
                }}}])
            request["process"]["env"].extend(key + "=" + value for key, value in {
                "NEMOCLAW_PERSONAL_BROWSER_SESSION": nonce, "NEMOCLAW_AGENT_SESSION_ID": nonce[:10],
                "NEMOCLAW_WORKER_ROOT": runtime[:3] + "NemoClawPersonalNode-" + nonce[:12] + "\\workers",
                "NEMOCLAW_BROWSER_RELAY_ROOT": relay, "NEMOCLAW_HERMES_BROWSER_PIPE_PORT": "8124",
                "NEMOCLAW_BROWSER_CDP_PATH": "/devtools/browser/owned", "NEMOCLAW_PERSONAL_BROWSER_PAGE": page,
                "BROWSER_CDP_URL": "ws://127.0.0.1:8124/devtools/browser/owned",
                "BU_CDP_WS": "ws://127.0.0.1:8124/devtools/browser/owned",
            }.items())
            owner.validate_same_run_browser(personal, request)
            for keys, value in [(("nativeBrowser", "closed"), False), (("nativeBrowser", "pageKind"), "localhost-http"),
                                (("nativeBrowser", "pageUrl"), page + "#changed"), (("nativeBrowser", "generalHostProxy"), True),
                                (("nativeBrowser", "identity", "machine"), 0x8664),
                                (("nativeBrowser", "identityLauncher", "sha256"), "f" * 64),
                                (("workload", "browserTransport", "closed"), False),
                                (("cleanup", "nativeBrowserComplete"), False)]:
                changed = copy.deepcopy(personal)
                target = changed
                for key in keys[:-1]: target = target[key]
                target[keys[-1]] = value
                with self.subTest(browser_field=keys), self.assertRaises(ValueError):
                    owner.validate_same_run_browser(changed, request)
            for keys, value in [(("pageKind",), "localhost-http"), (("pageServerOwner",), "host-job"),
                                (("pageObservation", "visible"), False),
                                (("pageObservation", "actual", "sentinel"), "b" * 24),
                                (("pageObservation", "actual", "url"), "about:blank"),
                                (("browserHarnessShutdown", "processExitObserved"), False),
                                (("browserHarnessShutdown", "identityReconfirmed"), False)]:
                changed = copy.deepcopy(personal)
                target = changed["workload"]["components"][0]["result"]["details"]
                for key in keys[:-1]: target = target[key]
                target[keys[-1]] = value
                with self.subTest(browser_detail=keys), self.assertRaises(ValueError):
                    owner.validate_same_run_browser(changed, request)
            for other in ("http://127.0.0.1:34567/" + nonce, page + "#changed"):
                changed, changed_request = copy.deepcopy(personal), copy.deepcopy(request)
                changed["nativeBrowser"]["pageUrl"] = other
                changed["workload"]["components"][0]["result"]["details"]["pageObservation"]["actual"]["url"] = other
                changed_request["process"]["env"] = [
                    "NEMOCLAW_PERSONAL_BROWSER_PAGE=" + other if entry.startswith("NEMOCLAW_PERSONAL_BROWSER_PAGE=") else entry
                    for entry in changed_request["process"]["env"]
                ]
                with self.subTest(page=other), self.assertRaises(ValueError):
                    owner.validate_same_run_browser(changed, changed_request)
            personal_raw = json.dumps(personal).encode()
            (personal_root / "personal-feasibility.json").write_bytes(personal_raw)
            (personal_root / "personal-request.json").write_text(json.dumps(request))
            (personal_root / "mxc-native.log").write_text("fixture, not native proof")
            common = {"schemaVersion": 1, "workflowRunId": "123", "workflowRunAttempt": "2",
                      "runtimeRoot": runtime, "buildProcessesClosed": True, "installedAcceptance": False}
            phase = {**common, "sourceRevision": self.pin["sourceRevision"],
                     "classification": "canonical-personal-mxc-candidate-feasibility", "status": "pass",
                     "currentNativeProduction": True, "diagnosticOnly": False, "cleanupErrors": [],
                     "runtimeRootRemoved": True, "runtimeRetainedForUnclosedBuild": False,
                     "runtimeRetainedForUnclosedExecutor": False, "runtimeRebuilt": True,
                     "runtimeExported": True, "fullAgentQualified": False, "replayInputSha256": None,
                     "derivedCandidateReceiptSha256": candidate_sha}
            build = {**common, "controllerSource": self.pin["sourceRevision"],
                     "classification": "official-hermes-runtime-build-phase",
                     "status": "candidate-bytes-exported-unqualified", "runtimeExecutionQualified": False,
                     "activationAllowed": False, "candidateReceiptSha256": candidate_sha,
                     "stateOwnerBuildAttempted": True, "stateOwnerBuildClosed": True}
            host = {"schemaVersion": 1, "classification": "personal-native-host-process-owner",
                    "sourceRevision": self.pin["sourceRevision"], "runtimeRoot": runtime,
                    "workflowRunId": "123", "workflowRunAttempt": "2", "nonce": "f" * 24,
                    "stateRoot": "C:\\NemoClawPersonalHost-" + "f" * 12,
                    "operationSucceeded": True, "diagnosticOnly": False, "canonicalQualification": False,
                    "installedAcceptance": False, "processCreated": True, "primaryError": None,
                    "childrenClosed": True, "cleanupComplete": True,
                    "execution": {"resumed": True, "childClosed": True, "exitCode": 0, "timedOut": False,
                                  "outputExceeded": False, "error": None},
                    "job": {"created": True, "assignedBeforeResume": True, "rootMembershipVerified": True,
                            "limitFlags": 8192, "activeAfterCleanup": 0, "forcedTermination": False},
                    "cleanup": {**dict.fromkeys(("captureClosed", "processHandleClosed", "threadHandleClosed",
                                               "jobHandleClosed", "stateRemoved"), True), "errors": []},
                    "result": {"passed": True, "file": str(personal_root / "personal-feasibility.json"),
                               "bytes": len(personal_raw), "sha256": hashlib.sha256(personal_raw).hexdigest()},
                    "inputs": {node["path"]: {"bytes": node["bytes"], "sha256": node["sha256"]}}}
            for name in ("probe-personal-candidate.mts", "personal-native-host.py", "probe-host-browser.py"):
                file = HERE.parent / "hermes" / name
                content = file.read_bytes()
                host["inputs"][str(file)] = {"bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()}
            def save_host(value=host):
                raw = json.dumps(value).encode()
                (root / "personal-host-owner.json").write_bytes(raw)
                phase.update(hostProcessOwnerAttempted=True, hostProcessOwnerClosed=True,
                             hostProcessOwner={"file": "personal-host-owner.json", "bytes": len(raw),
                                               "sha256": hashlib.sha256(raw).hexdigest(), "childrenClosed": True})
            save_host()
            def save(p=phase, b=build):
                (root / "personal-phase.json").write_text(json.dumps(p))
                (root / "official-hermes-runtime-phase.json").write_text(json.dumps(b))
            def stage(name):
                output = Path(temporary) / name
                output.mkdir()
                return owner.prepare_same_run_archives(root, output, self.pin["sourceRevision"], "123", "2")
            save()
            context, runs, paths = stage("valid")
            self.assertEqual(context["schemaVersion"], 5)
            self.assertEqual(owner.source_run(context, "candidate"), (self.pin["sourceRevision"], 123))
            self.assertEqual(context["candidateReceiptSha256"], candidate_sha)
            self.assertFalse(runs[123]["workflowCompleted"])
            self.assertNotIn("conclusion", runs[123])
            with zipfile.ZipFile(paths["candidateArtifact"]) as archive:
                self.assertEqual(archive.read("candidate/runtime-candidate.json"), candidate_raw)
                self.assertEqual(archive.read("build/native-adaptation.json"), b"{}")
            with zipfile.ZipFile(paths["personalEvidenceArtifact"]) as archive:
                self.assertEqual(archive.read("personal/personal-feasibility.json"), personal_raw)
                state_raw = archive.read("personal/state-owner-build.json")
                self.assertEqual(state_raw, (root / "state-owner-build.json").read_bytes())
                self.assertEqual(context["nativeStateBuildSha256"], hashlib.sha256(state_raw).hexdigest())
                host_raw = archive.read("personal/host-process-owner.json")
                self.assertEqual(host_raw, (root / "personal-host-owner.json").read_bytes())
                self.assertEqual(context["nativeHostOwnerSha256"], hashlib.sha256(host_raw).hexdigest())
            # Staging is not admission: incomplete native evidence and downloaded schema5 pins fail.
            with self.assertRaises(ValueError):
                owner.validate_personal(json.loads(personal_raw), context)
            with self.assertRaises(ValueError):
                owner.validate_pin(context)
            for index, (section, field, value) in enumerate([
                ("phase", "sourceRevision", "f" * 40), ("build", "controllerSource", "f" * 40),
                *[(section, key, value) for section in ("phase", "build") for key, value in (
                    ("schemaVersion", True), ("workflowRunId", "124"), ("workflowRunAttempt", "1"),
                    ("status", "failed"), ("buildProcessesClosed", 1), ("installedAcceptance", True))],
                *[("phase", key, value) for key, value in (
                    ("currentNativeProduction", False), ("diagnosticOnly", True), ("cleanupErrors", ["unclosed"]),
                    ("runtimeRootRemoved", False), ("runtimeRetainedForUnclosedBuild", True),
                    ("runtimeRetainedForUnclosedExecutor", True), ("runtimeRebuilt", False),
                    ("runtimeExported", False), ("fullAgentQualified", True), ("replayInputSha256", "f" * 64),
                    ("derivedCandidateReceiptSha256", "f" * 64), ("runtimeRoot", r"C:\unrelated"))],
                ("build", "candidateReceiptSha256", "f" * 64), ("build", "runtimeRoot", r"C:\unrelated"),
                ("build", "runtimeExecutionQualified", True), ("build", "activationAllowed", True),
                *[("build", key, value) for key in ("stateOwnerBuildAttempted", "stateOwnerBuildClosed")
                  for value in (False, 1, None)],
                *[("phase", key, value) for key in ("hostProcessOwnerAttempted", "hostProcessOwnerClosed")
                  for value in (False, 1, None)],
                ("phase", "hostProcessOwner", {}),
            ]):
                p, b = copy.deepcopy(phase), copy.deepcopy(build)
                (p if section == "phase" else b)[field] = value
                save(p, b)
                with self.subTest(section=section, field=field), self.assertRaises(ValueError):
                    stage("invalid-" + str(index))
            for index, (keys, value) in enumerate([
                (("sourceRevision",), "f" * 40), (("workflowRunId",), "124"),
                (("operationSucceeded",), False), (("primaryError",), "failed"),
                (("diagnosticOnly",), True), (("canonicalQualification",), True),
                (("processCreated",), False), (("nonce",), "not-a-nonce"), (("stateRoot",), r"C:\foreign"),
                (("execution", "exitCode"), False), (("execution", "timedOut"), True),
                (("execution", "outputExceeded"), True), (("execution", "error"), "unclosed"),
                (("job", "assignedBeforeResume"), False), (("job", "rootMembershipVerified"), 1),
                (("job", "limitFlags"), 0), (("job", "forcedTermination"), True),
                (("job", "activeAfterCleanup"), 1), (("cleanup", "captureClosed"), False),
                (("cleanup", "stateRemoved"), False), (("result", "passed"), 1),
                (("result", "sha256"), "f" * 64), (("inputs",), {}),
                (("inputs", node["path"], "sha256"), "f" * 64),
            ]):
                changed = copy.deepcopy(host)
                target = changed
                for key in keys[:-1]:
                    target = target[key]
                target[keys[-1]] = value
                save_host(changed)
                save()
                with self.subTest(host=keys), self.assertRaises(ValueError):
                    stage("invalid-host-" + str(index))
            save_host()
            save()
            (candidate_root / "unrelated.exe").write_bytes(b"not admitted")
            with self.assertRaises(ValueError):
                stage("extra")
            (candidate_root / "unrelated.exe").unlink()
            os.link(candidate_root / "runtime-candidate.json", Path(temporary) / "outside-hardlink")
            with self.assertRaises(ValueError):
                stage("hardlinked")

    def test_native_runtime_inventory_binds_both_comparisons_to_packaged_bytes(self):
        source = self.native_pin["sourceRevision"]
        runtime = r"C:\NemoClawHermesProbe-001122334455"
        inventory = {"files": [{"path": "lib/module.py", "bytes": 3,
                                "sha256": hashlib.sha256(b"abc").hexdigest()}],
                     "directories": ["lib"]}
        candidate = {"controllerSource": source, "fileCount": 1, "logicalBytes": 3,
                     "inventorySha256": hashlib.sha256(json.dumps(inventory).encode()).hexdigest()}
        raw = json.dumps(candidate).encode()
        sha = hashlib.sha256(raw).hexdigest()
        identity = (len(raw), sha)
        observed = {"allFilesAndDirectoriesVerified": True, "files": 1, "directories": 1,
                    "logicalBytes": 3, "inventorySha256": candidate["inventorySha256"]}
        record = {"sourceRevision": source, "candidateSource": source, "runtime": runtime,
                  "derivedRuntime": {"candidate": {"value": candidate, "bytes": len(raw), "sha256": sha}},
                  "runtimeInventory": {"schemaVersion": 1,
                                       "classification": "current-canonical-Personal-runtime-inventory",
                                       "sourceRevision": source, "runtimeRoot": runtime,
                                       "candidateReceiptSha256": sha,
                                       "before": copy.deepcopy(observed), "after": copy.deepcopy(observed)}}
        derivation = {"runtimeRootAtExport": runtime}
        owner.validate_native_runtime_inventory(record, candidate, identity, derivation, inventory, source)
        changes = [
            lambda r: r.update(runtimeInventory=None),
            lambda r: r.update(sourceRevision="f" * 40),
            lambda r: r.update(candidateSource="f" * 40),
            lambda r: r.update(runtime=r"C:\NemoClawHermesProbe-ffeeddccbbaa"),
            lambda r: r["derivedRuntime"]["candidate"].update(bytes=True),
            lambda r: r["derivedRuntime"]["candidate"].update(sha256="f" * 64),
            lambda r: r["derivedRuntime"]["candidate"]["value"].update(fileCount=2),
            lambda r: r["runtimeInventory"].update(schemaVersion=True),
            lambda r: r["runtimeInventory"].update(classification="immutable-canonical-hermes-personal-replay"),
            lambda r: r["runtimeInventory"].update(sourceRevision="f" * 40),
            lambda r: r["runtimeInventory"].update(runtimeRoot=r"C:\unrelated"),
            lambda r: r["runtimeInventory"].update(candidateReceiptSha256="f" * 64),
        ]
        for index, mutate in enumerate(changes):
            changed = copy.deepcopy(record)
            mutate(changed)
            with self.subTest(identity=index), self.assertRaises(ValueError):
                owner.validate_native_runtime_inventory(changed, candidate, identity, derivation, inventory, source)
        for phase in ("before", "after"):
            for field, value in (("allFilesAndDirectoriesVerified", 1), ("inventorySha256", "f" * 64),
                                 ("files", 2), ("directories", 0), ("logicalBytes", 4),
                                 ("files", True), ("directories", True), ("logicalBytes", 3.0)):
                changed = copy.deepcopy(record)
                changed["runtimeInventory"][phase][field] = value
                with self.subTest(phase=phase, field=field, value=value), self.assertRaises(ValueError):
                    owner.validate_native_runtime_inventory(changed, candidate, identity, derivation, inventory, source)
            changed = copy.deepcopy(record)
            changed["runtimeInventory"][phase] = None
            with self.subTest(missing=phase), self.assertRaises(ValueError):
                owner.validate_native_runtime_inventory(changed, candidate, identity, derivation, inventory, source)
        for changed_identity, changed_source, changed_derivation, changed_inventory in (
            ((len(raw) + 1, sha), source, derivation, inventory),
            ((len(raw), "f" * 64), source, derivation, inventory),
            (identity, "f" * 40, derivation, inventory),
            (identity, source, {"runtimeRootAtExport": r"C:\other"}, inventory),
            (identity, source, derivation, {**inventory, "files": [{**inventory["files"][0], "bytes": 4}]}),
            (identity, source, derivation, {**inventory, "files": [{**inventory["files"][0], "bytes": True}]}),
            (identity, source, derivation, {**inventory, "files": [{**inventory["files"][0], "linkTarget": "other"}]}),
        ):
            with self.assertRaises(ValueError):
                owner.validate_native_runtime_inventory(record, candidate, changed_identity,
                                                        changed_derivation, changed_inventory, changed_source)

    def test_native_personal_requires_bound_request_log_and_full_cleanup(self):
        fields, request, log = native.personal_fixture(self.pin["sourceRevision"])
        record = {**self.personal, **fields}
        owner.validate_personal(record, self.native_pin, request, log)
        owner.validate_personal(record, {**self.native_pin, "schemaVersion": 5}, request, log)
        for key in fields:
            changed = copy.deepcopy(record)
            del changed[key]
            with self.subTest(missing=key), self.assertRaises((ValueError, KeyError)):
                owner.validate_personal(changed, self.native_pin, request, log)
        for section in ("cleanup", "nativeExecution", "hostDesktopCleanup", "execution"):
            for key in fields[section]:
                changed = copy.deepcopy(record)
                del changed[section][key]
                with self.subTest(section=section, missing=key), self.assertRaises(ValueError):
                    owner.validate_personal(changed, self.native_pin, request, log)
        for changed_request, changed_log in ((None, log), (request, None),
                                              (request + b" ", log), (request, log + b" ")):
            with self.assertRaises(ValueError):
                owner.validate_personal(record, self.native_pin, changed_request, changed_log)

    def test_native_personal_rejects_legacy_policy_identity_and_diagnostic_substitution(self):
        fields, request, log = native.personal_fixture(self.pin["sourceRevision"])
        original = {**self.personal, **fields}
        changes = [
            lambda r: r.update(schemaVersion=True),
            lambda r: r.update(sourceRevision="f" * 40),
            lambda r: r.update(diagnosticOnly=True),
            lambda r: r.update(profileDeletion={"exitCode": 0}),
            lambda r: r.update(desktopJobMask={"removedMask": 64}),
            lambda r: r.update(nativeExecutionError=None),
            lambda r: r.update(selectedTier="appcontainer-dacl"),
            lambda r: r["cleanup"].update(profileDeleted=True),
            lambda r: r["cleanup"].update(nativeTeardownVerified=1),
            lambda r: r["execution"].update(exitCode=False),
            lambda r: r["execution"].update(signal="SIGKILL"),
            lambda r: r["nativeExecution"]["binding"].update(executorPid=43),
            lambda r: r["nativeExecution"]["jobTeardown"].update(activeProcesses=1),
            lambda r: r["nativeExecution"]["uiPolicy"].update(uiRestrictions=0x3bf),
            lambda r: r["nativeExecution"]["uiPolicy"].update(enforcementReadback=True),
            lambda r: r["nativeExecution"].update(uiMarker=None),
            lambda r: r["nativeExecution"]["uiMarker"]["prepared"].update(guestAccess=0x1F0003),
            lambda r: r["nativeExecution"]["uiMarker"]["closed"].update(absentAfterOwnerClose=False),
            lambda r: r["hostDesktopCleanup"].update(rootPid=43),
            lambda r: r["hostDesktopCleanup"]["binding"].update(requestSha256="f" * 64),
        ]
        for index, mutate in enumerate(changes):
            changed = copy.deepcopy(original)
            mutate(changed)
            with self.subTest(case=index), self.assertRaises(ValueError):
                owner.validate_personal(changed, self.native_pin, request, log)

    def test_native_personal_rechecks_raw_host_order_and_types_even_with_updated_hash(self):
        fields, request, log = native.personal_fixture(self.pin["sourceRevision"])
        original = {**self.personal, **fields}
        lines = log.splitlines(keepends=True)
        logs = [b"".join(lines[::-1]), b"".join([lines[0], lines[3], lines[1], lines[2]]),
                log + lines[3], log.replace(b'"activeProcesses": 0', b'"activeProcesses": false'),
                log.replace(b'"uiRestrictions": 1023', b'"uiRestrictions": 959'),
                log.replace(b'"default_policy":"block"', b'"default_policy":"allow"'),
                log.replace(b'"proxy_port":0', b'"proxy_port":1234'),
                log.replace(b'"exit_code":0', b'"exit_code":false'),
                b"".join(line for line in lines if b"NEMOCLAW_NATIVE_UI_OWNER=" not in line),
                b"".join(lines[:-2] + [lines[-1], lines[-2]]),
                log + lines[-1],
                log.replace(b'"absenceStatus": 3221225524', b'"absenceStatus": 3221225506'),
                log + b"NEMOCLAW_HERMES_DESKTOP_MASK={}\n"]
        for index, changed_log in enumerate(logs):
            changed = copy.deepcopy(original)
            changed["nativeExecution"]["logSha256"] = hashlib.sha256(changed_log).hexdigest()
            with self.subTest(case=index), self.assertRaises(ValueError):
                owner.validate_personal(changed, self.native_pin, request, changed_log)
        for mutate in (
            lambda r: r.update(version="0.6.0-alpha"),
            lambda r: r["fallback"].update(allowDaclMutation=True),
            lambda r: r["process"].update(inheritDefaultEnv=True),
            lambda r: r["processContainer"].update(capabilities=["networkLoopback"]),
            lambda r: r["processContainer"].update(ui={"desktopSystemControl": True}),
            lambda r: r["ui"].update(clipboard="all"),
            lambda r: r["ui"].update(injection=True),
            lambda r: r["ui"].update(disable=0),
            lambda r: r["network"]["egress"].update(default="allow"),
            lambda r: r["network"]["egress"].update(allow=[{"to": [{"cidr": "127.0.0.1/32"}]}]),
            lambda r: r["network"]["ingress"].update(hostLoopback="allow"),
            lambda r: r.update(runtimeConfig={"networkProxy": "http://127.0.0.1:1234"}),
            lambda r: r["telemetry"].update(enabled=True),
        ):
            changed = copy.deepcopy(original)
            policy = json.loads(request)
            mutate(policy)
            altered = json.dumps(policy).encode()
            sha = hashlib.sha256(altered).hexdigest()
            changed["requestSha256"] = sha
            changed["nativeExecution"]["binding"]["requestSha256"] = sha
            changed["hostDesktopCleanup"]["binding"]["requestSha256"] = sha
            with self.assertRaises(ValueError):
                owner.validate_personal(changed, self.native_pin, altered, log)

    def test_native_personal_archive_selects_primary_siblings_not_root_or_warm_logs(self):
        _, request, log = native.personal_fixture(self.pin["sourceRevision"])
        for include_primary in (True, False):
            stream = io.BytesIO()
            with zipfile.ZipFile(stream, "w") as archive:
                archive.writestr("personal/personal-feasibility.json", "{}")
                archive.writestr("personal/personal-request.json", request)
                archive.writestr("mxc-native.log", log)
                archive.writestr("personal/browser-ordinary-warm-diagnostic/mxc-native.log", log)
                if include_primary:
                    archive.writestr("personal/mxc-native.log", log)
            with zipfile.ZipFile(io.BytesIO(stream.getvalue())) as archive:
                if include_primary:
                    self.assertEqual(owner.native_personal_documents(archive, "personal/personal-feasibility.json"),
                                     {"personal-request.json": request, "mxc-native.log": log})
                else:
                    with self.assertRaises(ValueError):
                        owner.native_personal_documents(archive, "personal/personal-feasibility.json")

    def test_current_native_proof_rejects_missing_execution_and_cleanup(self):
        for container_id in native.fixture()[0]["nativeExecutions"]:
            for field in ["nativeExecutions", "cleanup"]:
                with self.subTest(container=container_id, field=field):
                    proof, compatibility, mxc = native.fixture()
                    del proof[field][container_id]
                    with self.assertRaises(ValueError):
                        owner.validate_current_compatibility(
                            proof, native.SHA, compatibility, mxc, native.CURRENT
                        )

    def test_current_native_proof_rejects_reuse_and_mismatched_builds(self):
        mutations = [
            lambda p, c, m: p.update(qualificationReuse={"baselinePassed": True}),
            lambda p, c, m: p.update(classification="local-diagnostic"),
            lambda p, c, m: p.update(sourceRevision="f" * 40),
            lambda p, c, m: p.update(normalCleanup=False),
            lambda p, c, m: p.update(passed=False),
            lambda p, c, m: c.update(sourceRevision="f" * 40),
            lambda p, c, m: m.update(candidateRevision="f" * 40),
            lambda p, c, m: m.update(classification="mxc-owned-token-inspection-build"),
            lambda p, c, m: m.update(tokenAccessMode="full-access"),
            lambda p, c, m: p["inputs"].update(mxcSha256="f" * 64),
            lambda p, c, m: p["inputs"].update(compatibility={}),
            lambda p, c, m: p["inputs"].update(mxcBuild={}),
        ]
        for index, mutate in enumerate(mutations):
            with self.subTest(case=index):
                proof, compatibility, mxc = native.fixture()
                mutate(proof, compatibility, mxc)
                with self.assertRaises(ValueError):
                    owner.validate_current_compatibility(
                        proof, native.SHA, compatibility, mxc, native.CURRENT
                    )

    def test_legacy_proof_cannot_admit_a_native_executor(self):
        proof, compatibility, mxc = native.fixture()
        proof["classification"] = "small-msys-appcontainer-compatibility-proof"
        with self.assertRaises(ValueError):
            owner.validate_current_compatibility(
                proof, native.SHA, compatibility, mxc, native.CURRENT
            )
        mxc["classification"] = "mxc-owned-token-inspection-build"
        owner.validate_current_compatibility(
            proof, native.SHA, compatibility, mxc, native.CURRENT
        )

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

    def replay_native_fixture(self, *, native_mode=False):
        _, record, *_ = self.replay_fixture()
        names = [
            "NemoClawMsysLauncher.exe",
            "NemoClawMsysCompat-arm64.dll",
            "NemoClawMsysCompat-x64.dll",
        ]
        build = {
            "classification": "mxc-msys-compatibility-prototype-build",
            "sourceRevision": "b" * 40,
            "status": "built",
            "files": [{"file": n, "bytes": 10, "sha256": "c" * 64} for n in names],
            "license": {"file": "DETOURS-LICENSE.txt", "bytes": 20, "sha256": "d" * 64},
        }
        executor = {"file": "wxc-exec.exe", "bytes": 30, "sha256": "e" * 64}
        mxc = {
            "classification": "mxc-owned-token-inspection-build",
            "candidateRevision": "b" * 40,
            "status": "built",
            "files": [executor],
        }
        proof = {
            "classification": "small-msys-appcontainer-compatibility-proof",
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
        if native_mode:
            legacy_files, license_row = build["files"], build["license"]
            proof, build, mxc = native.fixture()
            build["files"], build["license"] = legacy_files, license_row
            executor = mxc["files"][0]
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
        component = {
            "sourceRevision": build["sourceRevision"],
            "root": native_root,
            "documents": refs,
            "proof": refs["proof"],
            "build": refs["compatibility"],
            "executor": executor,
            "files": [{**r, "path": native_root + "\\" + r["file"]} for r in staged],
        }
        record["runtimeReplay"]["nativeComponent"] = component
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

        return record, data, collect

    def test_replay_native_raw_documents_bind_staged_files_and_executor(self):
        record, data, collect = self.replay_native_fixture()
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

    def test_replay_native_documents_require_strict_current_native_admission(self):
        record, data, collect = self.replay_native_fixture(native_mode=True)
        self.assertEqual(collect(record), data)
        mutations = [
            lambda p: p.update(classification="local-diagnostic"),
            lambda p: p.update(qualificationReuse={"baselinePassed": True}),
            lambda p: p.update(startedExecutors=4),
            lambda p: p.update(hostProcessesNormal=False),
        ]
        for mutate in mutations:
            changed = copy.deepcopy(record)
            archived = dict(data)
            proof = json.loads(archived["current-native-proof.json"])
            mutate(proof)
            raw = json.dumps(proof).encode()
            archived["current-native-proof.json"] = raw
            identity = {"bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}
            component = changed["runtimeReplay"]["nativeComponent"]
            component["documents"]["proof"].update(identity)
            component["proof"].update(identity)
            with self.assertRaises(ValueError):
                collect(changed, archived)

    def test_replay_native_documents_reject_bad_execution_even_with_matching_hashes(self):
        record, data, collect = self.replay_native_fixture(native_mode=True)
        for container_id in native.fixture()[0]["nativeExecutions"]:
            mutations = [
                lambda p: p["nativeExecutions"].pop(container_id),
                lambda p: p["cleanup"].pop(container_id),
                lambda p: p["nativeExecutions"][container_id]["jobTeardown"].update(
                    activeProcesses=1
                ),
                lambda p: p["cleanup"][container_id]["executor"].pop("error"),
            ]
            for index, mutate in enumerate(mutations):
                with self.subTest(container=container_id, case=index):
                    changed = copy.deepcopy(record)
                    archived = dict(data)
                    proof = json.loads(archived["current-native-proof.json"])
                    mutate(proof)
                    raw = json.dumps(proof).encode()
                    archived["current-native-proof.json"] = raw
                    identity = {
                        "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()
                    }
                    component = changed["runtimeReplay"]["nativeComponent"]
                    component["documents"]["proof"].update(identity)
                    component["proof"].update(identity)
                    with self.assertRaisesRegex(ValueError, "Hermes native"):
                        collect(changed, archived)


if __name__ == "__main__":
    unittest.main()
