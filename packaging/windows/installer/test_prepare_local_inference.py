# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Candidate engine admission controls; fixture PE headers are never executed."""

import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import warnings
import zipfile

from prepare_local_inference import REQUIRED, prepare


class PrepareLocalInference(unittest.TestCase):
    def setUp(self):
        fixture = tempfile.TemporaryDirectory()
        self.addCleanup(fixture.cleanup)
        self.root = Path(fixture.name)
        self.bundle = self.root / "fixture.msix"
        self.output = self.root / "managed"
        self.engine = {
            "version": "fixture",
            "architecture": "arm64",
            "backend": "cuda",
            "packageIdentity": "Fixture.Inference",
            "packageVersion": "1.0.0.0",
            "sourceRevision": "a" * 40,
            "prefix": "app/engine/",
        }
        pe = bytearray(256)
        pe[:2] = b"MZ"
        pe[60:64] = (128).to_bytes(4, "little")
        pe[128:134] = b"PE\0\0\x64\xaa"
        self.entries = [
            ("AppxManifest.xml",
             b'<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10">'
             b'<Identity Name="Fixture.Inference" Version="1.0.0.0" ProcessorArchitecture="arm64"/>'
             b'</Package>'),
            ("app/resources/agent-payload/manifest.json",
             json.dumps({"ref": self.engine["sourceRevision"], "target": "win32-arm64"}).encode()),
            *[(self.engine["prefix"] + name, bytes(pe)) for name in sorted(REQUIRED)],
        ]

    def write_bundle(self):
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            with zipfile.ZipFile(self.bundle, "w") as archive:
                for name, data in self.entries:
                    archive.writestr(name, data)
        self.engine["bundleBytes"] = self.bundle.stat().st_size
        self.engine["bundleSha256"] = hashlib.sha256(self.bundle.read_bytes()).hexdigest()
        return {"engine": self.engine}

    def test_candidate_receipt_keeps_distribution_and_qualification_unapproved(self):
        receipt = prepare(self.bundle, self.output, self.write_bundle())
        self.assertFalse(receipt["signatureVerified"])
        self.assertFalse(receipt["redistributionApproved"])
        self.assertEqual(receipt["qualification"], "not-run")
        self.assertFalse(receipt["modelsBundled"])
        self.assertEqual({row["path"] for row in receipt["files"]},
                         {"bin/" + name for name in REQUIRED})
        for row in receipt["files"]:
            data = (self.output / row["path"]).read_bytes()
            self.assertEqual(len(data), row["bytes"])
            self.assertEqual(hashlib.sha256(data).hexdigest(), row["sha256"])
        self.assertEqual(json.loads((self.output / "runtime.json").read_text()), receipt)

    def test_substituted_bundle_is_rejected_without_output(self):
        catalog = self.write_bundle()
        catalog["engine"]["bundleSha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "pinned size or SHA"):
            prepare(self.bundle, self.output, catalog)
        self.assertFalse(self.output.exists())

    def test_package_and_payload_identities_must_match_even_with_valid_digest(self):
        catalog = self.write_bundle()
        for field in ["packageIdentity", "packageVersion", "architecture", "sourceRevision"]:
            with self.subTest(field=field):
                changed = {"engine": {**catalog["engine"], field: "foreign"}}
                with self.assertRaisesRegex(ValueError, "identity|revision"):
                    prepare(self.bundle, self.output, changed)
                self.assertFalse(self.output.exists())

    def test_unsafe_and_case_alias_entries_are_rejected(self):
        for name in ["../escape.dll", "nested/escape.dll", "LLAMA.DLL"]:
            with self.subTest(name=name):
                self.entries.append((self.engine["prefix"] + name, b"invalid"))
                catalog = self.write_bundle()
                with self.assertRaisesRegex(ValueError, "unsafe or duplicate"):
                    prepare(self.bundle, self.output, catalog)
                self.assertFalse(self.output.exists())
                self.entries.pop()
        self.assertFalse((self.root / "escape.dll").exists())

    def test_duplicate_archive_entry_is_rejected(self):
        self.entries.append(self.entries[-1])
        catalog = self.write_bundle()
        with self.assertRaisesRegex(ValueError, "duplicate entries"):
            prepare(self.bundle, self.output, catalog)
        self.assertFalse(self.output.exists())

    def test_missing_cuda_dependency_is_rejected(self):
        self.entries = [row for row in self.entries if not row[0].endswith("/ggml-cuda.dll")]
        catalog = self.write_bundle()
        with self.assertRaisesRegex(ValueError, "incomplete"):
            prepare(self.bundle, self.output, catalog)
        self.assertFalse(self.output.exists())

    def test_wrong_architecture_removes_only_fresh_partial_output(self):
        name, data = self.entries[-1]
        wrong = bytearray(data)
        wrong[132:134] = b"\x64\x86"
        self.entries[-1] = (name, wrong)
        catalog = self.write_bundle()
        sentinel = self.root / "preserved.txt"
        sentinel.write_text("preserve")
        with self.assertRaisesRegex(ValueError, "not native ARM64"):
            prepare(self.bundle, self.output, catalog)
        self.assertFalse(self.output.exists())
        self.assertTrue(self.bundle.is_file())
        self.assertEqual(sentinel.read_text(), "preserve")

    def test_existing_output_is_never_replaced_or_cleaned(self):
        catalog = self.write_bundle()
        self.output.mkdir()
        saved = self.output / "saved.txt"
        saved.write_text("existing")
        with self.assertRaisesRegex(ValueError, "must be fresh"):
            prepare(self.bundle, self.output, catalog)
        self.assertEqual(saved.read_text(), "existing")


if __name__ == "__main__":
    unittest.main()
