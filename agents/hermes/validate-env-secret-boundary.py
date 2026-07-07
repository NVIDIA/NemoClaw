#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Validate the Hermes secret boundary on a .env file or the current process environment.

This is the single source of truth for the documented Hermes secret-boundary
contract. ``start.sh`` invokes the ``env-file`` and ``runtime-env`` subcommands
at sandbox startup and again from its root-owned PID 1 lifecycle handler before
relaunching Hermes, so the boundary survives ``recover`` and probe-triggered
recovery.

Exits 0 when the input passes the boundary, 1 when raw secret-shaped values are
present (emitting ``[SECURITY]`` lines on stderr that match the rest of the
gateway startup error contract).
"""

from __future__ import annotations

import argparse
import errno
import grp
import os
import pwd
import re
import stat
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Iterable, TextIO

SECRET_KEY_RE = re.compile(r"(^|_)(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|API)(_|$)")
PLACEHOLDER_RE = re.compile(r"^(xoxb|xapp)-OPENSHELL-RESOLVE-ENV-[A-Z0-9_]+$")
KEY_NAME_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
API_SERVER_KEY_RE = re.compile(r"^[0-9a-f]{64}$")

ENV_FILE_ALLOWED_NONSECRET_KEYS = frozenset({"API_SERVER_HOST", "API_SERVER_PORT"})
# API_SERVER_KEY is the bearer token Hermes' own api_server (Hermes v0.16.0+)
# reads for its loopback bind. NemoClaw mints it at sandbox startup; it is not
# an external-service credential routed through the OpenShell resolver. It
# authenticates clients reaching the 127.0.0.1 api_server (and the forwarded
# port), so the gateway must read it raw and it legitimately lives in .env. This
# mirrors the OPENCLAW_GATEWAY_TOKEN allowance below, but only for the generated
# 32-byte lowercase-hex shape minted by the runtime config guard.
ENV_FILE_ALLOWED_RAW_SECRET_KEYS = frozenset({"API_SERVER_KEY"})
RUNTIME_ALLOWED_NONSECRET_KEYS = frozenset(
    {
        "API_SERVER_HOST",
        "API_SERVER_PORT",
        "GPG_KEY",
        "NEMOCLAW_INFERENCE_API",
        "NEMOCLAW_PROVIDER_KEY",
    }
)
RUNTIME_ALLOWED_RAW_SECRET_KEYS = frozenset({"OPENCLAW_GATEWAY_TOKEN"})
# OpenShell's Docker/Podman supervisor owns this variable and injects a mounted
# file path, not private-key material. Keep the allowance exact and runtime-only
# so a caller cannot use the secret-shaped name to smuggle an arbitrary value or
# persist it in Hermes' mutable .env file.
RUNTIME_ALLOWED_PLATFORM_PATH_VALUES = frozenset(
    {("OPENSHELL_TLS_KEY", "/etc/openshell/tls/client/tls.key")}
)
ALLOWED_LITERALS = frozenset({"", "[STRIPPED_BY_MIGRATION]"})
MAX_ENV_BYTES = 4 * 1024 * 1024
MAX_ENV_LINE_BYTES = 256 * 1024
MAX_ENV_LINES = 65_536
MAX_VIOLATIONS = 64
INSTALLED_BOUNDARY_VALIDATOR = (
    "/usr/local/lib/nemoclaw/validate-hermes-env-secret-boundary.py"
)
INSTALLED_ENV_ROOT = "/sandbox"
INSTALLED_ENV_PATH = "/sandbox/.hermes/.env"


class UnsafeEnvInputError(RuntimeError):
    """An env path or payload cannot be validated without crossing trust bounds."""


def _directory_identity(st: os.stat_result) -> tuple[int, int, int, int, int]:
    return (
        st.st_dev,
        st.st_ino,
        stat.S_IMODE(st.st_mode),
        st.st_uid,
        st.st_gid,
    )


def _file_identity(
    st: os.stat_result,
) -> tuple[int, int, int, int, int, int, int, int, int]:
    return (
        st.st_dev,
        st.st_ino,
        stat.S_IMODE(st.st_mode),
        st.st_uid,
        st.st_gid,
        st.st_nlink,
        st.st_size,
        st.st_mtime_ns,
        st.st_ctime_ns,
    )


def _allowed_path_owner_uids() -> frozenset[int]:
    allowed = {0, os.geteuid()}
    try:
        allowed.add(pwd.getpwnam("sandbox").pw_uid)
    except KeyError:
        # Minimal development images may not define the sandbox account.
        pass
    return frozenset(allowed)


def _sandbox_identity() -> tuple[int, int] | None:
    try:
        return pwd.getpwnam("sandbox").pw_uid, grp.getgrnam("sandbox").gr_gid
    except KeyError:
        return None


def _validate_env_file_metadata(path: str, st: os.stat_result) -> None:
    if not stat.S_ISREG(st.st_mode):
        raise UnsafeEnvInputError("Hermes env path is not a regular file")
    if st.st_nlink != 1:
        raise UnsafeEnvInputError("Hermes env path is hardlinked")
    mode = stat.S_IMODE(st.st_mode)
    if (
        os.path.abspath(__file__) == INSTALLED_BOUNDARY_VALIDATOR
        and path == INSTALLED_ENV_PATH
    ):
        sandbox_identity = _sandbox_identity()
        allowed = {(0, 0, 0o400), (0, 0, 0o444)}
        if sandbox_identity is not None:
            sandbox_uid, sandbox_gid = sandbox_identity
            # 0640 is the current mutable top-level contract. Keep 0660 only
            # for intentional legacy images whose state-dir unlock predates the
            # top-level runtime guard split.
            allowed.update(
                {
                    (sandbox_uid, sandbox_gid, 0o640),
                    (sandbox_uid, sandbox_gid, 0o660),
                }
            )
        if (st.st_uid, st.st_gid, mode) not in allowed:
            raise UnsafeEnvInputError(
                "Hermes env path does not match a trusted owner/group/mode posture"
            )
        return

    if st.st_uid not in _allowed_path_owner_uids():
        raise UnsafeEnvInputError("Hermes env path has an untrusted owner")
    if mode & 0o022:
        raise UnsafeEnvInputError("Hermes env path is group/world-writable")


def _validate_directory_descriptor(path: str, fd: int) -> tuple[int, int, int, int, int]:
    st = os.fstat(fd)
    if not stat.S_ISDIR(st.st_mode):
        raise UnsafeEnvInputError(f"{path} is not a directory")
    if st.st_uid not in _allowed_path_owner_uids():
        raise UnsafeEnvInputError(f"{path} has an untrusted owner")
    mode = stat.S_IMODE(st.st_mode)
    if os.path.abspath(__file__) == INSTALLED_BOUNDARY_VALIDATOR:
        sandbox_identity = _sandbox_identity()
        if path == INSTALLED_ENV_ROOT:
            allowed = {(0, 0, 0o700), (0, 0, 0o755)}
            if sandbox_identity is not None:
                sandbox_uid, sandbox_gid = sandbox_identity
                allowed.update(
                    {
                        (sandbox_uid, sandbox_gid, 0o755),
                        (sandbox_uid, sandbox_gid, 0o770),
                        (0, sandbox_gid, 0o1775),
                    }
                )
            if (st.st_uid, st.st_gid, mode) not in allowed:
                raise UnsafeEnvInputError(
                    "/sandbox does not match a trusted owner/group/mode posture"
                )
        elif path == os.path.dirname(INSTALLED_ENV_PATH):
            allowed = {(0, 0, 0o500), (0, 0, 0o700), (0, 0, 0o755)}
            if sandbox_identity is not None:
                sandbox_uid, sandbox_gid = sandbox_identity
                allowed.update(
                    {
                        (sandbox_uid, sandbox_gid, 0o700),
                        (sandbox_uid, sandbox_gid, 0o3770),
                    }
                )
            if (st.st_uid, st.st_gid, mode) not in allowed:
                raise UnsafeEnvInputError(
                    "/sandbox/.hermes does not match a trusted owner/group/mode posture"
                )
    if mode & 0o002 and not mode & stat.S_ISVTX:
        raise UnsafeEnvInputError(f"{path} is world-writable without sticky protection")
    return _directory_identity(st)


@contextmanager
def _open_env_path(
    path: str,
) -> Iterator[
    tuple[
        int,
        tuple[int, int, int, int, int, int, int, int, int],
        list[int],
        list[tuple[int, str, int, tuple[int, int, int, int, int]]],
        str,
    ]
]:
    """Yield an env path opened without following any ancestor symlink."""

    if not os.path.isabs(path):
        raise UnsafeEnvInputError("Hermes env path must be absolute")
    # macOS checkout tests commonly live below the root-owned /var ->
    # /private/var compatibility symlink. Resolve that only for the explicit
    # source/dev fallback. The installed root validator never resolves an
    # ancestor symlink supplied as part of the sandbox path.
    installed_mode = os.path.abspath(__file__) == INSTALLED_BOUNDARY_VALIDATOR
    if installed_mode:
        if path != INSTALLED_ENV_PATH:
            raise UnsafeEnvInputError(
                "the installed validator only accepts the canonical Hermes env path"
            )
        normalized = path
        relative = os.path.relpath(normalized, INSTALLED_ENV_ROOT)
        if relative == os.pardir or relative.startswith(f"{os.pardir}{os.sep}"):
            raise UnsafeEnvInputError("Hermes env path escapes the sandbox root")
        components = [component for component in relative.split(os.sep) if component]
    else:
        normalized = os.path.join(
            os.path.realpath(os.path.dirname(path)), os.path.basename(path)
        )
        components = [component for component in normalized.split(os.sep) if component]
    if not components:
        raise UnsafeEnvInputError("Hermes env path has no file component")

    nofollow = getattr(os, "O_NOFOLLOW", 0)
    cloexec = getattr(os, "O_CLOEXEC", 0)
    directory_flags = os.O_RDONLY | os.O_DIRECTORY | nofollow | cloexec
    file_flags = os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | nofollow | cloexec
    directory_fds: list[int] = []
    chain: list[tuple[int, str, int, tuple[int, int, int, int, int]]] = []
    file_fd = -1
    try:
        # CodeQL cannot associate the dynamic descriptor stack with the close
        # loop below. Register each descriptor immediately, and close it here
        # too if list growth itself fails before ownership transfers.
        root_path = INSTALLED_ENV_ROOT if installed_mode else os.sep
        root_fd = os.open(root_path, directory_flags)  # codeql[py/file-not-closed]
        try:
            directory_fds.append(root_fd)
        except BaseException:
            os.close(root_fd)
            raise
        root_identity = _validate_directory_descriptor(root_path, root_fd)
        if installed_mode:
            # Landlock intentionally prevents the sandbox user from opening
            # `/`. Pin and revalidate the directly-opened `/sandbox` anchor;
            # its parent is not writable from inside the sandbox, so the entry
            # itself cannot be replaced by the caller.
            chain.append((root_fd, ".", root_fd, root_identity))
        current_fd = root_fd
        display = INSTALLED_ENV_ROOT if installed_mode else ""
        for component in components[:-1]:
            display = f"{display}/{component}"
            child_fd = os.open(  # codeql[py/file-not-closed]
                component, directory_flags, dir_fd=current_fd
            )
            try:
                directory_fds.append(child_fd)
            except BaseException:
                os.close(child_fd)
                raise
            identity = _validate_directory_descriptor(display, child_fd)
            chain.append((current_fd, component, child_fd, identity))
            current_fd = child_fd

        basename = components[-1]
        file_fd = os.open(basename, file_flags, dir_fd=current_fd)
        file_st = os.fstat(file_fd)
        _validate_env_file_metadata(normalized, file_st)
        if file_st.st_size > MAX_ENV_BYTES:
            raise UnsafeEnvInputError(
                f"Hermes env path exceeds the {MAX_ENV_BYTES}-byte limit"
            )
        yield file_fd, _file_identity(file_st), directory_fds, chain, basename
    finally:
        if file_fd != -1:
            os.close(file_fd)
        for fd in reversed(directory_fds):
            os.close(fd)


def _read_bounded_env(fd: int, expected_identity: tuple[int, ...]) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = os.read(fd, min(1024 * 1024, MAX_ENV_BYTES + 1 - total))
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_ENV_BYTES:
            raise UnsafeEnvInputError(
                f"Hermes env path exceeds the {MAX_ENV_BYTES}-byte limit"
            )
        chunks.append(chunk)
    if _file_identity(os.fstat(fd)) != expected_identity:
        raise UnsafeEnvInputError("Hermes env path changed while it was read")
    return b"".join(chunks)


def _verify_env_path_chain(
    file_fd: int,
    expected_file_identity: tuple[int, ...],
    final_directory_fd: int,
    chain: list[tuple[int, str, int, tuple[int, int, int, int, int]]],
    basename: str,
) -> None:
    for parent_fd, component, child_fd, expected in chain:
        if _directory_identity(os.fstat(child_fd)) != expected:
            raise UnsafeEnvInputError("Hermes env ancestor metadata changed")
        current = os.stat(component, dir_fd=parent_fd, follow_symlinks=False)
        if not stat.S_ISDIR(current.st_mode) or _directory_identity(current) != expected:
            raise UnsafeEnvInputError("Hermes env ancestor changed while it was read")
    current_file = os.stat(
        basename, dir_fd=final_directory_fd, follow_symlinks=False
    )
    if (
        not stat.S_ISREG(current_file.st_mode)
        or _file_identity(current_file) != expected_file_identity
        or _file_identity(os.fstat(file_fd)) != expected_file_identity
    ):
        raise UnsafeEnvInputError("Hermes env path changed while it was read")


def unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        return value[1:-1]
    return value


def is_allowed_value(value: str) -> bool:
    if value in ALLOWED_LITERALS:
        return True
    if value.startswith("openshell:resolve:env:"):
        return True
    if PLACEHOLDER_RE.fullmatch(value):
        return True
    return False


def is_generated_api_server_key(value: str) -> bool:
    return API_SERVER_KEY_RE.fullmatch(unquote(value)) is not None


def is_allowed_raw_secret_value(key: str, value: str) -> bool:
    if key == "OPENCLAW_GATEWAY_TOKEN":
        return True
    if key == "API_SERVER_KEY":
        return is_generated_api_server_key(value)
    return False


def _emit_violations(
    prefix: str, violations: Iterable[str], omitted_violations: int = 0
) -> None:
    print(prefix, file=sys.stderr)
    for item in violations:
        print(f"[SECURITY]   {item}", file=sys.stderr)
    if omitted_violations > 0:
        print(
            f"[SECURITY]   {omitted_violations} additional violation(s) omitted",
            file=sys.stderr,
        )


def validate_env_file(path: str) -> int:
    try:
        with _open_env_path(path) as (
            file_fd,
            file_identity,
            directory_fds,
            chain,
            basename,
        ):
            try:
                raw = _read_bounded_env(file_fd, file_identity)
                _verify_env_path_chain(
                    file_fd, file_identity, directory_fds[-1], chain, basename
                )
            except (OSError, UnsafeEnvInputError) as exc:
                print(
                    f"[SECURITY] Refusing Hermes startup because the env path could not be read safely: {exc}",
                    file=sys.stderr,
                )
                return 1
    except FileNotFoundError:
        print(
            "[SECURITY] Refusing Hermes startup because the expected env path disappeared",
            file=sys.stderr,
        )
        return 1
    except OSError as exc:
        detail = (
            "a symlink or non-directory ancestor"
            if exc.errno in (errno.ELOOP, errno.EMLINK, errno.ENOTDIR)
            else "an unreadable path component"
        )
        print(
            f"[SECURITY] Refusing Hermes startup because the env path contains {detail}",
            file=sys.stderr,
        )
        return 1
    except UnsafeEnvInputError as exc:
        print(f"[SECURITY] Refusing Hermes startup because {exc}", file=sys.stderr)
        return 1

    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        print(
            "[SECURITY] Refusing Hermes startup because the env file is not valid UTF-8",
            file=sys.stderr,
        )
        return 1
    lines = text.splitlines()
    if len(lines) > MAX_ENV_LINES:
        print(
            f"[SECURITY] Refusing Hermes startup because the env file exceeds the {MAX_ENV_LINES}-line limit",
            file=sys.stderr,
        )
        return 1
    if any(len(line.encode("utf-8")) > MAX_ENV_LINE_BYTES for line in lines):
        print(
            f"[SECURITY] Refusing Hermes startup because an env line exceeds the {MAX_ENV_LINE_BYTES}-byte limit",
            file=sys.stderr,
        )
        return 1

    violations: list[str] = []
    violation_count = 0
    for lineno, raw_line in enumerate(lines, 1):
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        if stripped.startswith("export "):
            stripped = stripped[len("export ") :].lstrip()
        key, value = stripped.split("=", 1)
        key = key.strip()
        if not KEY_NAME_RE.fullmatch(key):
            continue
        if key in ENV_FILE_ALLOWED_NONSECRET_KEYS:
            continue
        if key in ENV_FILE_ALLOWED_RAW_SECRET_KEYS and is_allowed_raw_secret_value(
            key, value
        ):
            continue
        if not SECRET_KEY_RE.search(key):
            continue
        if is_allowed_value(unquote(value)):
            continue
        violation_count += 1
        if len(violations) < MAX_VIOLATIONS:
            violations.append(f"{key} (line {lineno})")
    if not violations:
        return 0
    _emit_violations(
        "[SECURITY] Refusing Hermes startup because /sandbox/.hermes/.env "
        "contains raw secret-shaped values. Store credentials in OpenShell "
        "providers and keep only openshell resolver placeholders in the sandbox.",
        violations,
        violation_count - len(violations),
    )
    return 1


def validate_runtime_env(env: dict[str, str] | None = None) -> int:
    source = os.environ if env is None else env
    violations: list[str] = []
    violation_count = 0
    for key, value in sorted(source.items()):
        if key in RUNTIME_ALLOWED_NONSECRET_KEYS:
            continue
        if key in RUNTIME_ALLOWED_RAW_SECRET_KEYS and is_allowed_raw_secret_value(
            key, value
        ):
            continue
        if (key, value) in RUNTIME_ALLOWED_PLATFORM_PATH_VALUES:
            continue
        if not KEY_NAME_RE.fullmatch(key):
            continue
        if not SECRET_KEY_RE.search(key):
            continue
        if is_allowed_value(value):
            continue
        violation_count += 1
        if len(violations) < MAX_VIOLATIONS:
            violations.append(key)
    if not violations:
        return 0
    _emit_violations(
        "[SECURITY] Refusing Hermes startup because the process environment "
        "contains raw secret-shaped values. Store credentials in OpenShell "
        "providers and keep only openshell resolver placeholders in the sandbox.",
        violations,
        violation_count - len(violations),
    )
    return 1


# Config-output masking layer for the wrapper-installed `hermes config show`
# path. The upstream Hermes CLI prints inline provider `api_key` values verbatim
# when asked to render the resolved configuration, so the wrapper pipes the
# stdout/stderr streams through this masker to redact structured secret fields
# and any free-form `sk-`-prefixed token.
#
# Scope: structured key-labelled secret fields (api_key, api_secret,
# access_token, auth_token, client_secret, secret_key, secret, token, password,
# bearer, authorization, credential — including hyphen/underscore/camelCase
# variants) in Python-dict, JSON, YAML key:value, env-style key=value, and YAML
# block-scalar shapes; plus, as defence in depth, every free-form
# `sk-`-prefixed token of length >= 8. Non-`sk-` token families in free prose
# are not redacted — that is the upstream Hermes CLI's responsibility, since
# the wrapper's user-facing contract is `config show` output rather than
# ambient telemetry.
_SECRET_FIELD_RE = re.compile(
    r"(?i)\b(?:api[_-]?keys?|api[_-]?secrets?|access[_-]?tokens?|auth[_-]?tokens?|"
    r"client[_-]?secrets?|secret[_-]?keys?|"
    r"authorization|bearer|credentials?|passwords?|secrets?|tokens?)\b"
)
_MASK_PY = "sk-****"
# Quoted variants accept escaped delimiters via `(?:[^'\\]|\\.)*`.
# Unquoted variant covers YAML/env (key: value or key=value) and preserves trailing comments.
_PY_DICT_RE = re.compile(
    r"(?P<lead>'(?P<key>[A-Za-z_][A-Za-z0-9_-]*)'[ \t]*:[ \t]*)'(?:[^'\\]|\\.)*'"
)
_JSON_RE = re.compile(
    r"(?P<lead>\"(?P<key>[A-Za-z_][A-Za-z0-9_-]*)\"[ \t]*:[ \t]*)\"(?:[^\"\\]|\\.)*\""
)
# ReDoS analysis: every quantifier carries an explicit upper bound so the
# engine cannot do quadratic work on a hostile line. The key class is capped
# at 128 chars (real config keys are short identifiers; an oversized identifier
# is not a key we'd mask anyway). The value alternation bounds the unquoted
# tail at 128 KiB, well below the masker's 4 MiB input cap. Quoted alternates
# use the textbook `[^"\\]|\\.` / `[^'\\]|\\.` shape that is non-catastrophic.
# These bounds turn the failing-no-delimiter case from O(n^2) to O(n).
_UNQUOTED_RE = re.compile(
    r"(?P<lead>(?P<key>[A-Za-z_][A-Za-z0-9_-]{0,127})[ \t]*[:=][ \t]*)"
    r"(?P<value>\"(?:[^\"\\]|\\.){0,131071}\"|'(?:[^'\\]|\\.){0,131071}'|[^ \t\r\n#][^\r\n#]{0,131071}?)"
    r"(?P<trail>[ \t]*(?:#.*)?)$"
)
# YAML block scalar header: `key: |` / `key: >` with optional chomping (`|-`, `|+`)
# and an indent indicator (1-9 per YAML 1.2). Both orders of chomping vs indent
# are accepted (e.g. `|2-` and `|-2`), and multi-digit shapes are tolerated even
# though the spec forbids them, on the principle that a permissive matcher here
# fails closed — an unmatched header means the body would otherwise be scanned
# line-by-line and could leak a non-`sk-` secret.
_MULTILINE_HEADER_RE = re.compile(
    r"(?P<indent>[ \t]*)(?P<key>[A-Za-z_][A-Za-z0-9_-]*)[ \t]*:[ \t]*"
    r"[|>](?:[-+]?\d+|\d+[-+]?|[-+])?[ \t]*$"
)
# Free-form catch-all: any `sk-` prefix followed by 8+ identifier-safe chars.
# The 8-char floor prevents collisions with short legitimate identifiers while
# still catching every realistic OpenAI-style key (sk-... typically >= 32) and
# the `sk-OPENSHELL-PROXY-REWRITE` placeholder this wrapper exists to redact.
_FREEFORM_SK_RE = re.compile(r"sk-[A-Za-z0-9_-]{8,}")

_MASK_MAX_INPUT_BYTES = 4 * 1024 * 1024


def _is_secret_field(name: str) -> bool:
    return bool(_SECRET_FIELD_RE.search(name))


def _mask_pyjson(match: "re.Match[str]") -> str:
    if not _is_secret_field(match.group("key")):
        return match.group(0)
    quote = "'" if match.group(0).startswith("'") or "'" in match.group("lead")[-2:] else "\""
    return f"{match.group('lead')}{quote}{_MASK_PY}{quote}"


def _mask_unquoted(match: "re.Match[str]") -> str:
    if not _is_secret_field(match.group("key")):
        return match.group(0)
    return f"{match.group('lead')}{_MASK_PY}{match.group('trail')}"


def mask_config_output(stream_in: TextIO, stream_out: TextIO) -> int:
    # Force strict UTF-8 decoding so attacker-controlled bytes that survive a
    # surrogateescape-tolerant default cannot reach the regex layer as
    # undecoded surrogates. Without this, `for line in sys.stdin` accepts
    # arbitrary bytes when the inherited locale is POSIX and we lose the
    # fail-closed property the wrapper relies on.
    if hasattr(stream_in, "reconfigure"):
        stream_in.reconfigure(errors="strict")
    # Tracks indentation of an in-flight YAML block scalar that begins with a
    # secret-shaped key (key: | or key: >). Every continuation line —
    # indented past the header or blank — is replaced with the placeholder so
    # multi-line secrets cannot leak.
    #
    # Trade-off: continuation lines are emitted with a fixed two-space indent
    # below the header and any blank lines inside the block are also masked
    # (rather than preserved). Both choices favour masking over structural
    # fidelity: the resulting text remains valid YAML and reveals nothing
    # about the secret's length or layout. Downstream callers consuming
    # `config show` for human display can absorb the cosmetic difference;
    # programmatic callers should query the gateway provider list instead of
    # parsing this output.
    #
    # Buffer all output in memory and write only on success. If masking
    # raises mid-stream, nothing reaches `stream_out`, so a partial raw
    # secret cannot leak through an aborted run.
    #
    # Bound the input at _MASK_MAX_INPUT_BYTES (4 MiB) so an upstream
    # regression that streams an unbounded buffer through this filter fails
    # closed instead of consuming all sandbox memory. Hermes' resolved config
    # is kilobytes; exceeding the cap signals something has gone wrong
    # upstream.
    masked_chunks: list[str] = []
    block_indent: int | None = None
    total_bytes = 0
    while True:
        try:
            line = stream_in.readline()
        except UnicodeDecodeError:
            print(
                "[SECURITY] Refusing hermes config show: masker input is not valid UTF-8",
                file=sys.stderr,
            )
            return 1
        if not line:
            break
        total_bytes += len(line.encode("utf-8", errors="replace"))
        if total_bytes > _MASK_MAX_INPUT_BYTES:
            print(
                "[SECURITY] Refusing hermes config show: masker input exceeded "
                f"{_MASK_MAX_INPUT_BYTES} bytes",
                file=sys.stderr,
            )
            return 1
        stripped = line.lstrip()
        rstripped = line.rstrip("\r\n")
        line_indent = len(line) - len(stripped)
        if block_indent is not None:
            if rstripped == "" or line_indent > block_indent:
                masked_chunks.append(f"{' ' * (block_indent + 2)}{_MASK_PY}\n")
                continue
            block_indent = None
        if stripped.startswith("#"):
            masked_chunks.append(line)
            continue
        header = _MULTILINE_HEADER_RE.match(line.rstrip("\r\n"))
        if header and _is_secret_field(header.group("key")):
            block_indent = len(header.group("indent"))
            masked_chunks.append(line)
            continue
        masked = line
        if ":" in line:
            masked = _PY_DICT_RE.sub(_mask_pyjson, masked)
            masked = _JSON_RE.sub(_mask_pyjson, masked)
        if ":" in masked or "=" in masked:
            masked = _UNQUOTED_RE.sub(_mask_unquoted, masked)
        if "sk-" in masked:
            masked = _FREEFORM_SK_RE.sub(_MASK_PY, masked)
        masked_chunks.append(masked)
    stream_out.write("".join(masked_chunks))
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="validate-env-secret-boundary")
    sub = parser.add_subparsers(dest="mode", required=True)
    env_file_parser = sub.add_parser(
        "env-file",
        help="Validate a Hermes .env file at the given path",
    )
    env_file_parser.add_argument("path", help="Path to the .env file to validate")
    sub.add_parser(
        "runtime-env",
        help="Validate the current process environment",
    )
    sub.add_parser(
        "mask-config-output",
        help="Mask secret-shaped fields on stdin; print to stdout",
    )
    args = parser.parse_args(argv)
    if args.mode == "env-file":
        return validate_env_file(args.path)
    if args.mode == "mask-config-output":
        return mask_config_output(sys.stdin, sys.stdout)
    assert args.mode == "runtime-env", (
        f"unreachable: argparse subparsers are required ({args.mode!r})"
    )
    return validate_runtime_env()


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
