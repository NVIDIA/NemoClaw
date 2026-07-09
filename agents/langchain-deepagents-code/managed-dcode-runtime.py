# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# NemoClaw-managed Deep Agents Code hardening v2.
"""Runtime invariants for the NemoClaw-managed Deep Agents Code image."""

from __future__ import annotations

import errno
import fcntl
import hashlib
import ipaddress
import json
import os
import re
import stat
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlparse, urlsplit

_MANAGED_STATE_DIR = Path("/sandbox/.deepagents/.state")
_AUTH_FILE = _MANAGED_STATE_DIR / "auth.json"
_CODEX_AUTH_FILE = _MANAGED_STATE_DIR / "chatgpt-auth.json"
_MCP_CONFIG_FILE = Path("/sandbox/.deepagents/.nemoclaw-mcp.json")
_INFERENCE_BASE_URL_FILE = Path(
    "/usr/local/share/nemoclaw/dcode-inference-base-url"
)
_MANAGED_PROXY_HOST_FILE = Path(
    "/usr/local/share/nemoclaw/dcode-proxy-host"
)
_MANAGED_PROXY_PORT_FILE = Path(
    "/usr/local/share/nemoclaw/dcode-proxy-port"
)
_AUTO_APPROVAL_FILE = Path(
    "/usr/local/share/nemoclaw/dcode-auto-approval"
)
_AUTO_APPROVAL_DISABLED = "disabled"
_AUTO_APPROVAL_THREAD_OPT_IN = "thread-opt-in"
_AUTO_APPROVAL_CONTENTS = {
    b"disabled\n": _AUTO_APPROVAL_DISABLED,
    b"thread-opt-in\n": _AUTO_APPROVAL_THREAD_OPT_IN,
}
_MANAGED_FILE_OWNER_UID = 0
_CREDENTIAL_NAME = re.compile(
    r"(?:^|[_-])(?:API_KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|CREDENTIAL)$",
    re.IGNORECASE,
)
_CREDENTIAL_CAMEL_NAME = re.compile(
    r"(?:[A-Za-z0-9](?:Token|Secret|Credential|Password|Passwd|Pass)|"
    r"(?:[Aa]ccess|[Rr]efresh|[Cc]lient|[Bb]earer|[Aa]uth|[Aa][Pp][Ii]|"
    r"[Pp]rivate|[Ss]igning|[Ss]ession|[Bb]ot|[Aa]pp|[Rr]esolved)Key)$"
)
_CREDENTIAL_ENV_NAMES = {
    "LANGSMITH_RUNS_ENDPOINTS",
    "LANGCHAIN_RUNS_ENDPOINTS",
    "OTEL_EXPORTER_OTLP_HEADERS",
    "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
}
# OTLP endpoint variables carry the collector URL, not a credential. The
# documented `--observability` flow sets one (e.g.
# http://host.openshell.internal:4318), so a clean bare http(s) URL is allowed;
# a value with userinfo or a structured key-bearing blob is still refused. The
# `_HEADERS` variants stay in _CREDENTIAL_ENV_NAMES because they carry auth
# material. Mirrors dcode-wrapper.sh is_otlp_endpoint_name (#6466).
_OTLP_ENDPOINT_ENV_NAMES = {
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
}
# The only OTLP collector a managed sandbox can reach: the observability egress
# preset opens exactly this host. Restricting to it (exact match) refuses every
# other host, userinfo, query, fragment, percent-encoding, control character,
# non-ASCII byte, and malformed host/port by construction, and keeps trivial
# parity with the Bash wrapper's is_safe_otlp_endpoint_url (#6538 review).
_OTLP_MANAGED_ENDPOINT_HOST = "host.openshell.internal"
_OTLP_ENDPOINT_PORT = re.compile(r"[1-9][0-9]{0,4}")
_OTLP_ENDPOINT_PATH = re.compile(r"/[A-Za-z0-9._/-]*")
# Python's \s also includes control separators that ECMAScript excludes, so
# spell out the canonical whitespace set for cross-runtime parity.
_ECMASCRIPT_NON_WHITESPACE_SECRET_CHAR = (
    r"[^\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029"
    r"\u202f\u205f\u3000\ufeff'\"]"
)
_OPENSHELL_ENV_PLACEHOLDER_PREFIX = "openshell:resolve:env:"
_UPSTREAM_PROVIDER_ENV = "NEMOCLAW_UPSTREAM_PROVIDER"
_FETCH_URL_TRUSTED_PROXY_ENV = (
    "DEEPAGENTS_CODE_FETCH_URL_TRUSTED_PROXY_URL"
)
_MANAGED_FETCH_CA_BUNDLE_FILE = Path(
    "/etc/openshell-tls/ca-bundle.pem"
)
_MANAGED_ADAPTER_PROVIDER = "openai"
_NVIDIA_DISPLAY_PROVIDER_ALIASES = frozenset(
    {"nvidia", "nvidia-prod", "nvidia-nim", "nvidia-router"}
)
_DISPLAY_PROVIDER_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
# Match the launchers' root-owned, image-baked proxy validator. Its deliberate
# RFC 1123 deviation permits underscores only for controlled internal/container
# aliases such as `proxy_name`; the cross-boundary cases in
# test/langchain-deepagents-code-proxy-launcher.test.ts prevent validator drift.
_MANAGED_PROXY_HOST = re.compile(r"[A-Za-z0-9._-]+")
_MCP_SERVER_NAME = re.compile(r"[A-Za-z][A-Za-z0-9_-]{0,63}")
_MCP_ENV_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,127}")
_MCP_DNS_NAME = re.compile(
    r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*"
    r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
)
_MCP_NUMERIC_HOST = re.compile(
    r"(?:0x[0-9a-f]+|[0-9]+)(?:\.(?:0x[0-9a-f]+|[0-9]+))*"
)
_MCP_MAX_CONFIG_BYTES = 262_144
_MCP_MAX_SERVERS = 64
_MCP_DESCRIPTOR_PREFIX = "/proc/self/fd/"
_MCP_CHILD_BINDING_ENV = "NEMOCLAW_DCODE_MCP_BINDING"
_MCP_SEALED_KIND = "sealed-memfd"
_MCP_ANONYMOUS_KIND = "anonymous-otmpfile"
_MCP_ANONYMOUS_DIRECTORY = Path("/tmp")
_MCP_FALLBACK_ERRNOS = {
    errno.EACCES,
    errno.EINVAL,
    errno.ENOSYS,
    errno.EPERM,
}
_MCP_REQUIRED_SEALS = (
    fcntl.F_SEAL_WRITE
    | fcntl.F_SEAL_GROW
    | fcntl.F_SEAL_SHRINK
    | fcntl.F_SEAL_SEAL
)
_MCP_BLOCKED_ALIASES = {
    "host.openshell.internal",
    "host.docker.internal",
    "host.containers.internal",
}
_MCP_RESERVED_NAMES = {"localhost", "local", "internal", "metadata"}
_MCP_BLOCKED_IPV4_NETWORKS = tuple(
    ipaddress.ip_network(network)
    for network in (
        "0.0.0.0/8",
        "10.0.0.0/8",
        "100.64.0.0/10",
        "127.0.0.0/8",
        "169.254.0.0/16",
        "172.16.0.0/12",
        "192.0.0.0/24",
        "192.0.2.0/24",
        "192.31.196.0/24",
        "192.52.193.0/24",
        "192.88.99.0/24",
        "192.168.0.0/16",
        "192.175.48.0/24",
        "198.18.0.0/15",
        "198.51.100.0/24",
        "203.0.113.0/24",
        "224.0.0.0/4",
        "240.0.0.0/4",
    )
)
_MANAGED_MCP_FD: int | None = None
_MANAGED_MCP_BINDING: dict[str, int | str] | None = None
_MANAGED_MCP_CHILD_BINDING: dict[str, int | str] | None = None
_MANAGED_MCP_READY = False
# SECURITY -- Source boundary: this isolated Python runtime cannot import the
# canonical TypeScript groups in src/lib/security/secret-patterns.ts, so these
# expressions deliberately mirror their secret-shape behavior.
# Regression gate: test/langchain-deepagents-code-secret-pattern-parity.test.ts
# fingerprints all canonical groups and runs one shared positive corpus through
# both those groups and _contains_secret_shape; the Bash wrapper consumes the
# same corpus in test/langchain-deepagents-code-image-credentials.test.ts.
# Removal condition: delete this mirror only when the managed runtime can consume
# the canonical patterns directly or upstream rejects these shapes before boot.
_SECRET_PATTERNS = tuple(
    (platform, re.compile(pattern, flags))
    for platform, pattern, flags in (
        (None, r"(?:sk-proj-|sk-ant-)[A-Za-z0-9_-]{10,}", 0),
        (None, r"sk-[A-Za-z0-9_-]{20,}", 0),
        (None, r"(?:nvapi-|nvcf-|ghp_|hf_|glpat-|gsk_|pypi-|tvly-)[A-Za-z0-9_-]{10,}", 0),
        (None, r"github_pat_[A-Za-z0-9_]{30,}", 0),
        ("slack", r"xox[bpas]-[A-Za-z0-9_-]{10,}", 0),
        ("slack", r"xapp-[A-Za-z0-9_-]{10,}", 0),
        (None, r"A(?:K|S)IA[A-Z0-9]{16}", 0),
        ("telegram", r"(?:bot)?[0-9]{8,10}:[A-Za-z0-9_-]{35}", 0),
        ("discord", r"[A-Za-z0-9]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}", 0),
        (
            None,
            r"Bearer[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+[A-Za-z0-9_.+/=-]{10,}",
            re.IGNORECASE,
        ),
        (
            None,
            rf"(?:^|[^A-Za-z0-9])(?:[A-Za-z0-9]{{1,128}}_(?:KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD|PASSWD|PASS)|(?:X[-_])?API[-_]KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD|PASSWD|PASS)['\"]?(?:[ \t]{{0,32}}[=:][ \t]{{0,32}}|[ \t]{{1,32}})['\"]?{_ECMASCRIPT_NON_WHITESPACE_SECRET_CHAR}{{10,}}",
            re.IGNORECASE,
        ),
        (
            None,
            rf"(?:^|[^A-Za-z0-9])(?:[A-Za-z0-9]{{1,128}}(?:Token|Secret|Credential)|[A-Za-z0-9]{{0,128}}(?:[Aa]ccess|[Rr]efresh|[Cc]lient|[Bb]earer|[Aa]uth|[Aa][Pp][Ii]|[Pp]rivate|[Ss]igning|[Ss]ession|[Bb]ot|[Aa]pp|[Rr]esolved)Key|[A-Za-z0-9]{{1,128}}(?:Password|Passwd|Pass))['\"]?(?:[ \t]{{0,32}}[=:][ \t]{{0,32}}|[ \t]{{1,32}})['\"]?{_ECMASCRIPT_NON_WHITESPACE_SECRET_CHAR}{{10,}}",
            0,
        ),
        (
            None,
            rf"(?:^|[^A-Za-z0-9])KEY['\"]?(?:[ \t]{{0,32}}[=:][ \t]{{0,32}}|[ \t]{{1,32}})['\"]?{_ECMASCRIPT_NON_WHITESPACE_SECRET_CHAR}{{10,}}",
            0,
        ),
        (None, r"lsv2_(?:pt|sk)_[A-Za-z0-9]{10,}(?:_[A-Za-z0-9]+)*", 0),
        (None, r"-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*-----END [^-\r\n]*PRIVATE KEY-----", 0),
    )
)


