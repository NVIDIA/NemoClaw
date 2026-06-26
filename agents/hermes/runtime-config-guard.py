#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Descriptor-safe runtime config updates for the Hermes sandbox entrypoint."""

from __future__ import annotations

import argparse
import errno
import hashlib
import json
import os
import re
import secrets
import stat
import subprocess
import sys
import tempfile
from dataclasses import dataclass


API_SERVER_KEY_RE = re.compile(r"^[0-9a-f]{64}$")
ENV_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
SCOPED_PLACEHOLDER_PREFIX = "openshell:resolve:env:"
BOUNDARY_VALIDATOR_TIMEOUT_SECONDS = 5
# Restrictive compatibility fallback for provider placeholders persisted before
# Hermes messaging runtime-plan metadata existed. New channels must flow through
# runtime-plan credentialBindings/envAliases; do not broaden this set without a
# migration plan and source-of-truth review.
LEGACY_PROVIDER_PLACEHOLDER_KEYS = frozenset(
    {
        "TELEGRAM_BOT_TOKEN",
        "DISCORD_BOT_TOKEN",
        "SLACK_BOT_TOKEN",
        "SLACK_APP_TOKEN",
        "WECHAT_BOT_TOKEN",
        "MSTEAMS_APP_PASSWORD",
    }
)


class UnsafePathError(RuntimeError):
    """Raised when a mutable runtime config path is unsafe to trust."""


def _no_follow_flag() -> int:
    flag = getattr(os, "O_NOFOLLOW", 0)
    if not flag:
        raise UnsafePathError("O_NOFOLLOW is unavailable")
    return flag


def _cloexec_flag() -> int:
    return getattr(os, "O_CLOEXEC", 0)


def _directory_flag() -> int:
    return getattr(os, "O_DIRECTORY", 0)


@dataclass(frozen=True)
class FileSnapshot:
    dev: int
    ino: int
    mode: int
    uid: int
    gid: int
    nlink: int

    @classmethod
    def from_stat(cls, st: os.stat_result) -> "FileSnapshot":
        return cls(
            dev=st.st_dev,
            ino=st.st_ino,
            mode=stat.S_IMODE(st.st_mode),
            uid=st.st_uid,
            gid=st.st_gid,
            nlink=st.st_nlink,
        )


class OpenFile:
    def __init__(self, path: str, fd: int, snapshot: FileSnapshot):
        self.path = path
        self.fd = fd
        self.snapshot = snapshot

    def close(self) -> None:
        os.close(self.fd)

    def read_bytes(self) -> bytes:
        os.lseek(self.fd, 0, os.SEEK_SET)
        chunks: list[bytes] = []
        while True:
            chunk = os.read(self.fd, 1024 * 1024)
            if not chunk:
                break
            chunks.append(chunk)
        return b"".join(chunks)


def _die(message: str) -> None:
    print(f"[SECURITY] {message}", file=sys.stderr)
    sys.exit(1)


def _split_path(path: str) -> tuple[str, str]:
    abs_path = os.path.abspath(path)
    return os.path.dirname(abs_path), os.path.basename(abs_path)


def _open_parent_dir(path: str) -> tuple[int, str]:
    directory, basename = _split_path(path)
    flags = os.O_RDONLY | _directory_flag() | _no_follow_flag() | _cloexec_flag()
    try:
        dir_fd = os.open(directory, flags)
    except OSError as exc:
        raise UnsafePathError(f"refusing runtime config update because {directory} is unsafe: {exc}") from exc
    st = os.fstat(dir_fd)
    if not stat.S_ISDIR(st.st_mode):
        os.close(dir_fd)
        raise UnsafePathError(f"refusing runtime config update because {directory} is not a directory")
    return dir_fd, basename


def _validate_regular(path: str, st: os.stat_result) -> FileSnapshot:
    if stat.S_ISLNK(st.st_mode):
        raise UnsafePathError(f"refusing to follow symlink: {path}")
    if not stat.S_ISREG(st.st_mode):
        raise UnsafePathError(f"refusing non-regular runtime config path: {path}")
    if st.st_nlink != 1:
        raise UnsafePathError(f"refusing hardlinked runtime config path: {path}")
    mode = stat.S_IMODE(st.st_mode)
    if mode & 0o022:
        raise UnsafePathError(f"refusing group/world-writable runtime config path: {path}")
    return FileSnapshot.from_stat(st)


