# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""The local development issuer never grants anonymous gateway access."""

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import auth
import stack


class AuthTests(unittest.TestCase):
    def test_missing_openssl_fails_before_any_external_command(self):
        with tempfile.TemporaryDirectory() as directory:
            owned = stack.Stack(Path(directory))
            with (
                patch(
                    "stack.shutil.which",
                    side_effect=lambda name: None if name == "openssl" else "/tool",
                ),
                patch("stack.run") as run,
            ):
                with self.assertRaises(stack.Error):
                    owned.preflight()
                run.assert_not_called()

    def test_partial_keys_are_not_rotated(self):
        with tempfile.TemporaryDirectory() as directory:
            private = Path(directory) / "oidc"
            private.mkdir(mode=0o700)
            (private / "ca.crt").write_text("existing certificate")
            with patch("auth.openssl") as openssl:
                with self.assertRaises(ValueError):
                    auth.material(SimpleNamespace(state=Path(directory)))
                openssl.assert_not_called()

    def test_renew_missing_keys_never_generates_replacement_material(self):
        with tempfile.TemporaryDirectory() as directory:
            owned = stack.Stack(Path(directory))
            owned.receipt = {"owner": "test-owner"}
            with patch.object(owned, "guard"), patch("auth.openssl") as openssl:
                with self.assertRaises(ValueError):
                    auth.renew(owned)
                openssl.assert_not_called()

    def test_deploy_cannot_replace_completely_lost_initialized_material(self):
        with tempfile.TemporaryDirectory() as directory:
            owned = stack.Stack(Path(directory))
            owned.receipt = {"owner": "test-owner", "oidc_initialized": True}
            with patch(
                "auth.openssl", side_effect=ValueError("should not reach OpenSSL")
            ) as openssl:
                with self.assertRaises(ValueError):
                    auth.material(owned)
                openssl.assert_not_called()

    def test_valid_existing_keys_record_initialization_without_key_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            owned = stack.Stack(Path(directory))
            owned.receipt = {"owner": "test-owner"}
            private = Path(directory) / "oidc"
            private.mkdir(mode=0o700)
            for name in ["ca.key", "ca.crt", "server.key", "server.crt", "signing.key"]:
                (private / name).write_text("existing material")
                (private / name).chmod(0o600)
            with patch("auth.openssl", return_value=b"") as openssl:
                self.assertEqual(auth.material(owned), private)
                openssl.assert_called_once_with(
                    "x509", "-checkend", "3600", "-noout", "-in", private / "server.crt"
                )
            self.assertTrue(json.loads(owned.receipt_file.read_text())["oidc_initialized"])
            self.assertEqual((private / "signing.key").read_text(), "existing material")

    def test_key_and_certificate_output_symlinks_are_rejected_before_openssl(self):
        for name in [
            "ca.key",
            "ca.crt",
            "server.key",
            "server.crt",
            "signing.key",
            "server.csr",
            "server.ext",
            "ca.srl",
            "operator.token",
        ]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                private = Path(directory) / "oidc"
                private.mkdir(mode=0o700)
                (private / name).symlink_to(Path(directory) / "missing-target")
                with patch(
                    "auth.openssl", side_effect=ValueError("should not reach OpenSSL")
                ) as openssl:
                    with self.assertRaises(ValueError):
                        auth.material(stack.Stack(Path(directory)))
                    openssl.assert_not_called()

    def test_auxiliary_material_is_not_overwritten_when_primary_keys_are_missing(self):
        with tempfile.TemporaryDirectory() as directory:
            private = Path(directory) / "oidc"
            private.mkdir(mode=0o700)
            (private / "server.csr").write_text("existing signing request")
            (private / "server.csr").chmod(0o600)
            with patch(
                "auth.openssl", side_effect=ValueError("should not reach OpenSSL")
            ) as openssl:
                with self.assertRaises(ValueError):
                    auth.material(stack.Stack(Path(directory)))
                openssl.assert_not_called()

    def test_environment_contains_file_reference_without_bearer_value(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            (state / "oidc").mkdir()
            (state / "oidc/operator.token").write_text("credential-sentinel")
            (state / "environment.env").write_text("export NEMOCLAW_K8S_CA=/private/ca.crt\n")
            auth.export_environment(
                SimpleNamespace(state=state, write=lambda path, data: path.write_bytes(data))
            )
            environment = (state / "environment.env").read_text()
            self.assertNotIn("credential-sentinel", environment)
            self.assertIn("$(cat ", environment)

    def test_token_has_bounded_lifetime_and_explicit_scopes(self):
        claims = auth.claims(1000, "test-owner")
        self.assertEqual(claims["exp"] - claims["iat"], 3600)
        self.assertNotIn("openshell:all", claims["scope"])
        self.assertEqual(set(claims["scope"].split()), set(auth.SCOPES))
        self.assertEqual(claims["aud"], auth.AUDIENCE)
        self.assertEqual(claims["iss"], auth.ISSUER)

    def test_issuer_trust_requires_https_and_role_and_scope_claims(self):
        self.assertTrue(auth.OIDC_VALUES["issuer"].startswith("https://"))
        self.assertFalse(auth.OIDC_VALUES["dangerouslyAllowInsecureHttp"])
        self.assertEqual(auth.OIDC_VALUES["rolesClaim"], "roles")
        self.assertEqual(auth.OIDC_VALUES["scopesClaim"], "scope")
        self.assertTrue(auth.OIDC_VALUES["adminRole"])
        self.assertTrue(auth.OIDC_VALUES["userRole"])

    def test_issuer_egress_denied_and_only_gateway_ingress_allowed(self):
        policy = auth.network_policy()["spec"]
        self.assertEqual(policy["egress"], [])
        self.assertEqual(policy["policyTypes"], ["Ingress", "Egress"])
        self.assertEqual(
            policy["ingress"][0]["from"],
            [
                {
                    "podSelector": {
                        "matchLabels": {
                            "app.kubernetes.io/instance": "openshell",
                            "app.kubernetes.io/name": "openshell",
                        }
                    }
                }
            ],
        )


if __name__ == "__main__":
    unittest.main()