def _contains_secret_shape(value: str) -> bool:
    return any(pattern.search(value) for _platform, pattern in _SECRET_PATTERNS)


def _contains_other_platform_secret(value: str, platform: str) -> bool:
    return any(
        pattern.search(value)
        for pattern_platform, pattern in _SECRET_PATTERNS
        if pattern_platform != platform
    )


def _is_openshell_placeholder_for_name(name: str, value: str) -> bool:
    if name == "OPENSHELL_TLS_KEY" or not _MCP_ENV_NAME.fullmatch(name):
        return False
    canonical = f"{_OPENSHELL_ENV_PLACEHOLDER_PREFIX}{name}"
    versioned = re.fullmatch(
        rf"{re.escape(_OPENSHELL_ENV_PLACEHOLDER_PREFIX)}v[0-9]{{1,20}}_{re.escape(name)}",
        value,
    )
    return value == canonical or versioned is not None


def _is_managed_value(name: str, value: str) -> bool:
    if name == "DEEPAGENTS_CODE_OPENAI_API_KEY":
        return value == "nemoclaw-managed-inference"
    if name == "OPENSHELL_TLS_KEY":
        return value == "/etc/openshell/tls/client/tls.key"
    if name == "SLACK_BOT_TOKEN":
        return bool(re.fullmatch(r"xoxb-[A-Za-z0-9_-]{10,}", value)) and not _contains_other_platform_secret(value, "slack")
    if name == "SLACK_APP_TOKEN":
        return bool(re.fullmatch(r"xapp-[A-Za-z0-9_-]{10,}", value)) and not _contains_other_platform_secret(value, "slack")
    if name == "TELEGRAM_BOT_TOKEN":
        return bool(re.fullmatch(r"(?:bot)?[0-9]{8,10}:[A-Za-z0-9_-]{35}", value)) and not _contains_other_platform_secret(value, "telegram")
    if name == "DISCORD_BOT_TOKEN":
        return bool(
            re.fullmatch(r"[A-Za-z0-9]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}", value)
        ) and not _contains_other_platform_secret(value, "discord")
    return False


