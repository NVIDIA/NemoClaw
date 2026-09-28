# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Portable platform contract tests; commands never contact a cluster."""

import base64
import copy
import gzip
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

MODULE = importlib.util.spec_from_file_location(
    "managed_platform", Path(__file__).with_name("platform.py")
)
platform = importlib.util.module_from_spec(MODULE)
sys.modules[MODULE.name] = platform
MODULE.loader.exec_module(platform)


def spec(kind="kubernetes_storage"):
    return {
        "layout": 1,
        "kind": kind,
        "owner": "11111111-2222-4333-8444-555555555555",
        "generation": "a" * 32,
        "name": "nc-0123456789abcdef-gateway",
        "settings": {
            "endpoint": "https://127.0.0.1:17672",
            "kubernetes": {
                "kubeconfig": {"env": "TEST_KUBECONFIG"},
                "context": "explicit-context",
                "namespace": "owned-namespace",
                "prerequisites": {"agentSandbox": {"management": "managed"}},
                "authentication": {"profile": "development"},
            },
        },
    }


class PlatformTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.state = Path(self.directory.name)
        self.kubeconfig = self.state / "input-kubeconfig"
        self.kubeconfig.write_text("private fixture")
        self.kubeconfig.chmod(0o600)
        self.environment = patch.dict(os.environ, {"TEST_KUBECONFIG": str(self.kubeconfig)})
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def client(self, kind="kubernetes_storage", action="read", **extra):
        return platform.Platform(
            {"action": action, "spec": spec(kind), "stateDirectory": str(self.state), **extra}
        )

    def test_context_is_explicit_for_every_kubernetes_command(self):
        client = self.client()
        with patch.object(client, "command", return_value="{}") as command:
            client.kubectl("get", "namespace", "kube-system", "-o", "json")
        args = command.call_args.args[0]
        self.assertEqual(
            args[:5],
            ["kubectl", "--kubeconfig", str(self.kubeconfig), "--context", "explicit-context"],
        )

    def test_changed_cluster_identity_fails_before_any_mutation(self):
        client = self.client()
        client.receipt = {"binding": {"server": "old", "ca": "old", "systemUid": "old"}}
        with (
            patch.object(
                client,
                "cluster_binding",
                return_value={"server": "new", "ca": "new", "systemUid": "new"},
            ),
            patch.object(client, "create") as create,
        ):
            with self.assertRaisesRegex(platform.Error, "binding"):
                client.check_cluster()
            create.assert_not_called()

    def test_unbound_existing_namespace_is_not_adopted(self):
        client = self.client(action="ensure")
        with (
            patch.object(client, "get", return_value={"metadata": {"uid": "foreign"}}),
            patch.object(client, "create") as create,
        ):
            with self.assertRaisesRegex(platform.Error, "binding"):
                client.namespace(ensure=True)
            create.assert_not_called()

    def test_bound_missing_object_is_not_recreated(self):
        client = self.client(action="ensure")
        obj = {
            "apiVersion": "v1",
            "kind": "Secret",
            "metadata": {"name": "key", "namespace": client.namespace_name},
        }
        client.receipt = {
            "generations": {platform.STORAGE: "a" * 32},
            "objects": {platform.object_key(obj): {"uid": "original", "object": obj}},
        }
        with (
            patch.object(client, "get", return_value=None),
            patch.object(client, "create") as create,
        ):
            with self.assertRaisesRegex(platform.Error, "binding"):
                client.ensure_object(obj)
            create.assert_not_called()

    def test_substituted_object_uid_is_rejected(self):
        client = self.client()
        obj = {
            "apiVersion": "v1",
            "kind": "Secret",
            "metadata": {"name": "key", "namespace": client.namespace_name},
        }
        client.receipt = {
            "generations": {platform.STORAGE: "a" * 32},
            "objects": {platform.object_key(obj): {"uid": "original", "object": obj}},
        }
        with patch.object(client, "get", return_value={"metadata": {"uid": "substitute"}}):
            with self.assertRaisesRegex(platform.Error, "binding"):
                client.ensure_object(obj)

    def test_command_errors_never_include_output(self):
        client = self.client()
        result = type(
            "Result", (), {"returncode": 1, "stdout": "private-secret", "stderr": "private-secret"}
        )()
        with patch("managed_platform.subprocess.run", return_value=result):
            with self.assertRaises(platform.Error) as error:
                client.command(["kubectl", "get", "secret"])
            self.assertEqual(str(error.exception), "command")

    def test_json_stream_decodes_manifest_objects(self):
        self.assertEqual(
            platform.json_objects('{"kind":"Namespace"}\n{"kind":"Secret"}'),
            [{"kind": "Namespace"}, {"kind": "Secret"}],
        )

    def test_keK_value_has_expected_environment_encoding(self):
        value = platform.key_encryption_secret("key", "ns")["data"]["key-encryption-key"]
        self.assertEqual(len(base64.b64decode(base64.b64decode(value), validate=True)), 32)

    def test_checksum_mismatch_is_rejected(self):
        with self.assertRaisesRegex(platform.Error, "configuration"):
            platform.verify_bytes(b"modified", "0" * 64)

    def test_retained_storage_remove_does_not_delete_objects(self):
        client = self.client(action="remove")
        with (
            patch.object(client, "read", return_value={"id": "retained"}),
            patch.object(client, "command") as command,
        ):
            self.assertEqual(client.remove(), {"id": "retained"})
            command.assert_not_called()

    def test_plan_does_not_checkpoint_pending_namespace(self):
        client = self.client()
        client.receipt = {"namespacePending": True, "generations": {platform.STORAGE: "a" * 32}}
        obj = {"metadata": {"uid": "owned", "labels": client.labels()}}
        with patch.object(client, "get", return_value=obj), patch.object(client, "save") as save:
            self.assertEqual(client.namespace(), obj)
            save.assert_not_called()

    def test_missing_prior_receipt_refuses_even_when_namespace_is_absent(self):
        with self.assertRaisesRegex(platform.Error, "binding"):
            self.client(priorId="already-bound")

    def test_gateway_identity_does_not_depend_on_disposable_statefulset(self):
        client = self.client(platform.GATEWAY)
        client.receipt = {"storageId": "storage", "generations": {platform.GATEWAY: "a" * 32}}
        first = client.gateway_id()
        client.receipt["statefulsetUid"] = "replacement-after-complete-destroy"
        self.assertEqual(client.gateway_id(), first)

    def test_template_objects_use_release_namespace(self):
        client = self.client(platform.GATEWAY)
        observed = client.chart_objects(
            [
                {"kind": "StatefulSet", "metadata": {"name": client.name}},
                {"kind": "ClusterRole", "metadata": {"name": "cluster-role"}},
            ]
        )
        self.assertEqual(observed[0]["metadata"]["namespace"], client.namespace_name)
        self.assertNotIn("namespace", observed[1]["metadata"])

    def test_removed_gateway_accepts_completed_prior_binding(self):
        client = self.client(platform.GATEWAY)
        client.request["priorId"] = "old"
        client.receipt = {"gatewayPhase": "removed"}
        self.assertEqual(client.prior({"id": None}), {"id": None})

    def test_api_omits_empty_policy_fields_without_changing_deny_semantics(self):
        desired = {"spec": {"podSelector": {}, "policyTypes": ["Egress"], "egress": []}}
        observed = {"spec": {"policyTypes": ["Egress"]}}
        self.assertEqual(platform.project(observed, platform.shape(desired)), desired)
        with self.assertRaisesRegex(platform.Error, "binding"):
            platform.project({"spec": {}}, platform.shape(desired))

    @staticmethod
    def release_secret(client, release):
        encoded = base64.b64encode(gzip.compress(json.dumps(release).encode()))
        return {
            "metadata": {"name": "release.v1", "uid": "release-uid"},
            "type": "helm.sh/release.v1",
            "data": {"release": base64.b64encode(encoded).decode()},
        }

    @staticmethod
    def release(client):
        return {
            "name": client.name,
            "namespace": client.namespace_name,
            "version": 1,
            "info": {"status": "deployed", "description": "Install complete"},
            "chart": {"metadata": {"name": "openshell"}},
            "config": {"server": {"disableTls": False}},
            "manifest": "owned chart manifest",
            "hooks": [{"name": "certgen", "manifest": "owned hook", "last_run": {}}],
        }

    def test_changed_release_payload_with_same_uid_blocks_uninstall(self):
        for field, replacement in (
            ("manifest", "foreign persistent volume claim"),
            ("config", {"server": {"disableTls": True}}),
            ("hooks", [{"name": "foreign", "manifest": "foreign delete hook"}]),
        ):
            with self.subTest(field=field):
                client = self.client(platform.GATEWAY, action="remove")
                release = self.release(client)
                secret = self.release_secret(client, release)
                with patch.object(client, "kubectl", return_value=json.dumps({"items": [secret]})):
                    saved = client.releases()
                client.receipt = {"releaseSecrets": saved, "chartObjects": []}
                release[field] = replacement
                changed = self.release_secret(client, release)
                with (
                    patch.object(client, "kubectl", return_value=json.dumps({"items": [changed]})),
                    patch.object(client, "read", return_value={"id": "gateway"}),
                    patch.object(client, "check_cluster"),
                    patch.object(client, "save"),
                    patch.object(client, "helm") as helm,
                ):
                    with self.assertRaisesRegex(platform.Error, "binding"):
                        client.remove()
                    helm.assert_not_called()

    def test_release_status_changes_preserve_uninstall_recovery_binding(self):
        client = self.client(platform.GATEWAY)
        release = self.release(client)
        secret = self.release_secret(client, release)
        with patch.object(client, "kubectl", return_value=json.dumps({"items": [secret]})):
            saved = client.releases()
        client.receipt = {
            "releaseSecrets": saved,
            "installStarted": True,
            "gatewayPhase": "removing",
        }
        release["info"] = {"status": "uninstalling", "description": "Deletion in progress"}
        release["hooks"][0]["last_run"] = {"phase": "Succeeded", "completed_at": "later"}
        secret = self.release_secret(client, release)
        with patch.object(client, "kubectl", return_value=json.dumps({"items": [secret]})):
            self.assertEqual(client.check_releases(), saved)

    def test_release_receipts_without_payload_binding_fail_closed(self):
        client = self.client(platform.GATEWAY)
        client.receipt = {
            "releaseSecrets": [{"name": "release.v1", "uid": "release-uid"}],
            "installStarted": True,
            "gatewayPhase": "ready",
        }
        secret = self.release_secret(client, self.release(client))
        with patch.object(client, "kubectl", return_value=json.dumps({"items": [secret]})):
            with self.assertRaisesRegex(platform.Error, "binding"):
                client.check_releases()

    def test_same_uid_chart_drift_blocks_resumed_uninstall(self):
        client = self.client(platform.GATEWAY)
        desired = {
            "apiVersion": "apps/v1",
            "kind": "StatefulSet",
            "metadata": {"name": client.name, "namespace": client.namespace_name},
            "spec": {"replicas": 1},
        }
        current = copy.deepcopy(desired)
        current["metadata"]["uid"] = "owned"
        client.receipt = {
            "chartObjects": [platform.identity(desired)],
            "objects": {platform.object_key(desired): client.binding(current, desired)},
            "releaseSecrets": [],
        }
        current["spec"]["replicas"] = 2
        with (
            patch.object(client, "get_object", return_value=current),
            patch.object(client, "releases", return_value=[]),
        ):
            with self.assertRaisesRegex(platform.Error, "binding"):
                client.check_removing()


if __name__ == "__main__":
    unittest.main()
