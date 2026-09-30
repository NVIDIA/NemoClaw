# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Explicit development issuer for one owned Kubernetes gateway.

The private signing key remains with the operator. The Pod serves only public
discovery/JWKS documents using a separate TLS key. This is not a login service.
"""

import base64
import hashlib
import json
import os
import subprocess
import time
from pathlib import Path

IMAGE = "python:3.12.12-alpine3.22@sha256:848ba4413eb897e225159b8fc1b02094576cbae4aa73fc13142608ae2c8c0e32"
SCOPES = tuple(
    f"{name}:{operation}"
    for name in ("config", "provider", "sandbox", "workspace")
    for operation in ("read", "write")
)


def encode(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def openssl(*arguments, data=None):
    result = subprocess.run(
        ["openssl", *map(str, arguments)], input=data, capture_output=True, timeout=30
    )
    if result.returncode:
        raise ValueError("auth")
    return result.stdout


class DevelopmentAuth:
    def __init__(self, platform):
        self.platform = platform
        self.name = platform.name + "-oidc"
        self.namespace = platform.namespace_name
        self.host = f"{self.name}.{self.namespace}.svc.cluster.local"
        self.issuer = f"https://{self.host}:8443"
        self.audience = platform.spec["owner"]
        self.private = platform.state / "auth"

    def values(self):
        return {
            "issuer": self.issuer,
            "audience": self.audience,
            "rolesClaim": "roles",
            "adminRole": "nemoclaw-development-admin",
            "userRole": "nemoclaw-development-user",
            "scopesClaim": "scope",
            "jwksTtl": 60,
            "caConfigMapName": self.name + "-ca",
            "dangerouslyAllowInsecureHttp": False,
        }

    def material(self, create=False):
        if not self.private.exists() and not create:
            raise ValueError("auth")
        self.private.mkdir(mode=0o700, exist_ok=True)
        if (
            self.private.is_symlink()
            or self.private.stat().st_uid != os.getuid()
            or self.private.stat().st_mode & 0o077
        ):
            raise ValueError("auth")
        required = ("ca.key", "ca.crt", "server.key", "server.crt", "signing.key")
        auxiliary = ("server.csr", "server.ext", "ca.srl")
        for name in required + auxiliary:
            path = self.private / name
            if path.is_symlink() or (
                path.exists()
                and (
                    not path.is_file()
                    or path.stat().st_uid != os.getuid()
                    or path.stat().st_mode & 0o077
                )
            ):
                raise ValueError("auth")
        present = [name for name in required if (self.private / name).exists()]
        if present and len(present) != len(required):
            raise ValueError("auth")
        if not present:
            if (
                not create
                or self.platform.receipt.get("authStarted")
                or any((self.private / name).exists() for name in auxiliary)
            ):
                raise ValueError("auth")
            self.platform.receipt["authStarted"] = True
            self.platform.save()
            openssl(
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-nodes",
                "-sha256",
                "-days",
                "7",
                "-subj",
                "/CN=NemoClaw development OIDC CA",
                "-keyout",
                self.private / "ca.key",
                "-out",
                self.private / "ca.crt",
                "-addext",
                "basicConstraints=critical,CA:TRUE",
                "-addext",
                "keyUsage=critical,keyCertSign,cRLSign",
            )
            openssl(
                "req",
                "-new",
                "-newkey",
                "rsa:2048",
                "-nodes",
                "-sha256",
                "-subj",
                "/CN=NemoClaw development issuer",
                "-keyout",
                self.private / "server.key",
                "-out",
                self.private / "server.csr",
            )
            self.platform.write(
                self.private / "server.ext",
                ("subjectAltName=DNS:" + self.host + "\nextendedKeyUsage=serverAuth\n").encode(),
            )
            openssl(
                "x509",
                "-req",
                "-in",
                self.private / "server.csr",
                "-CA",
                self.private / "ca.crt",
                "-CAkey",
                self.private / "ca.key",
                "-CAcreateserial",
                "-out",
                self.private / "server.crt",
                "-days",
                "7",
                "-sha256",
                "-extfile",
                self.private / "server.ext",
            )
            openssl(
                "genpkey",
                "-algorithm",
                "RSA",
                "-pkeyopt",
                "rsa_keygen_bits:2048",
                "-pkeyopt",
                "rsa_keygen_pubexp:65537",
                "-out",
                self.private / "signing.key",
            )
            for name in required + auxiliary:
                (self.private / name).chmod(0o600)
        openssl("x509", "-checkend", "3600", "-noout", "-in", self.private / "server.crt")
        openssl("x509", "-checkend", "3600", "-noout", "-in", self.private / "ca.crt")
        openssl("x509", "-checkhost", self.host, "-noout", "-in", self.private / "server.crt")
        openssl("verify", "-CAfile", self.private / "ca.crt", self.private / "server.crt")
        for stem in ("ca", "server"):
            if openssl(
                "x509", "-pubkey", "-noout", "-in", self.private / (stem + ".crt")
            ) != openssl("pkey", "-pubout", "-in", self.private / (stem + ".key")):
                raise ValueError("auth")
        fingerprint = hashlib.sha256(
            json.dumps(self.public_metadata(), sort_keys=True).encode()
            + (self.private / "ca.crt").read_bytes()
            + (self.private / "server.crt").read_bytes()
        ).hexdigest()
        if self.platform.receipt.get("authFingerprint", fingerprint) != fingerprint:
            raise ValueError("auth")
        if not self.platform.receipt.get("authFingerprint"):
            if not create:
                raise ValueError("auth")
            self.platform.receipt["authFingerprint"] = fingerprint
            self.platform.save()

    def public_metadata(self):
        modulus = (
            openssl("rsa", "-in", self.private / "signing.key", "-noout", "-modulus")
            .decode()
            .strip()
        )
        if not modulus.startswith("Modulus="):
            raise ValueError("auth")
        key = {
            "kid": "nemoclaw-development",
            "kty": "RSA",
            "alg": "RS256",
            "use": "sig",
            "n": encode(bytes.fromhex(modulus.split("=", 1)[1])),
            "e": encode(b"\x01\x00\x01"),
        }
        return {
            "/.well-known/openid-configuration": {
                "issuer": self.issuer,
                "jwks_uri": self.issuer + "/jwks",
                "id_token_signing_alg_values_supported": ["RS256"],
            },
            "/jwks": {"keys": [key]},
        }

    def claims(self, now):
        return {
            "iss": self.issuer,
            "aud": self.audience,
            "sub": "nemoclaw-development-" + self.platform.spec["owner"],
            "iat": now,
            "nbf": now,
            "exp": now + 3600,
            "roles": ["nemoclaw-development-admin"],
            "scope": " ".join(SCOPES),
        }

    def token(self):
        self.material()
        header = encode(
            json.dumps(
                {"alg": "RS256", "typ": "JWT", "kid": "nemoclaw-development"}, separators=(",", ":")
            ).encode()
        )
        payload = encode(json.dumps(self.claims(int(time.time())), separators=(",", ":")).encode())
        message = (header + "." + payload).encode()
        signature = openssl("dgst", "-sha256", "-sign", self.private / "signing.key", data=message)
        return message.decode() + "." + encode(signature)

    def objects(self):
        metadata = {"name": self.name, "namespace": self.namespace}
        selector = {"app": self.name}
        gateway_selector = {
            "app.kubernetes.io/instance": self.platform.name,
            "app.kubernetes.io/name": "openshell",
        }
        return [
            {
                "apiVersion": "v1",
                "kind": "ConfigMap",
                "metadata": {"name": self.name + "-ca", "namespace": self.namespace},
                "data": {"ca.crt": (self.private / "ca.crt").read_text()},
            },
            {
                "apiVersion": "v1",
                "kind": "Secret",
                "metadata": metadata,
                "type": "kubernetes.io/tls",
                "data": {
                    "tls.crt": base64.b64encode(
                        (self.private / "server.crt").read_bytes()
                    ).decode(),
                    "tls.key": base64.b64encode(
                        (self.private / "server.key").read_bytes()
                    ).decode(),
                },
            },
            {
                "apiVersion": "v1",
                "kind": "ConfigMap",
                "metadata": metadata,
                "data": {
                    "server.py": Path(__file__).with_name("oidc_server.py").read_text(),
                    "metadata.json": json.dumps(self.public_metadata()),
                },
            },
            {
                "apiVersion": "networking.k8s.io/v1",
                "kind": "NetworkPolicy",
                "metadata": metadata,
                "spec": {
                    "podSelector": {"matchLabels": selector},
                    "policyTypes": ["Ingress", "Egress"],
                    "egress": [],
                    "ingress": [
                        {
                            "from": [{"podSelector": {"matchLabels": gateway_selector}}],
                            "ports": [{"protocol": "TCP", "port": 8443}],
                        }
                    ],
                },
            },
            {
                "apiVersion": "v1",
                "kind": "Service",
                "metadata": metadata,
                "spec": {"selector": selector, "ports": [{"port": 8443, "targetPort": 8443}]},
            },
            {
                "apiVersion": "apps/v1",
                "kind": "Deployment",
                "metadata": metadata,
                "spec": {
                    "replicas": 1,
                    "selector": {"matchLabels": selector},
                    "template": {
                        "metadata": {"labels": selector},
                        "spec": {
                            "automountServiceAccountToken": False,
                            "securityContext": self.platform.pod_security_context(),
                            "containers": [
                                {
                                    "name": "issuer",
                                    "image": IMAGE,
                                    "imagePullPolicy": "IfNotPresent",
                                    "command": ["python3", "-B", "/app/server.py"],
                                    "ports": [{"containerPort": 8443}],
                                    "readinessProbe": {
                                        "tcpSocket": {"port": 8443},
                                        "periodSeconds": 2,
                                    },
                                    "resources": {
                                        "requests": {"cpu": "50m", "memory": "32Mi"},
                                        "limits": {"cpu": "250m", "memory": "128Mi"},
                                    },
                                    "securityContext": {
                                        "readOnlyRootFilesystem": True,
                                        "allowPrivilegeEscalation": False,
                                        "capabilities": {"drop": ["ALL"]},
                                    },
                                    "volumeMounts": [
                                        {"name": "metadata", "mountPath": "/app", "readOnly": True},
                                        {"name": "tls", "mountPath": "/tls", "readOnly": True},
                                    ],
                                }
                            ],
                            "volumes": [
                                {"name": "metadata", "configMap": {"name": self.name}},
                                {
                                    "name": "tls",
                                    "secret": {"secretName": self.name, "defaultMode": 0o440},
                                },
                            ],
                        },
                    },
                },
            },
        ]

    def install(self):
        self.material(create=True)
        for obj in self.objects():
            self.platform.ensure_object(obj)
        self.platform.kubectl(
            "-n", self.namespace, "rollout", "status", "deployment/" + self.name, "--timeout=180s"
        )
