# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Run inside the agent image as the pinned Kubernetes driver's identity."""

import os
import pwd
import shutil
import stat
import tempfile
import unittest
from pathlib import Path


class KubernetesAgentImage(unittest.TestCase):
    def test_runtime_python_sources_are_readable_by_sandbox_identity(self):
        for name in ("fabric.py", "health.py", "interfaces.py", "openclaw_adapter.py"):
            path = Path("/opt/nemoclaw") / name
            compile(path.read_text(), str(path), "exec")

    def test_runtime_identity_matches_kubernetes_sandbox(self):
        self.assertEqual((os.getuid(), os.getgid()), (10001, 10001))
        user = pwd.getpwnam("node")
        self.assertEqual((user.pw_uid, user.pw_gid), (10001, 10001))

    def test_nonroot_workspace_seed_preserves_private_permissions(self):
        source = Path("/sandbox")
        list(source.iterdir())
        status = source.stat()
        self.assertEqual((status.st_uid, status.st_gid), (10001, 10001))
        self.assertEqual(stat.S_IMODE(status.st_mode), 0o700)
        # Match the driver's init container: source is read-only; the
        # destination must be writable by the same unprivileged identity.
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "workspace"
            shutil.copytree(source, destination, symlinks=True)
            # OpenShell qualifies Landlock before the Fabric command runs.
            # Rust uses the authored TMPDIR directly without a fallback.
            for name in ("tmp", ".cache"):
                folder = destination / name
                self.assertEqual(stat.S_IMODE(folder.stat().st_mode), 0o700)
                with tempfile.TemporaryFile(dir=folder) as probe:
                    probe.write(b"qualification")
            sentinel = destination / ".workspace-initialized"
            sentinel.write_text("ready")
            self.assertEqual(sentinel.read_text(), "ready")


if __name__ == "__main__":
    unittest.main()
