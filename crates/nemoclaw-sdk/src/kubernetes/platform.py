# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Private JSON protocol for an owned OpenShell release on an explicit cluster.

No kind, ambient context, shell evaluation, chart fork, or credential output is
used. Only connection responses carry ephemeral credentials to the SDK parent.
"""

import base64
import copy
import gzip
import hashlib
import io
import ipaddress
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
from pathlib import Path

from auth import DevelopmentAuth

OWNER = "nemoclaw.nvidia.com/uid"
GENERATION = "nemoclaw.nvidia.com/generation"
SPEC = "nemoclaw.nvidia.com/platform-spec"
STORAGE = "kubernetes_storage"
GATEWAY = "kubernetes_gateway"
ERRORS = {"binding", "incomplete", "prerequisite", "command", "auth", "configuration", "transport"}
PREREQUISITES = [
    ("Namespace", "agent-sandbox-system", ""),
    ("ServiceAccount", "agent-sandbox-controller", "agent-sandbox-system"),
    ("ClusterRoleBinding", "agent-sandbox-controller", ""),
    ("Role", "agent-sandbox-controller", "agent-sandbox-system"),
    ("RoleBinding", "agent-sandbox-controller", "agent-sandbox-system"),
    ("Service", "agent-sandbox-controller", "agent-sandbox-system"),
    ("Deployment", "agent-sandbox-controller", "agent-sandbox-system"),
    ("Service", "agent-sandbox-webhook-service", "agent-sandbox-system"),
    ("CustomResourceDefinition", "sandboxes.agents.x-k8s.io", ""),
    ("ClusterRole", "agent-sandbox-controller", ""),
]


class Error(Exception):
    pass


def digest(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def verify_bytes(data, expected):
    if hashlib.sha256(data).hexdigest() != expected:
        raise Error("configuration")


def json_objects(text):
    decoder = json.JSONDecoder()
    objects = []
    remaining = text.strip()
    while remaining:
        value, index = decoder.raw_decode(remaining)
        if value.get("kind") == "List":
            objects.extend(value["items"])
        else:
            objects.append(value)
        remaining = remaining[index:].strip()
    return objects


def object_key(obj):
    metadata = obj["metadata"]
    return "/".join((obj["kind"], metadata.get("namespace", ""), metadata["name"]))


def identity(obj):
    return {
        "kind": obj["kind"],
        "metadata": {
            key: obj["metadata"][key] for key in ("name", "namespace") if key in obj["metadata"]
        },
    }


def shape(value):
    if isinstance(value, dict):
        return {key: shape(child) for key, child in value.items()}
    if isinstance(value, list):
        return [shape(child) for child in value]
    return True


def project(value, template):
    if isinstance(template, dict):
        if not isinstance(value, dict):
            raise Error("binding")
        result = {}
        for key, child in template.items():
            if key not in value and child not in ({}, []):
                raise Error("binding")
            result[key] = project(value.get(key, child), child)
        return result
    if isinstance(template, list):
        if not isinstance(value, list) or len(value) != len(template):
            raise Error("binding")
        return [project(child, expected) for child, expected in zip(value, template, strict=True)]
    return value


def key_encryption_secret(name, namespace):
    value = base64.b64encode(secrets.token_bytes(32))
    return {
        "apiVersion": "v1",
        "kind": "Secret",
        "metadata": {"name": name, "namespace": namespace},
        "type": "Opaque",
        "data": {"key-encryption-key": base64.b64encode(value).decode()},
    }


class Platform:
    def __init__(self, request):
        self.request = request
        self.spec = request["spec"]
        self.kind = self.spec["kind"]
        self.name = self.spec["name"]
        self.settings = self.spec["settings"]
        self.config = self.settings["kubernetes"]
        if self.config.get("distribution", "kubernetes") not in ("kubernetes", "openshift"):
            raise Error("configuration")
        self.namespace_name = self.config["namespace"]
        self.context = self.config["context"]
        self.state = Path(request["stateDirectory"])
        if (
            self.spec["layout"] != 1
            or self.kind not in (STORAGE, GATEWAY)
            or not re.fullmatch(r"nc-[a-f0-9]{16}-[a-z][a-z0-9-]{0,25}", self.name)
        ):
            raise Error("configuration")
        if not re.fullmatch(r"[a-f0-9-]{36}", self.spec["owner"]) or not re.fullmatch(
            r"[a-f0-9]{32}", self.spec["generation"]
        ):
            raise Error("configuration")
        if not re.fullmatch(
            r"[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?", self.namespace_name
        ) or self.namespace_name in (
            "default",
            "kube-system",
            "kube-public",
            "kube-node-lease",
            "agent-sandbox-system",
        ):
            raise Error("configuration")
        if not self.context or any(character in self.context for character in "\x00\n\r"):
            raise Error("configuration")
        if self.config["authentication"] != {"profile": "development"} or self.config[
            "prerequisites"
        ]["agentSandbox"]["management"] not in ("managed", "existing"):
            raise Error("configuration")
        if (
            not re.fullmatch(r"https://127\.0\.0\.1:([0-9]{1,5})", self.settings["endpoint"])
            or not 1 <= int(self.settings["endpoint"].rsplit(":", 1)[1]) <= 65535
        ):
            raise Error("configuration")
        self.private_directory(self.state)
        self.kubeconfig = Path(os.environ.get(self.config["kubeconfig"]["env"], ""))
        if not self.kubeconfig.is_absolute() or not self.kubeconfig.is_file():
            raise Error("configuration")
        self.receipt_path = self.state / "platform.json"
        self.receipt = None
        if self.receipt_path.exists() or self.receipt_path.is_symlink():
            self.private_file(self.receipt_path)
            self.receipt = json.loads(self.receipt_path.read_text())
            if (
                self.receipt.get("owner") != self.spec["owner"]
                or self.receipt.get("name") != self.name
                or self.receipt.get("settings") != digest(self.settings)
            ):
                raise Error("binding")
            if self.receipt.get("artifactPins") != digest(self.pins):
                raise Error("binding")
            if self.receipt.get("generations", {}).get(
                self.kind, self.spec["generation"]
            ) != self.spec["generation"] and not (
                self.kind == GATEWAY
                and self.receipt.get("gatewayPhase") == "removed"
                and not request.get("priorId")
            ):
                raise Error("binding")
        elif request.get("priorId"):
            raise Error("binding")
        self.auth = DevelopmentAuth(self)

    @staticmethod
    def private_directory(path):
        if (
            not path.is_absolute()
            or path.is_symlink()
            or not path.is_dir()
            or path.stat().st_uid != os.getuid()
            or path.stat().st_mode & 0o077
        ):
            raise Error("configuration")

    @staticmethod
    def private_file(path):
        if (
            path.is_symlink()
            or not path.is_file()
            or path.stat().st_uid != os.getuid()
            or path.stat().st_mode & 0o077
        ):
            raise Error("binding")

    @staticmethod
    def write(path, data):
        if path.is_symlink():
            raise Error("binding")
        if path.exists():
            Platform.private_file(path)
        descriptor, temporary = tempfile.mkstemp(prefix=".write-", dir=path.parent)
        try:
            with os.fdopen(descriptor, "wb") as output:
                output.write(data)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def save(self):
        self.write(self.receipt_path, json.dumps(self.receipt, sort_keys=True).encode())

    @property
    def pins(self):
        pins = json.loads(Path(__file__).with_name("pins.json").read_text())
        if (
            pins["sources"]["openshell"]["directory"]
            != "OpenShell-" + pins["versions"]["openshellRevision"]
        ):
            raise Error("configuration")
        return pins

    def command(self, arguments, data=None, timeout=600):
        try:
            result = subprocess.run(
                arguments, input=data, text=True, capture_output=True, timeout=timeout
            )
        except (OSError, subprocess.TimeoutExpired):
            raise Error("command") from None
        if result.returncode:
            raise Error("command")
        return result.stdout

    def kubectl(self, *arguments, data=None, timeout=600):
        return self.command(
            [
                "kubectl",
                "--kubeconfig",
                str(self.kubeconfig),
                "--context",
                self.context,
                *arguments,
            ],
            data=data,
            timeout=timeout,
        )

    def helm(self, *arguments, data=None):
        return self.command(
            [
                "helm",
                *arguments,
                "--kubeconfig",
                str(self.kubeconfig),
                "--kube-context",
                self.context,
                "--namespace",
                self.namespace_name,
            ],
            data=data,
            timeout=660,
        )

    def get(self, kind, name, namespace=""):
        arguments = ["-n", namespace] if namespace else []
        output = self.kubectl(*arguments, "get", kind, name, "--ignore-not-found", "-o", "json")
        return json.loads(output) if output.strip() else None

    def get_object(self, obj):
        return self.get(obj["kind"], obj["metadata"]["name"], obj["metadata"].get("namespace", ""))

    def cluster_binding(self):
        config = json.loads(self.kubectl("config", "view", "--raw", "--minify", "-o", "json"))
        cluster = config["clusters"][0]["cluster"]
        if (
            cluster.get("insecure-skip-tls-verify")
            or not cluster["server"].startswith("https://")
            or config["current-context"] != self.context
        ):
            raise Error("binding")
        if cluster.get("certificate-authority-data"):
            ca = base64.b64decode(cluster["certificate-authority-data"], validate=True)
        elif cluster.get("certificate-authority"):
            path = Path(cluster["certificate-authority"])
            ca = (path if path.is_absolute() else self.kubeconfig.parent / path).read_bytes()
        else:
            raise Error("binding")
        if not ca:
            raise Error("binding")
        system = self.get("Namespace", "kube-system")
        if not system:
            raise Error("binding")
        return {
            "context": self.context,
            "server": cluster["server"],
            "ca": hashlib.sha256(ca).hexdigest(),
            "tlsServerName": cluster.get("tls-server-name", ""),
            "systemUid": system["metadata"]["uid"],
        }

    def check_cluster(self):
        binding = self.cluster_binding()
        if self.receipt and binding != self.receipt["binding"]:
            raise Error("binding")
        if self.is_openshift:
            groups = json.loads(self.kubectl("get", "--raw", "/apis")).get("groups", [])
            versions = {
                version.get("groupVersion")
                for group in groups
                for version in group.get("versions", [])
            }
            if not {"security.openshift.io/v1", "project.openshift.io/v1"} <= versions:
                raise Error("prerequisite")
            if (self.receipt or {}).get("namespaceUid"):
                # Revalidate the bound allocation before each dependent write,
                # including after long-running prerequisite and network checks.
                self.namespace()
        return binding

    @property
    def is_openshift(self):
        return self.config.get("distribution", "kubernetes") == "openshift"

    @staticmethod
    def allocation_start(value):
        # Use the namespace's allocation, never a privileged SCC or fixed-UID fallback.
        # Keep the accepted form bounded to the standard start/count annotation.
        if not isinstance(value, str) or not re.fullmatch(
            r"[1-9][0-9]{0,9}/[1-9][0-9]{0,9}", value
        ):
            raise Error("prerequisite")
        start, count = map(int, value.split("/"))
        if start + count > 2**32 - 1:
            raise Error("prerequisite")
        return start

    def namespace_identity(self, namespace, ensure=False):
        if not self.is_openshift:
            return
        annotations = namespace["metadata"].get("annotations", {})
        uid_range = annotations.get("openshift.io/sa.scc.uid-range")
        group_range = annotations.get("openshift.io/sa.scc.supplemental-groups", uid_range)
        observed = {
            "uidRange": uid_range,
            "groupRange": group_range,
            "uid": self.allocation_start(uid_range),
            "gid": self.allocation_start(group_range),
        }
        retained = self.receipt.get("openshiftIdentity")
        if retained is not None and retained != observed:
            raise Error("binding")
        if retained is None and self.receipt.get("storageReady"):
            raise Error("binding")
        if ensure and retained is None:
            self.receipt["openshiftIdentity"] = observed
            self.save()

    def pod_security_context(self):
        uid = gid = 10001
        if self.is_openshift:
            observed = (self.receipt or {}).get("openshiftIdentity")
            if not observed:
                raise Error("prerequisite")
            uid, gid = observed["uid"], observed["gid"]
        return {
            "runAsNonRoot": True,
            "runAsUser": uid,
            "runAsGroup": gid,
            "fsGroup": gid,
            "seccompProfile": {"type": "RuntimeDefault"},
        }

    def labels(self):
        return {OWNER: self.spec["owner"], GENERATION: self.receipt["generations"][STORAGE]}

    def namespace(self, ensure=False):
        current = self.get("Namespace", self.namespace_name)
        if not self.receipt:
            if current:
                raise Error("binding")
            return None
        expected_uid = self.receipt.get("namespaceUid")
        if expected_uid:
            if (
                not current
                or current["metadata"].get("uid") != expected_uid
                or any(
                    current["metadata"].get("labels", {}).get(key) != value
                    for key, value in self.labels().items()
                )
            ):
                raise Error("binding")
            self.namespace_identity(current, ensure)
            return current
        if current:
            if not self.receipt.get("namespacePending") or any(
                current["metadata"].get("labels", {}).get(key) != value
                for key, value in self.labels().items()
            ):
                raise Error("binding")
        elif ensure:
            self.receipt["namespacePending"] = True
            self.save()
            self.create(
                {
                    "apiVersion": "v1",
                    "kind": "Namespace",
                    "metadata": {"name": self.namespace_name, "labels": self.labels()},
                }
            )
            current = self.get("Namespace", self.namespace_name)
            if not current or any(
                current["metadata"].get("labels", {}).get(key) != value
                for key, value in self.labels().items()
            ):
                raise Error("incomplete")
        else:
            return None
        if self.is_openshift and ensure:
            deadline = time.monotonic() + 60
            namespace_uid = current["metadata"]["uid"]
            while (
                not current["metadata"].get("annotations", {}).get("openshift.io/sa.scc.uid-range")
            ):
                if time.monotonic() > deadline:
                    raise Error("incomplete")
                time.sleep(0.5)
                current = self.get("Namespace", self.namespace_name)
                if (
                    not current
                    or current["metadata"].get("uid") != namespace_uid
                    or any(
                        current["metadata"].get("labels", {}).get(key) != value
                        for key, value in self.labels().items()
                    )
                ):
                    raise Error("binding")
        self.namespace_identity(current, ensure)
        if not ensure:
            return current
        self.receipt["namespaceUid"] = current["metadata"]["uid"]
        self.receipt["storageId"] = "ks-" + digest(
            [
                self.spec["owner"],
                self.receipt["generations"][STORAGE],
                self.receipt["namespaceUid"],
                self.receipt["binding"],
            ]
        )
        self.save()
        return current

    def create(self, obj):
        self.check_cluster()
        self.kubectl("create", "-f", "-", data=json.dumps(obj))

    def binding(self, current, desired=None):
        result = {"object": identity(current), "uid": current["metadata"]["uid"]}
        if desired is not None:
            result.update({"shape": shape(desired), "digest": digest(desired)})
        return result

    def verify_object(self, bound):
        current = self.get_object(bound["object"])
        if not current or current["metadata"].get("uid") != bound["uid"]:
            raise Error("binding")
        if "shape" in bound and digest(project(current, bound["shape"])) != bound["digest"]:
            raise Error("binding")
        return current

    def verify_objects(self, skip_chart=False):
        chart = (
            {object_key(obj) for obj in self.receipt.get("chartObjects", [])}
            if skip_chart
            else set()
        )
        probes = {object_key(obj) for obj in self.receipt.get("probeObjects", [])}
        for key, bound in self.receipt.get("objects", {}).items():
            if key in chart or key in probes:
                continue
            if "uid" in bound:
                self.verify_object(bound)

    def ensure_object(self, obj):
        obj = copy.deepcopy(obj)
        obj["metadata"].setdefault("labels", {}).update(self.labels())
        key = object_key(obj)
        objects = self.receipt.setdefault("objects", {})
        expected = objects.get(key)
        if expected and "uid" in expected:
            return self.verify_object(expected)
        if expected and expected.get("pending") != digest(obj):
            raise Error("binding")
        current = self.get_object(obj)
        if current:
            if (
                not expected
                or expected.get("pending") != digest(obj)
                or digest(project(current, shape(obj))) != digest(obj)
            ):
                raise Error("binding")
        else:
            objects[key] = {"object": identity(obj), "pending": digest(obj), "shape": shape(obj)}
            self.save()
            self.create(obj)
            current = self.get_object(obj)
            if not current or digest(project(current, shape(obj))) != digest(obj):
                raise Error("incomplete")
        objects[key] = self.binding(current, obj)
        self.save()
        return current

    def storage_preflight(self):
        classes = json.loads(self.kubectl("get", "storageclasses", "-o", "json"))["items"]
        defaults = [
            item
            for item in classes
            if any(
                item["metadata"].get("annotations", {}).get(key) == "true"
                for key in (
                    "storageclass.kubernetes.io/is-default-class",
                    "storageclass.beta.kubernetes.io/is-default-class",
                )
            )
        ]
        if len(defaults) != 1:
            raise Error("prerequisite")

    def ensure_key(self):
        descriptor = {
            "kind": "Secret",
            "metadata": {"name": self.name + "-kek", "namespace": self.namespace_name},
        }
        bound = self.receipt["objects"].get(object_key(descriptor))
        if bound and "uid" in bound:
            self.verify_object(bound)
            return
        private = self.state / "credential-key"
        if not private.exists():
            if self.receipt.get("kekStarted") or bound:
                raise Error("auth")
            self.receipt["kekStarted"] = True
            self.save()
            self.write(private, base64.b64encode(secrets.token_bytes(32)))
        self.private_file(private)
        value = private.read_bytes()
        if len(base64.b64decode(value, validate=True)) != 32:
            raise Error("auth")
        fingerprint = hashlib.sha256(value).hexdigest()
        if self.receipt.get("kekFingerprint", fingerprint) != fingerprint:
            raise Error("binding")
        self.receipt["kekFingerprint"] = fingerprint
        self.save()
        self.ensure_object(
            {
                "apiVersion": "v1",
                **descriptor,
                "type": "Opaque",
                "data": {"key-encryption-key": base64.b64encode(value).decode()},
            }
        )

    def delete_probe_object(self, obj):
        key = object_key(obj)
        bound = self.receipt.get("objects", {}).get(key)
        current = self.get_object(obj)
        if current:
            if not bound:
                raise Error("binding")
            if "uid" in bound:
                if current["metadata"]["uid"] != bound["uid"]:
                    raise Error("binding")
            elif digest(project(current, bound["shape"])) != bound.get("pending"):
                raise Error("binding")
            prefix, plural = {
                "Pod": ("/api/v1", "pods"),
                "NetworkPolicy": ("/apis/networking.k8s.io/v1", "networkpolicies"),
            }[obj["kind"]]
            path = f"{prefix}/namespaces/{self.namespace_name}/{plural}/{obj['metadata']['name']}"
            self.check_cluster()
            self.kubectl(
                "delete",
                "--raw",
                path,
                "-f",
                "-",
                data=json.dumps(
                    {
                        "apiVersion": "v1",
                        "kind": "DeleteOptions",
                        "preconditions": {"uid": current["metadata"]["uid"]},
                    }
                ),
            )
            deadline = time.monotonic() + 60
            while self.get_object(obj):
                if time.monotonic() > deadline:
                    raise Error("incomplete")
                time.sleep(0.2)
        self.receipt["objects"].pop(key, None)
        self.save()

    def cleanup_probe(self):
        for obj in reversed(self.receipt.get("probeObjects", [])):
            self.delete_probe_object(obj)
        self.receipt["probeObjects"] = []
        self.save()

    def probe_request(self, address):
        address = str(ipaddress.ip_address(address))
        if ":" in address:
            address = "[" + address + "]"
        arguments = [
            "kubectl",
            "--kubeconfig",
            str(self.kubeconfig),
            "--context",
            self.context,
            "-n",
            self.namespace_name,
            "exec",
            self.name + "-probe-client",
            "--",
            "wget",
            "-q",
            "-T",
            "2",
            "-O",
            "-",
            "http://" + address + ":8080",
        ]
        result = subprocess.run(arguments, capture_output=True, text=True, timeout=15)
        if result.returncode == 0 and result.stdout.strip() == "nemoclaw-network-proof":
            return True
        if result.returncode and any(
            message in result.stderr
            for message in ("wget: download timed out", "wget: can't connect to remote host")
        ):
            return False
        raise Error("command")

    def policy_probe(self):
        if self.receipt.get("networkVerified"):
            return
        self.cleanup_probe()
        labels = {"nemoclaw.nvidia.com/network-probe": self.name}
        image = self.pins["sources"]["policyProbeImage"]
        objects = []
        for role in ("server", "client"):
            pod_labels = {**labels, "nemoclaw.nvidia.com/probe-role": role}
            command = (
                [
                    "sh",
                    "-c",
                    "mkdir -p /tmp/www; printf nemoclaw-network-proof > /tmp/www/index.html; exec httpd -f -p 8080 -h /tmp/www",
                ]
                if role == "server"
                else ["sleep", "600"]
            )
            container = {
                "name": "probe",
                "image": image,
                "command": command,
                "resources": {
                    "requests": {"cpu": "10m", "memory": "8Mi"},
                    "limits": {"cpu": "100m", "memory": "32Mi"},
                },
                "securityContext": {
                    "allowPrivilegeEscalation": False,
                    "capabilities": {"drop": ["ALL"]},
                },
            }
            if role == "server":
                container["readinessProbe"] = {
                    "httpGet": {"path": "/", "port": 8080},
                    "periodSeconds": 1,
                }
            objects.append(
                {
                    "apiVersion": "v1",
                    "kind": "Pod",
                    "metadata": {
                        "name": self.name + "-probe-" + role,
                        "namespace": self.namespace_name,
                        "labels": pod_labels,
                    },
                    "spec": {
                        "automountServiceAccountToken": False,
                        "restartPolicy": "Never",
                        "terminationGracePeriodSeconds": 1,
                        "securityContext": self.pod_security_context(),
                        "containers": [container],
                    },
                }
            )
        self.receipt["probeObjects"] = [identity(obj) for obj in objects]
        self.save()
        try:
            for obj in objects:
                self.ensure_object(obj)
            self.kubectl(
                "-n",
                self.namespace_name,
                "wait",
                "--for=condition=Ready",
                "pod",
                "-l",
                "nemoclaw.nvidia.com/network-probe=" + self.name,
                "--timeout=120s",
            )
            address = self.get_object(objects[0])["status"]["podIP"]
            if not self.probe_request(address):
                raise Error("prerequisite")
            for direction, role in (("Ingress", "server"), ("Egress", "client")):
                policy = {
                    "apiVersion": "networking.k8s.io/v1",
                    "kind": "NetworkPolicy",
                    "metadata": {
                        "name": self.name + "-probe-deny",
                        "namespace": self.namespace_name,
                    },
                    "spec": {
                        "podSelector": {
                            "matchLabels": {**labels, "nemoclaw.nvidia.com/probe-role": role}
                        },
                        "policyTypes": [direction],
                        direction.lower(): [],
                    },
                }
                self.receipt["probeObjects"].append(identity(policy))
                self.save()
                self.ensure_object(policy)
                deadline = time.monotonic() + 30
                while self.probe_request(address):
                    if time.monotonic() > deadline:
                        raise Error("prerequisite")
                    time.sleep(0.5)
                self.delete_probe_object(policy)
                deadline = time.monotonic() + 30
                while not self.probe_request(address):
                    if time.monotonic() > deadline:
                        raise Error("prerequisite")
                    time.sleep(0.5)
                self.receipt["probeObjects"].pop()
                self.save()
        finally:
            self.cleanup_probe()
        self.receipt["networkVerified"] = True
        self.save()

    def artifact(self, name):
        pin = self.pins["sources"][name]
        cache = self.state / "sources"
        if cache.is_symlink():
            raise Error("binding")
        cache.mkdir(mode=0o700, exist_ok=True)
        self.private_directory(cache)
        path = cache / (name + (".tar.gz" if name == "openshell" else ".yaml"))
        if path.exists():
            self.private_file(path)
            data = path.read_bytes()
        else:
            with urllib.request.urlopen(pin["url"], timeout=60) as response:
                data = response.read(40 << 20)
            verify_bytes(data, pin["sha256"])
            self.write(path, data)
        verify_bytes(data, pin["sha256"])
        return data

    def manifest(self, data):
        # kubectl's local YAML decoder supports the pinned large CRD schema;
        # no Python YAML package or Kubernetes discovery is needed here.
        output = self.kubectl(
            "label",
            "--local",
            "-f",
            "-",
            OWNER + "=" + self.spec["owner"],
            GENERATION + "=" + self.receipt["generations"][STORAGE],
            "--output=json",
            data=data.decode(),
        )
        return json_objects(output)

    def prerequisite_objects(self):
        data = self.artifact("agentSandbox")
        images = self.pins["sources"]["dependencyImages"]

        def replace(match):
            original = match.group(2)
            if original not in images:
                raise Error("prerequisite")
            return match.group(1) + original + "@" + images[original]

        data = re.sub(r"(?m)^(\s*image: )([^\s]+)$", replace, data.decode()).encode()
        objects = self.manifest(data)
        observed = {
            (obj["kind"], obj["metadata"]["name"], obj["metadata"].get("namespace", ""))
            for obj in objects
        }
        if observed != set(PREREQUISITES):
            raise Error("prerequisite")
        return objects

    def prerequisites(self, ensure=False):
        current = [self.get(*item) for item in PREREQUISITES]
        present = [item for item in current if item is not None]
        receipt = (self.receipt or {}).get("prerequisites")
        if receipt:
            for bound in receipt.get("objects", []):
                self.verify_object(bound)
            if receipt.get("mode") == "owned" and ensure:
                for obj in self.prerequisite_objects():
                    self.ensure_object(obj)
                current = [self.get(*item) for item in PREREQUISITES]
                present = [item for item in current if item is not None]
        elif present:
            if len(present) != len(PREREQUISITES):
                raise Error("prerequisite")
        else:
            if self.config["prerequisites"]["agentSandbox"]["management"] != "managed":
                raise Error("prerequisite")
            if not ensure:
                return
            self.receipt["prerequisites"] = {"mode": "owned", "objects": []}
            self.save()
            for obj in self.prerequisite_objects():
                self.ensure_object(obj)
            current = [self.get(*item) for item in PREREQUISITES]
            present = [item for item in current if item is not None]
        if len(present) != len(PREREQUISITES):
            if ensure:
                raise Error("incomplete")
            return
        deployment = next(obj for obj in present if obj["kind"] == "Deployment")
        wanted = (
            "registry.k8s.io/agent-sandbox/agent-sandbox-controller:v0.5.0@"
            + self.pins["sources"]["dependencyImages"][
                "registry.k8s.io/agent-sandbox/agent-sandbox-controller:v0.5.0"
            ]
        )
        if [
            container["image"] for container in deployment["spec"]["template"]["spec"]["containers"]
        ] != [wanted]:
            raise Error("prerequisite")
        crd = next(obj for obj in present if obj["kind"] == "CustomResourceDefinition")
        if not any(
            version["name"] in ("v1alpha1", "v1beta1") and version["served"]
            for version in crd["spec"]["versions"]
        ):
            raise Error("prerequisite")
        if ensure:
            if (receipt or {}).get("mode") != "owned" and self.receipt.get("prerequisites", {}).get(
                "mode"
            ) != "owned":
                # Verify the pinned prerequisite's declarative content without
                # taking ownership of existing objects or their metadata.
                for expected in self.prerequisite_objects():
                    observed = self.get_object(expected)
                    content = {
                        key: value
                        for key, value in expected.items()
                        if key not in ("apiVersion", "kind", "metadata")
                    }
                    if digest(project(observed, shape(content))) != digest(content):
                        raise Error("prerequisite")
            self.kubectl(
                "wait",
                "--for=condition=Established",
                "crd/sandboxes.agents.x-k8s.io",
                "--timeout=120s",
            )
            self.kubectl(
                "-n",
                "agent-sandbox-system",
                "rollout",
                "status",
                "deployment/agent-sandbox-controller",
                "--timeout=300s",
            )
            self.receipt["prerequisites"] = {
                "mode": (receipt or self.receipt.get("prerequisites", {})).get("mode", "existing"),
                "objects": [self.binding(obj) for obj in present],
            }
            self.save()
        elif deployment.get("status", {}).get("availableReplicas", 0) < 1:
            raise Error("prerequisite")

    def values(self):
        def image(name, supervisor=False):
            repository, sha = self.pins["versions"]["images"][name].split("@", 1)
            if not re.fullmatch(r"sha256:[a-f0-9]{64}", sha):
                raise Error("configuration")
            return {
                "repository": repository,
                "digest": sha,
                "pullPolicy": "if_not_present" if supervisor else "IfNotPresent",
            }

        values = {
            "fullnameOverride": self.name,
            "global": {"image": {"registry": ""}},
            "gateway": {"image": image("gateway")},
            "sandboxRuntime": {"image": image("sandboxRuntime")},
            "supervisor": {"image": image("supervisor", True)},
            "sandbox": {"image": image("sandboxRuntime", True)},
            "server": {
                "telemetryEnabled": False,
                "disableTls": False,
                "auth": {"allowUnauthenticatedUsers": False},
                "oidc": self.auth.values(),
                "tls": {
                    "enableMtls": True,
                    "certSecretName": self.name + "-server-tls",
                    "clientTlsSecretName": self.name + "-client-tls",
                },
                "sandboxJwt": {"signingSecretName": self.name + "-jwt-keys"},
                "credentialStorage": {"existingSecret": self.name + "-kek"},
                "workspaceDefaultStorageSize": "2Gi",
                "drivers": {"kubernetes": {"workspaceMode": "shared"}},
            },
            "pkiInitJob": {"enabled": True},
            "resources": {
                "requests": {"cpu": "250m", "memory": "256Mi"},
                "limits": {"cpu": "1", "memory": "1Gi"},
            },
        }
        if self.is_openshift:
            context = self.pod_security_context()
            values["podSecurityContext"] = {
                "fsGroup": context["fsGroup"],
                "seccompProfile": context["seccompProfile"],
            }
            values["securityContext"] = {
                "runAsNonRoot": True,
                "runAsUser": context["runAsUser"],
                "runAsGroup": context["runAsGroup"],
                "allowPrivilegeEscalation": False,
                "capabilities": {"drop": ["ALL"]},
            }
        return values

    def chart(self):
        data = self.artifact("openshell")
        cache = self.state / "sources"
        source = cache / self.pins["sources"]["openshell"]["directory"]
        with tempfile.TemporaryDirectory(prefix=".extract-", dir=cache) as temporary:
            with tarfile.open(fileobj=io.BytesIO(data)) as archive:
                archive.extractall(temporary, filter="data")
            extracted = Path(temporary) / source.name
            if not extracted.is_dir() or extracted.is_symlink():
                raise Error("configuration")
            if source.is_symlink():
                source.unlink()
            elif source.exists():
                shutil.rmtree(source)
            extracted.replace(source)
        return source / "deploy/helm/openshell"

    def retained_gateway_objects(self):
        return [
            {
                "kind": "Secret",
                "metadata": {"name": self.name + suffix, "namespace": self.namespace_name},
            }
            for suffix in ("-server-tls", "-client-tls", "-jwt-keys")
        ] + [
            {
                "kind": "PersistentVolumeClaim",
                "metadata": {
                    "name": "openshell-data-" + self.name + "-0",
                    "namespace": self.namespace_name,
                },
            }
        ]

    def releases(self):
        output = self.kubectl(
            "-n",
            self.namespace_name,
            "get",
            "secrets",
            "-l",
            "owner=helm,name=" + self.name,
            "-o",
            "json",
        )
        return sorted(
            [self.release_binding(obj) for obj in json.loads(output)["items"]],
            key=lambda item: item["name"],
        )

    def release_binding(self, obj):
        try:
            if obj["type"] != "helm.sh/release.v1":
                raise Error("binding")
            encoded = base64.b64decode(obj["data"]["release"], validate=True)
            compressed = base64.b64decode(encoded, validate=True)
            with gzip.GzipFile(fileobj=io.BytesIO(compressed)) as source:
                data = source.read((16 << 20) + 1)
            if len(data) > 16 << 20:
                raise Error("binding")
            release = json.loads(data)
            if (
                release["name"] != self.name
                or release["namespace"] != self.namespace_name
                or type(release["version"]) is not int
                or release["version"] < 1
                or not isinstance(release["manifest"], str)
                or not isinstance(release["chart"], dict)
                or not isinstance(release.get("hooks", []), list)
            ):
                raise Error("binding")
            # Helm updates status and hook execution timestamps in place during
            # upgrade/uninstall. Bind every other field, including the manifest
            # and hooks that Helm can execute or delete under our credentials.
            release.pop("info", None)
            for hook in release.get("hooks", []):
                if not isinstance(hook, dict):
                    raise Error("binding")
                hook.pop("last_run", None)
            return {
                "name": obj["metadata"]["name"],
                "uid": obj["metadata"]["uid"],
                "digest": digest(release),
            }
        except (KeyError, TypeError, ValueError, OSError, EOFError):
            raise Error("binding") from None

    def check_releases(self):
        current = self.releases()
        saved = self.receipt.get("releaseSecrets", [])
        for previous in saved:
            if previous not in current:
                raise Error("binding")
        if current and not self.receipt.get("installStarted"):
            raise Error("binding")
        if self.receipt.get("gatewayPhase") == "ready" and current != saved:
            raise Error("binding")
        return current

    def gateway_id(self):
        return "kg-" + digest([self.receipt["storageId"], self.receipt["generations"][GATEWAY]])

    def chart_objects(self, documents):
        result = []
        for obj in documents:
            if obj.get("metadata", {}).get("annotations", {}).get("helm.sh/hook"):
                continue
            obj = identity(obj)
            if obj["kind"] not in ("ClusterRole", "ClusterRoleBinding"):
                obj["metadata"].setdefault("namespace", self.namespace_name)
            result.append(obj)
        return result

    def chart_desired(self, documents):
        result = {}
        for obj in documents:
            if obj.get("metadata", {}).get("annotations", {}).get("helm.sh/hook"):
                continue
            obj = copy.deepcopy(obj)
            if obj["kind"] not in ("ClusterRole", "ClusterRoleBinding"):
                obj["metadata"].setdefault("namespace", self.namespace_name)
            for key in (OWNER, GENERATION):
                obj["metadata"].get("labels", {}).pop(key, None)
            result[object_key(obj)] = obj
        return result

    def hook_objects(self, documents):
        result = []
        for obj in documents:
            if not obj.get("metadata", {}).get("annotations", {}).get("helm.sh/hook"):
                continue
            obj = copy.deepcopy(obj)
            obj["metadata"].setdefault("namespace", self.namespace_name)
            for key in (OWNER, GENERATION):
                obj["metadata"].get("labels", {}).pop(key, None)
            result.append(obj)
        return result

    def check_hooks(self, checkpoint=False):
        for bound in self.receipt.get("hooks", []):
            current = self.get_object(bound["object"])
            if current:
                if digest(project(current, bound["shape"])) != bound["digest"]:
                    raise Error("binding")
                if not self.receipt.get("hookPending") and current["metadata"]["uid"] != bound.get(
                    "uid"
                ):
                    raise Error("binding")
            elif bound.get("uid") and not self.receipt.get("hookPending"):
                raise Error("binding")
            if checkpoint:
                bound["uid"] = current["metadata"]["uid"] if current else None
        if checkpoint:
            self.save()

    def checkpoint_gateway(self, expected):
        objects = self.receipt.setdefault("objects", {})
        for descriptor in expected + self.retained_gateway_objects():
            current = self.get_object(descriptor)
            key = object_key(descriptor)
            if key in objects and "uid" in objects[key]:
                self.verify_object(objects[key])
            elif current:
                # This dedicated namespace and explicit pending release were
                # checked for collisions before allowing Helm bootstrap.
                if descriptor in expected:
                    annotations = current["metadata"].get("annotations", {})
                    if (
                        annotations.get("meta.helm.sh/release-name") != self.name
                        or annotations.get("meta.helm.sh/release-namespace") != self.namespace_name
                    ):
                        raise Error("binding")
                    desired = self.receipt["chartDesired"][key]
                    if digest(project(current, shape(desired))) != digest(desired):
                        raise Error("binding")
                    objects[key] = self.binding(current, desired)
                else:
                    objects[key] = self.binding(current)
                if descriptor["kind"] == "Secret":
                    critical = {
                        "data": current.get("data", {}),
                        "type": current.get("type", "Opaque"),
                    }
                    objects[key].update({"shape": shape(critical), "digest": digest(critical)})
        self.receipt["releaseSecrets"] = self.check_releases()
        self.check_hooks(checkpoint=True)
        statefulset = self.get("StatefulSet", self.name, self.namespace_name)
        if statefulset:
            key = object_key(statefulset)
            if key not in objects or objects[key]["uid"] != statefulset["metadata"]["uid"]:
                raise Error("binding")
            self.receipt["gatewayId"] = self.gateway_id()
        self.save()

    def prior(self, result):
        previous = self.request.get("priorId")
        removed = (
            self.kind == GATEWAY
            and (self.receipt or {}).get("gatewayPhase") == "removed"
            and result.get("id") is None
        )
        if previous is not None and result.get("id") != previous and not removed:
            raise Error("binding")
        return result

    def read(self):
        self.check_cluster()
        self.namespace()
        self.prerequisites()
        if not self.receipt:
            return self.prior({"id": None, **({"running": False} if self.kind == GATEWAY else {})})
        removing = self.receipt.get("gatewayPhase") == "removing"
        self.verify_objects(skip_chart=removing)
        self.check_hooks()
        if self.receipt.get("storageReady") or self.receipt.get("authFingerprint"):
            self.auth.material(create=False)
        if self.kind == STORAGE:
            result = {
                "id": self.receipt.get("storageId"),
                "running": bool(self.receipt.get("storageReady")),
            }
        elif self.receipt.get("gatewayPhase") == "removing":
            self.check_removing()
            result = {"id": self.receipt.get("gatewayId"), "running": False}
        elif self.receipt.get("gatewayPhase") == "removed":
            if self.get("StatefulSet", self.name, self.namespace_name) or self.releases():
                raise Error("binding")
            result = {"id": None, "running": False}
        else:
            self.check_releases()
            statefulset = self.get("StatefulSet", self.name, self.namespace_name)
            running = bool(
                statefulset
                and self.receipt.get("gatewayPhase") == "ready"
                and statefulset.get("status", {}).get("readyReplicas", 0) == 1
                and statefulset.get("status", {}).get("observedGeneration", 0)
                >= statefulset["metadata"].get("generation", 0)
            )
            result = {"id": self.receipt.get("gatewayId"), "running": running}
        return self.prior(result)

    def ensure(self):
        binding = self.check_cluster()
        self.namespace()
        self.prerequisites()
        self.storage_preflight()
        if not self.receipt:
            if self.kind != STORAGE:
                raise Error("incomplete")
            self.receipt = {
                "layout": 1,
                "owner": self.spec["owner"],
                "name": self.name,
                "settings": digest(self.settings),
                "artifactPins": digest(self.pins),
                "binding": binding,
                "generations": {STORAGE: self.spec["generation"]},
                "objects": {},
            }
            self.save()
        if self.kind == STORAGE:
            self.namespace(ensure=True)
            self.verify_objects()
            self.policy_probe()
            self.prerequisites(ensure=True)
            self.auth.install()
            self.ensure_key()
            self.receipt["storageReady"] = True
            self.save()
            return self.prior({"id": self.receipt["storageId"], "running": True})
        if not self.receipt.get("storageReady"):
            raise Error("incomplete")
        if self.receipt.get("gatewayPhase") == "removing":
            raise Error("incomplete")
        self.auth.material(create=False)
        self.verify_objects()
        if self.receipt.get("gatewayPhase") == "ready":
            result = self.read()
            if not result.get("running"):
                raise Error("incomplete")
            return result
        self.receipt["generations"][GATEWAY] = self.spec["generation"]
        self.save()
        chart = self.chart()
        values = self.state / "chart-values.json"
        self.write(values, json.dumps(self.values()).encode())
        rendered = self.helm(
            "template",
            self.name,
            str(chart),
            "-f",
            str(values),
            "--set",
            "agentSandbox.preflight.enabled=false",
        )
        documents = self.manifest(rendered.encode())
        expected = self.chart_objects(documents)
        hooks = self.hook_objects(documents)
        chart_desired = self.chart_desired(documents)
        if self.receipt.get("chartDesired", chart_desired) != chart_desired:
            raise Error("binding")
        self.receipt["chartDesired"] = chart_desired
        if self.receipt.get("gatewayPhase") == "removed":
            self.receipt["installStarted"] = False
        if not self.receipt.get("installStarted"):
            if self.releases():
                raise Error("binding")
            for descriptor in expected + self.retained_gateway_objects():
                current = self.get_object(descriptor)
                bound = self.receipt["objects"].get(object_key(descriptor))
                if current and not bound:
                    raise Error("binding")
                if bound:
                    self.verify_object(bound)
            if not self.receipt.get("hooks"):
                for hook in hooks:
                    if self.get_object(hook):
                        raise Error("binding")
                self.receipt["hooks"] = [
                    {
                        "object": identity(obj),
                        "shape": shape(obj),
                        "digest": digest(obj),
                        "uid": None,
                    }
                    for obj in hooks
                ]
            else:
                self.check_hooks()
            self.receipt["installStarted"] = True
            self.receipt["gatewayPhase"] = "installing"
            self.receipt["chartObjects"] = expected
            self.receipt["gatewayId"] = self.gateway_id()
            self.save()
        elif self.receipt.get("chartObjects") != expected:
            raise Error("binding")
        self.check_releases()
        self.check_hooks()
        self.receipt["hookPending"] = True
        self.save()
        self.check_cluster()
        try:
            self.helm(
                "upgrade",
                "--install",
                self.name,
                str(chart),
                "-f",
                str(values),
                "--wait",
                "--timeout",
                "10m",
            )
        finally:
            self.checkpoint_gateway(expected)
        self.receipt["gatewayPhase"] = "ready"
        self.receipt["hookPending"] = False
        self.save()
        return self.read()

    def check_removing(self):
        for obj in self.receipt.get("chartObjects", []):
            observed = self.get_object(obj)
            bound = self.receipt["objects"].get(object_key(obj))
            if observed and (not bound or observed["metadata"]["uid"] != bound["uid"]):
                raise Error("binding")
            if observed and "shape" in bound:
                if digest(project(observed, bound["shape"])) != bound["digest"]:
                    raise Error("binding")
        known = self.receipt.get("releaseSecrets", [])
        if any(item not in known for item in self.releases()):
            raise Error("binding")

    def remove(self):
        result = self.read()
        if self.kind == STORAGE:
            return result
        if not result.get("id"):
            return result
        self.check_cluster()
        self.receipt["gatewayPhase"] = "removing"
        self.save()
        self.check_removing()
        if self.releases():
            self.helm("uninstall", self.name, "--wait", "--timeout", "5m")
        if (
            any(self.get_object(obj) for obj in self.receipt.get("chartObjects", []))
            or self.releases()
        ):
            raise Error("incomplete")
        for obj in self.receipt.get("chartObjects", []):
            self.receipt["objects"].pop(object_key(obj), None)
        self.receipt.update({"gatewayPhase": "removed", "gatewayId": None, "releaseSecrets": []})
        self.save()
        self.verify_objects()
        return {"id": None}

    def connection(self):
        result = self.read()
        if not result.get("id") or not result.get("running"):
            raise Error("incomplete")
        secret = self.get("Secret", self.name + "-client-tls", self.namespace_name)
        environment = {"NEMOCLAW_MANAGED_K8S_TOKEN": self.auth.token()}
        for key, suffix in (("ca.crt", "CA"), ("tls.crt", "CERT"), ("tls.key", "KEY")):
            path = self.state / ("gateway-" + key)
            self.write(path, base64.b64decode(secret["data"][key], validate=True))
            environment["NEMOCLAW_MANAGED_K8S_" + suffix] = str(path)
        return {**result, "environment": environment}

    def execute(self):
        action = self.request["action"]
        if action in ("read", "plan"):
            return self.read()
        if action == "ensure":
            return self.ensure()
        if action == "remove":
            return self.remove()
        if action == "connection":
            return self.connection()
        raise Error("configuration")


def main():
    os.umask(0o077)
    platform = None
    try:
        line = sys.stdin.readline((1 << 20) + 1)
        if len(line) > 1 << 20 or not line.endswith("\n"):
            raise Error("configuration")
        request = json.loads(line)
        if request.get("parentWatch") is True:
            import parent_watch

            parent_watch.start()
        platform = Platform(request)
        result = platform.execute()
    except Exception as error:
        code = str(error) if isinstance(error, Error) and str(error) in ERRORS else "command"
        if isinstance(error, ValueError) and str(error) == "auth":
            code = "auth"
        result = {"error": code}
        if platform and platform.receipt:
            key = "storageId" if platform.kind == STORAGE else "gatewayId"
            if platform.receipt.get(key):
                result.update({"id": platform.receipt[key], "running": False})
    sys.stdout.write(json.dumps(result, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
