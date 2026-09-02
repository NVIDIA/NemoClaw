#!/opt/hermes/.venv/bin/python
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Transactional Hermes MCP config mutation and gateway reload control.

This helper never proxies MCP traffic and never handles raw service
credentials. NemoClaw invokes it as a one-shot ordinary OpenShell sandbox exec
command in the Hermes sandbox namespaces. No persistent control listener or
host-side MCP data-plane process is exposed.

Pinned Hermes exposes interactive ``hermes mcp add/remove/list`` commands, but
they prompt, write service credentials into Hermes-owned environment state, and
do not provide NemoClaw's noninteractive ownership/hash transaction with an
acknowledged managed gateway reload/restart (https://github.com/NousResearch/hermes-agent/issues/690
and https://github.com/NousResearch/hermes-agent/issues/52417). Direct config
edits would therefore expose a partial-write/reload race and violate the
OpenShell provider boundary. This helper owns the atomic write, ownership
checks, and reload acknowledgement instead; hermes-mcp-config-transaction.test.ts
locks that contract. Remove it when the minimum supported Hermes capability
provides equivalent noninteractive mutation, credential isolation, ownership,
and acknowledged reload guarantees.
"""

from __future__ import annotations

import argparse
import http.client
import importlib.util
import ipaddress
import json
import logging
import os
import grp
import pwd
import re
import signal
import stat
import sys
import time
import unicodedata
from pathlib import Path
from types import ModuleType
from urllib.parse import urlsplit

import yaml


CONFIG_PATH = "/sandbox/.hermes/config.yaml"
HERMES_DIR = "/sandbox/.hermes"
GATEWAY_PID_PATH = f"{HERMES_DIR}/runtime/gateway.pid"
STRICT_HASH_PATH = "/etc/nemoclaw/hermes.config-hash"
GUARD_PATH = "/usr/local/lib/nemoclaw/hermes-runtime-config-guard.py"
ROOT_LIFECYCLE_MARKER = "/run/nemoclaw/hermes-root-lifecycle"
GATEWAY_PUBLIC_PORT_PATH = "/run/nemoclaw/hermes-api-port"
SERVICE_MANAGER_PATH = b"/usr/local/bin/nemoclaw-start"
RELOAD_TIMEOUT_SECONDS = 300
SERVER_NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")
MCP_DNS_LABEL_RE = re.compile(
    r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$"
)
MCP_ROUTED_PRIVATE_IPV4_NETWORKS = tuple(
    ipaddress.ip_network(cidr)
    for cidr in (
        "10.0.0.0/8",
        "100.64.0.0/10",
        "172.16.0.0/12",
        "192.168.0.0/16",
    )
)
ENV_PLACEHOLDER_RE = re.compile(
    r"^Bearer openshell:resolve:env:([A-Za-z_][A-Za-z0-9_]{0,127})$"
)
REVISIONED_ENV_PLACEHOLDER_RE = re.compile(
    r"^Bearer openshell:resolve:env:(v[0-9]{1,20})_([A-Za-z_][A-Za-z0-9_]{0,127})$"
)
OPENSHELL_REVISIONED_CREDENTIAL_NAME_RE = re.compile(r"^v[0-9]+_[A-Za-z0-9_]+$")
BOUNDARY_MANIFEST_NAME = "openshell-child-visible-credentials.v0.0.106.json"
ANSI_ESCAPE_RE = re.compile(
    r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[@-_])"
)
AUTHORIZATION_FIELD_RE = re.compile(
    r"(?i)((?:[\"']?authorization[\"']?)\s*[:=]\s*)[^;}\]]+"
)
BEARER_VALUE_RE = re.compile(r"(?i)(\bBearer\s+)[^;}\]]+")
SENSITIVE_ASSIGNMENT_RE = re.compile(
    r"(?i)((?:[\"']?(?:api[_-]?key|token|secret|password|credential)[\"']?)"
    r"\s*[:=]\s*)[^;}\]]+"
)
URL_USERINFO_RE = re.compile(r"(?i)(https?://)[^/@\s]+@")
SENSITIVE_QUERY_RE = re.compile(
    r"(?i)([?&](?:api[_-]?key|token|secret|password|credential|auth)\s*=)[^&#\s]+"
)
SENSITIVE_PAYLOAD_KEY_RE = re.compile(
    r"(?i)(?:authorization|bearer|api[_-]?key|token|secret|password|credential)"
)
MAX_ERROR_MESSAGE_LENGTH = 512
MAX_GATEWAY_PID_RECORD_BYTES = 4096
MCP_RACE_RECOVERY_ATTEMPTS = 3
MAX_GATEWAY_PUBLIC_PORT_RECORD_BYTES = 16
GATEWAY_INTERNAL_PORT = 18642
GATEWAY_NOT_READY_MESSAGE = "Hermes gateway is not running for managed MCP reload"
MANAGED_API_RELAY_TARGET = f"TCP:127.0.0.1:{GATEWAY_INTERNAL_PORT}".encode()
MANAGED_API_RELAY_PROCESS_NAME = b"socat"
MANAGED_API_RELAY_LISTEN_PREFIX = b"TCP-LISTEN:"
MANAGED_API_RELAY_LISTEN_SUFFIX = b",bind=0.0.0.0,fork,reuseaddr"


def _parse_gateway_public_port(raw: str) -> int:
    """Parse one allocated Hermes API port."""
    if re.fullmatch(r"[0-9]+", raw) is None:
        raise PermissionError("Hermes API port is malformed")
    try:
        port = int(raw, 10)
    except ValueError as error:
        raise PermissionError("Hermes API port is malformed") from error
    if not 8642 <= port <= 8652:
        raise PermissionError("Hermes API port is outside the allocated range")
    return port


def _root_gateway_public_port_marker() -> int | None:
    """Read the root-owned API-port marker without following links."""
    no_follow = getattr(os, "O_NOFOLLOW", 0)
    if not no_follow:
        raise PermissionError("Hermes API port marker cannot be opened safely")
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | no_follow

    try:
        descriptor = os.open(GATEWAY_PUBLIC_PORT_PATH, flags)
    except FileNotFoundError:
        return None
    except OSError as error:
        raise PermissionError(
            "Hermes API port marker cannot be opened safely"
        ) from error

    try:
        before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_uid != 0
            or before.st_gid != 0
            or stat.S_IMODE(before.st_mode) != 0o444
            or before.st_nlink != 1
            or before.st_size <= 0
            or before.st_size > MAX_GATEWAY_PUBLIC_PORT_RECORD_BYTES
        ):
            raise PermissionError("Hermes API port marker is unsafe")
        raw = os.read(descriptor, MAX_GATEWAY_PUBLIC_PORT_RECORD_BYTES + 1)
        after = os.fstat(descriptor)
        if (
            len(raw) != before.st_size
            or len(raw) > MAX_GATEWAY_PUBLIC_PORT_RECORD_BYTES
            or (
                before.st_dev,
                before.st_ino,
                before.st_mode,
                before.st_uid,
                before.st_gid,
                before.st_nlink,
                before.st_size,
                before.st_mtime_ns,
                before.st_ctime_ns,
            )
            != (
                after.st_dev,
                after.st_ino,
                after.st_mode,
                after.st_uid,
                after.st_gid,
                after.st_nlink,
                after.st_size,
                after.st_mtime_ns,
                after.st_ctime_ns,
            )
        ):
            raise PermissionError("Hermes API port marker changed while reading")
    finally:
        os.close(descriptor)

    try:
        decoded = raw.decode("ascii").strip()
    except UnicodeDecodeError as error:
        raise PermissionError("Hermes API port marker is malformed") from error
    return _parse_gateway_public_port(decoded)


GATEWAY_PUBLIC_PORT = 8642
TRUSTED_HERMES_GATEWAY_LAUNCHERS = {
    b"/usr/local/bin/hermes.real",
    b"/usr/local/lib/nemoclaw/hermes",
    b"/opt/hermes/.venv/bin/hermes",
}


def _load_credential_boundary_manifest() -> dict[str, object]:
    # invalidState: the transaction accepts a credential name against a missing,
    # corrupt, or wrong-version OpenShell boundary manifest.
    # sourceBoundary: NemoClaw owns one reviewed manifest installed beside this
    # helper in images; the second path is the deterministic source-checkout layout.
    # whyNotSourceFix: OpenShell v0.0.106 has no machine-readable child-env contract.
    # It also deliberately hides the supervisor identity mount from workload
    # children and the Hermes image contains no OpenShell CLI. Executing
    # ``openshell --version`` here would therefore either fail every real
    # transaction or verify an unrelated in-image stub. The host MCP lifecycle
    # gate verifies the selected OpenShell CLI before provider mutation; the
    # exact loaded MCP policy remains the running-supervisor capability proof.
    # regressionTest: hermes-mcp-config-transaction and image packaging tests cover
    # both layouts, strict parsing, version alignment, and reserved-name parity.
    # removalCondition: replace this manifest boundary only when the live
    # supervisor exposes an authenticated, machine-readable attestation binding
    # both its running version and child-env contract to workload startup; #6256
    # tracks that upstream capability boundary.
    candidates = (
        Path(__file__).with_name(BOUNDARY_MANIFEST_NAME),
        Path(__file__).resolve().parents[2]
        / "src"
        / "lib"
        / "actions"
        / "sandbox"
        / BOUNDARY_MANIFEST_NAME,
    )
    manifest_path = next((path for path in candidates if path.is_file()), None)
    if manifest_path is None:
        raise RuntimeError("Hermes MCP credential boundary manifest is missing")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if (
        not isinstance(manifest, dict)
        or manifest.get("openshellVersion") != "0.0.106"
    ):
        raise RuntimeError("Hermes MCP credential boundary manifest is invalid")
    return manifest


def _manifest_strings(manifest: dict[str, object], key: str) -> frozenset[str]:
    values = manifest.get(key)
    if (
        not isinstance(values, list)
        or not values
        or not all(isinstance(value, str) and value for value in values)
    ):
        raise RuntimeError(f"Hermes MCP credential boundary manifest has invalid {key}")
    return frozenset(values)


_CREDENTIAL_BOUNDARY_MANIFEST = _load_credential_boundary_manifest()
_RAW_CHILD_VALUE_KEYS = _manifest_strings(
    _CREDENTIAL_BOUNDARY_MANIFEST, "rawChildValueKeys"
)
_REWRITTEN_CHILD_VALUE_KEYS = _manifest_strings(
    _CREDENTIAL_BOUNDARY_MANIFEST, "rewrittenChildValueKeys"
)
_RUNTIME_CONTROL_KEYS = _manifest_strings(
    _CREDENTIAL_BOUNDARY_MANIFEST, "runtimeControlKeys"
)
_RUNTIME_CONTROL_PREFIXES = _manifest_strings(
    _CREDENTIAL_BOUNDARY_MANIFEST, "runtimeControlPrefixes"
)


def _credential_name_is_reserved(name: str) -> bool:
    return (
        OPENSHELL_REVISIONED_CREDENTIAL_NAME_RE.fullmatch(name) is not None
        or name in _RAW_CHILD_VALUE_KEYS
        or name in _REWRITTEN_CHILD_VALUE_KEYS
        or name in _RUNTIME_CONTROL_KEYS
        or any(name.startswith(prefix) for prefix in _RUNTIME_CONTROL_PREFIXES)
    )


def _load_guard() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "nemoclaw_hermes_runtime_guard", GUARD_PATH
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("Hermes runtime config guard could not be loaded")
    module = importlib.util.module_from_spec(spec)
    # dataclasses resolves the defining module through sys.modules while the
    # guard is executing, so register it before exec_module().
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _assert_mutable_snapshot(snapshot: object) -> None:
    mode = int(getattr(snapshot, "mode"))
    uid = int(getattr(snapshot, "uid"))
    gid = int(getattr(snapshot, "gid"))
    if os.geteuid() == 0:
        expected_uid = pwd.getpwnam("sandbox").pw_uid
        expected_gid = grp.getgrnam("sandbox").gr_gid
        owner_matches = uid == expected_uid and gid == expected_gid
    else:
        owner_matches = uid == os.geteuid()
    if not owner_matches or not (mode & stat.S_IWUSR):
        raise RuntimeError(
            "Hermes config is locked or is not owned by the sandbox identity. "
            "Lower shields before changing managed MCP servers."
        )


def _parse_payload(raw: str) -> dict[str, object]:
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise ValueError("MCP mutation payload must be an object")
    return payload


def _display_safe_text(value: object) -> str:
    """Collapse terminal controls so one error cannot forge extra log lines."""
    text = ANSI_ESCAPE_RE.sub("", str(value))
    text = "".join(
        character
        for character in text
        if unicodedata.category(character) not in {"Cc", "Cf", "Cs"}
    )
    return " ".join(text.split())


def _sensitive_payload_values(payload: object) -> tuple[str, ...]:
    values: list[str] = []

    def visit(value: object, sensitive: bool = False) -> None:
        if isinstance(value, dict):
            for key, child in value.items():
                key_is_sensitive = isinstance(key, str) and bool(
                    SENSITIVE_PAYLOAD_KEY_RE.search(key)
                )
                visit(child, sensitive or key_is_sensitive)
        elif isinstance(value, list):
            for child in value:
                visit(child, sensitive)
        elif sensitive and isinstance(value, str) and value:
            values.append(_display_safe_text(value))

    visit(payload)
    return tuple(sorted(set(values), key=len, reverse=True))


def _sanitize_error_message(error: Exception, payload: object = None) -> str:
    """Return a bounded, single-line diagnostic without credential material."""
    if isinstance(error, yaml.YAMLError):
        return "Invalid Hermes config: YAML parsing failed"
    if isinstance(error, (json.JSONDecodeError, UnicodeError)):
        return "Hermes MCP mutation payload could not be decoded"

    message = _display_safe_text(error)
    for value in _sensitive_payload_values(payload):
        if value:
            message = message.replace(value, "<REDACTED>")
    message = AUTHORIZATION_FIELD_RE.sub(r"\1<REDACTED>", message)
    message = BEARER_VALUE_RE.sub(r"\1<REDACTED>", message)
    message = SENSITIVE_ASSIGNMENT_RE.sub(r"\1<REDACTED>", message)
    message = URL_USERINFO_RE.sub(r"\1<REDACTED>@", message)
    message = SENSITIVE_QUERY_RE.sub(r"\1<REDACTED>", message)
    if not message:
        message = "Hermes MCP transaction failed"
    return message[:MAX_ERROR_MESSAGE_LENGTH]


def _validate_payload(action: str, payload: dict[str, object]) -> None:
    if action not in {"add", "remove"}:
        raise ValueError("Unsupported MCP config action")
    allowed = {"server", "url", "headers"}
    allowed.add("replace_existing" if action == "add" else "force")
    unexpected = sorted(set(payload) - allowed)
    if unexpected:
        raise ValueError(
            f"MCP mutation payload contains unsupported fields: {', '.join(unexpected)}"
        )
    server = payload.get("server")
    if not isinstance(server, str) or not SERVER_NAME_RE.fullmatch(server):
        raise ValueError("MCP mutation payload has an invalid server name")
    flag_name = "replace_existing" if action == "add" else "force"
    if not isinstance(payload.get(flag_name), bool):
        raise ValueError(f"MCP mutation payload {flag_name} must be boolean")
    # Forced cleanup is server-name scoped: _mutate removes only this exact
    # mapping key and deliberately skips ownership matching. Do not strand a
    # legacy entry merely because its persisted URL or header shape is no
    # longer accepted for add/non-force mutation.
    if action == "remove" and payload["force"] is True:
        return
    raw_url = payload.get("url")
    if not isinstance(raw_url, str) or len(raw_url) > 2048:
        raise ValueError("MCP mutation payload has an invalid URL")
    parsed = urlsplit(raw_url)
    if parsed.scheme != "https" or not parsed.hostname:
        raise ValueError("MCP mutation payload URL must use HTTPS")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("MCP mutation payload URL contains forbidden components")
    hostname = parsed.hostname.lower().rstrip(".")
    # Fail closed on every IPv6 literal, including globally routable addresses,
    # before the numeric-host handling below. DNS names are resolved and
    # validated by the host boundary, then pinned into OpenShell allowed_ips;
    # this in-sandbox transaction never establishes the network connection.
    if ":" in hostname:
        raise ValueError("IPv6-literal MCP URLs are not supported")
    if not hostname.isascii() or any(char in hostname for char in "*?[]{};"):
        raise ValueError("MCP mutation payload URL has a non-literal hostname")
    try:
        port = parsed.port
    except ValueError as error:
        raise ValueError("MCP mutation payload URL has an invalid port") from error
    if port == 0:
        raise ValueError("MCP mutation payload URL port must be nonzero")
    host_aliases = {
        "host.openshell.internal",
        "host.docker.internal",
        "host.containers.internal",
    }
    if action == "add" and hostname in host_aliases:
        raise ValueError(
            "Authenticated MCP OpenShell host aliases are unavailable with OpenShell v0.0.106"
        )
    # Host preflight owns destination trust and binds every accepted endpoint to
    # exact OpenShell address pins. This in-sandbox check revalidates canonical
    # syntax and rejects IPv4 literals outside public or routed-private ranges.
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        address = None
    if address is None:
        if re.fullmatch(
            r"(?:0x[0-9a-f]+|[0-9]+)(?:\.(?:0x[0-9a-f]+|[0-9]+))*",
            hostname,
        ):
            raise ValueError("MCP mutation payload URL uses an ambiguous numeric host")
        if len(hostname) > 253 or any(
            MCP_DNS_LABEL_RE.fullmatch(label) is None
            for label in hostname.split(".")
        ):
            raise ValueError(
                "MCP mutation payload URL hostname must use canonical DNS labels"
            )
    elif not (
        (address.is_global and not address.is_multicast)
        or any(address in network for network in MCP_ROUTED_PRIVATE_IPV4_NETWORKS)
    ):
        raise ValueError("MCP mutation payload URL uses a disallowed address")
    path = parsed.path or "/"
    path_segments = path.split("/")
    if (
        not path.startswith("/")
        or "" in path_segments[1:-1]
        or any(segment in {".", ".."} for segment in path_segments)
        or any(char in path for char in ("%", "\\", ";", "*", "?", "[", "]", "{", "}"))
    ):
        raise ValueError("MCP mutation payload URL path must be literal and canonical")
    default_port = 443
    authority = hostname if port in {None, default_port} else f"{hostname}:{port}"
    canonical = f"{parsed.scheme}://{authority}{path}"
    if raw_url != canonical:
        raise ValueError("MCP mutation payload URL must be canonical")
    headers = payload.get("headers")
    if not isinstance(headers, dict) or set(headers) != {"Authorization"}:
        raise ValueError("MCP mutation payload must contain one Authorization header")
    authorization = headers.get("Authorization")
    revisioned_authorization_match = (
        REVISIONED_ENV_PLACEHOLDER_RE.fullmatch(authorization)
        if isinstance(authorization, str)
        else None
    )
    canonical_authorization_match = (
        ENV_PLACEHOLDER_RE.fullmatch(authorization)
        if isinstance(authorization, str)
        else None
    )
    authorization_match = (
        revisioned_authorization_match or canonical_authorization_match
    )
    if authorization_match is None:
        raise ValueError(
            "Hermes MCP Authorization must contain an OpenShell environment placeholder"
        )
    credential_name = (
        revisioned_authorization_match.group(2)
        if revisioned_authorization_match is not None
        else canonical_authorization_match.group(1)
    )
    if action == "add" and revisioned_authorization_match is not None:
        expected_child_value = authorization.removeprefix("Bearer ")
        if os.environ.get(credential_name) != expected_child_value:
            raise ValueError(
                "Hermes MCP Authorization revision does not match the OpenShell child environment"
            )
    if action == "add" and _credential_name_is_reserved(credential_name):
        raise ValueError(
            "Hermes MCP Authorization uses a reserved credential environment name"
        )


def _managed_candidate(payload: dict[str, object]) -> dict[str, object]:
    headers = payload.get("headers")
    if not isinstance(headers, dict):
        raise ValueError("MCP mutation payload headers must be an object")
    candidate: dict[str, object] = {
        "url": payload.get("url"),
        "enabled": True,
        "timeout": 120,
        "connect_timeout": 60,
        "tools": {"resources": True, "prompts": True},
    }
    if headers:
        candidate["headers"] = headers
    return candidate


def _managed_candidate_matches(
    actual: object, expected: dict[str, object], allow_revisioned: bool
) -> bool:
    """Compare managed config with bounded revision equivalence when requested."""
    if actual == expected:
        return True
    if not allow_revisioned or not isinstance(actual, dict):
        return False
    if set(actual) != set(expected):
        return False
    for name, value in expected.items():
        if name != "headers" and actual.get(name) != value:
            return False
    actual_headers = actual.get("headers")
    expected_headers = expected.get("headers")
    if not isinstance(actual_headers, dict) or not isinstance(expected_headers, dict):
        return False
    if set(actual_headers) != {"Authorization"} or set(expected_headers) != {
        "Authorization"
    }:
        return False
    expected_authorization = expected_headers.get("Authorization")
    actual_authorization = actual_headers.get("Authorization")
    expected_match = (
        ENV_PLACEHOLDER_RE.fullmatch(expected_authorization)
        if isinstance(expected_authorization, str)
        else None
    )
    if expected_match is None:
        return False
    expected_name = expected_match.group(1)
    if OPENSHELL_REVISIONED_CREDENTIAL_NAME_RE.fullmatch(expected_name):
        return False
    if not isinstance(actual_authorization, str):
        return False
    prefix = "Bearer openshell:resolve:env:v"
    suffix = f"_{expected_name}"
    if not actual_authorization.startswith(prefix) or not actual_authorization.endswith(suffix):
        return False
    revision = actual_authorization[len(prefix) : -len(suffix)]
    return revision.isdigit() and 1 <= len(revision) <= 20


_MANAGED_CANDIDATE_FIELDS = frozenset(
    {"url", "enabled", "timeout", "connect_timeout", "tools", "headers"}
)


def _validate_inspection_payload(payload: dict[str, object]) -> None:
    if set(payload) != {"present", "absent"}:
        raise ValueError("Hermes MCP inspection payload has invalid fields")
    present = payload.get("present")
    absent = payload.get("absent")
    if not isinstance(present, dict) or not isinstance(absent, list):
        raise ValueError("Hermes MCP inspection payload has invalid shape")
    if not all(
        isinstance(name, str) and SERVER_NAME_RE.fullmatch(name) for name in present
    ):
        raise ValueError("Hermes MCP inspection payload has an invalid server name")
    if not all(
        isinstance(name, str) and SERVER_NAME_RE.fullmatch(name) for name in absent
    ):
        raise ValueError("Hermes MCP inspection payload has an invalid absent server")
    if len(absent) != len(set(absent)) or set(present).intersection(absent):
        raise ValueError("Hermes MCP inspection payload has overlapping server state")
    for server, expected in present.items():
        if not isinstance(expected, dict):
            raise ValueError("Hermes MCP inspection expected config must be an object")
        if not set(expected).issubset(_MANAGED_CANDIDATE_FIELDS):
            raise ValueError("Hermes MCP inspection expected config has invalid fields")
        synthetic = {
            "server": server,
            "url": expected.get("url"),
            "headers": expected.get("headers"),
            "replace_existing": True,
        }
        _validate_payload("add", synthetic)
        if expected != _managed_candidate(synthetic):
            raise ValueError("Hermes MCP inspection expected config is not canonical")


def inspect_managed_config(payload: dict[str, object]) -> dict[str, object]:
    _validate_inspection_payload(payload)
    privileged = os.geteuid() == 0
    guard = _load_guard()
    hash_path = (
        STRICT_HASH_PATH if privileged else os.path.join(HERMES_DIR, ".config-hash")
    )
    compatibility_hash_path = (
        os.path.join(HERMES_DIR, ".config-hash") if privileged else None
    )
    # TOCTOU contract: this call reads config, env, and every hash anchor into
    # one authenticated snapshot. After comparing the returned config bytes to
    # host intent, `assert_mcp_integrity_snapshot_current` reopens every path and
    # requires the same inode/content metadata before any match is reported.
    integrity = guard.inspect_mcp_integrity_snapshot(
        HERMES_DIR, hash_path, compatibility_hash_path
    )
    if integrity.state != "current":
        raise RuntimeError("Hermes MCP config does not match applied gateway state")
    parsed = yaml.safe_load(integrity.config_text)
    if parsed is None:
        parsed = {}
    if not isinstance(parsed, dict):
        raise RuntimeError("Hermes MCP config does not match persisted managed intent")
    servers = parsed.get("mcp_servers", {})
    if servers is None:
        servers = {}
    if not isinstance(servers, dict):
        raise RuntimeError("Hermes MCP config does not match persisted managed intent")
    present = payload["present"]
    absent = payload["absent"]
    if not isinstance(present, dict) or not isinstance(absent, list):
        raise RuntimeError("Hermes MCP config does not match persisted managed intent")
    matches = all(
        _managed_candidate_matches(servers.get(name), expected, True)
        for name, expected in present.items()
    )
    matches = matches and all(name not in servers for name in absent)
    if not matches:
        raise RuntimeError("Hermes MCP config does not match persisted managed intent")
    guard.assert_mcp_integrity_snapshot_current(integrity)
    return {"ok": True, "state": "matched"}


def _mutate(
    data: object,
    action: str,
    payload: dict[str, object],
) -> tuple[dict, bool]:
    if not isinstance(data, dict):
        raise ValueError("Invalid Hermes config: expected a YAML object")
    server_name = payload.get("server")
    if not isinstance(server_name, str) or not server_name:
        raise ValueError("MCP mutation payload has no server name")

    servers = data.get("mcp_servers")
    if servers is None:
        servers = {}
        data["mcp_servers"] = servers
    if not isinstance(servers, dict):
        raise ValueError("Invalid Hermes config: mcp_servers must be an object")

    if action == "add":
        replace = payload.get("replace_existing") is True
        if server_name in servers and not replace:
            raise ValueError(
                f"MCP server '{server_name}' already exists in Hermes config and is not managed by NemoClaw."
            )
        candidate = _managed_candidate(payload)
        if servers.get(server_name) == candidate:
            return data, False
        servers[server_name] = candidate
        return data, True

    if action != "remove":
        raise ValueError(f"Unsupported MCP config action '{action}'")
    if server_name not in servers:
        return data, False
    if payload.get("force") is not True:
        current = servers.get(server_name)
        if not _managed_candidate_matches(current, _managed_candidate(payload), True):
            raise ValueError(
                f"Refusing to remove modified Hermes MCP server '{server_name}'. Use --force to remove it."
            )
    servers.pop(server_name, None)
    if not servers:
        data.pop("mcp_servers", None)
    return data, True


def _managed_hash_paths(privileged: bool) -> tuple[str, ...]:
    compatibility = os.path.join(HERMES_DIR, ".config-hash")
    return (STRICT_HASH_PATH, compatibility) if privileged else (compatibility,)


def _refresh_and_verify_hashes(
    guard: ModuleType, privileged: bool, mcp_transition: str = "preserve"
) -> None:
    if privileged:
        guard.refresh_hashes(
            HERMES_DIR,
            STRICT_HASH_PATH,
            "strict",
            mcp_transition=mcp_transition,
        )
    guard.refresh_hashes(
        HERMES_DIR,
        STRICT_HASH_PATH,
        "compat",
        mcp_transition=mcp_transition,
    )
    compat_text, _ = guard._read_text(os.path.join(HERMES_DIR, ".config-hash"))
    _config_digest, _env_digest, mcp_state = guard._parse_config_hash(
        compat_text,
        os.path.join(HERMES_DIR, "config.yaml"),
        os.path.join(HERMES_DIR, ".env"),
    )
    expected_text, _, _ = guard._hash_text(
        os.path.join(HERMES_DIR, "config.yaml"),
        os.path.join(HERMES_DIR, ".env"),
        mcp_state,
    )
    if compat_text != expected_text:
        raise RuntimeError("Hermes compatibility config hash is stale")
    if privileged:
        strict_text, _ = guard._read_text(STRICT_HASH_PATH)
    else:
        strict_text = compat_text
    if strict_text != compat_text:
        raise RuntimeError("Hermes strict and compatibility config hashes differ")
    state = guard.inspect_mcp_integrity(
        HERMES_DIR,
        STRICT_HASH_PATH if privileged else os.path.join(HERMES_DIR, ".config-hash"),
    )
    expected_state = {
        "apply": "current",
        "rollback": "pending",
    }.get(mcp_transition)
    if expected_state is not None and state != expected_state:
        raise RuntimeError("Hermes MCP applied hash state is stale")


def _restore_hash_snapshots(
    guard: ModuleType, originals: dict[str, tuple[str, object]]
) -> None:
    for path, (original_text, original_snapshot) in originals.items():
        _, current_snapshot = guard._read_text(path)
        guard._write_existing(
            path,
            original_text,
            current_snapshot,
            mode=int(getattr(original_snapshot, "mode")),
        )
        restored_text, _ = guard._read_text(path)
        if restored_text != original_text:
            raise RuntimeError(f"Failed to restore Hermes hash file {path}")


def _is_retryable_mcp_snapshot_race(error: Exception) -> bool:
    message = str(error)
    return "refusing raced runtime config path:" in message or (
        "refusing raced Hermes MCP integrity snapshot" in message
    )


def _recover_committed_apply_snapshot(
    guard: ModuleType, privileged: bool, expected_text: str
) -> bool:
    """Reopen a bounded number of snapshots across an atomic hash replacement."""
    compatibility_hash_path = os.path.join(HERMES_DIR, ".config-hash")
    for attempt in range(MCP_RACE_RECOVERY_ATTEMPTS):
        try:
            integrity = guard.inspect_mcp_integrity_snapshot(
                HERMES_DIR,
                STRICT_HASH_PATH if privileged else compatibility_hash_path,
                compatibility_hash_path if privileged else None,
            )
            if integrity.config_text != expected_text or integrity.state != "current":
                return False
            guard.assert_mcp_integrity_snapshot_current(integrity)
            return True
        except guard.UnsafePathError as recovery_error:
            if (
                not _is_retryable_mcp_snapshot_race(recovery_error)
                or attempt + 1 == MCP_RACE_RECOVERY_ATTEMPTS
            ):
                raise
    return False


def apply_transaction(action: str, payload: dict[str, object]) -> bool:
    _validate_payload(action, payload)
    privileged = os.geteuid() == 0
    guard = _load_guard()
    original_text, original_snapshot = guard._read_text(CONFIG_PATH)
    _assert_mutable_snapshot(original_snapshot)
    hash_originals = {
        path: guard._read_text(path) for path in _managed_hash_paths(privileged)
    }
    integrity_path = (
        STRICT_HASH_PATH if privileged else os.path.join(HERMES_DIR, ".config-hash")
    )
    guard.inspect_mcp_integrity(HERMES_DIR, integrity_path)
    parsed = yaml.safe_load(original_text)
    if parsed is None:
        parsed = {}
    updated, changed = _mutate(parsed, action, payload)
    if not changed:
        try:
            _refresh_and_verify_hashes(guard, privileged, "intend")
        except Exception as hash_error:
            try:
                _restore_hash_snapshots(guard, hash_originals)
            except Exception as rollback_error:
                raise RuntimeError(
                    f"Hermes MCP hash refresh failed ({hash_error}); "
                    f"hash rollback also failed ({rollback_error})"
                ) from rollback_error
            raise
        return False

    updated_text = yaml.safe_dump(updated, sort_keys=False)
    replacement_snapshot = None
    try:
        guard._write_existing(
            CONFIG_PATH,
            updated_text,
            original_snapshot,
            mode=original_snapshot.mode,
        )
        _, replacement_snapshot = guard._read_text(CONFIG_PATH)
        _refresh_and_verify_hashes(guard, privileged, "intend")
    except Exception as mutation_error:
        if replacement_snapshot is None:
            raise
        try:
            guard._write_existing(
                CONFIG_PATH,
                original_text,
                replacement_snapshot,
                mode=original_snapshot.mode,
            )
            _restore_hash_snapshots(guard, hash_originals)
        except Exception as rollback_error:
            raise RuntimeError(
                f"Hermes MCP config update failed ({mutation_error}); rollback also failed ({rollback_error})"
            ) from rollback_error
        raise
    return True


def apply_transaction_and_reload(
    action: str, payload: dict[str, object]
) -> dict[str, object]:
    """Commit config+hashes and runtime reload as one recoverable operation."""
    _validate_payload(action, payload)
    privileged = os.geteuid() == 0
    guard = _load_guard()
    original_text, original_snapshot = guard._read_text(CONFIG_PATH)
    parsed = yaml.safe_load(original_text)
    if parsed is None:
        parsed = {}
    expected_data, expected_changed = _mutate(parsed, action, payload)
    expected_text = (
        yaml.safe_dump(expected_data, sort_keys=False)
        if expected_changed
        else original_text
    )

    changed = apply_transaction(action, payload)
    reload_completed = False
    try:
        reloaded = reload_gateway()
        if not reloaded:
            raise RuntimeError("Hermes gateway stopped before managed MCP reload")
        reload_completed = True
        current_text, _current_snapshot = guard._read_text(CONFIG_PATH)
        if current_text != expected_text:
            raise RuntimeError(
                "Hermes config changed concurrently after MCP reload; refusing applied-state commit"
            )
        _refresh_and_verify_hashes(guard, privileged, "apply")
    except Exception as reload_error:
        if not changed:
            raise RuntimeError(
                f"Hermes MCP runtime reload failed with unchanged config ({reload_error})"
            ) from reload_error
        # After a completed reload, check whether the gateway committed the
        # apply-state hash advance concurrently with the transaction helper's
        # verify step. A failed reload cannot use anchor state as runtime proof.
        # If the config still matches the intended text and both integrity
        # anchors are current, rolling it back would undo a live configuration.
        if reload_completed:
            try:
                if _recover_committed_apply_snapshot(guard, privileged, expected_text):
                    return {"ok": True, "changed": True, "reloaded": True}
            except Exception as recovery_error:
                logging.getLogger(__name__).warning(
                    "Hermes MCP race-recovery verification failed (%s); proceeding to rollback",
                    type(recovery_error).__name__,
                )
        rollback_errors: list[str] = []
        try:
            current_text, current_snapshot = guard._read_text(CONFIG_PATH)
            if current_text != expected_text:
                raise RuntimeError(
                    "Hermes config changed concurrently after MCP mutation; refusing rollback"
                )
            guard._write_existing(
                CONFIG_PATH,
                original_text,
                current_snapshot,
                mode=int(getattr(original_snapshot, "mode")),
            )
            # Do not restore the original current/current anchors before the
            # old config is proven live.  Record a pending rollback anchor so
            # startup and host reconciliation remain fail-closed if this
            # second reload also fails.
            _refresh_and_verify_hashes(guard, privileged, "rollback")
        except Exception as rollback_error:
            rollback_errors.append(f"config/hash rollback failed: {rollback_error}")
        else:
            try:
                rollback_reloaded = reload_gateway()
                if not rollback_reloaded:
                    rollback_errors.append(
                        "old-config runtime reload was not verified because the gateway stopped"
                    )
                else:
                    _refresh_and_verify_hashes(guard, privileged, "apply")
            except Exception as rollback_reload_error:
                rollback_errors.append(
                    f"old-config runtime reload failed: {rollback_reload_error}"
                )
        detail = "; ".join(rollback_errors) or "config and hashes were restored"
        raise RuntimeError(
            f"Hermes MCP runtime reload failed ({reload_error}); {detail}"
        ) from reload_error
    return {"ok": True, "changed": changed, "reloaded": reloaded}


def _process_arguments(pid: int) -> list[bytes]:
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as command_line:
            return [
                argument
                for argument in command_line.read(16 * 1024).split(b"\0")
                if argument
            ]
    except FileNotFoundError:
        return []


def _process_name(pid: int) -> bytes | None:
    try:
        with open(f"/proc/{pid}/status", "rb") as status_file:
            for line in status_file:
                if line.startswith(b"Name:"):
                    fields = line.split(maxsplit=1)
                    return fields[1].removesuffix(b"\n") if len(fields) == 2 else None
    except FileNotFoundError:
        return None
    return None


def _is_trusted_gateway_process(pid: int) -> bool:
    arguments = _process_arguments(pid)
    return any(
        arguments[index] in TRUSTED_HERMES_GATEWAY_LAUNCHERS
        and arguments[index + 1 : index + 3] == [b"gateway", b"run"]
        for index in range(max(0, len(arguments) - 2))
    )


def _process_parent_pid(pid: int) -> int | None:
    try:
        with open(f"/proc/{pid}/status", encoding="utf-8") as status_file:
            for line in status_file:
                if line.startswith("PPid:"):
                    return int(line.split()[1])
    except (FileNotFoundError, ValueError, IndexError):
        return None
    return None


def _is_service_manager_arguments(arguments: list[bytes]) -> bool:
    if not arguments:
        return False
    if arguments == [SERVICE_MANAGER_PATH]:
        return True
    return (
        os.path.basename(arguments[0]) in {b"bash", b"sh"}
        and len(arguments) == 2
        and arguments[1] == SERVICE_MANAGER_PATH
    )


def _is_service_manager_process(pid: int) -> bool:
    return _is_service_manager_arguments(_process_arguments(pid))


def _gateway_has_managed_parent(pid: int) -> bool:
    parent_pid = _process_parent_pid(pid)
    return parent_pid is not None and _is_service_manager_process(parent_pid)


def _gateway_pid_record_candidate(expected_uid: int) -> tuple[int, int | None] | None:
    """Read Hermes runtime metadata as an untrusted PID candidate.

    Pinned Hermes rejects NemoClaw's root-owned ``hermes.real`` wrapper target
    before returning the otherwise valid PID/lock record.  The candidate is
    never authority by itself: ``_gateway_identity`` still requires the live
    same-UID process, exact trusted launcher argv, managed parent, and a stable
    process start identity before mutation or reload.
    """

    no_follow = getattr(os, "O_NOFOLLOW", 0)
    non_blocking = getattr(os, "O_NONBLOCK", 0)
    if not no_follow or not non_blocking:
        raise PermissionError("Hermes gateway PID record cannot be opened safely")
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | no_follow | non_blocking
    try:
        descriptor = os.open(GATEWAY_PID_PATH, flags)
    except FileNotFoundError:
        return None
    except OSError as error:
        raise PermissionError(
            "Hermes gateway PID record cannot be opened safely"
        ) from error

    try:
        before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_uid != expected_uid
            or before.st_nlink != 1
            or before.st_size <= 0
            or before.st_size > MAX_GATEWAY_PID_RECORD_BYTES
        ):
            raise PermissionError("Hermes gateway PID record is unsafe")
        raw = os.read(descriptor, MAX_GATEWAY_PID_RECORD_BYTES + 1)
        after = os.fstat(descriptor)
        if (
            len(raw) != before.st_size
            or len(raw) > MAX_GATEWAY_PID_RECORD_BYTES
            or (
                before.st_dev,
                before.st_ino,
                before.st_mode,
                before.st_uid,
                before.st_nlink,
                before.st_size,
                before.st_mtime_ns,
                before.st_ctime_ns,
            )
            != (
                after.st_dev,
                after.st_ino,
                after.st_mode,
                after.st_uid,
                after.st_nlink,
                after.st_size,
                after.st_mtime_ns,
                after.st_ctime_ns,
            )
        ):
            raise PermissionError("Hermes gateway PID record changed while reading")
    finally:
        os.close(descriptor)

    try:
        decoded = raw.decode("utf-8").strip()
    except UnicodeDecodeError as error:
        raise PermissionError("Hermes gateway PID record is malformed") from error
    try:
        record: object = json.loads(decoded)
    except json.JSONDecodeError:
        try:
            record = {"pid": int(decoded)}
        except ValueError as error:
            raise PermissionError("Hermes gateway PID record is malformed") from error
    if isinstance(record, int) and not isinstance(record, bool):
        record = {"pid": record}
    if not isinstance(record, dict):
        raise PermissionError("Hermes gateway PID record is malformed")

    pid = record.get("pid")
    recorded_start = record.get("start_time")
    if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 1:
        raise PermissionError("Hermes gateway PID record is malformed")
    if recorded_start is not None and (
        isinstance(recorded_start, bool)
        or not isinstance(recorded_start, int)
        or recorded_start <= 0
    ):
        raise PermissionError("Hermes gateway PID record is malformed")
    return pid, recorded_start


def _gateway_identity() -> tuple[int, object] | None:
    os.environ["HERMES_HOME"] = HERMES_DIR
    from gateway.status import get_process_start_time, get_running_pid

    expected_uid = pwd.getpwnam("gateway").pw_uid if os.geteuid() == 0 else os.geteuid()
    pid = get_running_pid(cleanup_stale=False)
    if not pid:
        from gateway.status import is_gateway_runtime_lock_active

        if not is_gateway_runtime_lock_active():
            return None
        candidate = _gateway_pid_record_candidate(expected_uid)
        if candidate is None:
            return None
        numeric_pid, recorded_start = candidate
    else:
        numeric_pid = int(pid)
        recorded_start = None
    try:
        owner_uid = os.stat(f"/proc/{numeric_pid}").st_uid
    except FileNotFoundError:
        return None
    if owner_uid != expected_uid:
        expected_identity = "gateway" if os.geteuid() == 0 else "sandbox"
        raise PermissionError(
            f"Hermes gateway is not owned by the expected {expected_identity} identity"
        )
    if not _is_trusted_gateway_process(numeric_pid):
        raise PermissionError(
            "Hermes gateway PID does not identify the trusted launcher"
        )
    if not _gateway_has_managed_parent(numeric_pid):
        raise PermissionError(
            "Hermes gateway is not running under the managed service lifecycle"
        )
    start_time = get_process_start_time(numeric_pid)
    if start_time is None:
        raise PermissionError("Hermes gateway process start identity is unavailable")
    if recorded_start is not None and recorded_start != start_time:
        return None
    if get_process_start_time(numeric_pid) != start_time:
        return None
    return numeric_pid, start_time


def _process_start_identity(pid: int) -> object | None:
    os.environ["HERMES_HOME"] = HERMES_DIR
    from gateway.status import get_process_start_time

    return get_process_start_time(pid)


def _managed_api_relay_port(arguments: list[bytes]) -> int | None:
    if (
        len(arguments) != 3
        or os.path.basename(arguments[0]) != MANAGED_API_RELAY_PROCESS_NAME
        or arguments[2] != MANAGED_API_RELAY_TARGET
    ):
        return None

    listen = arguments[1]
    if not (
        listen.startswith(MANAGED_API_RELAY_LISTEN_PREFIX)
        and listen.endswith(MANAGED_API_RELAY_LISTEN_SUFFIX)
    ):
        raise PermissionError("Hermes managed API relay arguments are malformed")
    raw_port = listen[
        len(MANAGED_API_RELAY_LISTEN_PREFIX) : -len(MANAGED_API_RELAY_LISTEN_SUFFIX)
    ]
    try:
        decoded = raw_port.decode("ascii")
    except UnicodeDecodeError as error:
        raise PermissionError("Hermes managed API relay port is malformed") from error
    return _parse_gateway_public_port(decoded)


def _managed_api_relay_public_port(
    identity: tuple[int, object],
) -> int:
    """Resolve the public port from the service manager's API relay child."""
    gateway_pid = identity[0]
    manager_pid = _process_parent_pid(gateway_pid)
    if manager_pid is None:
        raise PermissionError(
            "Hermes gateway is not running under the managed service lifecycle"
        )

    expected_uid = os.geteuid()
    try:
        manager_uid = os.stat(f"/proc/{manager_pid}").st_uid
        manager_arguments = _process_arguments(manager_pid)
        manager_start = _process_start_identity(manager_pid)
    except FileNotFoundError:
        raise RuntimeError(GATEWAY_NOT_READY_MESSAGE) from None
    except OSError as error:
        raise PermissionError(
            "Hermes service manager identity is unavailable"
        ) from error
    if (
        manager_uid != expected_uid
        or not _is_service_manager_arguments(manager_arguments)
        or manager_start is None
    ):
        raise PermissionError(
            "Hermes gateway is not running under the managed service lifecycle"
        )

    # The sandbox user can rewrite same-UID files. An unrelated sandbox process
    # cannot choose the validated service manager as its parent.
    candidates: list[tuple[int, object, int, list[bytes]]] = []
    try:
        with os.scandir("/proc") as process_entries:
            process_names = [process_entry.name for process_entry in process_entries]
    except OSError as error:
        raise PermissionError("Hermes process table is unavailable") from error

    for name in process_names:
        if not name.isascii() or not name.isdigit():
            continue
        pid = int(name, 10)
        if pid <= 1 or pid == gateway_pid:
            continue
        try:
            owner_uid = os.stat(f"/proc/{pid}").st_uid
            parent_pid = _process_parent_pid(pid)
            process_name = _process_name(pid)
        except OSError:
            continue
        if (
            owner_uid != expected_uid
            or parent_pid != manager_pid
            or process_name != MANAGED_API_RELAY_PROCESS_NAME
        ):
            continue
        try:
            arguments = _process_arguments(pid)
        except FileNotFoundError:
            continue
        except OSError as error:
            raise PermissionError(
                "Hermes managed API relay identity is unavailable"
            ) from error
        port = _managed_api_relay_port(arguments)
        if port is None:
            continue
        try:
            start_identity = _process_start_identity(pid)
        except FileNotFoundError:
            continue
        except OSError as error:
            raise PermissionError(
                "Hermes managed API relay identity is unavailable"
            ) from error
        if start_identity is not None:
            candidates.append((pid, start_identity, port, arguments))

    if not candidates:
        raise RuntimeError(GATEWAY_NOT_READY_MESSAGE)
    if len(candidates) != 1:
        raise PermissionError("Hermes managed API relay identity is ambiguous")

    relay_pid, relay_start, port, relay_arguments = candidates[0]
    try:
        relay_owner_uid = os.stat(f"/proc/{relay_pid}").st_uid
    except FileNotFoundError:
        raise RuntimeError(GATEWAY_NOT_READY_MESSAGE) from None
    except OSError as error:
        raise PermissionError(
            "Hermes managed API relay identity is unavailable"
        ) from error
    try:
        relay_parent_pid = _process_parent_pid(relay_pid)
        relay_process_name = _process_name(relay_pid)
        current_arguments = _process_arguments(relay_pid)
        current_start = _process_start_identity(relay_pid)
        current_manager_uid = os.stat(f"/proc/{manager_pid}").st_uid
        current_manager_arguments = _process_arguments(manager_pid)
        current_manager_start = _process_start_identity(manager_pid)
    except FileNotFoundError:
        raise RuntimeError(GATEWAY_NOT_READY_MESSAGE) from None
    except OSError as error:
        raise PermissionError(
            "Hermes managed API relay identity is unavailable"
        ) from error
    if (
        relay_owner_uid != expected_uid
        or relay_parent_pid != manager_pid
        or relay_process_name != MANAGED_API_RELAY_PROCESS_NAME
        or current_arguments != relay_arguments
        or current_start != relay_start
        or current_manager_uid != manager_uid
        or current_manager_arguments != manager_arguments
        or current_manager_start != manager_start
        or _process_parent_pid(gateway_pid) != manager_pid
        or _gateway_identity() != identity
    ):
        raise RuntimeError(GATEWAY_NOT_READY_MESSAGE)
    return port


def _resolve_gateway_public_port() -> int:
    marker_port = _root_gateway_public_port_marker()
    if marker_port is not None:
        return marker_port
    if os.geteuid() == 0:
        raise PermissionError("Hermes root API port marker is unavailable")
    identity = _gateway_identity()
    if identity is None:
        raise RuntimeError(GATEWAY_NOT_READY_MESSAGE)
    return _managed_api_relay_public_port(identity)


def _configure_gateway_public_port() -> None:
    global GATEWAY_PUBLIC_PORT
    GATEWAY_PUBLIC_PORT = _resolve_gateway_public_port()


def _gateway_health_endpoint_ready(port: int, timeout_seconds: float = 2) -> bool:
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout_seconds)
    try:
        connection.request("GET", "/health")
        response = connection.getresponse()
        response.read()
        return response.status in {200, 401}
    except OSError:
        return False
    finally:
        connection.close()


