# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

import importlib.util
import os
from pathlib import Path, PureWindowsPath
import subprocess
import sys
import tempfile
import unittest


SPEC = importlib.util.spec_from_file_location(
    "bytecode_builder", Path(__file__).with_name("prepare-python-bytecode.py")
)
BUILDER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILDER)


class BytecodeControls(unittest.TestCase):
    def test_worker_is_directly_executable_with_source_hash_header(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, output = root / "worker.py", root / "worker.pyc"
            source.write_text("print('STATIC_WORKER_OK')\n", encoding="utf-8")
            receipt = BUILDER.compile_source(
                source,
                output,
                r"C:\Program Files\NVIDIA\NemoClaw\runtimes\test\workers\worker.py",
            )
            self.assertEqual(receipt["flags"], 1)
            self.assertEqual(receipt["magicHex"], importlib.util.MAGIC_NUMBER.hex())
            result = subprocess.run(
                [sys.executable, "-I", "-B", str(output)],
                capture_output=True,
                text=True,
                check=True,
                timeout=10,
            )
            self.assertEqual(result.stdout, "STATIC_WORKER_OK\n")

    def test_timestamp_normalization_preserves_actual_cached_import(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "prepared_module.py"
            source.write_text("VALUE = 'CACHED_IMPORT_OK'\n", encoding="utf-8")
            files = BUILDER.compile_import_tree(
                root, PureWindowsPath(r"C:\Program Files\NVIDIA\NemoClaw\runtime")
            )
            cache = root / files[0]["cache"]
            before = cache.read_bytes()
            os.utime(source, (1000, 1000))
            command = [
                sys.executable,
                "-I",
                "-B",
                "-v",
                "-c",
                "import sys; sys.path.insert(0, sys.argv[1]); import prepared_module; print(prepared_module.VALUE)",
                str(root),
            ]
            result = subprocess.run(
                command, capture_output=True, text=True, check=True, timeout=10
            )
            self.assertEqual(result.stdout, "CACHED_IMPORT_OK\n")
            self.assertIn("code object from", result.stderr)
            self.assertIn(cache.name, result.stderr)
            self.assertEqual(cache.read_bytes(), before)
            self.assertTrue(source.exists())

    def test_bad_python_stops_preparation_without_successful_bytecode(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, output = root / "bad.py", root / "bad.pyc"
            source.write_text("def broken(:\n", encoding="utf-8")
            with self.assertRaises(BUILDER.py_compile.PyCompileError):
                BUILDER.compile_source(source, output, r"C:\owned\bad.py")
            self.assertFalse(output.exists())

    def test_existing_worker_output_is_not_silently_reused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, output = root / "worker.py", root / "worker.pyc"
            source.write_text("VALUE = 1\n", encoding="utf-8")
            output.write_bytes(b"previous-output")
            with self.assertRaisesRegex(ValueError, "fresh"):
                BUILDER.compile_source(source, output, r"C:\owned\worker.py")
            self.assertEqual(output.read_bytes(), b"previous-output")


if __name__ == "__main__":
    unittest.main()
