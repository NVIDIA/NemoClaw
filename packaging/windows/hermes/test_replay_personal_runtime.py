# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import struct
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch
import zipfile

SPEC = importlib.util.spec_from_file_location(
    "replay", Path(__file__).with_name("replay-personal-runtime.py")
)
REPLAY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(REPLAY)
PUBLIC_ACCESS = REPLAY.load("prepare-public-runtime-acl.py")


class ReplayControls(unittest.TestCase):
    def test_public_rx_diagnostic_path_is_explicit_and_keeps_default_root(self):
        class EmptyRoot:
            def __init__(self, text, contents=()):
                self.text, self.contents = text, contents

            def __str__(self):
                return self.text

            def is_symlink(self):
                return False

            def is_dir(self):
                return True

            def iterdir(self):
                return iter(self.contents)

        nonce = "0123456789ab"
        diagnostic = rf"C:\NemoClawRendererWer-{nonce}"
        original = PUBLIC_ACCESS.PUBLIC_ROOT
        environment = SimpleNamespace(
            name="nt", environ={"GITHUB_ACTIONS": "true", "GITHUB_SHA": "a" * 40}
        )
        with patch.object(PUBLIC_ACCESS, "os", environment):
            for path, options in (
                (original, {}),
                (diagnostic, {"diagnostic_nonce": nonce}),
            ):
                kernel, security, receipt = MagicMock(), MagicMock(), MagicMock()
                kernel.CreateFileW.return_value = None
                with (
                    patch.object(
                        PUBLIC_ACCESS.C,
                        "WinDLL",
                        side_effect=[kernel, security],
                        create=True,
                    ),
                    patch.object(
                        PUBLIC_ACCESS.C, "get_last_error", return_value=5, create=True
                    ),
                    patch.object(
                        PUBLIC_ACCESS.C,
                        "WinError",
                        return_value=OSError(5, "fixture-open-denied"),
                        create=True,
                    ),
                    self.assertRaisesRegex(OSError, "fixture-open-denied"),
                ):
                    PUBLIC_ACCESS.prepare(EmptyRoot(path), receipt, **options)
                kernel.CreateFileW.assert_called_once_with(
                    path, 0x60080, 3, None, 3, 0x02200000, None
                )
                record = json.loads(receipt.write_text.call_args.args[0])
                self.assertEqual(
                    record.get("diagnosticNonce"), options.get("diagnostic_nonce")
                )
                self.assertEqual("diagnosticNonce" in record, bool(options))
                self.assertEqual(record["runtimeRoot"], path)
                self.assertEqual(
                    record["sourceSha256"],
                    hashlib.sha256(
                        Path(PUBLIC_ACCESS.__file__).read_bytes()
                    ).hexdigest(),
                )
            for path, options, contents in (
                (original, {"diagnostic_nonce": nonce}, ()),
                (diagnostic, {}, ()),
                (diagnostic.replace("C:", "D:"), {"diagnostic_nonce": nonce}, ()),
                (diagnostic, {"diagnostic_nonce": nonce.upper()}, ()),
                (diagnostic, {"diagnostic_nonce": nonce + "0"}, ()),
                (diagnostic, {"diagnostic_nonce": True}, ()),
                (diagnostic, {"diagnostic_nonce": nonce}, ("existing",)),
            ):
                with (
                    patch.object(PUBLIC_ACCESS.C, "WinDLL", create=True) as native,
                    self.assertRaises(ValueError),
                ):
                    PUBLIC_ACCESS.prepare(
                        EmptyRoot(path, contents), MagicMock(), **options
                    )
                native.assert_not_called()
        self.assertEqual(PUBLIC_ACCESS.PUBLIC_ROOT, original)

    def test_public_rx_addition_preserves_existing_ace_bytes_and_order(self):
        # A prior explicit deny and inherited System grant retain their exact
        # flags/masks/SIDs. Only the new AppPackages RX ACE is inserted.
        sid = bytes.fromhex("010100000000000512000000")
        deny = struct.pack("<BBHI", 1, 0, 8 + len(sid), 2) + sid
        inherited = struct.pack("<BBHI", 0, 0x13, 8 + len(sid), 0x1F01FF) + sid
        raw = (
            struct.pack("<BBHHH", 2, 0, 8 + len(deny + inherited), 2, 0)
            + deny
            + inherited
        )
        updated = PUBLIC_ACCESS.append_public_rx(raw)
        revision, entries = PUBLIC_ACCESS.acl_entries(updated)
        self.assertEqual(revision, 2)
        self.assertEqual(entries, [deny, PUBLIC_ACCESS.RX_ACE, inherited])
        self.assertEqual(
            PUBLIC_ACCESS.RX_ACE[:8], struct.pack("<BBHI", 0, 3, 24, 0x1200A9)
        )
        before = {
            "ownerSidHex": "owner",
            "groupSidHex": "group",
            "revision": 1,
            "control": 0x8004,
        }
        after = {**before, "control": 0x8404, "acesHex": [ace.hex() for ace in entries]}
        PUBLIC_ACCESS.verify_delta(before, after, updated)
        for changed in (
            {"control": 0x9404},
            {"ownerSidHex": "other"},
            {"acesHex": list(reversed(after["acesHex"]))},
        ):
            with self.assertRaisesRegex(ValueError, "one-ACE"):
                PUBLIC_ACCESS.verify_delta(before, {**after, **changed}, updated)
        with self.assertRaisesRegex(ValueError, "already has"):
            PUBLIC_ACCESS.append_public_rx(updated)
        with self.assertRaisesRegex(ValueError, "truncated"):
            PUBLIC_ACCESS.acl_entries(
                raw[:2] + struct.pack("<H", len(raw) - 4) + raw[4:-4]
            )

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

            def before_contents(path):
                self.assertTrue(path.is_dir())
                self.assertEqual(list(path.iterdir()), [])
                claimed.append(path)

            REPLAY.OWNER.extract_verified(
                archive, details, root, created=before_contents
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
