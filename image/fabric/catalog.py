# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Publish what an agent image provides for Fabric.

The catalog pairs the adapters the image build installed with their descriptors
from Fabric's own adapter catalog package. Each harness stage declares its
adapters, their files, and their executables in /opt/nemoclaw/adapters.json;
Fabric's package supplies the descriptors, unmodified. An adapter Fabric's
package does not publish, such as NemoClaw's test-only adapter, declares the
descriptor file its package installed. Run with the interpreter
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
    """Return the adapters a harness stage declared: their files, executables, and
    the paths their harness writes beyond the image's default policy."""
    if not path.exists():
        raise ValueError(f"{path} must declare the image's adapters")
    declared = json.loads(path.read_text())
    if not isinstance(declared, dict) or not declared:
        raise ValueError(f"{path} must declare at least one adapter")
    for adapter_id, entry in declared.items():
        if (
            not adapter_id
            or not isinstance(entry, dict)
            or not {"files", "binaries"}
            <= set(entry)
            <= {"files", "binaries", "descriptor", "read_write"}
        ):
            raise ValueError(f"{path} must give {adapter_id!r} its files and binaries")
        descriptor = entry.get("descriptor")
        if descriptor is not None and not (
            isinstance(descriptor, str)
            and descriptor.startswith("/")
            and ".." not in descriptor.split("/")
        ):
            raise ValueError(f"{path} must give {adapter_id!r} an absolute descriptor path")
        files, binaries = entry["files"], entry["binaries"]
        for paths in (files, entry.get("read_write", [])):
            if not isinstance(paths, list) or not all(
                isinstance(file, str) and file.startswith("/") and ".." not in file.split("/")
                for file in paths
            ):
                raise ValueError(f"{path} must list absolute paths for {adapter_id}")
        if not isinstance(binaries, list) or not all(
            isinstance(binary, str) and binary and "/" not in binary for binary in binaries
        ):
            raise ValueError(f"{path} must list executable names for {adapter_id}")
    return declared


def record(adapter_id, descriptor_path=None):
    """Return an adapter's descriptor: Fabric's, or the file its package installed."""
    if descriptor_path is None:
        return {"descriptor": get_adapter_descriptor(adapter_id), "provenance": PROVENANCE}
    descriptor = json.loads(Path(descriptor_path).read_text())
    if descriptor.get("adapter_id") != adapter_id:
        raise ValueError(f"{descriptor_path} does not describe {adapter_id}")
    return {
        "descriptor": descriptor,
        "provenance": [{"source": "explicit_local", "path": descriptor_path}],
    }


def records(adapters):
    """Return each adapter's descriptor, in ID order.

    adapters maps adapter IDs to their declarations, or is a list of IDs whose
    descriptors all come from Fabric's catalog.
    """
    declared = (
        adapters if isinstance(adapters, dict) else {adapter_id: {} for adapter_id in adapters}
    )
    return [
        record(adapter_id, declared[adapter_id].get("descriptor"))
        for adapter_id in sorted(declared)
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
    """Return an image's catalog: its declared adapters and runtime."""
    # Imported here so the bundled snapshot needs only Fabric's catalog package.
    from runtime_metadata import read_runtime

    declared = read_adapters(adapters)
    catalog = snapshot(revision, source_sha256, declared)
    catalog["runtime"] = read_runtime(
        runtime_manifest,
        {adapter_id: entry["binaries"] for adapter_id, entry in declared.items()},
        required=True,
    )
    # A harness that writes outside the defaults, such as Hermes's browser chat
    # opening pseudo-terminals, extends only its own image's default policy.
    for entry in declared.values():
        for path in entry.get("read_write", []):
            filesystem = catalog["runtime"]["policy"].setdefault("filesystem_policy", {})
            writable = filesystem.setdefault("read_write", [])
            if path not in writable:
                writable.append(path)
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
    parser.add_argument(
        "--adapter", action="append", default=[], help="bundled snapshot: an adapter ID to include"
    )
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
        installed(
            args.revision,
            args.source_sha256,
            adapters=args.adapters,
            runtime_manifest=args.runtime_manifest,
        )
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
