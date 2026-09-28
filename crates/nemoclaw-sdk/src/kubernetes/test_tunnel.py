# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""The tunnel must end when its SDK command disappears, including abrupt exit."""

import os
import signal
import subprocess
import sys
import time
import unittest
from pathlib import Path


@unittest.skipUnless(os.name == "posix", "POSIX process-group custody")
class TunnelTests(unittest.TestCase):
    def test_tunnel_readiness_does_not_outlive_parent_custody(self):
        code = "import os,time; print(os.getpid(),flush=True); time.sleep(60)"
        bootstrap = "import sys,runpy; p=sys.argv.pop(1); sys.path.insert(0,p); runpy.run_path(p+'/tunnel.py',run_name='__main__')"
        helper = subprocess.Popen(
            [
                sys.executable,
                "-I",
                "-B",
                "-c",
                bootstrap,
                str(Path(__file__).parent),
                sys.executable,
                "-c",
                code,
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            start_new_session=True,
        )
        try:
            child = int(helper.stdout.readline())
            helper.stdin.close()
            self.assertEqual(helper.wait(timeout=5), -signal.SIGKILL)
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                status = subprocess.run(
                    ["ps", "-o", "stat=", "-p", str(child)], capture_output=True, text=True
                )
                if (
                    status.returncode
                    or not status.stdout.strip()
                    or status.stdout.strip().startswith("Z")
                ):
                    break
                time.sleep(0.01)
            else:
                self.fail("port-forward descendant survived SDK custody loss")
        finally:
            if helper.poll() is None:
                os.killpg(helper.pid, signal.SIGKILL)
            helper.wait(timeout=5)
            helper.stdout.close()
            if not helper.stdin.closed:
                helper.stdin.close()


if __name__ == "__main__":
    unittest.main()
