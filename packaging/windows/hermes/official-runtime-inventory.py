# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Inventory a complete official source/venv tree after its real relocation gate."""

import argparse
import email.parser
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import tarfile
import tomllib


UPSTREAM_COMMIT = "2237be355906fbe6065ce1815711eee52b2d646e"
SOURCE_SHA256 = "c1f2401c8096e9372c46fa4ef8bdada18ed3cc84c0f5274562b86b7646ed3a87"
REQUIRED_STAGES = frozenset(
    [
        "node",
        "system-packages",
        "dependencies",
        "path",
        "config-templates",
        "platform-sdks",
    ]
)
REQUIRED_CHECKS = frozenset(
    [
        "python-base",
        "python-imports",
        "conpty",
        "bash-coreutils",
        "ripgrep",
        "browser-use",
        "browser-local-page",
        "dashboard",
        "tui",
    ]
)


def digest(path):
    with Path(path).open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def write_json(path, value):
    with Path(path).open("x", encoding="utf-8", newline="\n") as handle:
        json.dump(value, handle, indent=2, ensure_ascii=False)
        handle.write("\n")


def source_inputs(source):
    """Retain the full upstream graphs; platform selection remains the installer's."""
    source = Path(source)
    python = tomllib.loads((source / "uv.lock").read_text(encoding="utf-8"))
    npm = json.loads((source / "package-lock.json").read_text(encoding="utf-8"))
    artifacts = []
    for package in python["package"]:
        for artifact in package.get("wheels", []) + (
            [package["sdist"]] if "sdist" in package else []
        ):
            artifacts.append(
                {
                    "manager": "uv",
                    "name": package["name"],
                    "version": package["version"],
                    **artifact,
                }
            )
    for location, package in npm["packages"].items():
        if package.get("link") or not package.get("resolved"):
            continue
        if not package.get("integrity"):
            raise ValueError(f"Upstream npm artifact has no integrity: {location}")
        artifacts.append(
            {
                "manager": "npm",
                "location": location,
                "version": package["version"],
                "url": package["resolved"],
                "integrity": package["integrity"],
                "license": package.get("license"),
            }
        )
    return {
        "schemaVersion": 1,
        "upstreamCommit": UPSTREAM_COMMIT,
        "pythonLockSha256": digest(source / "uv.lock"),
        "npmLockSha256": digest(source / "package-lock.json"),
        "selection": "Complete upstream graphs; unmodified installer selects host-compatible packages",
        "artifacts": artifacts,
    }


def verify_official_source(runtime, archive):
    if digest(archive) != SOURCE_SHA256:
        raise ValueError(
            "The official source archive does not match its immutable identity"
        )
    source = Path(runtime) / "hermes-agent"
    count = 0
    with tarfile.open(archive, "r:gz") as handle:
        for member in handle:
            relative = Path(*Path(member.name).parts[1:])
            if relative.is_absolute() or ".." in relative.parts:
                raise ValueError("The source archive contains an unsafe path")
            target = source / relative
            if member.isfile():
                archived = handle.extractfile(member)
                if (
                    not target.is_file()
                    or target.is_symlink()
                    or digest(target)
                    != hashlib.file_digest(archived, "sha256").hexdigest()
                ):
                    raise ValueError(
                        f"Official source bytes were omitted or changed: {relative}"
                    )
                count += 1
            elif member.issym():
                if not target.is_symlink() or os.readlink(target) != member.linkname:
                    raise ValueError(f"Official source link changed: {relative}")
            elif not member.isdir():
                raise ValueError(f"Unsupported source archive entry: {relative}")
    return count


def validate_build_receipt(build):
    if (
        build.get("schemaVersion") != 1
        or build.get("upstreamCommit") != UPSTREAM_COMMIT
    ):
        raise ValueError("Unexpected official build receipt identity")
    if (
        build.get("status") != "runtime-provisioned"
        or build.get("installedTier") != "hash-verified (uv.lock)"
    ):
        raise ValueError(
            "The complete official runtime has not passed locked provisioning"
        )
    stages = build.get("stages", [])
    names = [stage.get("stage") for stage in stages]
    if len(names) != len(set(names)) or not REQUIRED_STAGES.issubset(names):
        raise ValueError("The complete official stage set is missing or ambiguous")
    if any(
        stage.get("ok") is not True or stage.get("skipped") is not False
        for stage in stages
    ):
        raise ValueError("An official stage failed or skipped a required capability")
    if build.get("fallbacks") != [] or build.get("sourceUnchanged") is not True:
        raise ValueError("Dependency fallback or source modification prevents freezing")
    node = build.get("nodeBuild", {})
    if (
        node.get("schemaVersion") != 1
        or node.get("profile") != "official-prebuilt-cli-web-tui"
        or node.get("npmVersion") != "12.0.2"
        or node.get("upstreamLockUnchanged") is not True
        or node.get("neighboringBuildDependenciesAbsent") is not True
        or node.get("tuiNonTtyImports") is not True
        or node.get("desktopSelected") is not False
        or {item.get("path") for item in node.get("outputs", [])}
        != {"ui-tui/dist", "hermes_cli/web_dist"}
        or {item.get("path") for item in node.get("sidecars", [])}
        != {"plugins/platforms/photon/sidecar", "scripts/whatsapp-bridge"}
    ):
        raise ValueError("The selected official production Node closure is incomplete")
    browser = build.get("selectedBrowserChain", {})
    if (
        browser.get("profile") != "official-prebuilt-cli-web-tui"
        or browser.get("browserUse") != "0.13.10"
        or browser.get("agentBrowser")
        != "agent-browser/bin/agent-browser-win32-x64.exe"
        or browser.get("runtimeQualified") is not False
    ):
        raise ValueError("The explicit official browser chain is incomplete")