def _is_safe_otlp_endpoint_url(value: str) -> bool:
    """Accept ONLY http(s)://host.openshell.internal[:port][/path].

    The managed sandbox's observability egress reaches only that host, so an
    exact-host allowlist refuses every other host, userinfo, query, fragment,
    percent-encoding, control character, non-ASCII byte, malformed host/port,
    and oversized input by construction. Mirrors the Bash wrapper's
    is_safe_otlp_endpoint_url byte-for-byte (#6538 review). The optional path may
    contain dot segments; that is intentional and safe because the path reaches
    only the exact managed collector host and cannot traverse to another origin.
    """
    if len(value) > 2048:
        return False
    for scheme in ("http://", "https://"):
        if value.startswith(scheme):
            rest = value[len(scheme) :]
            break
    else:
        return False
    authority, sep, path = rest.partition("/")
    if sep and not _OTLP_ENDPOINT_PATH.fullmatch("/" + path):
        return False
    host, colon, port = authority.partition(":")
    if host != _OTLP_MANAGED_ENDPOINT_HOST:
        return False
    if colon and not (_OTLP_ENDPOINT_PORT.fullmatch(port) and int(port) <= 65535):
        return False
    return True


def _assert_safe_environment() -> None:
    for name, value in os.environ.items():
        if _OPENSHELL_ENV_PLACEHOLDER_PREFIX in value:
            if _is_openshell_placeholder_for_name(name, value):
                continue
            raise RuntimeError(
                f"runtime environment variable {name} contains an invalid "
                "OpenShell credential placeholder"
            )
        if _is_managed_value(name, value):
            continue
        if _contains_secret_shape(value) or (
            len(value) >= 10
            and (
                _CREDENTIAL_NAME.search(name)
                or _CREDENTIAL_CAMEL_NAME.search(name)
            )
        ) or (
            bool(value) and name.upper() in _CREDENTIAL_ENV_NAMES
        ):
            raise RuntimeError(
                f"runtime environment variable {name} contains a credential; "
                "use NemoClaw credential handling"
            )
        if (
            name.upper() in _OTLP_ENDPOINT_ENV_NAMES
            and value
            and not _is_safe_otlp_endpoint_url(value)
        ):
            raise RuntimeError(
                f"runtime environment variable {name} contains a credential; "
                "use NemoClaw credential handling"
            )


def _assert_safe_auth_state() -> None:
    if _CODEX_AUTH_FILE.exists() or _CODEX_AUTH_FILE.is_symlink():
        raise RuntimeError(
            "chatgpt-auth.json is not allowed in a NemoClaw-managed sandbox"
        )
    if not _AUTH_FILE.exists() and not _AUTH_FILE.is_symlink():
        return
    if _AUTH_FILE.is_symlink():
        raise RuntimeError("auth.json must not be a symlink in a managed sandbox")
    try:
        data = json.loads(_AUTH_FILE.read_text(encoding="utf-8"))
    except Exception as exc:
        raise RuntimeError(
            "auth.json is unreadable or malformed in a NemoClaw-managed sandbox"
        ) from exc
    credentials = data.get("credentials") if isinstance(data, dict) else None
    if credentials:
        raise RuntimeError(
            "auth.json contains credentials; use NemoClaw credential handling"
        )


def _validate_managed_mcp_hostname(hostname: str) -> None:
    if (
        hostname != hostname.lower()
        or hostname.endswith(".")
        or hostname in _MCP_BLOCKED_ALIASES
        or hostname in _MCP_RESERVED_NAMES
        or any(
            hostname.endswith(f".{reserved}")
            for reserved in _MCP_RESERVED_NAMES
        )
    ):
        raise RuntimeError("managed MCP server URL hostname is invalid")
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        if (
            _MCP_NUMERIC_HOST.fullmatch(hostname)
            or len(hostname) > 253
            or not _MCP_DNS_NAME.fullmatch(hostname)
        ):
            raise RuntimeError("managed MCP server URL hostname is invalid")
        return
    if (
        address.version != 4
        or not address.is_global
        or any(address in network for network in _MCP_BLOCKED_IPV4_NETWORKS)
    ):
        raise RuntimeError("managed MCP server URL address is not public IPv4")


def _validate_managed_mcp_url(value: object) -> str:
    if not isinstance(value, str) or not value or len(value) > 2048:
        raise RuntimeError("managed MCP server URL is invalid")
    if (
        not value.isascii()
        or any(
            character.isspace()
            or ord(character) < 32
            or ord(character) == 127
            for character in value
        )
    ):
        raise RuntimeError(
            "managed MCP server URL must be ASCII without whitespace"
        )
    if any(
        character in value
        for character in ("%", "\\", "*", "[", "]", "{", "}", ";")
    ):
        raise RuntimeError("managed MCP server URL is not canonical")
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https"
        or not value.startswith("https://")
        or not parsed.netloc
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise RuntimeError("managed MCP server URL is invalid")
    try:
        port = parsed.port
    except ValueError as exc:
        raise RuntimeError("managed MCP server URL port is invalid") from exc
    if port is not None and not 1 <= port <= 65535:
        raise RuntimeError("managed MCP server URL port is invalid")
    hostname = parsed.hostname
    _validate_managed_mcp_hostname(hostname)
    path = parsed.path or "/"
    if (
        not path.startswith("/")
        or "//" in path
        or any(segment in {".", ".."} for segment in path.split("/"))
    ):
        raise RuntimeError("managed MCP server URL path is not canonical")
    if any(
        _contains_secret_shape(segment)
        for segment in path.split("/")
        if segment
    ):
        raise RuntimeError(
            "managed MCP server URL path contains credential-shaped data"
        )
    port_suffix = f":{port}" if port is not None and port != 443 else ""
    canonical = f"https://{hostname}{port_suffix}{path}"
    if value != canonical:
        raise RuntimeError("managed MCP server URL is not canonical")
    return canonical


