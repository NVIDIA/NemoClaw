# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Exercise cleanup through a fake Brev executable; never access live resources."""

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class BrevCleanup(unittest.TestCase):
    def cleanup(self, inventories):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "inventories").write_text(json.dumps(inventories))
            (root / "brev").write_text("""#!/usr/bin/env python3
import json, os, pathlib, sys
root = pathlib.Path(os.environ["FAKE_BREV_ROOT"])
with (root / "calls").open("a") as f: f.write(json.dumps(sys.argv[1:]) + "\\n")
if sys.argv[1] == "ls":
    path = root / "inventories"
    values = json.loads(path.read_text())
    value = values.pop(0) if values else "invalid"
    path.write_text(json.dumps(values))
    print(json.dumps(value))
""")
            (root / "sleep").write_text("#!/bin/sh\nexit 0\n")
            for name in ("brev", "sleep"):
                (root / name).chmod(0o755)
            result = subprocess.run(
                ["bash", str(ROOT / "tools/e2e/brev-v1-host.sh"), "cleanup"],
                env={
                    **os.environ,
                    "PATH": f"{root}:{os.environ['PATH']}",
                    "INSTANCE_NAME": "nclaw-v1-123-1",
                    "FAKE_BREV_ROOT": str(root),
                },
                capture_output=True,
                text=True,
                timeout=20,
                check=False,
            )
            calls = (
                [json.loads(line) for line in (root / "calls").read_text().splitlines()]
                if (root / "calls").exists()
                else []
            )
            return result, calls

    def test_requires_two_consecutive_confirmed_absences(self):
        result, calls = self.cleanup([[], [{"name": "nclaw-v1-123-1"}], [], []])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sum(c[0] == "ls" for c in calls), 4)
        self.assertIn("Verified Brev workspace deletion", result.stdout)
        self.assertTrue(
            all(c[1] == "nclaw-v1-123-1" for c in calls if c[0] == "delete")
        )

    def test_cleanup_does_not_refresh_ssh_configuration(self):
        result, calls = self.cleanup([[{"name": "nclaw-v1-123-1"}], [], []])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(all(call[0] in ("delete", "ls") for call in calls), calls)

    def test_invalid_inventory_never_confirms_deletion(self):
        for invalid in (
            {},
            {"workspaces": {}},
            [None],
            [{}],
            [{"name": ""}],
            "invalid",
        ):
            with self.subTest(invalid=invalid):
                result, _ = self.cleanup([invalid] * 40)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("Verified Brev workspace deletion", result.stdout)

    def test_unknown_observation_resets_absence_count(self):
        result, calls = self.cleanup([[], {}, [], []])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sum(c[0] == "ls" for c in calls), 4)

    def test_other_workspaces_are_preserved(self):
        result, calls = self.cleanup(
            [
                {"workspaces": [{"workspaceName": "other"}]},
                [{"instanceName": "other"}],
            ]
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(all(c[1] != "other" for c in calls if c[0] == "delete"))

    def test_null_workspace_list_is_an_empty_inventory(self):
        result, _ = self.cleanup([{"workspaces": None}, []])
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