def _gateway_health_phase(deadline: float | None = None) -> tuple[bool, str]:
    # Hermes can bind its internal API before the managed service loop repairs
    # the public socat relay after a SIGUSR1 reload.  A successful MCP command
    # must not return during that gap: callers use the documented public port.
    def probe_timeout() -> float:
        if deadline is None:
            return 2
        return max(0, min(2, deadline - time.monotonic()))

    internal_timeout = probe_timeout()
    if internal_timeout <= 0 or not _gateway_health_endpoint_ready(
        GATEWAY_INTERNAL_PORT, internal_timeout
    ):
        return False, "waiting-for-internal-health"
    public_timeout = probe_timeout()
    if public_timeout <= 0 or not _gateway_health_endpoint_ready(
        GATEWAY_PUBLIC_PORT, public_timeout
    ):
        return False, "waiting-for-public-relay-health"
    return True, "waiting-for-stable-replacement-identity"


def _gateway_healthy() -> bool:
    return _gateway_health_phase()[0]


def reload_gateway() -> bool:
    previous = _gateway_identity()
    if previous is None:
        return False
    try:
        os.kill(previous[0], signal.SIGUSR1)
    except ProcessLookupError:
        if _gateway_identity() is None:
            return False
        raise

    started_at = time.monotonic()
    deadline = started_at + RELOAD_TIMEOUT_SECONDS
    re_kick_not_before = started_at + (RELOAD_TIMEOUT_SECONDS / 2)
    re_kick_attempted = False
    re_kick_sent = False
    phase_order = {
        "waiting-for-replacement-identity": 0,
        "waiting-for-internal-health": 1,
        "waiting-for-public-relay-health": 2,
        "waiting-for-stable-replacement-identity": 3,
    }
    last_safe_phase = "waiting-for-replacement-identity"
    while True:
        now = time.monotonic()
        if now >= deadline:
            break
        current = _gateway_identity()
        observed_phase = "waiting-for-replacement-identity"
        if (
            current is not None
            and current != previous
            and _gateway_has_managed_parent(current[0])
        ):
            healthy, observed_phase = _gateway_health_phase(deadline)
            if phase_order[observed_phase] > phase_order[last_safe_phase]:
                last_safe_phase = observed_phase
            if healthy:
                confirmed = _gateway_identity()
                if (
                    confirmed == current
                    and _gateway_has_managed_parent(current[0])
                    and time.monotonic() < deadline
                ):
                    return True

        # A pinned Hermes gateway can remain alive without converging after the
        # first SIGUSR1.  Give it half of the existing total deadline, then
        # permit one additional desired-config signal.  Re-read the complete
        # trusted identity immediately before signaling and require its managed
        # parent so known stale or unmanaged identities are refused.
        now = time.monotonic()
        if (
            not re_kick_attempted
            and now >= re_kick_not_before
            and now < deadline
            # The managed supervisor owns the public socat relay. Once the
            # replacement gateway is internally healthy, another gateway
            # signal cannot repair that relay and only creates crash churn.
            and observed_phase != "waiting-for-public-relay-health"
            and current is not None
            and _gateway_has_managed_parent(current[0])
            and _gateway_identity() == current
            and time.monotonic() < deadline
        ):
            re_kick_attempted = True
            try:
                os.kill(current[0], signal.SIGUSR1)
            except ProcessLookupError:
                pass
            else:
                re_kick_sent = True
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        time.sleep(min(1, remaining))
    raise TimeoutError(
        "Hermes gateway did not complete its managed MCP reload "
        f"(last safe phase: {last_safe_phase}; "
        f"re-kick attempted: {'yes' if re_kick_attempted else 'no'}; "
        f"re-kick sent: {'yes' if re_kick_sent else 'no'})"
    )


