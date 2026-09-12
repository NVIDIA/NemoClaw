# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
import hashlib
import importlib.util
import io
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
import zipfile

SPEC = importlib.util.spec_from_file_location(
    "replay", Path(__file__).with_name("replay-personal-runtime.py")
)
REPLAY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(REPLAY)


class ReplayControls(unittest.TestCase):
    def test_fixed_known_complete_artifact_documents_are_admitted(self):
        file = os.environ.get("NEMOCLAW_REPLAY_TEST_ZIP")
        if not file:
            self.skipTest("Exact downloaded artifact supplied by the replay-data check")
        with zipfile.ZipFile(file) as archive:
            details, documents, derivation = REPLAY.replay_documents(archive)
        self.assertEqual(details[0]["controllerSource"], REPLAY.PIN["sourceRevision"])
        self.assertEqual(derivation["runtimeRootAtExport"], REPLAY.PIN["runtimeRoot"])
        self.assertEqual(
            hashlib.sha256(documents["runtime-candidate.json"]).hexdigest(),
            REPLAY.PIN["candidateReceiptSha256"],
        )
        self.assertEqual(len(details[2]), 57823)
        self.assertFalse(details[4])

    def test_preexisting_fixed_root_is_not_claimed_or_removed(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "existing"
            root.mkdir()
            sentinel = root / "foreign"
            sentinel.write_bytes(b"preserve")
            with self.assertRaisesRegex(ValueError, "already exists"):
                REPLAY.stage(
                    Path(folder) / "absent.zip", Path(folder) / "evidence", root
                )
            self.assertEqual(sentinel.read_bytes(), b"preserve")
            self.assertFalse((Path(folder) / "evidence").exists())

    def test_extractor_reports_ownership_only_after_its_own_creation(self):
        data = b"finished bytes"
        packed = io.BytesIO()
        with tarfile.open(fileobj=packed, mode="w:gz") as archive:
            directory = tarfile.TarInfo("runtime")
            directory.type = tarfile.DIRTYPE
            archive.addfile(directory)
            member = tarfile.TarInfo("runtime/file")
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
        payload = packed.getvalue()
        outer = io.BytesIO()
        with zipfile.ZipFile(outer, "w") as archive:
            archive.writestr("runtime.tar.gz", payload)
        details = (
            {
                "archive": {
                    "bytes": len(payload),
                    "sha256": hashlib.sha256(payload).hexdigest(),
                }
            },
            {},
            {
                "runtime/file": {
                    "bytes": len(data),
                    "sha256": hashlib.sha256(data).hexdigest(),
                }
            },
            {"runtime"},
            {},
            "runtime.tar.gz",
        )
        with (
            tempfile.TemporaryDirectory() as folder,
            zipfile.ZipFile(io.BytesIO(outer.getvalue())) as archive,
        ):
            REPLAY.OWNER.verify_members(archive, details)
            root = Path(folder) / "root"
            claimed = []
            REPLAY.OWNER.extract_verified(
                archive, details, root, created=lambda p: claimed.append(p)
            )
            self.assertEqual(claimed, [root])
            self.assertEqual((root / "file").read_bytes(), data)
            with self.assertRaisesRegex(ValueError, "must be fresh"):
                REPLAY.OWNER.extract_verified(
                    archive, details, root, created=lambda p: claimed.append(p)
                )
            self.assertEqual(claimed, [root])

    def test_full_inventory_detects_changes(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "file").write_bytes(b"abc")
            expected = {
                "files": [
                    {
                        "path": "file",
                        "bytes": 3,
                        "sha256": hashlib.sha256(b"abc").hexdigest(),
                    }
                ],
                "directories": [],
            }
            self.assertEqual(REPLAY.verify_runtime(root, expected)["files"], 1)
            (root / "file").write_bytes(b"abd")
            with self.assertRaisesRegex(ValueError, "original full inventory"):
                REPLAY.verify_runtime(root, expected)


if __name__ == "__main__":
    unittest.main()
