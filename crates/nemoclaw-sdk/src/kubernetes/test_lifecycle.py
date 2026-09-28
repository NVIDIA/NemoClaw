# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Interrupted Helm operations preserve data and recover through the same state."""

import copy
import io
import json
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import test_platform
from test_platform import platform, spec


class FakePlatform(platform.Platform):
    def __init__(self, request, world):
        self.world = world
        super().__init__(request)
        self.auth = SimpleNamespace(
            install=lambda: None, material=lambda **_: None, values=lambda: {}
        )

    @property
    def pins(self):
        return {
            "versions": {
                "images": {
                    name: "registry.example/" + name + "@sha256:" + "a" * 64
                    for name in ("gateway", "sandboxRuntime", "supervisor")
                }
            }
        }

    def cluster_binding(self):
        return {
            "context": "explicit",
            "server": "https://cluster.example",
            "ca": "digest",
            "systemUid": "cluster-uid",
        }

    def get(self, kind, name, namespace=""):
        return copy.deepcopy(self.world["objects"].get("/".join((kind, namespace, name))))

    def create(self, obj):
        key = platform.object_key(obj)
        if key in self.world["objects"]:
            raise platform.Error("binding")
        obj = copy.deepcopy(obj)
        self.world["sequence"] += 1
        obj["metadata"]["uid"] = str(self.world["sequence"])
        self.world["objects"][key] = obj

    def prerequisites(self, ensure=False):
        pass

    def storage_preflight(self):
        pass

    def policy_probe(self):
        pass

    def chart(self):
        return Path("/verified/chart")

    def manifest(self, data):
        return json.loads(data)

    def releases(self):
        return self.world["releases"]

    def helm(self, *arguments, **_kwargs):
        if arguments[0] == "template":
            return json.dumps(
                [
                    {
                        "apiVersion": "apps/v1",
                        "kind": "StatefulSet",
                        "metadata": {"name": self.name},
                        "spec": {
                            "template": {
                                "spec": {
                                    "containers": [
                                        {
                                            "name": "gateway",
                                            "image": "registry.example/gateway@sha256:" + "a" * 64,
                                        }
                                    ]
                                }
                            }
                        },
                    },
                    {"apiVersion": "v1", "kind": "Service", "metadata": {"name": self.name}},
                    {
                        "apiVersion": "rbac.authorization.k8s.io/v1",
                        "kind": "Role",
                        "metadata": {
                            "name": self.name + "-certgen",
                            "namespace": self.namespace_name,
                            "annotations": {"helm.sh/hook": "pre-install,pre-upgrade"},
                        },
                        "rules": [],
                    },
                ]
            )
        self.world["mutations"].append(arguments[0])
        if arguments[0] == "upgrade":
            for obj in self.receipt["chartObjects"]:
                if not self.get_object(obj):
                    value = copy.deepcopy(self.receipt["chartDesired"][platform.object_key(obj)])
                    value["metadata"]["annotations"] = {
                        "meta.helm.sh/release-name": self.name,
                        "meta.helm.sh/release-namespace": self.namespace_name,
                    }
                    if value["kind"] == "StatefulSet":
                        value["metadata"]["generation"] = 1
                        value["status"] = {"readyReplicas": 1, "observedGeneration": 1}
                    self.create(value)
            for obj in self.retained_gateway_objects():
                if not self.get_object(obj):
                    value = {**copy.deepcopy(obj), "apiVersion": "v1"}
                    if value["kind"] == "Secret":
                        value.update({"data": {"key": "fixture"}, "type": "Opaque"})
                    self.create(value)
            hook = {
                "apiVersion": "rbac.authorization.k8s.io/v1",
                "kind": "Role",
                "metadata": {
                    "name": self.name + "-certgen",
                    "namespace": self.namespace_name,
                    "annotations": {"helm.sh/hook": "pre-install,pre-upgrade"},
                },
                "rules": [],
            }
            self.world["objects"].pop(platform.object_key(hook), None)
            self.create(hook)
            self.world["releases"] = [{"name": "release", "uid": str(self.world["sequence"])}]
        elif arguments[0] == "uninstall":
            for obj in self.receipt["chartObjects"]:
                self.world["objects"].pop(platform.object_key(obj), None)
            self.world["releases"] = []
        if self.world.pop("lose", None) == arguments[0]:
            raise platform.Error("command")
        return ""


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        test_platform.PlatformTests.setUp(self)
        self.world = {"objects": {}, "releases": [], "sequence": 0, "mutations": []}

    def client(self, kind=platform.STORAGE, action="ensure", **extra):
        request = {"action": action, "spec": spec(kind), "stateDirectory": str(self.state), **extra}
        return FakePlatform(request, self.world)

    def initialized(self):
        self.client().ensure()
        return self.client(platform.GATEWAY)

    def test_destroy_then_apply_preserves_credentials_and_pvc(self):
        client = self.initialized()
        first = client.ensure()
        retained = {
            platform.object_key(obj): client.get_object(obj)["metadata"]["uid"]
            for obj in client.retained_gateway_objects()
        }
        self.assertTrue(first["running"])
        self.assertEqual(self.client(platform.GATEWAY).remove(), {"id": None})
        recreated = self.client(platform.GATEWAY).ensure()
        self.assertTrue(recreated["running"])
        self.assertEqual(first["id"], recreated["id"])
        self.assertEqual(
            retained, {key: self.world["objects"][key]["metadata"]["uid"] for key in retained}
        )

    def test_lost_install_response_retains_identity_for_read_and_remove(self):
        client = self.initialized()
        self.world["lose"] = "upgrade"
        with self.assertRaisesRegex(platform.Error, "command"):
            client.ensure()
        observed = self.client(platform.GATEWAY).read()
        self.assertTrue(observed["id"])
        self.assertFalse(observed["running"])
        self.assertEqual(self.client(platform.GATEWAY).remove(), {"id": None})

    def test_lost_uninstall_response_can_finish_without_recreating_gateway(self):
        self.initialized().ensure()
        self.world["lose"] = "uninstall"
        with self.assertRaisesRegex(platform.Error, "command"):
            self.client(platform.GATEWAY).remove()
        self.assertFalse(self.client(platform.GATEWAY).read()["running"])
        self.assertEqual(self.client(platform.GATEWAY).remove(), {"id": None})
        self.assertEqual(self.world["mutations"], ["upgrade", "uninstall"])

    def test_foreign_hook_is_rejected_before_helm_can_delete_it(self):
        client = self.initialized()
        hook = {
            "kind": "Role",
            "metadata": {"name": client.name + "-certgen", "namespace": client.namespace_name},
        }
        client.create(hook)
        with self.assertRaisesRegex(platform.Error, "binding"):
            client.ensure()
        self.assertEqual(self.world["mutations"], [])

    def test_missing_bound_gateway_is_not_reinstalled(self):
        client = self.initialized()
        client.ensure()
        self.world["objects"].pop("StatefulSet/" + client.namespace_name + "/" + client.name)
        with self.assertRaisesRegex(platform.Error, "binding"):
            self.client(platform.GATEWAY).ensure()
        self.assertEqual(self.world["mutations"], ["upgrade"])

    def test_protocol_errors_do_not_disclose_exception_contents(self):
        request = {"action": "ensure", "spec": spec(), "stateDirectory": str(self.state)}
        stdout = io.StringIO()
        with (
            patch.object(platform, "Platform", side_effect=RuntimeError("private-secret")),
            patch.object(platform.sys, "stdin", io.StringIO(json.dumps(request) + "\n")),
            patch.object(platform.sys, "stdout", stdout),
        ):
            platform.main()
        self.assertEqual(json.loads(stdout.getvalue()), {"error": "command"})

    def test_uncertain_unsubmitted_kek_create_reuses_private_key_on_retry(self):
        client = self.client()
        original = client.create
        sent = []

        def interrupted(obj):
            if obj["kind"] == "Secret":
                sent.append(copy.deepcopy(obj["data"]))
                raise platform.Error("command")
            return original(obj)

        with patch.object(client, "create", side_effect=interrupted):
            with self.assertRaisesRegex(platform.Error, "command"):
                client.ensure()
        resumed = self.client()
        self.assertTrue(resumed.ensure()["running"])
        key = resumed.get("Secret", resumed.name + "-kek", resumed.namespace_name)
        self.assertEqual(key["data"], sent[0])

    def test_changed_image_with_same_gateway_uid_fails_read(self):
        client = self.initialized()
        client.ensure()
        key = "StatefulSet/" + client.namespace_name + "/" + client.name
        self.world["objects"][key]["spec"]["template"]["spec"]["containers"][0]["image"] = (
            "untrusted:latest"
        )
        with self.assertRaisesRegex(platform.Error, "binding"):
            self.client(platform.GATEWAY).read()

    def test_changed_retained_credential_with_same_uid_fails_read(self):
        client = self.initialized()
        client.ensure()
        key = "Secret/" + client.namespace_name + "/" + client.name + "-kek"
        self.world["objects"][key]["data"] = {"key-encryption-key": "substitute"}
        with self.assertRaisesRegex(platform.Error, "binding"):
            self.client(platform.GATEWAY).read()

    def test_changed_pin_binding_fails_before_cluster_access(self):
        self.initialized()
        receipt = json.loads((self.state / "platform.json").read_text())
        receipt["artifactPins"] = "different-pins"
        platform.Platform.write(self.state / "platform.json", json.dumps(receipt).encode())
        with patch.object(FakePlatform, "cluster_binding") as cluster:
            with self.assertRaisesRegex(platform.Error, "binding"):
                self.client(platform.GATEWAY)
            cluster.assert_not_called()


if __name__ == "__main__":
    unittest.main()
