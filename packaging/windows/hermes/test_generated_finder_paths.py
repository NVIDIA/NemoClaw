# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Execute generated metadata; real Windows/MXC import remains a separate gate."""

import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock


spec = importlib.util.spec_from_file_location(
    "generated_finder_metadata",
    os.environ.get(
        "NEMOCLAW_TEST_METADATA_BUILDER",
        str(Path(__file__).with_name("prepare-native-runtime.py")),
    ),
)
metadata = importlib.util.module_from_spec(spec)
spec.loader.exec_module(metadata)


class GeneratedFinderPaths(unittest.TestCase):
    def setUp(self):
        fixture = tempfile.TemporaryDirectory()
        self.addCleanup(fixture.cleanup)
        self.root = Path(fixture.name)
        self.source = self.root / "original/hermes-agent"
        self.target = self.root / "installed/hermes-agent"
        self.finder = (
            self.target / "venv/Lib/site-packages/__editable___hermes_finder.py"
        )
        self.finder.parent.mkdir(parents=True)
        package = self.target / "hermes_cli"
        package.mkdir()
        (package / "__init__.py").write_text("IDENTITY = 'owned-source'\n")
        self.input = (
            "from __future__ import annotations\n"
            f"MAPPING: dict[str, str] = { {'hermes_cli': str(self.source / 'hermes_cli')}!r}\n"
            f"NAMESPACES: dict[str, list[str]] = { {'hermes_plugins': [str(self.source / 'plugins')]}!r}\n"
        ).encode()

    def test_actual_generated_import_works_without_realpath(self):
        generated = metadata.relocate_finder(self.input, self.source)
        self.finder.write_bytes(generated)
        finder_spec = importlib.util.spec_from_file_location(
            "actual_finder", self.finder
        )
        finder = importlib.util.module_from_spec(finder_spec)
        with mock.patch.object(
            Path, "resolve", side_effect=PermissionError("GetFinalPath denied")
        ):
            finder_spec.loader.exec_module(finder)
            package_spec = importlib.util.spec_from_file_location(
                "actual_owned_hermes",
                Path(finder.MAPPING["hermes_cli"]) / "__init__.py",
            )
            package = importlib.util.module_from_spec(package_spec)
            package_spec.loader.exec_module(package)
        self.assertFalse(self.source.exists())
        self.assertEqual(
            finder.MAPPING, {"hermes_cli": str(self.target / "hermes_cli")}
        )
        self.assertEqual(
            finder.NAMESPACES, {"hermes_plugins": [str(self.target / "plugins")]}
        )
        self.assertEqual(package.IDENTITY, "owned-source")

    def test_generated_finder_refuses_relative_import_origin(self):
        generated = metadata.relocate_finder(self.input, self.source)
        with self.assertRaisesRegex(ImportError, "absolute installed path"):
            exec(generated, {"__file__": "venv/Lib/site-packages/finder.py"})

    def test_generated_finder_refuses_parent_traversal(self):
        generated = metadata.relocate_finder(self.input, self.source)
        with self.assertRaisesRegex(ImportError, "absolute installed path"):
            exec(generated, {"__file__": str(self.finder.parent / ".." / "finder.py")})

    def test_foreign_source_mapping_still_refused_before_generation(self):
        foreign = self.input.replace(
            str(self.source).encode(), str(self.root / "foreign").encode()
        )
        with self.assertRaisesRegex(
            metadata.AdaptationError, "declared source runtime"
        ):
            metadata.relocate_finder(foreign, self.source)


if __name__ == "__main__":
    unittest.main()
