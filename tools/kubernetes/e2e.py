#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Run the opt-in, owned kind qualification from the Kubernetes branch scope decision.

Only NVIDIA_INFERENCE_API_KEY is required as configuration. The SDK continues to
use an ordinary managed manifest and never depends on this local test fixture.
"""

import argparse
import hashlib
import io
import json
import os
import platform
import re
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import urllib.request
import uuid
import zipfile
from pathlib import Path

from inference_check import InferenceCheckError, check_inference

REPO = Path(__file__).resolve().parents[2]
PYTHON = sys.executable
KEY = "NVIDIA_INFERENCE_API_KEY"
STATE_PARENT = Path.home() / ".local/state/nemoclaw"
FULL_TEST = "owned_kubernetes_gateway_applies_invokes_exports_reapplies_and_destroys"
RETRY_TEST = "owned_kubernetes_agent_response_from_retained_state"
PLACEHOLDER_IMAGE = "registry.example.com/nemoclaw/openclaw-kubernetes@sha256:" + "0" * 64


class Error(Exception):
    pass


def platforms(system, machine):
    operating_system = {"Linux": "linux", "Darwin": "darwin"}.get(system)
    arch = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "amd64", "amd64": "amd64"}.get(
        machine.lower()
    )
    if not operating_system or not arch:
        raise Error("this local fixture requires Linux or macOS on AMD64 or ARM64")
    return f"{operating_system}_{arch}", f"linux/{arch}"


def environ(source):
    key = source.get(KEY, "")
    if not key or any(char.isspace() for char in key):
        raise Error(f"set {KEY} to your inference API key before running this test")
    env = dict(source)
    # Build tools, image builds, downloads, and cluster helpers do not receive it.
    env.pop(KEY, None)
    for name in ["KUBECONFIG", "CARGO", "RUSTC", "NEMOCLAW_CLUSTER_KUBECONFIG"]:
        env.pop(name, None)
    return key, env


def new_state():
    parent = STATE_PARENT.resolve()
    if parent == REPO or REPO in parent.parents:
        raise Error("test state must remain outside the repository")
    parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    return Path(tempfile.mkdtemp(prefix="k8s-e2e-", dir=parent))


def manifest(template, context, image, port):
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}", image):
        raise Error("agent image must have a verified repository digest")
    replacements = {
        "uid: d67c2c99-cf14-4bf0-8270-3754504b2219": ("uid: " + str(uuid.uuid4()), 1),
        "context: replace-with-explicit-context": ("context: " + json.dumps(context), 1),
        "https://127.0.0.1:17671": (f"https://127.0.0.1:{port}", 1),
        PLACEHOLDER_IMAGE: (image, 3),
        "../../schemas/nemoclaw-v1alpha1.schema.json": (
            (REPO / "schemas/nemoclaw-v1alpha1.schema.json").as_uri(),
            1,
        ),
    }
    for old, (new, count) in replacements.items():
        if template.count(old) != count:
            raise Error("managed example changed; update the test generator before deploying")
        template = template.replace(old, new)
    return template


def write_private(path, content):
    with path.open("x") as file:
        path.chmod(0o600)
        file.write(content)


class Runner:
    def __init__(self, state, key, env):
        self.state = state
        self.key = key
        self.env = env.copy()
        self.cluster = None
        self.stage = "Preflight"
        self.log = state / "test.log"
        write_private(self.log, "")

    def emit(self, text):
        safe = text.replace(self.key, "[REDACTED]")
        print(safe, end="", flush=True)
        with self.log.open("a") as file:
            file.write(safe)

    def run(self, stage, args, *, env=None, inference=False, quiet=False, compiler_output=False):
        self.stage = stage
        self.emit(f"\n{stage}\n")
        child_env = {**self.env, **(env or {})}
        child_env.pop(KEY, None)
        if inference:
            child_env[KEY] = self.key
        # Never print argv or environment. SDK errors and probe messages are
        # independently constrained; exact-key redaction is defense in depth.
        process = None
        try:
            with subprocess.Popen(
                args,
                cwd=REPO,
                env=child_env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                start_new_session=True,
            ) as process:
                try:
                    output = []
                    for line in process.stdout:
                        output.append(line)
                        if compiler_output:
                            try:
                                message = json.loads(line)
                            except ValueError:
                                self.emit(line)
                            else:
                                if message.get("reason") == "compiler-message":
                                    self.emit(message.get("message", {}).get("rendered") or "")
                        elif not quiet:
                            self.emit(line)
                    status = process.wait()
                except BaseException:
                    # Stop the command and its descendants before reporting the
                    # failure. Retained state must never have an active writer.
                    self.stop(process)
                    raise
        except OSError as error:
            raise Error(
                f"{stage}: could not start required tool (OS error {error.errno})"
            ) from None
        if status:
            raise Error(f"{stage} failed (exit {status}); resources and private state retained")
        return "".join(output)

    @staticmethod
    def stop(process):
        for sig in [signal.SIGTERM, signal.SIGKILL]:
            try:
                os.killpg(process.pid, sig)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=5)
                # The leader can exit before its descendants; end the group too.
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                return
            except subprocess.TimeoutExpired:
                continue
        raise Error("interrupted child could not be reaped; inspect retained state before recovery")

    def available(self, args):
        try:
            result = subprocess.run(
                args, cwd=REPO, env=self.env, capture_output=True, text=True, timeout=30
            )
            return result.stdout.strip() if result.returncode == 0 else None
        except (OSError, subprocess.TimeoutExpired):
            return None

    def preflight(self):
        if sys.version_info < (3, 12):  # noqa: UP036 - executable entry point for older hosts
            raise Error("Python 3.12 or newer is required")
        native, agent = platforms(platform.system(), platform.machine())
        for name in ["Cargo.toml", "docker-bake.hcl", "versions.json", "tools/kubernetes/stack.py"]:
            if not (REPO / name).is_file():
                raise Error("checkout is incomplete; use the codex/kubernetes-backend branch")
        missing = [
            name
            for name in ["docker", "kind", "kubectl", "helm", "openssl", "cc"]
            if not shutil.which(name, path=self.env.get("PATH"))
        ]
        if missing:
            raise Error("install required tools first: " + ", ".join(missing))
        docker = ["docker"]
        if self.available(docker + ["info", "--format", "{{.ServerVersion}}"]) is None:
            docker = ["sudo", "-n", "docker"]
            if self.available(docker + ["info", "--format", "{{.ServerVersion}}"]) is None:
                raise Error(
                    "start Docker and allow access; existing noninteractive sudo also failed"
                )
        if self.available(docker + ["buildx", "version"]) is None:
            raise Error("Docker Buildx is required")
        server = self.available(docker + ["info", "--format", "{{.OSType}}/{{.Architecture}}"])
        server_arch = {"linux/aarch64": "linux/arm64", "linux/x86_64": "linux/amd64"}.get(
            server, server
        )
        if server_arch != agent:
            raise Error("Docker must run Linux containers matching this host's architecture")
        pins = json.loads((REPO / "versions.json").read_text())
        self.env["RUSTUP_TOOLCHAIN"] = pins["rust"]
        cargo = ["cargo"]
        if not (self.available(cargo + ["--version"]) or "").startswith(
            "cargo " + pins["rust"] + " "
        ):
            local = REPO / ".tools" / ("rust-" + pins["rust"]) / "bin"
            if local.is_dir():
                self.env["PATH"] = str(local) + os.pathsep + self.env.get("PATH", "")
            elif shutil.which("rustup", path=self.env.get("PATH")):
                selected = self.available(["rustup", "which", "--toolchain", pins["rust"], "cargo"])
                if selected is None:
                    self.run(
                        "Prepare pinned Rust toolchain",
                        ["rustup", "toolchain", "install", pins["rust"], "--profile", "minimal"],
                    )
                    selected = self.available(
                        ["rustup", "which", "--toolchain", pins["rust"], "cargo"]
                    )
                if not selected or not Path(selected).is_absolute():
                    raise Error("rustup could not locate the pinned Cargo executable")
                # Homebrew's standalone cargo can precede rustup's shims. Use
                # the selected toolchain directory for cargo and its rustc.
                self.env["PATH"] = (
                    str(Path(selected).parent) + os.pathsep + self.env.get("PATH", "")
                )
            else:
                raise Error("install rustup or place the pinned Rust toolchain on PATH")
        for tool in ["cargo", "rustc"]:
            version = self.available([tool, "--version"]) or ""
            if not version.startswith(tool + " " + pins["rust"] + " "):
                raise Error(
                    "the pinned Rust toolchain is unavailable: " + tool + " " + pins["rust"]
                )
        self.prepare_protoc(pins, native)
        # Keep both cargo invocations on the same build cache; the bundle builder
        # explicitly uses the repository target directory for its binaries.
        self.env["CARGO_TARGET_DIR"] = str(REPO / "target")
        self.emit(f"Native bundle: {native}; agent image: {agent}\n")
        return cargo, docker, native, agent

    def prepare_protoc(self, pins, native):
        expected = "libprotoc " + pins["protobuf"]
        candidates = [
            self.env.get("PROTOC"),
            "protoc",
            str(REPO / ".tools" / ("protoc-" + pins["protobuf"]) / "bin/protoc"),
        ]
        for binary in candidates:
            if binary and self.available([binary, "--version"]) == expected:
                self.env["PROTOC"] = binary
                return
        self.stage = "Prepare pinned Protocol Buffers compiler"
        self.emit(f"\n{self.stage}\n")
        pin = pins["platforms"][native]["protoc"]
        try:
            with urllib.request.urlopen(pin["url"], timeout=120) as response:
                data = response.read()
        except OSError:
            raise Error("could not download the pinned protoc archive") from None
        if hashlib.sha256(data).hexdigest() != pin["sha256"]:
            raise Error("protoc archive checksum mismatch")
        destination = self.state / "protoc"
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            archive.extractall(destination)
        binary = destination / "bin/protoc"
        binary.chmod(0o700)
        self.env["PROTOC"] = str(binary)
        if self.available([str(binary), "--version"]) != expected:
            raise Error("downloaded protoc did not report the pinned version")

    def execute(self, *, keep_cluster=False):
        cargo, docker, native, agent = self.preflight()
        self.run(
            "Build verified native bundle",
            cargo
            + ["run", "--locked", "-p", "nemoclaw-build", "--", "bundle", "--platform", native],
        )
        artifacts = self.run(
            "Build lifecycle test binary",
            cargo
            + [
                "test",
                "--locked",
                "-p",
                "nemoclaw-e2e",
                "--test",
                "kubernetes_live",
                "--no-run",
                "--message-format=json",
            ],
            compiler_output=True,
        )
        executables = []
        for line in artifacts.splitlines():
            try:
                artifact = json.loads(line)
            except ValueError:
                continue
            if (
                artifact.get("reason") == "compiler-artifact"
                and artifact.get("target", {}).get("name") == "kubernetes_live"
                and artifact.get("profile", {}).get("test")
                and artifact.get("executable")
            ):
                executables.append(artifact["executable"])
        if len(executables) != 1 or not Path(executables[0]).is_file():
            raise Error("Cargo did not produce the requested lifecycle test executable")
        # Preserve this test binary for the inference-only retry. A later build
        # in the checkout must not silently replace the executable used here.
        test_binary = self.state / "kubernetes-live-test"
        shutil.copyfile(executables[0], test_binary)
        test_binary.chmod(0o700)
        prefix = "nc-k8s-e2e-" + uuid.uuid4().hex[:12]
        image_tag = prefix + ":openclaw-kubernetes"
        # Use the upstream packaging entry point so the final image records
        # discovery from its installed Fabric adapter. sudo normally strips
        # environment variables; supply this nonsecret image name after it.
        self.run(
            "Build Kubernetes agent image",
            docker[:-1]
            + [
                "env",
                "IMAGE_PREFIX=" + prefix,
                PYTHON,
                str(REPO / "image/build_fabric.py"),
                "--platform",
                agent,
                "openclaw-kubernetes",
            ],
        )
        inspected = json.loads(
            self.run("Inspect agent image", docker + ["image", "inspect", image_tag], quiet=True)
        )
        if (
            len(inspected) != 1
            or str(inspected[0].get("Os")) + "/" + str(inspected[0].get("Architecture")) != agent
        ):
            raise Error("built agent image architecture does not match the selected cluster")
        digests = inspected[0].get("RepoDigests", [])
        image = next((value for value in digests if value.startswith(prefix + "@sha256:")), None)
        if image is None:
            # Some Docker engines normalize the repository with docker.io/library.
            image = next(
                (
                    value
                    for value in digests
                    if value.startswith("docker.io/library/" + prefix + "@sha256:")
                ),
                None,
            )
        if not image:
            raise Error(
                "Docker did not retain the built repository digest; enable its containerd image store"
            )
        metadata = self.state / "image-metadata.json"
        self.run(
            "Export immutable image metadata",
            [PYTHON, str(REPO / "image/export_metadata.py")]
            + (["--sudo-docker"] if docker[:-1] else [])
            + ["--image", image, "--platform", agent, "--output", str(metadata)],
        )
        helper = [PYTHON, str(REPO / "tools/kubernetes/stack.py")]
        cluster_state = self.state / "kind"
        self.run(
            "Create isolated kind cluster", helper + ["cluster", "--state-dir", str(cluster_state)]
        )
        receipt = json.loads((cluster_state / "ownership.json").read_text())
        self.cluster = receipt["cluster"]
        self.run(
            "Load verified image into owned cluster",
            helper + ["load-image", "--state-dir", str(cluster_state), "--image", image_tag],
        )
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        config = self.state / "deployment.yaml"
        text = manifest(
            (REPO / "examples/kubernetes/managed-development.yaml").read_text(),
            "kind-" + self.cluster,
            image,
            port,
        )
        write_private(config, text)
        test_env = {
            "NEMOCLAW_AGENT_IMAGE_METADATA": str(metadata),
            "NEMOCLAW_CLUSTER_KUBECONFIG": str(cluster_state / "kubeconfig"),
            "NEMOCLAW_TEST_KUBERNETES_CONFIG": str(config),
            "NEMOCLAW_TEST_KUBERNETES_STATE": str(self.state / "sdk-state"),
            "NEMOCLAW_TEST_BUNDLE": str(REPO / "dist" / native),
        }
        write_private(
            self.state / "run.json",
            json.dumps(
                {
                    "platform": native,
                    "image": image,
                    "cluster": self.cluster,
                    "environment": test_env,
                },
                indent=2,
            )
            + "\n",
        )
        # The inference-only retry cannot accidentally rerun apply or destroy.
        retry = [
            "env",
            *(f"{key}={value}" for key, value in test_env.items()),
            "PATH=" + str(REPO / "dist" / native / "bin") + os.pathsep + self.env.get("PATH", ""),
            str(test_binary),
            RETRY_TEST,
            "--ignored",
            "--exact",
            "--nocapture",
        ]
        write_private(
            self.state / "retry-inference.sh",
            "#!/bin/sh\nset -eu\ncd " + shlex.quote(str(REPO)) + "\n" + shlex.join(retry) + "\n",
        )
        self.emit(f"\nManifest: {config}\nPrivate kubeconfig: {cluster_state / 'kubeconfig'}\n")
        self.run(
            "Run full Kubernetes lifecycle",
            [str(test_binary), FULL_TEST, "--ignored", "--exact", "--nocapture"],
            env=test_env,
            inference=True,
        )
        if not keep_cluster:
            self.run(
                "Delete completed test cluster",
                helper
                + ["cleanup", "--state-dir", str(cluster_state), "--confirm-cluster", self.cluster],
            )
        self.emit("\nPASS: three agent responses, unchanged plan, export/reapply, and destroy.\n")
        self.emit(
            "Cluster retained by --keep-cluster.\n"
            if keep_cluster
            else "Owned disposable cluster deleted.\n"
        )
        self.emit(f"Private test evidence and SDK state retained: {self.state}\n")

    def failure(self, message):
        self.emit(f"\nFAILED: {message}\nPrivate state retained: {self.state}\n")
        cluster_state = self.state / "kind"
        if (cluster_state / "kubeconfig").is_file():
            self.emit(
                "Inspect this cluster with:\n"
                + shlex.join(
                    [
                        "kubectl",
                        "--kubeconfig",
                        str(cluster_state / "kubeconfig"),
                        "get",
                        "pods",
                        "-A",
                    ]
                )
                + "\n"
            )
        if (self.state / "retry-inference.sh").is_file():
            self.emit(
                "For a transient inference failure, retry against the installed provider credential:\n"
                + shlex.join(["sh", str(self.state / "retry-inference.sh")])
                + "\n"
            )
            self.emit(
                "Changing an exported key does not update the installed provider credential.\n"
                "For HTTP 401, validate the key with e2e.py --check-inference, then start a fresh test if correcting the key.\n"
            )
        if self.cluster is None and (cluster_state / "ownership.json").is_file():
            try:
                candidate = json.loads((cluster_state / "ownership.json").read_text()).get(
                    "cluster", ""
                )
                if re.fullmatch(r"nemoclaw-v1-[a-z0-9]{8}", candidate):
                    self.cluster = candidate
            except (OSError, ValueError):
                pass
        if self.cluster:
            self.emit(
                "To delete this disposable cluster and all its volumes:\n"
                + shlex.join(
                    [
                        PYTHON,
                        str(REPO / "tools/kubernetes/stack.py"),
                        "cleanup",
                        "--state-dir",
                        str(cluster_state),
                        "--confirm-cluster",
                        self.cluster,
                    ]
                )
                + "\n"
            )
        self.emit("A new invocation creates fresh state; it does not repair or delete this run.\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument(
        "--keep-cluster",
        action="store_true",
        help="retain the disposable cluster after success; SDK destroy still runs",
    )
    modes.add_argument(
        "--check-inference",
        action="store_true",
        help="check the exported key and sample model directly; do not build or create a cluster",
    )
    args = parser.parse_args()
    runner = None
    try:
        key, env = environ(os.environ)
        print("Check hosted inference authentication", flush=True)
        check_inference(key)
        print("Hosted inference accepted the key and returned a valid result.", flush=True)
        if args.check_inference:
            return 0
        os.umask(0o077)

        def interrupted(signum, frame):
            raise KeyboardInterrupt

        signal.signal(signal.SIGTERM, interrupted)
        runner = Runner(new_state(), key, env)
        runner.emit(f"Private test directory: {runner.state}\n")
        runner.execute(keep_cluster=args.keep_cluster)
        return 0
    except (Error, InferenceCheckError, OSError, ValueError, KeyboardInterrupt) as error:
        message = (
            "interrupted; resources retained"
            if isinstance(error, KeyboardInterrupt)
            else str(error)
        )
        if runner:
            runner.failure(message)
        else:
            print("Error: " + message, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
