# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Validate deterministic read-only MCP calls against the installed package."""

import datetime
import errno
import ipaddress
import json
import signal
import socket
import ssl
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

_COMMAND = "/usr/local/lib/nemoclaw/dcode-wrapper.sh"
_CONFIG = Path("/sandbox/.deepagents/.nemoclaw-mcp.json")
_MAX_BYTES = 131_072
_TOOL = "worker-broker_worker_task_context"
_REFLECTED_CREDENTIAL = "Bearer sk-proj-validation-credential-value"
_ATTESTATION = {
    "algorithm": "sha256",
    "digest": "3d872ea8299fc2d4663469b2e6e81c56e9bfc3dcab53779fc19b0588915d0f9e",
    "nonce": "qualification-nonce",
}
_ERROR_MESSAGES = {
    "ambiguous_tool": "The exact MCP tool name is ambiguous.",
    "input_too_large": "The JSON input exceeds the managed size limit.",
    "invalid_input": "Standard input must be one JSON object.",
    "result_too_large": "The MCP tool result exceeds the managed size limit.",
    "runtime_failure": "The managed MCP tool call failed.",
    "timeout": "The managed MCP tool call exceeded its time limit.",
    "tool_failed": "The MCP tool reported a failure.",
    "tool_not_found": "The exact MCP tool is unavailable.",
    "tool_not_read_only": "The selected MCP tool is not coherently read-only.",
}


def _record(marker: Path, value: str) -> None:
    with marker.open("a", encoding="utf-8") as stream:
        stream.write(f"{value}\n")


def _serve(mode: str, host: str, port: int, cert: Path, key: Path, marker: Path) -> None:
    """Run one real Streamable HTTP MCP server for the build validation."""
    import uvicorn
    from mcp.server.fastmcp import FastMCP
    from mcp.server.fastmcp.exceptions import ToolError
    from mcp.types import AudioContent, CallToolResult, ToolAnnotations
    from pydantic import BaseModel

    class Qualification(BaseModel):
        output_attestation: dict[str, str]

    class ContextResult(BaseModel):
        qualification: Qualification
        task_context: dict[str, str]

    server = FastMCP(
        "nemoclaw-read-only-validation",
        host=host,
        port=port,
        streamable_http_path="/mcp",
        json_response=True,
        stateless_http=True,
        log_level="CRITICAL",
    )
    read_only = ToolAnnotations(
        readOnlyHint=True,
        destructiveHint=False,
        idempotentHint=True,
        openWorldHint=False,
    )

    @server.tool(name="worker_task_context", annotations=read_only)
    def worker_task_context(worker: str, nonce: str) -> ContextResult:
        _record(marker, "worker_task_context")
        return ContextResult(
            qualification=Qualification(output_attestation=_ATTESTATION),
            task_context={"nonce": nonce, "worker": worker},
        )

    @server.tool(name="credential_reflection", annotations=read_only)
    def credential_reflection() -> dict[str, Any]:
        _record(marker, "credential_reflection")
        return {
            "authorization": _REFLECTED_CREDENTIAL,
            "nested": {"credential": _REFLECTED_CREDENTIAL},
        }

    @server.tool(name="unannotated")
    def unannotated() -> str:
        _record(marker, "unannotated")
        return "unexpected"

    @server.tool(
        name="mutating",
        annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=True),
    )
    def mutating() -> str:
        _record(marker, "mutating")
        return "unexpected"

    if mode == "malformed":
        malformed = ToolAnnotations.model_construct(
            readOnlyHint="not-a-boolean",
            destructiveHint=False,
            idempotentHint=True,
            openWorldHint=False,
        )

        @server.tool(name="malformed_annotations", annotations=malformed)
        def malformed_annotations() -> str:
            _record(marker, "malformed_annotations")
            return "unexpected"
    elif mode != "normal":
        raise RuntimeError("invalid validation MCP server mode")

    @server.tool(
        name="contradictory",
        annotations=ToolAnnotations(readOnlyHint=True, destructiveHint=True),
    )
    def contradictory() -> str:
        _record(marker, "contradictory")
        return "unexpected"

    @server.tool(name="failing", annotations=read_only)
    def failing() -> str:
        _record(marker, "failing")
        raise ToolError("untrusted failure detail")

    @server.tool(name="oversized", annotations=read_only)
    def oversized() -> dict[str, Any]:
        _record(marker, "oversized")
        return {
            "nested": [
                {
                    "authorization": "Bearer sk-proj-"
                    + "x" * (_MAX_BYTES * 8)
                }
            ],
        }

    @server.tool(name="malformed_result", annotations=read_only)
    def malformed_result() -> CallToolResult:
        _record(marker, "malformed_result")
        return CallToolResult(
            content=[
                AudioContent(type="audio", data="AA==", mimeType="audio/wav")
            ]
        )

    @server.tool(name="hanging", annotations=read_only)
    async def hanging() -> str:
        import asyncio

        _record(marker, "hanging")
        await asyncio.Event().wait()
        return "unexpected"

    @server.tool(name="c", annotations=read_only)
    def ambiguous_c() -> str:
        _record(marker, "ambiguous_c")
        return "unexpected"

    @server.tool(name="b_c", annotations=read_only)
    def ambiguous_b_c() -> str:
        _record(marker, "ambiguous_b_c")
        return "unexpected"

    app = server.streamable_http_app()
    uvicorn.run(
        app,
        host=host,
        port=port,
        ssl_certfile=str(cert),
        ssl_keyfile=str(key),
        log_level="critical",
        access_log=False,
        timeout_graceful_shutdown=1,
    )


