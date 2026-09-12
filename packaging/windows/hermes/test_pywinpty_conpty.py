# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
import importlib.util
from pathlib import Path
import tempfile
import tomllib
import unittest

spec = importlib.util.spec_from_file_location(
    "conpty_build", Path(__file__).with_name("pywinpty-conpty.py")
)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)

SOURCE = """[project]
name = "control-only"
[tool.uv]
override-dependencies = ["cryptography>=50,<51", "pynacl>=1.6,<1.7"]
exclude-newer = "14 days"
[tool.uv.exclude-newer-package]
cryptography = false
maturin = false
[tool.setuptools]
packages = ["unrelated"]
"""


class ConptyBuildConfiguration(unittest.TestCase):
    def test_retains_all_upstream_uv_values_and_scopes_only_pywinpty(self):
        original = tomllib.loads(SOURCE)["tool"]["uv"]
        configured = tomllib.loads(helper.render_configuration(SOURCE))
        settings = configured.pop("config-settings-package")
        self.assertEqual(configured, original)
        self.assertEqual(
            settings,
            {"pywinpty": {"build-args": "--features winpty-rs/conpty --locked"}},
        )
        self.assertNotIn("cryptography", settings)
        self.assertNotIn("tool", configured)

    def test_unknown_upstream_uv_schema_requires_explicit_review(self):
        with self.assertRaisesRegex(ValueError, "fresh explicit review"):
            helper.render_configuration(
                SOURCE.replace(
                    'exclude-newer = "14 days"',
                    'exclude-newer = "14 days"\nnew-option = true',
                )
            )

    def test_duplicate_toml_is_refused_before_writing(self):
        with self.assertRaises(tomllib.TOMLDecodeError):
            helper.render_configuration(SOURCE + "\n[tool.uv]\n")

    def test_changed_canonical_source_cannot_create_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project = root / "pyproject.toml"
            project.write_text(SOURCE)
            with self.assertRaisesRegex(ValueError, "exact canonical source"):
                helper.prepare_configuration(
                    project, root / "uv.toml", root / "receipt.json"
                )
            self.assertFalse((root / "uv.toml").exists())
            self.assertFalse((root / "receipt.json").exists())


if __name__ == "__main__":
    unittest.main()
