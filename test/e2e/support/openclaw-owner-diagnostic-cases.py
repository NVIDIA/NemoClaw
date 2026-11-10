# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

import json
import os
from pathlib import Path
import tempfile
import subprocess
import sys
import unittest
from unittest.mock import patch

import importlib.util

spec = importlib.util.spec_from_file_location(
    "owner_snapshot", Path(__file__).parents[1] / "lib/openclaw-owner-diagnostic.py"
)
owner_snapshot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owner_snapshot)
MAX_BYTES = owner_snapshot.MAX_BYTES
snapshot = owner_snapshot.snapshot


class DiagnosticTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.state = self.root / "state"
        self.owner = self.state / "tmp/openclaw-1000"
        self.owner.mkdir(parents=True)
        self.proc = self.root / "proc"
        self.proc.mkdir()
        self.lock = self.owner / "state.0123456789abcdef.lock"

    def read(self):
        return snapshot(str(self.state), str(self.proc))

    def process(self, pid=42, worker=True):
        folder = self.proc / str(pid)
        folder.mkdir()
        # Fields 3 through 22, including a parenthesis in Linux comm.
        (folder / "stat").write_text(f"{pid} (worker ) name) S 1 " + "0 " * 17 + "123\n")
        (folder / "cmdline").write_bytes(
            b"node\0/infra/sqlite-readonly-location.worker.js\0SECRET_ARGUMENT\0" if worker else b"node\0SECRET_ARGUMENT\0"
        )

    def test_projects_owner_and_worker_without_payload_or_arguments(self):
        self.process()
        self.lock.write_text(json.dumps({"pid": 42, "role": "gateway", "startTime": 123,
            "configPath": "SECRET_CONFIG", "ownerId": "SECRET_ID", "processNamespace": {
                "platform": "linux", "host": "SECRET_HOST", "pidNsInode": "456",
                "identity": "11111111-1111-1111-1111-111111111111"}}))
        before = self.lock.read_bytes()
        result = self.read()
        self.assertEqual(result["owners"][0]["pidNamespaceInode"], "456")
        self.assertEqual(result["owners"][0]["ownerBootIdentity"], "11111111-1111-1111-1111-111111111111")
        self.assertEqual(result["owners"][0]["ownerProcess"]["startTicks"], 123)
        self.assertEqual(result["workers"][0]["pid"], 42)
        self.assertNotIn("SECRET", json.dumps(result))
        self.assertEqual(self.lock.read_bytes(), before)

    def test_command_entrypoint_emits_only_projected_json(self):
        self.process()
        self.lock.write_text('{"pid":42,"ownerId":"SECRET_ID"}')
        result = subprocess.run(
            [sys.executable, "-I", "-B", spec.origin,
             "--state-root", str(self.state), "--proc-root", str(self.proc)],
            capture_output=True, text=True, timeout=5,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        self.assertNotIn("SECRET", result.stdout)
        facts = json.loads(result.stdout)
        self.assertEqual(facts["kind"], "openclaw-owner-diagnostic-v1")
        self.assertEqual(facts["owners"][0]["pid"], 42)

    def test_rejects_symlink_lock(self):
        secret = self.root / "secret"
        secret.write_text('{"pid":42}')
        self.lock.symlink_to(secret)
        self.assertEqual(self.read()["owners"][0]["status"], "unavailable")

    def test_rejects_symlink_owner_directory(self):
        outside = self.root / "outside"
        outside.mkdir()
        (self.state / "tmp/openclaw-2000").symlink_to(outside)
        self.assertIn({"status": "directory-unavailable"}, self.read()["owners"])

    def test_fifo_does_not_block(self):
        os.mkfifo(self.lock)
        self.assertEqual(self.read()["owners"][0]["status"], "unavailable")

    def test_rejects_oversize_and_malformed_owner(self):
        for payload in ["x" * (MAX_BYTES + 1), "{", "[]", "null", "[" * 1200]:
            with self.subTest(size=len(payload)):
                self.lock.write_text(payload)
                self.assertEqual(self.read()["owners"][0]["status"], "unavailable")

    def test_untrusted_fields_do_not_escape_or_crash(self):
        self.lock.write_text(json.dumps({"pid": "../SECRET", "role": [], "startTime": True,
            "processNamespace": {"platform": "linux", "pidNsInode": "SECRET"}}))
        result = self.read()
        self.assertNotIn("SECRET", json.dumps(result))
        self.assertEqual(result["owners"][0]["ownerProcess"], {"status": "invalid-pid"})

    def test_missing_process_is_unavailable_not_dead(self):
        self.lock.write_text('{"pid":42}')
        self.assertEqual(self.read()["owners"][0]["ownerProcess"], {"status": "unavailable", "pid": 42})

    def test_nonworker_arguments_are_omitted(self):
        self.process(worker=False)
        (self.proc / "42/cmdline").write_bytes(b"node\0service.js\0SECRET_sqlite_worker_argument\0")
        self.assertEqual(self.read()["workers"], [])

    def test_unavailable_process_is_counted(self):
        (self.proc / "42").mkdir()
        result = self.read()
        self.assertEqual(result["unavailableProcesses"], 1)
        self.assertEqual(result["workers"], [])

    def test_cpu_tick_changes_preserve_identity_but_pid_reuse_does_not(self):
        self.process()
        original = owner_snapshot.bounded_file
        for started, expected in [(123, "observed"), (124, "unavailable")]:
            reads = 0

            def changing_stat(name, parent, limit=MAX_BYTES):
                nonlocal reads
                data, metadata = original(name, parent, limit)
                if name == "stat":
                    reads += 1
                    if reads % 2 == 0:
                        data = data.replace(b") S 1 ", b") R 1 ").replace(b"123\n", f"{started}\n".encode())
                return data, metadata

            with self.subTest(started=started), patch.object(owner_snapshot, "bounded_file", changing_stat):
                fd = owner_snapshot.directory(str(self.proc))
                try:
                    self.assertEqual(owner_snapshot.process_facts(fd, 42)["status"], expected)
                finally:
                    os.close(fd)

    def test_bounds_lock_inventory(self):
        for number in range(40):
            (self.owner / f"state.{number:016x}.lock").write_text('{"pid":42}')
        result = self.read()
        self.assertEqual(len(result["owners"]), 32)
        self.assertEqual(result["stateScan"], "truncated")

    def test_absent_state_preserves_process_evidence(self):
        self.process()
        result = snapshot(str(self.root / "absent"), str(self.proc))
        self.assertEqual(result["stateScan"], "unavailable")
        self.assertEqual(result["workers"][0]["pid"], 42)


if __name__ == "__main__":
    unittest.main(verbosity=2)