def _validate_managed_mcp_entry(
    server: object, entry: object
) -> dict[str, object]:
    if not isinstance(server, str) or not _MCP_SERVER_NAME.fullmatch(server):
        raise RuntimeError("managed MCP config contains an invalid server name")
    if not isinstance(entry, dict) or set(entry) != {"type", "url", "headers"}:
        raise RuntimeError(f"managed MCP server {server} has an invalid shape")
    if entry["type"] != "http":
        raise RuntimeError(f"managed MCP server {server} must use HTTP transport")
    url = _validate_managed_mcp_url(entry["url"])
    headers = entry["headers"]
    if not isinstance(headers, dict) or set(headers) != {"Authorization"}:
        raise RuntimeError(f"managed MCP server {server} has invalid headers")
    authorization = headers["Authorization"]
    if not isinstance(authorization, str) or not authorization.startswith("Bearer "):
        raise RuntimeError(f"managed MCP server {server} has invalid authorization")
    placeholder = authorization.removeprefix("Bearer ")
    if not placeholder.startswith(_OPENSHELL_ENV_PLACEHOLDER_PREFIX):
        raise RuntimeError(f"managed MCP server {server} must use an OpenShell placeholder")
    suffix = placeholder.removeprefix(_OPENSHELL_ENV_PLACEHOLDER_PREFIX)
    match = re.fullmatch(r"(?:v[0-9]{1,20}_)?([A-Za-z_][A-Za-z0-9_]{0,127})", suffix)
    if match is None or not _is_openshell_placeholder_for_name(match.group(1), placeholder):
        raise RuntimeError(f"managed MCP server {server} has an invalid OpenShell placeholder")
    return {
        "headers": {"Authorization": authorization},
        "type": "http",
        "url": url,
    }


def _reject_duplicate_json_keys(
    pairs: list[tuple[str, object]],
) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise RuntimeError(
                "managed MCP config contains a duplicate JSON key"
            )
        result[key] = value
    return result


def _reject_non_json_constant(value: str) -> None:
    raise RuntimeError(
        f"managed MCP config contains invalid JSON constant {value}"
    )


def _read_managed_mcp_config() -> bytes | None:
    flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK
    try:
        descriptor = os.open(_MCP_CONFIG_FILE, flags)
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise RuntimeError(
            "managed MCP config is unreadable or unsafe"
        ) from exc
    try:
        before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_nlink != 1
            or before.st_uid != os.getuid()
            or stat.S_IMODE(before.st_mode) != 0o600
            or before.st_size <= 0
            or before.st_size > _MCP_MAX_CONFIG_BYTES
        ):
            raise RuntimeError(
                "managed MCP config has unsafe ownership or mode or invalid size"
            )
        chunks: list[bytes] = []
        total = 0
        while total <= _MCP_MAX_CONFIG_BYTES:
            chunk = os.read(
                descriptor,
                min(65_536, _MCP_MAX_CONFIG_BYTES + 1 - total),
            )
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
        raw = b"".join(chunks)
        after = os.fstat(descriptor)
    except OSError as exc:
        raise RuntimeError("managed MCP config is unreadable") from exc
    finally:
        os.close(descriptor)
    stable_fields = (
        "st_dev",
        "st_ino",
        "st_mode",
        "st_nlink",
        "st_uid",
        "st_gid",
        "st_size",
        "st_mtime_ns",
        "st_ctime_ns",
    )
    if (
        len(raw) != before.st_size
        or len(raw) > _MCP_MAX_CONFIG_BYTES
        or any(
            getattr(before, field) != getattr(after, field)
            for field in stable_fields
        )
    ):
        raise RuntimeError(
            "managed MCP config changed while it was being validated"
        )
    return raw


def _canonicalize_managed_mcp_config(raw: bytes) -> bytes | None:
    try:
        data = json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=_reject_duplicate_json_keys,
            parse_constant=_reject_non_json_constant,
        )
    except Exception as exc:
        if isinstance(exc, RuntimeError):
            raise
        raise RuntimeError("managed MCP config is malformed") from exc
    if not isinstance(data, dict) or set(data) != {"mcpServers"}:
        raise RuntimeError("managed MCP config must contain only mcpServers")
    servers = data["mcpServers"]
    if not isinstance(servers, dict) or len(servers) > _MCP_MAX_SERVERS:
        raise RuntimeError("managed MCP config has an invalid server map")
    if not servers:
        return None
    canonical_servers = {
        server: _validate_managed_mcp_entry(server, servers[server])
        for server in sorted(servers)
    }
    canonical = {"mcpServers": canonical_servers}
    return (
        json.dumps(
            canonical,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
        )
        + "\n"
    ).encode("utf-8")


def _validate_sealed_managed_mcp_descriptor(
    descriptor: int,
    *,
    expected_size: int | None,
    unavailable_message: str,
    invalid_message: str,
) -> None:
    """Require one bounded, regular, completely sealed managed MCP memfd."""
    try:
        metadata = os.fstat(descriptor)
        seals = fcntl.fcntl(descriptor, fcntl.F_GET_SEALS)
    except OSError as exc:
        raise RuntimeError(unavailable_message) from exc
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_size <= 0
        or metadata.st_size > _MCP_MAX_CONFIG_BYTES
        or (expected_size is not None and metadata.st_size != expected_size)
        or seals != _MCP_REQUIRED_SEALS
    ):
        raise RuntimeError(invalid_message)


def is_managed_mcp_config_path(value: object) -> bool:
    """Return whether a value is a canonical process-local descriptor path."""
    if not isinstance(value, str) or not value.startswith(_MCP_DESCRIPTOR_PREFIX):
        return False
    descriptor_text = value.removeprefix(_MCP_DESCRIPTOR_PREFIX)
    return (
        descriptor_text.isascii()
        and descriptor_text.isdecimal()
        and str(int(descriptor_text)) == descriptor_text
    )


def _managed_mcp_descriptor(path: str) -> int:
    descriptor_text = path.removeprefix(_MCP_DESCRIPTOR_PREFIX)
    if not is_managed_mcp_config_path(path):
        raise RuntimeError("managed MCP config path is not a canonical descriptor")
    return int(descriptor_text)


