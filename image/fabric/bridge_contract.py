# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Capabilities shared by the bridge and image catalog."""

INTERFACE_VERSION = 1
OPERATIONS = ("validate", "prepare", "configure", "check", "invoke", "serve")
REQUEST_LIMIT = 512 * 1024
RESULT_LIMIT = 4 * 1024 * 1024
SHUTDOWN_SECONDS = 4  # OpenShell allows five seconds before forced termination.


def capabilities(health_checks):
    """Advertise only cumulative native checks supplied by the installed backend."""
    levels = tuple(health_checks)
    if levels != ("live", "active", "ready")[: len(levels)]:
        raise ValueError("health checks must be a cumulative prefix")
    return {
        "interface_version": INTERFACE_VERSION,
        "operations": list(OPERATIONS),
        "health_checks": list(levels),
    }


if __name__ == "__main__":
    import json

    from backend import HEALTH_CHECKS

    print(json.dumps(capabilities(HEALTH_CHECKS), sort_keys=True))
