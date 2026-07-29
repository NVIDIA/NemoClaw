# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# NemoClaw-managed Deep Agents Code hardening v2.
"""Runtime invariants for the NemoClaw-managed Deep Agents Code image."""

from __future__ import annotations

import ctypes
import errno
import fcntl
import grp
import hashlib
import ipaddress
import json
import os
import re
import selectors
import shlex
import signal
import stat
import subprocess
import sys
import time
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
_VALIDATION_PROFILE_FILE = Path(
    "/usr/local/share/nemoclaw/dcode-validation-profile.json"
)
_VALIDATION_PROFILE_SCHEMA = "nemoclaw.dcode.validation-profile.v1"
_VALIDATION_RECEIPT_SCHEMA = "nemoclaw.dcode.validation-receipt.v1"
_VALIDATION_MAX_PROFILE_BYTES = 65_536
_VALIDATION_DIGEST = re.compile(r"sha256:[0-9a-f]{64}")
_VALIDATION_IDENTITY = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}")
_VALIDATION_COMMAND_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")
_VALIDATION_ENV_NAME = re.compile(r"[A-Z_][A-Z0-9_]{0,127}")
_VALIDATION_SHELL_SYNTAX = re.compile(r"[\x00-\x1f\x7f;&|><`$(){}[\]*?!~]")
_VALIDATION_FIXED_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
_VALIDATION_EXECUTABLE_OWNER_UID = 0
_VALIDATION_GIT_EXECUTABLE = Path("/usr/bin/git")
_VALIDATION_GIT_OWNER_UID = 0
_VALIDATION_INVOCATION_BUDGET_ROOT = Path(
    "/usr/local/share/nemoclaw/dcode-validation-invocations"
)
_VALIDATION_INVOCATION_BUDGET_OWNER_UID = 0
_VALIDATION_INVOCATION_BUDGET_GROUP_GID: int | None = None
_VALIDATION_INVOCATION_ANCHOR = "anchor"
_VALIDATION_INVOCATION_CLAIMS = "claims"
_VALIDATION_INVOCATION_ROOT_PROBE = ".root-write-protection-probe"
_VALIDATION_INVOCATION_SANDBOX_PROBE = ".sandbox-one-way-claim-probe"
_VALIDATION_CREDENTIAL_ENV_NAME = re.compile(
    r"(?:^|[_-])(?:api[_-]?key|access[_-]?key|secret[_-]?key|"
    r"auth[_-]?token|refresh[_-]?token|access[_-]?token|client[_-]?secret|"
    r"private[_-]?key|pass[_-]?code|personal[_-]?access[_-]?token|"
    r"connection[_-]?string|webhook(?:[_-]?url)?|key|secret|token|password|"
    r"passwd|passcode|auth|authorization|credential|credentials|bearer|"
    r"bearer[_-]?token|cookie|cookies|pat|private|privatekey|pin|webhookurl|"
    r"dsn|connectionstring)(?:$|[_-])",
    re.IGNORECASE,
)
# SECURITY -- Source boundary: this isolated Python runtime cannot import the
# canonical policy in src/lib/security/process-control-env.ts. Keep the managed
# profile validator fail-closed for the same execution-control families. HOME
# and PATH are safe profile declarations because execution replaces both with
# fixed managed values instead of inheriting them.
_VALIDATION_PROCESS_CONTROL_ENV_NAMES = {
    "ALL_PROXY",
    "ALLUSERSPROFILE",
    "APPDATA",
    "AWS_CA_BUNDLE",
    "BASHOPTS",
    "BASH_ENV",
    "CDPATH",
    "CLASSPATH",
    "COMSPEC",
    "CURL_CA_BUNDLE",
    "CURL_HOME",
    "DENO_CERT",
    "DOCKER_CERT_PATH",
    "DOCKER_CONFIG",
    "DOCKER_CONTEXT",
    "DOCKER_HOST",
    "DOCKER_TLS_VERIFY",
    "DOTNET_STARTUP_HOOKS",
    "ENV",
    "FTP_PROXY",
    "GIT_ASKPASS",
    "GIT_COMMON_DIR",
    "GIT_DIR",
    "GIT_EDITOR",
    "GIT_EXEC_PATH",
    "GIT_EXTERNAL_DIFF",
    "GIT_PAGER",
    "GIT_PROXY_COMMAND",
    "GIT_PROXY_SSL_CAINFO",
    "GIT_SEQUENCE_EDITOR",
    "GIT_SSH",
    "GIT_SSH_COMMAND",
    "GIT_SSL_CAINFO",
    "GIT_SSL_CAPATH",
    "GIT_SSL_NO_VERIFY",
    "GLOBIGNORE",
    "GCONV_PATH",
    "GLIBC_TUNABLES",
    "GRPC_DEFAULT_SSL_ROOTS_FILE_PATH",
    "GRPC_PROXY",
    "HOMEDRIVE",
    "HOMEPATH",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "IFS",
    "JAVA_TOOL_OPTIONS",
    "JDK_JAVA_OPTIONS",
    "KUBECONFIG",
    "LESSCLOSE",
    "LESSOPEN",
    "LOCALAPPDATA",
    "LOCPATH",
    "MANPAGER",
    "NODE_EXTRA_CA_CERTS",
    "NODE_OPTIONS",
    "NODE_PATH",
    "NODE_TLS_REJECT_UNAUTHORIZED",
    "NODE_USE_ENV_PROXY",
    "NODE_USE_SYSTEM_CA",
    "NO_PROXY",
    "NETRC",
    "NEMOCLAW_ACCEPT_DEV_UNVERIFIED_INSTALL",
    "NEMOCLAW_BOOTSTRAP_PAYLOAD",
    "NEMOCLAW_INSTALL_REF",
    "NEMOCLAW_INSTALL_TAG",
    "NEMOCLAW_INSTALLER_STAGED",
    "NEMOCLAW_INSTALLER_URL",
    "NEMOCLAW_OPENSHELL_BIN",
    "NEMOCLAW_OPENSHELL_CHANNEL",
    "NEMOCLAW_OPENSHELL_GATEWAY_BIN",
    "NEMOCLAW_OPENSHELL_SANDBOX_BIN",
    "NEMOCLAW_REPO_ROOT",
    "NEMOCLAW_SOURCE_ROOT",
    "NVM_DIR",
    "OLDPWD",
    "OPENSSL_CONF",
    "OPENSSL_CONF_INCLUDE",
    "OPENSSL_ENGINES",
    "OPENSSL_MODULES",
    "PAGER",
    "PATHEXT",
    "PERL5LIB",
    "PERL5OPT",
    "PS4",
    "PWD",
    "PSMODULEPATH",
    "PROGRAMDATA",
    "PYTHONHOME",
    "PYTHONINSPECT",
    "PYTHONPATH",
    "PYTHONSTARTUP",
    "PYTHONUSERBASE",
    "REQUESTS_CA_BUNDLE",
    "RUBYLIB",
    "RUBYOPT",
    "SHELL",
    "SHELLOPTS",
    "SSH_ASKPASS",
    "SSH_ASKPASS_REQUIRE",
    "SSLKEYLOGFILE",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USERPROFILE",
    "VIRTUAL_ENV",
    "XDG_CACHE_HOME",
    "XDG_BIN_HOME",
    "XDG_CONFIG_DIRS",
    "XDG_CONFIG_HOME",
    "XDG_DATA_DIRS",
    "XDG_DATA_HOME",
    "XDG_RUNTIME_DIR",
    "XDG_STATE_HOME",
    "ZDOTDIR",
    "_JAVA_OPTIONS",
}
_VALIDATION_PROCESS_CONTROL_ENV_PREFIXES = (
    "BASH_FUNC_",
    "LD_",
    "DYLD_",
    "GIT_CONFIG_",
    "GIT_TRACE",
    "NPM_CONFIG_",
    "OPENSHELL_",
    "PIP_",
)
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
# OpenShell 8eacb477 reserves these for the supervisor and strips them from all
# child process shapes; fail closed if a regressed runtime exposes them here.
_OPENSHELL_SUPERVISOR_ONLY_ENV_NAMES = frozenset(
    {"OPENSHELL_TLS_CA", "OPENSHELL_TLS_CERT", "OPENSHELL_TLS_KEY"}
)
_UPSTREAM_PROVIDER_ENV = "NEMOCLAW_UPSTREAM_PROVIDER"
_FETCH_URL_TRUSTED_PROXY_ENV = (
    "DEEPAGENTS_CODE_FETCH_URL_TRUSTED_PROXY_URL"
)
_MANAGED_FETCH_CA_BUNDLE_FILE = Path(
    "/etc/openshell-tls/ca-bundle.pem"
)
# Keep this managed adapter allow-list in sync with generate-config.ts and the
# patch-managed-deepagents-code.py provider guards injected into Deep Agents Code.
_MANAGED_ADAPTER_PROVIDERS = frozenset({"openai", "openrouter"})
_NVIDIA_DISPLAY_PROVIDER_ALIASES = frozenset(
    {"nvidia", "nvidia-prod", "nvidia-nim", "nvidia-router"}
)
_OPENROUTER_DISPLAY_PROVIDER_ALIASES = frozenset({"openrouter", "openrouter-api"})
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
        if name in _OPENSHELL_SUPERVISOR_ONLY_ENV_NAMES:
            raise RuntimeError(
                f"runtime environment variable {name} is reserved for the "
                "OpenShell supervisor and must not reach a child process"
            )
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


