# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Run the same command contract against explicitly selected local images."""

import argparse
import json
import subprocess
import uuid
from pathlib import Path


def qualify(image):
    metadata = json.loads(subprocess.check_output(["docker", "image", "inspect", image]))[0]
    labels = metadata["Config"].get("Labels") or {}
    bridge = labels["io.nemoclaw.fabric.bridge"]
    name = "nemoclaw-contract-" + uuid.uuid4().hex
    try:
        subprocess.run(
            [
                "docker",
                "run",
                "--name",
                name,
                "--rm",
                "--runtime=runc",
                "--network=none",
                "--read-only",
                "--tmpfs",
                "/sandbox:rw,uid=1000,gid=1000,mode=0700",
                "--tmpfs",
                "/tmp:rw,mode=1777",
                "-e",
                "NEMOCLAW_TEST_BRIDGE=" + bridge,
                "-e",
                "NEMOCLAW_TEST_REFERENCE=" + labels.get("io.nemoclaw.fabric.reference", ""),
                "--mount",
                f"type=bind,src={Path(__file__).with_name('test_agent_contract.py').resolve()},dst=/test.py,readonly",
                "--entrypoint",
                "/opt/fabric/bin/python",
                metadata["Id"],
                "-B",
                "/test.py",
            ],
            check=True,
            timeout=180,
        )
    finally:
        # Only this invocation's container can be removed, including after timeout.
        subprocess.run(
            ["docker", "rm", "--force", name],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("images", nargs="+")
    for image in parser.parse_args().images:
        print(f"Qualifying {image}", flush=True)
        qualify(image)
