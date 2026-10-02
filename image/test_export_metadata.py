# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Offline OCI archive proofs; no Docker daemon, registry, or cluster calls."""

import hashlib
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from image import export_metadata as export


def blob(value):
    raw = json.dumps(value, indent=2).encode() + b"\n"
    return "sha256:" + hashlib.sha256(raw).hexdigest(), raw


def fixture(index=True, architecture="amd64"):
    config, config_raw = blob(
        {
            "os": "linux",
            "architecture": architecture,
            "config": {"Labels": {"io.nemoclaw.fabric.catalog": '{"runtime":{}}'}},
        }
    )
    manifest, manifest_raw = blob(
        {
            "schemaVersion": 2,
            "mediaType": export.MANIFEST_TYPES[0],
            "config": {
                "mediaType": "application/vnd.oci.image.config.v1+json",
                "digest": config,
                "size": len(config_raw),
            },
            "layers": [{"digest": "sha256:" + "f" * 64, "size": 1000000}],
        }
    )
    blobs = {config: config_raw, manifest: manifest_raw}
    root = manifest
    if index:
        root, raw = blob(
            {
                "schemaVersion": 2,
                "mediaType": export.INDEX_TYPES[0],
                "manifests": [
                    {
                        "mediaType": export.MANIFEST_TYPES[0],
                        "digest": manifest,
                        "size": len(manifest_raw),
                        "platform": {"os": "linux", "architecture": architecture},
                    }
                ],
            }
        )
        blobs[root] = raw
    return "fixture/agent@" + root, manifest, config, blobs


def archive(blobs, extra=()):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w") as tar:
        for digest, raw in blobs.items():
            name = "blobs/sha256/" + digest.removeprefix("sha256:")
            member = tarfile.TarInfo(name)
            member.size = len(raw)
            tar.addfile(member, io.BytesIO(raw))
        for name, raw in extra:
            member = tarfile.TarInfo(name)
            member.size = len(raw)
            tar.addfile(member, io.BytesIO(raw))
    output.seek(0)
    return output