def _assert_non_root_lifecycle_identity() -> None:
    """Allow only an active same-uid Hermes workload topology.

    Root-started sandboxes stamp a root-owned read-only runtime marker and run
    Hermes as the dedicated gateway uid. OpenShell current main starts the
    workload and gateway as the sandbox uid. Direct sandbox execution cannot
    cross from the former topology into the latter.
    """
    # invalidState: an ordinary sandbox process claims same-UID mutation
    # authority while Hermes actually runs in the legacy root-separated
    # topology.
    # sourceBoundary: OpenShell owns workload topology; NemoClaw owns the
    # immutable root-lifecycle marker and validates it before mutation.
    # whyNotSourceFix: OpenShell 0.0.106 supports both topologies but exposes no
    # attested same-UID capability that this packaged helper can query.
    # regressionTest: hermes-mcp-config-transaction.test.ts rejects both probe
    # and add when the root-lifecycle marker identifies the legacy topology.
    # removalCondition: remove this marker check when OpenShell unifies the
    # topology or exposes an attested execution-identity capability.
    try:
        root_marker = os.lstat(ROOT_LIFECYCLE_MARKER)
    except FileNotFoundError:
        root_marker = None
    if root_marker is not None:
        if not stat.S_ISREG(root_marker.st_mode) or root_marker.st_uid != 0:
            raise PermissionError("Hermes root lifecycle marker is unsafe")
        raise PermissionError(
            "Hermes MCP mutation requires a same-uid OpenShell sandbox runtime"
        )
    identity = _gateway_identity()
    if identity is None:
        raise RuntimeError(GATEWAY_NOT_READY_MESSAGE)
    if not _gateway_has_managed_parent(identity[0]):
        raise RuntimeError(
            "Hermes gateway is not running under the managed service lifecycle"
        )
    if _gateway_identity() != identity:
        raise RuntimeError(GATEWAY_NOT_READY_MESSAGE)


