# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Run inside the agent image as the pinned Kubernetes driver's identity."""

import json
import os
import pwd
import shutil
import stat
import tempfile
import unittest
from pathlib import Path


class KubernetesAgentImage(unittest.TestCase):
    def test_runtime_python_sources_are_readable_by_sandbox_identity(self):
        for name in ("fabric.py", "bridge_contract.py", "catalog.py", "runtime_metadata.py"):
            path = Path("/opt/nemoclaw") / name
            compile(path.read_text(), str(path), "exec")

    def test_installed_fabric_adapter_is_readable_by_sandbox_identity(self):
        import nemo_fabric_adapters.openclaw.adapter as adapter

        path = Path(adapter.__file__)
        compile(path.read_text(), str(path), "exec")

    def test_runtime_identity_matches_kubernetes_sandbox(self):
        self.assertEqual((os.getuid(), os.getgid()), (10001, 10001))
        user = pwd.getpwnam("node")
        self.assertEqual((user.pw_uid, user.pw_gid), (10001, 10001))

    def test_image_runtime_metadata_matches_the_nonroot_process_identity(self):
        runtime = json.loads(Path("/opt/nemoclaw/runtime.json").read_text())
        self.assertEqual(
            runtime["policy"]["process"],
            {"run_as_user": str(os.getuid()), "run_as_group": str(os.getgid())},
        )
        self.assertTrue(os.access(runtime["command"][0], os.X_OK))

    def test_native_plugins_are_readable_by_the_changed_sandbox_identity(self):
        for plugin in ("brave", "tavily"):
            directory = Path("/app/dist/extensions") / plugin
            self.assertTrue(directory.is_dir())
            paths = [directory, *directory.rglob("*")]
            for path in paths:
                self.assertTrue(os.access(path, os.R_OK), str(path))
                if path.is_dir():
                    self.assertTrue(os.access(path, os.X_OK), str(path))

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
