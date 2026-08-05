# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Read the versioned policy manifest emitted by the Hermes TypeScript model."""

from __future__ import annotations

import errno
import json
import os
import stat
from pathlib import Path

MANAGED_POLICY_PATH = Path("/usr/local/share/nemoclaw/hermes-managed-policy.json")
MANAGED_POLICY_SCHEMA_VERSION = 1
HERMES_PROXY_REWRITE_SENTINEL = "sk-OPENSHELL-PROXY-REWRITE"


class ManagedPolicyError(Exception):
    pass


def _read_regular_text_no_follow(path: Path) -> str:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd = -1
    try:
        fd = os.open(path, flags)
        file_stat = os.fstat(fd)
        if not stat.S_ISREG(file_stat.st_mode):
            raise ManagedPolicyError("managed policy is not a regular file")
        with os.fdopen(fd, "r", encoding="utf-8", closefd=False) as handle:
            return handle.read()
    except OSError as exc:
        if exc.errno == errno.ELOOP:
            raise ManagedPolicyError("managed policy is a symlink") from exc
        raise ManagedPolicyError("managed policy is unreadable") from exc
    finally:
        if fd >= 0:
            try:
                os.close(fd)
            except OSError:
                pass


def _string_list(value: object, label: str) -> list[str]:
    if (
        not isinstance(value, list)
        or not value
        or not all(isinstance(item, str) and item for item in value)
        or len(set(value)) != len(value)
    ):
        raise ManagedPolicyError(f"{label} must be a non-empty list of unique strings")
    return value


def load_managed_policy(path: Path = MANAGED_POLICY_PATH) -> dict:
    try:
        document = json.loads(_read_regular_text_no_follow(path))
    except json.JSONDecodeError as exc:
        raise ManagedPolicyError("managed policy is malformed") from exc
    if not isinstance(document, dict):
        raise ManagedPolicyError("managed policy must be a mapping")
    if set(document) != {
        "schema_version",
        "config",
        "env_lines",
        "dashboard",
        "managed_paths",
    }:
        raise ManagedPolicyError("managed policy has an unexpected top-level shape")
    version = document.get("schema_version")
    if version != MANAGED_POLICY_SCHEMA_VERSION:
        raise ManagedPolicyError(
            f"managed policy schema {version!r} has no migration to "
            f"{MANAGED_POLICY_SCHEMA_VERSION}"
        )
    if not isinstance(document.get("config"), dict):
        raise ManagedPolicyError("managed policy config must be a mapping")
    _string_list(document.get("env_lines"), "managed policy env_lines")
    dashboard = document.get("dashboard")
    if not isinstance(dashboard, dict) or set(dashboard) != {
        "routing_keys",
        "env_keys",
    }:
        raise ManagedPolicyError("managed policy dashboard has an unexpected shape")
    for key in ("routing_keys", "env_keys"):
        _string_list(dashboard.get(key), f"managed policy dashboard.{key}")
    managed_paths = _string_list(
        document.get("managed_paths"),
        "managed policy managed_paths",
    )
    config = document["config"]
    if policy_value(config, "model.api_key") != HERMES_PROXY_REWRITE_SENTINEL:
        raise ManagedPolicyError(
            "managed policy model.api_key must use the OpenShell proxy rewrite sentinel"
        )
    for managed_path in managed_paths:
        policy_value(config, managed_path)
    for key in dashboard["routing_keys"]:
        if key not in config:
            raise ManagedPolicyError(f"managed policy config is missing {key}")
    return document


def policy_value(config: dict, dotted_path: str) -> object:
    value: object = config
    for segment in dotted_path.split("."):
        if not isinstance(value, dict) or segment not in value:
            raise ManagedPolicyError(f"managed policy is missing {dotted_path}")
        value = value[segment]
    return value


def profile_default_values(policy: dict) -> dict[str, object]:
    config = policy["config"]
    return {
        path: policy_value(config, path)
        for path in policy["managed_paths"]
    }
