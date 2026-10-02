# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Run the same command contract against explicitly selected local images."""

import argparse
import json
import subprocess
import uuid
from pathlib import Path


def qualify(image, *, lifecycle=None, require_ready=False):
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
                "-e",
                "NEMOCLAW_TEST_LIFECYCLE=" + (lifecycle or ""),
                "-e",
                "NEMOCLAW_TEST_REQUIRE_READY=" + ("1" if require_ready else "0"),
                "-e",
                "FABRIC_NATIVE_TEST_KEY=fabric-native-key",
                "-e",
                "HOME=/sandbox",
                "--workdir",
                "/sandbox",
                "--mount",
                f"type=bind,src={Path(__file__).with_name('test_agent_contract.py').resolve()},dst=/test.py,readonly",
                "--mount",
                f"type=bind,src={Path(__file__).with_name('qualify_native.py').resolve()},dst=/qualify_native.py,readonly",
                "--entrypoint",
                "/opt/fabric/bin/python",
                metadata["Id"],
                "-B",
                "/test.py",
                "-v",
            ],
            check=True,
            timeout=480,
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
    parser.add_argument(
        "--lifecycle",
        choices=("dummy", "openclaw", "hermes", "pi"),
        help="run shared lifecycle assertions with this adapter's offline configuration",
    )
    parser.add_argument(
        "--require-ready",
        action="store_true",
        help="fail when native readiness is unsupported instead of reporting it as skipped",
    )
    args = parser.parse_args()
    if args.require_ready and not args.lifecycle:
        parser.error("--require-ready requires an explicit --lifecycle profile")
    for image in args.images:
        print(f"Qualifying {image}", flush=True)
        qualify(image, lifecycle=args.lifecycle, require_ready=args.require_ready)
