# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Read only two exact host binaries from a pinned prior MSI in disposable CI."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess

MSI_BYTES = 259973780
MSI_SHA256 = "2eadf86ba80fbfbb0b84803c32835fcfff0a33a19e2629ead346610db8fb6a8c"
MSI_URL = "https://media.githubusercontent.com/media/NVIDIA/NemoClaw/8856ce6f0263ca55427924e64605b700a7bed6b5/NemoClaw-0.1.0-windows-arm64.msi"
CAB_BYTES = 47883590
CAB_SHA256 = "af94ab7824a485a53067a528861319e0cfd3114c9e20d435f3135ae7ec906f8e"
PATCH_SHA256 = "9229f70e50ed0d654ce3d06ef6964facefdd651d634921d49db9aa7fd7258937"
FILES = {
    "openshell.exe": (
        "Fil_82fa72e8688fce16aa07c295ac7c24ba",
        22062080,
        "09e9b07a10c5ee181b4a1827e4fb4510b1eb72714c7d0d76dd79d8001e26eeda",
    ),
    "openshell-gateway.exe": (
        "Fil_70d7c6844051c174553ea092f337a16c",
        67402240,
        "d51599b47ce66d99fb8652e918f1f4d28f6417e87aa439f75edd90fcdfe5684b",
    ),
}
ORIGINAL_BUILD_STEPS = {
    "Check out the pinned OpenShell Windows candidate": "1c5e085f1fe876559fab901bbf1962059c139c62a420eba34c82b02d7e861009",
    "Set up pinned Rust for the OpenShell ARM64 build": "f5af6bb8e896590df78e5ba6b2d023f860404507f24b2e033fd6008b8674e4c4",
    "Build the pinned NVIDIA/OpenShell#2721 candidate": "1bade8e2e628d748897bf3cdebc5602f39d1e577af3fbf448f994dc61ed53843",
    "Build the pinned Node compatibility derivative": "36a87c38d899b40658ed0d72f03efd363d39ba1a3f4b31627d126bd5cd7b61a4",
}


def digest(file):
    with file.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def ordinary(file):
    info = file.lstat()
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_nlink != 1
        or getattr(info, "st_file_attributes", 0) & 0x400
    ):
        raise ValueError("The selected input is not an ordinary single-link file")


def verify(file, size, expected):
    ordinary(file)
    if file.stat().st_size != size or digest(file) != expected:
        raise ValueError("A reused package or binary differs from its pinned bytes")


def verify_source(root):
    patch = root / "packaging/windows/openshell-2721-node-ui.patch"
    ordinary(patch)
    if digest(patch) != PATCH_SHA256:
        raise ValueError(
            "The current OpenShell derivative patch differs from the reused build"
        )
    # The finished installer deliberately retires the legacy expanded-build job.
    # Its old step hashes remain provenance; current reuse authority is this
    # explicit pinned component selection and the unchanged derivative patch.
    return {
        "openshellRevision": "bcd517bbe08cc80860c9be57699390cd32e8445f",
        "rustToolchain": "1.95.0",
        "rustTarget": "aarch64-pc-windows-msvc",
        "derivativePatchSha256": PATCH_SHA256,
    }


