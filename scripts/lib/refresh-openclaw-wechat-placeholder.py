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


if not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_DIRECTORY"):
    fail("the platform cannot enforce no-follow account traversal")

close_on_exec = getattr(os, "O_CLOEXEC", 0)
directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | close_on_exec
file_flags = os.O_RDONLY | os.O_NOFOLLOW | close_on_exec

descriptors = []
try:
    try:
        root_fd = os.open(openclaw_dir, directory_flags)
        descriptors.append(root_fd)
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
        descriptors.append(plugin_fd)
        accounts_fd = os.open("accounts", directory_flags, dir_fd=plugin_fd)
        descriptors.append(accounts_fd)
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
            if stat.S_IMODE(metadata.st_mode) & 0o077:
                fail("a managed account file is accessible outside its owner")
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
        pending.append((filename, metadata, payload))

    for filename, metadata, payload in pending:
        temporary = f".{filename}.nemoclaw-{os.getpid()}-{secrets.token_hex(8)}.tmp"
        temporary_created = False
        try:
            create_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
            temporary_fd = os.open(temporary, create_flags, 0o600, dir_fd=accounts_fd)
            temporary_created = True
            try:
                os.fchmod(temporary_fd, 0o600)
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
                    pass

    if pending:
        print(
            f"[config] Refreshed WeChat account provider placeholder from OpenShell runtime env: {env_key}",
            file=sys.stderr,
        )
finally:
    for descriptor in reversed(descriptors):
        os.close(descriptor)
