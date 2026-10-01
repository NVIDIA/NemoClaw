# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Exercise the bootstrap with fake privileged commands, without changing the host."""

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class BrevStartup(unittest.TestCase):
    def startup(self, held):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "held").write_text(str(held))
            command = root / "command"
            command.write_text('''#!/usr/bin/env python3
import json, os, pathlib, sys
root = pathlib.Path(os.environ["FIXTURE_ROOT"])
name = pathlib.Path(sys.argv[0]).name
privileged = os.environ.get("FIXTURE_ROOT_ACCESS") == "1"
with (root / "calls").open("a") as output:
    output.write(json.dumps([name, privileged, *sys.argv[1:]]) + "\\n")
if name == "id":
    print("1000" if sys.argv[1] == "-u" else "fixture")
elif name == "sudo":
    os.environ["FIXTURE_ROOT_ACCESS"] = "1"
    os.execvp(sys.argv[1], sys.argv[1:])
elif name == "fuser":
    if not privileged:
        sys.exit(1)
    held = int((root / "held").read_text())
    (root / "held").write_text(str(max(0, held - 1)))
    sys.exit(0 if held else 1)
elif name == "apt-get":
    if "install" in sys.argv and "DPkg::Lock::Timeout=180" not in sys.argv:
        print("E: Unable to acquire the dpkg frontend lock", file=sys.stderr)
        sys.exit(100)
''')
            command.chmod(0o755)
            for name in (
                "id", "sudo", "fuser", "apt-get", "docker", "systemctl",
                "usermod", "install", "sleep", "apt-cache",
            ):
                (root / name).symlink_to(command)
            script = (ROOT / "tools/e2e/brev-v1-startup.sh").read_text()
            script = script.replace("/tmp/nemoclaw-brev-v1-startup.log", str(root / "log"))
            script = script.replace("/var/run/nemoclaw-brev-v1-ready", str(root / "ready"))
            result = subprocess.run(
                ["bash", "-s"], input=script, capture_output=True, text=True,
                env={**os.environ, "PATH": f"{root}:{os.environ['PATH']}",
                     "FIXTURE_ROOT": str(root)}, timeout=20, check=False,
            )
            calls = [json.loads(line) for line in (root / "calls").read_text().splitlines()]
            return result, calls

    def test_nonroot_bootstrap_observes_root_locks_and_waits_atomically_for_install(self):
        result, calls = self.startup(2)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        probes = [c for c in calls if c[0] == "fuser"]
        self.assertTrue(probes and all(c[1] for c in probes))
        self.assertGreaterEqual(sum(c[0] == "sleep" for c in calls), 2)
        installs = [c for c in calls if c[0] == "apt-get" and "install" in c]
        self.assertTrue(installs)
        self.assertTrue(all("DPkg::Lock::Timeout=180" in c for c in installs))
        self.assertIn("bare Brev host prerequisites are ready", result.stdout)

    def test_persistent_lock_fails_before_installation_or_ready_marker(self):
        result, calls = self.startup(1000)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("apt locks remained busy for 180 seconds", result.stdout)
        self.assertFalse(any(c[0] in ("apt-get", "install") for c in calls))


if __name__ == "__main__":
    unittest.main()
