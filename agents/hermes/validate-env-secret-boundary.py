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
import os
import re
import sys
from typing import Iterable

SECRET_KEY_RE = re.compile(r"(^|_)(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|API)(_|$)")
PLACEHOLDER_RE = re.compile(r"^(xoxb|xapp)-OPENSHELL-RESOLVE-ENV-[A-Z0-9_]+$")
KEY_NAME_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")

ENV_FILE_ALLOWED_NONSECRET_KEYS = frozenset({"API_SERVER_HOST", "API_SERVER_PORT"})
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


def _emit_violations(prefix: str, violations: Iterable[str]) -> None:
    print(prefix, file=sys.stderr)
    for item in violations:
        print(f"[SECURITY]   {item}", file=sys.stderr)


def validate_env_file(path: str) -> int:
    violations: list[str] = []
    try:
        with open(path, encoding="utf-8") as fh:
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
                if not SECRET_KEY_RE.search(key):
                    continue
                if is_allowed_value(unquote(value)):
                    continue
                violations.append(f"{key} (line {lineno})")
    except FileNotFoundError:
        return 0
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
        if key in RUNTIME_ALLOWED_RAW_SECRET_KEYS or key in RUNTIME_ALLOWED_NONSECRET_KEYS:
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
    args = parser.parse_args(argv)
    if args.mode == "env-file":
        return validate_env_file(args.path)
    if args.mode == "runtime-env":
        return validate_runtime_env()
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