def _read_managed_validation_profile() -> bytes | None:
    """Read the optional root-owned image profile without following links."""
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(_VALIDATION_PROFILE_FILE, flags)
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise RuntimeError("managed validation profile is unreadable or unsafe") from exc
    try:
        before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_nlink != 1
            or before.st_uid != _MANAGED_FILE_OWNER_UID
            or stat.S_IMODE(before.st_mode) != 0o444
            or before.st_size < 2
            or before.st_size > _VALIDATION_MAX_PROFILE_BYTES
        ):
            raise RuntimeError("managed validation profile metadata is unsafe")
        raw = os.read(descriptor, before.st_size + 1)
        after = os.fstat(descriptor)
        if (
            len(raw) != before.st_size
            or len(raw) > _VALIDATION_MAX_PROFILE_BYTES
            or any(
                getattr(before, field) != getattr(after, field)
                for field in (
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
            )
        ):
            raise RuntimeError("managed validation profile changed while reading")
        return raw
    finally:
        os.close(descriptor)


def _validation_absolute_path(value: object, label: str) -> str:
    if (
        not isinstance(value, str)
        or not value.startswith("/")
        or len(value) > 4096
        or value != os.path.normpath(value)
        or "\\" in value
        or ".." in value.split("/")
        or _contains_secret_shape(value)
    ):
        raise RuntimeError(f"managed validation profile {label} is invalid")
    return value


def _validation_positive_integer(
    value: object, label: str, maximum: int
) -> int:
    if type(value) is not int or value < 1 or value > maximum:
        raise RuntimeError(f"managed validation profile {label} is invalid")
    return value


def _validation_credential_name(name: str) -> bool:
    return bool(
        _VALIDATION_CREDENTIAL_ENV_NAME.search(name)
        or _CREDENTIAL_NAME.search(name)
        or _CREDENTIAL_CAMEL_NAME.search(name)
        or name.upper() in _CREDENTIAL_ENV_NAMES
    )


def _validation_process_control_name(name: str) -> bool:
    if name in {"HOME", "PATH"}:
        return False
    return (
        name == "GIT_CONFIG"
        or name in _VALIDATION_PROCESS_CONTROL_ENV_NAMES
        or name.startswith(_VALIDATION_PROCESS_CONTROL_ENV_PREFIXES)
    )


def _canonical_validation_profile(raw: bytes) -> dict[str, object]:
    try:
        value = json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=_reject_duplicate_json_keys,
            parse_constant=_reject_non_json_constant,
        )
    except Exception as exc:
        if isinstance(exc, RuntimeError):
            raise
        raise RuntimeError("managed validation profile is malformed") from exc
    fields = {
        "schemaVersion",
        "contentDigest",
        "sandboxName",
        "taskIdentity",
        "sourceIdentity",
        "workingDirectoryRoots",
        "commands",
    }
    if not isinstance(value, dict) or set(value) != fields:
        raise RuntimeError("managed validation profile has an invalid shape")
    if value["schemaVersion"] != _VALIDATION_PROFILE_SCHEMA:
        raise RuntimeError("managed validation profile schema is unsupported")
    for name in ("sandboxName", "taskIdentity"):
        item = value[name]
        if (
            not isinstance(item, str)
            or _VALIDATION_IDENTITY.fullmatch(item) is None
            or _contains_secret_shape(item)
        ):
            raise RuntimeError(f"managed validation profile {name} is invalid")
    source_identity = value["sourceIdentity"]
    if (
        not isinstance(source_identity, str)
        or _VALIDATION_DIGEST.fullmatch(source_identity) is None
    ):
        raise RuntimeError("managed validation profile sourceIdentity is invalid")
    roots = value["workingDirectoryRoots"]
    if not isinstance(roots, list) or not 1 <= len(roots) <= 16:
        raise RuntimeError("managed validation profile roots are invalid")
    canonical_roots = [
        _validation_absolute_path(root, f"workingDirectoryRoots[{index}]")
        for index, root in enumerate(roots)
    ]
    if len(set(canonical_roots)) != len(canonical_roots):
        raise RuntimeError("managed validation profile roots are duplicated")
    commands = value["commands"]
    if not isinstance(commands, list) or not 1 <= len(commands) <= 32:
        raise RuntimeError("managed validation profile commands are invalid")
    canonical_commands: list[dict[str, object]] = []
    for index, command in enumerate(commands):
        command_fields = {
            "id",
            "argv",
            "workingDirectory",
            "environment",
            "timeoutSeconds",
            "maxOutputBytes",
            "maxInvocations",
        }
        if not isinstance(command, dict) or set(command) != command_fields:
            raise RuntimeError(f"managed validation profile command {index} is invalid")
        command_id = command["id"]
        if (
            not isinstance(command_id, str)
            or _VALIDATION_COMMAND_ID.fullmatch(command_id) is None
            or _contains_secret_shape(command_id)
        ):
            raise RuntimeError(f"managed validation profile command {index} id is invalid")
        argv = command["argv"]
        if not isinstance(argv, list) or not 1 <= len(argv) <= 64:
            raise RuntimeError(f"managed validation profile command {index} argv is invalid")
        canonical_argv: list[str] = []
        for argument in argv:
            if (
                not isinstance(argument, str)
                or not argument
                or len(argument) > 4096
                or _VALIDATION_SHELL_SYNTAX.search(argument)
                or _contains_secret_shape(argument)
            ):
                raise RuntimeError(
                    f"managed validation profile command {index} argv is invalid"
                )
            canonical_argv.append(argument)
        if not canonical_argv[0].startswith("/"):
            raise RuntimeError(
                f"managed validation profile command {index} executable is invalid"
            )
        working_directory = _validation_absolute_path(
            command["workingDirectory"], f"command {index} workingDirectory"
        )
        if not any(
            working_directory == root
            or working_directory.startswith(root.rstrip("/") + "/")
            for root in canonical_roots
        ):
            raise RuntimeError(
                f"managed validation profile command {index} workingDirectory is outside its roots"
            )
        environment = command["environment"]
        if not isinstance(environment, list) or len(environment) > 64:
            raise RuntimeError(
                f"managed validation profile command {index} environment is invalid"
            )
        canonical_environment: list[str] = []
        for name in environment:
            if (
                not isinstance(name, str)
                or _VALIDATION_ENV_NAME.fullmatch(name) is None
                or _validation_credential_name(name)
                or _validation_process_control_name(name)
            ):
                raise RuntimeError(
                    f"managed validation profile command {index} environment is invalid"
                )
            canonical_environment.append(name)
        if len(set(canonical_environment)) != len(canonical_environment):
            raise RuntimeError(
                f"managed validation profile command {index} environment is duplicated"
            )
        canonical_commands.append(
            {
                "id": command_id,
                "argv": canonical_argv,
                "workingDirectory": working_directory,
                "environment": canonical_environment,
                "timeoutSeconds": _validation_positive_integer(
                    command["timeoutSeconds"], f"command {index} timeoutSeconds", 3600
                ),
                "maxOutputBytes": _validation_positive_integer(
                    command["maxOutputBytes"],
                    f"command {index} maxOutputBytes",
                    16 * 1024 * 1024,
                ),
                "maxInvocations": _validation_positive_integer(
                    command["maxInvocations"], f"command {index} maxInvocations", 1000
                ),
            }
        )
    if len({command["id"] for command in canonical_commands}) != len(canonical_commands):
        raise RuntimeError("managed validation profile command ids are duplicated")
    content = {
        "schemaVersion": _VALIDATION_PROFILE_SCHEMA,
        "sandboxName": value["sandboxName"],
        "taskIdentity": value["taskIdentity"],
        "sourceIdentity": source_identity,
        "workingDirectoryRoots": canonical_roots,
        "commands": canonical_commands,
    }
    expected_digest = "sha256:" + hashlib.sha256(
        json.dumps(
            content, sort_keys=True, separators=(",", ":"), ensure_ascii=False
        ).encode("utf-8")
    ).hexdigest()
    if value["contentDigest"] != expected_digest:
        raise RuntimeError("managed validation profile contentDigest is invalid")
    return {**content, "contentDigest": expected_digest}


