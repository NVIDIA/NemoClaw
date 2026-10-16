# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Publish what an agent image provides for Fabric.

The catalog pairs the adapters the image build installed with their descriptors
from Fabric's own adapter catalog package. Each harness stage declares its
adapters, their files, and their executables in /opt/nemoclaw/adapters.json;
Fabric's package supplies the descriptors, unmodified. Run with the interpreter
that has the matching nemo-fabric-adapter-catalog installed.
"""

import argparse
import json
from pathlib import Path

from nemo_fabric_adapter_catalog import get_adapter_descriptor

ADAPTERS = Path("/opt/nemoclaw/adapters.json")
RUNTIME_MANIFEST = Path("/opt/nemoclaw/runtime.json")
PROVENANCE = [{"source": "nemo-fabric-adapter-catalog"}]


def read_adapters(path):
    """Return the adapters a harness stage declared: their files and executables."""
    if not path.exists():
        raise ValueError(f"{path} must declare the image's adapters")
    declared = json.loads(path.read_text())
    if not isinstance(declared, dict) or not declared:
        raise ValueError(f"{path} must declare at least one adapter")
    for adapter_id, entry in declared.items():
        if not adapter_id or not isinstance(entry, dict) or set(entry) != {"files", "binaries"}:
            raise ValueError(f"{path} must give {adapter_id!r} its files and binaries")
        files, binaries = entry["files"], entry["binaries"]
        if not isinstance(files, list) or not all(
            isinstance(file, str) and file.startswith("/") and ".." not in file.split("/")
            for file in files
        ):
            raise ValueError(f"{path} must list absolute paths for {adapter_id}")
        if not isinstance(binaries, list) or not all(
            isinstance(binary, str) and binary and "/" not in binary for binary in binaries
        ):
            raise ValueError(f"{path} must list executable names for {adapter_id}")
    return declared


def records(adapter_ids):
    """Return each adapter's descriptor from Fabric's catalog, in ID order."""
    return [
        {"descriptor": get_adapter_descriptor(adapter_id), "provenance": PROVENANCE}
        for adapter_id in sorted(adapter_ids)
    ]


def snapshot(revision, source_sha256, adapter_ids):
    """Return the bundled catalog: the listed adapters' descriptors only."""
    return {
        "schema_version": 2,
        "fabric_revision": revision,
        "source_sha256": source_sha256,
        "adapters": records(adapter_ids),
        "targets": [],
    }


def installed(revision, source_sha256, *, adapters=ADAPTERS, runtime_manifest=RUNTIME_MANIFEST):
    """Return an image's catalog: its declared adapters, bridge, and runtime."""
    # Imported here so the bundled snapshot needs only Fabric's catalog package.
    from backend import HEALTH_CHECKS
    from bridge_contract import capabilities
    from runtime_metadata import read_runtime

    declared = read_adapters(adapters)
    catalog = snapshot(revision, source_sha256, declared)
    catalog["bridge"] = capabilities(HEALTH_CHECKS)
    catalog["runtime"] = read_runtime(
        runtime_manifest,
        {adapter_id: entry["binaries"] for adapter_id, entry in declared.items()},
        required=True,
    )
    files = {adapter_id: entry["files"] for adapter_id, entry in declared.items() if entry["files"]}
    if files:
        catalog["runtime_files"] = files
    return catalog


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--revision")
    parser.add_argument("--source-sha256")
    parser.add_argument("--provenance", type=Path)
    parser.add_argument("--installed", action="store_true")
    parser.add_argument("--adapter", action="append", default=[], help="bundled snapshot: an adapter ID to include")
    parser.add_argument("--adapters", type=Path, default=ADAPTERS)
    parser.add_argument("--runtime-manifest", type=Path, default=RUNTIME_MANIFEST)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.provenance:
        provenance = json.loads(args.provenance.read_text())
        args.revision, args.source_sha256 = (
            provenance["fabric_revision"],
            provenance["source_sha256"],
        )
    if not args.revision or not args.source_sha256:
        parser.error("provide --provenance or both --revision and --source-sha256")
    if args.installed == bool(args.adapter):
        parser.error("provide either --installed or at least one --adapter")
    catalog = (
        installed(args.revision, args.source_sha256, adapters=args.adapters, runtime_manifest=args.runtime_manifest)
        if args.installed
        else snapshot(args.revision, args.source_sha256, args.adapter)
    )
    encoded = json.dumps(catalog, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.write_text(encoded)
    else:
        print(encoded, end="")


if __name__ == "__main__":
    main()
