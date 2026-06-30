#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Validate the Hermes secret boundary on a .env file or the current process environment.

This is the single source of truth for the documented Hermes secret-boundary
contract. ``start.sh`` invokes the ``env-file`` and ``runtime-env`` subcommands at
sandbox startup, and the host-side gateway recovery path
(``src/lib/agent/runtime.ts:buildRecoveryScript``) invokes the same script before
relaunching the Hermes gateway so the boundary survives ``sandbox recover`` /
``connect --probe-only``.

Exits 0 when the input passes the boundary, 1 when raw secret-shaped values are
present (emitting ``[SECURITY]`` lines on stderr that match the rest of the
gateway startup error contract).
"""

from __future__ import annotations

import argparse
import errno
import os
import re
import stat
import sys
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
ALLOWED_LITERALS = frozenset({"", "[STRIPPED_BY_MIGRATION]"})


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


def _emit_violations(prefix: str, violations: Iterable[str]) -> None:
    print(prefix, file=sys.stderr)
    for item in violations:
        print(f"[SECURITY]   {item}", file=sys.stderr)


def _no_follow_opener(path: str, flags: int) -> int:
    return os.open(
        path,
        flags | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0),
    )


def validate_env_file(path: str) -> int:
    # Open the file with O_NOFOLLOW so a symlink swapped in between any earlier
    # lstat check and this read cannot redirect validation to an attacker-chosen
    # target. fstat then confirms the descriptor still points at a regular file
    # before we parse it, closing the static islink + open(path) TOCTOU gap.
    # The `open(... opener=_no_follow_opener)` form delegates fd ownership to
    # the file object's context manager, so any early-exit path closes the
    # descriptor without an explicit try/finally raw-fd dance.
    violations: list[str] = []
    try:
        fh = open(path, "r", encoding="utf-8", opener=_no_follow_opener)
    except FileNotFoundError:
        return 0
    except OSError as exc:
        if exc.errno in (errno.ELOOP, errno.EMLINK):
            print(
                f"[SECURITY] Refusing Hermes startup because {path} is a symlink",
                file=sys.stderr,
            )
            return 1
        raise
    with fh:
        st = os.fstat(fh.fileno())
        if not stat.S_ISREG(st.st_mode):
            print(
                f"[SECURITY] Refusing Hermes startup because {path} is not a regular file",
                file=sys.stderr,
            )
            return 1
        for lineno, raw_line in enumerate(fh, 1):
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
            if key in ENV_FILE_ALLOWED_RAW_SECRET_KEYS and is_allowed_raw_secret_value(key, value):
                continue
            if not SECRET_KEY_RE.search(key):
                continue
            if is_allowed_value(unquote(value)):
                continue
            violations.append(f"{key} (line {lineno})")
    if not violations:
        return 0
    _emit_violations(
        "[SECURITY] Refusing Hermes startup because /sandbox/.hermes/.env "
        "contains raw secret-shaped values. Store credentials in OpenShell "
        "providers and keep only openshell resolver placeholders in the sandbox.",
        violations,
    )
    return 1


def validate_runtime_env(env: dict[str, str] | None = None) -> int:
    source = os.environ if env is None else env
    violations: list[str] = []
    for key, value in sorted(source.items()):
        if key in RUNTIME_ALLOWED_NONSECRET_KEYS:
            continue
        if key in RUNTIME_ALLOWED_RAW_SECRET_KEYS and is_allowed_raw_secret_value(key, value):
            continue
        if not KEY_NAME_RE.fullmatch(key):
            continue
        if not SECRET_KEY_RE.search(key):
            continue
        if is_allowed_value(value):
            continue
        violations.append(key)
    if not violations:
        return 0
    _emit_violations(
        "[SECURITY] Refusing Hermes startup because the process environment "
        "contains raw secret-shaped values. Store credentials in OpenShell "
        "providers and keep only openshell resolver placeholders in the sandbox.",
        violations,
    )
    return 1


# Scope: this masker is keyed off recognised credential-shaped FIELD NAMES in
# structured config output (Python dict, JSON, YAML key:value, env-style
# key=value). As a defence-in-depth catch-all, free-form `sk-` prefixed tokens
# (length >= 8 to avoid false-positives on legitimate short identifiers) are
# also redacted on every line so the `buildHermesConfig` placeholder and any
# real `sk-` value that escapes into a diagnostic cannot leak. Non-`sk-` token
# families (e.g. `xoxb-`, `nvapi-`) in prose are not scanned — the wrapper's
# threat model is the `hermes config show` resolved-config rendering, which
# emits secrets via labelled fields; broader prose redaction is the upstream
# Hermes CLI's responsibility.
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


_MAX_INPUT_BYTES = 4 * 1024 * 1024


def mask_config_output(stream_in: TextIO, stream_out: TextIO) -> int:
    # Force strict UTF-8 decoding so attacker-controlled bytes that survive a
    # surrogateescape-tolerant default cannot reach the regex layer as undecoded
    # surrogates. Without this, `for line in sys.stdin` accepts arbitrary bytes
    # when the inherited locale is POSIX and we lose the fail-closed property
    # the wrapper relies on.
    if hasattr(stream_in, "reconfigure"):
        stream_in.reconfigure(errors="strict")
    # Tracks indentation of an in-flight YAML block scalar that begins with a
    # secret-shaped key (key: | or key: >). Every continuation line — indented
    # past the header or blank — is replaced with the placeholder so multi-line
    # secrets cannot leak.
    #
    # Trade-off: continuation lines are emitted with a fixed two-space indent
    # below the header and any blank lines inside the block are also masked
    # (rather than preserved). Both choices favour masking over structural
    # fidelity: the resulting text remains valid YAML and reveals nothing about
    # the secret's length or layout. Downstream callers consuming `config show`
    # for human display can absorb the cosmetic difference; programmatic
    # callers should query the gateway provider list instead of parsing this
    # output.
    #
    # Buffer all output in memory and write only on success. If masking raises
    # mid-stream, nothing reaches `stream_out`, so a partial raw secret cannot
    # leak through an aborted run.
    #
    # Bound the input at _MAX_INPUT_BYTES (4 MiB) so an upstream regression
    # that streams an unbounded buffer through this filter fails closed instead
    # of consuming all sandbox memory. Hermes' resolved config is kilobytes;
    # exceeding the cap signals something has gone wrong upstream.
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
        if total_bytes > _MAX_INPUT_BYTES:
            print(
                "[SECURITY] Refusing hermes config show: masker input exceeded "
                f"{_MAX_INPUT_BYTES} bytes",
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
    parser = argparse.ArgumentParser(prog="validate-hermes-env-secret-boundary")
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
    assert args.mode == "runtime-env", f"unreachable: argparse subparsers are required ({args.mode!r})"
    return validate_runtime_env()


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