def managed_validation_profile() -> dict[str, object] | None:
    """Return the validated immutable headless-command profile, if installed."""
    raw = _read_managed_validation_profile()
    return None if raw is None else _canonical_validation_profile(raw)


def validate_managed_validation_profile_file() -> None:
    """Fail an image build when an installed validation profile is invalid."""
    if managed_validation_profile() is None:
        raise RuntimeError("managed validation profile is unavailable")


def _validation_invocation_command_path(
    profile: dict[str, object], command: dict[str, object]
) -> Path:
    digest = str(profile["contentDigest"]).removeprefix("sha256:")
    return _VALIDATION_INVOCATION_BUDGET_ROOT / digest / str(command["id"])


def _validation_invocation_budget_group_gid() -> int:
    configured = _VALIDATION_INVOCATION_BUDGET_GROUP_GID
    return grp.getgrnam("sandbox").gr_gid if configured is None else configured


def initialize_managed_validation_invocation_budget() -> None:
    """Create the root-owned, write-once invocation slots during image build."""
    if os.geteuid() != _VALIDATION_INVOCATION_BUDGET_OWNER_UID:
        raise RuntimeError("validation invocation budget requires its trusted owner")
    if _VALIDATION_INVOCATION_BUDGET_ROOT.exists():
        raise RuntimeError("validation invocation budget already exists")
    _VALIDATION_INVOCATION_BUDGET_ROOT.mkdir(mode=0o755)
    profile = managed_validation_profile()
    if profile is None:
        return
    digest_directory = _VALIDATION_INVOCATION_BUDGET_ROOT / str(
        profile["contentDigest"]
    ).removeprefix("sha256:")
    digest_directory.mkdir(mode=0o755)
    for command in profile["commands"]:
        command_directory = _validation_invocation_command_path(profile, command)
        command_directory.mkdir(mode=0o755)
        anchor = command_directory / _VALIDATION_INVOCATION_ANCHOR
        descriptor = os.open(
            anchor,
            os.O_RDWR
            | os.O_CREAT
            | os.O_EXCL
            | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_NOFOLLOW", 0),
            0o600,
        )
        os.fchown(
            descriptor,
            _VALIDATION_INVOCATION_BUDGET_OWNER_UID,
            _validation_invocation_budget_group_gid(),
        )
        os.fchmod(descriptor, 0o660)
        os.close(descriptor)
        claims = command_directory / _VALIDATION_INVOCATION_CLAIMS
        claims.mkdir(mode=0o1730)
        os.chown(
            claims,
            _VALIDATION_INVOCATION_BUDGET_OWNER_UID,
            _validation_invocation_budget_group_gid(),
            follow_symlinks=False,
        )
        claims.chmod(0o1730)
        os.link(anchor, claims / _VALIDATION_INVOCATION_ROOT_PROBE)


