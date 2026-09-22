#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Own one disposable kind development stack without using ambient kubeconfig.

The Kubernetes backend development request extends docs/design/scope.md only
for this isolated development stack. Upstream charts remain unmodified.
"""

import argparse
import base64
import hashlib
import io
import json
import os
import re
import secrets
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
import uuid
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
LOCK = json.loads(Path(__file__).with_name("sources.json").read_text())
NAMESPACE = "nemoclaw-dev"
RELEASE = "openshell"


class Error(Exception):
    pass


def check_cluster_name(name):
    if not re.fullmatch(r"nemoclaw-v1-[a-z0-9]{8}", name):
        raise Error("refusing a cluster outside the dedicated NemoClaw development naming contract")


def check_state_path(path):
    if path.is_symlink() or REPO == path.resolve() or REPO in path.resolve().parents:
        raise Error("state must be a real private directory outside the repository")
    if path.exists() and (path.stat().st_uid != os.getuid() or path.stat().st_mode & 0o077):
        raise Error("state must be owned by the current user with mode 0700")


def check_identity(receipt, binding, nodes, system_uid):
    check_cluster_name(receipt["cluster"])
    expected = receipt["binding"]
    if expected["context"] != "kind-" + receipt["cluster"]:
        raise Error("receipt context does not identify the owned cluster")
    if not re.fullmatch(r"https://127\.0\.0\.1:[0-9]+", expected["server"]):
        raise Error("the dedicated kind API must use a loopback endpoint")
    if binding != expected or nodes != receipt["nodes"] or system_uid != receipt["system_uid"]:
        raise Error("cluster identity changed; refusing access or cleanup")


def verify_bytes(data, digest):
    if hashlib.sha256(data).hexdigest() != digest:
        raise Error("downloaded artifact does not match its pinned SHA256")


def image_digest_aliases(digests, listing):
    """Register only digests whose OCI content kind actually imported."""
    if not digests:
        raise Error(
            "local image has no repository digest; use a digest-retaining Docker image store"
        )
    images = {
        row[0]: row[2]
        for line in listing.splitlines()
        if len(row := line.split()) >= 3 and row[2].startswith("sha256:")
    }
    result = []
    for reference in digests:
        if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}", reference):
            raise Error("local image repository digest is malformed")
        repository, digest = reference.split("@", 1)
        if "/" not in repository:
            repository = "docker.io/library/" + repository
        elif not any(
            marker in repository.split("/")[0] for marker in [".", ":"]
        ) and not repository.startswith("localhost/"):
            repository = "docker.io/" + repository
        alias = repository + "@" + digest
        if alias in images:
            if images[alias] != digest:
                raise Error("existing node image digest alias refers to different content")
            continue
        source = next((name for name, target in images.items() if target == digest), None)
        if source is None:
            raise Error("kind did not import the expected immutable OCI image content")
        result.append((source, alias))
    return result


def pin_manifest_images(data):
    """Change only exact image scalars in the checksum-verified prerequisite."""

    def replace(match):
        original = match.group(2)
        digest = LOCK["dependencyImages"].get(original)
        if not digest:
            raise Error("prerequisite manifest contains an unpinned image")
        return match.group(1) + original + "@" + digest

    text = data.decode()
    return re.sub(r"(?m)^(\s*image: )([^\s]+)$", replace, text).encode()


def chart_values():
    from auth import OIDC_VALUES

    pins = json.loads((REPO / "versions.json").read_text())
    if LOCK["openshell"]["directory"] != "OpenShell-" + pins["openshellRevision"]:
        raise Error("upstream chart revision must match versions.json")

    def image(key):
        repository, digest = pins["images"][key].split("@", 1)
        # Upstream accepts repository:tag; an OCI tag@digest selects the digest.
        return {"repository": repository, "tag": "pinned@" + digest, "pullPolicy": "IfNotPresent"}

    supervisor = image("supervisor")
    supervisor["pullPolicy"] = "if_not_present"
    return {
        "fullnameOverride": RELEASE,
        "image": image("gateway"),
        "sandboxRuntime": {"image": image("sandboxRuntime")},
        "supervisor": {"image": supervisor, "sandboxRuntime": {"networkPolicyEnforced": True}},
        "server": {
            "telemetryEnabled": False,
            "disableTls": False,
            "auth": {"allowUnauthenticatedUsers": False},
            "oidc": OIDC_VALUES,
            "tls": {"enableMtls": True},
            "credentialStorage": {"existingSecret": "nemoclaw-kek"},
            "sandboxImage": pins["images"]["sandboxRuntime"],
            "sandboxImagePullPolicy": "if_not_present",
            "workspaceDefaultStorageSize": "2Gi",
            "drivers": {"kubernetes": {"workspaceMode": "shared"}},
        },
        "pkiInitJob": {"enabled": True},
        "resources": {
            "requests": {"cpu": "250m", "memory": "256Mi"},
            "limits": {"cpu": "1", "memory": "1Gi"},
        },
    }


def key_encryption_secret():
    # The gateway reads base64 TEXT from an environment variable. Kubernetes
    # Secret.data requires a second encoding around that ASCII value.
    encoded = base64.b64encode(secrets.token_bytes(32))
    return {
        "apiVersion": "v1",
        "kind": "Secret",
        "metadata": {"name": "nemoclaw-kek", "namespace": NAMESPACE},
        "type": "Opaque",
        "data": {"key-encryption-key": base64.b64encode(encoded).decode()},
    }


def run(args, *, data=None, check=True, timeout=900, sensitive=False):
    result = subprocess.run(args, input=data, text=True, capture_output=True, timeout=timeout)
    if check and result.returncode:
        # Secret responses and inputs never enter diagnostics.
        detail = "" if sensitive else result.stderr[-2000:].strip()
        raise Error(
            f"{Path(args[0]).name} failed (exit {result.returncode})"
            + (f": {detail}" if detail else "")
        )
    return result


class Stack:
    def __init__(self, state):
        self.state = state.absolute()
        check_state_path(self.state)
        self.kubeconfig = self.state / "kubeconfig"
        self.receipt_file = self.state / "ownership.json"
        self.receipt = (
            json.loads(self.receipt_file.read_text()) if self.receipt_file.exists() else None
        )
        self.privileged = []

    def preflight(self):
        for program in ["docker", "kind", "kubectl", "helm", "openssl"]:
            if not shutil.which(program):
                raise Error(f"required existing tool is unavailable: {program}")
        if run(["docker", "info", "--format", "{{.ServerVersion}}"], check=False).returncode:
            if not shutil.which("sudo"):
                raise Error("Docker is unavailable and noninteractive sudo is not installed")
            run(["sudo", "-n", "docker", "info", "--format", "{{.ServerVersion}}"])
            self.privileged = ["sudo", "-n"]
        chart_values()
        print("Preflight passed: existing tools and Docker are available.", flush=True)

    def prepare(self):
        self.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        check_state_path(self.state)
        cache = self.state / "sources"
        cache.mkdir(exist_ok=True, mode=0o700)
        for name in ["openshell", "agentSandbox", "calico"]:
            artifact = LOCK[name]
            dest = cache / (name + (".tar.gz" if name == "openshell" else ".yaml"))
            data = (
                dest.read_bytes()
                if dest.exists()
                else urllib.request.urlopen(artifact["url"], timeout=60).read()
            )
            verify_bytes(data, artifact["sha256"])
            if not dest.exists():
                self.write(dest, data)
            if name == "openshell":
                source = cache / artifact["directory"]
                # Replace the entire source directory: overwriting archive
                # members would preserve extra, unverified chart templates.
                with tempfile.TemporaryDirectory(prefix=".openshell-", dir=cache) as staging:
                    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
                        archive.extractall(staging, filter="data")
                    extracted = Path(staging) / artifact["directory"]
                    if not extracted.is_dir() or extracted.is_symlink():
                        raise Error("verified OpenShell archive must contain its source directory")
                    if source.is_symlink():
                        source.unlink()
                    elif source.exists():
                        shutil.rmtree(source)
                    extracted.replace(source)
                self.chart = source / "deploy/helm/openshell"
            else:
                self.write(self.state / (name + "-pinned.yaml"), pin_manifest_images(data))
        self.values = self.state / "values.json"
        self.write(self.values, json.dumps(chart_values(), indent=2).encode())

    @staticmethod
    def write(path, data):
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "wb") as output:
            output.write(data)

    def save_receipt(self):
        self.write(self.receipt_file, json.dumps(self.receipt, indent=2).encode())

    def docker(self, *args, **kwargs):
        return run(self.privileged + ["docker", *args], **kwargs)

    def nodes(self, name):
        check_cluster_name(name)
        result = self.docker(
            "ps",
            "-a",
            "--filter",
            "label=io.x-k8s.kind.cluster=" + name,
            "--format",
            "{{.Names}} {{.ID}}",
            "--no-trunc",
        )
        return dict(line.split() for line in result.stdout.splitlines())

    def kubectl(self, *args, **kwargs):
        return run(
            [
                "kubectl",
                "--kubeconfig",
                str(self.kubeconfig),
                "--context",
                "kind-" + self.receipt["cluster"],
                *args,
            ],
            **kwargs,
        )

    def binding(self):
        config = json.loads(
            self.kubectl("config", "view", "--raw", "--minify", "-o", "json", sensitive=True).stdout
        )
        cluster = config["clusters"][0]["cluster"]
        if "certificate-authority-data" not in cluster or cluster.get("insecure-skip-tls-verify"):
            raise Error("private kubeconfig must retain its inline kind CA and verify TLS")
        return {
            "context": config["current-context"],
            "server": cluster["server"],
            "ca": hashlib.sha256(cluster["certificate-authority-data"].encode()).hexdigest(),
        }

    def guard(self):
        if not self.receipt or self.receipt.get("phase") != "ready":
            raise Error("a complete private cluster ownership receipt is required")
        # Check Docker identities and local configuration before contacting Kubernetes.
        actual_nodes = self.nodes(self.receipt["cluster"])
        actual_binding = self.binding()
        check_identity(self.receipt, actual_binding, actual_nodes, self.receipt["system_uid"])
        uid = self.kubectl(
            "get", "namespace", "kube-system", "-o", "jsonpath={.metadata.uid}"
        ).stdout
        check_identity(self.receipt, actual_binding, actual_nodes, uid)

    def create(self):
        if self.receipt:
            self.guard()
            return
        name = "nemoclaw-v1-" + uuid.uuid4().hex[:8]
        if self.nodes(name):
            raise Error("dedicated cluster name already exists; refusing adoption")
        config = self.state / "kind.json"
        self.write(
            config,
            json.dumps(
                {
                    "kind": "Cluster",
                    "apiVersion": "kind.x-k8s.io/v1alpha4",
                    "networking": {
                        "disableDefaultCNI": True,
                        "podSubnet": "192.168.0.0/16",
                        "apiServerAddress": "127.0.0.1",
                    },
                    "nodes": [{"role": "control-plane", "image": LOCK["kindNode"]}],
                }
            ).encode(),
        )
        self.receipt = {"cluster": name, "phase": "creating", "owner": str(uuid.uuid4())}
        self.save_receipt()
        print("Creating dedicated cluster " + name + ".", flush=True)
        root_config = self.state / "kind-created-kubeconfig"
        result = run(
            self.privileged
            + [
                "kind",
                "create",
                "cluster",
                "--name",
                name,
                "--config",
                str(config),
                "--kubeconfig",
                str(root_config),
                "--retain",
                "--wait",
                "0s",
            ],
            check=False,
        )
        self.receipt["nodes"] = self.nodes(name)
        self.save_receipt()
        if result.returncode:
            raise Error(
                "kind creation failed; retained owned nodes for explicit cleanup: "
                + result.stderr[-1000:]
            )
        content = run(self.privileged + ["cat", str(root_config)], sensitive=True).stdout
        self.write(self.kubeconfig, content.encode())
        root_config.unlink()
        self.receipt["binding"] = self.binding()
        self.receipt["system_uid"] = self.kubectl(
            "get", "namespace", "kube-system", "-o", "jsonpath={.metadata.uid}"
        ).stdout
        self.receipt["phase"] = "ready"
        self.save_receipt()
        self.guard()

    def render(self):
        self.prepare()
        result = run(
            [
                "helm",
                "template",
                RELEASE,
                str(self.chart),
                "--namespace",
                NAMESPACE,
                "-f",
                str(self.values),
                "--set",
                "agentSandbox.preflight.enabled=false",
            ]
        )
        output = self.state / "openshell-rendered.yaml"
        self.write(output, result.stdout.encode())
        print("Rendered official upstream chart to " + str(output), flush=True)

    def apply_json(self, document):
        self.guard()
        self.kubectl("apply", "-f", "-", data=json.dumps(document), sensitive=True)

    def policy_probe(self):
        """Prove ingress and egress isolation each block a healthy connection."""
        self.guard()
        namespace = "nemoclaw-network-probe"
        self.apply_json({"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": namespace}})
        for name, command in [
            ("server", ["sh", "-c", "echo ready >/tmp/index.html; exec httpd -f -p 8080 -h /tmp"]),
            ("client", ["sleep", "600"]),
        ]:
            self.apply_json(
                {
                    "apiVersion": "v1",
                    "kind": "Pod",
                    "metadata": {"name": name, "namespace": namespace, "labels": {"app": name}},
                    "spec": {
                        "automountServiceAccountToken": False,
                        "restartPolicy": "Never",
                        "containers": [
                            {
                                "name": name,
                                "image": LOCK["policyProbeImage"],
                                "command": command,
                                "securityContext": {
                                    "allowPrivilegeEscalation": False,
                                    "runAsUser": 1000,
                                    "capabilities": {"drop": ["ALL"]},
                                },
                            }
                        ],
                    },
                }
            )
        self.kubectl(
            "-n", namespace, "wait", "--for=condition=Ready", "pod", "--all", "--timeout=180s"
        )
        ip = self.kubectl(
            "-n", namespace, "get", "pod", "server", "-o", "jsonpath={.status.podIP}"
        ).stdout
        probe = [
            "-n",
            namespace,
            "exec",
            "client",
            "--",
            "wget",
            "-q",
            "-T",
            "2",
            "-O",
            "-",
            "http://" + ip + ":8080",
        ]
        self.kubectl(*probe)
        for direction, selected in [("Ingress", "server"), ("Egress", "client")]:
            self.apply_json(
                {
                    "apiVersion": "networking.k8s.io/v1",
                    "kind": "NetworkPolicy",
                    "metadata": {"name": "deny-probe", "namespace": namespace},
                    "spec": {
                        "podSelector": {"matchLabels": {"app": selected}},
                        "policyTypes": [direction],
                        direction.lower(): [],
                    },
                }
            )
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                result = self.kubectl(*probe, check=False)
                if result.returncode and "timed out" in result.stderr:
                    break
                time.sleep(1)
            else:
                raise Error(direction + " NetworkPolicy did not block a proven healthy connection")
            self.guard()
            self.kubectl("-n", namespace, "delete", "networkpolicy", "deny-probe")
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                if self.kubectl(*probe, check=False).returncode == 0:
                    break
                time.sleep(1)
            else:
                raise Error(
                    "connectivity did not recover after removing " + direction + " probe policy"
                )
        self.kubectl("delete", "namespace", namespace, "--wait=false")
        print("NetworkPolicy ingress and egress tests passed: allow, deny, then allow.", flush=True)

    def deploy(self):
        self.prepare()
        self.create()
        self.guard()
        self.kubectl("apply", "--server-side", "-f", str(self.state / "calico-pinned.yaml"))
        self.kubectl(
            "-n", "kube-system", "rollout", "status", "daemonset/calico-node", "--timeout=300s"
        )
        self.kubectl("wait", "--for=condition=Ready", "node", "--all", "--timeout=300s")
        self.policy_probe()
        self.guard()
        self.kubectl("apply", "--server-side", "-f", str(self.state / "agentSandbox-pinned.yaml"))
        self.kubectl(
            "wait", "--for=condition=Established", "crd/sandboxes.agents.x-k8s.io", "--timeout=120s"
        )
        self.kubectl(
            "-n",
            "agent-sandbox-system",
            "rollout",
            "status",
            "deployment/agent-sandbox-controller",
            "--timeout=300s",
        )
        self.apply_json({"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": NAMESPACE}})
        from auth import install

        install(self)
        present = self.kubectl(
            "-n", NAMESPACE, "get", "secret", "nemoclaw-kek", "--ignore-not-found", "-o", "name"
        )
        if not present.stdout.strip():
            self.apply_json(key_encryption_secret())
        self.guard()
        print("Installing the pinned upstream OpenShell chart with mTLS.", flush=True)
        run(
            [
                "helm",
                "upgrade",
                "--install",
                RELEASE,
                str(self.chart),
                "--namespace",
                NAMESPACE,
                "--kubeconfig",
                str(self.kubeconfig),
                "--kube-context",
                "kind-" + self.receipt["cluster"],
                "-f",
                str(self.values),
                "--wait",
                "--timeout",
                "10m",
            ]
        )
        self.verify()
        self.credentials()

    def verify(self):
        self.guard()
        self.kubectl(
            "-n", "kube-system", "rollout", "status", "daemonset/calico-node", "--timeout=60s"
        )
        self.kubectl(
            "-n",
            "agent-sandbox-system",
            "rollout",
            "status",
            "deployment/agent-sandbox-controller",
            "--timeout=60s",
        )
        self.kubectl(
            "-n", NAMESPACE, "rollout", "status", "statefulset/openshell", "--timeout=120s"
        )
        print("Owned stack is ready: Calico, Agent Sandbox, and OpenShell.", flush=True)

    def credentials(self):
        self.guard()
        secret = json.loads(
            self.kubectl(
                "-n",
                NAMESPACE,
                "get",
                "secret",
                "openshell-client-tls",
                "-o",
                "json",
                sensitive=True,
            ).stdout
        )
        paths = {}
        for key, variable in [
            ("ca.crt", "NEMOCLAW_K8S_CA"),
            ("tls.crt", "NEMOCLAW_K8S_CERT"),
            ("tls.key", "NEMOCLAW_K8S_KEY"),
        ]:
            dest = self.state / key
            self.write(dest, base64.b64decode(secret["data"][key], validate=True))
            paths[variable] = str(dest)
        self.write(
            self.state / "environment.env",
            (
                "\n".join(
                    "export " + key + "=" + shlex.quote(value) for key, value in paths.items()
                )
                + "\n"
            ).encode(),
        )
        from auth import export_environment

        export_environment(self)
        self.write(
            self.state / "connection.json",
            json.dumps(
                {
                    "namespace": NAMESPACE,
                    "context": "kind-" + self.receipt["cluster"],
                    "kubeconfig": str(self.kubeconfig),
                    "endpoint": "https://127.0.0.1:17671",
                    "tlsEnvironmentFile": str(self.state / "environment.env"),
                },
                indent=2,
            ).encode(),
        )
        print(
            "Private TLS file references saved to " + str(self.state / "environment.env"),
            flush=True,
        )

    def connect(self):
        self.guard()
        print(
            "Forwarding the owned gateway on https://127.0.0.1:17671; press Ctrl-C to stop.",
            flush=True,
        )
        subprocess.run(
            [
                "kubectl",
                "--kubeconfig",
                str(self.kubeconfig),
                "--context",
                "kind-" + self.receipt["cluster"],
                "-n",
                NAMESPACE,
                "port-forward",
                "--address",
                "127.0.0.1",
                "service/openshell",
                "17671:8080",
            ],
            check=True,
        )

    def load_image(self, image):
        self.guard()
        if not image or image.startswith("-") or any(char.isspace() for char in image):
            raise Error("an explicit local image reference is required")
        digests = json.loads(
            self.docker("image", "inspect", image, "--format", "{{json .RepoDigests}}").stdout
        )
        if not digests:
            raise Error("local image must have an immutable repository digest before loading")
        run(
            self.privileged
            + ["kind", "load", "docker-image", "--name", self.receipt["cluster"], image]
        )
        # kind preserves OCI content but its tag-only import need not create a
        # CRI repository-digest reference. Verify content before adding aliases.
        self.guard()
        for node in self.receipt["nodes"]:
            listing = self.docker("exec", node, "ctr", "-n", "k8s.io", "images", "ls").stdout
            for source, alias in image_digest_aliases(digests, listing):
                self.docker("exec", node, "ctr", "-n", "k8s.io", "images", "tag", source, alias)
        print(
            "Loaded and verified immutable image references in the owned kind cluster.", flush=True
        )

    def cleanup(self, confirmation):
        if not self.receipt or confirmation != self.receipt["cluster"]:
            raise Error("cleanup requires --confirm-cluster matching the private ownership receipt")
        if self.receipt.get("phase") == "ready":
            self.guard()
        elif (
            self.receipt.get("phase") != "creating"
            or not self.receipt.get("nodes")
            or self.nodes(confirmation) != self.receipt["nodes"]
        ):
            raise Error("partial cluster identity cannot be verified; refusing cleanup")
        run(
            self.privileged
            + [
                "kind",
                "delete",
                "cluster",
                "--name",
                confirmation,
                "--kubeconfig",
                str(self.kubeconfig),
            ]
        )
        self.receipt["phase"] = "deleted"
        self.save_receipt()
        for name in [
            "kubeconfig",
            "kind-created-kubeconfig",
            "ca.crt",
            "tls.crt",
            "tls.key",
            "environment.env",
        ]:
            (self.state / name).unlink(missing_ok=True)
        private_oidc = self.state / "oidc"
        if private_oidc.is_dir() and not private_oidc.is_symlink():
            shutil.rmtree(private_oidc)
        print("Deleted only the owned cluster and its local connection credentials.", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "action",
        choices=["preflight", "render", "deploy", "verify", "connect", "load-image", "cleanup"],
    )
    parser.add_argument(
        "--state-dir", type=Path, default=Path.home() / ".local/state/nemoclaw/kubernetes-dev"
    )
    parser.add_argument("--confirm-cluster")
    parser.add_argument("--image")
    args = parser.parse_args()
    os.umask(0o077)
    try:
        stack = Stack(args.state_dir)
        if args.action == "render":
            stack.render()
            return
        stack.preflight()
        if args.action == "preflight":
            return
        if args.action == "cleanup":
            stack.cleanup(args.confirm_cluster)
        elif args.action == "load-image":
            stack.load_image(args.image)
        else:
            getattr(stack, args.action)()
    except (Error, OSError, ValueError, KeyError, subprocess.TimeoutExpired) as error:
        print("Error: " + str(error), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