def _validation_hosts() -> tuple[str, str]:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("10.255.255.254", 1))
            address = probe.getsockname()[0]
    except OSError as error:
        if error.errno != errno.ENETUNREACH:
            raise
        # Protected image rebuilds deliberately disable BuildKit networking.
        # Bind to loopback while using a canonical DNS name so the validation
        # still exercises the managed destination and local TLS/MCP contracts.
        return "127.0.0.1", "localhost"
    parsed = ipaddress.ip_address(address)
    if parsed.version != 4 or parsed.is_loopback or parsed.is_link_local:
        raise RuntimeError("validation server did not resolve a routed IPv4 address")
    return address, address


def _free_port(host: str) -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind((host, 0))
        return listener.getsockname()[1]


def _write_certificate(directory: Path, host: str) -> tuple[Path, Path]:
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, host)])
    now = datetime.datetime.now(datetime.timezone.utc)
    try:
        alternative_name: x509.GeneralName = x509.IPAddress(ipaddress.ip_address(host))
    except ValueError:
        alternative_name = x509.DNSName(host)
    certificate = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=1))
        .not_valid_after(now + datetime.timedelta(minutes=10))
        .add_extension(
            x509.SubjectAlternativeName([alternative_name]),
            critical=False,
        )
        .sign(key, hashes.SHA256())
    )
    cert_path = directory / "server.pem"
    key_path = directory / "server-key.pem"
    cert_path.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    key_path.chmod(0o600)
    return cert_path, key_path


def _wait_for_server(host: str, port: int, cert: Path, process: subprocess.Popen[bytes]) -> None:
    context = ssl.create_default_context(cafile=str(cert))
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError("validation MCP server exited during startup")
        try:
            with socket.create_connection((host, port), timeout=0.2) as connection:
                with context.wrap_socket(connection, server_hostname=host):
                    return
        except (OSError, ssl.SSLError):
            time.sleep(0.05)
    raise RuntimeError("validation MCP server did not become ready")


def _write_config(url: str, *, ambiguous: bool = False) -> None:
    if _CONFIG.exists() or _CONFIG.is_symlink():
        raise RuntimeError("managed MCP validation config already exists")
    servers: dict[str, Any]
    common = {
        "type": "http",
        "url": url,
        "headers": {
            "Authorization": "Bearer openshell:resolve:env:v12_VALIDATION_MCP_TOKEN"
        },
    }
    if ambiguous:
        servers = {"a": common, "a_b": common}
    else:
        servers = {"worker-broker": common}
    _CONFIG.parent.mkdir(parents=True, exist_ok=True)
    _CONFIG.write_text(json.dumps({"mcpServers": servers}), encoding="utf-8")
    _CONFIG.chmod(0o600)


