# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Resolve image-owned launch and executable metadata in the installed image."""

import json
import os
import shutil
from pathlib import Path


def absolute(path):
    return (
        isinstance(path, str)
        and path.startswith("/")
        and ".." not in path.split("/")
        and "\0" not in path
    )


def read_runtime(path, adapters, *, required=False):
    if not path.exists():
        if required:
            raise ValueError("installed image requires a runtime manifest")
        return None
    runtime = json.loads(path.read_text())
    if (
        not isinstance(runtime, dict)
        or set(runtime) != {"schema_version", "command", "environment", "required_paths", "policy"}
        or type(runtime["schema_version"]) is not int
        or runtime["schema_version"] != 1
    ):
        raise ValueError("unsupported runtime manifest")
    command = runtime["command"]
    if (
        not isinstance(command, list)
        or not command
        or not all(isinstance(part, str) and part and "\0" not in part for part in command)
        or not absolute(command[0])
        or not Path(command[0]).is_file()
        or not os.access(command[0], os.X_OK)
    ):
        raise ValueError("runtime command requires an installed executable")
    environment = runtime["environment"]
    if (
        not isinstance(environment, dict)
        or not all(
            isinstance(key, str)
            and key
            and "=" not in key
            and "\0" not in key
            and isinstance(value, str)
            and "\0" not in value
            for key, value in environment.items()
        )
        or any(key in environment for key in ("NEMOCLAW_AGENT_NAME", "NEMOCLAW_PROVIDER_NAMES"))
    ):
        raise ValueError("invalid runtime environment")
    required_paths = runtime["required_paths"]
    if (
        not isinstance(required_paths, list)
        or not required_paths
        or not all(absolute(value) and Path(value).exists() for value in required_paths)
    ):
        raise ValueError("runtime required paths must exist in the image")
    runtime["binaries"] = {}
    # The Python host executes Python adapters in-process. Include its actual
    # interpreter as well as each descriptor's additional executable requirements.
    interpreter = environment.get("ADAPTER_PYTHON")
    if (
        not absolute(interpreter)
        or not Path(interpreter).is_file()
        or not os.access(interpreter, os.X_OK)
    ):
        raise ValueError("runtime ADAPTER_PYTHON requires an installed interpreter")
    for record in adapters:
        descriptor = record["descriptor"]
        binaries = {str(Path(interpreter).resolve(strict=True))}
        for binary in descriptor.get("requirements", {}).get("binaries", []):
            executable = shutil.which(binary, path=environment.get("PATH", ""))
            if executable is None:
                raise ValueError(
                    f"missing required executable {binary!r} for {descriptor['adapter_id']}"
                )
            binaries.add(str(Path(executable).resolve(strict=True)))
        runtime["binaries"][descriptor["adapter_id"]] = sorted(binaries)
    return runtime
