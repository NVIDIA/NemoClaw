#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Retire Hermes' legacy dashboard homes without losing agent-owned state.

The dashboard now uses the native Hermes home. Older images wrote durable
state below ``dashboard-home`` or ``profiles/dashboard-home``. Merge those
trees into the native home only when every path is a real directory or a
single-link regular file and every destination collision is byte-identical.
Generated shadow configuration is deliberately removed rather than allowed to
replace the native configuration.
"""

from __future__ import annotations

import argparse
import copy
import errno
import hashlib
import os
import secrets
import signal
import sqlite3
import stat
import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from managed_policy import (  # noqa: E402
    MANAGED_POLICY_PATH,
    ManagedPolicyError,
    load_managed_policy,
)


MANAGED_SHADOW_FILES = frozenset(
    {
        ".config-hash",
        ".env-hash",
        ".runtime-config-state.json",
        "gateway_state.json",
    }
)
VERIFIABLE_SHADOW_FILES = frozenset({"config.yaml", ".env"})
LEGACY_STATE_DATABASE = "state.db"
STALE_RUNTIME_FILES = frozenset({"gateway.lock", "gateway.pid", "state.db-shm", "state.db-wal"})
STALE_RUNTIME_DIRECTORIES = frozenset({"logs"})
MAX_VERIFICATION_BYTES = 4 * 1024 * 1024
LEGACY_PATHS = ("dashboard-home", "profiles/dashboard-home")
DEFAULT_MAX_ENTRIES = 100_000
DEFAULT_MAX_DEPTH = 64
DEFAULT_MAX_BYTES = 10 * 1024 * 1024 * 1024


class MigrationError(Exception):
    """A legacy tree cannot be migrated without guessing or following links."""


@dataclass(frozen=True)
class EntryIdentity:
    device: int
    inode: int
    mode: int
    links: int
    size: int


@dataclass
class MigrationBudget:
    max_entries: int
    max_depth: int
    max_bytes: int
    entries: int = 0
    total_bytes: int = 0

    def consume(self, entry: EntryIdentity, display: str, depth: int) -> None:
        if depth > self.max_depth:
            raise MigrationError(
                f"legacy dashboard state exceeds maximum depth {self.max_depth} at {display}"
            )
        self.entries += 1
        if self.entries > self.max_entries:
            raise MigrationError(
                f"legacy dashboard state exceeds maximum entry count {self.max_entries}"
            )
        if stat.S_ISREG(entry.mode):
            self.total_bytes += entry.size
            if self.total_bytes > self.max_bytes:
                raise MigrationError(
                    f"legacy dashboard state exceeds maximum byte count {self.max_bytes}"
                )


@dataclass(frozen=True)
class ShadowMigrationPolicy:
    routing_keys: tuple[str, ...]
    managed_config_paths: tuple[tuple[str, ...], ...]
    env_keys: frozenset[str]


def _load_shadow_migration_policy(path: str) -> ShadowMigrationPolicy:
    try:
        document = load_managed_policy(Path(path))
    except ManagedPolicyError as exc:
        raise MigrationError(f"managed Hermes policy is invalid: {exc}") from exc
    shadow = document["shadow_migration"]
    managed_paths = tuple(tuple(value.split(".")) for value in document["managed_paths"])
    if any(not path or any(not segment for segment in path) for path in managed_paths):
        raise MigrationError("managed Hermes policy contains an invalid managed path")
    return ShadowMigrationPolicy(
        routing_keys=tuple(shadow["routing_keys"]),
        managed_config_paths=managed_paths,
        env_keys=frozenset(shadow["env_keys"]),
    )


def _identity(parent_fd: int, name: str, display: str) -> EntryIdentity:
    try:
        current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except OSError as exc:
        raise MigrationError(f"{display} could not be inspected: {exc.strerror}") from exc
    if stat.S_ISLNK(current.st_mode):
        raise MigrationError(f"{display} is a symbolic link")
    if not stat.S_ISDIR(current.st_mode) and not stat.S_ISREG(current.st_mode):
        raise MigrationError(f"{display} is not a regular file or directory")
    if stat.S_ISREG(current.st_mode) and current.st_nlink != 1:
        raise MigrationError(f"{display} has hard-link count {current.st_nlink}")
    return EntryIdentity(
        current.st_dev,
        current.st_ino,
        current.st_mode,
        current.st_nlink,
        current.st_size,
    )


def _open_dir(parent_fd: int, name: str, display: str) -> int:
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    flags |= getattr(os, "O_CLOEXEC", 0)
    try:
        return os.open(name, flags, dir_fd=parent_fd)
    except OSError as exc:
        raise MigrationError(f"{display} is not a safe directory: {exc.strerror}") from exc


def _open_file(parent_fd: int, name: str, display: str) -> int:
    flags = os.O_RDONLY | os.O_NOFOLLOW
    flags |= getattr(os, "O_CLOEXEC", 0)
    try:
        fd = os.open(name, flags, dir_fd=parent_fd)
    except OSError as exc:
        raise MigrationError(f"{display} is not a safe regular file: {exc.strerror}") from exc
    try:
        opened = os.fstat(fd)
        if not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1:
            raise MigrationError(f"{display} is not a single-link regular file")
    except BaseException:
        os.close(fd)
        raise
    return fd


def _same_file(
    source_fd: int,
    source_name: str,
    source_display: str,
    target_fd: int,
    target_name: str,
    target_display: str,
) -> bool:
    left = _open_file(source_fd, source_name, source_display)
    try:
        right = _open_file(target_fd, target_name, target_display)
        try:
            if os.fstat(left).st_size != os.fstat(right).st_size:
                return False
            while True:
                left_chunk = os.read(left, 64 * 1024)
                right_chunk = os.read(right, 64 * 1024)
                if left_chunk != right_chunk:
                    return False
                if not left_chunk:
                    return True
        finally:
            os.close(right)
    finally:
        os.close(left)


def _entries(fd: int) -> list[str]:
    try:
        return sorted(os.listdir(fd))
    except OSError as exc:
        raise MigrationError(f"legacy dashboard state could not be listed: {exc.strerror}") from exc


def _read_text(parent_fd: int, name: str, display: str) -> str | None:
    fd = _open_file(parent_fd, name, display)
    try:
        size = os.fstat(fd).st_size
        if size > MAX_VERIFICATION_BYTES:
            return None
        chunks: list[bytes] = []
        remaining = size + 1
        while remaining > 0:
            chunk = os.read(fd, min(64 * 1024, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        if remaining == 0:
            return None
        return b"".join(chunks).decode("utf-8")
    except (OSError, UnicodeDecodeError):
        return None
    finally:
        os.close(fd)


def _path_value(document: dict, path: tuple[str, ...]) -> tuple[bool, object]:
    current: object = document
    for segment in path:
        if not isinstance(current, dict) or segment not in current:
            return False, None
        current = current[segment]
    return True, current


def _remove_path(document: dict, path: tuple[str, ...]) -> None:
    parents: list[tuple[dict, str]] = []
    current = document
    for segment in path[:-1]:
        child = current.get(segment)
        if not isinstance(child, dict):
            return
        parents.append((current, segment))
        current = child
    current.pop(path[-1], None)
    for parent, segment in reversed(parents):
        child = parent.get(segment)
        if isinstance(child, dict) and not child:
            parent.pop(segment, None)


def _is_subset_equal(candidate: object, reference: object) -> bool:
    if isinstance(candidate, dict):
        return isinstance(reference, dict) and all(
            key in reference and _is_subset_equal(value, reference[key])
            for key, value in candidate.items()
        )
    return candidate == reference


def _load_unique_yaml(text: str) -> object:
    import yaml

    class UniqueKeyLoader(yaml.SafeLoader):
        pass

    def construct_unique_mapping(
        loader: UniqueKeyLoader, node: yaml.nodes.MappingNode, deep: bool = False
    ) -> dict:
        mapping: dict = {}
        for key_node, value_node in node.value:
            key = loader.construct_object(key_node, deep=deep)
            try:
                duplicate = key in mapping
            except TypeError as exc:
                raise yaml.constructor.ConstructorError(
                    "while constructing a mapping",
                    node.start_mark,
                    "found an unhashable mapping key",
                    key_node.start_mark,
                ) from exc
            if duplicate:
                raise yaml.constructor.ConstructorError(
                    "while constructing a mapping",
                    node.start_mark,
                    f"found duplicate key {key!r}",
                    key_node.start_mark,
                )
            mapping[key] = loader.construct_object(value_node, deep=deep)
        return mapping

    UniqueKeyLoader.add_constructor(
        yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG,
        construct_unique_mapping,
    )
    return yaml.load(text, Loader=UniqueKeyLoader)


def _verified_generated_config(
    source_fd: int,
    source_name: str,
    source_display: str,
    target_fd: int,
    target_name: str,
    target_display: str,
    policy: ShadowMigrationPolicy,
) -> bool:
    source_text = _read_text(source_fd, source_name, source_display)
    target_text = _read_text(target_fd, target_name, target_display)
    if source_text is None or target_text is None:
        return False
    try:
        source = _load_unique_yaml(source_text)
        target = _load_unique_yaml(target_text)
    except Exception:
        return False
    if not isinstance(source, dict) or not isinstance(target, dict):
        return False

    for key in policy.routing_keys:
        expected = copy.deepcopy(target.get(key))
        if key == "model" and isinstance(expected, dict):
            upstream = target.get("_nemoclaw_upstream")
            if isinstance(upstream, dict) and isinstance(upstream.get("provider_key"), str):
                expected["provider"] = upstream["provider_key"]
        if source.get(key) != expected or (key in source) != (key in target):
            return False

    for path in policy.managed_config_paths:
        present, value = _path_value(source, path)
        if present:
            target_present, target_value = _path_value(target, path)
            if not target_present or value != target_value:
                return False

    source_web = source.get("web")
    if isinstance(source_web, dict) and "backend" in source_web:
        target_web = target.get("web")
        if not isinstance(target_web, dict) or source_web["backend"] != target_web.get("backend"):
            return False
    version = source.get("_config_version")
    if version is not None and not isinstance(version, int):
        return False

    source_residual = copy.deepcopy(source)
    target_residual = copy.deepcopy(target)
    for document in (source_residual, target_residual):
        document.pop("_config_version", None)
        for key in policy.routing_keys:
            document.pop(key, None)
        for path in policy.managed_config_paths:
            _remove_path(document, path)
        _remove_path(document, ("web", "backend"))
    return _is_subset_equal(source_residual, target_residual)


def _parse_env(text: str) -> dict[str, str] | None:
    values: dict[str, str] = {}
    for line in text.splitlines():
        candidate = line.lstrip()
        if candidate.startswith("export "):
            candidate = candidate[len("export ") :].lstrip()
        if not candidate or "=" not in candidate:
            if candidate:
                return None
            continue
        key, value = candidate.split("=", 1)
        key = key.strip()
        if not key or key in values:
            return None
        values[key] = value.strip()
    return values


def _verified_generated_env(
    source_fd: int,
    source_name: str,
    source_display: str,
    target_fd: int,
    target_name: str,
    target_display: str,
    policy: ShadowMigrationPolicy,
) -> bool:
    source_text = _read_text(source_fd, source_name, source_display)
    target_text = _read_text(target_fd, target_name, target_display)
    if source_text is None or target_text is None:
        return False
    source = _parse_env(source_text)
    target = _parse_env(target_text)
    return (
        source is not None
        and target is not None
        and all(key in policy.env_keys and target.get(key) == value for key, value in source.items())
    )


def _is_verified_generated_shadow(
    source_fd: int,
    source_name: str,
    logical_name: str,
    source_display: str,
    target_fd: int,
    target_display: str,
    policy: ShadowMigrationPolicy,
) -> bool:
    if logical_name == "config.yaml":
        return _verified_generated_config(
            source_fd,
            source_name,
            source_display,
            target_fd,
            logical_name,
            target_display,
            policy,
        )
    if logical_name == ".env":
        return _verified_generated_env(
            source_fd,
            source_name,
            source_display,
            target_fd,
            logical_name,
            target_display,
            policy,
        )
    return False


def _source_has_user_state(
    source_fd: int,
    source_display: str,
    target_fd: int,
    target_display: str,
    policy: ShadowMigrationPolicy,
) -> bool:
    for name in _entries(source_fd):
        source_path = f"{source_display}/{name}"
        source = _identity(source_fd, name, source_path)
        if name in MANAGED_SHADOW_FILES:
            if not stat.S_ISREG(source.mode):
                raise MigrationError(f"generated shadow path {source_path} is not a regular file")
            continue
        if name in STALE_RUNTIME_FILES:
            if not stat.S_ISREG(source.mode):
                raise MigrationError(f"stale runtime path {source_path} is not a regular file")
            continue
        if name in STALE_RUNTIME_DIRECTORIES:
            if not stat.S_ISDIR(source.mode):
                raise MigrationError(f"stale runtime path {source_path} is not a directory")
            continue
        if name in VERIFIABLE_SHADOW_FILES and stat.S_ISREG(source.mode):
            target_path = f"{target_display}/{name}"
            if _lookup(target_fd, name) is not None and _is_verified_generated_shadow(
                source_fd,
                name,
                name,
                source_path,
                target_fd,
                target_path,
                policy,
            ):
                continue
        return True
    return False


def _lookup(parent_fd: int, name: str) -> os.stat_result | None:
    try:
        return os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        return None


def _open_native_runtime_directory(target_fd: int, target_display: str) -> int:
    runtime = _lookup(target_fd, "runtime")
    if runtime is None:
        raise MigrationError(f"native Hermes runtime directory is missing at {target_display}/runtime")
    if not stat.S_ISDIR(runtime.st_mode):
        raise MigrationError(
            f"native Hermes runtime path is not a safe directory at {target_display}/runtime"
        )
    return _open_dir(target_fd, "runtime", f"{target_display}/runtime")


def _validate_native_state_destination(target_fd: int, target_display: str) -> int:
    compatibility = _lookup(target_fd, LEGACY_STATE_DATABASE)
    if compatibility is not None:
        if not stat.S_ISLNK(compatibility.st_mode):
            raise MigrationError(
                f"native Hermes state path conflicts at {target_display}/{LEGACY_STATE_DATABASE}"
            )
        try:
            link_target = os.readlink(LEGACY_STATE_DATABASE, dir_fd=target_fd)
        except OSError as exc:
            raise MigrationError(
                f"native Hermes state link could not be inspected: {exc.strerror}"
            ) from exc
        if link_target != "runtime/state.db":
            raise MigrationError(
                f"native Hermes state link has an unexpected target at "
                f"{target_display}/{LEGACY_STATE_DATABASE}"
            )
    runtime_fd = _open_native_runtime_directory(target_fd, target_display)
    if _lookup(runtime_fd, LEGACY_STATE_DATABASE) is not None:
        os.close(runtime_fd)
        raise MigrationError(
            f"legacy dashboard state conflicts with native state at "
            f"{target_display}/runtime/{LEGACY_STATE_DATABASE}"
        )
    return runtime_fd


def _preflight_tree(
    source_fd: int,
    source_display: str,
    target_fd: int,
    target_display: str,
    policy: ShadowMigrationPolicy,
    budget: MigrationBudget,
    depth: int,
) -> None:
    for name in _entries(source_fd):
        source_path = f"{source_display}/{name}"
        target_path = f"{target_display}/{name}"
        source = _identity(source_fd, name, source_path)
        budget.consume(source, source_path, depth)
        at_legacy_root = source_display.rsplit("/", 1)[-1] == "dashboard-home"
        if at_legacy_root and name == LEGACY_STATE_DATABASE:
            if not stat.S_ISREG(source.mode):
                raise MigrationError(f"legacy state database {source_path} is not a regular file")
            runtime_fd = _validate_native_state_destination(target_fd, target_display)
            os.close(runtime_fd)
            continue
        if at_legacy_root and name in STALE_RUNTIME_FILES:
            if not stat.S_ISREG(source.mode):
                raise MigrationError(f"stale runtime path {source_path} is not a regular file")
            continue
        if at_legacy_root and name in STALE_RUNTIME_DIRECTORIES:
            if not stat.S_ISDIR(source.mode):
                raise MigrationError(f"stale runtime path {source_path} is not a directory")
            child = _open_dir(source_fd, name, source_path)
            try:
                _preflight_tree(child, source_path, child, source_path, policy, budget, depth + 1)
            finally:
                os.close(child)
            continue
        if at_legacy_root and name in MANAGED_SHADOW_FILES:
            if not stat.S_ISREG(source.mode):
                raise MigrationError(f"generated shadow path {source_path} is not a regular file")
            continue
        target = _lookup(target_fd, name)
        if (
            at_legacy_root
            and name in VERIFIABLE_SHADOW_FILES
            and target is not None
            and stat.S_ISREG(source.mode)
            and _is_verified_generated_shadow(
                source_fd,
                name,
                name,
                source_path,
                target_fd,
                target_path,
                policy,
            )
        ):
            continue
        if target is None:
            if stat.S_ISDIR(source.mode):
                child = _open_dir(source_fd, name, source_path)
                try:
                    _preflight_tree(
                        child, source_path, child, source_path, policy, budget, depth + 1
                    )
                finally:
                    os.close(child)
            continue
        target_identity = _identity(target_fd, name, target_path)
        if stat.S_ISDIR(source.mode) and stat.S_ISDIR(target_identity.mode):
            source_child = _open_dir(source_fd, name, source_path)
            try:
                target_child = _open_dir(target_fd, name, target_path)
                try:
                    _preflight_tree(
                        source_child,
                        source_path,
                        target_child,
                        target_path,
                        policy,
                        budget,
                        depth + 1,
                    )
                finally:
                    os.close(target_child)
            finally:
                os.close(source_child)
            continue
        if stat.S_ISREG(source.mode) and stat.S_ISREG(target_identity.mode):
            if _same_file(source_fd, name, source_path, target_fd, name, target_path):
                continue
            raise MigrationError(
                f"legacy dashboard state conflicts with native state at {target_path}"
            )
        raise MigrationError(f"legacy dashboard state has a type conflict at {target_path}")


def _rename_no_replace(
    source_fd: int, name: str, target_fd: int, target_name: str | None = None
) -> None:
    import ctypes

    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == "darwin":
        rename_no_replace = getattr(libc, "renameatx_np", None)
        flag = 0x00000004
        unavailable = "renameatx_np is unavailable"
    else:
        rename_no_replace = getattr(libc, "renameat2", None)
        flag = 1
        unavailable = "renameat2 is unavailable"
    if rename_no_replace is None:
        raise OSError(errno.ENOSYS, unavailable)
    rename_no_replace.argtypes = [
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_uint,
    ]
    rename_no_replace.restype = ctypes.c_int
    encoded_source = os.fsencode(name)
    encoded_target = os.fsencode(target_name if target_name is not None else name)
    if rename_no_replace(source_fd, encoded_source, target_fd, encoded_target, flag) != 0:
        number = ctypes.get_errno()
        raise OSError(number, os.strerror(number))


def _matches(identity: EntryIdentity, current: os.stat_result) -> bool:
    return (
        (current.st_dev, current.st_ino) == (identity.device, identity.inode)
        and stat.S_IFMT(current.st_mode) == stat.S_IFMT(identity.mode)
        and (not stat.S_ISREG(current.st_mode) or current.st_nlink == 1)
    )


def _move_no_replace_verified(
    source_fd: int,
    name: str,
    source_display: str,
    target_fd: int,
    target_display: str,
) -> None:
    before = _identity(source_fd, name, source_display)
    try:
        _rename_no_replace(source_fd, name, target_fd)
    except OSError as exc:
        raise MigrationError(f"{source_display} could not be moved safely: {exc.strerror}") from exc
    try:
        moved = os.stat(name, dir_fd=target_fd, follow_symlinks=False)
    except OSError as exc:
        raise MigrationError(
            f"{target_display} disappeared after migration: {exc.strerror}"
        ) from exc
    if _matches(before, moved):
        return
    try:
        _rename_no_replace(target_fd, name, source_fd)
    except OSError as rollback:
        raise MigrationError(
            f"{source_display} changed during migration and rollback failed: {rollback.strerror}"
        ) from rollback
    raise MigrationError(f"{source_display} changed during migration")


def _unlink_verified(
    parent_fd: int,
    name: str,
    display: str,
    expected: EntryIdentity | None = None,
) -> None:
    before = _identity(parent_fd, name, display)
    if not stat.S_ISREG(before.mode):
        raise MigrationError(f"{display} is not a regular file")
    if expected is not None and before != expected:
        raise MigrationError(f"{display} changed after verification")
    quarantine = ".nemoclaw-dashboard-migration-" + hashlib.sha256(
        os.fsencode(name)
    ).hexdigest()[:24]
    quarantined = False
    try:
        try:
            _rename_no_replace(parent_fd, name, parent_fd, quarantine)
            quarantined = True
        except OSError as exc:
            raise MigrationError(
                f"{display} could not be quarantined safely: {exc.strerror}"
            ) from exc
        moved = os.stat(quarantine, dir_fd=parent_fd, follow_symlinks=False)
        if not _matches(before, moved):
            raise MigrationError(f"{display} changed while it was quarantined")
        os.unlink(quarantine, dir_fd=parent_fd)
    except BaseException:
        if quarantined and _lookup(parent_fd, quarantine) is not None:
            if _lookup(parent_fd, name) is not None:
                raise MigrationError(
                    f"{display} could not be restored because its original name reappeared"
                )
            try:
                _rename_no_replace(parent_fd, quarantine, parent_fd, name)
            except OSError as rollback:
                raise MigrationError(
                    f"{display} could not be restored after deletion failed: "
                    f"{rollback.strerror}"
                ) from rollback
        raise


def _migrate_legacy_state_database(
    source_fd: int,
    source_name: str,
    source_display: str,
    target_fd: int,
    target_display: str,
) -> None:
    before = _identity(source_fd, source_name, source_display)
    if not stat.S_ISREG(before.mode):
        raise MigrationError(f"legacy state database {source_display} is not a regular file")
    runtime_fd = _validate_native_state_destination(target_fd, target_display)
    source_file_fd = -1
    temporary_name: str | None = None
    published = False
    try:
        source_file_fd = _open_file(source_fd, source_name, source_display)
        if not _matches(before, os.fstat(source_file_fd)):
            raise MigrationError(f"{source_display} changed before SQLite migration")
        for _ in range(64):
            candidate = f".nemoclaw-dashboard-state-{secrets.token_hex(12)}"
            flags = os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
            flags |= getattr(os, "O_CLOEXEC", 0)
            try:
                temporary_fd = os.open(candidate, flags, 0o600, dir_fd=runtime_fd)
            except FileExistsError:
                continue
            os.close(temporary_fd)
            temporary_name = candidate
            break
        if temporary_name is None:
            raise MigrationError("could not allocate a temporary native Hermes state database")

        descriptor_root = "/proc/self/fd" if os.path.isdir("/proc/self/fd") else "/dev/fd"
        source_path = f"{descriptor_root}/{source_file_fd}"
        destination_path = f"{descriptor_root}/{runtime_fd}/{temporary_name}"
        source_connection: sqlite3.Connection | None = None
        destination_connection: sqlite3.Connection | None = None
        try:
            source_connection = sqlite3.connect(
                f"file:{source_path}?mode=ro", uri=True, timeout=30
            )
            destination_connection = sqlite3.connect(destination_path, timeout=30)
            destination_connection.execute("PRAGMA busy_timeout=30000")
            source_connection.backup(destination_connection)
            integrity = destination_connection.execute("PRAGMA quick_check").fetchone()
            if integrity != ("ok",):
                raise MigrationError(
                    f"legacy state database failed SQLite quick_check: {integrity!r}"
                )
        except (OSError, sqlite3.Error) as exc:
            raise MigrationError(
                f"legacy state database could not be backed up safely: {exc}"
            ) from exc
        finally:
            if destination_connection is not None:
                destination_connection.close()
            if source_connection is not None:
                source_connection.close()

        current = os.stat(source_name, dir_fd=source_fd, follow_symlinks=False)
        if not _matches(before, os.fstat(source_file_fd)) or not _matches(before, current):
            raise MigrationError(f"{source_display} changed during SQLite migration")
        temporary_fd = _open_file(runtime_fd, temporary_name, destination_path)
        try:
            os.fchmod(temporary_fd, stat.S_IMODE(before.mode))
        finally:
            os.close(temporary_fd)
        _rename_no_replace(
            runtime_fd,
            temporary_name,
            runtime_fd,
            LEGACY_STATE_DATABASE,
        )
        published = True
        temporary_name = None
        _unlink_verified(source_fd, source_name, source_display, expected=before)
    except OSError as exc:
        raise MigrationError(
            f"legacy state database could not be published safely: {exc.strerror}"
        ) from exc
    finally:
        if source_file_fd >= 0:
            os.close(source_file_fd)
        if temporary_name is not None and _lookup(runtime_fd, temporary_name) is not None:
            os.unlink(temporary_name, dir_fd=runtime_fd)
        os.close(runtime_fd)
        if published and _lookup(source_fd, source_name) is not None:
            raise MigrationError(
                f"{source_display} was backed up to {target_display}/runtime/state.db but "
                "the legacy copy could not be retired"
            )


def _discard_runtime_directory(
    parent_fd: int,
    name: str,
    display: str,
    budget: MigrationBudget,
    depth: int,
) -> None:
    before = _identity(parent_fd, name, display)
    if not stat.S_ISDIR(before.mode):
        raise MigrationError(f"stale runtime path {display} is not a directory")
    child_fd = _open_dir(parent_fd, name, display)
    try:
        if not _matches(before, os.fstat(child_fd)):
            raise MigrationError(f"{display} changed before retirement")
        for child_name in _entries(child_fd):
            child_display = f"{display}/{child_name}"
            child = _identity(child_fd, child_name, child_display)
            budget.consume(child, child_display, depth)
            if stat.S_ISDIR(child.mode):
                _discard_runtime_directory(
                    child_fd,
                    child_name,
                    child_display,
                    budget,
                    depth + 1,
                )
            else:
                _unlink_verified(child_fd, child_name, child_display, expected=child)
        current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        if not _matches(before, os.fstat(child_fd)) or not _matches(before, current):
            raise MigrationError(f"{display} changed during retirement")
    finally:
        os.close(child_fd)
    try:
        os.rmdir(name, dir_fd=parent_fd)
    except OSError as exc:
        raise MigrationError(f"{display} could not be retired safely: {exc.strerror}") from exc


def _remove_generated_file(parent_fd: int, name: str, display: str) -> None:
    _unlink_verified(parent_fd, name, display)


def _remove_verified_generated_shadow(
    source_fd: int,
    name: str,
    source_display: str,
    target_fd: int,
    target_display: str,
    policy: ShadowMigrationPolicy,
) -> None:
    before = _identity(source_fd, name, source_display)
    if not stat.S_ISREG(before.mode):
        raise MigrationError(f"{source_display} is not a regular file")
    quarantine = ".nemoclaw-dashboard-verified-" + hashlib.sha256(
        os.fsencode(name)
    ).hexdigest()[:24]
    quarantined = False
    try:
        try:
            _rename_no_replace(source_fd, name, source_fd, quarantine)
            quarantined = True
        except OSError as exc:
            raise MigrationError(
                f"{source_display} could not be quarantined safely: {exc.strerror}"
            ) from exc
        moved = os.stat(quarantine, dir_fd=source_fd, follow_symlinks=False)
        if not _matches(before, moved):
            raise MigrationError(f"{source_display} changed while it was quarantined")
        if not _is_verified_generated_shadow(
            source_fd,
            quarantine,
            name,
            source_display,
            target_fd,
            target_display,
            policy,
        ):
            raise MigrationError(
                f"{source_display} changed before generated-state verification"
            )
        _unlink_verified(source_fd, quarantine, source_display, expected=before)
    except BaseException:
        if quarantined and _lookup(source_fd, quarantine) is not None:
            if _lookup(source_fd, name) is not None:
                raise MigrationError(
                    f"{source_display} could not be restored because its original name reappeared"
                )
            try:
                _rename_no_replace(source_fd, quarantine, source_fd, name)
            except OSError as rollback:
                raise MigrationError(
                    f"{source_display} could not be restored after verified deletion failed: "
                    f"{rollback.strerror}"
                ) from rollback
        raise


def _merge_tree(
    source_fd: int,
    source_display: str,
    target_fd: int,
    target_display: str,
    policy: ShadowMigrationPolicy,
    budget: MigrationBudget,
    depth: int,
) -> None:
    for name in _entries(source_fd):
        source_path = f"{source_display}/{name}"
        target_path = f"{target_display}/{name}"
        source = _identity(source_fd, name, source_path)
        budget.consume(source, source_path, depth)
        at_legacy_root = source_display.rsplit("/", 1)[-1] == "dashboard-home"
        if at_legacy_root and name == LEGACY_STATE_DATABASE:
            _migrate_legacy_state_database(
                source_fd,
                name,
                source_path,
                target_fd,
                target_display,
            )
            continue
        if at_legacy_root and name in STALE_RUNTIME_FILES:
            _unlink_verified(source_fd, name, source_path, expected=source)
            continue
        if at_legacy_root and name in STALE_RUNTIME_DIRECTORIES:
            _discard_runtime_directory(
                source_fd,
                name,
                source_path,
                budget,
                depth + 1,
            )
            continue
        if at_legacy_root and name in MANAGED_SHADOW_FILES:
            _remove_generated_file(source_fd, name, source_path)
            continue
        target = _lookup(target_fd, name)
        if (
            at_legacy_root
            and name in VERIFIABLE_SHADOW_FILES
            and target is not None
            and stat.S_ISREG(source.mode)
            and _is_verified_generated_shadow(
                source_fd,
                name,
                name,
                source_path,
                target_fd,
                target_path,
                policy,
            )
        ):
            _remove_verified_generated_shadow(
                source_fd,
                name,
                source_path,
                target_fd,
                target_path,
                policy,
            )
            continue
        if target is None:
            if stat.S_ISDIR(source.mode):
                os.mkdir(name, stat.S_IMODE(source.mode), dir_fd=target_fd)
                created = _identity(target_fd, name, target_path)
                source_child = _open_dir(source_fd, name, source_path)
                try:
                    target_child = _open_dir(target_fd, name, target_path)
                    try:
                        if not _matches(source, os.fstat(source_child)):
                            raise MigrationError(f"{source_path} changed before migration")
                        if not _matches(created, os.fstat(target_child)):
                            raise MigrationError(f"{target_path} changed while it was created")
                        _merge_tree(
                            source_child,
                            source_path,
                            target_child,
                            target_path,
                            policy,
                            budget,
                            depth + 1,
                        )
                        os.fchmod(target_child, stat.S_IMODE(source.mode))
                    finally:
                        os.close(target_child)
                finally:
                    os.close(source_child)
                os.rmdir(name, dir_fd=source_fd)
            else:
                _move_no_replace_verified(source_fd, name, source_path, target_fd, target_path)
            continue
        target_identity = _identity(target_fd, name, target_path)
        if stat.S_ISDIR(source.mode) and stat.S_ISDIR(target_identity.mode):
            source_child = _open_dir(source_fd, name, source_path)
            try:
                target_child = _open_dir(target_fd, name, target_path)
                try:
                    _merge_tree(
                        source_child,
                        source_path,
                        target_child,
                        target_path,
                        policy,
                        budget,
                        depth + 1,
                    )
                finally:
                    os.close(target_child)
            finally:
                os.close(source_child)
            os.rmdir(name, dir_fd=source_fd)
            continue
        if stat.S_ISREG(source.mode) and stat.S_ISREG(target_identity.mode) and _same_file(
            source_fd, name, source_path, target_fd, name, target_path
        ):
            _unlink_verified(source_fd, name, source_path)
            continue
        raise MigrationError(
            f"legacy dashboard state changed after migration preflight at {source_path}"
        )


def _open_relative_directory(root_fd: int, relative: str) -> int | None:
    current_fd = os.dup(root_fd)
    try:
        for component in relative.split("/"):
            child = _lookup(current_fd, component)
            if child is None:
                os.close(current_fd)
                return None
            next_fd = _open_dir(current_fd, component, relative)
            os.close(current_fd)
            current_fd = next_fd
        return current_fd
    except Exception:
        os.close(current_fd)
        raise


def migrate(
    hermes_dir: str,
    *,
    policy: ShadowMigrationPolicy,
    max_entries: int = DEFAULT_MAX_ENTRIES,
    max_depth: int = DEFAULT_MAX_DEPTH,
    max_bytes: int = DEFAULT_MAX_BYTES,
) -> bool:
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    flags |= getattr(os, "O_CLOEXEC", 0)
    try:
        root_fd = os.open(hermes_dir, flags)
    except OSError as exc:
        raise MigrationError(
            f"native Hermes home {hermes_dir} is not a safe directory: {exc.strerror}"
        ) from exc
    try:
        sources: list[tuple[str, int]] = []
        try:
            for relative in LEGACY_PATHS:
                source_fd = _open_relative_directory(root_fd, relative)
                if source_fd is not None:
                    try:
                        sources.append((relative, source_fd))
                    except BaseException:
                        os.close(source_fd)
                        raise
            populated = [
                (name, fd)
                for name, fd in sources
                if _source_has_user_state(
                    fd,
                    f"{hermes_dir}/{name}",
                    root_fd,
                    hermes_dir,
                    policy,
                )
            ]
            if len(populated) > 1:
                raise MigrationError(
                    "both legacy dashboard homes contain state; refusing an ambiguous merge"
                )
            preflight_budget = MigrationBudget(max_entries, max_depth, max_bytes)
            for relative, source_fd in sources:
                _preflight_tree(
                    source_fd,
                    f"{hermes_dir}/{relative}",
                    root_fd,
                    hermes_dir,
                    policy,
                    preflight_budget,
                    1,
                )
            merge_budget = MigrationBudget(max_entries, max_depth, max_bytes)
            for relative, source_fd in sources:
                _merge_tree(
                    source_fd,
                    f"{hermes_dir}/{relative}",
                    root_fd,
                    hermes_dir,
                    policy,
                    merge_budget,
                    1,
                )
                parent_relative, name = (
                    relative.rsplit("/", 1) if "/" in relative else ("", relative)
                )
                parent_fd = (
                    root_fd
                    if not parent_relative
                    else _open_relative_directory(root_fd, parent_relative)
                )
                if parent_fd is None:
                    raise MigrationError(f"legacy dashboard parent {parent_relative} disappeared")
                try:
                    os.rmdir(name, dir_fd=parent_fd)
                finally:
                    if parent_fd != root_fd:
                        os.close(parent_fd)
            return bool(sources)
        finally:
            for _, source_fd in sources:
                os.close(source_fd)
    finally:
        os.close(root_fd)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--hermes-dir", default="/sandbox/.hermes")
    parser.add_argument("--managed-policy", default=str(MANAGED_POLICY_PATH))
    parser.add_argument("--max-entries", type=int, default=DEFAULT_MAX_ENTRIES)
    parser.add_argument("--max-depth", type=int, default=DEFAULT_MAX_DEPTH)
    parser.add_argument("--max-bytes", type=int, default=DEFAULT_MAX_BYTES)
    args = parser.parse_args(argv[1:])
    if args.max_entries < 1 or args.max_depth < 1 or args.max_bytes < 0:
        parser.error("migration limits must be positive (max-bytes may be zero)")
    def interrupt_migration(signum: int, _frame: object) -> None:
        raise MigrationError(f"migration interrupted by signal {signum}")

    signal.signal(signal.SIGTERM, interrupt_migration)
    signal.signal(signal.SIGINT, interrupt_migration)
    try:
        policy = _load_shadow_migration_policy(args.managed_policy)
        changed = migrate(
            args.hermes_dir,
            policy=policy,
            max_entries=args.max_entries,
            max_depth=args.max_depth,
            max_bytes=args.max_bytes,
        )
    except MigrationError as exc:
        print(
            f"[SECURITY] Refusing legacy Hermes dashboard-state migration: {exc}",
            file=sys.stderr,
        )
        return 1
    if changed:
        print(
            "[dashboard] migrated legacy dashboard state into the native Hermes home",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