def validate_managed_validation_invocation_budget_unprivileged() -> None:
    """Prove the sandbox UID can consume but cannot roll back one slot."""
    profile = managed_validation_profile()
    if profile is None:
        return
    if os.geteuid() == _VALIDATION_INVOCATION_BUDGET_OWNER_UID:
        raise RuntimeError("validation invocation budget probe requires an unprivileged user")
    for command in profile["commands"]:
        command_directory = _validation_invocation_command_path(profile, command)
        anchor = command_directory / _VALIDATION_INVOCATION_ANCHOR
        claims = command_directory / _VALIDATION_INVOCATION_CLAIMS
        root_probe = claims / _VALIDATION_INVOCATION_ROOT_PROBE
        sandbox_probe = claims / _VALIDATION_INVOCATION_SANDBOX_PROBE
        anchor_stat = anchor.stat(follow_symlinks=False)
        # The link retains the root-owned anchor inode, so the sticky claims
        # directory denies sandbox removal. A sandbox-owned file would not
        # provide the write-once guarantee.
        os.link(anchor, sandbox_probe, follow_symlinks=False)
        with root_probe.open("wb") as stream:
            stream.write(b"sandbox file-write probe")
        for protected in (root_probe, sandbox_probe):
            try:
                protected.unlink()
            except PermissionError:
                pass
            else:
                raise RuntimeError("sandbox user rolled back an invocation claim")
            protected_stat = protected.stat(follow_symlinks=False)
            if (
                protected_stat.st_dev != anchor_stat.st_dev
                or protected_stat.st_ino != anchor_stat.st_ino
            ):
                raise RuntimeError("validation invocation claim identity changed")


def finalize_managed_validation_invocation_budget() -> None:
    """Remove image-build probes without exposing runtime rollback authority."""
    profile = managed_validation_profile()
    if profile is None:
        return
    if os.geteuid() != _VALIDATION_INVOCATION_BUDGET_OWNER_UID:
        raise RuntimeError("validation invocation budget requires its trusted owner")
    for command in profile["commands"]:
        command_directory = _validation_invocation_command_path(profile, command)
        claims = command_directory / _VALIDATION_INVOCATION_CLAIMS
        for name in (
            _VALIDATION_INVOCATION_ROOT_PROBE,
            _VALIDATION_INVOCATION_SANDBOX_PROBE,
        ):
            (claims / name).unlink()
        anchor = command_directory / _VALIDATION_INVOCATION_ANCHOR
        with anchor.open("wb"):
            pass


def managed_validation_profile_enabled() -> bool:
    """Return whether the immutable image contains a valid command profile."""
    return managed_validation_profile() is not None


