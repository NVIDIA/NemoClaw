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
import shutil


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


def validate_current_adaptation(runtime, report):
    # The pinned controller checkout is the reviewed adapter source. Compare
    # every installed copy to these exact bytes and retain the hash in the receipt.
    module_sha = digest(Path(__file__).with_name("nemoclaw_native_windows.py"))
    validate_adaptation(runtime, report, module_sha)
    return module_sha


def git_inventory_summary(files):
    """Match the canonical Git producer's sorted-directory DFS and JSON bytes."""
    rows = [
        {"path": name[4:], "bytes": value["bytes"], "sha256": value["sha256"]}
        for name, value in files.items()
        if name.startswith("git/")
    ]
    rows.sort(
        key=lambda row: tuple(
            part.encode("utf-16-be", "surrogatepass") for part in row["path"].split("/")
        )
    )
    encoded = json.dumps(rows, ensure_ascii=False, separators=(",", ":")).encode(
        "utf-8"
    )
    return (
        len(rows),
        sum(row["bytes"] for row in rows),
        hashlib.sha256(encoded).hexdigest(),
    )


def validate_reuse(runtime, inputs, output, inventory_owner, *, payload=None):
    """Bind the one-package rebuild and exact Git/compat changes to the full base."""
    if sys.platform != "win32" or os.environ.get("GITHUB_ACTIONS") != "true":
        raise ValueError("Complete runtime reuse requires Windows CI")
    here = Path(__file__).parent
    spec = importlib.util.spec_from_file_location(
        "targeted_pywinpty", here / "rebuild-pywinpty-conpty.py"
    )
    wheel_owner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(wheel_owner)
    wheel_evidence = Path(inputs["pywinptyEvidence"])
    wheel_receipt_path = wheel_evidence / "pywinpty-rebuild.json"
    wheel_receipt = json.loads(wheel_receipt_path.read_text(encoding="utf-8"))
    wheel_owner.validate_rebuild_receipt(runtime, wheel_receipt, wheel_evidence)
    before = json.loads((wheel_evidence / "after-inventory.json").read_text())
    expected = wheel_owner.identities(before)
    git_path = Path(inputs["gitReceipt"])
    git = json.loads(git_path.read_text(encoding="utf-8"))
    if (
        git.get("schemaVersion") != 1
        or git.get("classification") != "ci-derived-initialized-canonical-hermes-git"
        or git.get("baseCandidateSource") != wheel_receipt["base"]["sourceRevision"]
        or git.get("baseInventorySha256") != wheel_receipt["base"]["inventorySha256"]
        or git.get("allOtherFilesUnchanged") is not True
        or git.get("firstLaunchSetupAllowed") is not False
        or git.get("fileCount") != 7835
        or git.get("fullAgentQualified") is not False
        or git.get("installedAcceptance") is not False
        or git.get("filesReplacedAtBuild") != 3
        or git.get("personalLoginShellQualificationRequired") is not True
        or git.get("initializedFilesPreserved")
        != [
            "clangarm64/libexec/git-core/dlls-copied",
            "etc/hosts",
            "etc/mtab",
            "etc/networks",
            "etc/protocols",
            "etc/services",
        ]
    ):
        raise ValueError("Initialized canonical Git derivation differs")
    if git_inventory_summary(expected) != (
        git["fileCount"],
        git["beforeLogicalBytes"],
        git["beforeInventorySha256"],
    ):
        raise ValueError("Canonical Git before-inventory binding differs")
    if any(
        name == "git/post-install.bat" or name.startswith("git/etc/post-install/")
        for name in expected
    ):
        raise ValueError("First-launch Git setup returned to the runtime")
    proof_path = Path(inputs["compatibilityProof"])
    if (
        digest(proof_path)
        != "59019111819aa577c30fc494616932486effef4af8b5e850040ecac860a93a1a"
    ):
        raise ValueError("The exact passed Windows compatibility proof changed")
    proof = json.loads(proof_path.read_text(encoding="utf-8"))
    compat_path = Path(inputs["compatibilityReceipt"])
    compat = json.loads(compat_path.read_text(encoding="utf-8"))
    mxc_path = Path(inputs["mxcBuildReceipt"])
    mxc = json.loads(mxc_path.read_text(encoding="utf-8"))
    if (
        proof.get("classification") != "small-msys-appcontainer-compatibility-proof"
        or proof.get("sourceRevision") != "43c9e32485f802ac277d9d0f7959c802facda04d"
        or proof.get("passed") is not True
        or proof.get("normalCleanup") is not True
        or proof["inputs"]["compatibility"] != compat
        or proof["inputs"]["mxcBuild"] != mxc
        or compat.get("status") != "built"
    ):
        raise ValueError(
            "The reused compatibility bytes lack their passed Windows proof"
        )
    source_directory = here.parent / "mxc-bash"
    for row in compat["sourceFiles"]:
        if (
            Path(row["path"]).name != row["path"]
            or digest(source_directory / row["path"]) != row["sha256"]
        ):
            raise ValueError("Compatibility source changed after its Windows proof")
    if digest(source_directory / "mxc-token-inspection.patch") != mxc["patchSha256"]:
        raise ValueError("The tested MXC patch changed")
    proved_images = {
        row["path"]: row for row in proof["inputs"]["gitDerivation"]["files"]
    }
    if len(git.get("files", [])) != 3 or {r["path"] for r in git["files"]} != set(
        proved_images
    ):
        raise ValueError("The canonical Git image set changed")
    for row in git["files"]:
        proved = proved_images[row["path"]]
        for key in (
            "beforeSha256",
            "afterSha256",
            "beforeBytes",
            "bytes",
            "onlyMetadataChanged",
            "sections",
        ):
            if row[key] != proved[key]:
                raise ValueError("A Git image differs from its native proof")
        name = "git/" + row["path"]
        if expected[name] != {
            "bytes": row["beforeBytes"],
            "sha256": row["beforeSha256"],
        }:
            raise ValueError("Git no longer matches the canonical base")
        expected[name] = {"bytes": row["bytes"], "sha256": row["afterSha256"]}
    if git_inventory_summary(expected) != (
        git["fileCount"],
        git["afterLogicalBytes"],
        git["afterInventorySha256"],
    ):
        raise ValueError("Canonical Git after-inventory binding differs")
    copied = [
        *compat["files"],
        compat["license"],
        {
            "file": "build-receipt.json",
            "bytes": compat_path.stat().st_size,
            "sha256": digest(compat_path),
        },
    ]
    if len(copied) != 5 or {r["file"] for r in copied} != {
        "NemoClawMsysLauncher.exe",
        "NemoClawMsysCompat-arm64.dll",
        "NemoClawMsysCompat-x64.dll",
        "DETOURS-LICENSE.txt",
        "build-receipt.json",
    }:
        raise ValueError("Unexpected compatibility runtime member")
    for row in copied:
        name = "mxc-compat/" + row["file"]
        if name in expected:
            raise ValueError("Compatibility collides with the canonical runtime")
        expected[name] = {"bytes": row["bytes"], "sha256": row["sha256"]}
    actual = inventory_owner.inventory(runtime) if payload is None else payload
    if wheel_owner.identities(actual) != expected:
        raise ValueError(
            "The complete runtime changed outside the recorded composition"
        )
    if set(actual["directories"]) != set(before["directories"]) | {"mxc-compat"}:
        raise ValueError("Unrecorded runtime directory changes")
    original = Path(inputs["originalBuildRoot"])
    if (
        original == runtime
        or original.exists()
        or not re.fullmatch(
            r"[A-Za-z]:\\NemoClawHermesProbe-[a-f0-9]{12}", str(original)
        )
    ):
        raise ValueError("The original canonical build root must be absent")
    documents = {}
    for key, source, filename in (
        ("pywinpty", wheel_receipt_path, "pywinpty-rebuild.json"),
        ("git", git_path, "canonical-git-derivation.json"),
        ("compatibility", compat_path, "msys-build.json"),
        ("compatibilityProof", proof_path, "bash-compatibility-proof.json"),
        ("mxc", mxc_path, "mxc-build.json"),
    ):
        destination = output / filename
        if destination.exists():
            raise ValueError("Derivation evidence output must be fresh")
        shutil.copyfile(source, destination)
        documents[key] = {
            "file": filename,
            "bytes": destination.stat().st_size,
            "sha256": digest(destination),
        }
    marker = json.loads((runtime / "nemoclaw-windows-runtime.json").read_text())
    result = {
        "schemaVersion": 1,
        "classification": "reused-complete-canonical-hermes-runtime",
        "base": wheel_receipt["base"],
        "runtimeRootAtExport": str(runtime),
        "originalBuildRoot": str(original),
        "adapterUpgrade": marker["startupAdapterUpgrade"],
        "onlyRecordedChanges": True,
        "completeCanonicalBaseVerified": True,
        "fullAgentQualified": False,
        "installedAcceptance": False,
        **documents,
    }
    destination = output / "candidate-derivation.json"
    save(destination, result)
    return {
        "file": destination.name,
        "bytes": destination.stat().st_size,
        "sha256": digest(destination),
    }


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
    parser.add_argument("--derivation-inputs", type=Path)
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
            "status": "pending-Personal-MXC",
            "reason": "Canonical Bash/browser/ConPTY still requires the current Hermes Personal-profile test; the older component failure is retained separately.",
            "upstreamIssue": "https://github.com/microsoft/mxc/issues/1061",
        },
        "finalInstallPathAdaptationRequired": True,
        "movedRootExecutionRequired": True,
    }
    try:
        inventory = load_inventory()
        build = json.loads(args.build_receipt.read_text(encoding="utf-8"))
        inventory.validate_build_receipt(build)
        module_sha = validate_current_adaptation(
            runtime,
            json.loads(args.adaptation_receipt.read_text(encoding="utf-8")),
        )
        source_files = inventory.verify_official_source(runtime, args.source_archive)
        payload = inventory.inventory(runtime)
        if args.derivation_inputs:
            result["derivation"] = validate_reuse(
                runtime,
                json.loads(args.derivation_inputs.read_text(encoding="utf-8")),
                output,
                inventory,
                payload=payload,
            )
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