def _open_regular(path: str, mode: int = os.O_RDONLY) -> OpenFile:
    dir_fd, basename = _open_parent_dir(path)
    try:
        flags = mode | _no_follow_flag() | _cloexec_flag()
        fd = os.open(basename, flags, dir_fd=dir_fd)
        try:
            snapshot = _validate_regular(path, os.fstat(fd))
        except Exception:
            os.close(fd)
            raise
        return OpenFile(path, fd, snapshot)
    finally:
        os.close(dir_fd)


def _stat_path_at(dir_fd: int, basename: str) -> os.stat_result:
    return os.stat(basename, dir_fd=dir_fd, follow_symlinks=False)


def _same_snapshot(st: os.stat_result, snapshot: FileSnapshot) -> bool:
    return (
        st.st_dev == snapshot.dev
        and st.st_ino == snapshot.ino
        and stat.S_IMODE(st.st_mode) == snapshot.mode
        and st.st_uid == snapshot.uid
        and st.st_gid == snapshot.gid
        and st.st_nlink == snapshot.nlink
        and stat.S_ISREG(st.st_mode)
    )


def _assert_current_snapshot(dir_fd: int, basename: str, path: str, snapshot: FileSnapshot) -> None:
    current = _stat_path_at(dir_fd, basename)
    if not _same_snapshot(current, snapshot):
        raise UnsafePathError(f"refusing raced runtime config path: {path}")


def _atomic_replace(
    path: str,
    data: bytes,
    *,
    expected: FileSnapshot | None,
    mode: int,
    uid: int,
    gid: int,
) -> None:
    dir_fd, basename = _open_parent_dir(path)
    tmp_name = f".{basename}.nemoclaw.{os.getpid()}.{secrets.token_hex(8)}"
    tmp_fd: int | None = None
    try:
        if expected is not None:
            _assert_current_snapshot(dir_fd, basename, path, expected)
        else:
            try:
                _stat_path_at(dir_fd, basename)
            except FileNotFoundError:
                pass
            else:
                raise UnsafePathError(f"refusing raced runtime config create: {path}")

        tmp_fd = os.open(
            tmp_name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | _no_follow_flag() | _cloexec_flag(),
            0o600,
            dir_fd=dir_fd,
        )
        try:
            os.fchown(tmp_fd, uid, gid)
        except PermissionError:
            if os.geteuid() == 0:
                raise
        os.fchmod(tmp_fd, mode)
        with os.fdopen(tmp_fd, "wb", closefd=True) as handle:
            tmp_fd = None
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())

        if expected is not None:
            _assert_current_snapshot(dir_fd, basename, path, expected)
        os.replace(tmp_name, basename, src_dir_fd=dir_fd, dst_dir_fd=dir_fd)
        try:
            os.fsync(dir_fd)
        except OSError:
            # Directory fsync is best-effort; some container filesystems reject
            # it even after the atomic replace has succeeded.
            pass
    except Exception:
        try:
            os.unlink(tmp_name, dir_fd=dir_fd)
        except FileNotFoundError:
            # The temp file may not exist yet, or may already have been removed
            # by the failing operation path.
            pass
        except OSError:
            # Cleanup must not mask the original atomic-write failure.
            pass
        raise
    finally:
        if tmp_fd is not None:
            os.close(tmp_fd)
        os.close(dir_fd)


def _read_text(path: str) -> tuple[str, FileSnapshot]:
    opened = _open_regular(path)
    try:
        return opened.read_bytes().decode("utf-8"), opened.snapshot
    finally:
        opened.close()


def _sha256_entry(path: str) -> tuple[str, FileSnapshot]:
    opened = _open_regular(path)
    try:
        digest = hashlib.sha256(opened.read_bytes()).hexdigest()
        return f"{digest}  {path}\n", opened.snapshot
    finally:
        opened.close()


def _write_existing(path: str, text: str, snapshot: FileSnapshot, mode: int | None = None) -> None:
    _atomic_replace(
        path,
        text.encode("utf-8"),
        expected=snapshot,
        mode=snapshot.mode if mode is None else mode,
        uid=snapshot.uid,
        gid=snapshot.gid,
    )


def _write_hash(path: str, text: str) -> None:
    try:
        opened = _open_regular(path)
    except FileNotFoundError:
        _atomic_replace(
            path,
            text.encode("utf-8"),
            expected=None,
            mode=0o600,
            uid=os.geteuid(),
            gid=os.getegid(),
        )
        return
    try:
        snapshot = opened.snapshot
    finally:
        opened.close()
    _atomic_replace(
        path,
        text.encode("utf-8"),
        expected=snapshot,
        mode=snapshot.mode,
        uid=snapshot.uid,
        gid=snapshot.gid,
    )


