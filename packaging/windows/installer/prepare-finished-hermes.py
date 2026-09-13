# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Admit a pinned Personal-passing complete candidate for CI installer assembly."""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PureWindowsPath
import re
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


def source_run(pin, kind):
    if pin["schemaVersion"] == 1:
        return pin["sourceRevision"], pin["runId"]
    return pin[kind + "SourceRevision"], pin[kind + "RunId"]


def validate_pin(pin):
    require(
        pin.get("schemaVersion") in (1, 2, 3)
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
    return pin


def validate_personal(record, pin):
    edge_mode = pin["schemaVersion"] == 3
    require(
        record.get("schemaVersion") == 1
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
                "profileDeleted",
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


def validate_run(run, source, run_id, *, passing):
    require(
        run.get("id") == run_id
        and run.get("head_sha") == source
        and run.get("status") == "completed"
        and (not passing or run.get("conclusion") == "success")
        and run.get("path") == ".github/workflows/windows-native-installer.yaml",
        "Pinned workflow identity or result differs",
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--pin",
        type=Path,
        default=Path(__file__).with_name("finished-hermes-inputs.json"),
    )
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--native-proof-directory", type=Path, required=True)
    parser.add_argument("--source-revision", required=True)
    args = parser.parse_args()
    pin = validate_pin(json.loads(args.pin.read_text()))
    require(
        os.name == "nt"
        and os.environ.get("GITHUB_ACTIONS") == "true"
        and args.source_revision == os.environ.get("GITHUB_SHA"),
        "Finished Hermes intake requires exact Windows CI",
    )
    require(not args.output.exists(), "Hermes intake output must be fresh")
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
            or pin["schemaVersion"] == 1,
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
    source = Path(__file__).parents[1] / "hermes/verify-personal-candidate.py"
    spec = importlib.util.spec_from_file_location("complete_candidate", source)
    owner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(owner)
    args.output.mkdir(parents=True)
    paths = {}
    for key in ["personalEvidenceArtifact", "candidateArtifact"]:
        row = pin[key]
        source_revision, run_id = source_run(
            pin, "personal" if key == "personalEvidenceArtifact" else "candidate"
        )
        file = args.output / (key + ".zip")
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
        file = args.output / "edgeEvidenceArtifact.zip"
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
            _, edge_raw, edge_identity = owner.document(archive, "edge-identity.json", 64 * 1024)
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
    with zipfile.ZipFile(paths["personalEvidenceArtifact"]) as archive:
        _, raw, personal = owner.document(
            archive, "personal-feasibility.json", 16 * 1024 * 1024
        )
        require(
            hashlib.sha256(raw).hexdigest() == pin["personalReceiptSha256"],
            "Personal receipt changed",
        )
        validate_personal(personal, pin)
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
    require(
        proof.get("classification") == "small-msys-appcontainer-compatibility-proof"
        and proof.get("sourceRevision") == args.source_revision
        and proof.get("passed") is True
        and proof.get("normalCleanup") is True,
        "Current-source compatibility proof did not pass",
    )
    for name, field in [
        ("compatibility-build/build-receipt.json", "sourceRevision"),
        (
            "mxc-token-inspection-build/mxc-token-inspection-build.json",
            "candidateRevision",
        ),
    ]:
        record = json.loads((proof_root / name).read_text())
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
                if pin["schemaVersion"] in (2, 3)
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
