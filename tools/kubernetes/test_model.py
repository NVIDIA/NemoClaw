# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import model


class ModelTests(unittest.TestCase):
    def test_cpu_fixture_pins_instruct_model_and_bounds_context_and_capacity(self):
        self.assertEqual(model.MODEL, "qwen3:4b-instruct-2507-q4_K_M")
        self.assertEqual(
            model.MODEL_SHA256,
            "0edcdef34593eac1aa2be9c7d06c432dcf81945adca5eca2f27662c18f168ba0",
        )
        objects = {item["kind"]: item for item in model.manifests()}
        self.assertEqual(
            objects["PersistentVolumeClaim"]["spec"]["resources"]["requests"]["storage"], "6Gi"
        )
        container = objects["Deployment"]["spec"]["template"]["spec"]["containers"][0]
        self.assertEqual(container["resources"]["requests"], {"cpu": "2", "memory": "8Gi"})
        self.assertEqual(container["resources"]["limits"], {"cpu": "8", "memory": "16Gi"})
        self.assertIn({"name": "OLLAMA_CONTEXT_LENGTH", "value": "32768"}, container["env"])
        self.assertIn({"name": "LLAMA_ARG_THREADS", "value": "8"}, container["env"])
        config = model.configuration("nc-test@sha256:" + "a" * 64, "10.96.1.2", "openclaw")
        route = config["spec"]["sandboxes"][0]["agent"]["inference"]["routes"][0]
        self.assertEqual(route["overrides"]["model"], model.MODEL)

    def test_manifest_verification_tracks_the_selected_model_tag(self):
        calls = []

        def kubectl(*args):
            calls.append(args)
            return SimpleNamespace(stdout=model.MODEL_SHA256 + "  manifest\n")

        stack = SimpleNamespace(kubectl=kubectl)
        model.verify_model(stack)
        self.assertEqual(
            calls[-1][-1],
            "/models/manifests/registry.ollama.ai/library/qwen3/4b-instruct-2507-q4_K_M",
        )
        with patch.object(model, "MODEL", "qwen3:another-tag"):
            model.verify_model(stack)
        self.assertEqual(
            calls[-1][-1], "/models/manifests/registry.ollama.ai/library/qwen3/another-tag"
        )

    def test_invalid_model_paths_are_rejected_before_cluster_access(self):
        def kubectl(*args):
            self.fail("invalid model reference reached the cluster")

        for reference in [
            "qwen3",
            "../qwen3:tag",
            "qwen3:../tag",
            "qwen3:tag/../../other",
            "qwen3:--option",
            "qwen3:tag\n",
            "registry.example/qwen3:tag",
        ]:
            with self.subTest(reference=reference), patch.object(model, "MODEL", reference):
                with self.assertRaises(model.Error):
                    model.verify_model(SimpleNamespace(kubectl=kubectl))

    def test_missing_or_mismatched_manifest_digest_is_rejected(self):
        for digest in ["", "0" * 64, model.MODEL_SHA256.upper()]:
            with self.subTest(digest=digest), self.assertRaises(model.Error):
                model.verify_model(
                    SimpleNamespace(
                        kubectl=lambda *args, digest=digest: SimpleNamespace(stdout=digest)
                    )
                )

    def test_generated_configuration_uses_only_explicit_kubernetes_and_private_inference(self):
        config = model.configuration("nc-test@sha256:" + "a" * 64, "10.96.1.2", "openclaw")
        self.assertEqual(config["spec"]["sandboxes"][0]["runtime"]["provider"], "kubernetes")
        self.assertEqual(config["spec"]["gateway"]["management"], "external")
        self.assertEqual(
            config["spec"]["inferenceProviders"][0]["endpoint"], "http://10.96.1.2:11434/v1"
        )
        self.assertNotIn("services", config["spec"])

    def test_mutable_images_and_unexpected_inference_addresses_are_rejected(self):
        for image, address in [
            ("nc-test:latest", "10.96.1.2"),
            ("nc-test@sha256:" + "a" * 64, "169.254.169.254"),
            ("nc-test@sha256:" + "a" * 64, "8.8.8.8"),
        ]:
            with self.assertRaises(model.Error):
                model.configuration(image, address, "openclaw")

    def test_documentation_and_reserved_addresses_cannot_become_inference_endpoints(self):
        for address in [
            "192.0.0.1",
            "192.0.2.1",
            "198.18.0.1",
            "198.51.100.1",
            "203.0.113.1",
            "240.0.0.1",
            "255.255.255.255",
            "172.15.255.255",
            "172.32.0.1",
            "192.167.255.255",
            "192.169.0.1",
        ]:
            with self.subTest(address=address), self.assertRaises(model.Error):
                model.configuration("nc-test@sha256:" + "a" * 64, address, "openclaw")

    def test_each_rfc1918_range_can_supply_the_inference_endpoint(self):
        for address in [
            "10.0.0.1",
            "10.255.255.254",
            "172.16.0.1",
            "172.31.255.254",
            "192.168.0.1",
            "192.168.255.254",
        ]:
            with self.subTest(address=address):
                config = model.configuration("nc-test@sha256:" + "a" * 64, address, "openclaw")
                self.assertEqual(
                    config["spec"]["inferenceProviders"][0]["endpoint"],
                    f"http://{address}:11434/v1",
                )

    def test_serving_policy_has_no_outbound_grants_after_model_download(self):
        policy = model.network_policy(False, verified=True)
        self.assertEqual(policy["spec"]["egress"], [])
        self.assertEqual(
            policy["spec"]["ingress"][0]["ports"], [{"protocol": "TCP", "port": 11434}]
        )

    def test_failed_rollout_or_integrity_never_leaves_a_usable_model_endpoint(self):
        class FakeStack:
            def __init__(self, failure):
                self.failure = failure
                self.applied = []

            def guard(self):
                pass

            def apply_json(self, value):
                self.applied.append(value)

            def kubectl(self, *args, **kwargs):
                if "rollout" in args and self.failure == "rollout":
                    raise model.Error("rollout failed")
                if "sha256sum" in args:
                    return SimpleNamespace(stdout="0" * 64 + "  manifest")
                return SimpleNamespace(stdout="")

        for failure in ["rollout", "integrity"]:
            fixture = FakeStack(failure)
            with self.assertRaises(model.Error):
                model.deploy(fixture)
            self.assertEqual(fixture.applied[-1]["spec"]["egress"], [])
            self.assertEqual(fixture.applied[-1]["spec"]["ingress"], [])


if __name__ == "__main__":
    unittest.main()