def extract_member(tool, archive, member, output, stderr):
    # -so writes only the named member to this exclusive file. MSI actions are
    # never invoked; neither the MSI nor either extracted executable is run.
    with output.open("xb") as data, stderr.open("xb") as errors:
        subprocess.run(
            [str(tool), "e", "-so", str(archive), member],
            stdin=subprocess.DEVNULL,
            stdout=data,
            stderr=errors,
            timeout=90,
            check=True,
        )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["msi", "seven-zip", "source-root", "output", "scratch"]:
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--source-revision", required=True)
    parser.add_argument("--portable-proof", action="store_true")
    args = parser.parse_args()
    if not args.portable_proof and (
        os.name != "nt" or os.environ.get("GITHUB_ACTIONS") != "true"
    ):
        raise ValueError("Selected MSI extraction is a disposable Windows CI operation")
    if not re.fullmatch(r"[a-f0-9]{40}", args.source_revision):
        raise ValueError("The current source revision must be explicit")
    if any(file.exists() or file.is_symlink() for file in [args.output, args.scratch]):
        raise ValueError("Extraction output and compressed scratch must both be fresh")
    if args.output.resolve().is_relative_to(
        args.scratch.resolve()
    ) or args.scratch.resolve().is_relative_to(args.output.resolve()):
        raise ValueError(
            "Compressed scratch must be separate from selected binary output"
        )
    verify(args.msi, MSI_BYTES, MSI_SHA256)
    ordinary(args.seven_zip)
    source = verify_source(args.source_root)
    tool_identity = digest(args.seven_zip)
    args.output.mkdir(parents=True)
    args.scratch.mkdir(parents=True)
    cab = args.scratch / "cab1.cab"
    extract_member(
        args.seven_zip, args.msi, "cab1.cab", cab, args.scratch / "cabinet.stderr.log"
    )
    verify(cab, CAB_BYTES, CAB_SHA256)
    files = []
    for name, (member, size, expected) in FILES.items():
        target = args.output / name
        extract_member(
            args.seven_zip, cab, member, target, args.scratch / (name + ".stderr.log")
        )
        verify(target, size, expected)
        with target.open("rb") as stream:
            header = stream.read(4096)
        offset = int.from_bytes(header[60:64], "little")
        if (
            header[:2] != b"MZ"
            or offset < 64
            or offset > len(header) - 6
            or header[offset : offset + 6] != b"PE\0\0\x64\xaa"
        ):
            raise ValueError("The reused host executable is not Windows ARM64")
        files.append(
            {
                "file": name,
                "bytes": size,
                "sha256": expected,
                "msiFileId": member,
                "peMachine": "arm64",
            }
        )
    verify(args.msi, MSI_BYTES, MSI_SHA256)
    if (
        digest(args.seven_zip) != tool_identity
        or verify_source(args.source_root) != source
    ):
        raise ValueError(
            "A source or extraction tool changed during read-only extraction"
        )
    receipt = {
        "schemaVersion": 1,
        "classification": "ci-reused-openshell-host-binaries",
        "requestedSourceRevision": args.source_revision,
        "sourceRevision": "ed71ba30a6192544d48e373b5a73816ce2ab89b5",
        "sourceWorkflowRun": 34471812081,
        "sourceRunAttempt": 1,
        "sourceArtifactId": 10153321775,
        "sourceMsi": {"url": MSI_URL, "bytes": MSI_BYTES, "sha256": MSI_SHA256},
        "packageManifestSha256": "18ccf6ffebdf3e7af6ff9c0aaab3168b18efc879892f516114355507b20a0f07",
        "openshellRevision": "bcd517bbe08cc80860c9be57699390cd32e8445f",
        "derivativePatchSha256": PATCH_SHA256,
        "currentPinnedSourceAuthority": source,
        "originalBuildSteps": [
            {"name": name, "sha256": value}
            for name, value in ORIGINAL_BUILD_STEPS.items()
        ],
        "license": {
            "url": "https://raw.githubusercontent.com/NVIDIA/OpenShell/bcd517bbe08cc80860c9be57699390cd32e8445f/LICENSE",
            "bytes": 10788,
            "sha256": "b967d1c87b93b7d61ebcf4f8737e6ad79e5433e743e49dff395a36fb3c327047",
        },
        "cabinet": {"name": "cab1.cab", "bytes": CAB_BYTES, "sha256": CAB_SHA256},
        "archiveToolSha256": tool_identity,
        "files": files,
        "extraction": "selected MSI stream and two exact cabinet members; no MSI actions or administrative installation",
        "portableProof": args.portable_proof,
        "binariesExecuted": False,
        "oldPackageInstalledAcceptance": "failed",
        "currentPackageQualification": False,
    }
    with (args.output / "openshell-reuse.json").open("x", encoding="utf-8") as stream:
        json.dump(receipt, stream, indent=2)
        stream.write("\n")
    print(
        json.dumps(
            {
                "files": 2,
                "bytes": sum(item[1] for item in FILES.values()),
                "currentPackageQualification": False,
            }
        )
    )


if __name__ == "__main__":
    main()
