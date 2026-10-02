#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Local development OIDC discovery/JWKS fixture and one-hour operator token.

This is a test issuer for the owned disposable cluster, not a login service.
The signing key stays in private operator state; the Pod serves public metadata.
"""

import argparse
import base64
import json
import os
import shlex
import shutil
import subprocess
import sys
import time
from pathlib import Path

NAME = "nemoclaw-dev-oidc"
NAMESPACE = "nemoclaw-dev"
HOST = f"{NAME}.{NAMESPACE}.svc.cluster.local"
ISSUER = f"https://{HOST}:8443"
AUDIENCE = "nemoclaw-kubernetes-development"
IMAGE = "python:3.12.12-alpine3.22@sha256:848ba4413eb897e225159b8fc1b02094576cbae4aa73fc13142608ae2c8c0e32"
SCOPES = (
    "config:read",
    "config:write",
    "provider:read",
    "provider:write",
    "sandbox:read",
    "sandbox:write",
    "workspace:read",
    "workspace:write",
)
OIDC_VALUES = {
    "issuer": ISSUER,
    "audience": AUDIENCE,
    "rolesClaim": "roles",
    "adminRole": "nemoclaw-development-admin",
    "userRole": "nemoclaw-development-user",
    "scopesClaim": "scope",
    "jwksTtl": 60,
    "caConfigMapName": NAME + "-ca",
    "dangerouslyAllowInsecureHttp": False,
}


def encode(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def claims(now, owner):
    return {
        "iss": ISSUER,
        "aud": AUDIENCE,
        "sub": "nemoclaw-development-" + owner,
        "preferred_username": "nemoclaw-development-operator",
        "iat": now,
        "nbf": now,
        "exp": now + 3600,
        "roles": [OIDC_VALUES["adminRole"]],
        "scope": " ".join(SCOPES),
    }


def openssl(*arguments, data=None):
    result = subprocess.run(["openssl", *map(str, arguments)], input=data, capture_output=True)
    if result.returncode:
        raise ValueError("OpenSSL operation failed; private material was not logged")
    return result.stdout


def material(stack, *, create=True):
    private = stack.state / "oidc"
    if not create and not private.exists():
        raise ValueError("OIDC material is missing; renewal cannot replace keys or trust")
    private.mkdir(exist_ok=True, mode=0o700)
    if (
        private.is_symlink()
        or private.stat().st_uid != os.getuid()
        or private.stat().st_mode & 0o077
    ):
        raise ValueError("OIDC material must remain in an owned private directory")
    required = ["ca.key", "ca.crt", "server.key", "server.crt", "signing.key"]
    auxiliary = ["server.csr", "server.ext", "ca.srl", "operator.token"]
    # OpenSSL opens its output paths directly. Validate every existing path,
    # including dangling symlinks and auxiliary outputs, before invoking it.
    for name in required + auxiliary:
        path = private / name
        if path.is_symlink() or (
            path.exists()
            and (
                not path.is_file()
                or path.stat().st_uid != os.getuid()
                or path.stat().st_mode & 0o077
            )
        ):
            raise ValueError("OIDC material requires regular files with owner-only access")
    present = [name for name in required if (private / name).exists()]
    if present and len(present) != len(required):
        raise ValueError("incomplete OIDC material; refusing key rotation or partial recovery")
    if not present:
        if (
            not create
            or (stack.receipt or {}).get("oidc_initialized")
            or any((private / name).exists() for name in auxiliary)
        ):
            raise ValueError("OIDC keys are missing; refusing replacement of existing material")
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
            "/CN=NemoClaw disposable OIDC CA",
            "-keyout",
            private / "ca.key",
            "-out",
            private / "ca.crt",
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
            "/CN=" + HOST,
            "-keyout",
            private / "server.key",
            "-out",
            private / "server.csr",
        )
        extension = private / "server.ext"
        stack.write(
            extension, ("subjectAltName=DNS:" + HOST + "\nextendedKeyUsage=serverAuth\n").encode()
        )
        openssl(
            "x509",
            "-req",
            "-in",
            private / "server.csr",
            "-CA",
            private / "ca.crt",
            "-CAkey",
            private / "ca.key",
            "-CAcreateserial",
            "-out",
            private / "server.crt",
            "-days",
            "7",
            "-sha256",
            "-extfile",
            extension,
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
            private / "signing.key",
        )
    for name in required:
        path = private / name
        if path.is_symlink() or path.stat().st_uid != os.getuid() or path.stat().st_mode & 0o077:
            raise ValueError("OIDC key and certificate files require owner-only access")
    openssl("x509", "-checkend", "3600", "-noout", "-in", private / "server.crt")
    if not stack.receipt.get("oidc_initialized"):
        # Preserve this fact outside the key directory so total key loss cannot
        # turn a repeated deployment into an implicit CA and signing-key rotation.
        stack.receipt["oidc_initialized"] = True
        stack.save_receipt()
    return private


def public_metadata(private):
    modulus = openssl("rsa", "-in", private / "signing.key", "-noout", "-modulus").decode().strip()
    if not modulus.startswith("Modulus="):
        raise ValueError("unexpected RSA public-key encoding")
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
            "issuer": ISSUER,
            "jwks_uri": ISSUER + "/jwks",
            "id_token_signing_alg_values_supported": ["RS256"],
        },
        "/jwks": {"keys": [key]},
    }


def network_policy():
    return {
        "apiVersion": "networking.k8s.io/v1",
        "kind": "NetworkPolicy",
        "metadata": {"name": NAME, "namespace": NAMESPACE},
        "spec": {
            "podSelector": {"matchLabels": {"app": NAME}},
            "policyTypes": ["Ingress", "Egress"],
            "egress": [],
            "ingress": [
                {
                    "from": [
                        {
                            "podSelector": {
                                "matchLabels": {
                                    "app.kubernetes.io/instance": "openshell",
                                    "app.kubernetes.io/name": "openshell",
                                }
                            }
                        }
                    ],
                    "ports": [{"protocol": "TCP", "port": 8443}],
                }
            ],
        },
    }


def export_environment(stack):
    token = stack.state / "oidc/operator.token"
    environment = stack.state / "environment.env"
    if not token.exists() or not environment.exists():
        return
    lines = [
        line
        for line in environment.read_text().splitlines()
        if not line.startswith("export NEMOCLAW_K8S_TOKEN=")
    ]
    lines.append("export NEMOCLAW_K8S_TOKEN=$(cat " + shlex.quote(str(token)) + ")")
    stack.write(environment, ("\n".join(lines) + "\n").encode())


def renew(stack):
    stack.guard()
    private = material(stack, create=False)
    header = encode(
        json.dumps(
            {"alg": "RS256", "typ": "JWT", "kid": "nemoclaw-development"}, separators=(",", ":")
        ).encode()
    )
    payload = encode(
        json.dumps(claims(int(time.time()), stack.receipt["owner"]), separators=(",", ":")).encode()
    )
    message = (header + "." + payload).encode()
    signature = openssl("dgst", "-sha256", "-sign", private / "signing.key", data=message)
    stack.write(private / "operator.token", message + b"." + encode(signature).encode())
    export_environment(stack)


def install(stack):
    stack.guard()
    if not shutil.which("openssl"):
        raise ValueError("an existing OpenSSL executable is required for the local issuer")
    private = material(stack)
    metadata = {"name": NAME, "namespace": NAMESPACE}
    stack.apply_json(
        {
            "apiVersion": "v1",
            "kind": "ConfigMap",
            "metadata": {"name": NAME + "-ca", "namespace": NAMESPACE},
            "data": {"ca.crt": (private / "ca.crt").read_text()},
        }
    )
    stack.apply_json(
        {
            "apiVersion": "v1",
            "kind": "Secret",
            "metadata": metadata,
            "type": "kubernetes.io/tls",
            "data": {
                "tls.crt": base64.b64encode((private / "server.crt").read_bytes()).decode(),
                "tls.key": base64.b64encode((private / "server.key").read_bytes()).decode(),
            },
        }
    )
    server = Path(__file__).with_name("oidc_server.py").read_text()
    stack.apply_json(
        {
            "apiVersion": "v1",
            "kind": "ConfigMap",
            "metadata": metadata,
            "data": {"server.py": server, "metadata.json": json.dumps(public_metadata(private))},
        }
    )
    stack.apply_json(network_policy())
    stack.apply_json(
        {
            "apiVersion": "v1",
            "kind": "Service",
            "metadata": metadata,
            "spec": {"selector": {"app": NAME}, "ports": [{"port": 8443, "targetPort": 8443}]},
        }
    )
    stack.apply_json(
        {
            "apiVersion": "apps/v1",
            "kind": "Deployment",
            "metadata": metadata,
            "spec": {
                "replicas": 1,
                "selector": {"matchLabels": {"app": NAME}},
                "template": {
                    "metadata": {"labels": {"app": NAME}},
                    "spec": {
                        "automountServiceAccountToken": False,
                        "securityContext": {
                            "runAsNonRoot": True,
                            "runAsUser": 10001,
                            "runAsGroup": 10001,
                            "fsGroup": 10001,
                            "seccompProfile": {"type": "RuntimeDefault"},
                        },
                        "containers": [
                            {
                                "name": "issuer",
                                "image": IMAGE,
                                "imagePullPolicy": "IfNotPresent",
                                "command": ["python3", "-B", "/app/server.py"],
                                "ports": [{"containerPort": 8443}],
                                "readinessProbe": {"tcpSocket": {"port": 8443}, "periodSeconds": 2},
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
                            {"name": "metadata", "configMap": {"name": NAME}},
                            {"name": "tls", "secret": {"secretName": NAME, "defaultMode": 0o440}},
                        ],
                    },
                },
            },
        }
    )
    stack.kubectl("-n", NAMESPACE, "rollout", "status", "deployment/" + NAME, "--timeout=180s")
    renew(stack)
    print("Local HTTPS OIDC fixture is ready; operator token lifetime is one hour.", flush=True)


def main():
    from stack import Error, Stack, run

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["deploy", "renew"])
    parser.add_argument(
        "--state-dir", type=Path, default=Path.home() / ".local/state/nemoclaw/kubernetes-dev"
    )
    args = parser.parse_args()
    os.umask(0o077)
    try:
        stack = Stack(args.state_dir)
        stack.preflight()
        if args.action == "renew":
            renew(stack)
        else:
            stack.prepare()
            install(stack)
            run(
                [
                    "helm",
                    "upgrade",
                    "--install",
                    "openshell",
                    str(stack.chart),
                    "--namespace",
                    NAMESPACE,
                    "--kubeconfig",
                    str(stack.kubeconfig),
                    "--kube-context",
                    "kind-" + stack.receipt["cluster"],
                    "-f",
                    str(stack.values),
                    "--wait",
                    "--timeout",
                    "5m",
                ]
            )
            stack.verify()
            stack.credentials()
        print("Credential environment: " + str(stack.state / "environment.env"))
    except (Error, OSError, ValueError, KeyError, subprocess.TimeoutExpired) as error:
        print("Error: " + str(error), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