def _validate_managed_mcp_binding(
    value: object,
) -> dict[str, int | str]:
    fields = {"fd", "dev", "ino", "size", "sha256", "kind"}
    if not isinstance(value, dict) or set(value) != fields:
        raise RuntimeError("managed MCP child descriptor binding is invalid")
    integers = (value["fd"], value["dev"], value["ino"], value["size"])
    if any(type(item) is not int or item < 0 for item in integers):
        raise RuntimeError("managed MCP child descriptor binding is invalid")
    if value["size"] <= 0 or value["size"] > _MCP_MAX_CONFIG_BYTES:
        raise RuntimeError("managed MCP child descriptor binding is invalid")
    if value["kind"] not in {_MCP_SEALED_KIND, _MCP_ANONYMOUS_KIND}:
        raise RuntimeError("managed MCP child descriptor binding is invalid")
    digest = value["sha256"]
    if not isinstance(digest, str) or re.fullmatch(r"[0-9a-f]{64}", digest) is None:
        raise RuntimeError("managed MCP child descriptor binding is invalid")
    return value


def _managed_mcp_child_binding() -> dict[str, int | str]:
    global _MANAGED_MCP_CHILD_BINDING  # noqa: PLW0603
    if _MANAGED_MCP_CHILD_BINDING is not None:
        return _MANAGED_MCP_CHILD_BINDING
    raw = os.environ.pop(_MCP_CHILD_BINDING_ENV, None)
    if raw is None:
        raise RuntimeError("managed MCP child descriptor binding is unavailable")
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError) as exc:
        raise RuntimeError("managed MCP child descriptor binding is invalid") from exc
    _MANAGED_MCP_CHILD_BINDING = _validate_managed_mcp_binding(parsed)
    return _MANAGED_MCP_CHILD_BINDING


def _validate_bound_managed_mcp_descriptor(
    descriptor: int,
    binding: dict[str, int | str],
) -> os.stat_result:
    try:
        metadata = os.fstat(descriptor)
        access_mode = fcntl.fcntl(descriptor, fcntl.F_GETFL) & os.O_ACCMODE
    except OSError as exc:
        raise RuntimeError("managed MCP config descriptor is unavailable") from exc
    if (
        not stat.S_ISREG(metadata.st_mode)
        or descriptor != binding["fd"]
        or metadata.st_dev != binding["dev"]
        or metadata.st_ino != binding["ino"]
        or metadata.st_size != binding["size"]
        or metadata.st_uid != os.getuid()
    ):
        raise RuntimeError("managed MCP config descriptor binding changed")
    if binding["kind"] == _MCP_SEALED_KIND:
        _validate_sealed_managed_mcp_descriptor(
            descriptor,
            expected_size=int(binding["size"]),
            unavailable_message="managed MCP config descriptor is unavailable",
            invalid_message="managed MCP config descriptor is not sealed",
        )
    elif (
        metadata.st_nlink != 0
        or stat.S_IMODE(metadata.st_mode) != 0
        or access_mode != os.O_RDONLY
    ):
        raise RuntimeError("managed MCP anonymous descriptor is not read-only")
    return metadata


def _read_bound_managed_mcp_descriptor(
    descriptor: int,
    binding: dict[str, int | str],
) -> bytes:
    before = _validate_bound_managed_mcp_descriptor(descriptor, binding)
    expected_size = int(binding["size"])
    chunks: list[bytes] = []
    offset = 0
    try:
        while offset < expected_size:
            chunk = os.pread(descriptor, min(65_536, expected_size - offset), offset)
            if not chunk:
                break
            chunks.append(chunk)
            offset += len(chunk)
        extra = os.pread(descriptor, 1, expected_size)
    except OSError as exc:
        raise RuntimeError("managed MCP config descriptor is unreadable") from exc
    raw = b"".join(chunks)
    after = _validate_bound_managed_mcp_descriptor(descriptor, binding)
    stable_fields = (
        "st_dev",
        "st_ino",
        "st_mode",
        "st_nlink",
        "st_uid",
        "st_gid",
        "st_size",
        "st_mtime_ns",
        "st_ctime_ns",
    )
    if (
        len(raw) != expected_size
        or extra
        or any(
            getattr(before, field) != getattr(after, field)
            for field in stable_fields
        )
        or hashlib.sha256(raw).hexdigest() != binding["sha256"]
    ):
        raise RuntimeError("managed MCP config descriptor contents changed")
    return raw


def managed_mcp_config_bytes(config_path: str) -> bytes | None:
    """Read and verify a managed descriptor; leave ordinary paths upstream."""
    if not isinstance(config_path, str) or not config_path.startswith(
        _MCP_DESCRIPTOR_PREFIX
    ):
        return None
    descriptor = _managed_mcp_descriptor(config_path)
    if _MANAGED_MCP_READY:
        binding = _MANAGED_MCP_BINDING
        if (
            _MANAGED_MCP_FD is None
            or binding is None
            or descriptor != _MANAGED_MCP_FD
        ):
            raise RuntimeError(
                "managed MCP config descriptor is not process-local"
            )
    else:
        binding = _managed_mcp_child_binding()
    if config_path != f"{_MCP_DESCRIPTOR_PREFIX}{binding['fd']}":
        raise RuntimeError("managed MCP config descriptor binding does not match")
    return _read_bound_managed_mcp_descriptor(descriptor, binding)


def managed_mcp_server_binding(path: str) -> tuple[int, str]:
    """Validate and serialize the exact snapshot inherited by a server child."""
    descriptor = _managed_mcp_descriptor(path)
    if (
        not _MANAGED_MCP_READY
        or _MANAGED_MCP_FD is None
        or _MANAGED_MCP_BINDING is None
        or descriptor != _MANAGED_MCP_FD
        or path != f"{_MCP_DESCRIPTOR_PREFIX}{_MANAGED_MCP_FD}"
    ):
        raise RuntimeError(
            "managed MCP server config descriptor is not process-local"
        )
    managed_mcp_config_bytes(path)
    return descriptor, json.dumps(
        _MANAGED_MCP_BINDING,
        sort_keys=True,
        separators=(",", ":"),
    )


def managed_mcp_server_descriptor(path: str) -> int:
    """Validate the exact descriptor inherited by a managed server child."""
    descriptor, _binding = managed_mcp_server_binding(path)
    return descriptor


