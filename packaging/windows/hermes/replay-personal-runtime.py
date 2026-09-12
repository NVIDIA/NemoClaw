# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Replay one immutable complete canonical runtime; never rebuild or relocate it."""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import time
import zipfile

HERE = Path(__file__).parent
PIN = {
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
SOURCE_SHA = "c1f2401c8096e9372c46fa4ef8bdada18ed3cc84c0f5274562b86b7646ed3a87"
BUILD_SHA = "b28c01a5eb2880cab6d824f812a414df86f91de1e0806452cf9132044d934b26"


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


OWNER = load("verify-personal-candidate.py")


def sha(data):
    return hashlib.sha256(data).hexdigest()


def replay_documents(archive):
    OWNER.require(
        len(archive.infolist()) == 14 and len(set(archive.namelist())) == 14,
        "The fixed complete replay artifact layout differs",
    )
    _, raw, candidate = OWNER.document(archive, "runtime-candidate.json", 65536)
    OWNER.require(
        sha(raw) == PIN["candidateReceiptSha256"],
        "The fixed replay candidate receipt changed",
    )
    OWNER.require(
        candidate.get("sourceArchiveSha256") == SOURCE_SHA
        and candidate.get("buildReceiptSha256") == BUILD_SHA
        and candidate.get("inventorySha256") == PIN["inventorySha256"],
        "The fixed replay lost its original complete source/build provenance",
    )
    details = OWNER.documents(
        archive, head=PIN["sourceRevision"], adapter=PIN["startupAdapterSha256"]
    )
    OWNER.require(not details[4], "The completed replay unexpectedly contains links")
    reference = candidate.get("derivation", {})
    _, derivation_raw, derivation = OWNER.document(
        archive, "candidate-derivation.json", 65536
    )
    OWNER.require(
        reference.get("file") == "candidate-derivation.json"
        and reference.get("bytes") == len(derivation_raw)
        and reference.get("sha256") == sha(derivation_raw)
        and derivation.get("classification")
        == "reused-complete-canonical-hermes-runtime"
        and derivation.get("runtimeRootAtExport") == PIN["runtimeRoot"]
        and derivation.get("onlyRecordedChanges") is True
        and derivation.get("completeCanonicalBaseVerified") is True
        and derivation.get("installedAcceptance") is False
        and derivation.get("fullAgentQualified") is False,
        "The completed replay derivation changed",
    )
    documents = {
        "runtime-candidate.json": raw,
        "candidate-derivation.json": derivation_raw,
    }
    references = [
        ("payload-inventory.json", candidate["inventorySha256"]),
        ("official-runtime-build.json", candidate["buildReceiptSha256"]),
        ("native-adaptation.json", candidate["adaptationReceiptSha256"]),
    ]
    for key, name in [
        ("pywinpty", "pywinpty-rebuild.json"),
        ("git", "canonical-git-derivation.json"),
        ("compatibility", "msys-build.json"),
        ("compatibilityProof", "bash-compatibility-proof.json"),
        ("mxc", "mxc-build.json"),
    ]:
        row = derivation[key]
        OWNER.require(row["file"] == name, "The completed replay document name changed")
        references.append((name, row["sha256"]))
    for name, expected in references:
        _, data, _ = OWNER.document(archive, name)
        OWNER.require(
            sha(data) == expected, "The completed replay document changed: " + name
        )
        documents[name] = data
    return details, documents, derivation


def verify_runtime(runtime, expected):
    started = time.monotonic()
    actual = load("official-runtime-inventory.py").inventory(runtime)
    OWNER.require(
        actual["files"] == expected["files"]
        and actual["directories"] == expected["directories"],
        "The immutable replay runtime changed outside its original full inventory",
    )
    return {
        "allFilesAndDirectoriesVerified": True,
        "files": len(actual["files"]),
        "logicalBytes": sum(row.get("bytes", 0) for row in actual["files"]),
        "elapsedMs": (time.monotonic() - started) * 1000,
    }


def stage(zip_file, output, runtime):
    OWNER.require(
        not output.exists() and not output.is_symlink(), "Replay evidence must be fresh"
    )
    OWNER.require(
        not runtime.exists() and not runtime.is_symlink(),
        "The fixed replay runtime root already exists",
    )
    OWNER.require(
        str(runtime) == PIN["runtimeRoot"],
        "Replay must use its recorded final runtime path",
    )
    OWNER.require(
        OWNER.digest(HERE / "nemoclaw_native_windows.py")
        == PIN["startupAdapterSha256"],
        "The current Python adapter differs; this immutable replay cannot test changed Python bytes",
    )
    output.mkdir(parents=True)
    if not zip_file.exists():
        OWNER.download(
            zip_file,
            artifact=PIN["artifactId"],
            run=PIN["runId"],
            head=PIN["sourceRevision"],
            size=PIN["bytes"],
            sha=PIN["sha256"],
        )
    OWNER.verify_zip(zip_file, PIN["bytes"], PIN["sha256"])
    created = False

    def owned(path):
        nonlocal created
        created = True
        OWNER.save(
            output / "runtime-ownership.json",
            {"runtimeRoot": str(path), "createdByReplay": True},
        )

    try:
        with zipfile.ZipFile(zip_file) as archive:
            details, documents, derivation = replay_documents(archive)
            OWNER.require(
                not Path(derivation["originalBuildRoot"]).exists(),
                "The original pre-adaptation root must remain absent",
            )
            verified = time.monotonic()
            OWNER.verify_members(archive, details)
            archive_ms = (time.monotonic() - verified) * 1000
            for name, data in documents.items():
                (output / name).write_bytes(data)
            extracted = time.monotonic()
            OWNER.extract_verified(archive, details, runtime, created=owned)
            extraction_ms = (time.monotonic() - extracted) * 1000
            before = verify_runtime(runtime, details[1])
            before["inventorySha256"] = PIN["inventorySha256"]
        receipt = {
            "schemaVersion": 1,
            "classification": "immutable-canonical-hermes-personal-replay",
            "controllerSource": os.environ["GITHUB_SHA"],
            "base": PIN,
            "runtimeRoot": str(runtime),
            "completeZipVerified": True,
            "completeNestedArchiveVerified": True,
            "sourceBuildProvenanceVerified": True,
            "before": before,
            "archiveVerificationMs": archive_ms,
            "extractionMs": extraction_ms,
            "runtimeRebuilt": False,
            "runtimeRelocated": False,
            "runtimeExported": False,
            "runtimeExecutionQualified": False,
            "installedAcceptance": False,
        }
        OWNER.save(output / "replay-input.json", receipt)
        return receipt
    except BaseException as error:
        if created:
            try:
                shutil.rmtree(runtime)
            except Exception as cleanup:
                error.add_note(
                    "Owned replay extraction cleanup also failed: " + str(cleanup)
                )
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--zip", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--runtime-root", type=Path, default=Path(PIN["runtimeRoot"]))
    args = parser.parse_args()
    OWNER.require(
        os.name == "nt" and os.environ.get("GITHUB_ACTIONS") == "true",
        "Replay requires disposable Windows CI",
    )
    print(json.dumps(stage(args.zip, args.output, args.runtime_root)))


if __name__ == "__main__":
    main()