def _invoke(
    tool: str,
    arguments: dict[str, Any],
    *,
    cert: Path,
    host: str,
    expected_status: int,
    raw_input: str | None = None,
) -> dict[str, Any]:
    environment = {
        "HOME": "/sandbox",
        "LANG": "C.UTF-8",
        "NEMOCLAW_TOOL_DISCLOSURE": "progressive",
        "NO_PROXY": host,
        "PATH": "/usr/local/bin:/opt/venv/bin:/usr/bin:/bin",
        "SSL_CERT_FILE": str(cert),
    }
    result = subprocess.run(
        [_COMMAND, "tools", "call-read-only", tool, "--json"],
        input=json.dumps(arguments) if raw_input is None else raw_input,
        text=True,
        capture_output=True,
        timeout=25,
        check=False,
        env=environment,
    )
    if result.returncode != expected_status:
        raise RuntimeError(f"managed MCP command returned {result.returncode}")
    if result.stderr:
        raise RuntimeError("managed MCP command emitted standard error")
    if len(result.stdout.encode("utf-8")) > _MAX_BYTES + 1:
        raise RuntimeError("managed MCP command exceeded its output limit")
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError("managed MCP command returned malformed JSON") from exc
    if (
        not isinstance(payload, dict)
        or payload.get("schema_version") != 1
        or payload.get("command") != "tools call-read-only"
        or not isinstance(payload.get("data"), dict)
    ):
        raise RuntimeError("managed MCP command returned the wrong envelope")
    return payload["data"]


def _expect_error(
    tool: str,
    code: str,
    *,
    cert: Path,
    host: str,
    raw_input: str | None = None,
) -> dict[str, Any]:
    data = _invoke(
        tool,
        {},
        cert=cert,
        host=host,
        expected_status=1,
        raw_input=raw_input,
    )
    if data != {
        "ok": False,
        "status": "error",
        "code": code,
        "message": _ERROR_MESSAGES[code],
    }:
        raise RuntimeError(f"managed MCP command returned the wrong {code} error")
    return data


def _marker_values(marker: Path) -> list[str]:
    if not marker.exists():
        return []
    return marker.read_text(encoding="utf-8").splitlines()


