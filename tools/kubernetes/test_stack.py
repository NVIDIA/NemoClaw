# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Deterministic safety tests; these never contact Docker or Kubernetes."""

import base64
import copy
import hashlib
import importlib.util
import io
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SPEC = importlib.util.spec_from_file_location("stack", Path(__file__).with_name("stack.py"))
stack = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(stack)


class OwnershipTests(unittest.TestCase):
    def setUp(self):
        self.binding = {
            "context": "kind-nemoclaw-v1-test1234",
            "server": "https://127.0.0.1:12345",
            "ca": "cluster-ca",
        }
        self.receipt = {
            "cluster": "nemoclaw-v1-test1234",
            "binding": self.binding,
            "nodes": {"nemoclaw-v1-test1234-control-plane": "node-id"},
            "system_uid": "system-uid",
        }

    def test_matching_identity_permits_access(self):
        stack.check_identity(self.receipt, self.binding, self.receipt["nodes"], "system-uid")

    def test_changed_context_server_or_ca_rejects_access(self):
        for key in self.binding:
            changed = dict(self.binding, **{key: "changed"})
            with self.subTest(key=key), self.assertRaises(stack.Error):
                stack.check_identity(self.receipt, changed, self.receipt["nodes"], "system-uid")

    def test_same_name_replacement_rejects_access(self):
        for nodes, uid in [
            ({"nemoclaw-v1-test1234-control-plane": "new-id"}, "system-uid"),
            (self.receipt["nodes"], "replacement"),
        ]:
            with self.assertRaises(stack.Error):
                stack.check_identity(self.receipt, self.binding, nodes, uid)

    def test_wrong_cluster_name_or_non_loopback_server_rejects(self):
        for value in ["production", "rancher-desktop", "nemoclaw-v1-test1234;id"]:
            with self.assertRaises(stack.Error):
                stack.check_cluster_name(value)
        changed = copy.deepcopy(self.receipt)
        changed["binding"]["server"] = "https://cluster.example.com:6443"
        with self.assertRaises(stack.Error):
            stack.check_identity(changed, changed["binding"], changed["nodes"], "system-uid")

    def test_state_inside_repository_is_rejected(self):
        with self.assertRaises(stack.Error):
            stack.check_state_path(stack.REPO / ".private-state")

    def test_state_symlink_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "target"
            target.mkdir()
            link = Path(tmp) / "link"
            link.symlink_to(target)
            with self.assertRaises(stack.Error):
                stack.check_state_path(link)

    def test_cleanup_uses_only_the_owned_kubeconfig(self):
        with tempfile.TemporaryDirectory() as directory:
            instance = stack.Stack(Path(directory))
            instance.receipt = dict(self.receipt, phase="ready")
            with (
                mock.patch.object(instance, "guard") as guard,
                mock.patch.object(stack, "run") as run,
            ):
                instance.cleanup(self.receipt["cluster"])
            guard.assert_called_once_with()
            run.assert_called_once_with(
                [
                    "kind",
                    "delete",
                    "cluster",
                    "--name",
                    self.receipt["cluster"],
                    "--kubeconfig",
                    str(instance.kubeconfig),
                ]
            )


class RenderTests(unittest.TestCase):
    def test_prepare_replaces_modified_chart_and_removes_extra_cached_templates(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            instance = stack.Stack(state)
            cache = state / "sources"
            cache.mkdir(mode=0o700)
            chart = cache / stack.LOCK["openshell"]["directory"] / "deploy/helm/openshell"
            (chart / "templates").mkdir(parents=True)
            (chart / "templates/extra.yaml").write_text("kind: Namespace\n")
            (chart / "Chart.yaml").write_text("modified cache\n")
            verified = b"apiVersion: v2\nname: openshell\nversion: 0.0.0\n"
            archive_bytes = io.BytesIO()
            with tarfile.open(fileobj=archive_bytes, mode="w:gz") as archive:
                member = tarfile.TarInfo(
                    stack.LOCK["openshell"]["directory"] + "/deploy/helm/openshell/Chart.yaml"
                )
                member.size = len(verified)
                archive.addfile(member, io.BytesIO(verified))
            archive_data = archive_bytes.getvalue()
            (cache / "openshell.tar.gz").write_bytes(archive_data)
            sources = copy.deepcopy(stack.LOCK)
            sources["openshell"]["sha256"] = hashlib.sha256(archive_data).hexdigest()
            for name in ["agentSandbox", "calico"]:
                manifest = b"kind: List\nitems: []\n"
                (cache / (name + ".yaml")).write_bytes(manifest)
                sources[name]["sha256"] = hashlib.sha256(manifest).hexdigest()
            with (
                mock.patch.dict(stack.LOCK, sources),
                mock.patch.object(
                    stack.urllib.request,
                    "urlopen",
                    side_effect=AssertionError("unexpected network access"),
                ),
            ):
                instance.prepare()
            self.assertEqual(instance.chart, chart)
            self.assertEqual((chart / "Chart.yaml").read_bytes(), verified)
            self.assertFalse((chart / "templates/extra.yaml").exists())

    def test_key_encryption_secret_contains_base64_text_for_environment(self):
        data = stack.key_encryption_secret()["data"]["key-encryption-key"]
        value = base64.b64decode(data).decode("ascii")
        self.assertEqual(len(base64.b64decode(value, validate=True)), 32)

    def test_chart_values_preserve_tls_and_immutable_images(self):
        values = stack.chart_values()
        self.assertFalse(values["server"]["disableTls"])
        self.assertFalse(values["server"]["auth"]["allowUnauthenticatedUsers"])
        self.assertTrue(values["server"]["tls"]["enableMtls"])
        self.assertFalse(values["server"]["telemetryEnabled"])
        self.assertTrue(values["supervisor"]["sandboxRuntime"]["networkPolicyEnforced"])
        for image in [
            values["image"],
            values["supervisor"]["image"],
            values["sandboxRuntime"]["image"],
        ]:
            self.assertIn("@sha256:", image["tag"])
        self.assertEqual(values["server"]["credentialStorage"]["existingSecret"], "nemoclaw-kek")

    def test_artifact_digest_mismatch_is_rejected(self):
        with self.assertRaises(stack.Error):
            stack.verify_bytes(b"modified", "0" * 64)

    def test_unrecognized_prerequisite_image_rejects_render(self):
        with self.assertRaises(stack.Error):
            stack.pin_manifest_images(b"  image: unknown:latest\n")

    def test_prerequisite_images_are_digest_selected(self):
        for image, digest in stack.LOCK["dependencyImages"].items():
            self.assertEqual(
                stack.pin_manifest_images(("  image: " + image + "\n").encode()),
                ("  image: " + image + "@" + digest + "\n").encode(),
            )


if __name__ == "__main__":
    unittest.main()
