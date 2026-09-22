# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Run independent offline adapter fixtures with bounded concurrency."""

import argparse
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed


def run(commands, workers=4):
    def execute(command):
        started = time.monotonic()
        result = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            check=False,
        )
        return result, time.monotonic() - started

    failed = False
    with ThreadPoolExecutor(max_workers=workers) as pool:
        pending = [pool.submit(execute, command) for command in commands]
        for future in as_completed(pending):
            result, duration = future.result()
            print(f"::group::{' '.join(result.args)} ({duration:.1f}s)", flush=True)
            print(result.stdout, flush=True)
            print("::endgroup::", flush=True)
            failed |= result.returncode != 0
    return int(failed)


def commands(platform):
    base = [sys.executable, "tools/fabric-adapter-experiment.py"]
    if platform == "linux_amd64":
        return [[*base, "--harness", "deepagents"]]
    # Start the longest fixtures first; each owns its container and certificates.
    return [
        [
            *base,
            "--harness",
            "openclaw",
            "--interfaces",
            "--inference-api",
            "openai-responses",
        ],
        [
            *base,
            "--harness",
            "hermes",
            "--interfaces",
            "--inference-api",
            "openai-completions",
        ],
        [
            *base,
            "--harness",
            "hermes",
            "--hermes-relay",
            "--inference-api",
            "anthropic-messages",
        ],
        *[
            [*base, "--harness", harness]
            for harness in (
                "deepagents",
                "claude",
                "codex",
                "mini-swe-agent",
                "nooa",
                "nooa-bench",
                "remote-agent",
                "pi",
            )
        ],
    ]


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("platform", choices=["linux_arm64", "linux_amd64"])
    args = parser.parse_args()
    raise SystemExit(run(commands(args.platform)))
