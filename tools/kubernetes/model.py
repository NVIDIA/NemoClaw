#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Install one pinned CPU inference fixture in the owned kind development stack."""

import argparse
import ipaddress
import json
import re
import sys
import uuid
from pathlib import Path

from stack import NAMESPACE, Error, Stack

IMAGE = "docker.io/ollama/ollama:0.34.0@sha256:684d8674b4315fa18f4f0e973a118ec2652ed96f67563277839985175858e0ba"
# Official registry manifest fetched over verified HTTPS on 2026-09-22:
# https://registry.ollama.ai/v2/library/qwen3/manifests/4b-instruct-2507-q4_K_M
MODEL = "qwen3:4b-instruct-2507-q4_K_M"
MODEL_SHA256 = "0edcdef34593eac1aa2be9c7d06c432dcf81945adca5eca2f27662c18f168ba0"
NAME = "nemoclaw-dev-ollama"
LABELS = {"app": NAME, "app.kubernetes.io/managed-by": "nemoclaw-kind-development"}
RFC1918_NETWORKS = tuple(
    ipaddress.IPv4Network(network) for network in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")
)


def metadata():
    return {"name": NAME, "namespace": NAMESPACE, "labels": LABELS}


def network_policy(download, verified=False):
    egress = []
    if download:
        egress = [
            {
                "to": [
                    {
                        "namespaceSelector": {
                            "matchLabels": {"kubernetes.io/metadata.name": "kube-system"}
                        }
                    }
                ],
                "ports": [{"protocol": "UDP", "port": 53}, {"protocol": "TCP", "port": 53}],
            },
            {"ports": [{"protocol": "TCP", "port": 443}]},
        ]
    return {
        "apiVersion": "networking.k8s.io/v1",
        "kind": "NetworkPolicy",
        "metadata": metadata(),
        "spec": {
            "podSelector": {"matchLabels": {"app": NAME}},
            "policyTypes": ["Ingress", "Egress"],
            "ingress": (
                [{"from": [{"podSelector": {}}], "ports": [{"protocol": "TCP", "port": 11434}]}]
                if verified
                else []
            ),
            "egress": egress,
        },
    }


def manifests():
    return [
        {
            "apiVersion": "v1",
            "kind": "PersistentVolumeClaim",
            "metadata": metadata(),
            "spec": {
                "accessModes": ["ReadWriteOnce"],
                "resources": {"requests": {"storage": "6Gi"}},
            },
        },
        {
            "apiVersion": "v1",
            "kind": "Service",
            "metadata": metadata(),
            "spec": {"selector": {"app": NAME}, "ports": [{"port": 11434, "targetPort": 11434}]},
        },
        network_policy(True),
        {
            "apiVersion": "apps/v1",
            "kind": "Deployment",
            "metadata": metadata(),
            "spec": {
                "replicas": 1,
                "strategy": {"type": "Recreate"},
                "selector": {"matchLabels": {"app": NAME}},
                "template": {
                    "metadata": {"labels": LABELS},
                    "spec": {
                        "automountServiceAccountToken": False,
                        "securityContext": {
                            "runAsNonRoot": True,
                            "runAsUser": 1000,
                            "runAsGroup": 1000,
                            "fsGroup": 1000,
                            "seccompProfile": {"type": "RuntimeDefault"},
                        },
                        "containers": [
                            {
                                "name": "ollama",
                                "image": IMAGE,
                                "imagePullPolicy": "IfNotPresent",
                                "env": [
                                    {"name": "HOME", "value": "/models"},
                                    {"name": "OLLAMA_MODELS", "value": "/models"},
                                    {"name": "OLLAMA_HOST", "value": "0.0.0.0:11434"},
                                    {"name": "OLLAMA_KEEP_ALIVE", "value": "15m"},
                                    {"name": "OLLAMA_CONTEXT_LENGTH", "value": "32768"},
                                    # Auto-detection sees host CPUs instead of the Pod quota.
                                    {"name": "LLAMA_ARG_THREADS", "value": "8"},
                                ],
                                "securityContext": {
                                    "allowPrivilegeEscalation": False,
                                    "readOnlyRootFilesystem": True,
                                    "capabilities": {"drop": ["ALL"]},
                                },
                                "resources": {
                                    "requests": {"cpu": "2", "memory": "8Gi"},
                                    "limits": {"cpu": "8", "memory": "16Gi"},
                                },
                                "ports": [{"containerPort": 11434}],
                                "readinessProbe": {
                                    "httpGet": {"path": "/api/tags", "port": 11434},
                                    "periodSeconds": 5,
                                },
                                "volumeMounts": [
                                    {"name": "models", "mountPath": "/models"},
                                    {"name": "tmp", "mountPath": "/tmp"},
                                ],
                            }
                        ],
                        "volumes": [
                            {"name": "models", "persistentVolumeClaim": {"claimName": NAME}},
                            {"name": "tmp", "emptyDir": {}},
                        ],
                    },
                },
            },
        },
    ]