def validate_receipts(runtime, build, relocation):
    runtime = Path(runtime).resolve(strict=True)
    validate_build_receipt(build)
    if (
        relocation.get("schemaVersion") != 1
        or relocation.get("upstreamCommit") != UPSTREAM_COMMIT
    ):
        raise ValueError("Unexpected relocation receipt identity")
    if (
        relocation.get("status") != "pass"
        or Path(relocation["targetRoot"]).resolve() != runtime
    ):
        raise ValueError("The relocated target has not passed validation")
    original = Path(relocation["sourceRoot"])
    if (
        original.exists()
        or original.resolve() == runtime
        or relocation.get("originalRootUnavailable") is not True
    ):
        raise ValueError(
            "The original runtime is still reachable; same-root checks cannot prove relocation"
        )
    checks = relocation.get("checks", [])
    check_names = [check.get("name") for check in checks]
    if len(check_names) != len(set(check_names)) or not REQUIRED_CHECKS.issubset(
        check_names
    ):
        raise ValueError("A relocated runtime capability check is missing or ambiguous")
    if any(check.get("passed") is not True for check in checks):
        raise ValueError("A relocated runtime capability failed")
    if (
        relocation.get("containedInMxc") is not True
        or relocation.get("cleanupPassed") is not True
    ):
        raise ValueError(
            "Actual MXC execution and owned cleanup are required before freeze"
        )


