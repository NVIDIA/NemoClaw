# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Materialize shared compiler/browser-observer tools without an agent payload."""

import argparse
import importlib.util
import json
import os
from pathlib import Path
import time


def prepare(output, cache, lock_file):
    if os.name != "nt" or os.environ.get("GITHUB_ACTIONS") != "true":
        raise ValueError("Shared runtime tools require Windows CI")
    if output.exists():
        raise ValueError("Shared build tools require a fresh directory")
    lock = json.loads(lock_file.read_text())
    if (
        lock.get("classification") != "shared-windows-runtime-build-tools"
        or lock.get("schemaVersion") != 1
    ):
        raise ValueError("Unexpected shared compiler lock")
    selected = [p for p in lock["packages"] if p["package"] != "@esbuild/darwin-arm64"]
    if {p["package"] for p in selected} != {
        "esbuild",
        "@esbuild/win32-arm64",
        "typescript",
        "playwright-core",
    } or len(selected) != 4:
        raise ValueError("Unexpected shared compiler dependency closure")
    source = Path(__file__).parents[1] / "app/materialize-openclaw-build.py"
    spec = importlib.util.spec_from_file_location("verified_package_inputs", source)
    materializer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(materializer)
    output.mkdir(parents=True)
    cache.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + 900
    packages = []
    for pin in selected:
        archive = materializer.fetch(pin, cache, deadline)
        destination = output / "tools/node_modules" / pin["package"]
        inventory = materializer.extract(archive["archive"], destination)
        metadata = json.loads((destination / "package.json").read_text())
        if metadata["name"] != pin["package"] or metadata["version"] != pin["version"]:
            raise ValueError("Shared compiler package differs from its pin")
        packages.append(
            {
                "package": pin["package"],
                "version": pin["version"],
                **archive,
                **inventory,
            }
        )
    (output / "materialization-receipt.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "classification": "verified-shared-runtime-build-inputs",
                "packages": packages,
                "agentPayloads": [],
                "lifecycleScriptsExecuted": False,
                "installedAcceptance": False,
            },
            indent=2,
        )
        + "\n"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument(
        "--lock",
        type=Path,
        default=Path(__file__).with_name("native-build-tools.lock.json"),
    )
    args = parser.parse_args()
    prepare(args.output, args.cache, args.lock)
