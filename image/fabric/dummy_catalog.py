# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Publish the reference dummy image's catalog without Fabric.

Production images record Fabric's discovery result. The dummy has no Fabric to
discover with, so it publishes its one explicit descriptor in the same catalog
form, letting deployments select it like any installed adapter.
"""

import json
from pathlib import Path

from backend import HEALTH_CHECKS
from bridge_contract import capabilities
from runtime_metadata import read_runtime

ROOT = Path("/opt/nemoclaw")


def snapshot(root=ROOT):
    # Not provenance.json: the host reports that file's revision as the Fabric
    # that validated a configuration, and Fabric validates nothing here.
    contract = json.loads((root / "contract.json").read_text())
    descriptor_path = root / "dummy.fabric-adapter.json"
    adapters = [
        {
            "descriptor": json.loads(descriptor_path.read_text()),
            "provenance": [
                {"source": "explicit_local", "path": str(descriptor_path), "root": str(root)}
            ],
        }
    ]
    return {
        "schema_version": 2,
        # The Fabric revision whose adapter contract the descriptor follows.
        "fabric_revision": contract["fabric_revision"],
        "source_sha256": contract["source_sha256"],
        "bridge": capabilities(HEALTH_CHECKS),
        "adapters": adapters,
        "targets": [],
        # The dummy runs no executables beyond the image's interpreter.
        "runtime": read_runtime(
            root / "runtime.json",
            {adapter["descriptor"]["adapter_id"]: [] for adapter in adapters},
            required=True,
        ),
    }


if __name__ == "__main__":
    print(json.dumps(snapshot(), indent=2, sort_keys=True))