def _hash_text(config_path: str, env_path: str) -> tuple[str, FileSnapshot, FileSnapshot]:
    config_entry, config_snapshot = _sha256_entry(config_path)
    env_entry, env_snapshot = _sha256_entry(env_path)
    return config_entry + env_entry, config_snapshot, env_snapshot


def refresh_hashes(hermes_dir: str, hash_file: str, mode: str) -> None:
    config_path = os.path.join(hermes_dir, "config.yaml")
    env_path = os.path.join(hermes_dir, ".env")
    compat_hash = os.path.join(hermes_dir, ".config-hash")
    hash_text, config_snapshot, env_snapshot = _hash_text(config_path, env_path)

    def assert_inputs_stable() -> None:
        config = _open_regular(config_path)
        env = _open_regular(env_path)
        try:
            if config.snapshot != config_snapshot or env.snapshot != env_snapshot:
                raise UnsafePathError("refusing raced Hermes config/env path before hash refresh")
        finally:
            config.close()
            env.close()

    if mode == "strict":
        assert_inputs_stable()
        _write_hash(hash_file, hash_text)

    compat_exists = os.path.exists(compat_hash)
    compat_writable = os.access(compat_hash, os.W_OK) if compat_exists else os.access(hermes_dir, os.W_OK)
    if mode == "compat" and compat_writable:
        assert_inputs_stable()
        _write_hash(compat_hash, hash_text)


def _parse_env_assignment(line: str) -> tuple[str, str, str] | None:
    stripped = line.rstrip("\n")
    prefix = ""
    candidate = stripped
    if candidate.startswith("export "):
        prefix = "export "
        candidate = candidate[len(prefix) :].lstrip()
    if "=" not in candidate:
        return None
    key, value = candidate.split("=", 1)
    return prefix, key, value


def _upsert_env_assignments(text: str, assignments: dict[str, str]) -> tuple[str, bool, set[str]]:
    if not assignments:
        return text, False, set()

    seen: set[str] = set()
    changed = False
    changed_keys: set[str] = set()
    updated: list[str] = []
    for line in text.splitlines(keepends=True):
        parsed = _parse_env_assignment(line)
        if parsed is None:
            updated.append(line)
            continue
        prefix, key, _value = parsed
        if key not in assignments:
            updated.append(line)
            continue
        if key in seen:
            changed = True
            changed_keys.add(key)
            continue
        seen.add(key)
        new_line = f"{prefix}{key}={assignments[key]}\n"
        updated.append(new_line)
        if new_line != line:
            changed = True
            changed_keys.add(key)

    for key, value in assignments.items():
        if key in seen:
            continue
        if updated and not updated[-1].endswith("\n"):
            updated[-1] = updated[-1] + "\n"
            changed = True
        # Appended provider placeholders use standard dotenv syntax; existing
        # export-prefixed assignments preserve their export prefix above.
        updated.append(f"{key}={value}\n")
        changed = True
        changed_keys.add(key)

    updated_text = "".join(updated)
    return updated_text, changed or updated_text != text, changed_keys


def _first_env_assignment_value(text: str, env_key: str) -> str | None:
    for line in text.splitlines(keepends=True):
        parsed = _parse_env_assignment(line)
        if parsed is None:
            continue
        _prefix, key, value = parsed
        if key == env_key:
            return value
    return None


def _env_assignment_keys(text: str) -> set[str]:
    keys: set[str] = set()
    for line in text.splitlines(keepends=True):
        parsed = _parse_env_assignment(line)
        if parsed is None:
            continue
        _prefix, key, _value = parsed
        keys.add(key)
    return keys


def _is_generated_api_server_key(value: str) -> bool:
    candidate = value.strip()
    if len(candidate) >= 2 and candidate[0] == candidate[-1] and candidate[0] in ("'", '"'):
        candidate = candidate[1:-1]
    return API_SERVER_KEY_RE.fullmatch(candidate) is not None


def _placeholder_suffix_matches_env_key(suffix: str, env_key: str) -> bool:
    if suffix == env_key:
        return True
    revision_match = re.fullmatch(r"v[0-9]+_(.+)", suffix)
    return revision_match is not None and revision_match.group(1) == env_key


