# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Check notices on generated source before it is installed into vLLM."""
import importlib.util
from pathlib import Path
import unittest


class GeneratedNotices(unittest.TestCase):
    def annotate(self, source, patch):
        spec = importlib.util.spec_from_file_location(
            "apply_patches", Path(__file__).with_name("apply_patches.py"))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.attribute_source(source, patch)

    def test_modified_source_keeps_original_notices_and_executes(self):
        source = ('# SPDX-License-Identifier: Apache-2.0\n'
                  '# SPDX-FileCopyrightText: Copyright contributors to the vLLM project\n'
                  '# Additional upstream attribution must survive.\n'
                  'from __future__ import annotations\n'
                  'answer = 42\n')
        output = self.annotate(source, "patch_ple_offload.py")
        self.assertIn("SPDX-License-Identifier: Apache-2.0\n", output)
        self.assertEqual(output.count("SPDX-License-Identifier:"), 1)
        self.assertTrue(output.endswith(source))
        self.assertIn("Copyright contributors to the vLLM project", output)
        self.assertIn("Additional upstream attribution must survive.", output)
        self.assertIn("Copyright (C) 2026 MiaAI Lab", output)
        self.assertIn("d03809008834124e80223c3482f2ddb59577a48f", output)
        self.assertIn("patch_ple_offload.py", output)
        self.assertIn("2026-09-15", output)
        self.assertIn("recipe/README.md", output)
        namespace = {}
        exec(compile(output, "patched.py", "exec"), namespace)
        self.assertEqual(namespace["answer"], 42)

    def test_unexpected_original_license_stops_packaging(self):
        for source in ("answer = 42\n", "# SPDX-License-Identifier: MIT\nanswer = 42\n"):
            with self.subTest(source=source), self.assertRaises(ValueError):
                self.annotate(source, "patch_ple_layer.py")


if __name__ == "__main__":
    unittest.main()
