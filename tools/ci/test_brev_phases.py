# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class BrevPhases(unittest.TestCase):
    def phase(self, name):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            executable = root / "command"
            executable.write_text("""#!/usr/bin/env python3
import json, os, pathlib, sys
name = pathlib.Path(sys.argv[0]).name
with open(os.environ["CALLS"], "a") as output:
    output.write(json.dumps([name, *sys.argv[1:]]) + "\\n")
if name == "ssh" and 'printf %s "$HOME"' in sys.argv:
    print("/home/fixture")
""")
            executable.chmod(0o755)
            for command in ("brev", "ssh", "rsync"):
                (root / command).symlink_to(executable)
            env = {
                **os.environ,
                "PATH": f"{root}:{os.environ['PATH']}",
                "RUNNER_TEMP": str(root),
                "CALLS": str(root / "calls"),
                "INSTANCE_NAME": "nclaw-v1-123-1",
            }
            env.pop("NVIDIA_INFERENCE_API_KEY", None)
            if name == "qualify":
                env["NVIDIA_INFERENCE_API_KEY"] = "fixture-only"
            result = subprocess.run(
                ["bash", str(ROOT / "tools/e2e/brev-v1-host.sh"), name],
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )
            calls = (
                [json.loads(line) for line in (root / "calls").read_text().splitlines()]
                if (root / "calls").exists()
                else []
            )
            return result, calls

    def test_image_loading_needs_neither_bundle_nor_inference_credential(self):
        result, calls = self.phase("load-image")
        self.assertEqual(result.returncode, 0, result.stderr)
        transfers = [call for call in calls if call[0] == "rsync"]
        self.assertEqual(len(transfers), 1)
        self.assertIn("candidate-image/", transfers[0])
        self.assertTrue(
            any(call[0] == "ssh" and "load-image" in call[-1] for call in calls)
        )

    def test_qualification_does_not_transfer_the_image_again(self):
        result, calls = self.phase("qualify")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(any("candidate-image/" in call for call in calls))
        self.assertTrue(any("candidate/bundle/" in call for call in calls))


if __name__ == "__main__":
    unittest.main()
