# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Build local agent images and label them with their installed Fabric metadata."""

import argparse
import json
import os
import subprocess
import tempfile
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--platform", required=True, choices=("linux/arm64", "linux/amd64"))
    parser.add_argument("targets", nargs="+")
    args = parser.parse_args()
    environment = {**os.environ, "AGENT_PLATFORM": args.platform}
    plan = json.loads(
        subprocess.check_output(
            ["docker", "buildx", "bake", "--print", *args.targets],
            cwd=ROOT,
            env=environment,
        )
    )
    for name, target in plan["target"].items():
        tags = target.get("tags", [])
        if not tags:
            parser.error(f"{name} is not a tagged agent image")
        temporary_tag = f"nemoclaw-build:{uuid.uuid4().hex}"
        try:
            subprocess.run(
                [
                    "docker",
                    "buildx",
                    "bake",
                    name,
                    "--load",
                    "--set",
                    f"{name}.tags={temporary_tag}",
                ],
                cwd=ROOT,
                env=environment,
                check=True,
            )
            # This temporary packaging process only reads metadata. It does not
            # start an adapter, contact a model, or attach deployment resources.
            raw = subprocess.check_output(
                [
                    "docker",
                    "run",
                    "--rm",
                    "--network=none",
                    "--read-only",
                    "--entrypoint",
                    "/opt/fabric/bin/python",
                    temporary_tag,
                    "/opt/nemoclaw/catalog.py",
                    "--installed",
                    "--provenance",
                    "/opt/nemoclaw/provenance.json",
                ],
                cwd=ROOT,
            )
            catalog = json.dumps(json.loads(raw), separators=(",", ":"))
            with tempfile.TemporaryDirectory(prefix="nemoclaw-image-label-") as directory:
                Path(directory, "Dockerfile").write_text(f"FROM {temporary_tag}\n")
                command = ["docker", "build", "--label", f"io.nemoclaw.fabric.catalog={catalog}"]
                for tag in tags:
                    command.extend(("--tag", tag))
                subprocess.run([*command, directory], check=True)
        finally:
            subprocess.run(
                ["docker", "image", "rm", temporary_tag], check=False, stdout=subprocess.DEVNULL
            )


if __name__ == "__main__":
    main()
