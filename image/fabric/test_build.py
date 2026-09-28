# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Exercise the installed Fabric contract and locally compiled wheel inputs."""

import hashlib
import tempfile
import unittest
from pathlib import Path

from wheel_lock import requirements


class RecipeCoverage(unittest.TestCase):
    def test_wheel_lock_binds_installs_to_the_exact_compiled_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            wheel = root / "example_package-0.4.0-py3-none-any.whl"
            wheel.write_bytes(b"compiled wheel")
            digest = hashlib.sha256(wheel.read_bytes()).hexdigest()
            self.assertEqual(requirements(root), f"example-package==0.4.0 --hash=sha256:{digest}\n")
            wheel.write_bytes(b"different compilation")
            self.assertNotIn(digest, requirements(root))
            (root / "example_package-0.5.0-py3-none-any.whl").write_bytes(b"ambiguous")
            with self.assertRaises(ValueError):
                requirements(root)

    def test_missing_compiled_wheels_fail_before_dependency_resolution(self):
        with tempfile.TemporaryDirectory() as directory, self.assertRaises(ValueError):
            requirements(Path(directory))


if __name__ == "__main__":
    unittest.main()
