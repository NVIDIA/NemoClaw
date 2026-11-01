# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Record the selected launcher's build inputs without executing or authorizing it."""

import argparse
import importlib.util
import json
import os
import re
from pathlib import Path

from package_runtime import validate_launcher_capabilities


SPEC = importlib.util.spec_from_file_location(
    "compiled_materializer", Path(__file__).with_name("materialize-compiled-executable.py")
)
materializer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(materializer)
PREFIX = "packaging/windows/launcher/"
REQUIRED = {
    "Cargo.toml", "Cargo.lock", "src/main.rs", "src/state_session.rs", "src/runtime_lease.rs"
}


def snapshot(path, limit):
    before = materializer.inspect_path(path)
    materializer.require(0 < before.st_size <= limit, "Launcher evidence input exceeds its bound.")
    with path.open("rb") as stream:
        opened = os.fstat(stream.fileno())
        materializer.require(
            materializer.file_identity(before) == materializer.file_identity(opened),
            "Launcher evidence input changed before opening.",
        )
        data = stream.read(limit + 1)
        closed = os.fstat(stream.fileno())
    after = materializer.inspect_path(path)
    materializer.require(
        materializer.file_identity(before) == materializer.file_identity(closed)
        == materializer.file_identity(after)
        and len(data) == before.st_size,
        "Launcher evidence input changed during inspection.",
    )
    return data, {"bytes": len(data), "sha256": materializer.digest(data)}


def collect(source_root, package_root, revision, run_id, run_attempt):
    materializer.require(re.fullmatch(r"[a-f0-9]{40}", revision), "Invalid launcher source revision.")
    for value in (run_id, run_attempt):
        materializer.require(re.fullmatch(r"[1-9][0-9]*", value), "Invalid launcher run identity.")
    source_root, package_root = Path(source_root).absolute(), Path(package_root).absolute()
    retained = package_root / "build/compiled-native/NemoClaw.exe"
    packaged = package_root / "build/payload/bin/NemoClaw.exe"
    launcher, identity = snapshot(retained, materializer.MAX_BYTES)
    packaged_bytes, packaged_identity = snapshot(packaged, materializer.MAX_BYTES)
    materializer.require(launcher == packaged_bytes, "Retained launcher differs from package-selected bytes.")
    offset = int.from_bytes(launcher[60:64], "little")
    materializer.require(
        launcher[:2] == b"MZ"
        and 64 <= offset <= min(len(launcher) - 26, 4096)
        and launcher[offset:offset + 4] == b"PE\0\0"
        and int.from_bytes(launcher[offset + 4:offset + 6], "little") == 0xAA64
        and int.from_bytes(launcher[offset + 20:offset + 22], "little") >= 2
        and int.from_bytes(launcher[offset + 22:offset + 24], "little") & 0x2002 == 0x2
        and int.from_bytes(launcher[offset + 24:offset + 26], "little") == 0x20B,
        "Retained launcher is not an ARM64 PE32+ executable.",
    )
    copy_data, copy_identity = snapshot(package_root / "compiled-launcher.json", 65536)
    copied = json.loads(copy_data)
    materializer.require(
        type(copied.get("schemaVersion")) is int and copied["schemaVersion"] == 1
        and copied.get("classification") == "ci-native-compiled-artifact"
        and copied.get("status") == "materialized"
        and copied.get("runtimeLaunchCopy") is False
        and copied.get("outputSha256") == identity["sha256"]
        and copied.get("sourceSha256Before") == identity["sha256"]
        and copied.get("sourceSha256After") == identity["sha256"]
        and copied.get("outputStat", {}).get("bytes") == identity["bytes"]
        and copied.get("outputStat", {}).get("links") == 1
        and materializer.inspect_path(retained).st_nlink == 1,
        "Retained launcher differs from compiled materialization evidence.",
    )
    capability_data, capability_identity = snapshot(
        package_root / "build/launcher-capabilities.json", 4096
    )
    commands = validate_launcher_capabilities(json.loads(capability_data), identity["sha256"])
    source_dir = source_root / PREFIX
    materializer.inspect_path(source_dir, directory=True)
    paths = {source_dir / name for name in REQUIRED}
    # Cargo can also compile build.rs and nested Rust modules. Bind them all.
    for path in source_dir.rglob("*"):
        materializer.inspect_path(path, directory=path.is_dir())
        relative = path.relative_to(source_dir)
        if path.is_dir():
            materializer.require(
                relative.parts[0] not in {"target", "bin", "obj"},
                "Launcher build inputs contain generated output.",
            )
        elif path.suffix == ".rs" or relative.as_posix().startswith(".cargo/"):
            paths.add(path)
    materializer.require(len(paths) <= 512, "Launcher source inventory exceeds its bound.")
    sources = []
    for path in sorted(paths):
        _, row = snapshot(path, 16 * 1024 * 1024)
        sources.append({"file": path.relative_to(source_root).as_posix(), **row})
    return {
        "schemaVersion": 1,
        "classification": "package-selected-launcher-build-inputs",
        "sourceRevision": revision,
        "workflowRunId": run_id,
        "workflowRunAttempt": run_attempt,
        "target": "aarch64-pc-windows-msvc",
        "rustToolchain": "1.95.0-aarch64-pc-windows-msvc",
        "features": ["immutable-runtime"],
        "lockedDependencies": True,
        "staticCrt": True,
        "retainedLauncher": {"file": "build/compiled-native/NemoClaw.exe", **identity},
        "packagedLauncher": {"file": "build/payload/bin/NemoClaw.exe", **packaged_identity},
        "materialization": {"file": "compiled-launcher.json", **copy_identity},
        "capabilityObservation": {
            "file": "build/launcher-capabilities.json", **capability_identity,
            "advertisedCommands": commands,
        },
        "sources": sources,
        "commandSupportValidated": False,
        "invocationAdmitted": False,
        "installedAcceptance": False,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("source-root", "package-root", "source-revision", "run-id", "run-attempt", "output"):
        parser.add_argument("--" + name, required=True)
    args = parser.parse_args()
    output = Path(args.output).absolute()
    materializer.fresh(output)
    record = collect(args.source_root, args.package_root, args.source_revision, args.run_id, args.run_attempt)
    with output.open("x", encoding="utf-8") as stream:
        json.dump(record, stream, indent=2)
        stream.write("\n")


if __name__ == "__main__":
    main()