def configuration(image, address, harness):
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}", image):
        raise Error("agent image must use an immutable sha256 reference")
    try:
        ip = ipaddress.IPv4Address(address)
    except ipaddress.AddressValueError as error:
        raise Error("inference service must have a private IPv4 address") from error
    # Match the SDK's RFC1918 policy rather than Python's broader is_private.
    if not any(ip in network for network in RFC1918_NETWORKS):
        raise Error("inference service must have a private routable IPv4 address")
    if harness not in {"openclaw", "deepagents"}:
        raise Error("the local AMD64 fixture supports openclaw or deepagents")
    return {
        "apiVersion": "nemoclaw.nvidia.com/v1alpha1",
        "kind": "NemoClawConfig",
        "metadata": {"name": "kind-agent", "uid": str(uuid.uuid4())},
        "spec": {
            "gateway": {
                "management": "external",
                "endpoint": "https://127.0.0.1:17671",
                "credential": {"env": "NEMOCLAW_K8S_TOKEN"},
                "tls": {
                    "ca": {"env": "NEMOCLAW_K8S_CA"},
                    "certificate": {"env": "NEMOCLAW_K8S_CERT"},
                    "key": {"env": "NEMOCLAW_K8S_KEY"},
                },
            },
            "inferenceProviders": [
                {
                    "name": "local-model",
                    "provider": "openai",
                    "endpoint": f"http://{address}:11434/v1",
                }
            ],
            "sandboxes": [
                {
                    "name": "assistant",
                    "image": {"ref": image},
                    "runtime": {"provider": "kubernetes"},
                    "network": {"tier": "isolated"},
                    "harness": {"kind": harness},
                    "agent": {
                        "name": "main",
                        "inference": {
                            "routes": [
                                {
                                    "name": "primary",
                                    "providerRef": "local-model",
                                    "overrides": {"model": MODEL},
                                }
                            ]
                        },
                    },
                }
            ],
        },
    }


def deploy(stack):
    stack.guard()
    for manifest in manifests():
        existing = stack.kubectl(
            "-n", NAMESPACE, "get", manifest["kind"], NAME, "--ignore-not-found", "-o", "json"
        ).stdout
        if existing and any(
            json.loads(existing)["metadata"].get("labels", {}).get(k) != v
            for k, v in LABELS.items()
        ):
            raise Error(
                "refusing to overwrite an inference resource without the development ownership labels"
            )
    verified = False
    try:
        for manifest in manifests():
            stack.apply_json(manifest)
        stack.kubectl("-n", NAMESPACE, "rollout", "status", "deployment/" + NAME, "--timeout=600s")
        print("Downloading the pinned CPU development model.", flush=True)
        stack.kubectl(
            "-n",
            NAMESPACE,
            "exec",
            "deployment/" + NAME,
            "--",
            "ollama",
            "pull",
            MODEL,
            timeout=1200,
        )
        verify_model(stack)
        verified = True
    finally:
        # The serving process has no network egress after model acquisition,
        # including when the download or integrity check failed.
        stack.apply_json(network_policy(False, verified=verified))
    print("CPU inference fixture is ready; runtime egress is denied.", flush=True)


def verify_model(stack):
    reference = re.fullmatch(r"([a-z0-9][a-z0-9_-]*):([a-zA-Z0-9][a-zA-Z0-9_.-]*)", MODEL)
    if reference is None:
        raise Error("model must name one official library model and explicit tag")
    name, tag = reference.groups()
    digest = stack.kubectl(
        "-n",
        NAMESPACE,
        "exec",
        "deployment/" + NAME,
        "--",
        "sha256sum",
        f"/models/manifests/registry.ollama.ai/library/{name}/{tag}",
    ).stdout.split()
    if not digest or digest[0] != MODEL_SHA256:
        raise Error("downloaded model manifest differs from the accepted immutable model")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["deploy", "configuration"])
    parser.add_argument(
        "--state-dir", type=Path, default=Path.home() / ".local/state/nemoclaw/kubernetes-dev"
    )
    parser.add_argument("--agent-image")
    parser.add_argument("--harness", choices=["openclaw", "deepagents"], default="openclaw")
    args = parser.parse_args()
    try:
        stack = Stack(args.state_dir)
        stack.preflight()
        stack.guard()
        if args.action == "deploy":
            deploy(stack)
        else:
            if not args.agent_image:
                raise Error("configuration requires --agent-image repository@sha256:digest")
            output = stack.state / "deployment.json"
            if output.exists():
                raise Error("deployment.json already exists; retain its UID and edit it explicitly")
            verify_model(stack)
            address = stack.kubectl(
                "-n", NAMESPACE, "get", "service", NAME, "-o", "jsonpath={.spec.clusterIP}"
            ).stdout
            stack.write(
                output,
                (
                    json.dumps(configuration(args.agent_image, address, args.harness), indent=2)
                    + "\n"
                ).encode(),
            )
            print("Saved desired state to " + str(output), flush=True)
    except (Error, OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
