#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Descriptor-safe recursive state-directory shields transitions.

The host invokes this helper as root inside an agent sandbox.  It deliberately
does not use ``chown -R``/``chmod -R``: every traversal is rooted at an already
opened directory descriptor and every descent uses ``O_NOFOLLOW``.  Locking
also replaces regular files with fresh inodes so a sandbox process cannot keep
mutating the visible file through a writable descriptor opened before shields
went up.  Extended attributes (including ACL storage) are copied when the
container Python exposes the descriptor-based xattr API; the shipped Linux
images do.  The final chmod clamps any copied ACL mask to the shields mode.
"""

from __future__ import annotations

import argparse
import errno
import fcntl
import grp
import json
import os
import posixpath
import pwd
import re
import secrets
import stat
import struct
import sys
import time
from dataclasses import dataclass, field
from typing import Literal


MAX_SYMLINK_EXPANSIONS = 40
MAX_TRAVERSAL_DEPTH = 256
STABLE_COPY_ATTEMPTS = 3
COPY_BUFFER_BYTES = 1024 * 1024
MAX_ENTRIES_PER_PASS = 100_000
MAX_LOGICAL_BYTES_PER_PASS = 16 * 1024 * 1024 * 1024
MAX_ALLOCATED_BYTES_PER_PASS = 8 * 1024 * 1024 * 1024
MAX_COPIED_BYTES_PER_PASS = 8 * 1024 * 1024 * 1024
MAX_GUARD_SECONDS = 10 * 60
PRODUCTION_FAIL_CLOSED_CONFIG_DIRS = frozenset(
    {"/sandbox/.openclaw", "/sandbox/.hermes", "/sandbox/.deepagents"}
)
OPENCLAW_CONFIG_DIR = "/sandbox/.openclaw"
OPENCLAW_NATIVE_MUTABLE_ROOTS = ("devices", "identity")
OPENCLAW_MUTATION_MUTEX_PATH = "/run/nemoclaw/openclaw-config-mutation.lock"
MAX_TRANSITION_LOCK_BYTES = 16 * 1024
# Keep this exact source/target contract aligned with
# src/lib/state/openclaw-managed-extensions.ts.
OPENCLAW_IMAGE_PACKAGE_PATHS = frozenset(
    {
        "/usr/local/lib/node_modules/openclaw",
        "/usr/local/lib/nemoclaw/openclaw-runtime/node_modules/openclaw",
    }
)
OPENCLAW_EXTENSION_PEER_LINK_SUFFIX = ("node_modules", "openclaw")
SAFE_EXTENSION_ID_CHARS = frozenset(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-"
)
ASCII_ALNUM_CHARS = frozenset(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
)
SAFE_TOP_LEVEL_RE = re.compile(r"^[A-Za-z0-9._-]+$")
PLAN_KEYS = frozenset(
    {
        "version",
        "readOnlyRoots",
        "confidentialRoots",
        "readOnlyPrefixes",
        "confidentialPrefixes",
        "writableSubpaths",
    }
)
OPTIONAL_PLAN_KEYS = frozenset({"$comment"})
MAX_PLAN_BYTES = 1024 * 1024
HERMES_PRIVATE_WRITABLE_SUBPATH = "profiles/dashboard-home"
FS_IMMUTABLE_FL = 0x00000010
FS_APPEND_FL = 0x00000020
FS_IOC_GETFLAGS = 0x80086601
FS_IOC_SETFLAGS = 0x40086602

Action = Literal["preflight", "lock", "unlock", "startup"]
Policy = Literal["high-risk", "confidentiality"]


class PlanValidationError(ValueError):
    pass


@dataclass(frozen=True)
class AgentStateLockPlan:
    version: Literal[1]
    read_only_roots: tuple[str, ...]
    confidential_roots: tuple[str, ...]
    read_only_prefixes: tuple[str, ...]
    confidential_prefixes: tuple[str, ...]
    writable_subpaths: tuple[tuple[str, ...], ...]

    def policy_for_root(self, name: str) -> Policy | None:
        if name in self.confidential_roots or any(
            name.startswith(prefix) for prefix in self.confidential_prefixes
        ):
            return "confidentiality"
        if name in self.read_only_roots or any(
            name.startswith(prefix) for prefix in self.read_only_prefixes
        ):
            return "high-risk"
        return None


@dataclass(frozen=True)
class Identity:
    root_uid: int
    root_gid: int
    sandbox_uid: int
    sandbox_gid: int


@dataclass(frozen=True)
class Issue:
    code: str
    path: str
    detail: str

    def as_json(self) -> dict[str, str]:
        return {
            "type": "issue",
            "code": self.code,
            "path": self.path,
            "detail": self.detail,
        }


@dataclass(frozen=True)
class RootSpec:
    name: str
    policy: Policy
    dev: int
    ino: int


@dataclass
class GuardResult:
    action: Action
    issues: list[Issue] = field(default_factory=list)
    roots: int = 0
    directories: int = 0
    files: int = 0
    symlinks: int = 0
    removed_entries: int = 0

    @property
    def ok(self) -> bool:
        return not self.issues

    def summary_json(self) -> dict[str, object]:
        return {
            "type": "result",
            "action": self.action,
            "status": "ok" if self.ok else "failed",
            "roots": self.roots,
            "directories": self.directories,
            "files": self.files,
            "symlinks": self.symlinks,
            "removedEntries": self.removed_entries,
            "issueCount": len(self.issues),
        }


class GuardOperationError(RuntimeError):
    def __init__(self, issue: Issue):
        super().__init__(issue.detail)
        self.issue = issue


@dataclass
class WorkBudget:
    deadline: float
    entries: int = 0
    logical_bytes: int = 0
    allocated_bytes: int = 0
    copied_bytes: int = 0

    def check_time(self, path: str) -> None:
        if time.monotonic() > self.deadline:
            raise GuardOperationError(
                Issue(
                    "work-time-limit",
                    path,
                    f"state-dir guard exceeded {MAX_GUARD_SECONDS} seconds",
                )
            )

    def observe_entry(self, path: str, entry: os.stat_result) -> None:
        self.check_time(path)
        self.entries += 1
        if self.entries > MAX_ENTRIES_PER_PASS:
            raise GuardOperationError(
                Issue(
                    "work-entry-limit",
                    path,
                    f"state tree exceeds {MAX_ENTRIES_PER_PASS} entries in one pass",
                )
            )
        if not stat.S_ISREG(entry.st_mode):
            return
        self.logical_bytes += max(0, entry.st_size)
        self.allocated_bytes += max(0, getattr(entry, "st_blocks", 0) * 512)
        if self.logical_bytes > MAX_LOGICAL_BYTES_PER_PASS:
            raise GuardOperationError(
                Issue(
                    "work-logical-byte-limit",
                    path,
                    f"state tree exceeds {MAX_LOGICAL_BYTES_PER_PASS} logical bytes",
                )
            )
        if self.allocated_bytes > MAX_ALLOCATED_BYTES_PER_PASS:
            raise GuardOperationError(
                Issue(
                    "work-allocated-byte-limit",
                    path,
                    f"state tree exceeds {MAX_ALLOCATED_BYTES_PER_PASS} allocated bytes",
                )
            )

    def account_copy(self, path: str, size: int) -> None:
        self.check_time(path)
        self.copied_bytes += size
        if self.copied_bytes > MAX_COPIED_BYTES_PER_PASS:
            raise GuardOperationError(
                Issue(
                    "work-copy-byte-limit",
                    path,
                    f"state lock exceeds {MAX_COPIED_BYTES_PER_PASS} copied data bytes",
                )
            )


def _unique_json_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise PlanValidationError(f"plan repeats key {key!r}")
        result[key] = value
    return result


def _read_string_list(record: dict[str, object], key: str) -> tuple[str, ...]:
    value = record[key]
    if not isinstance(value, list):
        raise PlanValidationError(f"plan field {key!r} must be an array")
    result: list[str] = []
    seen: set[str] = set()
    for index, item in enumerate(value):
        if not isinstance(item, str):
            raise PlanValidationError(f"plan field {key!r}[{index}] must be a string")
        if item in seen:
            raise PlanValidationError(f"plan field {key!r} repeats {item!r}")
        seen.add(item)
        result.append(item)
    return tuple(result)


def _validate_top_level_name(value: str, field: str) -> None:
    if (
        value in {"", ".", ".."}
        or SAFE_TOP_LEVEL_RE.fullmatch(value) is None
        or "/" in value
        or "\\" in value
    ):
        raise PlanValidationError(
            f"plan field {field!r} must contain one safe top-level name"
        )


def _validate_writable_subpath(value: str, field: str) -> tuple[str, ...]:
    if value.startswith("/") or "\\" in value or any(
        ord(character) < 32 or ord(character) == 127 for character in value
    ):
        raise PlanValidationError(
            f"plan field {field!r} must be a canonical relative path"
        )
    components = tuple(value.split("/"))
    if len(components) < 2 or any(
        component in {"", ".", ".."} for component in components
    ):
        raise PlanValidationError(
            f"plan field {field!r} must be beneath a declared top-level root"
        )
    for component in components:
        if "*" in component and component != "*":
            raise PlanValidationError(
                f"plan field {field!r} may use '*' only as a complete path component"
            )
    if components[-1] == "*":
        raise PlanValidationError(
            f"plan field {field!r} may not end with a wildcard component"
        )
    return components


def _patterns_overlap(first: tuple[str, ...], second: tuple[str, ...]) -> bool:
    return all(
        left == "*" or right == "*" or left == right
        # A matching shorter pattern is a shared-prefix overlap.
        for left, right in zip(first, second, strict=False)
    )


def _validate_policy_boundaries(
    read_only_roots: tuple[str, ...],
    confidential_roots: tuple[str, ...],
    read_only_prefixes: tuple[str, ...],
    confidential_prefixes: tuple[str, ...],
) -> None:
    exact = [
        *((name, "read-only") for name in read_only_roots),
        *((name, "confidential") for name in confidential_roots),
    ]
    prefixes = [
        *((prefix, "read-only") for prefix in read_only_prefixes),
        *((prefix, "confidential") for prefix in confidential_prefixes),
    ]
    exact_names: set[str] = set()
    for name, _policy in exact:
        if name in exact_names:
            raise PlanValidationError(f"plan assigns root {name!r} more than once")
        exact_names.add(name)
    prefix_names: set[str] = set()
    for prefix, _policy in prefixes:
        if prefix in prefix_names:
            raise PlanValidationError(f"plan assigns prefix {prefix!r} more than once")
        prefix_names.add(prefix)
    for name, _policy in exact:
        for prefix, _prefix_policy in prefixes:
            if name.startswith(prefix):
                raise PlanValidationError(
                    f"plan root {name!r} also matches prefix {prefix!r}"
                )
    for index, (prefix, _policy) in enumerate(prefixes):
        for other, _other_policy in prefixes[index + 1 :]:
            if prefix.startswith(other) or other.startswith(prefix):
                raise PlanValidationError(
                    f"plan prefixes {prefix!r} and {other!r} overlap"
                )


def parse_agent_state_lock_plan(payload: str) -> AgentStateLockPlan:
    try:
        value = json.loads(payload, object_pairs_hook=_unique_json_object)
    except (json.JSONDecodeError, PlanValidationError) as exc:
        raise PlanValidationError(f"plan is not valid JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise PlanValidationError("plan must be a JSON object")
    keys = set(value)
    missing = sorted(PLAN_KEYS - keys)
    unknown = sorted(keys - PLAN_KEYS - OPTIONAL_PLAN_KEYS)
    if missing:
        raise PlanValidationError(f"plan is missing keys: {', '.join(missing)}")
    if unknown:
        raise PlanValidationError(f"plan has unknown keys: {', '.join(unknown)}")
    if "$comment" in value and not isinstance(value["$comment"], str):
        raise PlanValidationError("plan field '$comment' must be a string")
    if type(value["version"]) is not int or value["version"] != 1:
        raise PlanValidationError("plan field 'version' must be exactly 1")

    read_only_roots = _read_string_list(value, "readOnlyRoots")
    confidential_roots = _read_string_list(value, "confidentialRoots")
    read_only_prefixes = _read_string_list(value, "readOnlyPrefixes")
    confidential_prefixes = _read_string_list(value, "confidentialPrefixes")
    writable_values = _read_string_list(value, "writableSubpaths")
    for key, entries in (
        ("readOnlyRoots", read_only_roots),
        ("confidentialRoots", confidential_roots),
        ("readOnlyPrefixes", read_only_prefixes),
        ("confidentialPrefixes", confidential_prefixes),
    ):
        for index, entry in enumerate(entries):
            _validate_top_level_name(entry, f"{key}[{index}]")
    _validate_policy_boundaries(
        read_only_roots,
        confidential_roots,
        read_only_prefixes,
        confidential_prefixes,
    )

    writable_subpaths = tuple(
        _validate_writable_subpath(entry, f"writableSubpaths[{index}]")
        for index, entry in enumerate(writable_values)
    )
    for index, components in enumerate(writable_subpaths):
        if components[0] not in read_only_roots:
            raise PlanValidationError(
                f"plan field 'writableSubpaths[{index}]' must be beneath a read-only root"
            )
        for other_index, other in enumerate(writable_subpaths[index + 1 :], index + 1):
            if _patterns_overlap(components, other):
                raise PlanValidationError(
                    "plan writable subpaths "
                    f"{writable_values[index]!r} and {writable_values[other_index]!r} overlap"
                )
    return AgentStateLockPlan(
        version=1,
        read_only_roots=read_only_roots,
        confidential_roots=confidential_roots,
        read_only_prefixes=read_only_prefixes,
        confidential_prefixes=confidential_prefixes,
        writable_subpaths=writable_subpaths,
    )


def _no_follow_flag() -> int:
    flag = getattr(os, "O_NOFOLLOW", 0)
    if not flag:
        raise GuardOperationError(
            Issue("unsupported-platform", "", "O_NOFOLLOW is unavailable")
        )
    return flag


def _directory_flags() -> int:
    flag = getattr(os, "O_DIRECTORY", 0)
    if not flag:
        raise GuardOperationError(
            Issue("unsupported-platform", "", "O_DIRECTORY is unavailable")
        )
    return os.O_RDONLY | flag | _no_follow_flag() | getattr(os, "O_CLOEXEC", 0)


def _file_flags() -> int:
    return os.O_RDONLY | _no_follow_flag() | getattr(os, "O_CLOEXEC", 0)


def _get_inode_flags(fd: int) -> int | None:
    try:
        raw = fcntl.ioctl(fd, FS_IOC_GETFLAGS, struct.pack("I", 0))
        return int(struct.unpack("I", raw)[0])
    except OSError as exc:
        if exc.errno in {errno.ENOTTY, errno.EOPNOTSUPP, errno.ENOSYS, errno.EINVAL}:
            return None
        raise


def _set_inode_flags(fd: int, flags: int | None) -> None:
    if flags is None:
        return
    try:
        fcntl.ioctl(fd, FS_IOC_SETFLAGS, struct.pack("I", flags))
    except OSError as exc:
        if exc.errno in {errno.ENOTTY, errno.EOPNOTSUPP, errno.ENOSYS, errno.EINVAL}:
            return
        raise


def _clear_mutation_flags(fd: int) -> int | None:
    original = _get_inode_flags(fd)
    if original is not None and original & (FS_IMMUTABLE_FL | FS_APPEND_FL):
        _set_inode_flags(fd, original & ~(FS_IMMUTABLE_FL | FS_APPEND_FL))
    return original


def _display_path(config_path: str, relative_path: str) -> str:
    if not relative_path:
        return config_path
    return posixpath.join(config_path, relative_path)


def _os_issue(code: str, path: str, operation: str, exc: OSError) -> Issue:
    return Issue(code, path, f"{operation} failed: {exc.strerror or exc}")


def _same_entry(first: os.stat_result, second: os.stat_result) -> bool:
    return first.st_dev == second.st_dev and first.st_ino == second.st_ino


def _bounded_directory_names(
    dir_fd: int,
    path: str,
    budget: WorkBudget | None = None,
) -> list[str]:
    names: list[str] = []
    with os.scandir(dir_fd) as entries:
        for entry in entries:
            if budget is not None:
                budget.check_time(path)
            names.append(entry.name)
            if len(names) > MAX_ENTRIES_PER_PASS:
                raise GuardOperationError(
                    Issue(
                        "work-entry-limit",
                        path,
                        f"directory exceeds {MAX_ENTRIES_PER_PASS} entries",
                    )
                )
    names.sort()
    return names


def _open_absolute_dir_nofollow(path: str) -> int:
    if not posixpath.isabs(path):
        raise GuardOperationError(
            Issue("invalid-config-path", path, "config directory must be absolute")
        )
    normalized = posixpath.normpath(path)
    fd = os.open("/", _directory_flags())
    try:
        for component in normalized.split("/"):
            if not component:
                continue
            next_fd = os.open(component, _directory_flags(), dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except Exception:
        os.close(fd)
        raise


def _open_child_dir(parent_fd: int, name: str, expected: os.stat_result) -> int:
    child_fd = os.open(name, _directory_flags(), dir_fd=parent_fd)
    actual = os.fstat(child_fd)
    if not _same_entry(expected, actual):
        os.close(child_fd)
        raise GuardOperationError(
            Issue("entry-raced", name, "directory changed while it was being opened")
        )
    return child_fd


def _entry_kind(st: os.stat_result) -> str:
    mode = st.st_mode
    if stat.S_ISDIR(mode):
        return "directory"
    if stat.S_ISREG(mode):
        return "regular file"
    if stat.S_ISLNK(mode):
        return "symlink"
    if stat.S_ISFIFO(mode):
        return "FIFO"
    if stat.S_ISSOCK(mode):
        return "socket"
    if stat.S_ISCHR(mode):
        return "character device"
    if stat.S_ISBLK(mode):
        return "block device"
    return "unknown entry"


def _select_roots(
    config_fd: int,
    config_path: str,
    config_dev: int,
    plan: AgentStateLockPlan,
) -> tuple[list[RootSpec], list[Issue]]:
    issues: list[Issue] = []
    try:
        present_names = set(_bounded_directory_names(config_fd, config_path))
    except OSError as exc:
        return [], [_os_issue("list-failed", config_path, "list config directory", exc)]

    selected_names = sorted(
        name for name in present_names if plan.policy_for_root(name) is not None
    )
    roots: list[RootSpec] = []
    for name in selected_names:
        path = _display_path(config_path, name)
        try:
            st = os.stat(name, dir_fd=config_fd, follow_symlinks=False)
        except OSError as exc:
            issues.append(_os_issue("stat-failed", path, "stat state-dir root", exc))
            continue
        if st.st_dev != config_dev:
            issues.append(
                Issue(
                    "cross-device-entry",
                    path,
                    "state-dir root is on a different filesystem",
                )
            )
            continue
        if stat.S_ISLNK(st.st_mode):
            issues.append(
                Issue(
                    "state-root-symlink", path, "state-dir roots must not be symlinks"
                )
            )
            continue
        if not stat.S_ISDIR(st.st_mode):
            issues.append(
                Issue(
                    "state-root-not-directory",
                    path,
                    f"state-dir root is a {_entry_kind(st)}, not a directory",
                )
            )
            continue
        policy = plan.policy_for_root(name)
        if policy is None:  # The name came from the same predicate above.
            continue
        roots.append(RootSpec(name=name, policy=policy, dev=st.st_dev, ino=st.st_ino))
    return roots, issues


def _remove_unsupported_root_entries_for_lock(
    config_fd: int,
    config_path: str,
    config_dev: int,
    plan: AgentStateLockPlan,
) -> int:
    """Remove attacker-created protected-root names that cannot be traversed.

    The caller has already frozen the top-level config directory.  Removing a
    symlink/FIFO/file at a name whose shields contract requires a directory is
    therefore descriptor-relative and cannot follow or affect its target.  A
    hard failure (including a cross-device mount) remains fail-closed.
    """

    removed = 0
    for name in _bounded_directory_names(config_fd, config_path):
        if plan.policy_for_root(name) is None:
            continue
        path = _display_path(config_path, name)
        st = os.stat(name, dir_fd=config_fd, follow_symlinks=False)
        if st.st_dev != config_dev:
            raise GuardOperationError(
                Issue(
                    "cross-device-entry",
                    path,
                    "state-dir root is on a different filesystem",
                )
            )
        if stat.S_ISDIR(st.st_mode):
            continue
        current = os.stat(name, dir_fd=config_fd, follow_symlinks=False)
        if not _same_entry(st, current):
            raise GuardOperationError(
                Issue(
                    "entry-raced",
                    path,
                    "unsupported state-dir root changed before removal",
                )
            )
        try:
            os.unlink(name, dir_fd=config_fd)
            os.fsync(config_fd)
        except OSError as exc:
            raise GuardOperationError(
                _os_issue(
                    "unsafe-entry-remove-failed",
                    path,
                    "remove unsupported state-dir root",
                    exc,
                )
            ) from exc
        removed += 1
    return removed


@dataclass
class TraversalContext:
    config_fd: int
    config_path: str
    config_dev: int
    protected_roots: tuple[str, ...]
    budget: WorkBudget
    writable_subpaths: tuple[tuple[str, ...], ...] = ()

    def display(self, relative_path: str) -> str:
        return _display_path(self.config_path, relative_path)

    def is_protected(self, relative_path: str) -> bool:
        return any(
            relative_path == root or relative_path.startswith(f"{root}/")
            for root in self.protected_roots
        )

    @staticmethod
    def _matches(pattern: tuple[str, ...], components: tuple[str, ...]) -> bool:
        return len(pattern) == len(components) and all(
            expected == "*" or expected == actual
            for expected, actual in zip(pattern, components, strict=True)
        )

    def is_writable_root(self, relative_path: str) -> bool:
        components = tuple(relative_path.split("/"))
        return any(
            self._matches(pattern, components) for pattern in self.writable_subpaths
        )

    def is_private_writable_root(self, relative_path: str) -> bool:
        return (
            posixpath.basename(self.config_path) == ".hermes"
            and relative_path == HERMES_PRIVATE_WRITABLE_SUBPATH
        )

    def is_openclaw_native_mutable_path(self, relative_path: str) -> bool:
        return self.config_path == OPENCLAW_CONFIG_DIR and any(
            relative_path == root or relative_path.startswith(f"{root}/")
            for root in OPENCLAW_NATIVE_MUTABLE_ROOTS
        )

    def is_under_writable_root(self, relative_path: str) -> bool:
        components = tuple(relative_path.split("/"))
        return any(
            len(components) >= len(pattern)
            and self._matches(pattern, components[: len(pattern)])
            for pattern in self.writable_subpaths
        )

    def writable_children(self, relative_path: str) -> tuple[str, ...]:
        components = tuple(relative_path.split("/"))
        return tuple(
            pattern[-1]
            for pattern in self.writable_subpaths
            if len(pattern) == len(components) + 1
            and self._matches(pattern[:-1], components)
        )


def _normalize_link_target(
    context: TraversalContext,
    link_parent: str,
    target: str,
) -> str:
    if posixpath.isabs(target):
        normalized_absolute = posixpath.normpath(target)
        try:
            within_config = (
                posixpath.commonpath([context.config_path, normalized_absolute])
                == context.config_path
            )
        except ValueError:
            within_config = False
        if not within_config:
            raise GuardOperationError(
                Issue(
                    "symlink-outside-protected-root",
                    normalized_absolute,
                    "absolute symlink target is outside the config directory",
                )
            )
        relative = posixpath.relpath(normalized_absolute, context.config_path)
    else:
        relative = posixpath.normpath(posixpath.join(link_parent, target))

    if relative in {"", "."} or relative == ".." or relative.startswith("../"):
        raise GuardOperationError(
            Issue(
                "symlink-outside-protected-root",
                target,
                "symlink target escapes the config directory",
            )
        )
    if not context.is_protected(relative):
        raise GuardOperationError(
            Issue(
                "symlink-outside-protected-root",
                target,
                "symlink target is not inside a protected state-dir root",
            )
        )
    return relative


def _is_allowed_openclaw_extension_peer_symlink(
    context: TraversalContext,
    relative_path: str,
    target: str,
) -> bool:
    """Recognize an exact image-owned peer link that may leave the state tree."""

    if target not in OPENCLAW_IMAGE_PACKAGE_PATHS:
        return False
    if posixpath.basename(context.config_path) != ".openclaw":
        return False
    components = relative_path.split("/")
    if len(components) != 4:
        return False
    root, extension_id, *suffix = components
    return (
        root == "extensions"
        and bool(extension_id)
        and extension_id[0] in ASCII_ALNUM_CHARS
        and all(character in SAFE_EXTENSION_ID_CHARS for character in extension_id)
        and tuple(suffix) == OPENCLAW_EXTENSION_PEER_LINK_SUFFIX
    )


def _resolve_internal_symlink(
    context: TraversalContext,
    link_relative_path: str,
    target: str,
) -> None:
    """Resolve a link without ever asking the kernel to follow a symlink."""

    relative = _normalize_link_target(
        context, posixpath.dirname(link_relative_path), target
    )
    if context.is_under_writable_root(
        link_relative_path
    ) or context.is_under_writable_root(relative):
        raise GuardOperationError(
            Issue(
                "symlink-crosses-runtime-carveout",
                context.display(link_relative_path),
                "symlinks may not enter or originate in a writable state subpath",
            )
        )
    seen: set[str] = set()
    expansions = 0

    while True:
        if relative in seen:
            raise GuardOperationError(
                Issue(
                    "symlink-cycle",
                    context.display(link_relative_path),
                    "internal symlink chain contains a cycle",
                )
            )
        seen.add(relative)
        components = relative.split("/")
        current_fd = os.dup(context.config_fd)
        resolved_parts: list[str] = []
        restart = False
        try:
            for index, component in enumerate(components):
                current_relative = "/".join([*resolved_parts, component])
                current_path = context.display(current_relative)
                try:
                    st = os.stat(component, dir_fd=current_fd, follow_symlinks=False)
                except OSError as exc:
                    raise GuardOperationError(
                        _os_issue(
                            "symlink-target-unavailable",
                            current_path,
                            "stat symlink target",
                            exc,
                        )
                    ) from exc
                if st.st_dev != context.config_dev:
                    raise GuardOperationError(
                        Issue(
                            "cross-device-entry",
                            current_path,
                            "symlink target crosses to a different filesystem",
                        )
                    )
                remaining = components[index + 1 :]
                if stat.S_ISLNK(st.st_mode):
                    if st.st_nlink != 1:
                        raise GuardOperationError(
                            Issue(
                                "hardlinked-entry",
                                current_path,
                                f"symlink has link count {st.st_nlink}, expected 1",
                            )
                        )
                    expansions += 1
                    if expansions > MAX_SYMLINK_EXPANSIONS:
                        raise GuardOperationError(
                            Issue(
                                "too-many-symlinks",
                                context.display(link_relative_path),
                                "internal symlink chain is too deep",
                            )
                        )
                    nested_target = os.readlink(component, dir_fd=current_fd)
                    expanded = _normalize_link_target(
                        context, "/".join(resolved_parts), nested_target
                    )
                    relative = posixpath.normpath(posixpath.join(expanded, *remaining))
                    if not context.is_protected(relative):
                        raise GuardOperationError(
                            Issue(
                                "symlink-outside-protected-root",
                                context.display(link_relative_path),
                                "expanded symlink target leaves protected roots",
                            )
                        )
                    if context.is_under_writable_root(relative):
                        raise GuardOperationError(
                            Issue(
                                "symlink-crosses-runtime-carveout",
                                context.display(link_relative_path),
                                "symlink chain enters a writable state subpath",
                            )
                        )
                    restart = True
                    break
                if remaining:
                    if not stat.S_ISDIR(st.st_mode):
                        raise GuardOperationError(
                            Issue(
                                "symlink-target-invalid",
                                current_path,
                                "non-directory occurs before the end of a symlink target",
                            )
                        )
                    next_fd = _open_child_dir(current_fd, component, st)
                    os.close(current_fd)
                    current_fd = next_fd
                    resolved_parts.append(component)
                    continue
                if not (stat.S_ISDIR(st.st_mode) or stat.S_ISREG(st.st_mode)):
                    raise GuardOperationError(
                        Issue(
                            "special-entry",
                            current_path,
                            f"symlink resolves to a {_entry_kind(st)}",
                        )
                    )
                if stat.S_ISREG(st.st_mode) and st.st_nlink != 1:
                    raise GuardOperationError(
                        Issue(
                            "hardlinked-entry",
                            current_path,
                            f"regular file has link count {st.st_nlink}, expected 1",
                        )
                    )
        finally:
            os.close(current_fd)
        if restart:
            continue
        return


def _validate_symlink(
    context: TraversalContext,
    parent_fd: int,
    name: str,
    relative_path: str,
    st: os.stat_result,
) -> Issue | None:
    path = context.display(relative_path)
    if st.st_dev != context.config_dev:
        return Issue("cross-device-entry", path, "symlink is on a different filesystem")
    if st.st_nlink != 1:
        return Issue(
            "hardlinked-entry",
            path,
            f"symlink has link count {st.st_nlink}, expected 1",
        )
    try:
        target = os.readlink(name, dir_fd=parent_fd)
        if not _is_allowed_openclaw_extension_peer_symlink(
            context, relative_path, target
        ):
            _resolve_internal_symlink(context, relative_path, target)
    except GuardOperationError as exc:
        return Issue(exc.issue.code, path, exc.issue.detail)
    except OSError as exc:
        return _os_issue("readlink-failed", path, "read symlink", exc)
    return None


def _scan_dir(
    context: TraversalContext,
    dir_fd: int,
    relative_dir: str,
    issues: list[Issue],
    depth: int,
    action: Action,
) -> None:
    if depth > MAX_TRAVERSAL_DEPTH:
        issues.append(
            Issue(
                "tree-too-deep",
                context.display(relative_dir),
                f"state tree exceeds {MAX_TRAVERSAL_DEPTH} directory levels",
            )
        )
        return
    try:
        names = _bounded_directory_names(
            dir_fd, context.display(relative_dir), context.budget
        )
    except OSError as exc:
        issues.append(
            _os_issue(
                "list-failed", context.display(relative_dir), "list directory", exc
            )
        )
        return

    for name in names:
        relative_path = posixpath.join(relative_dir, name)
        path = context.display(relative_path)
        try:
            st = os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
        except OSError as exc:
            issues.append(_os_issue("stat-failed", path, "stat entry", exc))
            continue
        context.budget.observe_entry(path, st)
        if st.st_dev != context.config_dev:
            issues.append(
                Issue("cross-device-entry", path, "entry is on a different filesystem")
            )
            continue
        if stat.S_ISDIR(st.st_mode):
            # Writable contents are intentionally outside the shields integrity
            # boundary and remain live while shields are up. Validate that the
            # subpath root is a real in-tree directory, but do not traverse a
            # subtree the gateway may be mutating concurrently.
            if context.is_writable_root(relative_path):
                continue
            try:
                child_fd = _open_child_dir(dir_fd, name, st)
            except (OSError, GuardOperationError) as exc:
                if isinstance(exc, GuardOperationError):
                    issues.append(Issue(exc.issue.code, path, exc.issue.detail))
                else:
                    issues.append(_os_issue("open-failed", path, "open directory", exc))
                continue
            try:
                _scan_dir(context, child_fd, relative_path, issues, depth + 1, action)
            finally:
                os.close(child_fd)
        elif stat.S_ISREG(st.st_mode):
            if action != "lock" and st.st_nlink != 1:
                issues.append(
                    Issue(
                        "hardlinked-entry",
                        path,
                        f"regular file has link count {st.st_nlink}, expected 1",
                    )
                )
        elif stat.S_ISLNK(st.st_mode):
            issue = _validate_symlink(context, dir_fd, name, relative_path, st)
            if action != "lock" and issue is not None:
                issues.append(issue)
        else:
            if action != "lock":
                issues.append(
                    Issue(
                        "special-entry",
                        path,
                        f"state tree contains a {_entry_kind(st)}",
                    )
                )


def _preflight(
    config_fd: int,
    config_path: str,
    config_dev: int,
    deadline: float,
    action: Action,
    plan: AgentStateLockPlan,
) -> tuple[list[RootSpec], list[Issue]]:
    roots, issues = _select_roots(config_fd, config_path, config_dev, plan)
    protected_roots = tuple(root.name for root in roots)
    context = TraversalContext(
        config_fd,
        config_path,
        config_dev,
        protected_roots,
        WorkBudget(deadline),
        plan.writable_subpaths,
    )
    for root in roots:
        path = context.display(root.name)
        try:
            root_lstat = os.stat(root.name, dir_fd=config_fd, follow_symlinks=False)
            context.budget.observe_entry(path, root_lstat)
            root_fd = _open_child_dir(config_fd, root.name, root_lstat)
        except (OSError, GuardOperationError) as exc:
            if isinstance(exc, GuardOperationError):
                issues.append(Issue(exc.issue.code, path, exc.issue.detail))
            else:
                issues.append(
                    _os_issue("open-failed", path, "open state-dir root", exc)
                )
            continue
        try:
            _scan_dir(context, root_fd, root.name, issues, 1, action)
        finally:
            os.close(root_fd)
    return roots, issues


def _expected_ids(
    policy: Policy,
    action: Action,
    identity: Identity,
    is_confidentiality_root: bool = False,
) -> tuple[int, int]:
    if action == "unlock":
        return identity.sandbox_uid, identity.sandbox_gid
    if policy == "confidentiality":
        if is_confidentiality_root:
            return identity.root_uid, identity.sandbox_gid
        return identity.root_uid, identity.root_gid
    return identity.root_uid, identity.sandbox_gid


def _expected_dir_mode(
    policy: Policy, action: Action, is_confidentiality_root: bool = False
) -> int:
    if action == "unlock":
        return 0o2770
    if policy == "confidentiality":
        # The confidentiality root stays traversable (group execute, no read)
        # so a sandbox probe for a missing name directly under the root, such
        # as the legacy credentials/oauth.json, resolves as ENOENT instead of
        # EACCES.  Nested directories and every file keep the sealed posture,
        # so contents and the subtree shape stay unreadable.
        return 0o710 if is_confidentiality_root else 0o700
    return 0o755


def _expected_file_mode(policy: Policy, action: Action, old_mode: int) -> int:
    old_mode &= 0o777
    if action == "unlock":
        # chmod g+rwX,o-rwx: preserve owner bits; group gets rw and gets x only
        # when the file was executable by somebody before the transition.
        return (old_mode & 0o700) | 0o060 | (0o010 if old_mode & 0o111 else 0)
    if policy == "confidentiality":
        return old_mode & 0o700
    # High-risk files move from the sandbox UID to root while retaining the
    # sandbox group. Mirror the original owner's read/execute access onto that
    # group before removing every group/world write bit; otherwise an
    # owner-private 0600 runtime file becomes root:sandbox 0600 and the
    # gateway loses the access it had before Shields went up (#8304).
    return (old_mode & ~0o022) | ((old_mode & 0o500) >> 3)


def _freeze_dir_for_lock(dir_fd: int) -> None:
    current = stat.S_IMODE(os.fstat(dir_fd).st_mode)
    os.fchmod(dir_fd, current & 0o555)


def _set_dir_metadata(
    dir_fd: int,
    policy: Policy,
    action: Action,
    identity: Identity,
    is_confidentiality_root: bool = False,
) -> None:
    uid, gid = _expected_ids(policy, action, identity, is_confidentiality_root)
    os.fchown(dir_fd, uid, gid)
    os.fchmod(dir_fd, _expected_dir_mode(policy, action, is_confidentiality_root))


def _set_writable_subpath_metadata(
    context: TraversalContext,
    dir_fd: int,
    relative_path: str,
    policy: Policy,
    identity: Identity,
) -> None:
    if context.is_private_writable_root(relative_path):
        os.fchown(dir_fd, identity.sandbox_uid, identity.sandbox_gid)
        os.fchmod(dir_fd, 0o700)
        return
    _set_dir_metadata(dir_fd, policy, "unlock", identity)


def _set_empty_credentials_startup_metadata(
    dir_fd: int,
    identity: Identity,
) -> None:
    """Allow the sandbox group to probe names in an empty sealed credentials dir."""

    os.fchown(dir_fd, identity.root_uid, identity.sandbox_gid)
    os.fchmod(dir_fd, 0o710)


def _is_empty_credentials_root(
    relative_dir: str,
    policy: Policy,
    action: Action,
    is_root: bool,
    names: list[str],
) -> bool:
    return (
        action == "lock"
        and policy == "confidentiality"
        and is_root
        and relative_dir == "credentials"
        and not names
    )


def _copy_extent(
    source_fd: int,
    temp_fd: int,
    length: int,
    context: TraversalContext,
    path: str,
) -> None:
    remaining = length
    while remaining > 0:
        context.budget.check_time(path)
        chunk = os.read(source_fd, min(COPY_BUFFER_BYTES, remaining))
        if not chunk:
            raise OSError(errno.EIO, "unexpected EOF while copying state file")
        context.budget.account_copy(path, len(chunk))
        view = memoryview(chunk)
        while view:
            written = os.write(temp_fd, view)
            if written <= 0:
                raise OSError(errno.EIO, "short write while copying state file")
            view = view[written:]
        remaining -= len(chunk)


def _copy_file_sparse_aware(
    source_fd: int,
    temp_fd: int,
    size: int,
    context: TraversalContext,
    path: str,
) -> None:
    seek_data = getattr(os, "SEEK_DATA", None)
    seek_hole = getattr(os, "SEEK_HOLE", None)
    if seek_data is not None and seek_hole is not None:
        try:
            os.ftruncate(temp_fd, size)
            offset = 0
            while offset < size:
                context.budget.check_time(path)
                try:
                    data_offset = os.lseek(source_fd, offset, seek_data)
                except OSError as exc:
                    if exc.errno == errno.ENXIO:
                        return
                    raise
                hole_offset = min(size, os.lseek(source_fd, data_offset, seek_hole))
                os.lseek(source_fd, data_offset, os.SEEK_SET)
                os.lseek(temp_fd, data_offset, os.SEEK_SET)
                _copy_extent(
                    source_fd,
                    temp_fd,
                    hole_offset - data_offset,
                    context,
                    path,
                )
                offset = hole_offset
            return
        except OSError as exc:
            if exc.errno not in {errno.EINVAL, errno.ENOTSUP, errno.EOPNOTSUPP}:
                raise
            # Filesystem does not implement SEEK_DATA/SEEK_HOLE. Reset the
            # partially staged file before the bounded dense fallback.
            os.ftruncate(temp_fd, 0)
            os.lseek(source_fd, 0, os.SEEK_SET)
            os.lseek(temp_fd, 0, os.SEEK_SET)

    _copy_extent(source_fd, temp_fd, size, context, path)


def _copy_stable_file_to_temp(
    parent_fd: int,
    name: str,
    relative_path: str,
    context: TraversalContext,
    policy: Policy,
    identity: Identity,
) -> int:
    path = context.display(relative_path)
    for attempt in range(STABLE_COPY_ATTEMPTS):
        source_fd = -1
        temp_fd = -1
        source_flags: int | None = None
        replaced = False
        temp_name = f".nemoclaw-state-dir-{secrets.token_hex(12)}.tmp"
        try:
            source_fd = os.open(name, _file_flags(), dir_fd=parent_fd)
            before = os.fstat(source_fd)
            if not stat.S_ISREG(before.st_mode):
                raise GuardOperationError(
                    Issue("entry-raced", path, "file changed type while being opened")
                )
            if before.st_dev != context.config_dev:
                raise GuardOperationError(
                    Issue(
                        "cross-device-entry", path, "file is on a different filesystem"
                    )
                )
            # A hardlink is severed by the fresh-inode replacement below. Do
            # not clear immutable/append flags on a multiply-linked source:
            # those flags belong to every link, potentially including a path
            # outside this state tree.
            source_flags = _get_inode_flags(source_fd)
            if before.st_nlink == 1:
                source_flags = _clear_mutation_flags(source_fd)
            temp_fd = os.open(
                temp_name,
                os.O_WRONLY
                | os.O_CREAT
                | os.O_EXCL
                | _no_follow_flag()
                | getattr(os, "O_CLOEXEC", 0),
                0o600,
                dir_fd=parent_fd,
            )
            try:
                _copy_file_sparse_aware(
                    source_fd,
                    temp_fd,
                    before.st_size,
                    context,
                    path,
                )
            except OSError as exc:
                # At the containment deadline a writer holding an old FD must
                # not veto fresh-inode publication forever. On the final
                # attempt, a concurrent shrink can yield EIO after a bounded
                # partial copy; publish those captured bytes and report any
                # application-level damage after the stale FD is detached.
                if attempt + 1 < STABLE_COPY_ATTEMPTS or exc.errno != errno.EIO:
                    raise
            after = os.fstat(source_fd)
            stable = (
                _same_entry(before, after)
                and before.st_size == after.st_size
                and before.st_mtime_ns == after.st_mtime_ns
                and before.st_ctime_ns == after.st_ctime_ns
            )
            if not stable and attempt + 1 < STABLE_COPY_ATTEMPTS:
                os.close(temp_fd)
                temp_fd = -1
                os.unlink(temp_name, dir_fd=parent_fd)
                continue

            current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
            if not _same_entry(before, current):
                raise GuardOperationError(
                    Issue("entry-raced", path, "file changed before atomic replacement")
                )
            uid, gid = _expected_ids(policy, "lock", identity)
            os.fchown(temp_fd, uid, gid)
            # Preserve application metadata on the fresh inode.  Applying the
            # final mode after copying xattrs also clamps any POSIX ACL mask to
            # the shields mode instead of re-opening write access.
            listxattr = getattr(os, "listxattr", None)
            getxattr = getattr(os, "getxattr", None)
            setxattr = getattr(os, "setxattr", None)
            try:
                attributes = (
                    listxattr(source_fd)
                    if listxattr is not None
                    and getxattr is not None
                    and setxattr is not None
                    else ()
                )
                for attribute in attributes:
                    setxattr(
                        temp_fd,
                        attribute,
                        getxattr(source_fd, attribute),
                    )
            except OSError as exc:
                if exc.errno not in {errno.ENOTSUP, errno.ENOSYS}:
                    raise
            os.fchmod(
                temp_fd,
                _expected_file_mode(policy, "lock", stat.S_IMODE(before.st_mode)),
            )
            os.utime(
                temp_fd,
                ns=(before.st_atime_ns, before.st_mtime_ns),
            )
            final_source = os.fstat(source_fd)
            final_stable = (
                _same_entry(before, final_source)
                and before.st_size == final_source.st_size
                and before.st_mtime_ns == final_source.st_mtime_ns
                and before.st_ctime_ns == final_source.st_ctime_ns
            )
            if not final_stable and attempt + 1 < STABLE_COPY_ATTEMPTS:
                os.close(temp_fd)
                temp_fd = -1
                os.unlink(temp_name, dir_fd=parent_fd)
                continue
            os.fsync(temp_fd)
            os.replace(temp_name, name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
            replaced = True
            temp_name = ""
            _set_inode_flags(temp_fd, source_flags)
            os.fsync(temp_fd)
            os.fsync(parent_fd)
            return before.st_ino
        except GuardOperationError:
            raise
        except OSError as exc:
            raise GuardOperationError(
                _os_issue("file-replace-failed", path, "atomically replace file", exc)
            ) from exc
        finally:
            if source_fd >= 0:
                if not replaced:
                    try:
                        _set_inode_flags(source_fd, source_flags)
                    except OSError:
                        # Best effort: preserve the original operation failure.
                        pass
                os.close(source_fd)
            if temp_fd >= 0:
                os.close(temp_fd)
            if temp_name:
                try:
                    os.unlink(temp_name, dir_fd=parent_fd)
                except FileNotFoundError:
                    # Replacement or concurrent cleanup already removed it.
                    pass
    raise GuardOperationError(
        Issue(
            "unstable-file",
            path,
            f"file did not remain stable across {STABLE_COPY_ATTEMPTS} copy attempts",
        )
    )


def _unlock_file(
    parent_fd: int,
    name: str,
    relative_path: str,
    context: TraversalContext,
    policy: Policy,
    identity: Identity,
) -> None:
    path = context.display(relative_path)
    try:
        file_fd = os.open(name, _file_flags(), dir_fd=parent_fd)
    except OSError as exc:
        raise GuardOperationError(
            _os_issue("open-failed", path, "open file", exc)
        ) from exc
    try:
        _clear_mutation_flags(file_fd)
        st = os.fstat(file_fd)
        current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        if not _same_entry(st, current) or not stat.S_ISREG(st.st_mode):
            raise GuardOperationError(
                Issue("entry-raced", path, "file changed while it was being opened")
            )
        if st.st_dev != context.config_dev:
            raise GuardOperationError(
                Issue("cross-device-entry", path, "file is on a different filesystem")
            )
        if st.st_nlink != 1:
            raise GuardOperationError(
                Issue(
                    "hardlinked-entry",
                    path,
                    f"regular file has link count {st.st_nlink}, expected 1",
                )
            )
        uid, gid = _expected_ids(policy, "unlock", identity)
        os.fchown(file_fd, uid, gid)
        os.fchmod(
            file_fd,
            _expected_file_mode(policy, "unlock", stat.S_IMODE(st.st_mode)),
        )
    except OSError as exc:
        raise GuardOperationError(
            _os_issue("metadata-update-failed", path, "update file metadata", exc)
        ) from exc
    finally:
        os.close(file_fd)


def _chown_symlink(
    parent_fd: int,
    name: str,
    relative_path: str,
    context: TraversalContext,
    policy: Policy,
    action: Action,
    identity: Identity,
) -> None:
    path = context.display(relative_path)
    before = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    issue = _validate_symlink(context, parent_fd, name, relative_path, before)
    if issue is not None:
        raise GuardOperationError(issue)
    uid, gid = _expected_ids(policy, action, identity)
    try:
        os.chown(name, uid, gid, dir_fd=parent_fd, follow_symlinks=False)
    except OSError as exc:
        raise GuardOperationError(
            _os_issue("metadata-update-failed", path, "update symlink ownership", exc)
        ) from exc
    after = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    if not _same_entry(before, after):
        raise GuardOperationError(
            Issue("entry-raced", path, "symlink changed while ownership was updated")
        )
    if action == "unlock":
        issue = _validate_symlink(context, parent_fd, name, relative_path, after)
        if issue is not None:
            raise GuardOperationError(issue)


def _ensure_writable_subpath(
    context: TraversalContext,
    parent_fd: int,
    relative_dir: str,
    name: str,
    policy: Policy,
    identity: Identity,
    result: GuardResult,
) -> None:
    """Create a declared writable subpath when its parent already exists.

    The locked parent is root-owned and read-only for the sandbox identity, so
    the runtime cannot create the declared final component after shields-up.
    A surviving non-directory entry keeps its locked posture. A name that
    appears between the existence check and mkdir makes the lock fail closed.
    """

    relative_path = posixpath.join(relative_dir, name)
    path = context.display(relative_path)
    try:
        os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        return
    except FileNotFoundError:
        pass
    except OSError as exc:
        raise GuardOperationError(
            _os_issue(
                "carveout-create-failed",
                path,
                "check for a writable state subpath",
                exc,
            )
        ) from exc
    try:
        os.mkdir(name, mode=0o700, dir_fd=parent_fd)
        os.fsync(parent_fd)
        created = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        context.budget.observe_entry(path, created)
        child_fd = _open_child_dir(parent_fd, name, created)
    except OSError as exc:
        raise GuardOperationError(
            _os_issue(
                "carveout-create-failed",
                path,
                "create writable state subpath",
                exc,
            )
        ) from exc
    try:
        _set_writable_subpath_metadata(
            context, child_fd, relative_path, policy, identity
        )
    except OSError as exc:
        raise GuardOperationError(
            _os_issue(
                "metadata-update-failed",
                path,
                "prepare writable state subpath",
                exc,
            )
        ) from exc
    finally:
        os.close(child_fd)
    result.directories += 1


def _mutate_dir(
    context: TraversalContext,
    dir_fd: int,
    relative_dir: str,
    policy: Policy,
    action: Action,
    identity: Identity,
    result: GuardResult,
    replaced_inodes: dict[str, int],
    depth: int,
    is_root: bool = False,
) -> None:
    if depth > MAX_TRAVERSAL_DEPTH:
        raise GuardOperationError(
            Issue(
                "tree-too-deep",
                context.display(relative_dir),
                f"state tree exceeds {MAX_TRAVERSAL_DEPTH} directory levels",
            )
        )
    try:
        original_dir_flags = _clear_mutation_flags(dir_fd)
        if action == "lock":
            # Remove every write bit before changing ownership.  This revokes
            # mutation through directory descriptors opened by the sandbox
            # before shields-up, and it happens before visiting descendants.
            _freeze_dir_for_lock(dir_fd)
            _set_dir_metadata(
                dir_fd, policy, action, identity, is_root and policy == "confidentiality"
            )
        elif is_root:
            # Keep the subtree inaccessible while descendants are restored.
            os.fchmod(dir_fd, 0o700)
            os.fchown(dir_fd, identity.root_uid, identity.root_gid)
            os.fchmod(dir_fd, 0o700)
        names = _bounded_directory_names(
            dir_fd, context.display(relative_dir), context.budget
        )
        if _is_empty_credentials_root(
            relative_dir, policy, action, is_root, names
        ):
            # The confidentiality-root contract already grants the sandbox
            # group execute-only access (root:sandbox 0710).  Keep this
            # explicit empty-root case for compatibility with the startup
            # recovery path; nested entries remain root-only.
            _set_empty_credentials_startup_metadata(dir_fd, identity)
    except OSError as exc:
        raise GuardOperationError(
            _os_issue(
                "metadata-update-failed",
                context.display(relative_dir),
                "prepare directory",
                exc,
            )
        ) from exc

    result.directories += 1
    for name in names:
        relative_path = posixpath.join(relative_dir, name)
        path = context.display(relative_path)
        try:
            entry_st = os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
        except OSError as exc:
            raise GuardOperationError(
                _os_issue("stat-failed", path, "stat entry during mutation", exc)
            ) from exc
        context.budget.observe_entry(path, entry_st)
        if entry_st.st_dev != context.config_dev:
            raise GuardOperationError(
                Issue("cross-device-entry", path, "entry is on a different filesystem")
            )
        if stat.S_ISDIR(entry_st.st_mode):
            try:
                child_fd = _open_child_dir(dir_fd, name, entry_st)
            except OSError as exc:
                raise GuardOperationError(
                    _os_issue(
                        "open-failed", path, "open directory during mutation", exc
                    )
                ) from exc
            try:
                if context.is_writable_root(relative_path):
                    # Only the writable root has a shields contract. Its
                    # contents remain runtime-owned and may change while this
                    # helper runs, so never chmod/chown/copy descendants.
                    _clear_mutation_flags(child_fd)
                    _set_writable_subpath_metadata(
                        context, child_fd, relative_path, policy, identity
                    )
                    result.directories += 1
                else:
                    _mutate_dir(
                        context,
                        child_fd,
                        relative_path,
                        policy,
                        action,
                        identity,
                        result,
                        replaced_inodes,
                        depth + 1,
                    )
            finally:
                os.close(child_fd)
        elif stat.S_ISREG(entry_st.st_mode):
            if action == "lock":
                replaced_inodes[relative_path] = _copy_stable_file_to_temp(
                    dir_fd,
                    name,
                    relative_path,
                    context,
                    policy,
                    identity,
                )
            else:
                _unlock_file(
                    dir_fd,
                    name,
                    relative_path,
                    context,
                    policy,
                    identity,
                )
            result.files += 1
        elif stat.S_ISLNK(entry_st.st_mode):
            issue = _validate_symlink(context, dir_fd, name, relative_path, entry_st)
            if action == "lock" and issue is not None:
                current = os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
                if not _same_entry(entry_st, current):
                    raise GuardOperationError(
                        Issue(
                            "entry-raced", path, "unsafe symlink changed before removal"
                        )
                    )
                try:
                    os.unlink(name, dir_fd=dir_fd)
                    os.fsync(dir_fd)
                except OSError as exc:
                    raise GuardOperationError(
                        _os_issue(
                            "unsafe-entry-remove-failed",
                            path,
                            "remove unsafe symlink",
                            exc,
                        )
                    ) from exc
                result.removed_entries += 1
            else:
                _chown_symlink(
                    dir_fd,
                    name,
                    relative_path,
                    context,
                    policy,
                    action,
                    identity,
                )
                result.symlinks += 1
        else:
            if action != "lock":
                raise GuardOperationError(
                    Issue(
                        "special-entry",
                        path,
                        f"state tree contains a {_entry_kind(entry_st)}",
                    )
                )
            current = os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
            if not _same_entry(entry_st, current):
                raise GuardOperationError(
                    Issue("entry-raced", path, "special entry changed before removal")
                )
            try:
                os.unlink(name, dir_fd=dir_fd)
                os.fsync(dir_fd)
            except OSError as exc:
                raise GuardOperationError(
                    _os_issue(
                        "unsafe-entry-remove-failed", path, "remove special entry", exc
                    )
                ) from exc
            result.removed_entries += 1

    if action == "lock":
        for writable_child in context.writable_children(relative_dir):
            _ensure_writable_subpath(
                context,
                dir_fd,
                relative_dir,
                writable_child,
                policy,
                identity,
                result,
            )

    if action == "unlock":
        try:
            _set_dir_metadata(dir_fd, policy, action, identity)
        except OSError as exc:
            raise GuardOperationError(
                _os_issue(
                    "metadata-update-failed",
                    context.display(relative_dir),
                    "restore directory metadata",
                    exc,
                )
            ) from exc
    else:
        try:
            _set_inode_flags(dir_fd, original_dir_flags)
        except OSError as exc:
            raise GuardOperationError(
                _os_issue(
                    "metadata-update-failed",
                    context.display(relative_dir),
                    "restore directory inode flags",
                    exc,
                )
            ) from exc


def _verify_metadata(
    path: str,
    st: os.stat_result,
    entry_type: Literal["directory", "file", "symlink"],
    policy: Policy,
    action: Action,
    identity: Identity,
    is_confidentiality_root: bool = False,
    allow_openclaw_native_mutable: bool = False,
) -> Issue | None:
    expected_uid, expected_gid = _expected_ids(
        policy, action, identity, is_confidentiality_root
    )
    if st.st_uid != expected_uid or st.st_gid != expected_gid:
        return Issue(
            "verification-owner-mismatch",
            path,
            f"owner is {st.st_uid}:{st.st_gid}, expected {expected_uid}:{expected_gid}",
        )
    if entry_type == "symlink":
        return None
    mode = stat.S_IMODE(st.st_mode)
    if entry_type == "directory":
        if allow_openclaw_native_mutable and mode in (0o700, 0o755):
            return None
        expected_mode = _expected_dir_mode(policy, action, is_confidentiality_root)
        if mode != expected_mode:
            return Issue(
                "verification-mode-mismatch",
                path,
                f"directory mode is {mode:04o}, expected {expected_mode:04o}",
            )
        return None
    if mode & 0o7000:
        return Issue(
            "verification-mode-mismatch",
            path,
            f"file retains special mode bits: {mode:04o}",
        )
    if action == "unlock":
        if allow_openclaw_native_mutable and mode == 0o600:
            return None
        if mode & 0o007 or mode & 0o060 != 0o060:
            return Issue(
                "verification-mode-mismatch",
                path,
                f"mutable file mode does not satisfy g+rwX,o-rwx: {mode:04o}",
            )
    elif policy == "confidentiality":
        if mode & 0o077:
            return Issue(
                "verification-mode-mismatch",
                path,
                f"confidential file exposes group/world permissions: {mode:04o}",
            )
    else:
        if mode & 0o022:
            return Issue(
                "verification-mode-mismatch",
                path,
                f"high-risk file is group/world writable: {mode:04o}",
            )
        required_group_access = (mode & 0o500) >> 3
        if (mode & required_group_access) != required_group_access:
            return Issue(
                "verification-mode-mismatch",
                path,
                "high-risk file does not preserve owner read/execute access "
                f"for the sandbox group: {mode:04o}",
            )
    return None


def _verify_writable_subpath_metadata(
    context: TraversalContext,
    path: str,
    relative_path: str,
    st: os.stat_result,
    policy: Policy,
    identity: Identity,
) -> Issue | None:
    if not context.is_private_writable_root(relative_path):
        return _verify_metadata(path, st, "directory", policy, "unlock", identity)
    if st.st_uid != identity.sandbox_uid or st.st_gid != identity.sandbox_gid:
        return Issue(
            "verification-owner-mismatch",
            path,
            f"owner is {st.st_uid}:{st.st_gid}, "
            f"expected {identity.sandbox_uid}:{identity.sandbox_gid}",
        )
    mode = stat.S_IMODE(st.st_mode)
    if mode != 0o700:
        return Issue(
            "verification-mode-mismatch",
            path,
            f"directory mode is {mode:04o}, expected 0700",
        )
    return None


def _verify_dir(
    context: TraversalContext,
    dir_fd: int,
    relative_dir: str,
    policy: Policy,
    action: Action,
    identity: Identity,
    replaced_inodes: dict[str, int],
    issues: list[Issue],
    depth: int,
    is_root: bool = False,
) -> None:
    if depth > MAX_TRAVERSAL_DEPTH:
        issues.append(
            Issue(
                "tree-too-deep",
                context.display(relative_dir),
                f"state tree exceeds {MAX_TRAVERSAL_DEPTH} directory levels",
            )
        )
        return
    try:
        names = _bounded_directory_names(
            dir_fd, context.display(relative_dir), context.budget
        )
    except OSError as exc:
        issues.append(
            _os_issue(
                "verification-list-failed", context.display(relative_dir), "list", exc
            )
        )
        return
    dir_issue = _verify_metadata(
        context.display(relative_dir),
        os.fstat(dir_fd),
        "directory",
        policy,
        action,
        identity,
        is_root and policy == "confidentiality",
        action == "unlock"
        and policy == "high-risk"
        and context.is_openclaw_native_mutable_path(relative_dir),
    )
    if dir_issue is not None:
        issues.append(dir_issue)
    for name in names:
        relative_path = posixpath.join(relative_dir, name)
        path = context.display(relative_path)
        try:
            st = os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
        except OSError as exc:
            issues.append(_os_issue("verification-stat-failed", path, "stat", exc))
            continue
        try:
            context.budget.observe_entry(path, st)
        except GuardOperationError as exc:
            issues.append(exc.issue)
            return
        if st.st_dev != context.config_dev:
            issues.append(
                Issue("cross-device-entry", path, "entry is on a different filesystem")
            )
            continue
        if stat.S_ISDIR(st.st_mode):
            try:
                child_fd = _open_child_dir(dir_fd, name, st)
            except (OSError, GuardOperationError) as exc:
                if isinstance(exc, GuardOperationError):
                    issues.append(Issue(exc.issue.code, path, exc.issue.detail))
                else:
                    issues.append(
                        _os_issue("verification-open-failed", path, "open", exc)
                    )
                continue
            try:
                if context.is_writable_root(relative_path):
                    writable_issue = _verify_writable_subpath_metadata(
                        context,
                        path,
                        relative_path,
                        os.fstat(child_fd),
                        policy,
                        identity,
                    )
                    if writable_issue is not None:
                        issues.append(writable_issue)
                else:
                    _verify_dir(
                        context,
                        child_fd,
                        relative_path,
                        policy,
                        action,
                        identity,
                        replaced_inodes,
                        issues,
                        depth + 1,
                    )
            finally:
                os.close(child_fd)
        elif stat.S_ISREG(st.st_mode):
            if st.st_nlink != 1:
                issues.append(
                    Issue(
                        "hardlinked-entry",
                        path,
                        f"regular file has link count {st.st_nlink}, expected 1",
                    )
                )
            metadata_issue = _verify_metadata(
                path,
                st,
                "file",
                policy,
                action,
                identity,
                allow_openclaw_native_mutable=(
                    action == "unlock"
                    and policy == "high-risk"
                    and context.is_openclaw_native_mutable_path(relative_path)
                ),
            )
            if metadata_issue is not None:
                issues.append(metadata_issue)
            old_inode = replaced_inodes.get(relative_path)
            if action == "lock" and old_inode is not None and st.st_ino == old_inode:
                issues.append(
                    Issue(
                        "verification-inode-not-replaced",
                        path,
                        "locked file still uses its pre-lock inode",
                    )
                )
        elif stat.S_ISLNK(st.st_mode):
            metadata_issue = _verify_metadata(
                path, st, "symlink", policy, action, identity
            )
            if metadata_issue is not None:
                issues.append(metadata_issue)
            symlink_issue = _validate_symlink(context, dir_fd, name, relative_path, st)
            if symlink_issue is not None:
                issues.append(symlink_issue)
        else:
            issues.append(
                Issue(
                    "special-entry",
                    path,
                    f"state tree contains a {_entry_kind(st)}",
                )
            )


def _restore_empty_credentials_startup_access(
    config_dir: str,
    identity: Identity,
    deadline: float,
    plan: AgentStateLockPlan,
) -> GuardResult:
    """Restore only the empty credentials traversal needed during startup."""

    result = GuardResult(action="startup")
    config_fd = -1
    credentials_fd = -1
    path = _display_path(config_dir, "credentials")
    if "credentials" not in plan.confidential_roots:
        result.issues.append(
            Issue(
                "startup-plan-mismatch",
                path,
                "state lock plan must declare credentials as a confidential root",
            )
        )
        return result
    try:
        config_fd = _open_absolute_dir_nofollow(config_dir)
        config_st = os.fstat(config_fd)
        config_mode = stat.S_IMODE(config_st.st_mode)
        if config_st.st_uid != identity.root_uid or config_mode & 0o022:
            result.issues.append(
                Issue(
                    "startup-posture-mismatch",
                    config_dir,
                    "sealed config directory must be root-owned and not group/world writable",
                )
            )
            return result
        try:
            credentials_st = os.stat(
                "credentials", dir_fd=config_fd, follow_symlinks=False
            )
        except FileNotFoundError:
            return result
        if (
            not stat.S_ISDIR(credentials_st.st_mode)
            or credentials_st.st_dev != config_st.st_dev
        ):
            result.issues.append(
                Issue(
                    "unsafe-startup-credentials-root",
                    path,
                    "credentials root must be a directory on the config filesystem",
                )
            )
            return result
        credentials_fd = _open_child_dir(config_fd, "credentials", credentials_st)
        names = _bounded_directory_names(
            credentials_fd, path, WorkBudget(deadline)
        )
        current = os.fstat(credentials_fd)
        mode = stat.S_IMODE(current.st_mode)
        root_only = (
            current.st_uid == identity.root_uid
            and current.st_gid == identity.root_gid
            and mode == 0o700
        )
        startup_traversable = (
            current.st_uid == identity.root_uid
            and current.st_gid == identity.sandbox_gid
            and mode == 0o710
        )
        if not root_only and not startup_traversable:
            result.issues.append(
                Issue(
                    "startup-posture-mismatch",
                    path,
                    f"credentials root has unexpected owner or mode {mode:04o}",
                )
            )
            return result
        # All confidentiality roots are execute-only for the sandbox group,
        # whether or not they currently contain credentials.  This preserves
        # known-name ENOENT probes without exposing names or descendants.
        _set_dir_metadata(
            credentials_fd,
            "confidentiality",
            "lock",
            identity,
            is_confidentiality_root=True,
        )
        after = os.fstat(credentials_fd)
        if (
            after.st_uid != identity.root_uid
            or after.st_gid != identity.sandbox_gid
            or stat.S_IMODE(after.st_mode) != 0o710
        ):
            result.issues.append(
                Issue(
                    "startup-verification-failed",
                    path,
                    "empty credentials root did not reach root:sandbox 0710",
                )
            )
            return result
        os.fsync(credentials_fd)
        result.roots = 1
        result.directories = 1
        return result
    except (OSError, GuardOperationError) as exc:
        result.issues.append(
            exc.issue
            if isinstance(exc, GuardOperationError)
            else _os_issue(
                "startup-restore-failed",
                path,
                "restore empty credentials startup access",
                exc,
            )
        )
        return result
    finally:
        if credentials_fd >= 0:
            os.close(credentials_fd)
        if config_fd >= 0:
            os.close(config_fd)


def _run_guard_unserialized(
    action: Action,
    config_dir: str,
    identity: Identity,
    plan: AgentStateLockPlan,
) -> GuardResult:
    """Run one guard action.  ``identity`` is explicit for focused tests."""

    result = GuardResult(action=action)
    deadline = time.monotonic() + MAX_GUARD_SECONDS
    normalized_config = posixpath.normpath(config_dir)
    if action == "startup":
        return _restore_empty_credentials_startup_access(
            normalized_config, identity, deadline, plan
        )
    fail_closed_config_root = action == "lock" and (
        normalized_config in PRODUCTION_FAIL_CLOSED_CONFIG_DIRS
        or os.environ.get("NEMOCLAW_TEST_OPENCLAW_FAIL_CLOSED") == "1"
        or os.environ.get("NEMOCLAW_TEST_HERMES_FAIL_CLOSED") == "1"
        or os.environ.get("NEMOCLAW_TEST_DEEP_AGENTS_FAIL_CLOSED") == "1"
    )
    config_fd = -1
    try:
        config_fd = _open_absolute_dir_nofollow(normalized_config)
        config_st = os.fstat(config_fd)
        if not stat.S_ISDIR(config_st.st_mode):
            result.issues.append(
                Issue(
                    "invalid-config-path",
                    normalized_config,
                    "config path is not a directory",
                )
            )
            return result

        if fail_closed_config_root:
            # The agent top-config guard has already pinned the config root
            # under a root-owned outer parent. Clamp traversal before any
            # attacker-sized listing. On every later error the directory stays
            # 0500, so no gateway/sandbox identity can consume partially
            # hardened code or state through the canonical namespace.
            _clear_mutation_flags(config_fd)
            os.fchmod(config_fd, 0o500)
            os.fchown(config_fd, identity.root_uid, identity.root_gid)
            os.fchmod(config_fd, 0o500)
            os.fsync(config_fd)

        if action == "lock":
            result.removed_entries += _remove_unsupported_root_entries_for_lock(
                config_fd, normalized_config, config_st.st_dev, plan
            )

        roots, issues = _preflight(
            config_fd,
            normalized_config,
            config_st.st_dev,
            deadline,
            action,
            plan,
        )
        result.roots = len(roots)
        result.issues.extend(issues)
        if action == "preflight" or issues:
            return result

        # Detect root swaps/creations between preflight and mutation before
        # changing any metadata.  Each root inode is checked again when opened.
        current_roots, selection_issues = _select_roots(
            config_fd, normalized_config, config_st.st_dev, plan
        )
        result.issues.extend(selection_issues)
        expected_root_set = {(root.name, root.dev, root.ino) for root in roots}
        current_root_set = {(root.name, root.dev, root.ino) for root in current_roots}
        if expected_root_set != current_root_set:
            result.issues.append(
                Issue(
                    "root-set-changed",
                    normalized_config,
                    "protected state-dir roots changed after preflight",
                )
            )
            return result

        context = TraversalContext(
            config_fd,
            normalized_config,
            config_st.st_dev,
            tuple(root.name for root in roots),
            WorkBudget(deadline),
            plan.writable_subpaths,
        )
        replaced_inodes: dict[str, int] = {}
        for root in roots:
            path = context.display(root.name)
            try:
                root_lstat = os.stat(root.name, dir_fd=config_fd, follow_symlinks=False)
                context.budget.observe_entry(path, root_lstat)
                if root_lstat.st_dev != root.dev or root_lstat.st_ino != root.ino:
                    raise GuardOperationError(
                        Issue(
                            "entry-raced",
                            path,
                            "state-dir root changed after preflight",
                        )
                    )
                root_fd = _open_child_dir(config_fd, root.name, root_lstat)
                try:
                    _mutate_dir(
                        context,
                        root_fd,
                        root.name,
                        root.policy,
                        action,
                        identity,
                        result,
                        replaced_inodes,
                        1,
                        is_root=True,
                    )
                finally:
                    os.close(root_fd)
            except GuardOperationError as exc:
                result.issues.append(exc.issue)
                return result
            except OSError as exc:
                result.issues.append(
                    _os_issue("mutation-failed", path, "mutate state-dir root", exc)
                )
                return result

        # A second independent descriptor traversal verifies the recursive
        # result and catches entries changed by a concurrent pre-open FD.
        verify_roots, selection_issues = _select_roots(
            config_fd, normalized_config, config_st.st_dev, plan
        )
        result.issues.extend(selection_issues)
        verify_root_set = {(root.name, root.dev, root.ino) for root in verify_roots}
        if verify_root_set != current_root_set:
            result.issues.append(
                Issue(
                    "verification-root-set-changed",
                    normalized_config,
                    "protected state-dir roots changed during mutation",
                )
            )
            return result
        context.budget = WorkBudget(deadline)
        for root in verify_roots:
            path = context.display(root.name)
            try:
                root_lstat = os.stat(root.name, dir_fd=config_fd, follow_symlinks=False)
                context.budget.observe_entry(path, root_lstat)
                root_fd = _open_child_dir(config_fd, root.name, root_lstat)
            except (OSError, GuardOperationError) as exc:
                if isinstance(exc, GuardOperationError):
                    result.issues.append(Issue(exc.issue.code, path, exc.issue.detail))
                else:
                    result.issues.append(
                        _os_issue("verification-open-failed", path, "open root", exc)
                    )
                continue
            try:
                _verify_dir(
                    context,
                    root_fd,
                    root.name,
                    root.policy,
                    action,
                    identity,
                    replaced_inodes,
                    result.issues,
                    1,
                    is_root=True,
                )
            finally:
                os.close(root_fd)
        if fail_closed_config_root and not result.issues:
            os.fchmod(config_fd, 0o755)
            os.fsync(config_fd)
        return result
    except GuardOperationError as exc:
        result.issues.append(exc.issue)
        return result
    except OSError as exc:
        result.issues.append(
            _os_issue(
                "config-open-failed", normalized_config, "open config directory", exc
            )
        )
        return result
    finally:
        if config_fd >= 0:
            os.close(config_fd)


def _transition_lock_path(config_dir: str) -> str | None:
    if config_dir == "/sandbox/.openclaw":
        return OPENCLAW_MUTATION_MUTEX_PATH
    if os.environ.get("NEMOCLAW_TEST_OPENCLAW_TRANSACTION_LOCK") == "1":
        return posixpath.join(
            posixpath.dirname(config_dir), ".openclaw-config-mutation.lock"
        )
    return None


def _acquire_transition_lock(path: str, identity: Identity) -> int:
    parent_fd = _open_absolute_dir_nofollow(posixpath.dirname(path))
    name = posixpath.basename(path)
    fd = -1
    try:
        fd = os.open(
            name,
            os.O_RDWR
            | os.O_CREAT
            | getattr(os, "O_NOFOLLOW", 0)
            | getattr(os, "O_CLOEXEC", 0),
            0o600,
            dir_fd=parent_fd,
        )
        opened = os.fstat(fd)
        current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        if (
            not stat.S_ISREG(opened.st_mode)
            or opened.st_nlink != 1
            or not _same_entry(opened, current)
            or opened.st_uid != identity.root_uid
            or opened.st_gid != identity.root_gid
            or stat.S_IMODE(opened.st_mode) != 0o600
        ):
            raise GuardOperationError(
                Issue(
                    "unsafe-transition-lock",
                    path,
                    "transition mutex must be a private root-owned regular file",
                )
            )
        fcntl.flock(fd, fcntl.LOCK_EX)
        after = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        if not _same_entry(opened, after):
            raise GuardOperationError(
                Issue(
                    "transition-lock-raced",
                    path,
                    "transition mutex changed while waiting",
                )
            )
        return fd
    except Exception:
        if fd >= 0:
            os.close(fd)
        raise
    finally:
        os.close(parent_fd)


def _run_guard_with_transition_lock_fd(
    action: Action,
    config_dir: str,
    identity: Identity,
    plan: AgentStateLockPlan,
    lock_path: str,
    lock_fd: int,
) -> GuardResult:
    """Run under the caller's inherited OpenClaw mutation-mutex description.

    The caller must hold the mutex exclusively. Re-locking an inherited
    descriptor succeeds while a separately opened one blocks, which is what
    proves inheritance. A shared lock would pass without giving exclusion, so
    do not reuse this path for read-only actions.
    """

    try:
        opened = os.fstat(lock_fd)
        current = os.stat(lock_path, follow_symlinks=False)
        if (
            not stat.S_ISREG(opened.st_mode)
            or opened.st_nlink != 1
            or not _same_entry(opened, current)
            or opened.st_uid != identity.root_uid
            or opened.st_gid != identity.root_gid
            or stat.S_IMODE(opened.st_mode) != 0o600
            or opened.st_size > MAX_TRANSITION_LOCK_BYTES
        ):
            raise GuardOperationError(
                Issue(
                    "unsafe-transition-lock",
                    lock_path,
                    "inherited mutation mutex must be the private root-owned lock file",
                )
            )
        try:
            # An inherited descriptor shares the parent's flock ownership; a
            # separately opened one blocks and cannot bypass serialization.
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise GuardOperationError(
                Issue(
                    "transition-lock-not-inherited",
                    lock_path,
                    "mutation mutex descriptor does not share the caller's lock",
                )
            ) from exc
        after = os.stat(lock_path, follow_symlinks=False)
        if not _same_entry(opened, after):
            raise GuardOperationError(
                Issue(
                    "transition-lock-raced",
                    lock_path,
                    "transition mutex changed during inherited-lock verification",
                )
            )
        return _run_guard_unserialized(action, config_dir, identity, plan)
    except GuardOperationError as exc:
        result = GuardResult(action=action)
        result.issues.append(exc.issue)
        return result
    except OSError as exc:
        result = GuardResult(action=action)
        result.issues.append(
            _os_issue(
                "transition-lock-failed", lock_path, "verify inherited mutation mutex", exc
            )
        )
        return result


def run_guard(
    action: Action,
    config_dir: str,
    identity: Identity,
    plan: AgentStateLockPlan,
    *,
    transition_lock_fd: int | None = None,
) -> GuardResult:
    """Serialize production OpenClaw recursive transitions with its top guard."""

    normalized_config = posixpath.normpath(config_dir)
    lock_path = _transition_lock_path(normalized_config)
    if transition_lock_fd is not None:
        if lock_path is None:
            result = GuardResult(action=action)
            result.issues.append(
                Issue(
                    "unexpected-transition-lock-fd",
                    normalized_config,
                    "an inherited transition mutex is valid only for serialized OpenClaw state",
                )
            )
            return result
        return _run_guard_with_transition_lock_fd(
            action,
            normalized_config,
            identity,
            plan,
            lock_path,
            transition_lock_fd,
        )
    if lock_path is None:
        return _run_guard_unserialized(action, normalized_config, identity, plan)

    lock_fd = -1
    try:
        lock_fd = _acquire_transition_lock(lock_path, identity)
        if normalized_config != "/sandbox/.openclaw":
            ready_path = os.environ.get("NEMOCLAW_TEST_TRANSACTION_LOCK_READY")
            if ready_path:
                with open(ready_path, "w", encoding="utf-8") as stream:
                    stream.write("ready\n")
            hold_ms = int(os.environ.get("NEMOCLAW_TEST_TRANSACTION_LOCK_HOLD_MS", "0"))
            if hold_ms > 0:
                time.sleep(hold_ms / 1000)
        return _run_guard_unserialized(action, normalized_config, identity, plan)
    except GuardOperationError as exc:
        result = GuardResult(action=action)
        result.issues.append(exc.issue)
        return result
    except (OSError, ValueError) as exc:
        result = GuardResult(action=action)
        result.issues.append(
            _os_issue(
                "transition-lock-failed", lock_path, "acquire transition mutex", exc
            )
            if isinstance(exc, OSError)
            else Issue("transition-lock-failed", lock_path, str(exc))
        )
        return result
    finally:
        if lock_fd >= 0:
            try:
                fcntl.flock(lock_fd, fcntl.LOCK_UN)
            finally:
                os.close(lock_fd)


def _production_identity() -> Identity:
    sandbox_user = pwd.getpwnam("sandbox")
    sandbox_group = grp.getgrnam("sandbox")
    return Identity(
        root_uid=0,
        root_gid=0,
        sandbox_uid=sandbox_user.pw_uid,
        sandbox_gid=sandbox_group.gr_gid,
    )


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Safely manage recursive agent state directories"
    )
    parser.add_argument("action", choices=("preflight", "lock", "unlock", "startup"))
    parser.add_argument("--config-dir", required=True)
    plan_source = parser.add_mutually_exclusive_group()
    plan_source.add_argument("--plan-json")
    plan_source.add_argument("--plan-file")
    parser.add_argument("--transition-lock-fd", type=int, help=argparse.SUPPRESS)
    return parser.parse_args(argv)


def _bundled_plan_path() -> str:
    helper_dir = os.path.dirname(os.path.realpath(__file__))
    lib_dir = os.path.dirname(helper_dir)
    if os.path.basename(helper_dir) != "nemoclaw" or os.path.basename(lib_dir) != "lib":
        raise PlanValidationError(
            "a plan source is required outside a bundled lib/nemoclaw helper layout"
        )
    prefix = os.path.dirname(lib_dir)
    return os.path.join(prefix, "share", "nemoclaw", "state-lock-plan.json")


def _load_plan(args: argparse.Namespace) -> AgentStateLockPlan:
    if args.plan_json is not None:
        payload = args.plan_json
        if len(payload.encode("utf-8")) > MAX_PLAN_BYTES:
            raise PlanValidationError(
                f"plan exceeds the {MAX_PLAN_BYTES}-byte input limit"
            )
    else:
        plan_file = args.plan_file or _bundled_plan_path()
        try:
            with open(plan_file, "rb") as stream:
                raw = stream.read(MAX_PLAN_BYTES + 1)
        except OSError as exc:
            raise PlanValidationError(f"cannot read plan file: {exc}") from exc
        if len(raw) > MAX_PLAN_BYTES:
            raise PlanValidationError(
                f"plan exceeds the {MAX_PLAN_BYTES}-byte input limit"
            )
        try:
            payload = raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise PlanValidationError("plan file must contain UTF-8 JSON") from exc
    return parse_agent_state_lock_plan(payload)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    try:
        plan = _load_plan(args)
    except PlanValidationError as exc:
        result = GuardResult(action=args.action)
        result.issues.append(Issue("invalid-plan", args.config_dir, str(exc)))
    else:
        if os.geteuid() != 0:
            result = GuardResult(action=args.action)
            result.issues.append(
                Issue("root-required", args.config_dir, "state-dir guard must run as root")
            )
        else:
            try:
                identity = _production_identity()
            except KeyError as exc:
                result = GuardResult(action=args.action)
                result.issues.append(
                    Issue(
                        "identity-unavailable",
                        args.config_dir,
                        f"required sandbox account is unavailable: {exc}",
                    )
                )
            else:
                result = run_guard(
                    args.action,
                    args.config_dir,
                    identity,
                    plan,
                    transition_lock_fd=args.transition_lock_fd,
                )

    for issue in result.issues:
        print(json.dumps(issue.as_json(), sort_keys=True, separators=(",", ":")))
    print(json.dumps(result.summary_json(), sort_keys=True, separators=(",", ":")))
    return 0 if result.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