def inventory(runtime):
    runtime = Path(runtime).resolve(strict=True)
    files = []
    license_files = []
    distributions = []
    ordinary_directories = []
    for directory, directories, names in os.walk(runtime, followlinks=False):
        for name in list(directories):
            entry = Path(directory) / name
            if (
                entry.is_symlink()
                or getattr(entry.lstat(), "st_file_attributes", 0) & 0x400
            ):
                directories.remove(name)
                names.append(name)
            else:
                ordinary_directories.append(entry.relative_to(runtime).as_posix())
        for name in sorted(names):
            if len(files) >= 500000:
                raise ValueError("Complete runtime inventory exceeded its entry bound")
            entry = Path(directory) / name
            relative = entry.relative_to(runtime).as_posix()
            info = entry.lstat()
            if (
                stat.S_ISLNK(info.st_mode)
                or getattr(info, "st_file_attributes", 0) & 0x400
            ):
                if not entry.resolve(strict=True).is_relative_to(runtime):
                    raise ValueError(
                        f"Runtime link escapes the frozen tree: {relative}"
                    )
                tag = getattr(info, "st_reparse_tag", None)
                if tag is not None and tag not in (0xA0000003, 0xA000000C):
                    raise ValueError("Unsupported runtime reparse type")
                files.append(
                    {
                        "path": relative,
                        "linkTarget": os.path.relpath(
                            entry.resolve(strict=True), entry.parent
                        ).replace("\\", "/"),
                        "originalLinkTarget": os.readlink(entry),
                        "reparseTag": tag,
                    }
                )
                continue
            if not stat.S_ISREG(info.st_mode):
                raise ValueError(f"Runtime contains a non-regular file: {relative}")
            record = {"path": relative, "bytes": info.st_size, "sha256": digest(entry)}
            with entry.open("rb") as handle:
                header = handle.read(64)
                if len(header) == 64 and header[:2] == b"MZ":
                    offset = int.from_bytes(header[60:64], "little")
                    if offset + 6 <= info.st_size:
                        handle.seek(offset)
                        pe = handle.read(6)
                        if pe[:4] == b"PE\0\0":
                            record["peMachine"] = hex(int.from_bytes(pe[4:6], "little"))
            files.append(record)
            if (
                name.lower().startswith(("license", "copying", "copyright", "notice"))
                or name == "ABOUT"
            ):
                license_files.append(relative)
            if name == "METADATA" and entry.parent.name.endswith(".dist-info"):
                metadata = email.parser.Parser().parsestr(
                    entry.read_text(encoding="utf-8")
                )
                distributions.append(
                    {
                        "metadataPath": relative,
                        "name": metadata["Name"],
                        "version": metadata["Version"],
                        "licenseExpression": metadata["License-Expression"],
                        "license": metadata["License"],
                        "licenseFiles": metadata.get_all("License-File", []),
                    }
                )
    candidates = [
        record
        for record in files
        if record["path"].endswith((".d.ts", ".map", ".pdb"))
        and record["path"] not in license_files
    ]
    return {
        "schemaVersion": 1,
        "files": sorted(files, key=lambda item: item["path"]),
        "directories": sorted(ordinary_directories),
        "licenseFiles": sorted(license_files),
        "pythonDistributions": distributions,
        "diagnosticsCandidates": candidates,
        "diagnosticsRemovalValidated": False,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-root", required=True, type=Path)
    parser.add_argument("--source-archive", required=True, type=Path)
    parser.add_argument("--build-receipt", required=True, type=Path)
    parser.add_argument("--relocation-receipt", required=True, type=Path)
    parser.add_argument("--output-directory", required=True, type=Path)
    args = parser.parse_args()
    runtime = args.runtime_root.resolve(strict=True)
    output = args.output_directory.resolve()
    if output.is_relative_to(runtime) or output.exists():
        raise ValueError(
            "Freeze evidence must be a fresh directory outside the runtime"
        )
    build = json.loads(args.build_receipt.read_text(encoding="utf-8"))
    relocation = json.loads(args.relocation_receipt.read_text(encoding="utf-8"))
    validate_receipts(runtime, build, relocation)
    source_files = verify_official_source(runtime, args.source_archive)
    output.mkdir(parents=True)
    if os.name != "nt":
        raise ValueError(
            "The final official runtime marker requires the real Windows build"
        )
    environment = {
        name: os.environ[name]
        for name in [
            "SystemRoot",
            "SystemDrive",
            "WINDIR",
            "OS",
            "TEMP",
            "TMP",
            "USERPROFILE",
            "LOCALAPPDATA",
        ]
        if name in os.environ
    }
    powershell = (
        Path(environment["SystemRoot"])
        / "System32/WindowsPowerShell/v1.0/powershell.exe"
    )
    # The upstream completion marker is created only after all moved-root MXC
    # checks pass. It cannot turn an incomplete build into a completed runtime.
    with (
        (output / "bootstrap-marker.stdout.log").open("xb") as stdout,
        (output / "bootstrap-marker.stderr.log").open("xb") as stderr,
    ):
        subprocess.run(
            [
                str(powershell),
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(runtime / "hermes-agent/scripts/install.ps1"),
                "-Stage",
                "bootstrap-marker",
                "-NonInteractive",
                "-SkipSetup",
                "-SkipComputerUse",
                "-Commit",
                UPSTREAM_COMMIT,
                "-Branch",
                "v2026.9.7",
                "-HermesHome",
                str(runtime),
                "-InstallDir",
                str(runtime / "hermes-agent"),
                "-Json",
            ],
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=stdout,
            stderr=stderr,
            check=True,
            timeout=60,
        )
    marker = json.loads(
        (runtime / "hermes-agent/.hermes-bootstrap-complete").read_text(
            encoding="utf-8"
        )
    )
    if (
        marker.get("schemaVersion") != 1
        or marker.get("pinnedCommit") != UPSTREAM_COMMIT
    ):
        raise ValueError("The official completion marker has an unexpected identity")
    payload = inventory(runtime)
    write_json(output / "payload-inventory.json", payload)
    # Full canonical build evidence precedes the measured production partition.
    # Candidates stay in production until the owning runtime tests prove removal.
    write_json(
        output / "production-inventory.json",
        {
            "schemaVersion": 1,
            "partitionStatus": "canonical-unpruned",
            "files": payload["files"],
        },
    )
    write_json(
        output / "diagnostics-inventory.json",
        {
            "schemaVersion": 1,
            "files": [],
            "candidates": payload["diagnosticsCandidates"],
            "removalValidated": False,
        },
    )
    write_json(
        output / "upstream-locked-inputs.json", source_inputs(runtime / "hermes-agent")
    )
    write_json(
        output / "official-runtime-frozen.json",
        {
            "schemaVersion": 1,
            "classification": "official-hermes-runtime-build-freeze",
            "upstreamCommit": UPSTREAM_COMMIT,
            "sourceArchiveSha256": SOURCE_SHA256,
            "completeRuntime": True,
            "installedAcceptance": False,
            "sourceFilesVerified": source_files,
            "inventorySha256": digest(output / "payload-inventory.json"),
            "buildReceiptSha256": digest(args.build_receipt),
            "relocationReceiptSha256": digest(args.relocation_receipt),
            "fileCount": len(payload["files"]),
            "totalBytes": sum(item.get("bytes", 0) for item in payload["files"]),
            "tavilyLiveLookup": "not-tested-user-waiver",
            "status": "frozen",
        },
    )


if __name__ == "__main__":
    main()
