# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Publish a version-bound snapshot of Fabric's public discovery result.

Run with the Fabric interpreter/environment whose adapters are being packaged.
The image build checks its label against discovery in the installed environment.
"""

import argparse
import json
from pathlib import Path

from nemo_fabric import DiscoveryConfig, Fabric


def snapshot(revision, source_sha256, *, discovery=None, installed_only=False):
    fabric = Fabric()
    records = {
        "adapters": fabric.discover(discovery=discovery),
        "targets": fabric.discover_targets(discovery=discovery),
    }
    return {
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--revision")
    parser.add_argument("--source-sha256")
    parser.add_argument("--provenance", type=Path)
    parser.add_argument("--installed", action="store_true")
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
