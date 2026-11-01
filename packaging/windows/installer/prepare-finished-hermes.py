# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Admit a pinned or same-run Personal-passing candidate for CI installer assembly."""

import argparse
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import stat
import urllib.request
import zipfile

REPLAY_BASE = {
    "artifactId": 10293082661,
    "runId": 34679482914,
    "sourceRevision": "8d78fe458e9268a7afdc8ed06b85c23306452036",
    "bytes": 1073328197,
    "sha256": "753aa3e7addcc1c274b4a59b6785706715ccba661eaa31bfe77a95e20271bda1",
    "candidateReceiptSha256": "c682b3cd2f9691ad7d65312682522b59a5a5105c19688621153261d92c4f1c4f",
    "inventorySha256": "f4df172630b7f5ae6ec9cc9cf9c54b4744c2b0046cb15859f9469ff9bfe7a0e2",
    "startupAdapterSha256": "58a55abda6045e4919da5e56042d21768e72bab3be1e7444a4f65eb850941f65",
    "runtimeRoot": r"C:\NemoClawHermesProbe-274d797050ea",
}


def require(value, message):
    if not value:
        raise ValueError(message)


def digest(file):
    with file.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def exact_archive_bytes(archive, name, maximum):
    matches = [entry for entry in archive.infolist() if entry.filename == name]
    require(
        len(matches) == 1
        and not matches[0].is_dir()
        and 0 < matches[0].file_size <= maximum,
        "Missing, duplicate or oversized root metadata: " + name,
    )
    data = archive.read(matches[0])
    return data


def exact_root_document(archive, name, maximum):
    data = exact_archive_bytes(archive, name, maximum)
    return data, json.loads(data)


def native_personal_documents(archive, personal_member):
    member = PurePosixPath(personal_member)
    require(member.name == "personal-feasibility.json" and not member.is_absolute()
            and ".." not in member.parts and "\\" not in personal_member,
            "Invalid Personal receipt archive member")
    # Bind to the primary receipt's directory, never a same-named warm replay log.
    return {
        name: exact_archive_bytes(archive, (member.parent / name).as_posix(), maximum)
        for name, maximum in (("personal-request.json", 1024 * 1024),
                              ("mxc-native.log", 4 * 1024 * 1024))
    }


def source_run(pin, kind):
    if pin["schemaVersion"] in (1, 4, 5):
        return pin["sourceRevision"], pin["runId"]
    return pin[kind + "SourceRevision"], pin[kind + "RunId"]


def validate_pin(pin):
    require(
        type(pin.get("schemaVersion")) is int
        and pin["schemaVersion"] in (1, 2, 3, 4)
        and pin.get("classification") == "personal-passing-hermes-installer-input"
        and pin.get("status")
        == ("edge-broker-prepared" if pin.get("schemaVersion") == 3 else "personal-passed"),
        "Exact unpublished Personal-passing inputs must be supplied before building Hermes",
    )
    for kind in ["candidate", "personal"]:
        source, run = source_run(pin, kind)
        require(
            isinstance(source, str)
            and re.fullmatch(r"[a-f0-9]{40}", source)
            and type(run) is int
            and run > 0,
            "Invalid " + kind + " source/run",
        )
    for key, cap in [
        ("candidateArtifact", 2_000_000_000),
        ("personalEvidenceArtifact", 200_000_000),
    ]:
        row = pin[key]
        require(
            type(row.get("id")) is int
            and row["id"] > 0
            and type(row.get("bytes")) is int
            and 0 < row["bytes"] <= cap
            and re.fullmatch(r"[a-f0-9]{64}", row.get("sha256", "")),
            "Invalid bounded artifact pin: " + key,
        )
    for key in ["candidateReceiptSha256", "personalReceiptSha256"]:
        require(
            isinstance(pin.get(key), str) and re.fullmatch(r"[a-f0-9]{64}", pin[key]),
            "Missing exact receipt pin: " + key,
        )
    if pin["schemaVersion"] == 2:
        require(
            pin.get("evidenceMode") == "immutable-replay"
            and source_run(pin, "candidate")
            == (REPLAY_BASE["sourceRevision"], REPLAY_BASE["runId"])
            and pin["candidateArtifact"]
            == {
                "id": REPLAY_BASE["artifactId"],
                "bytes": REPLAY_BASE["bytes"],
                "sha256": REPLAY_BASE["sha256"],
            }
            and pin["candidateReceiptSha256"] == REPLAY_BASE["candidateReceiptSha256"],
            "Replay intake is limited to the exact reviewed complete 8d78 base",
        )
    if pin["schemaVersion"] == 3:
        require(
            pin.get("evidenceMode") == "immutable-replay-with-host-edge"
            and pin.get("browserMode") == "host-native-edge-cdp"
            and source_run(pin, "candidate")
            == (REPLAY_BASE["sourceRevision"], REPLAY_BASE["runId"])
            and pin["candidateArtifact"]
            == {
                "id": REPLAY_BASE["artifactId"],
                "bytes": REPLAY_BASE["bytes"],
                "sha256": REPLAY_BASE["sha256"],
            }
            and pin["candidateReceiptSha256"] == REPLAY_BASE["candidateReceiptSha256"]
            and isinstance(pin.get("edgeSourceRevision"), str)
            and re.fullmatch(r"[a-f0-9]{40}", pin["edgeSourceRevision"])
            and type(pin.get("edgeRunId")) is int
            and pin["edgeRunId"] > 0
            and isinstance(pin.get("edgeReceiptSha256"), str)
            and re.fullmatch(r"[a-f0-9]{64}", pin["edgeReceiptSha256"]),
            "Host Edge replay intake differs from its immutable evidence",
        )
        edge = pin.get("edgeEvidenceArtifact", {})
        require(
            type(edge.get("id")) is int
            and edge["id"] > 0
            and type(edge.get("bytes")) is int
            and 0 < edge["bytes"] <= 1024 * 1024
            and re.fullmatch(r"[a-f0-9]{64}", edge.get("sha256", "")),
            "Invalid bounded Edge prerequisite artifact pin",
        )
    if pin["schemaVersion"] == 4:
        require(pin.get("evidenceMode") == "same-source-native-personal"
                and not any(key in pin for key in (
                    "candidateSourceRevision", "personalSourceRevision", "candidateRunId",
                    "personalRunId", "browserMode", "edgeEvidenceArtifact",
                )), "Native input pin cannot substitute historical replay or host Edge evidence")
    return pin


