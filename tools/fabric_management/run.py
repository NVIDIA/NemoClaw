# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Qualify a local image in an owned, network-disabled disposable container."""

import argparse
import subprocess
import uuid
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True, help="Explicit locally built image")
    parser.add_argument("--config", type=Path, required=True, help="Native Fabric JSON fixture")
    args = parser.parse_args()
    source = Path(__file__).resolve().parent
    fixture = args.config.resolve(strict=True)
    image = subprocess.check_output(
        ["docker", "image", "inspect", args.image, "--format", "{{.Id}}"], text=True
    ).strip()
    name = "nc-fabric-management-" + str(uuid.uuid4())
    print(f"Testing {image} with {fixture.name}", flush=True)
    try:
        subprocess.run(
            [
                "docker",
                "run",
                "--rm",
                "--name",
                name,
                "--runtime=runc",
                "--network",
                "none",
                "-v",
                f"{source}:/experiment:ro",
                "-v",
                f"{fixture}:/fixture.json:ro",
                "--entrypoint",
                "/opt/fabric/bin/python",
                image,
                "-B",
                "/experiment/qualify.py",
                "/fixture.json",
            ],
            check=True,
            timeout=180,
        )
    finally:
        # The random name belongs to this call; remove it if docker run was interrupted.
        subprocess.run(
            ["docker", "rm", "-f", name],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )


if __name__ == "__main__":
    main()