class MetadataExport(unittest.TestCase):
    def test_preserves_exact_manifest_index_config_and_excludes_layers(self):
        for indexed in [False, True]:
            image, manifest, config, blobs = fixture(indexed)
            proof = export.metadata_bundle(
                image, archive(blobs, [("layers/layer.tar", b"layer")]), "linux/amd64", config
            )
            self.assertEqual(proof["schema_version"], 1)
            self.assertEqual(proof["manifest_digest"], manifest)
            self.assertEqual(proof["blobs"], {key: raw.decode() for key, raw in blobs.items()})
            self.assertNotIn("layer.tar", json.dumps(proof))

    def test_rejects_missing_original_bytes_or_substituted_content(self):
        image, _, _, blobs = fixture()
        for digest in blobs:
            missing = dict(blobs)
            del missing[digest]
            with self.assertRaises(export.Error):
                export.metadata_bundle(image, archive(missing), "linux/amd64")
            corrupted = {**blobs, digest: b'{"secret-sentinel": true}'}
            with self.assertRaises(export.Error) as failure:
                export.metadata_bundle(image, archive(corrupted), "linux/amd64")
            self.assertNotIn("secret-sentinel", str(failure.exception))

    def test_requires_immutable_reference_and_matching_platform_and_config(self):
        image, _, _, blobs = fixture()
        for reference, platform, config in [
            ("fixture/agent:latest", "linux/amd64", None),
            (image, "linux/arm64", None),
            (image, "linux/amd64", "sha256:" + "0" * 64),
        ]:
            with self.assertRaises(export.Error):
                export.metadata_bundle(reference, archive(blobs), platform, config)

    def test_local_image_identity_accepts_containerd_index_or_legacy_config(self):
        image, manifest, config, blobs = fixture()
        for identity in [image.split("@", 1)[1], manifest, config]:
            proof = export.metadata_bundle(image, archive(blobs), "linux/amd64", identity)
            self.assertEqual(proof["manifest_digest"], manifest)

    def test_index_rejects_ambiguous_matching_children_and_wrong_child_size(self):
        image, _, _, blobs = fixture()
        root = image.split("@", 1)[1]
        for duplicate in [True, False]:
            value = json.loads(blobs[root])
            if duplicate:
                value["manifests"].append(value["manifests"][0])
            else:
                value["manifests"][0]["size"] += 1
            digest, raw = blob(value)
            changed = {key: raw_value for key, raw_value in blobs.items() if key != root}
            changed[digest] = raw
            with self.assertRaises(export.Error):
                export.metadata_bundle("fixture/agent@" + digest, archive(changed), "linux/amd64")

    def test_index_rejects_another_linux_architecture_but_permits_attestations(self):
        image, _, _, blobs = fixture()
        root = image.split("@", 1)[1]
        _, other_manifest, _, other_blobs = fixture(False, "arm64")
        for operating_system in ["linux", "unknown"]:
            value = json.loads(blobs[root])
            value["manifests"].append(
                {
                    "mediaType": export.MANIFEST_TYPES[0],
                    "digest": other_manifest,
                    "size": len(other_blobs[other_manifest]),
                    "platform": {
                        "os": operating_system,
                        "architecture": "arm64" if operating_system == "linux" else "unknown",
                    },
                }
            )
            digest, raw = blob(value)
            changed = {key: entry for key, entry in blobs.items() if key != root}
            changed.update(other_blobs)
            changed[digest] = raw
            reference = "fixture/agent@" + digest
            if operating_system == "linux":
                with self.assertRaises(export.Error):
                    export.metadata_bundle(reference, archive(changed), "linux/amd64")
            else:
                proof = export.metadata_bundle(reference, archive(changed), "linux/amd64")
                self.assertEqual(len(proof["blobs"]), 3)
                self.assertNotIn(other_manifest, proof["blobs"])

    def test_archive_paths_never_extract_files_or_supply_a_missing_blob(self):
        image, _, config, blobs = fixture()
        raw = blobs.pop(config)
        with self.assertRaises(export.Error):
            export.metadata_bundle(
                image, archive(blobs, [("../blobs/sha256/" + config[7:], raw)]), "linux/amd64"
            )

    def test_output_is_private_and_never_overwrites_existing_file(self):
        image, _, _, blobs = fixture()
        proof = export.metadata_bundle(image, archive(blobs), "linux/amd64")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "metadata.json"
            export.write_bundle(path, proof)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(path.read_text()), proof)
            with self.assertRaises(export.Error):
                export.write_bundle(path, proof)
            self.assertEqual(json.loads(path.read_text()), proof)

    def test_archive_without_original_oci_manifest_fails_instead_of_reconstructing(self):
        image, _, config, blobs = fixture(False)
        legacy = archive(
            {},
            [
                (config[7:] + ".json", blobs[config]),
                ("manifest.json", b'[{"Config":"image.json","Layers":[]}]'),
            ],
        )
        with self.assertRaisesRegex(export.Error, "original.*metadata"):
            export.metadata_bundle(image, legacy, "linux/amd64")

    def test_local_inspection_uses_only_the_selected_docker_authority(self):
        image, _, config, _ = fixture()
        with patch(
            "subprocess.run",
            return_value=Mock(
                returncode=0,
                stdout=json.dumps(
                    [{"Os": "linux", "Architecture": "arm64", "Id": config}]
                ).encode(),
            ),
        ) as command:
            self.assertEqual(
                export.inspect_local(image, ["sudo", "-n", "docker"]), ("linux/arm64", config)
            )
        self.assertEqual(
            command.call_args.args[0], ["sudo", "-n", "docker", "image", "inspect", image]
        )

    def test_mutable_cli_input_stops_before_docker_or_output(self):
        with (
            patch(
                "sys.argv",
                [
                    "export_metadata.py",
                    "--image",
                    "fixture/agent:latest",
                    "--output",
                    "/tmp/no-metadata",
                ],
            ),
            patch("subprocess.run") as command,
            patch("subprocess.Popen") as process,
            patch("sys.stderr", io.StringIO()),
        ):
            self.assertEqual(export.main(), 1)
        command.assert_not_called()
        process.assert_not_called()

    def test_missing_descriptor_size_or_schema_cannot_be_accepted(self):
        image, _, _, blobs = fixture()
        root = image.split("@", 1)[1]
        for field in ["schemaVersion", "size"]:
            value = json.loads(blobs[root])
            if field == "size":
                del value["manifests"][0][field]
            else:
                value[field] = 1
            digest, raw = blob(value)
            changed = {key: entry for key, entry in blobs.items() if key != root}
            changed[digest] = raw
            with self.assertRaises(export.Error):
                export.metadata_bundle("fixture/agent@" + digest, archive(changed), "linux/amd64")

    def test_repository_output_is_rejected_without_creating_a_file(self):
        with self.assertRaises(export.Error):
            export.write_bundle(export.ROOT / "uncommitted-image-metadata.json", {})
        self.assertFalse((export.ROOT / "uncommitted-image-metadata.json").exists())

    def test_invalid_manifest_contracts_fail_during_export(self):
        _, manifest, _, blobs = fixture(False)
        for change in ["layers", "config_type"]:
            value = json.loads(blobs[manifest])
            if change == "layers":
                del value["layers"]
            else:
                value["config"]["mediaType"] = "application/x-unknown"
            digest, raw = blob(value)
            changed = {key: entry for key, entry in blobs.items() if key != manifest}
            changed[digest] = raw
            with self.assertRaises(export.Error):
                export.metadata_bundle("fixture/agent@" + digest, archive(changed), "linux/amd64")

    def test_index_descriptor_type_must_match_the_selected_manifest(self):
        image, _, _, blobs = fixture()
        root = image.split("@", 1)[1]
        value = json.loads(blobs[root])
        value["manifests"][0]["mediaType"] = export.MANIFEST_TYPES[1]
        digest, raw = blob(value)
        changed = {key: entry for key, entry in blobs.items() if key != root}
        changed[digest] = raw
        with self.assertRaises(export.Error):
            export.metadata_bundle("fixture/agent@" + digest, archive(changed), "linux/amd64")


if __name__ == "__main__":
    unittest.main()
