# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Candidate transfer must retain the exact source and immutable image identity."""

import json
import runpy
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import brev_image


ROOT = Path(__file__).resolve().parents[2]


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
        self.catalog = {"runtime": {
            "command": ["/usr/local/bin/fabric-agent"],
            "binaries": {"nvidia.fabric.openclaw": ["/usr/local/bin/openclaw"]},
        }}
        self.inspection = [
            {"RepoDigests": [self.digest], "Os": "linux", "Architecture": "amd64",
             "Config": {"Labels": {"io.nemoclaw.fabric.catalog": json.dumps(self.catalog)}}}
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

    def test_oci_export_labels_the_installed_catalog_before_recording_digest(self):
        self.docker.side_effect = [
            json.dumps({"target": {"openclaw": {"tags": ["nc-fabric:openclaw"]}}}).encode(),
            json.dumps(self.catalog).encode(),
        ]
        with patch.object(sys, "argv", [
            "build_fabric.py", "--platform", "linux/amd64", "--output",
            "type=oci,dest=candidate/image.tar", "--metadata-file", "candidate/metadata.json",
            "openclaw",
        ]), patch.object(brev_image.subprocess, "run") as run:
            runpy.run_path(str(ROOT / "image/build_fabric.py"), run_name="__main__")
        exports = [c.args[0] for c in run.call_args_list if "openclaw.output=type=oci,dest=candidate/image.tar" in c.args[0]]
        self.assertEqual(len(exports), 1)
        export = exports[0]
        label = next(v for v in export if v.startswith("openclaw.labels.io.nemoclaw.fabric.catalog="))
        self.assertEqual(json.loads(label.split("=", 1)[1]), self.catalog)
        self.assertEqual(export[export.index("--metadata-file") + 1], "candidate/metadata.json")
        discovery = self.docker.call_args_list[1].args[0]
        self.assertIn("--network=none", discovery)
        self.assertIn("--installed", discovery)

    def test_loaded_image_requires_openclaw_runtime_metadata(self):
        self.record()
        for catalog in (None, "invalid json", "{}", '{"runtime":{"binaries":{}}}'):
            with self.subTest(catalog=catalog):
                self.inspection[0]["Config"]["Labels"] = (
                    {} if catalog is None else {"io.nemoclaw.fabric.catalog": catalog}
                )
                self.docker.return_value = json.dumps(self.inspection).encode()
                with patch.object(brev_image.subprocess, "run"), self.assertRaises(ValueError):
                    brev_image.load(self.root, self.revision)
                self.assertFalse((self.root / "image-ref").exists())

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
