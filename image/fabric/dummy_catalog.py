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
    provenance = json.loads((root / "provenance.json").read_text())
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
        "fabric_revision": provenance["fabric_revision"],
        "source_sha256": provenance["source_sha256"],
        "bridge": capabilities(HEALTH_CHECKS),
        "adapters": adapters,
        "targets": [],
        "runtime": read_runtime(root / "runtime.json", adapters, required=True),
    }


if __name__ == "__main__":
    print(json.dumps(snapshot(), indent=2, sort_keys=True))
