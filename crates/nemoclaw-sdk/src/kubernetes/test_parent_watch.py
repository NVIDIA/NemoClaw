# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Cancellation custody tests using isolated local subprocesses only."""

import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import parent_watch

HELPER = """
import subprocess, sys
sys.path.insert(0, sys.argv[1])
import parent_watch
parent_watch.start()
subprocess.run([sys.executable, '-c',
    'import os,pathlib,sys,time; pathlib.Path(sys.argv[1]).write_text(str(os.getpid())); time.sleep(60)',
    sys.argv[2]], check=True)
"""


@unittest.skipUnless(os.name == "posix", "POSIX process-group custody")
class ParentWatchTests(unittest.TestCase):
    def test_shared_process_group_is_rejected_without_signalling(self):
        with (
            patch.object(parent_watch.os, "getpgrp", return_value=-1),
            patch.object(parent_watch.os, "killpg") as kill,
        ):
            with self.assertRaisesRegex(RuntimeError, "isolated process group"):
                parent_watch.start()
            kill.assert_not_called()

    def test_successful_helper_exits_while_parent_pipe_is_open(self):
        code = (
            "import sys; sys.path.insert(0,sys.argv[1]); import parent_watch; parent_watch.start()"
        )
        helper = subprocess.Popen(
            [sys.executable, "-I", "-B", "-c", code, str(Path(__file__).parent)],
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        try:
            self.assertEqual(helper.wait(timeout=5), 0)
        finally:
            if helper.poll() is None:
                os.killpg(helper.pid, signal.SIGKILL)
            helper.wait(timeout=5)
            helper.stdin.close()

    def child_running(self, pid):
        result = subprocess.run(
            ["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True, check=False
        )
        return (
            result.returncode == 0
            and bool(result.stdout.strip())
            and not result.stdout.strip().startswith("Z")
        )

    def test_closed_parent_pipe_kills_helper_and_command_descendant(self):
        with tempfile.TemporaryDirectory() as temporary:
            marker = Path(temporary) / "command.pid"
            helper = subprocess.Popen(
                [sys.executable, "-I", "-B", "-c", HELPER, str(Path(__file__).parent), str(marker)],
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
            try:
                deadline = time.monotonic() + 5
                while not marker.exists() and time.monotonic() < deadline and helper.poll() is None:
                    time.sleep(0.01)
                self.assertTrue(marker.exists(), "synthetic command did not start")
                child = int(marker.read_text())
                self.assertIsNone(helper.poll())
                self.assertTrue(self.child_running(child))
                helper.stdin.close()
                self.assertEqual(helper.wait(timeout=5), -signal.SIGKILL)
                deadline = time.monotonic() + 5
                while self.child_running(child) and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertFalse(
                    self.child_running(child), "command survived loss of provider custody"
                )
            finally:
                if helper.poll() is None:
                    os.killpg(helper.pid, signal.SIGKILL)
                helper.wait(timeout=5)
                if not helper.stdin.closed:
                    helper.stdin.close()


if __name__ == "__main__":
    unittest.main()
