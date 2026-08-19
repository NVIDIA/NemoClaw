# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Decide whether one exact Hermes command is the reviewed unattended action."""

from __future__ import annotations

import json
import os
import stat
from pathlib import Path

POLICY_PATH = Path("/usr/local/share/nemoclaw/hermes-unattended-approval-policy.json")
REVIEWED_COMMAND = "/usr/local/lib/nemoclaw/hermes-wikidata-reference-read"
_MAX_POLICY_BYTES = 8_192


def _load_policy(
    path: Path,
    *,
    trusted_uid: int = 0,
    trusted_gid: int = 0,
) -> tuple[str, str]:
    if not hasattr(os, "O_NOFOLLOW"):
        raise ValueError("platform cannot reject policy symlinks")
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | os.O_NOFOLLOW
    descriptor = os.open(path, flags)
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise ValueError("policy is not a regular file")
        if metadata.st_uid != trusted_uid or metadata.st_gid != trusted_gid:
            raise ValueError("policy ownership is not trusted")
        if stat.S_IMODE(metadata.st_mode) != 0o444:
            raise ValueError("policy mode is not read-only")
        if metadata.st_size > _MAX_POLICY_BYTES:
            raise ValueError("policy exceeds the size limit")
        with os.fdopen(descriptor, "rb", closefd=False) as source:
            raw = source.read(_MAX_POLICY_BYTES + 1)
    finally:
        os.close(descriptor)

    policy = json.loads(raw.decode("utf-8"))
    if set(policy) != {"schemaVersion", "wikidataReferenceRead"}:
        raise ValueError("policy fields changed")
    if type(policy["schemaVersion"]) is not int or policy["schemaVersion"] != 1:
        raise ValueError("policy schema is unsupported")
    action = policy["wikidataReferenceRead"]
    if not isinstance(action, dict) or set(action) != {"platform", "command"}:
        raise ValueError("reviewed action fields changed")
    platform = action["platform"]
    command = action["command"]
    if not isinstance(platform, str) or not isinstance(command, str):
        raise ValueError("reviewed action values must be strings")
    return platform, command


def reviewed_unattended_action_decision(
    command: str,
    platform: str,
    *,
    policy_path: Path = POLICY_PATH,
    trusted_uid: int = 0,
    trusted_gid: int = 0,
) -> str | None:
    """Return allow or deny for the reviewed action, or None for other commands."""
    if command != REVIEWED_COMMAND:
        return None
    try:
        expected_platform, expected_command = _load_policy(
            policy_path,
            trusted_uid=trusted_uid,
            trusted_gid=trusted_gid,
        )
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError):
        return "deny"
    if expected_command != REVIEWED_COMMAND:
        return "deny"
    return "allow" if platform == expected_platform else "deny"


def is_reviewed_unattended_command(
    command: str,
    platform: str,
    *,
    policy_path: Path = POLICY_PATH,
    trusted_uid: int = 0,
    trusted_gid: int = 0,
) -> bool:
    """Return true only for the exact command, platform, and trusted policy file."""
    return (
        reviewed_unattended_action_decision(
            command,
            platform,
            policy_path=policy_path,
            trusted_uid=trusted_uid,
            trusted_gid=trusted_gid,
        )
        == "allow"
    )
