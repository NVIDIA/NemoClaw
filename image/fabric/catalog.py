# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Publish a version-bound snapshot of Fabric's public discovery result.

Run with the Fabric interpreter/environment whose adapters are being packaged.
The image build checks its label against discovery in the installed environment.
"""

import argparse
import json
from pathlib import Path

from bridge_contract import HEALTH_CHECKS, INTERFACE_VERSION, OPERATIONS
from nemo_fabric import DiscoveryConfig, Fabric
from runtime_metadata import read_runtime

# Harness image stages write the directories their layout places each adapter's
# runtime in, so deployment planning can check explicit filesystem grants.
RUNTIME_FILES = Path("/opt/nemoclaw/runtime-files.json")
RUNTIME_MANIFEST = Path("/opt/nemoclaw/runtime.json")


def read_runtime_files(path, adapters):
    """Return image-owned read paths, keyed by an adapter in this catalog."""
    if not path.exists():
        return {}
    declared = json.loads(path.read_text())
    cataloged = {record["descriptor"]["adapter_id"] for record in adapters}
    for adapter_id, files in declared.items():
        if adapter_id not in cataloged:
            raise ValueError(f"{path} names {adapter_id}, which this catalog does not list")
        if (
            not isinstance(files, list)
            or not files
            or not all(
                isinstance(file, str) and file.startswith("/") and ".." not in file.split("/")
                for file in files
            )
        ):
            raise ValueError(f"{path} must list absolute paths for {adapter_id}")
    return declared


def snapshot(
    revision,
    source_sha256,
    *,
    discovery=None,
    installed_only=False,
    runtime_files=RUNTIME_FILES,
    runtime_manifest=RUNTIME_MANIFEST,
):
    fabric = Fabric()
    records = {
        "adapters": fabric.discover(discovery=discovery),
        "targets": fabric.discover_targets(discovery=discovery),
    }
    catalog = {
        "schema_version": 2,
        "fabric_revision": revision,
        "source_sha256": source_sha256,
        **{
            kind: [
                record.to_mapping()
                for record in items
                if not installed_only
                or any(source["source"] == "installed_package" for source in record.provenance)
            ]
            for kind, items in records.items()
        },
    }
    if installed_only:
        catalog["bridge"] = {
            "interface_version": INTERFACE_VERSION,
            "operations": list(OPERATIONS),
            "health_checks": list(HEALTH_CHECKS),
        }
    # Kept beside the descriptors so Fabric's records stay unedited.
    files = read_runtime_files(runtime_files, catalog["adapters"])
    if files:
        catalog["runtime_files"] = files
    runtime = read_runtime(runtime_manifest, catalog["adapters"], required=installed_only)
    if runtime is not None:
        catalog["runtime"] = runtime
    return catalog


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--revision")
    parser.add_argument("--source-sha256")
    parser.add_argument("--provenance", type=Path)
    parser.add_argument("--installed", action="store_true")
    parser.add_argument("--runtime-manifest", type=Path, default=RUNTIME_MANIFEST)
    parser.add_argument("--descriptor", action="append", type=Path, default=[])
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
    discovery = DiscoveryConfig(local_paths=args.descriptor) if args.descriptor else None
    encoded = (
        json.dumps(
            snapshot(
                args.revision,
                args.source_sha256,
                discovery=discovery,
                installed_only=args.installed,
                runtime_manifest=args.runtime_manifest,
            ),
            indent=2,
            sort_keys=True,
        )
        + "\n"
    )
    if args.output:
        args.output.write_text(encoded)
    else:
        print(encoded, end="")


if __name__ == "__main__":
    main()
