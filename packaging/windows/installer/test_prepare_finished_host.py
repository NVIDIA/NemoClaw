# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location(
    "host_builder", Path(__file__).with_name("prepare-finished-host.py")
)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def executable(machine=b"\x64\xaa"):
    result = bytearray(256)
    result[:2] = b"MZ"
    result[60:64] = (128).to_bytes(4, "little")
    result[128:134] = b"PE\0\0" + machine
    return bytes(result)


class NativeHostInputs(unittest.TestCase):
    def archive(self, root, extra=None):
        archive = root / "input.tgz"
        with tarfile.open(archive, "w:gz") as output:
            for name in ("wxc-exec.exe", "wxc-host-prep.exe"):
                data = executable()
                member = tarfile.TarInfo("package/bin/arm64/" + name)
                member.size = len(data)
                output.addfile(member, io.BytesIO(data))
            if extra:
                output.addfile(*extra)
        return archive

    def test_extracts_only_two_exact_arm64_components(self):
        with tempfile.TemporaryDirectory() as value:
            root = Path(value)
            extra = tarfile.TarInfo("package/bin/x64/wxc-exec.exe")
            extra.size = 3
            archive = self.archive(root, (extra, io.BytesIO(b"old")))
            MODULE.extract_mxc(archive, root / "native")
            self.assertEqual(
                sorted(path.name for path in (root / "native").iterdir()),
                ["wxc-exec.exe", "wxc-host-prep.exe"],
            )
            self.assertEqual((root / "native/wxc-exec.exe").read_bytes(), executable())

    def test_duplicate_selected_member_is_refused(self):
        with tempfile.TemporaryDirectory() as value:
            root = Path(value)
            extra = tarfile.TarInfo("package/bin/arm64/wxc-exec.exe")
            extra.size = 1
            archive = self.archive(root, (extra, io.BytesIO(b"x")))
            with self.assertRaisesRegex(ValueError, "duplicated"):
                MODULE.extract_mxc(archive, root / "native")

    def test_x64_binary_cannot_be_labeled_arm64(self):
        with tempfile.TemporaryDirectory() as value:
            path = Path(value) / "wrong.exe"
            path.write_bytes(executable(b"\x64\x86"))
            with self.assertRaisesRegex(ValueError, "not Windows ARM64"):
                MODULE.arm64(path)

    def test_wrong_cached_archive_is_not_reused_or_executed(self):
        with tempfile.TemporaryDirectory() as value:
            root = Path(value)
            (root / "mxc-sdk-0.8.0.tgz").write_bytes(b"wrong archive")
            with self.assertRaisesRegex(ValueError, "exact input pin"):
                MODULE.obtain_sdk(root)


if __name__ == "__main__":
    unittest.main()