def probe() -> dict[str, object]:
    """Prove the packaged helper is available without mutating config."""
    if os.geteuid() != 0:
        _assert_non_root_lifecycle_identity()
    _configure_gateway_public_port()
    return {"ok": True}


def execute(action: str, payload: dict[str, object]) -> dict[str, object]:
    _validate_payload(action, payload)
    if os.geteuid() != 0:
        _assert_non_root_lifecycle_identity()
    _configure_gateway_public_port()
    return apply_transaction_and_reload(action, payload)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("add", "remove", "inspect", "probe"))
    parser.add_argument("--payload")
    args = parser.parse_args()
    payload: dict[str, object] | None = None
    try:
        if args.action == "probe":
            if args.payload is not None:
                raise ValueError("Hermes MCP lifecycle probe does not accept --payload")
            result = probe()
        elif args.action == "inspect":
            if args.payload is None:
                raise ValueError("Hermes MCP inspection requires --payload")
            payload = _parse_payload(args.payload)
            result = inspect_managed_config(payload)
        elif args.payload is None:
            raise ValueError("Hermes MCP mutation requires --payload")
        else:
            payload = _parse_payload(args.payload)
            result = execute(args.action, payload)
    except Exception as error:
        print(_sanitize_error_message(error, payload), file=sys.stderr)
        return 2
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
