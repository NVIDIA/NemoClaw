# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location(
    "openshell_source", Path(__file__).with_name("openshell_source.py")
)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class LockedOpenShellSource(unittest.TestCase):
    def command(self, root, *arguments):
        return subprocess.check_output(
            ["git", "-C", str(root), "-c", "user.name=Fixture", "-c",
             "user.email=fixture@example.invalid", *arguments],
            stderr=subprocess.PIPE,
        )

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.source = root / "source"
        self.source.mkdir()
        self.command(self.source, "init", "--quiet")
        (self.source / "source.txt").write_text("base\n", encoding="utf-8")
        self.command(self.source, "add", "source.txt")
        self.command(self.source, "commit", "--quiet", "-m", "Fixture base")
        base = self.command(self.source, "rev-parse", "HEAD").decode().strip()
        (self.source / "source.txt").write_text("patched\n", encoding="utf-8")
        (self.source / "added.txt").write_text("new source\n", encoding="utf-8")
        self.command(self.source, "add", ".")
        tree = self.command(self.source, "write-tree").decode().strip()
        patch = self.command(self.source, "diff", "--cached", "--binary", "--full-index", "HEAD")
        self.inputs = root / "inputs"
        self.inputs.mkdir()
        (self.inputs / "openshell-native-transport.patch").write_bytes(patch)
        self.lock = {"schemaVersion": 1, "baseRevision": base, "patchedTree": tree,
                     "patchSha256": hashlib.sha256(patch).hexdigest()}
        (self.inputs / "openshell-native-transport.lock.json").write_text(json.dumps(self.lock))
        self.checkout = root / "checkout"
        self.command(root, "clone", "--quiet", "--no-hardlinks", str(self.source), str(self.checkout))

    def test_applies_new_and_changed_files_and_verifies_exact_tree(self):
        self.assertEqual(MODULE.apply(self.checkout, self.inputs), self.lock)
        self.assertEqual((self.checkout / "source.txt").read_text(), "patched\n")
        self.assertEqual((self.checkout / "added.txt").read_text(), "new source\n")
        self.assertEqual(MODULE.verify(self.checkout, self.lock), self.lock)

    def test_rejects_unpatched_tree_and_repeated_application(self):
        with self.assertRaisesRegex(ValueError, "source tree"):
            MODULE.verify(self.checkout, self.lock)
        MODULE.apply(self.checkout, self.inputs)
        with self.assertRaisesRegex(ValueError, "not clean"):
            MODULE.apply(self.checkout, self.inputs)

    def test_rejects_patch_substitution_before_mutating_checkout(self):
        (self.inputs / "openshell-native-transport.patch").write_bytes(b"substituted")
        with self.assertRaisesRegex(ValueError, "differs from its lock"):
            MODULE.apply(self.checkout, self.inputs)
        self.assertEqual(self.command(self.checkout, "status", "--porcelain"), b"")

    def test_rejects_wrong_base_revision_before_mutation(self):
        self.lock["baseRevision"] = "0" * 40
        (self.inputs / "openshell-native-transport.lock.json").write_text(json.dumps(self.lock))
        with self.assertRaisesRegex(ValueError, "base revision"):
            MODULE.apply(self.checkout, self.inputs)
        self.assertEqual(self.command(self.checkout, "status", "--porcelain"), b"")

    def test_rejects_dirty_checkout_before_application(self):
        (self.checkout / "untracked.txt").write_text("unexpected")
        with self.assertRaisesRegex(ValueError, "not clean"):
            MODULE.apply(self.checkout, self.inputs)

    def test_rejects_worktree_mutation_during_build(self):
        MODULE.apply(self.checkout, self.inputs)
        (self.checkout / "source.txt").write_text("changed during build")
        with self.assertRaisesRegex(ValueError, "source check failed"):
            MODULE.verify(self.checkout, self.lock)

    def test_rejects_staged_mutation_during_build(self):
        MODULE.apply(self.checkout, self.inputs)
        (self.checkout / "source.txt").write_text("changed during build")
        self.command(self.checkout, "add", "source.txt")
        with self.assertRaisesRegex(ValueError, "source tree"):
            MODULE.verify(self.checkout, self.lock)

    def test_rejects_untracked_source_during_build(self):
        MODULE.apply(self.checkout, self.inputs)
        (self.checkout / "untracked.txt").write_text("unexpected")
        with self.assertRaisesRegex(ValueError, "untracked"):
            MODULE.verify(self.checkout, self.lock)

    def test_checked_in_derivative_matches_its_lock(self):
        lock = MODULE.load_lock()
        self.assertEqual(lock["baseRevision"], "624f55b3c6affedd4f2757c7eb32132196b4c3e8")

    def test_rejects_invalid_lock_shape(self):
        for value in (None, [], "invalid", 1):
            with self.subTest(value=value):
                (self.inputs / "openshell-native-transport.lock.json").write_text(json.dumps(value))
                with self.assertRaisesRegex(ValueError, "identity is invalid"):
                    MODULE.load_lock(self.inputs)
        for field, value in (("schemaVersion", True), ("patchedTree", "../source"), ("patchSha256", None)):
            with self.subTest(field=field):
                changed = {**self.lock, field: value}
                (self.inputs / "openshell-native-transport.lock.json").write_text(json.dumps(changed))
                with self.assertRaisesRegex(ValueError, "identity is invalid"):
                    MODULE.load_lock(self.inputs)


if __name__ == "__main__":
    unittest.main()