def validate_personal(record, pin, request_raw=None, log_raw=None):
    edge_mode = pin["schemaVersion"] == 3
    native_personal = type(record.get("schemaVersion")) is int and record["schemaVersion"] == 2
    require(native_personal == (pin["schemaVersion"] in (4, 5)),
            "Personal backend differs from its explicit input pin schema")
    if native_personal:
        require(not edge_mode, "Native Personal requires its own passing browser evidence")
        spec = importlib.util.spec_from_file_location(
            "finished_native_personal",
            Path(__file__).parents[1] / "mxc-bash/native-compatibility-proof.py",
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.validate_native_personal(record, source_run(pin, "personal")[0], request_raw, log_raw)
    require(
        (native_personal or type(record.get("schemaVersion")) is int and record["schemaVersion"] == 1)
        and record.get("classification") == "canonical-personal-mxc-feasibility"
        and record.get("sourceRevision") == source_run(pin, "personal")[0]
        and record.get("feasibilityPassed") is (not edge_mode),
        "The exact candidate did not pass Personal",
    )
    require(
        record.get("installedAcceptance") is False
        and record.get("fullAgentQualified") is False
        and record.get("cleanupErrors") == [],
        "Unexpected Personal qualification/cleanup",
    )
    require(
        all(
            record.get("cleanup", {}).get(k) is True
            for k in [
                "executorClosed",
                "hostDiagnosticChildrenClosed",
                "nativeTeardownVerified" if native_personal else "profileDeleted",
                "ownedRootsRemoved",
            ]
        ),
        "Personal cleanup did not complete",
    )
    workload = record["workload"]
    components = workload["components"]
    require(
        workload.get("passed") is (not edge_mode)
        and len(components) == 4
        and {r["component"] for r in components}
        == {"python", "bash", "conpty", "browser"},
        "Incomplete canonical Personal component set",
    )
    require(
        all(
            r.get("passed") is True
            and r["execution"].get("exitCode") == 0
            and r["execution"].get("childClosed") is True
            and r["execution"].get("timedOut") is False
            and r["execution"].get("outputExceeded") is False
            for r in components
            if not edge_mode or r["component"] != "browser"
        ),
        "A canonical Personal component failed",
    )
    if edge_mode:
        browser = next(r for r in components if r["component"] == "browser")
        require(
            browser.get("passed") is False
            and browser["execution"].get("childClosed") is True
            and browser["execution"].get("timedOut") is False
            and browser["execution"].get("outputExceeded") is False,
            "Abandoned bundled Chrome evidence differs",
        )
    require(
        record["derivedRuntime"]["candidate"]["sha256"]
        == pin["candidateReceiptSha256"],
        "Personal tested another candidate",
    )
    require(
        (
            isinstance(record.get("runtimeReplay"), dict)
            if pin["schemaVersion"] in (2, 3)
            else record.get("runtimeReplay") is None
        ),
        "Personal evidence route differs from its explicit pin schema",
    )


def validate_native_runtime_inventory(record, candidate, candidate_identity, derivation, inventory, source):
    """Bind both Personal byte comparisons to the candidate admitted for assembly."""
    identity = record.get("derivedRuntime", {}).get("candidate", {})
    candidate_bytes, candidate_sha = candidate_identity
    require(
        type(identity.get("bytes")) is int
        and identity["bytes"] == candidate_bytes
        and identity.get("sha256") == candidate_sha
        and identity.get("value") == candidate,
        "Native Personal candidate differs from the admitted archive",
    )
    runtime = record.get("runtime")
    require(
        isinstance(runtime, str)
        and re.fullmatch(r"C:\\NemoClawHermesProbe-[a-f0-9]{12}", runtime)
        and derivation.get("runtimeRootAtExport") == runtime
        and record.get("sourceRevision") == source
        and record.get("candidateSource") == source
        and candidate.get("controllerSource") == source,
        "Native Personal source/runtime binding differs",
    )
    comparison = record.get("runtimeInventory")
    require(
        isinstance(comparison, dict)
        and type(comparison.get("schemaVersion")) is int
        and comparison["schemaVersion"] == 1
        and comparison.get("classification") == "current-canonical-Personal-runtime-inventory"
        and comparison.get("sourceRevision") == source
        and comparison.get("runtimeRoot") == runtime
        and comparison.get("candidateReceiptSha256") == candidate_sha,
        "Native Personal full inventory identity is missing or mismatched",
    )
    require(all(type(row.get("bytes")) is int and row["bytes"] >= 0
                and "linkTarget" not in row for row in inventory["files"]),
            "Native Personal inventory requires regular files with byte counts")
    counts = {"files": len(inventory["files"]), "directories": len(inventory["directories"]),
              "logicalBytes": sum(row["bytes"] for row in inventory["files"])}
    require(type(candidate.get("fileCount")) is int and candidate["fileCount"] == counts["files"]
            and type(candidate.get("logicalBytes")) is int
            and candidate["logicalBytes"] == counts["logicalBytes"],
            "Native candidate counts differ from its hashed inventory")
    for phase in ("before", "after"):
        observed = comparison.get(phase)
        require(
            isinstance(observed, dict)
            and observed.get("allFilesAndDirectoriesVerified") is True
            and observed.get("inventorySha256") == candidate["inventorySha256"]
            and all(type(observed.get(key)) is int and observed[key] == value
                    for key, value in counts.items()),
            "Native Personal full inventory comparison is missing or mismatched: " + phase,
        )


def validate_replay(record, pin, candidate, candidate_raw, derivation):
    """Bind the completed runtime and current controller without changing base bytes."""
    identity = record["derivedRuntime"]["candidate"]
    require(
        identity.get("bytes") == len(candidate_raw)
        and identity.get("sha256") == hashlib.sha256(candidate_raw).hexdigest()
        and identity.get("value") == candidate,
        "Personal candidate value/bytes/hash differ from the immutable artifact",
    )
    replay = record["runtimeReplay"]
    require(
        replay.get("schemaVersion") == 1
        and replay.get("classification") == "immutable-canonical-hermes-personal-replay"
        and replay.get("base") == REPLAY_BASE
        and replay.get("controllerSource") == source_run(pin, "personal")[0]
        and record.get("candidateSource") == REPLAY_BASE["sourceRevision"]
        and candidate.get("controllerSource") == REPLAY_BASE["sourceRevision"]
        and candidate.get("inventorySha256") == REPLAY_BASE["inventorySha256"]
        and candidate.get("startupAdapterSha256") == REPLAY_BASE["startupAdapterSha256"]
        and record.get("runtime") == REPLAY_BASE["runtimeRoot"]
        and replay.get("runtimeRoot") == REPLAY_BASE["runtimeRoot"]
        and derivation.get("runtimeRootAtExport") == REPLAY_BASE["runtimeRoot"],
        "Replay base/controller/root binding differs",
    )
    require(
        all(
            replay.get(key) is True
            for key in [
                "completeZipVerified",
                "completeNestedArchiveVerified",
                "sourceBuildProvenanceVerified",
                "nativeComponentUnchanged",
            ]
        )
        and all(
            replay.get(key) is False
            for key in [
                "runtimeRebuilt",
                "runtimeRelocated",
                "runtimeExported",
                "runtimeExecutionQualified",
                "installedAcceptance",
            ]
        ),
        "Replay changed the complete runtime or claimed qualification",
    )
    for phase in ["before", "after"]:
        observed = replay.get(phase, {})
        require(
            observed.get("allFilesAndDirectoriesVerified") is True
            and observed.get("inventorySha256") == REPLAY_BASE["inventorySha256"]
            and observed.get("files") == candidate["fileCount"]
            and observed.get("logicalBytes") == candidate["logicalBytes"],
            "Replay full inventory comparison is missing or mismatched: " + phase,
        )
    validate_public_runtime_access(record)


def validate_public_runtime_access(record):
    preparation = record["runtimeReplay"].get("publicRuntimeAccess", {})
    require(
        preparation.get("classification") == "fresh-public-runtime-rx-preparation"
        and preparation.get("sourceRevision") == record["sourceRevision"]
        and preparation.get("runtimeRoot") == record["runtime"]
        and preparation.get("status") == "prepared"
        and preparation.get("emptyBeforeExtraction") is True
        and preparation.get("exactDeltaVerified") is True
        and preparation.get("handleClosed") is True
        and preparation.get("setSecurityStatus") == 0
        and preparation.get("error") is None
        and preparation.get("cleanupErrors") == []
        and isinstance(preparation.get("before"), dict)
        and isinstance(preparation.get("after"), dict)
        and all(
            preparation[phase].get("descriptorHex") for phase in ["before", "after"]
        )
        and not preparation.get("receiptWriteError")
        and preparation.get("addedAce")
        == {
            "sid": "S-1-15-2-1",
            "mask": 0x1200A9,
            "flags": 3,
            "hex": "00031800a9001200010200000000000f0200000001000000",
        }
        and re.fullmatch("[a-f0-9]{64}", preparation.get("sourceSha256", "")),
        "Passing replay lacks the exact public runtime RX preparation",
    )
    python = next(
        row for row in record["workload"]["components"] if row["component"] == "python"
    )
    proof = python.get("result", {}).get("runtimeAccess", {})
    read, write = (
        proof.get("operations", {}).get(key, {}) for key in ["read", "write"]
    )
    relative = "tools/browser-use/Lib/site-packages/browser_use/cli.py"
    require(
        proof.get("passed") is True
        and proof.get("relativePath") == relative
        and PureWindowsPath(proof.get("path", ""))
        == PureWindowsPath(record["runtime"]) / relative
        and proof.get("creationDisposition") == 3
        and proof.get("shareMode") == 7
        and proof.get("fileFlags") == 0x200000
        and proof.get("contentWriteAttempted") is False
        and read.get("accessMask") == 0x80000000
        and read.get("openSucceeded") is True
        and read.get("readSucceeded") is True
        and read.get("bytesRead") == 64
        and read.get("handleClosed") is True
        and read.get("closeError") == 0
        and re.fullmatch("[a-f0-9]{64}", read.get("prefixSha256", ""))
        and write.get("accessMask") == 2
        and write.get("openSucceeded") is False
        and write.get("invalidHandleReturned") is True
        and write.get("openError") == 5,
        "Passing replay lacks contained read and exact write-open denial",
    )
    return {"preparation": preparation, "contained": proof}


def replay_native_documents(archive, owner, record):
    """Retain exact replay-native receipts beside the supplied Personal proof."""
    native = record["runtimeReplay"]["nativeComponent"]
    require(
        isinstance(native.get("sourceRevision"), str)
        and re.fullmatch(r"[a-f0-9]{40}", native["sourceRevision"]),
        "Replay native source is missing",
    )
    references = native["documents"]
    require(
        set(references) == {"proof", "compatibility", "mxc"},
        "Unexpected replay native documents",
    )
    documents, parsed = {}, {}
    for key, name in [
        ("proof", "current-native-proof.json"),
        ("compatibility", "current-msys-build.json"),
        ("mxc", "current-mxc-build.json"),
    ]:
        row = references[key]
        _, data, value = owner.document(archive, name, 16 * 1024 * 1024)
        require(
            row.get("file") == name
            and row.get("bytes") == len(data)
            and row.get("sha256") == hashlib.sha256(data).hexdigest(),
            "Replay native document hash/size/name changed: " + key,
        )
        documents[name], parsed[key] = data, value
    _, request_raw, _ = owner.document(archive, "personal-request.json", 1024 * 1024)
    require(
        hashlib.sha256(request_raw).hexdigest() == record.get("requestSha256"),
        "The executed Personal request differs from its receipt",
    )
    documents["personal-request.json"] = request_raw
    proof, build, mxc = (parsed[key] for key in ["proof", "compatibility", "mxc"])
    require(
        proof.get("passed") is True
        and proof.get("normalCleanup") is True
        and proof.get("phase") == "two-container-isolation"
        and proof.get("sourceRevision") == native["sourceRevision"]
        and build.get("sourceRevision") == native["sourceRevision"]
        and mxc.get("candidateRevision") == native["sourceRevision"]
        and build.get("status") == "built"
        and mxc.get("status") == "built"
        and proof.get("inputs", {}).get("compatibility") == build
        and proof.get("inputs", {}).get("mxcBuild") == mxc,
        "Replay native proof/build lineage differs",
    )
    validate_current_compatibility(
        proof, references["proof"]["sha256"], build, mxc, native["sourceRevision"]
    )
    for field, key in [("proof", "proof"), ("build", "compatibility")]:
        require(
            all(
                native[field].get(k) == references[key][k] for k in ["bytes", "sha256"]
            ),
            "Replay native document identity differs: " + field,
        )
    executors = [row for row in mxc["files"] if row.get("file") == "wxc-exec.exe"]
    require(len(executors) == 1, "Replay executor inventory is ambiguous")
    require(
        all(native["executor"].get(k) == executors[0][k] for k in ["bytes", "sha256"])
        and proof["inputs"].get("mxcSha256") == executors[0]["sha256"],
        "Replay executed another native executor",
    )
    expected = build["files"] + [
        build["license"],
        {
            "file": "build-receipt.json",
            "bytes": references["compatibility"]["bytes"],
            "sha256": references["compatibility"]["sha256"],
        },
    ]
    require(
        len(expected) == 5
        and {row["file"] for row in expected}
        == {
            "NemoClawMsysLauncher.exe",
            "NemoClawMsysCompat-arm64.dll",
            "NemoClawMsysCompat-x64.dll",
            "DETOURS-LICENSE.txt",
            "build-receipt.json",
        }
        and len(native["files"]) == len(expected),
        "Replay native file set changed",
    )
    native_root = native.get("root", "")
    require(
        re.fullmatch(r"C:\\NemoClawPersonalCompat-[a-f0-9]{12}", native_root),
        "Replay native staging root differs",
    )
    for expected_row in expected:
        rows = [
            row for row in native["files"] if row.get("file") == expected_row["file"]
        ]
        require(
            len(rows) == 1
            and all(rows[0].get(k) == expected_row[k] for k in ["bytes", "sha256"])
            and PureWindowsPath(rows[0]["path"])
            == PureWindowsPath(native_root) / expected_row["file"],
            "Replay native staged file identity differs",
        )
    return documents


def validate_run(run, source, run_id, *, passing, native_mode=False):
    require(
        run.get("id") == run_id
        and run.get("head_sha") == source
        and run.get("status") == "completed"
        and (not passing or run.get("conclusion") == "success")
        and run.get("path") == (
            ".github/workflows/windows-native-installer-v2.yaml" if native_mode
            else ".github/workflows/windows-native-installer.yaml"
        ),
        "Pinned workflow identity or result differs",
    )


def validate_current_compatibility(proof, proof_sha, compatibility, mxc, source):
    """Admit native evidence without treating legacy reuse as a native execution."""
    require(
        proof.get("sourceRevision") == source
        and proof.get("passed") is True
        and proof.get("normalCleanup") is True
        and compatibility.get("sourceRevision") == source
        and compatibility.get("status") == "built"
        and mxc.get("candidateRevision") == source
        and mxc.get("status") == "built",
        "Current-source compatibility proof did not pass",
    )
    if proof.get("classification") == "small-msys-appcontainer-compatibility-proof":
        require(
            mxc.get("classification") == "mxc-owned-token-inspection-build",
            "Legacy compatibility proof cannot admit a native executor",
        )
        return
    require(
        proof.get("classification")
        == "small-msys-native-basecontainer-compatibility-proof"
        and proof.get("qualificationReuse") is None,
        "Native compatibility requires fresh native evidence, not legacy reuse",
    )
    spec = importlib.util.spec_from_file_location(
        "finished_hermes_exporter",
        Path(__file__).parents[1] / "hermes/export-official-runtime.py",
    )
    exporter = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(exporter)
    exporter.validate_compatibility_proof(
        proof, proof_sha, compatibility, mxc, source
    )


def validate_personal_composition(personal, proof, compatibility, mxc, source):
    """Keep native and historical Personal evidence on separate composition paths."""
    native_personal = type(personal.get("schemaVersion")) is int and personal["schemaVersion"] == 2
    if proof.get("classification") != "small-msys-native-basecontainer-compatibility-proof":
        require(not native_personal, "Native Personal cannot use legacy compatibility proof")
        return
    require(native_personal and personal.get("sourceRevision") == source,
            "Native composition requires same-source native Personal execution")
    spec = importlib.util.spec_from_file_location(
        "finished_native_personal_inputs",
        Path(__file__).parents[1] / "mxc-bash/native-compatibility-proof.py",
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.validate_native_personal_inputs(personal, compatibility, mxc, source)


def read_same_run_file(file, maximum):
    info = file.lstat()
    require(stat.S_ISREG(info.st_mode) and not file.is_symlink()
            and not (getattr(info, "st_file_attributes", 0) & 0x400)
            and info.st_nlink == 1 and 0 < info.st_size <= maximum,
            "Same-run producer input is not bounded and ordinary: " + file.name)
    return file.read_bytes()


def validate_same_run_state_owner(root, personal, request, source, run_id, run_attempt):
    """Bind disposable native state custody to the actual helper and host account."""
    raw = read_same_run_file(root / "state-owner-build.json", 1024 * 1024)
    build = json.loads(raw)
    require(isinstance(build, dict), "Same-run native state helper build is not an object")
    for document, paths in (
        (personal, ((), ("nativeStateBuild",), ("nativeStateBuild", "executable"),
                    ("nativeStateBuild", "receipt"), ("cleanup",), ("workload",),
                    ("hostDesktopCleanup", "postExecutorObservation", "request"),
                    ("hostDesktopCleanup", "postExecutorObservation", "receipt", "value", "context"))),
        (request, ((), ("process",), ("filesystem",))),
    ):
        for keys in paths:
            value = document
            for key in keys:
                require(isinstance(value, dict), "Native state evidence is not an object")
                value = value.get(key)
            require(isinstance(value, dict), "Native state evidence is not an object")
    expected = {
        "schemaVersion": 1, "classification": "personal-native-state-owner-build",
        "sourceRevision": source, "workflowRunId": run_id, "workflowRunAttempt": run_attempt,
        "target": "aarch64-pc-windows-msvc", "immutableRuntime": False, "buildProcessesClosed": True,
    }
    require(all(type(build.get(key)) is type(value) and build[key] == value
                for key, value in expected.items()), "Same-run native state helper build differs")
    launcher = root / "official-hermes-runtime-build/state-owner-helper/NemoClaw.exe"
    executable = read_same_run_file(launcher, 32 * 1024 * 1024)
    offset = int.from_bytes(executable[60:64], "little")
    require(len(executable) >= 70 and executable[:2] == b"MZ" and 64 <= offset <= len(executable) - 6
            and executable[offset:offset + 4] == b"PE\0\0"
            and int.from_bytes(executable[offset + 4:offset + 6], "little") == 0xAA64,
            "Same-run native state helper is not ARM64")
    identity = {"path": str(launcher), "bytes": len(executable),
                "sha256": hashlib.sha256(executable).hexdigest(), "peMachine": 0xAA64, "architecture": "arm64"}
    require(build.get("file") == str(launcher) and type(build.get("bytes")) is int
            and build["bytes"] == identity["bytes"] and build.get("sha256") == identity["sha256"],
            "Same-run native state helper bytes differ")
    launcher_source = Path(__file__).parents[1] / "launcher"
    source_paths = [launcher_source / "Cargo.toml", launcher_source / "Cargo.lock",
                    *sorted((launcher_source / "src").rglob("*.rs"))]
    sources = []
    for file in source_paths:
        content = read_same_run_file(file, 2 * 1024 * 1024)
        sources.append({"file": file.relative_to(launcher_source).as_posix(), "bytes": len(content),
                        "sha256": hashlib.sha256(content).hexdigest()})
    actual_sources = build.get("sources")
    require(isinstance(actual_sources, list)
            and all(isinstance(row, dict) and isinstance(row.get("file"), str)
                    and type(row.get("bytes")) is int for row in actual_sources)
            and sorted(actual_sources, key=lambda row: row["file"]) == sorted(sources, key=lambda row: row["file"]),
            "Same-run native state helper source set differs")
    observed = personal.get("nativeStateBuild", {})
    receipt = {"path": str(root / "state-owner-build.json"), "bytes": len(raw),
               "sha256": hashlib.sha256(raw).hexdigest(), "peMachine": None, "architecture": "non-PE-or-unknown"}
    require(observed == {"launcher": str(launcher), "executable": identity, "receipt": receipt, "sources": actual_sources}
            and type(observed.get("executable", {}).get("bytes")) is int
            and type(observed.get("executable", {}).get("peMachine")) is int
            and type(observed.get("receipt", {}).get("bytes")) is int
            and all(type(row.get("bytes")) is int for row in observed["sources"]),
            "Personal execution did not bind this native state helper")
    state = personal.get("nativeState", {})
    expected_state = {
        "schemaVersion": 1, "classification": "personal-native-state-owner",
        "inspectionClosed": True, "sessionAttempted": True, "created": True,
        "sessionReleased": True, "removalAttempted": True, "removed": True,
        "removalReleased": True, "ownerUnreferenced": False, "retained": False, "complete": True,
    }
    require(isinstance(state, dict) and set(state) == {*expected_state, "stateRoot"}
            and all(type(state.get(key)) is type(value) and state[key] == value
                    for key, value in expected_state.items())
            and personal.get("cleanup", {}).get("nativeStateComplete") is True,
            "Personal native state creation, custody or cleanup is incomplete")
    desktop = personal.get("hostDesktopCleanup", {}).get("postExecutorObservation", {})
    sid = desktop.get("request", {}).get("hostUserSid")
    context = desktop.get("receipt", {}).get("value", {}).get("context", {})
    require(isinstance(sid, str) and len(sid) <= 184 and re.fullmatch(r"S-1-(?:[0-9]+-)*[0-9]+", sid)
            and context.get("hostUserSid") == sid,
            "Personal native state lacks its observed host account identity")
    runtime = personal.get("runtime", "")
    require(isinstance(runtime, str) and re.fullmatch(r"[A-Z]:\\NemoClawHermesProbe-[a-f0-9]{12}", runtime),
            "Personal native state runtime identity differs")
    state_root = runtime[:3] + "NemoClawState-" + sid + "-hermes"
    nonce = personal.get("workload", {}).get("nonce", "")
    require(isinstance(nonce, str) and re.fullmatch(r"[a-f0-9]{24}", nonce), "Personal state nonce is invalid")
    process = request.get("process", {})
    environment = process.get("env", [])
    require(isinstance(environment, list) and all(isinstance(entry, str) and "=" in entry for entry in environment),
            "Personal native state environment is invalid")
    pairs = [entry.split("=", 1) for entry in environment]
    require(len({key.casefold() for key, _ in pairs}) == len(pairs), "Personal environment has duplicate authorities")
    environment = dict(pairs)
    expected_environment = {key: state_root + "\\home" for key in
                            ("HERMES_HOME", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA")}
    expected_environment.update(NEMOCLAW_AGENT_HOME=state_root, TEMP=state_root + "\\temp", TMP=state_root + "\\temp",
                                NEMOCLAW_MSYS_TOKEN_INSPECTION_HOLD="hermes-query")
    require(state["stateRoot"] == state_root and process.get("cwd") == state_root
            and request.get("containerId") == "nm-" + nonce[:12] + "-start"
            and request.get("filesystem", {}).get("readwritePaths") == [state_root]
            and not {key.casefold() for key in environment}.intersection(
                {"nemoclaw_msys_token_inspection", "nemoclaw_hermes_private_desktop"})
            and all(environment.get(key) == value for key, value in expected_environment.items()),
            "Personal state authority or writable grants differ from its native owner")
    return raw


def validate_same_run_browser(personal, request):
    browser = personal.get("nativeBrowser", {})
    workload = personal.get("workload", {})
    nonce = workload.get("nonce", "")
    require(isinstance(browser, dict) and isinstance(nonce, str) and re.fullmatch(r"[a-f0-9]{24}", nonce),
            "Native browser identity is missing")
    require(type(browser.get("schemaVersion")) is int and browser["schemaVersion"] == 1
            and browser.get("classification") == "personal-native-edge-browser"
            and browser.get("nonce") == nonce and browser.get("runtime") == personal.get("runtime")
            and browser.get("transport") == "guarded-file-native-pipe" and browser.get("generalHostProxy") is False
            and browser.get("inheritedKillOnCloseJob") is True and browser.get("cleanupErrors") == []
            and all(browser.get(key) is True for key in
                    ("closed", "relayClosed", "edgeClosed", "relayOwnerClosed"))
            and personal.get("cleanup", {}).get("nativeBrowserComplete") is True,
            "Native browser transport or cleanup did not complete")
    launcher = personal["nativeStateBuild"]["executable"]
    require(browser.get("identityLauncher") == {key: launcher[key] for key in ("path", "bytes", "sha256")},
            "Native browser used another identity helper")
    identity = browser.get("identity", {})
    require(isinstance(identity, dict) and identity.get("classification") == "native-arm64-microsoft-edge"
            and identity.get("architecture") == "arm64" and type(identity.get("machine")) is int
            and identity["machine"] == 0xAA64 and identity.get("productName") == "Microsoft Edge"
            and identity.get("signatureStatus") == "Valid"
            and identity.get("provenance") == "standard-windows-microsoft-edge-installation"
            and isinstance(identity.get("sha256"), str) and re.fullmatch(r"[a-f0-9]{64}", identity["sha256"])
            and type(identity.get("bytes")) is int and identity["bytes"] > 0,
            "Native browser lacks its exact signed ARM64 identity")
    endpoint = browser.get("endpoint", {})
    require(isinstance(endpoint, dict) and type(endpoint.get("port")) is int and 0 < endpoint["port"] <= 65535
            and isinstance(endpoint.get("path"), str)
            and re.fullmatch(r"/devtools/browser/[A-Za-z0-9-]{1,128}", endpoint["path"]),
            "Native browser endpoint identity is invalid")
    environment = dict(entry.split("=", 1) for entry in request["process"]["env"])
    state = personal["nativeState"]["stateRoot"]
    controller = personal["runtime"][:3] + "NemoClawPersonalNode-" + nonce[:12]
    expected = {
        "NEMOCLAW_PERSONAL_BROWSER_SESSION": nonce, "NEMOCLAW_AGENT_SESSION_ID": nonce[:10],
        "NEMOCLAW_WORKER_ROOT": controller + "\\workers",
        "NEMOCLAW_BROWSER_RELAY_ROOT": state + "\\browser-relay-" + nonce,
        "NEMOCLAW_HERMES_BROWSER_PIPE_PORT": "8124", "NEMOCLAW_BROWSER_CDP_PATH": endpoint["path"],
        "BROWSER_CDP_URL": "ws://127.0.0.1:8124" + endpoint["path"],
        "BU_CDP_WS": "ws://127.0.0.1:8124" + endpoint["path"],
    }
    require(all(environment.get(key) == value for key, value in expected.items())
            and not environment.get("NEMOCLAW_AGENT_RUNTIME") and not environment.get("BU_CDP_URL")
            and browser.get("relayRoot") == expected["NEMOCLAW_BROWSER_RELAY_ROOT"],
            "Native browser did not use its declared contained transport")
    transport = workload.get("browserTransport", {})
    require(isinstance(transport, dict) and all(transport.get(key) is True for key in ("attempted", "started", "closed")),
            "Native browser pipe was not exercised")
    components = [row for row in workload.get("components", []) if row.get("component") == "browser"]
    require(len(components) == 1 and components[0].get("passed") is True, "Native browser component did not pass")
    details = components[0].get("result", {}).get("details", {})
    shutdown = details.get("browserHarnessShutdown", {})
    observation = details.get("pageObservation", {})
    page = '<!doctype html><title>Hermes Personal proof</title><p id="sentinel">' + nonce + '</p>'
    expected_page = "data:text/html;base64," + base64.b64encode(page.encode("ascii")).decode("ascii")
    require(details.get("nativeEdgeTransport") is True and details.get("pageServerOwner") is None
            and details.get("pageKind") == "inline-html" and browser.get("pageKind") == "inline-html"
            and details.get("canonicalBrowserCleanupCalled") is True
            and shutdown.get("complete") is True and shutdown.get("processExitObserved") is True
            and shutdown.get("identityReconfirmed") is True and shutdown.get("handleClosed") is True
            and shutdown.get("transport") == "native-hermes-browser-pipe"
            and observation.get("visible") is True and observation.get("actual", {}).get("sentinel") == nonce
            and observation.get("actual", {}).get("url") == browser.get("pageUrl")
            and browser.get("pageUrl") == environment.get("NEMOCLAW_PERSONAL_BROWSER_PAGE")
            and browser.get("pageUrl") == expected_page,
            "Native browser page or authenticated daemon shutdown is incomplete")


def validate_same_run_host_owner(root, phase, personal, personal_raw, source, run_id, run_attempt):
    source_root = Path(__file__).parents[1] / "hermes"
    spec = importlib.util.spec_from_file_location("personal_native_host_admission", source_root / "personal-native-host.py")
    host = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(host)
    raw = read_same_run_file(root / "personal-host-owner.json", 1024 * 1024)
    record = json.loads(raw)
    require(phase.get("hostProcessOwnerAttempted") is True and phase.get("hostProcessOwnerClosed") is True
            and phase.get("hostProcessOwner") == {"file": "personal-host-owner.json", "bytes": len(raw),
                "sha256": hashlib.sha256(raw).hexdigest(), "childrenClosed": True}
            and type(phase["hostProcessOwner"].get("bytes")) is int
            and phase["hostProcessOwner"].get("childrenClosed") is True
            and host.host_closed(record, source, phase["runtimeRoot"], run_id, run_attempt),
            "Same-run Personal host owner identity or closure differs")
    require(record.get("operationSucceeded") is True and record.get("diagnosticOnly") is False
            and record.get("canonicalQualification") is False and record.get("installedAcceptance") is False
            and record.get("processCreated") is True and record.get("primaryError") is None,
            "Same-run Personal host process did not complete normally")
    execution, job = record.get("execution", {}), record.get("job", {})
    require(isinstance(execution, dict) and isinstance(job, dict)
            and execution.get("resumed") is True and type(execution.get("exitCode")) is int
            and execution["exitCode"] == 0 and execution.get("timedOut") is False
            and execution.get("outputExceeded") is False and execution.get("error") is None
            and all(job.get(key) is True for key in ("created", "assignedBeforeResume", "rootMembershipVerified"))
            and type(job.get("limitFlags")) is int and job["limitFlags"] == 8192
            and job.get("forcedTermination") is False,
            "Same-run Personal host execution or job custody is incomplete")
    nonce = record.get("nonce")
    require(isinstance(nonce, str) and re.fullmatch(r"[a-f0-9]{24}", nonce)
            and record.get("stateRoot") == phase["runtimeRoot"][:3] + "NemoClawPersonalHost-" + nonce[:12],
            "Same-run Personal host scratch identity differs")
    inputs = record.get("inputs", {})
    require(isinstance(inputs, dict) and len(inputs) == 4, "Personal host command identities are incomplete")
    for name in ("probe-personal-candidate.mts", "personal-native-host.py", "probe-host-browser.py"):
        file = source_root / name
        data = read_same_run_file(file, 2 * 1024 * 1024)
        require(inputs.get(str(file)) == {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
                and type(inputs[str(file)].get("bytes")) is int,
                "Personal host controller or ownership source differs")
    require(isinstance(personal.get("hostInputs"), dict), "Personal host input record is missing")
    node = personal["hostInputs"].get("node", {})
    require(isinstance(node, dict) and isinstance(node.get("path"), str)
            and type(node.get("bytes")) is int and node["bytes"] > 0
            and node.get("sha256") == host.NODE_SHA256
            and inputs.get(node["path"]) == {"bytes": node["bytes"], "sha256": node["sha256"]}
            and type(inputs[node["path"]].get("bytes")) is int,
            "Personal host and contained producer identify different Node inputs")
    require(personal.get("feasibilityPassed") is True
            and record.get("result") == {"passed": True, "file": str(root / "personal-mxc/personal-feasibility.json"),
                "bytes": len(personal_raw), "sha256": hashlib.sha256(personal_raw).hexdigest()}
            and record["result"].get("passed") is True
            and type(record["result"].get("bytes")) is int,
            "Personal host completion does not identify this passing workload")
    return raw


def prepare_same_run_archives(root, output, source, run_id, run_attempt):
    """Snapshot this job's completed producer; never label it a published artifact."""
    require(re.fullmatch(r"[a-f0-9]{40}", source)
            and re.fullmatch(r"[1-9][0-9]*", run_id or "")
            and re.fullmatch(r"[1-9][0-9]*", run_attempt or ""),
            "Same-run intake requires the actual workflow identity")
    for directory in (root, root / "official-hermes-runtime-candidate",
                      root / "official-hermes-runtime-build", root / "personal-mxc"):
        info = directory.lstat()
        require(stat.S_ISDIR(info.st_mode) and not directory.is_symlink()
                and not (getattr(info, "st_file_attributes", 0) & 0x400),
                "Same-run producer directory is redirected")
    phase_raw = read_same_run_file(root / "personal-phase.json", 1024 * 1024)
    build_raw = read_same_run_file(root / "official-hermes-runtime-phase.json", 1024 * 1024)
    phase, build = json.loads(phase_raw), json.loads(build_raw)
    for value, source_key, classification, status in (
        (phase, "sourceRevision", "canonical-personal-mxc-candidate-feasibility", "pass"),
        (build, "controllerSource", "official-hermes-runtime-build-phase", "candidate-bytes-exported-unqualified"),
    ):
        require(type(value.get("schemaVersion")) is int and value["schemaVersion"] == 1
                and value.get("classification") == classification and value.get("status") == status
                and value.get(source_key) == source
                and value.get("workflowRunId") == run_id and value.get("workflowRunAttempt") == run_attempt
                and value.get("buildProcessesClosed") is True
                and value.get("installedAcceptance") is False,
                "Same-run producer identity, result or build closure differs")
    require(phase.get("currentNativeProduction") is True
            and phase.get("diagnosticOnly") is False and phase.get("cleanupErrors") == []
            and phase.get("runtimeRootRemoved") is True
            and phase.get("runtimeRetainedForUnclosedBuild") is False
            and phase.get("runtimeRetainedForUnclosedExecutor") is False
            and phase.get("runtimeRebuilt") is True and phase.get("runtimeExported") is True
            and phase.get("fullAgentQualified") is False
            and phase.get("replayInputSha256") is None
            and isinstance(phase.get("runtimeRoot"), str)
            and re.fullmatch(r"C:\\NemoClawHermesProbe-[a-f0-9]{12}", phase["runtimeRoot"])
            and phase["runtimeRoot"] == build.get("runtimeRoot")
            and build.get("runtimeExecutionQualified") is False and build.get("activationAllowed") is False,
            "Same-run Personal production or cleanup did not complete")
    candidate_root = root / "official-hermes-runtime-candidate"
    candidate_raw = read_same_run_file(candidate_root / "runtime-candidate.json", 65536)
    candidate_sha = hashlib.sha256(candidate_raw).hexdigest()
    require(candidate_sha == phase.get("derivedCandidateReceiptSha256")
            and candidate_sha == build.get("candidateReceiptSha256"),
            "Same-run producer receipts identify another candidate")
    personal_raw = read_same_run_file(root / "personal-mxc/personal-feasibility.json", 16 * 1024 * 1024)
    personal = json.loads(personal_raw)
    require(personal.get("runtime") == phase["runtimeRoot"],
            "Same-run Personal tested another runtime")
    host_owner_raw = validate_same_run_host_owner(root, phase, personal, personal_raw, source, run_id, run_attempt)
    require(build.get("stateOwnerBuildAttempted") is True and build.get("stateOwnerBuildClosed") is True,
            "Same-run native state helper build did not close")
    request_raw = read_same_run_file(root / "personal-mxc/personal-request.json", 1024 * 1024)
    state_build_raw = validate_same_run_state_owner(root, personal, json.loads(request_raw), source, run_id, run_attempt)
    validate_same_run_browser(personal, json.loads(request_raw))
    candidate_files = list(candidate_root.iterdir())
    require(0 < len(candidate_files) <= 32, "Same-run candidate metadata count exceeds its bound")
    archive_name = json.loads(candidate_raw)["archive"]["file"]
    require(archive_name == "official-hermes-runtime-candidate.tar.gz",
            "Same-run candidate archive name differs")
    entries = []
    for file in candidate_files:
        require(file.name == archive_name or file.suffix == ".json",
                "Unexpected same-run candidate member")
        info = file.lstat()
        require(stat.S_ISREG(info.st_mode) and not file.is_symlink() and info.st_nlink == 1
                and not (getattr(info, "st_file_attributes", 0) & 0x400)
                and 0 < info.st_size <= (2_000_000_000 if file.name == archive_name else 256 * 1024 * 1024),
                "Same-run candidate member is not bounded and ordinary")
        entries.append((file, "candidate/" + file.name))
    for name in ("official-runtime-build.json", "native-adaptation.json"):
        file = root / "official-hermes-runtime-build" / name
        read_same_run_file(file, 16 * 1024 * 1024)
        entries.append((file, "build/" + name))
    require(sum(file.stat().st_size for file, _ in entries) <= 2_000_000_000,
            "Same-run complete candidate exceeds its byte bound")
    candidate_zip = output / "candidateArtifact.zip"
    with zipfile.ZipFile(candidate_zip, "x", compression=zipfile.ZIP_STORED) as archive:
        for file, name in entries:
            archive.write(file, name)
    personal_zip = output / "personalEvidenceArtifact.zip"
    with zipfile.ZipFile(personal_zip, "x", compression=zipfile.ZIP_STORED) as archive:
        archive.writestr("personal/state-owner-build.json", state_build_raw)
        archive.writestr("personal/host-process-owner.json", host_owner_raw)
        for name, maximum in (("personal-feasibility.json", 16 * 1024 * 1024),
                              ("personal-request.json", 1024 * 1024), ("mxc-native.log", 4 * 1024 * 1024)):
            archive.writestr("personal/" + name, read_same_run_file(root / "personal-mxc" / name, maximum))
    (output / "personal-phase.json").write_bytes(phase_raw)
    (output / "official-hermes-runtime-phase.json").write_bytes(build_raw)
    paths = {"candidateArtifact": candidate_zip, "personalEvidenceArtifact": personal_zip}
    context = {"schemaVersion": 5, "classification": "same-run-native-personal-installer-input",
               "sourceRevision": source, "runId": int(run_id), "runAttempt": int(run_attempt),
               "candidateReceiptSha256": candidate_sha,
               "personalReceiptSha256": hashlib.sha256(personal_raw).hexdigest(),
               "nativeStateBuildSha256": hashlib.sha256(state_build_raw).hexdigest(),
               "nativeHostOwnerSha256": hashlib.sha256(host_owner_raw).hexdigest(),
               "localArchives": {key: {"bytes": file.stat().st_size, "sha256": digest(file)}
                                 for key, file in paths.items()},
               "producerReceipts": {"personal-phase.json": hashlib.sha256(phase_raw).hexdigest(),
                                    "official-hermes-runtime-phase.json": hashlib.sha256(build_raw).hexdigest()}}
    # The enclosing run is still live. Phase checks do not claim workflow success.
    runs = {int(run_id): {"id": int(run_id), "run_attempt": int(run_attempt), "head_sha": source,
                         "evidenceMode": "same-run-local-producer", "workflowCompleted": False}}
    return context, runs, paths


def prepare_pinned_archives(pin, owner, output):
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "NemoClaw-CI"}
    if os.environ.get("GH_TOKEN"):
        headers["Authorization"] = "Bearer " + os.environ["GH_TOKEN"]
    runs = {}
    for kind in ["personal", "candidate"]:
        source_revision, run_id = source_run(pin, kind)
        if run_id not in runs:
            with urllib.request.urlopen(
                urllib.request.Request(
                    f"https://api.github.com/repos/NVIDIA/NemoClaw/actions/runs/{run_id}",
                    headers=headers,
                ),
                timeout=30,
            ) as response:
                runs[run_id] = json.load(response)
        # The immutable 8d78 base exported complete bytes but failed Personal.
        # Only the separately pinned replay evidence must report a passing run.
        validate_run(
            runs[run_id],
            source_revision,
            run_id,
            passing=(kind == "personal" and pin["schemaVersion"] != 3)
            or pin["schemaVersion"] in (1, 4),
            native_mode=pin["schemaVersion"] == 4,
        )
    if pin["schemaVersion"] == 3:
        with urllib.request.urlopen(
            urllib.request.Request(
                f"https://api.github.com/repos/NVIDIA/NemoClaw/actions/runs/{pin['edgeRunId']}",
                headers=headers,
            ),
            timeout=30,
        ) as response:
            edge_run = json.load(response)
        validate_run(
            edge_run,
            pin["edgeSourceRevision"],
            pin["edgeRunId"],
            passing=True,
        )
    paths = {}
    for key in ["personalEvidenceArtifact", "candidateArtifact"]:
        row = pin[key]
        source_revision, run_id = source_run(
            pin, "personal" if key == "personalEvidenceArtifact" else "candidate"
        )
        file = output / (key + ".zip")
        owner.download(
            file,
            artifact=row["id"],
            run=run_id,
            head=source_revision,
            size=row["bytes"],
            sha=row["sha256"],
        )
        owner.verify_zip(file, row["bytes"], row["sha256"])
        paths[key] = file
    edge_identity = None
    if pin["schemaVersion"] == 3:
        row = pin["edgeEvidenceArtifact"]
        file = output / "edgeEvidenceArtifact.zip"
        owner.download(
            file,
            artifact=row["id"],
            run=pin["edgeRunId"],
            head=pin["edgeSourceRevision"],
            size=row["bytes"],
            sha=row["sha256"],
        )
        owner.verify_zip(file, row["bytes"], row["sha256"])
        with zipfile.ZipFile(file) as archive:
            edge_raw, edge_identity = exact_root_document(
                archive, "edge-identity.json", 64 * 1024
            )
        require(
            hashlib.sha256(edge_raw).hexdigest() == pin["edgeReceiptSha256"]
            and edge_identity.get("classification") == "native-arm64-microsoft-edge"
            and edge_identity.get("architecture") == "arm64"
            and edge_identity.get("machine") == 0xAA64
            and edge_identity.get("signatureStatus") == "Valid"
            and edge_identity.get("provenance") == "standard-windows-microsoft-edge-installation"
            and edge_identity.get("executed") is False,
            "Native Edge prerequisite receipt differs",
        )
    return runs, paths, edge_identity


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    inputs = parser.add_mutually_exclusive_group()
    inputs.add_argument("--pin", type=Path)
    inputs.add_argument("--same-run-personal-directory", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--native-proof-directory", type=Path, required=True)
    parser.add_argument("--source-revision", required=True)
    args = parser.parse_args()
    require(
        os.name == "nt"
        and os.environ.get("GITHUB_ACTIONS") == "true"
        and args.source_revision == os.environ.get("GITHUB_SHA")
        and re.fullmatch(r"[a-f0-9]{40}", args.source_revision),
        "Finished Hermes intake requires exact Windows CI",
    )
    require(not args.output.exists(), "Hermes intake output must be fresh")
    source = Path(__file__).parents[1] / "hermes/verify-personal-candidate.py"
    spec = importlib.util.spec_from_file_location("complete_candidate", source)
    owner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(owner)
    args.output.mkdir(parents=True)
    if args.same_run_personal_directory:
        pin, runs, paths = prepare_same_run_archives(
            args.same_run_personal_directory, args.output, args.source_revision,
            os.environ.get("GITHUB_RUN_ID"), os.environ.get("GITHUB_RUN_ATTEMPT"),
        )
        edge_identity = None
    else:
        pin_file = args.pin or Path(__file__).with_name("finished-hermes-inputs.json")
        pin = validate_pin(json.loads(pin_file.read_text()))
        if pin["schemaVersion"] == 4:
            require(pin["sourceRevision"] == args.source_revision,
                    "Native finished inputs must match the current assembly source")
        runs, paths, edge_identity = prepare_pinned_archives(pin, owner, args.output)
    with zipfile.ZipFile(paths["personalEvidenceArtifact"]) as archive:
        personal_member, raw, personal = owner.document(
            archive, "personal-feasibility.json", 16 * 1024 * 1024
        )
        require(
            hashlib.sha256(raw).hexdigest() == pin["personalReceiptSha256"],
            "Personal receipt changed",
        )
        native_documents = {}
        if type(personal.get("schemaVersion")) is int and personal["schemaVersion"] == 2:
            native_documents = native_personal_documents(archive, personal_member)
        validate_personal(personal, pin, native_documents.get("personal-request.json"),
                          native_documents.get("mxc-native.log"))
        if pin["schemaVersion"] == 5:
            state_raw = exact_archive_bytes(archive, "personal/state-owner-build.json", 1024 * 1024)
            require(hashlib.sha256(state_raw).hexdigest() == pin["nativeStateBuildSha256"]
                    == personal["nativeStateBuild"]["receipt"]["sha256"],
                    "The admitted native state build receipt changed")
            (args.output / "state-owner-build.json").write_bytes(state_raw)
        if pin["schemaVersion"] == 3:
            personal = {
                **personal,
                "browserMode": "host-native-edge-cdp",
                "edgePrerequisite": edge_identity,
                "sourcePersonalReceiptSha256": pin["personalReceiptSha256"],
                "installedAcceptanceRequired": True,
            }
            (args.output / "personal-feasibility.json").write_text(
                json.dumps(personal, indent=2) + "\n"
            )
        else:
            (args.output / "personal-feasibility.json").write_bytes(raw)
        current_documents = (
            replay_native_documents(archive, owner, personal)
            if pin["schemaVersion"] in (2, 3)
            else {}
        )
        for name, data in native_documents.items():
            require(name not in current_documents or current_documents[name] == data,
                    "Native Personal archive documents disagree")
            current_documents[name] = data
        for name, data in current_documents.items():
            (args.output / name).write_bytes(data)
    metadata = args.output / "candidate"
    metadata.mkdir()
    with zipfile.ZipFile(paths["candidateArtifact"]) as archive:
        _, raw, candidate = owner.document(archive, "runtime-candidate.json", 65536)
        require(
            hashlib.sha256(raw).hexdigest() == pin["candidateReceiptSha256"],
            "Candidate receipt changed",
        )
        adapter = (
            REPLAY_BASE["startupAdapterSha256"]
            if pin["schemaVersion"] == 3
            else digest(Path(__file__).parents[1] / "hermes/nemoclaw_native_windows.py")
        )
        details = owner.documents(
            archive, head=source_run(pin, "candidate")[0], adapter=adapter
        )
        _, derivation_raw, derivation = owner.document(
            archive, "candidate-derivation.json", 65536
        )
        require(
            hashlib.sha256(derivation_raw).hexdigest()
            == candidate["derivation"]["sha256"],
            "Candidate derivation changed",
        )
        if pin["schemaVersion"] in (2, 3):
            validate_replay(personal, pin, candidate, raw, derivation)
        elif pin["schemaVersion"] in (4, 5):
            validate_native_runtime_inventory(personal, candidate,
                                              (len(raw), hashlib.sha256(raw).hexdigest()),
                                              derivation, details[1], args.source_revision)
        documents = [
            ("runtime-candidate.json", pin["candidateReceiptSha256"]),
            ("payload-inventory.json", candidate["inventorySha256"]),
            ("official-runtime-build.json", candidate["buildReceiptSha256"]),
            ("native-adaptation.json", candidate["adaptationReceiptSha256"]),
            ("candidate-derivation.json", candidate["derivation"]["sha256"]),
        ]
        documents += [
            (derivation[key]["file"], derivation[key]["sha256"])
            for key in ["pywinpty", "git", "compatibility", "compatibilityProof", "mxc"]
        ]
        for name, expected in documents:
            require(Path(name).name == name, "Invalid candidate document name")
            _, data, _ = owner.document(archive, name)
            require(
                hashlib.sha256(data).hexdigest() == expected,
                "Candidate document changed: " + name,
            )
            (metadata / name).write_bytes(data)
        owner.verify_members(archive, details)
        owner.extract_verified(archive, details, args.output / "runtime")
    proof_root = args.native_proof_directory
    proof = json.loads((proof_root / "result.json").read_text())
    reuse = proof.get("qualificationReuse")
    if reuse is not None:
        reuse_receipt = json.loads((proof_root / "reuse-receipt.json").read_text())
        require(
            reuse == {key: value for key, value in reuse_receipt.items() if key != "rewrittenReceiptFiles"}
            and reuse.get("classification") == "exact-input-reused-bash-qualification"
            and reuse.get("currentSource") == args.source_revision
            and reuse.get("runtimeExecutedThisRun") is False
            and reuse.get("baselinePassed") is True,
            "Reused Bash qualification is not bound to exact producer inputs",
        )
    builds = []
    for name, field in [
        ("compatibility-build/build-receipt.json", "sourceRevision"),
        (
            "mxc-token-inspection-build/mxc-token-inspection-build.json",
            "candidateRevision",
        ),
    ]:
        record = json.loads((proof_root / name).read_text())
        builds.append(record)
        require(
            record.get(field) == args.source_revision
            and record.get("status") == "built",
            "Native composition uses a different source",
        )
        for row in record["files"]:
            file = (proof_root / name).parent / row["file"]
            require(
                Path(row["file"]).name == row["file"]
                and file.stat().st_size == row["bytes"]
                and digest(file) == row["sha256"],
                "Native composition member changed",
            )
    validate_current_compatibility(
        proof, digest(proof_root / "result.json"), *builds, args.source_revision
    )
    validate_personal_composition(personal, proof, *builds, args.source_revision)
    (args.output / "intake.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "classification": "finished-hermes-verified-build-inputs",
                "personalInput": pin,
                "sourceRevision": args.source_revision,
                "candidateRun": runs[source_run(pin, "candidate")[1]],
                "personalRun": runs[source_run(pin, "personal")[1]],
                "publicRuntimeAccess": validate_public_runtime_access(personal)
                if pin["schemaVersion"] in (2, 3)
                else None,
                "currentNativeDocuments": personal["runtimeReplay"]["nativeComponent"][
                    "documents"
                ]
                if pin["schemaVersion"] in (2, 3)
                else None,
                "personalRequest": {
                    "file": "personal-request.json",
                    "bytes": len(current_documents["personal-request.json"]),
                    "sha256": personal["requestSha256"],
                }
                if pin["schemaVersion"] in (2, 3, 4, 5)
                else None,
                "edgePrerequisite": edge_identity,
                "nativeProofSha256": digest(proof_root / "result.json"),
                "completeRuntimeVerified": True,
                "nativeCompositionStillRequired": True,
                "installedAcceptance": False,
                "fullAgentQualified": False,
            },
            indent=2,
        )
        + "\n"
    )


if __name__ == "__main__":
    main()
