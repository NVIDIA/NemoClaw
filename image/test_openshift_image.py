# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Opt-in smoke checks inside the OpenShift image as a namespace-selected UID."""

import json
import os
import stat
import unittest
from pathlib import Path


@unittest.skipUnless(
    os.environ.get("NEMOCLAW_TEST_OPENSHIFT_UID"),
    "requires an assembled image and explicit test UID",
)
class OpenShiftAgentImage(unittest.TestCase):
    def test_selected_uid_needs_no_privileged_group_or_image_seed_write(self):
        uid = int(os.environ["NEMOCLAW_TEST_OPENSHIFT_UID"])
        gid = int(os.environ.get("NEMOCLAW_TEST_OPENSHIFT_GID", uid))
        self.assertGreater(uid, 0)
        self.assertGreater(gid, 0)
        self.assertEqual((os.getuid(), os.getgid()), (uid, gid))
        self.assertNotIn(0, os.getgroups())
        seed = Path("/sandbox")
        self.assertEqual({path.name for path in seed.iterdir()}, {"tmp", ".cache"})
        for path in [seed, seed / "tmp", seed / ".cache"]:
            self.assertTrue(path.is_dir())
            self.assertEqual(path.stat().st_uid, 0)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o555)
            self.assertTrue(os.access(path, os.R_OK | os.X_OK))
            self.assertFalse(os.access(path, os.W_OK))
        self.assertEqual(list((seed / "tmp").iterdir()), [])
        self.assertEqual(list((seed / ".cache").iterdir()), [])

    def test_packaged_bridge_adapter_and_plugins_are_accessible(self):
        import nemo_fabric_adapters.openclaw.adapter as adapter

        compile(Path(adapter.__file__).read_text(), adapter.__file__, "exec")
        runtime = json.loads(Path("/opt/nemoclaw/runtime.json").read_text())
        self.assertTrue(os.access(runtime["command"][0], os.X_OK))
        for path in Path("/opt/nemoclaw").glob("*.py"):
            compile(path.read_text(), str(path), "exec")
        for plugin in ("brave", "tavily"):
            directory = Path("/app/dist/extensions") / plugin
            for path in [directory, *directory.rglob("*")]:
                self.assertTrue(os.access(path, os.R_OK), str(path))
                if path.is_dir():
                    self.assertTrue(os.access(path, os.X_OK), str(path))


if __name__ == "__main__":
    unittest.main()
