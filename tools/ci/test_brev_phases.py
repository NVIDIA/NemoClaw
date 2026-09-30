# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class BrevPhases(unittest.TestCase):
    def phase(
        self, name, ssh_failures=0, refresh_fails=False,
        lifecycle_fails=False, startup_fails=False,
    ):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            executable = root / "command"
            executable.write_text("""#!/usr/bin/env python3
import json, os, pathlib, sys
name = pathlib.Path(sys.argv[0]).name
with open(os.environ["CALLS"], "a") as output:
    output.write(json.dumps([name, *sys.argv[1:]]) + "\\n")
if name == "git" and sys.argv[1] == "rev-parse":
    print("a" * 40)
if name == "ssh" and sys.argv[-1] == "bash -s":
    with open(os.environ["CALLS"], "a") as output:
        output.write(json.dumps(["startup-input", sys.stdin.read()]) + "\\n")
    if os.environ["STARTUP_FAILS"] == "1":
        sys.exit(42)
if name == "ssh" and 'printf %s "$HOME"' in sys.argv:
    counter = pathlib.Path(os.environ["CALLS"] + ".attempts")
    attempts = int(counter.read_text()) if counter.exists() else 0
    counter.write_text(str(attempts + 1))
    if attempts < int(os.environ["SSH_FAILURES"]):
        print("kex_exchange_identification: Connection closed by remote host", file=sys.stderr)
        sys.exit(255)
    print("/home/fixture")
if name == "brev":
    print("refreshing brev...")
    if os.environ["REFRESH_FAILS"] == "1":
        sys.exit(1)
if name == "ssh" and " qualify" in sys.argv[-1] and os.environ["LIFECYCLE_FAILS"] == "1":
    sys.exit(255)
""")
            executable.chmod(0o755)
            for command in ("brev", "ssh", "rsync", "sleep", "git"):
                (root / command).symlink_to(executable)
            env = {
                **os.environ,
                "PATH": f"{root}:{os.environ['PATH']}",
                "RUNNER_TEMP": str(root),
                "CALLS": str(root / "calls"),
                "INSTANCE_NAME": "nclaw-v1-123-1",
                "SSH_FAILURES": str(ssh_failures),
                "STARTUP_FAILS": str(int(startup_fails)),
                "REFRESH_FAILS": str(int(refresh_fails)),
                "LIFECYCLE_FAILS": str(int(lifecycle_fails)),
            }
            env.pop("NVIDIA_INFERENCE_API_KEY", None)
            if name == "qualify":
                env["NVIDIA_INFERENCE_API_KEY"] = "fixture-only"
            result = subprocess.run(
                ["bash", str(ROOT / "tools/e2e/brev-v1-host.sh"), name],
                env=env,
                cwd=ROOT,
                capture_output=True,
                text=True,
                check=False,
                timeout=15,
            )
            calls = (
                [json.loads(line) for line in (root / "calls").read_text().splitlines()]
                if (root / "calls").exists()
                else []
            )
            return result, calls

    def test_prepare_runs_startup_over_ssh_before_transferring_candidate(self):
        result, calls = self.phase("prepare")
        self.assertEqual(result.returncode, 0, result.stderr)
        create = next(c for c in calls if c[:2] == ["brev", "create"])
        self.assertNotIn("--startup-script", create)
        startup = [c for c in calls if c[0] == "startup-input"]
        self.assertEqual(
            startup,
            [["startup-input", (ROOT / "tools/e2e/brev-v1-startup.sh").read_text()]],
        )
        self.assertLess(
            calls.index(startup[0]),
            next(i for i, c in enumerate(calls) if c[0] == "rsync"),
        )

    def test_startup_failure_stops_preparation_without_replaying_it(self):
        result, calls = self.phase("prepare", startup_fails=True)
        self.assertEqual(result.returncode, 42, result.stderr)
        self.assertEqual(sum(c[0] == "startup-input" for c in calls), 1)
        self.assertFalse(any(c[0] == "rsync" for c in calls))

    def test_transient_ssh_failure_refreshes_and_retries_the_read(self):
        for phase in ("load-image", "qualify"):
            with self.subTest(phase=phase):
                result, calls = self.phase(phase, ssh_failures=2)
                self.assertEqual(result.returncode, 0, result.stderr)
                probes = [
                    c for c in calls if c[0] == "ssh" and 'printf %s "$HOME"' in c
                ]
                self.assertEqual(len(probes), 3)
                self.assertTrue(
                    all("ConnectTimeout=10" in c and "BatchMode=yes" in c for c in probes)
                )
                self.assertGreaterEqual(calls.count(["brev", "refresh"]), 3)
                self.assertEqual(
                    sum(c[0] == "ssh" and phase in c[-1] for c in calls), 1
                )

    def test_refresh_failure_does_not_skip_a_working_ssh_probe(self):
        result, _ = self.phase("load-image", refresh_fails=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_ssh_retry_exhaustion_prevents_transfer_and_execution(self):
        result, calls = self.phase("load-image", ssh_failures=100)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(sum(c[0] == "ssh" for c in calls), 6)
        self.assertFalse(any(c[0] == "rsync" for c in calls))
        self.assertIn("Brev SSH home read failed after 6 attempts", result.stderr)

    def test_lifecycle_failure_is_not_replayed(self):
        result, calls = self.phase("qualify", lifecycle_fails=True)
        self.assertEqual(result.returncode, 255, result.stderr)
        self.assertEqual(sum(c[0] == "ssh" and " qualify" in c[-1] for c in calls), 1)

    def test_image_loading_needs_neither_bundle_nor_inference_credential(self):
        result, calls = self.phase("load-image")
        self.assertEqual(result.returncode, 0, result.stderr)
        transfers = [call for call in calls if call[0] == "rsync"]
        self.assertEqual(len(transfers), 1)
        self.assertIn("candidate-image/", transfers[0])
        self.assertEqual(
            transfers[0][-1],
            "nclaw-v1-123-1:/home/fixture/nclaw-v1-123-1/image-candidate/",
        )
        self.assertTrue(
            any(call[0] == "ssh" and "load-image" in call[-1] for call in calls)
        )

    def test_qualification_does_not_transfer_the_image_again(self):
        result, calls = self.phase("qualify")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(any("candidate-image/" in call for call in calls))
        self.assertTrue(any("candidate/bundle/" in call for call in calls))


if __name__ == "__main__":
    unittest.main()
