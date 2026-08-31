#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

import json
import os
import re
import secrets
import stat
import sys

config_file = os.path.abspath(sys.argv[1])
openclaw_dir = os.path.dirname(config_file)
env_key = "WECHAT_BOT_TOKEN"
canonical = f"openshell:resolve:env:{env_key}"
scoped_re = re.compile(rf"^openshell:resolve:env:v[0-9]+_{env_key}$")


def fail(message):
    print(f"[SECURITY] Refusing WeChat provider placeholder refresh — {message}", file=sys.stderr)
    raise SystemExit(1)


def safe_account_id(value):
    return (
        isinstance(value, str)
        and value
        and value == value.strip()
        and value not in {".", ".."}
        and ".." not in value
        and "/" not in value
        and "\\" not in value
        and not any(ord(char) < 32 or ord(char) == 127 for char in value)
    )


def temporary_owner_pid(candidate, filename):
    prefix = f".{filename}.nemoclaw-"
    suffix = ".tmp"
    if not candidate.startswith(prefix) or not candidate.endswith(suffix):
        return None
    identity = candidate[len(prefix) : -len(suffix)]
    match = re.fullmatch(r"([1-9][0-9]*)-([0-9a-f]{16})", identity)
    if match is None:
        return None
    pid = int(match.group(1))
    return pid if pid <= 2147483647 else None


def process_is_running(pid):
    if pid == os.getpid():
        return True
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except OSError:
        return True
    return True


def cleanup_stale_temporaries(accounts_fd, filename, account_metadata, account_mode):
    try:
        directory_metadata = os.fstat(accounts_fd)
    except OSError:
        fail("the managed account directory cannot be validated")
    if (
        not stat.S_ISDIR(directory_metadata.st_mode)
        or stat.S_IMODE(directory_metadata.st_mode) & 0o002
        or directory_metadata.st_uid not in {account_metadata.st_uid, os.geteuid()}
    ):
        fail("the managed account directory is unsafe for temporary-file cleanup")
    try:
        candidates = os.listdir(accounts_fd)
    except OSError:
        fail("the managed account directory cannot be checked for stale temporary files")
    cleaned = False
    for candidate in candidates:
        owner_pid = temporary_owner_pid(candidate, filename)
        if owner_pid is None or process_is_running(owner_pid):
            continue
        try:
            metadata = os.stat(candidate, dir_fd=accounts_fd, follow_symlinks=False)
        except FileNotFoundError:
            continue
        except OSError:
            fail("a stale managed account temporary file is unreadable")
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_nlink != 1
            or stat.S_IMODE(metadata.st_mode) != account_mode
            or metadata.st_uid != account_metadata.st_uid
            or metadata.st_gid != account_metadata.st_gid
        ):
            fail("a stale managed account temporary file is unsafe")
        try:
            os.unlink(candidate, dir_fd=accounts_fd)
        except FileNotFoundError:
            continue
        except OSError:
            fail(
                "a stale managed account temporary file could not be removed; "
                "restore owner write access to the managed account directory and retry startup"
            )
        cleaned = True
    if cleaned:
        try:
            os.fsync(accounts_fd)
        except OSError:
            fail("the managed account directory could not persist temporary-file cleanup")


if not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_DIRECTORY"):
    fail("the platform cannot enforce no-follow account traversal")

close_on_exec = getattr(os, "O_CLOEXEC", 0)
directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | close_on_exec
file_flags = os.O_RDONLY | os.O_NOFOLLOW | close_on_exec

