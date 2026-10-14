# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Deterministic cleanup failure coverage without a Docker daemon."""

import importlib.util
import io
from pathlib import Path
import signal
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "proof", Path(__file__).with_name("llama-cpp-stdio-image-proof.py"),
)
proof = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proof)


class CleanupTest(unittest.TestCase):
    def test_cleanup_outcomes(self):
        for failure in (
            "none", "container", "network", "timeout", "unavailable", "primary",
            "missing-container", "cancel", "cancel-during-network", "cancel-during-run",
            "cancel-during-cleanup",
        ):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                calls = []
                run_invocations = []
                output, errors = io.StringIO(), io.StringIO()
                network = Path(directory).name
                container = f"{network}-proof"

                def run(arguments, **kwargs):
                    if arguments[0] == "cc":
                        Path(arguments[-1]).touch()
                        return subprocess.CompletedProcess(arguments, 0)
                    calls.append(arguments)
                    self.assertEqual(kwargs["timeout"], proof.SUBPROCESS_TIMEOUT_SECONDS)
                    if failure == "timeout":
                        raise subprocess.TimeoutExpired(arguments, 60)
                    if failure == "unavailable":
                        raise OSError("Docker unavailable")
                    if failure == "missing-container" and arguments[1] == "rm":
                        return subprocess.CompletedProcess(
                            arguments, 1, stderr=b"No such container: already removed",
                        )
                    if failure == "cancel-during-cleanup" and arguments[1] == "rm":
                        signal.raise_signal(signal.SIGTERM)
                    failed = (
                        failure in ("container", "primary") and arguments[1] == "rm"
                    ) or (failure == "network" and arguments[1] == "network")
                    return subprocess.CompletedProcess(arguments, int(failed), stderr=b"cleanup denied")

                def docker(*arguments):
                    if arguments[:2] == ("network", "create"):
                        if failure == "cancel-during-network":
                            signal.raise_signal(signal.SIGTERM)
                        return "network"
                    if arguments[0] == "run":
                        run_invocations.append(arguments)
                        if failure == "cancel-during-run":
                            signal.raise_signal(signal.SIGTERM)
                        return "container"
                    if arguments[0] == "inspect":
                        return '[{"NetworkSettings":{},"HostConfig":{}}]'
                    if arguments[:2] == ("network", "inspect"):
                        return '[{"Internal":true}]'
                    return ""

                def forward(container, key):
                    if failure == "primary":
                        raise RuntimeError("primary failure")
                    if failure == "cancel":
                        signal.raise_signal(signal.SIGTERM)
                    code = b"200" if key == proof.TEST_KEY else b"401"
                    return 0, b"HTTP/1.1 " + code + b" OK\r\n\r\nOK", b""

                previous_handlers = (
                    proof.install_cancellation_handlers() if failure.startswith("cancel") else {}
                )
                try:
                    with patch.object(proof.subprocess, "run", run), patch.object(
                        proof, "docker", docker,
                    ), patch.object(proof, "forward", forward), patch.object(
                        proof, "cancel_forward", lambda _container: None,
                    ), patch.object(
                        proof.sys, "stdout", output,
                    ), patch.object(proof.sys, "stderr", errors):
                        if failure in ("none", "missing-container"):
                            proof.prove("image", Path(directory))
                        elif failure.startswith("cancel"):
                            with self.assertRaises(SystemExit) as cancelled:
                                proof.prove("image", Path(directory))
                            self.assertEqual(cancelled.exception.code, 128 + signal.SIGTERM)
                        else:
                            message = "primary failure" if failure == "primary" else "resource cleanup failed"
                            with self.assertRaisesRegex(RuntimeError, message):
                                proof.prove("image", Path(directory))
                finally:
                    for signum, handler in previous_handlers.items():
                        signal.signal(signum, handler)
                self.assertNotIn("PR-built", output.getvalue())
                if failure in ("none", "missing-container"):
                    self.assertIn("Image 'image':", output.getvalue())
                if failure in ("container", "primary"):
                    self.assertIn(repr(("rm", "--force", container)), errors.getvalue())
                    self.assertIn("cleanup denied", errors.getvalue())
                if failure == "network":
                    self.assertIn(repr(("network", "rm", network)), errors.getvalue())
                    self.assertIn("cleanup denied", errors.getvalue())
                self.assertEqual(calls, [
                    ("docker", "rm", "--force", container),
                    ("docker", "network", "rm", network),
                ])
                if failure == "cancel-during-network":
                    self.assertEqual(run_invocations, [])
                else:
                    self.assertEqual(len(run_invocations), 1)
                    self.assertIn("--rm", run_invocations[0])
                    self.assertEqual(
                        run_invocations[0][run_invocations[0].index("--name") + 1], container,
                    )


if __name__ == "__main__":
    unittest.main()
