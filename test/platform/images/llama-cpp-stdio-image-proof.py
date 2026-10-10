#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Exercise the PR-built request guard through Docker exec without a GPU or published port."""

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time


GUARD = "/usr/local/bin/nemoclaw-llama-cpp-request-guard"
LISTEN_PORT = 18081
UPSTREAM_PORT = 18082
TEST_KEY = "a" * 64
FIXTURE = Path(__file__).with_name("fixtures") / "llama-cpp-stdio-upstream.c"
SUBPROCESS_TIMEOUT_SECONDS = 60


def docker(*arguments: str) -> str:
    return subprocess.check_output(
        ("docker", *arguments), text=True, timeout=SUBPROCESS_TIMEOUT_SECONDS,
    ).strip()


def cleanup(*arguments: str) -> None:
    try:
        result = subprocess.run(
            ("docker", *arguments), check=False, capture_output=True,
            timeout=SUBPROCESS_TIMEOUT_SECONDS,
        )
        if result.returncode != 0:
            print("Docker proof cleanup failed", file=sys.stderr)
    except subprocess.TimeoutExpired:
        print("Docker proof cleanup timed out", file=sys.stderr)


def forward(container: str, authorization: str) -> tuple[int, bytes, bytes]:
    request = (
        f"GET /v1/models HTTP/1.1\r\nHost: 127.0.0.1\r\n"
        f"Authorization: Bearer {authorization}\r\n"
        "Connection: keep-alive\r\n\r\n"
    ).encode("ascii")
    process = subprocess.Popen(
        ("docker", "exec", "-i", container, GUARD, "--stdio-forward", "--listen-port", str(LISTEN_PORT)),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        assert process.stdin is not None
        process.stdin.write(request)
        process.stdin.flush()
        # Leave stdin open. A complete response must end docker exec even when
        # the request writer and upstream keep their connections open.
        status = process.wait(timeout=5)
        assert process.stdout is not None and process.stderr is not None
        return status, process.stdout.read(), process.stderr.read()
    except subprocess.TimeoutExpired as error:
        process.kill()
        process.wait(timeout=5)
        raise RuntimeError("docker exec waited for stdin or upstream EOF") from error
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        for stream in (process.stdin, process.stdout, process.stderr):
            if stream is not None:
                stream.close()


def require_response(status: int, output: bytes, error: bytes, expected: bytes) -> None:
    if status != 0 or not output.startswith(b"HTTP/1.1 " + expected + b" "):
        raise RuntimeError(
            f"docker exec returned {status}, expected HTTP {expected.decode()}: "
            f"stdout={output[:300]!r} stderr={error[:300]!r}"
        )


def prove(image: str, directory: Path) -> None:
    upstream = directory / "llama-server"
    subprocess.run(
        ("cc", "-O2", "-std=c11", "-Wall", "-Wextra", "-Werror", str(FIXTURE), "-o", str(upstream)),
        check=True,
        timeout=SUBPROCESS_TIMEOUT_SECONDS,
    )
    upstream.chmod(0o555)
    key = directory / "llama-cpp-api-key"
    key.write_text(TEST_KEY + "\n", encoding="ascii")
    key.chmod(0o444)
    directory.chmod(0o755)

    network = docker("network", "create", "--internal", "--driver", "bridge", directory.name)
    container = ""
    try:
        container = docker(
            "run", "--detach", "--read-only", "--network", network,
            "--mount", f"type=bind,source={directory},target=/run/secrets,readonly",
            "--mount", f"type=bind,source={upstream},target=/usr/local/bin/llama-server,readonly",
            "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777",
            "--entrypoint", GUARD, image,
            "--listen-host", "0.0.0.0", "--listen-port", str(LISTEN_PORT),
            "--upstream-host", "127.0.0.1", "--upstream-port", str(UPSTREAM_PORT),
            "--max-request-body-bytes", "1024", "--max-request-header-bytes", "8192",
            "--max-output-tokens", "16", "--request-timeout-seconds", "5",
            "--shutdown-timeout-seconds", "5", "--",
            "/usr/local/bin/llama-server", "--host", "127.0.0.1", "--port", str(UPSTREAM_PORT),
            "--api-key-file", "/run/secrets/llama-cpp-api-key", "--n-predict", "16",
            "--model", "/tmp/probe.gguf", "--no-agent", "--no-mmproj", "--no-slots", "--no-ui",
        )
        inspect = json.loads(docker("inspect", container))[0]
        ports = inspect["NetworkSettings"].get("Ports") or {}
        if inspect["HostConfig"].get("PortBindings") or any(ports.values()):
            raise RuntimeError("PR image published a container port")
        if not json.loads(docker("network", "inspect", network))[0]["Internal"]:
            raise RuntimeError("PR image network permits egress")

        # Only an unavailable listener is transient during container startup.
        # The unauthorized GET is idempotent and each attempt is retained in CI logs.
        for attempt in range(1, 21):
            status, output, error = forward(container, "b" * 64)
            if status == 0:
                require_response(status, output, error, b"401")
                break
            if b"request guard is unavailable" not in error or attempt == 20:
                raise RuntimeError(f"guard readiness attempt {attempt} failed: {error[:300]!r}")
            print(f"guard listener unavailable on startup attempt {attempt}", flush=True)
            time.sleep(0.1)

        status, output, error = forward(container, TEST_KEY)
        require_response(status, output, error, b"200")
        if not output.endswith(b"\r\n\r\nOK"):
            raise RuntimeError(f"guard did not forward the complete upstream body: {output[-100:]!r}")
        print("PR-built image: internal-only Docker exec, bearer 401/200, open-stdin exit passed")
    except Exception:
        if container:
            try:
                print(docker("logs", container)[-1200:], file=sys.stderr)
            except (subprocess.SubprocessError, OSError):
                print("Docker proof logs unavailable", file=sys.stderr)
        raise
    finally:
        if container:
            cleanup("rm", "--force", container)
        cleanup("network", "rm", network)


if __name__ == "__main__":
    if len(sys.argv) != 2 or not sys.argv[1]:
        raise SystemExit("usage: llama-cpp-stdio-image-proof.py IMAGE")
    with tempfile.TemporaryDirectory(prefix="nemoclaw-llama-stdio-image-") as temporary:
        prove(sys.argv[1], Path(temporary))