def _sealed_managed_mcp_snapshot(payload: bytes) -> int:
    try:
        descriptor = os.memfd_create(
            "nemoclaw-dcode-mcp",
            flags=os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING,
        )
    except (AttributeError, OSError) as exc:
        raise RuntimeError(
            "managed MCP config requires Linux sealed memfd support"
        ) from exc
    try:
        remaining = memoryview(payload)
        while remaining:
            written = os.write(descriptor, remaining)
            if written <= 0:
                raise RuntimeError(
                    "could not write managed MCP config snapshot"
                )
            remaining = remaining[written:]
        try:
            fcntl.fcntl(descriptor, fcntl.F_ADD_SEALS, _MCP_REQUIRED_SEALS)
        except OSError as exc:
            raise RuntimeError(
                "managed MCP config snapshot could not be sealed"
            ) from exc
        _validate_sealed_managed_mcp_descriptor(
            descriptor,
            expected_size=len(payload),
            unavailable_message="managed MCP config snapshot could not be sealed",
            invalid_message="managed MCP config snapshot could not be sealed",
        )
        os.lseek(descriptor, 0, os.SEEK_SET)
        return descriptor
    except Exception:
        os.close(descriptor)
        raise


def _anonymous_managed_mcp_snapshot(payload: bytes) -> int:
    writer: int | None = None
    reader: int | None = None
    complete = False
    try:
        flags = os.O_TMPFILE | os.O_EXCL | os.O_RDWR | os.O_CLOEXEC
        writer = os.open(_MCP_ANONYMOUS_DIRECTORY, flags, 0o600)
        remaining = memoryview(payload)
        while remaining:
            written = os.write(writer, remaining)
            if written <= 0:
                raise RuntimeError(
                    "could not write managed MCP config snapshot"
                )
            remaining = remaining[written:]
        os.fsync(writer)
        reader = os.open(
            f"{_MCP_DESCRIPTOR_PREFIX}{writer}",
            os.O_RDONLY | os.O_CLOEXEC,
        )
        writer_metadata = os.fstat(writer)
        reader_metadata = os.fstat(reader)
        if (
            writer_metadata.st_dev != reader_metadata.st_dev
            or writer_metadata.st_ino != reader_metadata.st_ino
            or reader_metadata.st_size != len(payload)
        ):
            raise RuntimeError("managed MCP anonymous descriptor binding changed")
        os.fchmod(writer, 0)
        os.close(writer)
        writer = None
        complete = True
        return reader
    except AttributeError as exc:
        raise RuntimeError(
            "managed MCP config requires anonymous O_TMPFILE support"
        ) from exc
    except OSError as exc:
        raise RuntimeError(
            "managed MCP config requires anonymous O_TMPFILE support"
        ) from exc
    finally:
        if writer is not None:
            try:
                os.close(writer)
            except OSError:
                # Best-effort teardown must not replace the primary result or error.
                pass
        if reader is not None and not complete:
            try:
                os.close(reader)
            except OSError:
                # Best-effort teardown must not replace the primary result or error.
                pass


def _managed_mcp_fallback_allowed(exc: BaseException) -> bool:
    current: BaseException | None = exc
    while current is not None:
        if isinstance(current, AttributeError):
            return True
        if isinstance(current, OSError):
            return current.errno in _MCP_FALLBACK_ERRNOS
        current = current.__cause__
    return False


def _managed_mcp_binding(
    descriptor: int,
    payload: bytes,
    kind: str,
) -> dict[str, int | str]:
    metadata = os.fstat(descriptor)
    binding: dict[str, int | str] = {
        "fd": descriptor,
        "dev": metadata.st_dev,
        "ino": metadata.st_ino,
        "size": len(payload),
        "sha256": hashlib.sha256(payload).hexdigest(),
        "kind": kind,
    }
    return _validate_managed_mcp_binding(binding)


def _managed_mcp_snapshot(
    payload: bytes,
) -> tuple[int, dict[str, int | str]]:
    try:
        descriptor = _sealed_managed_mcp_snapshot(payload)
        kind = _MCP_SEALED_KIND
    except RuntimeError as exc:
        if not _managed_mcp_fallback_allowed(exc):
            raise
        descriptor = _anonymous_managed_mcp_snapshot(payload)
        kind = _MCP_ANONYMOUS_KIND
    try:
        binding = _managed_mcp_binding(descriptor, payload, kind)
        if _read_bound_managed_mcp_descriptor(descriptor, binding) != payload:
            raise RuntimeError("managed MCP config snapshot changed")
        return descriptor, binding
    except Exception:
        os.close(descriptor)
        raise


def managed_mcp_config_path() -> str | None:
    """Return an integrity-bound process-local snapshot of managed MCP state."""
    global _MANAGED_MCP_BINDING, _MANAGED_MCP_FD, _MANAGED_MCP_READY  # noqa: PLW0603
    if _MANAGED_MCP_READY:
        if _MANAGED_MCP_FD is None:
            return None
        return f"/proc/self/fd/{_MANAGED_MCP_FD}"

    raw = _read_managed_mcp_config()
    if raw is None:
        _MANAGED_MCP_READY = True
        return None
    canonical = _canonicalize_managed_mcp_config(raw)
    if canonical is None:
        _MANAGED_MCP_READY = True
        return None
    _MANAGED_MCP_FD, _MANAGED_MCP_BINDING = _managed_mcp_snapshot(canonical)
    _MANAGED_MCP_READY = True
    return f"{_MCP_DESCRIPTOR_PREFIX}{_MANAGED_MCP_FD}"


def managed_inference_base_url() -> str:
    """Read and validate the root-owned inference route baked into the image."""
    path = _INFERENCE_BASE_URL_FILE
    if not path.is_file() or path.is_symlink():
        raise RuntimeError("managed inference base URL file is missing or unsafe")
    try:
        metadata = path.stat()
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise RuntimeError("managed inference base URL file is unreadable") from exc
    if (
        metadata.st_uid != _MANAGED_FILE_OWNER_UID
        or stat.S_IMODE(metadata.st_mode) != 0o444
    ):
        raise RuntimeError("managed inference base URL file has unsafe ownership or mode")
    value = raw.rstrip("\n")
    if not value or len(value) > 2048 or raw not in {value, f"{value}\n"}:
        raise RuntimeError("managed inference base URL file has invalid contents")
    if value != value.strip() or any(ord(character) < 32 for character in value):
        raise RuntimeError("managed inference base URL file has invalid contents")
    parsed = urlparse(value)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise RuntimeError("managed inference base URL is invalid")
    return value


