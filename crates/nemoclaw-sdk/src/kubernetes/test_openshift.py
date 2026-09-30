# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""OpenShift profile behavior without cluster access or relaxed admission."""

import copy
import json
import unittest
from unittest.mock import PropertyMock, patch

import test_platform

platform = test_platform.platform
spec = test_platform.spec


class OpenShiftTests(unittest.TestCase):
    setUp = test_platform.PlatformTests.setUp

    def openshift(self):
        selected = spec()
        selected["settings"]["kubernetes"]["distribution"] = "openshift"
        return platform.Platform(
            {"action": "read", "spec": selected, "stateDirectory": str(self.state)}
        )

    def namespace_fixture(self, client):
        client.receipt = {
            "generations": {platform.STORAGE: "a" * 32},
            "namespaceUid": "namespace-identity",
        }
        return {
            "metadata": {
                "uid": "namespace-identity",
                "labels": client.labels(),
                "annotations": {
                    "openshift.io/sa.scc.uid-range": "1000700000/10000",
                    "openshift.io/sa.scc.supplemental-groups": "1000800000/10000",
                },
            }
        }

    def test_plain_kubernetes_cannot_satisfy_openshift_before_create(self):
        client = self.openshift()
        with (
            patch.object(client, "cluster_binding", return_value={}),
            patch.object(client, "kubectl", return_value=json.dumps({"groups": []})) as command,
        ):
            with self.assertRaisesRegex(platform.Error, "prerequisite"):
                client.create({"kind": "Namespace", "metadata": {"name": "owned"}})
        self.assertFalse(any("create" in call.args for call in command.call_args_list))

    def test_missing_or_invalid_namespace_allocation_is_not_fixed_uid_fallback(self):
        for value in (
            None,
            "",
            "0/10000",
            "1000/0",
            "-1/2",
            "4294967295/1",
            "4294967295/2",
            "oops",
        ):
            with self.subTest(value=value):
                client = self.openshift()
                namespace = self.namespace_fixture(client)
                annotations = namespace["metadata"]["annotations"]
                if value is None:
                    annotations.pop("openshift.io/sa.scc.uid-range")
                else:
                    annotations["openshift.io/sa.scc.uid-range"] = value
                with patch.object(client, "get", return_value=namespace):
                    with self.assertRaisesRegex(platform.Error, "prerequisite"):
                        client.namespace()

    def test_changed_allocation_with_same_namespace_uid_blocks_reuse(self):
        client = self.openshift()
        namespace = self.namespace_fixture(client)
        with patch.object(client, "get", return_value=namespace):
            client.namespace(ensure=True)
        changed = copy.deepcopy(namespace)
        changed["metadata"]["annotations"]["openshift.io/sa.scc.uid-range"] = "1000900000/10000"
        with patch.object(client, "get", return_value=changed):
            with self.assertRaisesRegex(platform.Error, "binding"):
                client.namespace()

    def test_namespace_drift_after_binding_blocks_dependent_create(self):
        for field in ("allocation", "uid", "labels"):
            with self.subTest(field=field):
                client = self.openshift()
                namespace = self.namespace_fixture(client)
                client.receipt["binding"] = {}
                with (
                    patch.object(client, "get", return_value=namespace),
                    patch.object(client, "save"),
                ):
                    client.namespace(ensure=True)
                changed = copy.deepcopy(namespace)
                if field == "allocation":
                    changed["metadata"]["annotations"]["openshift.io/sa.scc.uid-range"] = (
                        "1000900000/10000"
                    )
                elif field == "uid":
                    changed["metadata"]["uid"] = "replacement-namespace"
                else:
                    changed["metadata"]["labels"] = {}
                groups = [
                    {"versions": [{"groupVersion": version}]}
                    for version in ("security.openshift.io/v1", "project.openshift.io/v1")
                ]
                with (
                    patch.object(client, "cluster_binding", return_value={}),
                    patch.object(client, "get", return_value=changed),
                    patch.object(
                        client, "kubectl", return_value=json.dumps({"groups": groups})
                    ) as command,
                ):
                    with self.assertRaisesRegex(platform.Error, "binding"):
                        client.create(
                            {
                                "kind": "ConfigMap",
                                "metadata": {
                                    "name": "dependent",
                                    "namespace": client.namespace_name,
                                },
                            }
                        )
                self.assertFalse(any("create" in call.args for call in command.call_args_list))

    def test_read_only_namespace_observation_does_not_bind_allocation(self):
        client = self.openshift()
        namespace = self.namespace_fixture(client)
        before = copy.deepcopy(client.receipt)
        with (
            patch.object(client, "get", return_value=namespace),
            patch.object(client, "save") as save,
        ):
            client.namespace()
        self.assertEqual(client.receipt, before)
        save.assert_not_called()

    def test_chart_and_issuer_use_namespace_identity_and_keep_tls(self):
        client = self.openshift()
        namespace = self.namespace_fixture(client)
        with patch.object(client, "get", return_value=namespace):
            client.namespace(ensure=True)
        pins = {
            "versions": {
                "images": {
                    name: "registry.example/" + name + "@sha256:" + "a" * 64
                    for name in ("gateway", "sandboxRuntime", "supervisor")
                }
            }
        }
        with patch.object(platform.Platform, "pins", new_callable=PropertyMock, return_value=pins):
            values = client.values()
        self.assertEqual(values["securityContext"]["runAsUser"], 1000700000)
        self.assertEqual(values["securityContext"]["runAsGroup"], 1000800000)
        self.assertEqual(values["podSecurityContext"]["fsGroup"], 1000800000)
        self.assertFalse(values["server"]["disableTls"])
        self.assertFalse(values["server"]["auth"]["allowUnauthenticatedUsers"])
        self.assertTrue(values["server"]["tls"]["enableMtls"])
        client.auth.private.mkdir()
        for name in ("ca.crt", "server.crt", "server.key"):
            (client.auth.private / name).write_text("fixture")
        with patch.object(client.auth, "public_metadata", return_value={}):
            objects = client.auth.objects()
        pod = next(obj for obj in objects if obj["kind"] == "Deployment")["spec"]["template"][
            "spec"
        ]
        self.assertEqual(pod["securityContext"]["runAsUser"], 1000700000)
        self.assertEqual(pod["securityContext"]["runAsGroup"], 1000800000)
        self.assertEqual(pod["securityContext"]["fsGroup"], 1000800000)
        self.assertFalse(pod["containers"][0]["securityContext"]["allowPrivilegeEscalation"])
        self.assertEqual(pod["containers"][0]["securityContext"]["capabilities"], {"drop": ["ALL"]})
        self.assertFalse(any(obj["kind"] == "SecurityContextConstraints" for obj in objects))

    def test_api_discovery_is_read_only_and_requires_both_groups(self):
        client = self.openshift()
        groups = [
            {"versions": [{"groupVersion": value}]}
            for value in ("security.openshift.io/v1", "project.openshift.io/v1")
        ]
        with (
            patch.object(client, "cluster_binding", return_value={}),
            patch.object(client, "kubectl", return_value=json.dumps({"groups": groups})) as command,
        ):
            self.assertEqual(client.check_cluster(), {})
            command.assert_called_once_with("get", "--raw", "/apis")
        with (
            patch.object(client, "cluster_binding", return_value={}),
            patch.object(client, "kubectl", return_value=json.dumps({"groups": groups[:1]})),
        ):
            with self.assertRaisesRegex(platform.Error, "prerequisite"):
                client.check_cluster()

    def test_supplemental_group_allocation_is_checked_and_missing_uses_uid_range(self):
        client = self.openshift()
        namespace = self.namespace_fixture(client)
        namespace["metadata"]["annotations"]["openshift.io/sa.scc.supplemental-groups"] = "0/1"
        with patch.object(client, "get", return_value=namespace):
            with self.assertRaisesRegex(platform.Error, "prerequisite"):
                client.namespace(ensure=True)
        del namespace["metadata"]["annotations"]["openshift.io/sa.scc.supplemental-groups"]
        with patch.object(client, "get", return_value=namespace):
            client.namespace(ensure=True)
        self.assertEqual(client.pod_security_context()["runAsGroup"], 1000700000)

    def test_pod_cannot_use_unbound_namespace_identity(self):
        client = self.openshift()
        self.namespace_fixture(client)
        with self.assertRaisesRegex(platform.Error, "prerequisite"):
            client.pod_security_context()

    def test_namespace_label_change_during_allocation_wait_blocks_binding(self):
        client = self.openshift()
        namespace = self.namespace_fixture(client)
        client.receipt.pop("namespaceUid")
        client.receipt["namespacePending"] = True
        later = copy.deepcopy(namespace)
        later["metadata"]["labels"] = {}
        namespace["metadata"]["annotations"] = {}
        with (
            patch.object(client, "get", side_effect=[namespace, later]),
            patch.object(platform.time, "sleep"),
        ):
            with self.assertRaisesRegex(platform.Error, "binding"):
                client.namespace(ensure=True)
        self.assertNotIn("openshiftIdentity", client.receipt)
