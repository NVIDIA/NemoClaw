# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Export complete candidate bytes; this is never an activation/qualification receipt."""

import argparse
import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import re
import tarfile


def load_inventory():
    spec = importlib.util.spec_from_file_location(
        "official_inventory", Path(__file__).with_name("official-runtime-inventory.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def digest(file):
    with Path(file).open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def save(file, value):
    with Path(file).open("x", encoding="utf-8", newline="\n") as handle:
        json.dump(value, handle, indent=2)
        handle.write("\n")


def validate_adaptation(runtime, report, module_sha):
    if (
        report.get("schemaVersion") != 1
        or report.get("classification") != "native-hermes-generated-metadata-adaptation"
        or report.get("hermesRevision") != "2237be355906fbe6065ce1815711eee52b2d646e"
        or report.get("runtimeExecutionQualified") is not False
        or report.get("requiresMovedRootProbe") is not True
        or report.get("environments") != ["hermes-agent/venv", "tools/browser-use"]
    ):
        raise ValueError(
            "The complete candidate lacks its exact generated-metadata adaptation"
        )
    seen = set()
    for item in report.get("files", []):
        relative = Path(item["path"])
        if relative.is_absolute() or ".." in relative.parts or item["path"] in seen:
            raise ValueError("Invalid or duplicate generated metadata path")
        seen.add(item["path"])
        file = runtime / relative
        if (
            not file.resolve(strict=True).is_relative_to(runtime)
            or not file.is_file()
            or file.stat().st_size != item["bytes"]
            or digest(file) != item["sha256"]
        ):
            raise ValueError("Generated metadata changed after adaptation")
    marker = json.loads(
        (runtime / "nemoclaw-windows-runtime.json").read_text(encoding="utf-8")
    )
    if (
        marker.get("startupAdapterSha256") != module_sha
        or "nemoclaw-windows-runtime.json" not in seen
    ):
        raise ValueError(
            "The candidate does not contain its exact current startup adapter"
        )
    hooks = [
        item
        for item in report["files"]
        if item["path"].endswith("/nemoclaw_native_windows.py")
    ]
    if len(hooks) != 3 or any(item["sha256"] != module_sha for item in hooks):
        raise ValueError(
            "The complete official base, Hermes and Browser Use startup hooks are missing"
        )


class HashedReader:
    def __init__(self, source):
        self.source = source
        self.hash = hashlib.sha256()
        self.bytes = 0

    def read(self, count):
        data = self.source.read(count)
        self.hash.update(data)
        self.bytes += len(data)
        return data


def archive_candidate(runtime, payload, destination):
    """Every inventoried regular byte and in-root link is retained; no pruning."""
    runtime = Path(runtime).resolve(strict=True)
    with (
        destination.open("xb") as output,
        gzip.GzipFile(fileobj=output, mode="wb", mtime=0) as zipped,
    ):
        with tarfile.open(
            fileobj=zipped, mode="w|", format=tarfile.PAX_FORMAT
        ) as archive:
            for relative in payload.get("directories", []):
                item = tarfile.TarInfo("runtime/" + relative)
                item.type = tarfile.DIRTYPE
                item.mode = 0o755
                archive.addfile(item)
            for row in payload["files"]:
                relative = Path(row["path"])
                if relative.is_absolute() or ".." in relative.parts:
                    raise ValueError("Unsafe archive inventory path")
                source = runtime / relative
                item = tarfile.TarInfo("runtime/" + row["path"])
                item.mode = 0o644
                if "linkTarget" in row:
                    if not source.resolve(strict=True).is_relative_to(runtime):
                        raise ValueError("A runtime link changed to an outside target")
                    target = os.path.relpath(
                        source.resolve(strict=True), source.parent
                    ).replace("\\", "/")
                    if target != row["linkTarget"]:
                        raise ValueError("A runtime link changed after inventory")
                    item.type = tarfile.SYMTYPE
                    item.linkname = target
                    archive.addfile(item)
                    continue
                with source.open("rb") as handle:
                    before = os.fstat(handle.fileno())
                    if (
                        not stat.S_ISREG(before.st_mode)
                        or before.st_size != row["bytes"]
                    ):
                        raise ValueError(
                            "A runtime file changed size/type before archival"
                        )
                    item.size = row["bytes"]
                    reader = HashedReader(handle)
                    archive.addfile(item, reader)
                    after = os.fstat(handle.fileno())
                    if (
                        handle.read(1)
                        or reader.bytes != row["bytes"]
                        or reader.hash.hexdigest() != row["sha256"]
                        or before.st_size != after.st_size
                        or before.st_mtime_ns != after.st_mtime_ns
                    ):
                        raise ValueError(
                            "Runtime bytes changed during candidate archival"
                        )
    return {
        "file": destination.name,
        "bytes": destination.stat().st_size,
        "sha256": digest(destination),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-root", type=Path, required=True)
    parser.add_argument("--source-archive", type=Path, required=True)
    parser.add_argument("--build-receipt", type=Path, required=True)
    parser.add_argument("--adaptation-receipt", type=Path, required=True)
    parser.add_argument("--output-directory", type=Path, required=True)
    parser.add_argument("--controller-source", required=True)
    args = parser.parse_args()
    runtime = args.runtime_root.resolve(strict=True)
    output = args.output_directory.resolve()
    if output.exists() or output.is_relative_to(runtime):
        raise ValueError("Candidate export requires fresh evidence outside the runtime")
    if not re.fullmatch("[a-f0-9]{40}", args.controller_source):
        raise ValueError("The candidate controller source must be an exact commit")
    output.mkdir(parents=True)
    result = {
        "schemaVersion": 1,
        "classification": "official-hermes-runtime-candidate-build",
        "status": "failed",
        "controllerSource": args.controller_source,
        "completeByteInventory": False,
        "runtimeExecutionQualified": False,
        "installedAcceptance": False,
        "activationAllowed": False,
        "upstreamCommit": "2237be355906fbe6065ce1815711eee52b2d646e",
        "profile": "official-cli-web-tui-and-browser-use",
        "standaloneDesktopBuilt": False,
        "computerUse": "not-selected-official-SkipComputerUse",
        "tavilyLiveLookup": "not-tested-user-waiver",
        "mxcQualification": {
            "status": "not-run-known-prerequisite-blocker",
            "reason": "Unmodified official MSYS named-object initialization is denied by pinned MXC",
            "upstreamIssue": "https://github.com/microsoft/mxc/issues/1061",
        },
        "finalInstallPathAdaptationRequired": True,
        "movedRootExecutionRequired": True,
    }
    try:
        inventory = load_inventory()
        build = json.loads(args.build_receipt.read_text(encoding="utf-8"))
        inventory.validate_build_receipt(build)
        module_sha = digest(Path(__file__).with_name("nemoclaw_native_windows.py"))
        if (
            module_sha
            != "055f26bd95242d0fbe7e2f69034b19c1fed13ebb71c5e8b5323db374e399427e"
        ):
            raise ValueError(
                "The startup adapter differs from the reviewed current source"
            )
        validate_adaptation(
            runtime,
            json.loads(args.adaptation_receipt.read_text(encoding="utf-8")),
            module_sha,
        )
        source_files = inventory.verify_official_source(runtime, args.source_archive)
        payload = inventory.inventory(runtime)
        save(output / "payload-inventory.json", payload)
        save(
            output / "upstream-locked-inputs.json",
            inventory.source_inputs(runtime / "hermes-agent"),
        )
        save(
            output / "production-inventory.json",
            {
                "schemaVersion": 1,
                "partitionStatus": "complete-unpruned-candidate",
                "files": payload["files"],
            },
        )
        save(
            output / "diagnostics-inventory.json",
            {"schemaVersion": 1, "files": [], "removalValidated": False},
        )
        pending = output / "official-hermes-runtime-candidate.tar.gz.partial"
        archived = archive_candidate(runtime, payload, pending)
        if inventory.inventory(runtime) != payload:
            raise ValueError("The runtime changed after its candidate byte snapshot")
        final_archive = output / "official-hermes-runtime-candidate.tar.gz"
        pending.rename(final_archive)
        archived["file"] = final_archive.name
        result.update(
            status="candidate-bytes-exported",
            completeByteInventory=True,
            archive=archived,
            sourceFilesVerified=source_files,
            fileCount=len(payload["files"]),
            logicalBytes=sum(row.get("bytes", 0) for row in payload["files"]),
            inventorySha256=digest(output / "payload-inventory.json"),
            sourceArchiveSha256=digest(args.source_archive),
            buildReceiptSha256=digest(args.build_receipt),
            adaptationReceiptSha256=digest(args.adaptation_receipt),
            startupAdapterSha256=module_sha,
        )
    except BaseException as error:
        result["error"] = str(error)
        raise
    finally:
        primary = sys.exception()
        try:
            save(output / "runtime-candidate.json", result)
        except Exception as error:
            if primary is None:
                raise
            primary.add_note("Candidate receipt also failed: " + str(error))


if __name__ == "__main__":
    main()