def _validation_receipt(
    profile: dict[str, object],
    command_id: str | None,
    argv: list[str],
    status_name: str,
    started: float,
    *,
    exit_code: int | None = None,
    stdout: bytes = b"",
    stderr: bytes = b"",
    verified_source_identity: str | None = None,
) -> dict[str, object]:
    return {
        "schemaVersion": _VALIDATION_RECEIPT_SCHEMA,
        "profileDigest": profile["contentDigest"],
        "sandboxName": profile["sandboxName"],
        "taskIdentity": profile["taskIdentity"],
        "sourceIdentity": profile["sourceIdentity"],
        "verifiedSourceIdentity": verified_source_identity,
        "commandId": command_id,
        "argvDigest": "sha256:"
        + hashlib.sha256(
            json.dumps(argv, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        ).hexdigest(),
        "workingDirectory": next(
            (
                command["workingDirectory"]
                for command in profile["commands"]
                if command["id"] == command_id
            ),
            None,
        ),
        "terminalStatus": status_name,
        "exitCode": exit_code,
        "durationMs": max(0, round((time.monotonic() - started) * 1000)),
        "stdoutSha256": hashlib.sha256(stdout).hexdigest(),
        "stderrSha256": hashlib.sha256(stderr).hexdigest(),
        "stdoutBytes": len(stdout),
        "stderrBytes": len(stderr),
    }


def _terminate_validation_process(process: subprocess.Popen[bytes]) -> None:
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except (OSError, ProcessLookupError):
        try:
            process.kill()
        except (OSError, ProcessLookupError):
            # The process already exited, so there is no remaining cleanup.
            pass


def _validation_descriptor_root() -> Path:
    candidate = Path("/proc/self/fd")
    if candidate.is_dir():
        return candidate
    raise RuntimeError("validation descriptor execution is unavailable")


_VALIDATION_SOURCE_WATCH_MASK = (
    0x00000002  # IN_MODIFY
    | 0x00000004  # IN_ATTRIB
    | 0x00000008  # IN_CLOSE_WRITE
    | 0x00000040  # IN_MOVED_FROM
    | 0x00000080  # IN_MOVED_TO
    | 0x00000100  # IN_CREATE
    | 0x00000200  # IN_DELETE
    | 0x00000400  # IN_DELETE_SELF
    | 0x00000800  # IN_MOVE_SELF
)


class _ValidationSourceWatch:
    """Record every work-tree mutation from source verification through exit."""

    def __init__(self, descriptor: int) -> None:
        self.descriptor = descriptor

    @classmethod
    def open(cls, root: Path) -> _ValidationSourceWatch:
        libc = ctypes.CDLL(None, use_errno=True)
        initialize = libc.inotify_init1
        initialize.argtypes = [ctypes.c_int]
        initialize.restype = ctypes.c_int
        add_watch = libc.inotify_add_watch
        add_watch.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32]
        add_watch.restype = ctypes.c_int
        descriptor = initialize(os.O_NONBLOCK | getattr(os, "O_CLOEXEC", 0))
        if descriptor < 0:
            raise RuntimeError("source mutation guard is unavailable")
        try:
            for current, directories, _files in os.walk(
                root, topdown=True, followlinks=False
            ):
                current_path = Path(current)
                current_stat = current_path.lstat()
                if current_path.is_symlink() or not stat.S_ISDIR(current_stat.st_mode):
                    raise RuntimeError("source mutation guard found an unsafe directory")
                if (
                    add_watch(
                        descriptor,
                        os.fsencode(current_path),
                        _VALIDATION_SOURCE_WATCH_MASK,
                    )
                    < 0
                ):
                    raise RuntimeError("source mutation guard could not cover the work tree")
                directories[:] = [
                    name
                    for name in directories
                    if not (current_path / name).is_symlink()
                ]
            return cls(descriptor)
        except Exception:
            os.close(descriptor)
            raise

    def changed(self) -> bool:
        changed = False
        while True:
            try:
                chunk = os.read(self.descriptor, 65_536)
            except BlockingIOError:
                return changed
            except OSError as exc:
                raise RuntimeError("source mutation guard failed") from exc
            if not chunk:
                raise RuntimeError("source mutation guard closed unexpectedly")
            changed = True

    def close(self) -> None:
        os.close(self.descriptor)


def _run_validation_git(
    working_directory: str,
    arguments: list[str],
    pass_descriptors: tuple[int, ...],
) -> tuple[int, bytes]:
    executable_stat = _VALIDATION_GIT_EXECUTABLE.lstat()
    if (
        _VALIDATION_GIT_EXECUTABLE.is_symlink()
        or not stat.S_ISREG(executable_stat.st_mode)
        or executable_stat.st_uid != _VALIDATION_GIT_OWNER_UID
        or executable_stat.st_mode & 0o022
        or executable_stat.st_mode & 0o111 == 0
    ):
        raise RuntimeError("trusted Git executable is unavailable")
    process = subprocess.Popen(
        [
            str(_VALIDATION_GIT_EXECUTABLE),
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.hooksPath=/dev/null",
            *arguments,
        ],
        cwd=working_directory,
        env={
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_OPTIONAL_LOCKS": "0",
            "GIT_TERMINAL_PROMPT": "0",
            "HOME": "/nonexistent",
            "LC_ALL": "C",
            "PATH": _VALIDATION_FIXED_PATH,
        },
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        shell=False,
        start_new_session=True,
        pass_fds=pass_descriptors,
    )
    assert process.stdout is not None
    os.set_blocking(process.stdout.fileno(), False)
    output = bytearray()
    deadline = time.monotonic() + 5
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    try:
        while selector.get_map():
            if time.monotonic() >= deadline:
                _terminate_validation_process(process)
                raise RuntimeError("source revision verification timed out")
            for key, _mask in selector.select(timeout=0.05):
                chunk = os.read(key.fileobj.fileno(), 4096)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                output.extend(chunk)
                if len(output) > 8192:
                    _terminate_validation_process(process)
                    raise RuntimeError("source revision verification output is excessive")
        remaining = max(0.0, deadline - time.monotonic())
        try:
            return process.wait(timeout=remaining), bytes(output)
        except subprocess.TimeoutExpired as exc:
            _terminate_validation_process(process)
            raise RuntimeError("source revision verification timed out") from exc
    finally:
        selector.close()
        process.stdout.close()
        if process.poll() is None:
            _terminate_validation_process(process)
            process.wait()


def _validation_source_root(
    working_directory: str, pass_descriptors: tuple[int, ...]
) -> Path:
    status, raw_root = _run_validation_git(
        working_directory, ["rev-parse", "--show-toplevel"], pass_descriptors
    )
    try:
        decoded = raw_root.decode("utf-8", errors="strict").strip()
    except UnicodeDecodeError as exc:
        raise RuntimeError("source work tree is invalid") from exc
    if (
        status != 0
        or not decoded.startswith("/")
        or "\x00" in decoded
        or decoded != os.path.normpath(decoded)
    ):
        raise RuntimeError("source work tree is invalid")
    root = Path(decoded)
    try:
        root_stat = root.lstat()
        root_real = root.resolve(strict=True)
    except OSError as exc:
        raise RuntimeError("source work tree is unavailable") from exc
    if root.is_symlink() or root_real != root or not stat.S_ISDIR(root_stat.st_mode):
        raise RuntimeError("source work tree is unsafe")
    return root