def _normalize_provider_placeholder_for_env_key(value: str, env_key: str) -> str | None:
    if not value.startswith(SCOPED_PLACEHOLDER_PREFIX):
        return None
    suffix = value[len(SCOPED_PLACEHOLDER_PREFIX) :]
    if not _placeholder_suffix_matches_env_key(suffix, env_key):
        return None
    return f"{SCOPED_PLACEHOLDER_PREFIX}{env_key}"


def _has_env_control_chars(value: str) -> bool:
    return "\x00" in value or "\r" in value or "\n" in value


def _validate_runtime_plan_env_key(value: object, label: str) -> str:
    if not isinstance(value, str) or not ENV_KEY_RE.fullmatch(value):
        raise UnsafePathError(f"messaging runtime plan {label} is invalid")
    return value


def _validate_env_text_with_boundary(text: str, boundary_validator_path: str | None) -> None:
    if not boundary_validator_path:
        raise UnsafePathError("Hermes provider placeholder refresh requires the secret-boundary validator")
    fd, temp_path = tempfile.mkstemp(prefix="hermes-env-boundary-", text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            fd = -1
            handle.write(text)
        try:
            result = subprocess.run(
                [sys.executable, boundary_validator_path, "env-file", temp_path],
                check=False,
                timeout=BOUNDARY_VALIDATOR_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired as exc:
            raise UnsafePathError("Hermes secret-boundary validator timed out") from exc
        except OSError as exc:
            raise UnsafePathError(f"Hermes secret-boundary validator failed: {exc}") from exc
        if result.returncode != 0:
            raise UnsafePathError(
                "Hermes provider placeholder refresh would violate the secret boundary"
            )
    finally:
        if fd != -1:
            os.close(fd)
        try:
            os.unlink(temp_path)
        except FileNotFoundError:
            # Temp file may already be removed; cleanup should remain best-effort.
            pass


def _runtime_plan_replacements_and_provider_keys(
    runtime_plan_path: str | None,
) -> tuple[dict[str, tuple[str, str]], set[str], bool]:
    if not runtime_plan_path:
        return {}, set(), False
    try:
        runtime_plan_text, _runtime_plan_snapshot = _read_text(runtime_plan_path)
    except FileNotFoundError:
        return {}, set(), False
    try:
        plan = json.loads(runtime_plan_text)
    except Exception as exc:
        raise UnsafePathError(f"messaging runtime plan is invalid: {exc}") from exc
    if not isinstance(plan, dict):
        raise UnsafePathError("messaging runtime plan must be an object")

    disabled_channels = {
        channel_id
        for channel_id in plan.get("disabledChannels", [])
        if isinstance(channel_id, str)
    }
    active_channel_ids: set[str] = set()
    for channel in plan.get("channels", []):
        if not isinstance(channel, dict):
            continue
        channel_id = channel.get("channelId")
        if (
            isinstance(channel_id, str)
            and channel.get("active") is True
            and channel.get("disabled") is not True
            and channel_id not in disabled_channels
        ):
            active_channel_ids.add(channel_id)

    provider_env_keys: set[str] = set()
    bindings = plan.get("credentialBindings", [])
    if not isinstance(bindings, list):
        raise UnsafePathError("messaging runtime plan credentialBindings must be a list")
    for binding in bindings:
        if not isinstance(binding, dict):
            raise UnsafePathError("messaging runtime plan credentialBindings entries must be objects")
        channel_id = binding.get("channelId")
        provider_env_key = binding.get("providerEnvKey")
        if isinstance(channel_id, str) and channel_id in active_channel_ids:
            provider_env_keys.add(
                _validate_runtime_plan_env_key(provider_env_key, "credentialBindings.providerEnvKey")
            )

    runtime_setup = plan.get("runtimeSetup") or {}
    if not isinstance(runtime_setup, dict):
        raise UnsafePathError("messaging runtime plan runtimeSetup must be an object")
    aliases = runtime_setup.get("envAliases", [])
    if not isinstance(aliases, list):
        raise UnsafePathError("messaging runtime plan runtimeSetup.envAliases must be a list")

    replacements: dict[str, tuple[str, str]] = {}
    for alias in aliases:
        if not isinstance(alias, dict):
            raise UnsafePathError("messaging runtime plan envAliases entries must be objects")
        channel_id = alias.get("channelId")
        if not isinstance(channel_id, str) or channel_id not in active_channel_ids:
            continue
        env_key = alias.get("envKey")
        pattern = alias.get("match")
        value = alias.get("value")
        message = alias.get("message") or ""
        if not isinstance(pattern, str) or not isinstance(value, str) or not isinstance(message, str):
            continue
        env_key = _validate_runtime_plan_env_key(env_key, "runtimeSetup.envAliases.envKey")
        if env_key in replacements:
            continue
        if _has_env_control_chars(value) or _has_env_control_chars(message):
            raise UnsafePathError("messaging runtime plan env alias contains unsafe characters")
        try:
            compiled = re.compile(pattern)
        except re.error as exc:
            raise UnsafePathError(f"messaging runtime plan env alias regex is invalid: {exc}") from exc
        if compiled.search(os.environ.get(env_key, "")):
            replacements[env_key] = (value, message)
    return replacements, provider_env_keys, True


def ensure_api_key(hermes_dir: str, hash_file: str, mode: str) -> None:
    env_path = os.path.join(hermes_dir, ".env")
    if not os.path.exists(env_path):
        return
    text, snapshot = _read_text(env_path)
    existing_value = _first_env_assignment_value(text, "API_SERVER_KEY")
    minted = existing_value is None or not _is_generated_api_server_key(existing_value)
    api_server_key = secrets.token_hex(32) if minted else existing_value
    updated_text, changed, _changed_keys = _upsert_env_assignments(text, {"API_SERVER_KEY": api_server_key})

    if not changed:
        print("minted=0")
        return

    _write_existing(env_path, updated_text, snapshot, mode=0o640)
    refresh_hashes(hermes_dir, hash_file, mode)
    print("minted=1" if minted else "updated=1")


def provider_placeholders(
    hermes_dir: str,
    hash_file: str,
    mode: str,
    runtime_plan_path: str | None,
    boundary_validator_path: str | None,
) -> None:
    env_path = os.path.join(hermes_dir, ".env")
    if not os.path.exists(env_path):
        return

    replacements, runtime_plan_provider_keys, runtime_plan_loaded = _runtime_plan_replacements_and_provider_keys(
        runtime_plan_path
    )
    text, snapshot = _read_text(env_path)
    allowed_fallback_keys = (
        runtime_plan_provider_keys
        if runtime_plan_loaded
        else set(LEGACY_PROVIDER_PLACEHOLDER_KEYS).intersection(_env_assignment_keys(text))
    )
    for key in allowed_fallback_keys:
        if key in replacements:
            continue
        normalized = _normalize_provider_placeholder_for_env_key(os.environ.get(key, ""), key)
        if normalized:
            replacements[key] = (normalized, "")
    if not replacements:
        return

    assignment_values = {key: replacement for key, (replacement, _message) in replacements.items()}
    updated_text, changed, changed_keys = _upsert_env_assignments(text, assignment_values)

    if not changed:
        return

    _validate_env_text_with_boundary(updated_text, boundary_validator_path)

    try:
        _write_existing(env_path, updated_text, snapshot, mode=0o640)
        refresh_hashes(hermes_dir, hash_file, mode)
    except PermissionError:
        if os.geteuid() != 0:
            print(
                "[config] Hermes provider placeholders supplied by OpenShell runtime env; "
                ".env refresh skipped without write access",
                file=sys.stderr,
            )
            return
        raise
    refreshed_messages = {
        message
        for key, (_replacement, message) in replacements.items()
        if key in changed_keys and message
    }
    for message in sorted(refreshed_messages):
        print(message, file=sys.stderr)
    print("[config] Refreshed Hermes provider placeholders from OpenShell runtime env", file=sys.stderr)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("ensure-api-key", "refresh-hashes", "provider-placeholders"))
    parser.add_argument("--hermes-dir", required=True)
    parser.add_argument("--hash-file", required=True)
    parser.add_argument("--runtime-plan", default="")
    parser.add_argument("--boundary-validator", default="")
    parser.add_argument("--mode", choices=("strict", "compat"), default="strict")
    args = parser.parse_args()

    try:
        if args.action == "ensure-api-key":
            ensure_api_key(args.hermes_dir, args.hash_file, args.mode)
        elif args.action == "refresh-hashes":
            refresh_hashes(args.hermes_dir, args.hash_file, args.mode)
        elif args.action == "provider-placeholders":
            provider_placeholders(
                args.hermes_dir,
                args.hash_file,
                args.mode,
                args.runtime_plan,
                args.boundary_validator,
            )
    except UnsafePathError as exc:
        _die(str(exc))
    except OSError as exc:
        if exc.errno in (errno.ELOOP, errno.EPERM, errno.EACCES):
            _die(f"refusing unsafe Hermes runtime config path: {exc}")
        raise
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