root_fd = -1
plugin_fd = -1
accounts_fd = -1
try:
    try:
        root_fd = os.open(openclaw_dir, directory_flags)
        config_fd = os.open("openclaw.json", file_flags, dir_fd=root_fd)
        try:
            config_metadata = os.fstat(config_fd)
            if not stat.S_ISREG(config_metadata.st_mode) or config_metadata.st_nlink != 1:
                fail("openclaw.json is not a single regular file")
            with os.fdopen(config_fd, "r", encoding="utf-8") as stream:
                config_fd = -1
                config = json.load(stream)
        finally:
            if config_fd >= 0:
                os.close(config_fd)
    except (OSError, ValueError, json.JSONDecodeError):
        fail("openclaw.json is unreadable or unsafe")

    channels = config.get("channels") if isinstance(config, dict) else None
    channel = channels.get("openclaw-weixin") if isinstance(channels, dict) else None
    if not isinstance(channel, dict) or channel.get("enabled") is False:
        raise SystemExit(0)

    accounts = channel.get("accounts")
    if not isinstance(accounts, dict):
        raise SystemExit(0)

    account_ids = []
    for account_id, account in accounts.items():
        if not isinstance(account, dict) or account.get("enabled") is False:
            continue
        if not safe_account_id(account_id):
            fail("active WeChat configuration contains an unsafe account id")
        account_ids.append(account_id)

    if not account_ids:
        raise SystemExit(0)

    runtime_placeholder = os.environ.get(env_key, "")
    if not scoped_re.fullmatch(runtime_placeholder):
        if not runtime_placeholder:
            fail(f"{env_key} is missing from the runtime environment")
        if not runtime_placeholder.startswith("openshell:resolve:env:"):
            fail(f"{env_key} is not an OpenShell placeholder; raw credentials stay out of account files")
        fail(f"{env_key} is not the required revision-scoped OpenShell placeholder")

    try:
        plugin_fd = os.open("openclaw-weixin", directory_flags, dir_fd=root_fd)
        accounts_fd = os.open("accounts", directory_flags, dir_fd=plugin_fd)
    except OSError:
        fail("the managed account directory is missing or unsafe")

    pending = []
    for account_id in sorted(account_ids):
        filename = f"{account_id}.json"
        try:
            account_fd = os.open(filename, file_flags, dir_fd=accounts_fd)
        except OSError:
            fail("a managed account file is missing or unsafe")
        try:
            metadata = os.fstat(account_fd)
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
                fail("a managed account file is not a single regular file")
            account_mode = stat.S_IMODE(metadata.st_mode)
            directory_metadata = os.fstat(accounts_fd)
            if (
                account_mode not in {0o600, 0o660}
                or metadata.st_uid != directory_metadata.st_uid
                or metadata.st_gid != directory_metadata.st_gid
            ):
                fail("a managed account file has unsafe ownership or permissions")
            cleanup_stale_temporaries(accounts_fd, filename, metadata, account_mode)
            try:
                with os.fdopen(os.dup(account_fd), "r", encoding="utf-8") as stream:
                    account_data = json.load(stream)
            except Exception:
                fail("a managed account file is unreadable")
        finally:
            os.close(account_fd)

        if not isinstance(account_data, dict) or not isinstance(account_data.get("token"), str):
            fail("a managed account file has no valid token field")
        current = account_data["token"]
        if current == runtime_placeholder:
            continue
        if current != canonical and not scoped_re.fullmatch(current):
            fail("a managed account token is neither canonical nor revision-scoped")
        account_data["token"] = runtime_placeholder
        payload = (json.dumps(account_data, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        pending.append((filename, metadata, account_mode, payload))

    for filename, metadata, account_mode, payload in pending:
        temporary = f".{filename}.nemoclaw-{os.getpid()}-{secrets.token_hex(8)}.tmp"
        temporary_created = False
        try:
            create_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
            temporary_fd = os.open(temporary, create_flags, 0o600, dir_fd=accounts_fd)
            temporary_created = True
            try:
                os.fchmod(temporary_fd, account_mode)
                if os.geteuid() == 0:
                    os.fchown(temporary_fd, metadata.st_uid, metadata.st_gid)
                offset = 0
                while offset < len(payload):
                    offset += os.write(temporary_fd, payload[offset:])
                os.fsync(temporary_fd)
            finally:
                os.close(temporary_fd)

            current_metadata = os.stat(filename, dir_fd=accounts_fd, follow_symlinks=False)
            before = (metadata.st_dev, metadata.st_ino, metadata.st_mtime_ns, metadata.st_size)
            after = (
                current_metadata.st_dev,
                current_metadata.st_ino,
                current_metadata.st_mtime_ns,
                current_metadata.st_size,
            )
            if before != after or current_metadata.st_nlink != 1:
                fail("a managed account file changed during refresh")
            os.replace(
                temporary,
                filename,
                src_dir_fd=accounts_fd,
                dst_dir_fd=accounts_fd,
            )
            temporary_created = False
            os.fsync(accounts_fd)
        finally:
            if temporary_created:
                try:
                    os.unlink(temporary, dir_fd=accounts_fd)
                except OSError:
                    print(
                        "[SECURITY] WeChat provider placeholder refresh could not remove its "
                        "temporary account file; restore owner write access to the managed "
                        "account directory and retry startup",
                        file=sys.stderr,
                    )

    if pending:
        print(
            f"[config] Refreshed WeChat account provider placeholder from OpenShell runtime env: {env_key}",
            file=sys.stderr,
        )
finally:
    if accounts_fd >= 0:
        os.close(accounts_fd)
    if plugin_fd >= 0:
        os.close(plugin_fd)
    if root_fd >= 0:
        os.close(root_fd)