def _verified_validation_source_identity(
    working_directory: str, pass_descriptors: tuple[int, ...]
) -> str | None:
    config_status, unsafe_config = _run_validation_git(
        working_directory,
        [
            "config",
            "--local",
            "--includes",
            "--name-only",
            "--get-regexp",
            (
                r"^(core\.(fsmonitor|hooksPath)|diff\..*\.command|"
                r"filter\..*\.(clean|smudge|process)|merge\..*\.driver)$"
            ),
        ],
        pass_descriptors,
    )
    format_status, raw_format = _run_validation_git(
        working_directory, ["rev-parse", "--show-object-format"], pass_descriptors
    )
    oid_status, raw_oid = _run_validation_git(
        working_directory,
        ["rev-parse", "--verify", "HEAD^{commit}"],
        pass_descriptors,
    )
    dirty_status, _output = _run_validation_git(
        working_directory,
        ["diff-index", "--quiet", "--no-ext-diff", "--ignore-submodules=none", "HEAD", "--"],
        pass_descriptors,
    )
    untracked_status, untracked = _run_validation_git(
        working_directory,
        ["ls-files", "--others", "--exclude-standard", "-z"],
        pass_descriptors,
    )
    try:
        object_format = raw_format.decode("ascii", errors="strict").strip()
        object_id = raw_oid.decode("ascii", errors="strict").strip()
    except UnicodeDecodeError:
        return None
    expected_length = {"sha1": 40, "sha256": 64}.get(object_format)
    if (
        format_status != 0
        or config_status != 1
        or unsafe_config
        or oid_status != 0
        or dirty_status != 0
        or untracked_status != 0
        or untracked
        or expected_length is None
        or re.fullmatch(rf"[0-9a-f]{{{expected_length}}}", object_id) is None
    ):
        return None
    identity = "sha256:" + hashlib.sha256(
        f"git:{object_format}:{object_id}".encode("ascii")
    ).hexdigest()
    return identity


def _reserve_validation_invocation(
    profile: dict[str, object], command: dict[str, object]
) -> tuple[int, int, int, int] | None:
    command_directory = _validation_invocation_command_path(profile, command)
    expected_directories = (
        _VALIDATION_INVOCATION_BUDGET_ROOT,
        command_directory.parent,
        command_directory,
    )
    for directory in expected_directories:
        directory_stat = directory.lstat()
        if (
            directory.is_symlink()
            or not stat.S_ISDIR(directory_stat.st_mode)
            or directory_stat.st_uid != _VALIDATION_INVOCATION_BUDGET_OWNER_UID
            or directory_stat.st_mode & 0o022
        ):
            raise RuntimeError("validation invocation budget directory is unsafe")
    claims = command_directory / _VALIDATION_INVOCATION_CLAIMS
    claims_stat = claims.lstat()
    if (
        claims.is_symlink()
        or not stat.S_ISDIR(claims_stat.st_mode)
        or claims_stat.st_uid != _VALIDATION_INVOCATION_BUDGET_OWNER_UID
        or claims_stat.st_gid != _validation_invocation_budget_group_gid()
        or stat.S_IMODE(claims_stat.st_mode) != 0o1730
    ):
        raise RuntimeError("validation invocation claim directory is unsafe")
    command_descriptor = os.open(
        command_directory,
        os.O_RDONLY
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_DIRECTORY", 0)
        | getattr(os, "O_NOFOLLOW", 0),
    )
    claims_descriptor: int | None = None
    anchor_descriptor: int | None = None
    try:
        claims_descriptor = os.open(
            _VALIDATION_INVOCATION_CLAIMS,
            os.O_RDONLY
            | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_DIRECTORY", 0)
            | getattr(os, "O_NOFOLLOW", 0),
            dir_fd=command_descriptor,
        )
        anchor_descriptor = os.open(
            _VALIDATION_INVOCATION_ANCHOR,
            os.O_RDWR
            | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_NOFOLLOW", 0),
            dir_fd=command_descriptor,
        )
        anchor_stat = os.fstat(anchor_descriptor)
        if (
            not stat.S_ISREG(anchor_stat.st_mode)
            or anchor_stat.st_uid != _VALIDATION_INVOCATION_BUDGET_OWNER_UID
            or anchor_stat.st_gid != _validation_invocation_budget_group_gid()
            or stat.S_IMODE(anchor_stat.st_mode) != 0o660
            or anchor_stat.st_dev != os.fstat(claims_descriptor).st_dev
        ):
            raise RuntimeError("validation invocation anchor is unsafe")
        lock_deadline = time.monotonic() + 1
        while True:
            try:
                fcntl.flock(
                    anchor_descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB
                )
                break
            except BlockingIOError as exc:
                if time.monotonic() >= lock_deadline:
                    raise RuntimeError(
                        "validation invocation budget is unavailable"
                    ) from exc
                time.sleep(0.01)
        for slot in range(command["maxInvocations"]):
            try:
                claim_stat = os.stat(
                    str(slot), dir_fd=claims_descriptor, follow_symlinks=False
                )
            except FileNotFoundError:
                return (
                    command_descriptor,
                    claims_descriptor,
                    anchor_descriptor,
                    slot,
                )
            if (
                not stat.S_ISREG(claim_stat.st_mode)
                or claim_stat.st_uid != _VALIDATION_INVOCATION_BUDGET_OWNER_UID
                or claim_stat.st_dev != anchor_stat.st_dev
                or claim_stat.st_ino != anchor_stat.st_ino
            ):
                raise RuntimeError("validation invocation claim is unsafe")
        os.close(anchor_descriptor)
        os.close(claims_descriptor)
        os.close(command_descriptor)
        return None
    except Exception:
        if anchor_descriptor is not None:
            os.close(anchor_descriptor)
        if claims_descriptor is not None:
            os.close(claims_descriptor)
        os.close(command_descriptor)
        raise


