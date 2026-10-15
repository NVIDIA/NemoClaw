#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Exercise the supplied image request guard through Docker exec without a GPU or published port."""

import json
from pathlib import Path
import selectors
import signal
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
_cancelled_signal: int | None = None
_cleanup_in_progress = False


def docker(*arguments: str) -> str:
    return subprocess.check_output(
        ("docker", *arguments), text=True, timeout=SUBPROCESS_TIMEOUT_SECONDS,
    ).strip()


def cleanup(*arguments: str) -> bool:
    try:
        result = subprocess.run(
            ("docker", *arguments), check=False, capture_output=True,
            timeout=SUBPROCESS_TIMEOUT_SECONDS,
        )
        if result.returncode != 0 and arguments[:2] == ("rm", "--force") and b"No such container" in result.stderr:
            return True  # --rm may already have removed an exited container.
        if result.returncode != 0:
            print(f"Docker cleanup {arguments!r} failed: stderr={result.stderr[:1200]!r}", file=sys.stderr)
        return result.returncode == 0
    except (subprocess.TimeoutExpired, OSError):
        print(f"Docker cleanup {arguments!r} unavailable or timed out", file=sys.stderr)
        return False


def cancel_on_signal(signum: int, _frame: object) -> None:
    global _cancelled_signal
    if _cancelled_signal is None:
        _cancelled_signal = signum
    if not _cleanup_in_progress:
        raise SystemExit(128 + _cancelled_signal)


def install_cancellation_handlers() -> dict[int, object]:
    global _cancelled_signal
    _cancelled_signal = None
    previous = {signum: signal.getsignal(signum) for signum in (signal.SIGINT, signal.SIGTERM)}
    for signum in previous:
        signal.signal(signum, cancel_on_signal)
    return previous


def forward(container: str, authorization: str) -> tuple[int, bytes, bytes]:
    request = (
        f"GET /v1/models HTTP/1.1\r\nHost: 127.0.0.1\r\n"
        f"Authorization: Bearer {authorization}\r\n"
        "Connection: keep-alive\r\n\r\n"
    ).encode("ascii")
    process = subprocess.Popen(
        (
            "docker", "exec", "-i", container, GUARD, "--stdio-forward", "--listen-port",
            str(LISTEN_PORT), "--forward-timeout-seconds", "10",
        ),
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


def cancel_forward(container: str) -> None:
    process = subprocess.Popen(
        ("docker", "exec", "-i", container, GUARD, "--stdio-forward", "--listen-port",
         str(LISTEN_PORT), "--forward-timeout-seconds", "60"),
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    try:
        assert process.stdin is not None and process.stdout is not None
        process.stdin.write((
            "GET /v1/models HTTP/1.1\r\nHost: guard\r\n"
            f"Authorization: Bearer {TEST_KEY}\r\n\r\n"
        ).encode("ascii"))
        process.stdin.flush()
        output = b""
        deadline = time.monotonic() + 5
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while not output.endswith(b"2\r\nOK\r\n"):
                if not selector.select(max(0, deadline - time.monotonic())):
                    raise RuntimeError("guard stream did not start before cancellation")
                chunk = process.stdout.read1(4096)
                if not chunk or len(output) + len(chunk) > 8192:
                    raise RuntimeError("guard stream ended or exceeded its fixture bound")
                output += chunk
        if not output.startswith(b"HTTP/1.1 200 "):
            raise RuntimeError("guard did not authorize the cancellation probe")
        process.stdin.close()
        # EOF must terminate the remote command before either serving deadline.
        if process.wait(timeout=3) != 0:
            raise RuntimeError("remote forwarder did not confirm cancellation")
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        for stream in (process.stdin, process.stdout, process.stderr):
            if stream is not None:
                stream.close()


def prove(image: str, directory: Path) -> None:
    global _cancelled_signal, _cleanup_in_progress
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

    network = directory.name
    container = f"{directory.name}-proof"
    try:
        docker("network", "create", "--internal", "--driver", "bridge", network)
        docker(
            "run", "--detach", "--rm", "--name", container, "--read-only", "--network", network,
            "--mount", f"type=bind,source={directory},target=/run/secrets,readonly",
            "--mount", f"type=bind,source={upstream},target=/usr/local/bin/llama-server,readonly",
            "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777",
            "--entrypoint", GUARD, image,
            "--listen-host", "0.0.0.0", "--listen-port", str(LISTEN_PORT),
            "--upstream-host", "127.0.0.1", "--upstream-port", str(UPSTREAM_PORT),
            "--max-request-body-bytes", "1024", "--max-request-header-bytes", "8192",
            "--max-output-tokens", "16", "--request-timeout-seconds", "30",
            "--shutdown-timeout-seconds", "5", "--",
            "/usr/local/bin/llama-server", "--host", "127.0.0.1", "--port", str(UPSTREAM_PORT),
            "--api-key-file", "/run/secrets/llama-cpp-api-key", "--n-predict", "16",
            "--model", "/tmp/probe.gguf", "--no-agent", "--no-mmproj", "--no-slots", "--no-ui",
        )
        inspect = json.loads(docker("inspect", container))[0]
        ports = inspect["NetworkSettings"].get("Ports") or {}
        if inspect["HostConfig"].get("PortBindings") or any(ports.values()):
            raise RuntimeError("Image published a container port")
        if not json.loads(docker("network", "inspect", network))[0]["Internal"]:
            raise RuntimeError("Image network permits egress")

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

        cancel_forward(container)
        status, output, error = forward(container, TEST_KEY)
        require_response(status, output, error, b"200")
        if not output.endswith(b"\r\n\r\nOK"):
            raise RuntimeError(f"guard did not forward the complete upstream body: {output[-100:]!r}")
        print(f"Image {image!r}: internal-only Docker exec, bearer 401/200, cancellation, recovery, open-stdin exit passed")
    except Exception:
        try:
            print(docker("logs", container)[-1200:], file=sys.stderr)
        except (subprocess.SubprocessError, OSError):
            print("Docker proof logs unavailable", file=sys.stderr)
        raise
    finally:
        primary_failure = sys.exc_info()[0] is not None
        _cleanup_in_progress = True
        try:
            container_removed = cleanup("rm", "--force", container)
            network_removed = cleanup("network", "rm", network)
        finally:
            _cleanup_in_progress = False
            cancelled_signal = _cancelled_signal
            _cancelled_signal = None
        if cancelled_signal is not None:
            raise SystemExit(128 + cancelled_signal)
        if not (container_removed and network_removed) and not primary_failure:
            raise RuntimeError("Docker proof resource cleanup failed")


if __name__ == "__main__":
    if len(sys.argv) != 2 or not sys.argv[1]:
        raise SystemExit("usage: llama-cpp-stdio-image-proof.py IMAGE")
    install_cancellation_handlers()
    with tempfile.TemporaryDirectory(prefix="nemoclaw-llama-stdio-image-") as temporary:
        prove(sys.argv[1], Path(temporary))
