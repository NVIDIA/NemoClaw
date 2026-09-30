# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Development signing custody and bounded-token regression tests."""

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import auth


class AuthTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.state = Path(self.directory.name)
        self.owner = SimpleNamespace(
            state=self.state,
            name="nc-0123456789abcdef-gateway",
            namespace_name="owned-namespace",
            spec={"owner": "owner"},
            receipt={},
            save=lambda: None,
            write=self.write,
            pod_security_context=lambda: {
                "runAsNonRoot": True,
                "runAsUser": 10001,
                "runAsGroup": 10001,
                "fsGroup": 10001,
                "seccompProfile": {"type": "RuntimeDefault"},
            },
        )
        self.auth = auth.DevelopmentAuth(self.owner)

    def write(self, path, data):
        path.write_bytes(data)
        path.chmod(0o600)

    def keys(self):
        self.auth.private.mkdir(mode=0o700)
        for name in ("ca.key", "ca.crt", "server.key", "server.crt", "signing.key"):
            self.write(self.auth.private / name, b"fixture")

    def test_tokens_have_exact_scopes_and_one_hour_lifetime(self):
        claims = self.auth.claims(1000)
        self.assertEqual(claims["exp"], 4600)
        self.assertEqual(claims["nbf"], 1000)
        self.assertEqual(claims["aud"], "owner")
        self.assertEqual(set(claims["scope"].split()), set(auth.SCOPES))

    def test_missing_keys_cannot_be_recreated_by_connection(self):
        with patch("auth.openssl") as openssl:
            with self.assertRaisesRegex(ValueError, "auth"):
                self.auth.token()
            openssl.assert_not_called()

    def test_partial_or_lost_initialized_material_never_rotates(self):
        self.auth.private.mkdir(mode=0o700)
        self.write(self.auth.private / "ca.crt", b"fixture")
        with patch("auth.openssl") as openssl:
            with self.assertRaisesRegex(ValueError, "auth"):
                self.auth.material(create=True)
            openssl.assert_not_called()
        (self.auth.private / "ca.crt").unlink()
        self.owner.receipt["authStarted"] = True
        with patch("auth.openssl") as openssl:
            with self.assertRaisesRegex(ValueError, "auth"):
                self.auth.material(create=True)
            openssl.assert_not_called()

    def test_output_symlinks_and_public_private_material_fail_before_openssl(self):
        self.auth.private.mkdir(mode=0o700)
        path = self.auth.private / "server.ext"
        path.symlink_to(self.state / "missing")
        with patch("auth.openssl") as openssl:
            with self.assertRaisesRegex(ValueError, "auth"):
                self.auth.material(create=True)
            openssl.assert_not_called()
        path.unlink()
        self.write(path, b"fixture")
        path.chmod(0o644)
        with patch("auth.openssl") as openssl:
            with self.assertRaisesRegex(ValueError, "auth"):
                self.auth.material(create=True)
            openssl.assert_not_called()

    def test_expired_certificate_rejects_token_without_signing(self):
        self.keys()
        with patch("auth.openssl", side_effect=ValueError("auth")) as openssl:
            with self.assertRaisesRegex(ValueError, "auth"):
                self.auth.token()
            self.assertFalse(any("-sign" in call.args for call in openssl.call_args_list))

    def test_real_material_has_private_modes_and_reused_identity(self):
        self.auth.material(create=True)
        first = self.owner.receipt["authFingerprint"]
        token = self.auth.token()
        self.assertEqual(len(token.split(".")), 3)
        self.assertEqual(self.owner.receipt["authFingerprint"], first)
        for path in self.auth.private.iterdir():
            self.assertEqual(path.stat().st_mode & 0o077, 0)
        self.assertNotIn("signing.key", json.dumps(self.auth.objects()))


if __name__ == "__main__":
    unittest.main()