def managed_fetch_proxy_url() -> str | None:
    """Return the explicit OpenShell proxy delegated to managed ``fetch_url``.

    The variable is absent when this helper is imported outside the managed
    launcher, in which case the upstream direct DNS-pinning transport remains
    authoritative. When present, every conventional HTTP(S) proxy variable
    must carry the same launcher-derived value. This prevents a mutable ambient
    proxy or ``NO_PROXY`` rule from silently replacing the root-owned route.
    """
    value = os.environ.get(_FETCH_URL_TRUSTED_PROXY_ENV)
    if value is None:
        return None
    expected_proxy_url = _managed_fetch_proxy_url_from_files()
    if (
        not value
        or len(value) > 2048
        or value != value.strip()
        or any(ord(character) < 32 for character in value)
    ):
        raise RuntimeError("managed fetch URL proxy is invalid")
    try:
        parsed = urlparse(value)
        port = parsed.port
    except ValueError as exc:
        raise RuntimeError("managed fetch URL proxy is invalid") from exc
    if (
        parsed.scheme != "http"
        or not parsed.hostname
        or port is None
        or port < 1
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.params
        or parsed.query
        or parsed.fragment
        or _MANAGED_PROXY_HOST.fullmatch(parsed.hostname) is None
    ):
        raise RuntimeError("managed fetch URL proxy is invalid")
    if value != expected_proxy_url:
        raise RuntimeError(
            "managed fetch URL proxy does not match root-owned proxy"
        )
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
        if os.environ.get(name) != value:
            raise RuntimeError("managed fetch URL proxy does not match runtime proxy")
    return value


def _read_managed_proxy_value(path: Path, label: str) -> str:
    """Read one immutable proxy component from the managed image."""
    if not path.is_file() or path.is_symlink():
        raise RuntimeError(f"managed proxy {label} file is missing or unsafe")
    try:
        metadata = path.stat()
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise RuntimeError(f"managed proxy {label} file is unreadable") from exc
    if (
        metadata.st_uid != _MANAGED_FILE_OWNER_UID
        or stat.S_IMODE(metadata.st_mode) != 0o444
    ):
        raise RuntimeError(
            f"managed proxy {label} file has unsafe ownership or mode"
        )
    value = raw.rstrip("\n")
    if (
        not value
        or len(value) > 2048
        or raw not in {value, f"{value}\n"}
        or value != value.strip()
        or any(ord(character) < 32 for character in value)
    ):
        raise RuntimeError(f"managed proxy {label} file has invalid contents")
    return value


def _managed_fetch_proxy_url_from_files() -> str:
    """Derive the trusted proxy URL independently from root-owned files."""
    host = _read_managed_proxy_value(_MANAGED_PROXY_HOST_FILE, "host")
    port = _read_managed_proxy_value(_MANAGED_PROXY_PORT_FILE, "port")
    if _MANAGED_PROXY_HOST.fullmatch(host) is None:
        raise RuntimeError("managed proxy host file has invalid contents")
    if (
        re.fullmatch(r"[0-9]{1,5}", port) is None
        or not 1 <= int(port, 10) <= 65535
    ):
        raise RuntimeError("managed proxy port file has invalid contents")
    return f"http://{host}:{port}"


def _managed_fetch_ca_bundle() -> tuple[int, str]:
    """Open and validate fixed OpenShell TLS trust without a pathname race."""
    path = _MANAGED_FETCH_CA_BUNDLE_FILE
    no_follow = getattr(os, "O_NOFOLLOW", None)
    if no_follow is None:
        raise RuntimeError("managed fetch CA bundle is invalid")
    flags = os.O_RDONLY | no_follow | getattr(os, "O_CLOEXEC", 0)
    try:
        descriptor = os.open(path, flags)
    except FileNotFoundError:
        raise RuntimeError("managed fetch CA bundle is unavailable") from None
    except OSError:
        raise RuntimeError("managed fetch CA bundle is invalid") from None

    try:
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != _MANAGED_FILE_OWNER_UID
            or stat.S_IMODE(metadata.st_mode) & 0o022
            or metadata.st_size <= 0
        ):
            raise RuntimeError("managed fetch CA bundle is invalid")
        descriptor_path = next(
            (
                candidate
                for root in ("/proc/self/fd", "/dev/fd")
                if os.path.exists(candidate := f"{root}/{descriptor}")
            ),
            None,
        )
        if descriptor_path is None:
            raise RuntimeError("managed fetch CA bundle is invalid")
        return descriptor, descriptor_path
    except OSError:
        os.close(descriptor)
        raise RuntimeError("managed fetch CA bundle is invalid") from None
    except RuntimeError:
        os.close(descriptor)
        raise


def _close_managed_fetch_ca_bundle(descriptor: int) -> None:
    try:
        os.close(descriptor)
    except OSError:
        # Closing the read-only trust snapshot cannot expand authority.
        pass


def _rewind_managed_fetch_ca_bundle(descriptor: int) -> None:
    """Reset fd-backed trust before each synchronous transport read."""
    try:
        os.lseek(descriptor, 0, os.SEEK_SET)
    except OSError:
        raise RuntimeError("managed fetch CA bundle is invalid") from None


