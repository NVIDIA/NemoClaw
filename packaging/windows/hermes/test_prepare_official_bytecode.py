# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

import importlib.util
import os
from pathlib import Path
import py_compile
import tempfile
import unittest


SPEC = importlib.util.spec_from_file_location(
    "bytecode", Path(__file__).with_name("prepare-official-bytecode.py")
)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class BytecodeControls(unittest.TestCase):
    def test_overlong_installed_cache_is_omitted_with_source_retained(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / ("x" * 140 + ".py")
            source.write_text("VALUE = 1\n")
            self.assertEqual(MODULE.prepare_tree(root), [])
            self.assertTrue(source.is_file())
            self.assertFalse((root / "__pycache__").exists() and any((root / "__pycache__").iterdir()))

    def test_timestamp_cache_is_replaced_and_resources_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "module.py"
            source.write_text("VALUE = 42\n")
            license_file = root / "LICENSE"
            license_file.write_bytes(b"required-license")
            py_compile.compile(
                str(source),
                doraise=True,
                invalidation_mode=py_compile.PycInvalidationMode.TIMESTAMP,
            )
            before = source.read_bytes()
            rows = MODULE.prepare_tree(root)
            self.assertTrue(rows[0]["replaced"])
            self.assertEqual(rows[0]["flags"], 1)
            self.assertEqual(
                rows[0]["sourceHashHex"], importlib.util.source_hash(before).hex()
            )
            self.assertEqual(source.read_bytes(), before)
            self.assertEqual(license_file.read_bytes(), b"required-license")

    def test_moved_zero_timestamp_cache_uses_actual_loader_without_compiling(self):
        with tempfile.TemporaryDirectory() as directory:
            proof = MODULE.prove_relocated_import(directory)
            self.assertTrue(proof["sourceCompilationForbidden"])
            self.assertTrue(proof["cacheUnchanged"])
            self.assertEqual(proof["sourceMtime"], 0)

    def test_optimized_existing_cache_also_survives_export(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "module.py"
            source.write_text("assert False\nVALUE = 2\n")
            py_compile.compile(
                str(source),
                optimize=1,
                doraise=True,
                invalidation_mode=py_compile.PycInvalidationMode.TIMESTAMP,
            )
            rows = MODULE.prepare_tree(root)
            self.assertEqual([r["optimization"] for r in rows], [0, 1])
            self.assertEqual([r["flags"] for r in rows], [1, 1])

    def test_invalid_retained_source_fails_instead_of_claiming_complete(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "broken.py").write_text("def broken(:\n")
            with self.assertRaises(py_compile.PyCompileError):
                MODULE.prepare_tree(root)

    def test_linked_source_is_not_written_or_followed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            outside = root / "outside"
            outside.mkdir()
            (outside / "module.py").write_text("VALUE = 1\n")
            selected = root / "selected"
            selected.mkdir()
            try:
                (selected / "module.py").symlink_to(outside / "module.py")
            except OSError:
                self.skipTest("Symbolic links unavailable in this test environment")
            with self.assertRaises(ValueError):
                MODULE.prepare_tree(selected)
            self.assertFalse((outside / "__pycache__").exists())

    def test_hardlinked_source_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "module.py"
            source.write_text("VALUE = 1\n")
            os.link(source, root / "alias.py")
            with self.assertRaises(ValueError):
                MODULE.prepare_tree(root)


if __name__ == "__main__":
    unittest.main()
