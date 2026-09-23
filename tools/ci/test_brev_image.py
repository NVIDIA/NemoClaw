# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Candidate transfer must retain the exact source and immutable image identity."""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import brev_image


class CandidateImage(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / "image.tar").write_bytes(b"candidate archive")
        self.revision = "a" * 40
        (self.root / "metadata.json").write_text(
            json.dumps({"openclaw": {"containerimage.digest": "sha256:" + "b" * 64}})
        )
        self.digest = "nc-fabric@sha256:" + "b" * 64
        self.inspection = [
            {"RepoDigests": [self.digest], "Os": "linux", "Architecture": "amd64"}
        ]
        self.docker = patch.object(
            brev_image.subprocess,
            "check_output",
            return_value=json.dumps(self.inspection).encode(),
        ).start()
        self.addCleanup(patch.stopall)

    def record(self):
        brev_image.record(self.root, self.revision)

    def test_archive_roundtrip_preserves_revision_and_digest(self):
        self.record()
        with patch.object(brev_image.subprocess, "run") as load:
            self.assertEqual(brev_image.load(self.root, self.revision), self.digest)
            load.assert_called_once()

    def test_corrupt_archive_is_rejected_before_docker_load(self):
        self.record()
        (self.root / "image.tar").write_bytes(b"substituted")
        with patch.object(brev_image.subprocess, "run") as load:
            with self.assertRaises(ValueError):
                brev_image.load(self.root, self.revision)
            load.assert_not_called()

    def test_different_source_revision_is_rejected_before_docker_load(self):
        self.record()
        with patch.object(brev_image.subprocess, "run") as load:
            with self.assertRaises(ValueError):
                brev_image.load(self.root, "c" * 40)
            load.assert_not_called()

    def test_loaded_tag_must_resolve_to_recorded_digest(self):
        self.record()
        self.inspection[0]["RepoDigests"] = ["nc-fabric@sha256:" + "d" * 64]
        self.docker.return_value = json.dumps(self.inspection).encode()
        with patch.object(brev_image.subprocess, "run"), self.assertRaises(ValueError):
            brev_image.load(self.root, self.revision)

    def test_wrong_loaded_architecture_is_rejected(self):
        self.record()
        self.inspection[0]["Architecture"] = "arm64"
        self.docker.return_value = json.dumps(self.inspection).encode()
        with patch.object(brev_image.subprocess, "run"), self.assertRaises(ValueError):
            brev_image.load(self.root, self.revision)

    def test_invalid_build_digest_cannot_be_recorded(self):
        (self.root / "metadata.json").write_text(
            json.dumps({"openclaw": {"containerimage.digest": "mutable-tag"}})
        )
        with self.assertRaises(ValueError):
            self.record()


if __name__ == "__main__":
    unittest.main()