def managed_fetch_with_redirects(
    url: str,
    *,
    timeout: int,
    max_redirects: int,
    original_fetch: Callable[..., Any],
    validation_error: type[ValueError],
) -> Any:
    """Fetch through only the launcher-delegated OpenShell proxy.

    Outside the managed launcher, preserve the pinned upstream transport. In
    the managed image, avoid forbidden direct DNS while keeping requests'
    ambient proxy discovery and ``NO_PROXY`` disabled. OpenShell's proxy then
    remains the authoritative network-policy and SSRF boundary for every hop.
    """
    try:
        proxy_url = managed_fetch_proxy_url()
    except RuntimeError as exc:
        # Keep runtime-integrity failures inside fetch_url's structured
        # validation result instead of surfacing an opaque tool exception.
        raise validation_error(str(exc)) from exc
    if proxy_url is None:
        return original_fetch(url, timeout=timeout)

    try:
        import requests
    except ImportError:
        # Keep an optional dependency failure inside fetch_url's structured
        # validation result without exposing import paths or stack details.
        raise validation_error(
            "managed fetch transport dependency is unavailable"
        ) from None
    try:
        ca_descriptor, ca_bundle = _managed_fetch_ca_bundle()
    except RuntimeError as exc:
        raise validation_error(str(exc)) from None

    def validate_url(candidate: str) -> None:
        try:
            parsed = urlparse(candidate)
            hostname = parsed.hostname
            # Force malformed ports through the same structured validation path
            # even though requests, rather than this helper, uses the value.
            _ = parsed.port
        except ValueError as exc:
            raise validation_error("URL is malformed") from exc
        if parsed.scheme not in {"http", "https"}:
            raise validation_error(
                f"URL scheme not allowed: {parsed.scheme!r} (must be http or https)"
            )
        if not hostname:
            raise validation_error("URL is missing a hostname")
        # RFC 3986 credentials are authority userinfo, exposed by username and
        # password. An `@` or `:` after the authority is ordinary path data
        # (including valid repository refs/files), never authentication;
        # rejecting that shape would create false positives. These validation
        # errors never echo the candidate URL, and the explicit OpenShell proxy
        # remains the destination-policy and SSRF authority for every hop.
        if parsed.username is not None or parsed.password is not None:
            raise validation_error("URL credentials are not allowed")
        try:
            hostname.encode("idna").decode("ascii")
        except UnicodeError:
            raise validation_error("URL hostname is not valid IDNA") from None

    current_url = url
    proxies = {"http": proxy_url, "https": proxy_url}
    try:
        with requests.Session() as session:
            # Disable every requests environment-derived session setting, including
            # proxy/NO_PROXY, netrc, and CA-bundle discovery. Each request receives
            # the sole root-verified proxy mapping explicitly below. The separately
            # selected CA bundle establishes TLS transport trust only; it cannot
            # choose a proxy or authorize a destination under OpenShell policy.
            session.trust_env = False
            for _hop in range(max_redirects + 1):
                validate_url(current_url)
                try:
                    _rewind_managed_fetch_ca_bundle(ca_descriptor)
                except RuntimeError as exc:
                    raise validation_error(str(exc)) from None
                response = session.get(
                    current_url,
                    timeout=timeout,
                    headers={"User-Agent": "Mozilla/5.0 (compatible; DeepAgents/1.0)"},
                    allow_redirects=False,
                    proxies=proxies,
                    verify=ca_bundle,
                )
                if 300 <= response.status_code < 400:
                    location = response.headers.get("Location")
                    if not location:
                        raise validation_error(
                            f"Redirect response (status {response.status_code}) is missing a Location header"
                        )
                    current_url = urljoin(current_url, location)
                    continue
                response.raise_for_status()
                return response

        raise requests.exceptions.TooManyRedirects(
            f"Exceeded {max_redirects} redirects"
        )
    finally:
        _close_managed_fetch_ca_bundle(ca_descriptor)


def _disabled_auto_approval(reason: str) -> str:
    if os.environ.get("NEMOCLAW_DEBUG") == "1":
        print(
            f"NemoClaw managed auto-approval disabled: {reason}",
            file=sys.stderr,
        )
    return _AUTO_APPROVAL_DISABLED


def managed_auto_approval_mode() -> str:
    """Return the trusted managed auto-approval mode, failing closed."""
    # The image build owns this file, but runtime must tolerate missing or
    # malformed image state and fail closed. Keep this check until sandbox
    # images are immutable end to end; direct-module tests pin rejected shapes.
    path = _AUTO_APPROVAL_FILE
    try:
        if path.is_symlink():
            return _disabled_auto_approval("capability path is a symlink")
        flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
        flags |= getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags)
    except OSError:
        return _disabled_auto_approval("capability file is missing or unreadable")

    try:
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != _MANAGED_FILE_OWNER_UID
            or stat.S_IMODE(metadata.st_mode) != 0o444
            or metadata.st_size not in {
                len(content) for content in _AUTO_APPROVAL_CONTENTS
            }
        ):
            return _disabled_auto_approval("capability metadata is unsafe")

        chunks: list[bytes] = []
        remaining = metadata.st_size
        while remaining:
            chunk = os.read(descriptor, remaining)
            if not chunk:
                return _disabled_auto_approval("capability file was truncated")
            chunks.append(chunk)
            remaining -= len(chunk)
        if os.read(descriptor, 1):
            return _disabled_auto_approval("capability file changed while reading")
    except OSError:
        return _disabled_auto_approval("capability file read failed")
    finally:
        try:
            os.close(descriptor)
        except OSError:
            # Cleanup cannot weaken the fail-closed capability result.
            pass

    return _AUTO_APPROVAL_CONTENTS.get(b"".join(chunks)) or _disabled_auto_approval(
        "capability contents are invalid"
    )


def managed_auto_approval_enabled() -> bool:
    """Return whether thread-scoped auto-approval may be explicitly enabled."""
    return managed_auto_approval_mode() == _AUTO_APPROVAL_THREAD_OPT_IN


def managed_display_provider(adapter_provider: object) -> str:
    """Return the provider label to show for the managed inference adapter.

    Managed inference always routes through the OpenAI-compatible adapter, so
    Deep Agents Code reports the wire provider (`openai`) in the status bar and
    the model-identity system prompt. Substitute the onboard-selected upstream
    provider so those surfaces match the launch page. Only the managed
    ``openai`` adapter is relabeled; every other adapter is returned unchanged.
    NVIDIA route aliases share the canonical ``nvidia`` display family.
    """
    adapter = adapter_provider if isinstance(adapter_provider, str) else ""
    if adapter != _MANAGED_ADAPTER_PROVIDER:
        return adapter

    upstream = os.environ.get(_UPSTREAM_PROVIDER_ENV, "")
    if _DISPLAY_PROVIDER_NAME.fullmatch(upstream) is None:
        return adapter
    if upstream in _NVIDIA_DISPLAY_PROVIDER_ALIASES:
        return "nvidia"
    return upstream


def assert_safe_runtime() -> None:
    """Reject unmanaged runtime credentials before dcode bootstraps settings."""
    _assert_safe_environment()
    _assert_safe_auth_state()
    managed_fetch_proxy_url()
    base_url = managed_inference_base_url()
    os.environ["OPENAI_BASE_URL"] = base_url
    os.environ["NEMOCLAW_INFERENCE_BASE_URL"] = base_url
    os.environ["LANGGRAPH_NO_VERSION_CHECK"] = "true"
    # LangGraph CLI otherwise posts command analytics to a third-party
    # Supabase collector. Managed sandboxes keep that optional egress closed.
    os.environ["LANGGRAPH_CLI_NO_ANALYTICS"] = "1"
    os.environ["OTEL_ENABLED"] = "false"
    for name in (
        "OPENAI_PROXY",
        "OTEL_EXPORTER_OTLP_ENDPOINT",
        "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
        "OTEL_EXPORTER_OTLP_HEADERS",
        "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
    ):
        os.environ.pop(name, None)