def _validate(
    host: str,
    port: int,
    malformed_port: int,
    cert: Path,
    marker: Path,
    malformed_marker: Path,
) -> None:
    url = f"https://{host}:{port}/mcp"

    _write_config(url)
    success = _invoke(
        _TOOL,
        {"worker": "worker.1", "nonce": "qualification-nonce"},
        cert=cert,
        host=host,
        expected_status=0,
    )
    if (
        success.get("ok") is not True
        or success.get("status") != "ok"
        or success.get("tool") != _TOOL
        or not isinstance(success.get("content"), list)
        or success.get("structured_content")
        != {
            "qualification": {"output_attestation": _ATTESTATION},
            "task_context": {
                "nonce": "qualification-nonce",
                "worker": "worker.1",
            },
        }
        or set(success)
        != {"ok", "status", "tool", "content", "structured_content"}
    ):
        raise RuntimeError("managed MCP command did not preserve the structured result")
    if _marker_values(marker) != ["worker_task_context"]:
        raise RuntimeError("managed MCP command did not invoke the exact tool once")

    reflected = _invoke(
        "worker-broker_credential_reflection",
        {},
        cert=cert,
        host=host,
        expected_status=0,
    )
    encoded_reflection = json.dumps(reflected, separators=(",", ":"))
    if (
        _REFLECTED_CREDENTIAL in encoded_reflection
        or encoded_reflection.count("<redacted-secret>") < 2
    ):
        raise RuntimeError("managed MCP command exposed a credential-bearing result")

    rejected = (
        ("worker-broker_unannotated", "tool_not_read_only"),
        ("worker-broker_mutating", "tool_not_read_only"),
        ("worker-broker_contradictory", "tool_not_read_only"),
        ("worker-broker_missing", "tool_not_found"),
    )
    for tool, code in rejected:
        _expect_error(tool, code, cert=cert, host=host)
    if _marker_values(marker) != ["worker_task_context", "credential_reflection"]:
        raise RuntimeError("managed MCP command invoked a rejected tool")

    _expect_error(
        _TOOL,
        "invalid_input",
        cert=cert,
        host=host,
        raw_input='{"nonce":"one","nonce":"two"}',
    )
    _expect_error(
        _TOOL,
        "input_too_large",
        cert=cert,
        host=host,
        raw_input="x" * (_MAX_BYTES + 1),
    )
    if _marker_values(marker) != ["worker_task_context", "credential_reflection"]:
        raise RuntimeError("managed MCP command accepted invalid input")

    for tool, code in (
        ("worker-broker_failing", "tool_failed"),
        ("worker-broker_malformed_result", "runtime_failure"),
    ):
        _expect_error(tool, code, cert=cert, host=host)

    oversized_started = time.monotonic()
    oversized = _expect_error(
        "worker-broker_oversized",
        "result_too_large",
        cert=cert,
        host=host,
    )
    if "sk-proj-" in json.dumps(oversized, separators=(",", ":")):
        raise RuntimeError("managed MCP command exposed an oversized credential")
    if time.monotonic() - oversized_started >= 15:
        raise RuntimeError("managed MCP command did not bound an oversized result")

    started = time.monotonic()
    _expect_error("worker-broker_hanging", "timeout", cert=cert, host=host)
    elapsed = time.monotonic() - started
    if elapsed < 15 or elapsed > 24:
        raise RuntimeError("managed MCP command did not enforce its fixed deadline")

    _CONFIG.unlink()
    _write_config(url, ambiguous=True)
    _expect_error("a_b_c", "ambiguous_tool", cert=cert, host=host)
    if _marker_values(marker) != [
        "worker_task_context",
        "credential_reflection",
        "failing",
        "malformed_result",
        "oversized",
        "hanging",
    ]:
        raise RuntimeError("managed MCP command invoked an unselected tool")

    _CONFIG.unlink()
    _write_config(f"https://{host}:{malformed_port}/mcp")
    _expect_error(
        "worker-broker_malformed_annotations",
        "tool_not_found",
        cert=cert,
        host=host,
    )
    if _marker_values(malformed_marker):
        raise RuntimeError("managed MCP command accepted malformed tool annotations")


def main() -> None:
    if len(sys.argv) == 8 and sys.argv[1] == "--server":
        _serve(
            sys.argv[2],
            sys.argv[3],
            int(sys.argv[4]),
            Path(sys.argv[5]),
            Path(sys.argv[6]),
            Path(sys.argv[7]),
        )
        return
    if len(sys.argv) != 1:
        raise RuntimeError("invalid validation command")

    bind_host, url_host = _validation_hosts()
    port = _free_port(bind_host)
    malformed_port = _free_port(bind_host)
    while malformed_port == port:
        malformed_port = _free_port(bind_host)
    with tempfile.TemporaryDirectory(prefix="nemoclaw-read-only-mcp-") as raw_directory:
        directory = Path(raw_directory)
        cert, key = _write_certificate(directory, url_host)
        marker = directory / "calls"
        malformed_marker = directory / "malformed-calls"
        processes = [
            subprocess.Popen(
                [
                    sys.executable,
                    "-I",
                    str(Path(__file__)),
                    "--server",
                    mode,
                    bind_host,
                    str(server_port),
                    str(cert),
                    str(key),
                    str(server_marker),
                ],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            for mode, server_port, server_marker in (
                ("normal", port, marker),
                ("malformed", malformed_port, malformed_marker),
            )
        ]
        try:
            _wait_for_server(url_host, port, cert, processes[0])
            _wait_for_server(url_host, malformed_port, cert, processes[1])
            _validate(
                url_host,
                port,
                malformed_port,
                cert,
                marker,
                malformed_marker,
            )
        finally:
            if _CONFIG.exists() or _CONFIG.is_symlink():
                _CONFIG.unlink()
            for process in processes:
                process.send_signal(signal.SIGTERM)
            for process in processes:
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
        if any(
            process.returncode not in (0, -signal.SIGTERM)
            for process in processes
        ):
            raise RuntimeError("a validation MCP server did not stop cleanly")


if __name__ == "__main__":
    main()