def _close_validation_invocation_reservation(
    reservation: tuple[int, int, int, int]
) -> None:
    command_descriptor, claims_descriptor, anchor_descriptor, _slot = reservation
    os.close(anchor_descriptor)
    os.close(claims_descriptor)
    os.close(command_descriptor)


def _commit_validation_invocation(
    reservation: tuple[int, int, int, int]
) -> None:
    command_descriptor, claims_descriptor, anchor_descriptor, slot = reservation
    anchor_stat = os.fstat(anchor_descriptor)
    try:
        os.link(
            _VALIDATION_INVOCATION_ANCHOR,
            str(slot),
            src_dir_fd=command_descriptor,
            dst_dir_fd=claims_descriptor,
            follow_symlinks=False,
        )
    except FileExistsError:
        claim_stat = os.stat(
            str(slot), dir_fd=claims_descriptor, follow_symlinks=False
        )
        if (
            not stat.S_ISREG(claim_stat.st_mode)
            or claim_stat.st_uid != _VALIDATION_INVOCATION_BUDGET_OWNER_UID
            or claim_stat.st_dev != anchor_stat.st_dev
            or claim_stat.st_ino != anchor_stat.st_ino
        ):
            raise RuntimeError("validation invocation claim changed before commit")


def execute_managed_validation_command(command_text: object) -> tuple[dict[str, object], bool]:
    """Execute one exact profiled argv without invoking a shell."""
    started = time.monotonic()
    profile = managed_validation_profile()
    if profile is None:
        raise RuntimeError("managed validation profile is disabled")
    argv: list[str] = []
    if (
        isinstance(command_text, str)
        and command_text
        and _VALIDATION_SHELL_SYNTAX.search(command_text) is None
    ):
        try:
            argv = shlex.split(command_text, posix=True)
        except ValueError:
            argv = []
    matched = next(
        (entry for entry in profile["commands"] if entry["argv"] == argv),
        None,
    )
    if matched is None:
        return _validation_receipt(profile, None, argv, "rejected", started), False
    command_id = matched["id"]
    executable = Path(argv[0])
    working_directory = Path(matched["workingDirectory"])
    directory_descriptor: int | None = None
    executable_descriptor: int | None = None
    try:
        executable_stat = executable.lstat()
        directory_stat = working_directory.lstat()
        executable_real = executable.resolve(strict=True)
        directory_real = working_directory.resolve(strict=True)
        roots_real = [Path(root).resolve(strict=True) for root in profile["workingDirectoryRoots"]]
    except (OSError, RuntimeError):
        return _validation_receipt(profile, command_id, argv, "rejected", started), False
    if (
        executable.is_symlink()
        or executable_real != executable
        or not stat.S_ISREG(executable_stat.st_mode)
        or executable_stat.st_uid != _VALIDATION_EXECUTABLE_OWNER_UID
        or executable_stat.st_mode & 0o022
        or executable_stat.st_mode & 0o111 == 0
        or working_directory.is_symlink()
        or directory_real != working_directory
        or not stat.S_ISDIR(directory_stat.st_mode)
        or not any(
            directory_real == root or directory_real.is_relative_to(root)
            for root in roots_real
        )
    ):
        return _validation_receipt(profile, command_id, argv, "rejected", started), False

    child_environment = {
        "HOME": "/sandbox",
        "PATH": _VALIDATION_FIXED_PATH,
    }
    for name in matched["environment"]:
        if name in {"HOME", "PATH"}:
            continue
        if _validation_process_control_name(name):
            return _validation_receipt(
                profile, command_id, argv, "rejected", started
            ), False
        value = os.environ.get(name)
        if value is not None:
            if _contains_secret_shape(value) or _validation_credential_name(name):
                return _validation_receipt(
                    profile, command_id, argv, "rejected", started
                ), False
            child_environment[name] = value

    try:
        directory_descriptor = os.open(
            working_directory,
            os.O_RDONLY
            | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_DIRECTORY", 0)
            | getattr(os, "O_NOFOLLOW", 0),
        )
        bound_directory_stat = os.fstat(directory_descriptor)
        if (
            bound_directory_stat.st_dev != directory_stat.st_dev
            or bound_directory_stat.st_ino != directory_stat.st_ino
        ):
            raise RuntimeError("working directory changed before execution")
        executable_descriptor = os.open(
            executable,
            os.O_RDONLY
            | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_NOFOLLOW", 0),
        )
        bound_executable_stat = os.fstat(executable_descriptor)
        if (
            bound_executable_stat.st_dev != executable_stat.st_dev
            or bound_executable_stat.st_ino != executable_stat.st_ino
            or not stat.S_ISREG(bound_executable_stat.st_mode)
            or bound_executable_stat.st_uid != _VALIDATION_EXECUTABLE_OWNER_UID
            or bound_executable_stat.st_mode & 0o022
            or bound_executable_stat.st_mode & 0o111 == 0
        ):
            raise RuntimeError("executable changed before execution")
        descriptor_root = _validation_descriptor_root()
        bound_working_directory = f"{descriptor_root}/{directory_descriptor}"
        bound_executable = f"{descriptor_root}/{executable_descriptor}"
        pass_descriptors = (directory_descriptor, executable_descriptor)
    except (OSError, RuntimeError):
        if executable_descriptor is not None:
            os.close(executable_descriptor)
        if directory_descriptor is not None:
            os.close(directory_descriptor)
        return _validation_receipt(profile, command_id, argv, "rejected", started), False

    verified_source_identity: str | None = None
    source_watch: _ValidationSourceWatch | None = None
    invocation_reservation: tuple[int, int, int, int] | None = None
    process: subprocess.Popen[bytes] | None = None
    try:
        source_root = _validation_source_root(
            bound_working_directory, (directory_descriptor,)
        )
        source_watch = _ValidationSourceWatch.open(source_root)
        verified_source_identity = _verified_validation_source_identity(
            bound_working_directory, (directory_descriptor,)
        )
        if (
            verified_source_identity != profile["sourceIdentity"]
            or source_watch.changed()
        ):
            return (
                _validation_receipt(
                    profile,
                    command_id,
                    argv,
                    "source_identity_mismatch",
                    started,
                    verified_source_identity=verified_source_identity,
                ),
                False,
            )
        invocation_reservation = _reserve_validation_invocation(profile, matched)
        if invocation_reservation is None:
            return (
                _validation_receipt(
                    profile,
                    command_id,
                    argv,
                    "invocation_limit_exceeded",
                    started,
                    verified_source_identity=verified_source_identity,
                ),
                False,
            )
        if source_watch.changed():
            return (
                _validation_receipt(
                    profile,
                    command_id,
                    argv,
                    "source_identity_mismatch",
                    started,
                    verified_source_identity=verified_source_identity,
                ),
                False,
            )
        process = subprocess.Popen(
            argv,
            executable=bound_executable,
            cwd=bound_working_directory,
            env=child_environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            shell=False,
            start_new_session=True,
            pass_fds=pass_descriptors,
        )
        spawned = time.monotonic()
        _commit_validation_invocation(invocation_reservation)
        committed_reservation = invocation_reservation
        invocation_reservation = None
        _close_validation_invocation_reservation(committed_reservation)

        output = {"stdout": bytearray(), "stderr": bytearray()}
        selector = selectors.DefaultSelector()
        assert process.stdout is not None and process.stderr is not None
        for name, stream in (("stdout", process.stdout), ("stderr", process.stderr)):
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ, name)
        terminal_status: str | None = None
        deadline = spawned + matched["timeoutSeconds"]
        maximum_output = matched["maxOutputBytes"]
        try:
            while selector.get_map():
                if source_watch.changed():
                    terminal_status = "source_identity_mismatch"
                    _terminate_validation_process(process)
                if time.monotonic() >= deadline:
                    terminal_status = terminal_status or "timed_out"
                    _terminate_validation_process(process)
                for key, _mask in selector.select(timeout=0.05):
                    chunk = os.read(key.fileobj.fileno(), 65_536)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    target = output[key.data]
                    remaining = maximum_output + 1 - sum(
                        len(value) for value in output.values()
                    )
                    if remaining > 0:
                        target.extend(chunk[:remaining])
                    if sum(len(value) for value in output.values()) > maximum_output:
                        terminal_status = terminal_status or "output_limit_exceeded"
                        _terminate_validation_process(process)
                if terminal_status is not None and process.poll() is not None:
                    for key in list(selector.get_map().values()):
                        selector.unregister(key.fileobj)
            remaining = max(0.0, deadline - time.monotonic())
            try:
                return_code = process.wait(timeout=remaining)
            except subprocess.TimeoutExpired:
                terminal_status = terminal_status or "timed_out"
                _terminate_validation_process(process)
                return_code = process.wait()
        except Exception:
            _terminate_validation_process(process)
            process.wait()
            terminal_status = terminal_status or "failed"
            return_code = process.returncode
        finally:
            selector.close()
            process.stdout.close()
            process.stderr.close()
        if (
            source_watch.changed()
            or _verified_validation_source_identity(
                bound_working_directory, (directory_descriptor,)
            )
            != profile["sourceIdentity"]
        ):
            terminal_status = "source_identity_mismatch"
        if terminal_status is None:
            terminal_status = "succeeded" if return_code == 0 else "failed"
        bounded_stdout = bytes(output["stdout"])
        bounded_stderr = bytes(output["stderr"])
        overflow = max(0, len(bounded_stdout) + len(bounded_stderr) - maximum_output)
        if overflow:
            if overflow <= len(bounded_stderr):
                bounded_stderr = bounded_stderr[:-overflow]
            else:
                overflow -= len(bounded_stderr)
                bounded_stderr = b""
                bounded_stdout = bounded_stdout[:-overflow]
        receipt = _validation_receipt(
            profile,
            command_id,
            argv,
            terminal_status,
            started,
            exit_code=return_code,
            stdout=bounded_stdout,
            stderr=bounded_stderr,
            verified_source_identity=verified_source_identity,
        )
        return receipt, terminal_status == "succeeded"
    except (OSError, RuntimeError):
        if process is not None and process.poll() is None:
            _terminate_validation_process(process)
            process.wait()
        return (
            _validation_receipt(
                profile,
                command_id,
                argv,
                "rejected",
                started,
                verified_source_identity=verified_source_identity,
            ),
            False,
        )
    finally:
        if invocation_reservation is not None:
            _close_validation_invocation_reservation(invocation_reservation)
        if source_watch is not None:
            source_watch.close()
        os.close(executable_descriptor)
        os.close(directory_descriptor)


def managed_display_provider(adapter_provider: object) -> str:
    """Return the provider label to show for the managed inference adapter.

    Managed inference normally routes through the OpenAI-compatible adapter, and
    OpenRouter routes through Deep Agents Code's native OpenRouter adapter while
    still targeting the managed ``inference.local`` gateway. Substitute the
    onboard-selected upstream provider so status surfaces match the launch page.
    NVIDIA and OpenRouter aliases share canonical display families.
    """
    adapter = adapter_provider if isinstance(adapter_provider, str) else ""
    if adapter not in _MANAGED_ADAPTER_PROVIDERS:
        return adapter

    upstream = os.environ.get(_UPSTREAM_PROVIDER_ENV, "")
    if _DISPLAY_PROVIDER_NAME.fullmatch(upstream) is None:
        return adapter
    if upstream in _NVIDIA_DISPLAY_PROVIDER_ALIASES:
        return "nvidia"
    if upstream in _OPENROUTER_DISPLAY_PROVIDER_ALIASES:
        return "openrouter"
    return upstream


def assert_safe_runtime() -> None:
    """Reject unmanaged runtime credentials before dcode bootstraps settings."""
    _assert_safe_environment()
    _assert_safe_auth_state()
    managed_validation_profile()
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
