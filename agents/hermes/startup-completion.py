#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Observe completion of the non-root supervisor's startup writes.

This receipt schedules configuration inspection. It does not grant mutation
authority or replace topology, ownership, or concurrent-change verification.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import time

RECEIPT = "/tmp/nemoclaw-hermes-startup-complete.json"
ROOT_LIFECYCLE = "/run/nemoclaw/hermes-root-lifecycle"


def requires_completion(root_lifecycle: str = ROOT_LIFECYCLE) -> bool:
    try:
        fd = os.open(root_lifecycle, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    except FileNotFoundError:
        return True
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                or info.st_uid != 0 or info.st_gid != 0
                or stat.S_IMODE(info.st_mode) != 0o444
                or os.read(fd, 64) != b"root-separated\n"):
            raise RuntimeError("Invalid Hermes root lifecycle marker")
    finally:
        os.close(fd)
    return False


def process_identity(pid: int) -> dict[str, int | str] | None:
    if type(pid) is not int or pid <= 0:
        return None
    try:
        proc = Path(f"/proc/{pid}")
        before = (proc / "stat").read_text()
        fields = before[before.rindex(")") + 2:].split()
        uid = next(line.split()[2] for line in
                   (proc / "status").read_text().splitlines() if line.startswith("Uid:"))
        if fields[0] == "Z" or int(uid) != os.geteuid():
            return None
        identity = {"pid": pid, "parent": int(fields[1]), "start": fields[19]}
        after = (proc / "stat").read_text()
        current = after[after.rindex(")") + 2:].split()
        if current[0] == "Z" or current[19] != fields[19] or current[1] != fields[1]:
            return None
        return identity
    except (OSError, ValueError, IndexError, StopIteration):
        return None


def read_completion(path: str = RECEIPT) -> dict | None:
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    except FileNotFoundError:
        return None
    try:
        before = os.fstat(fd)
        if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1
                or before.st_uid != os.geteuid() or before.st_gid != os.getegid()
                or stat.S_IMODE(before.st_mode) != 0o600 or before.st_size > 1024):
            raise RuntimeError("Unsafe Hermes startup completion receipt")
        data = os.read(fd, 1025)
        after = os.fstat(fd)
        named = os.stat(path, follow_symlinks=False)
        if any(getattr(before, field) != getattr(info, field)
               for info in (after, named)
               for field in ("st_dev", "st_ino", "st_mode", "st_uid", "st_gid",
                             "st_nlink", "st_size", "st_mtime_ns", "st_ctime_ns")):
            raise RuntimeError("Hermes startup completion receipt changed while reading")
    finally:
        os.close(fd)
    try:
        value = json.loads(data)
        if (set(value) != {"version", "supervisor", "gateway"}
                or type(value["version"]) is not int or value["version"] != 1):
            raise ValueError("invalid receipt fields")
        for role in ("supervisor", "gateway"):
            identity = value[role]
            if (set(identity) != {"pid", "parent", "start"}
                    or type(identity["pid"]) is not int or identity["pid"] <= 0
                    or type(identity["parent"]) is not int or identity["parent"] < 0
                    or not isinstance(identity["start"], str) or not identity["start"].isdigit()):
                raise ValueError("invalid process identity")
        if value["gateway"]["parent"] != value["supervisor"]["pid"]:
            raise ValueError("gateway has a different supervisor")
    except (ValueError, TypeError, KeyError) as error:
        raise RuntimeError("Invalid Hermes startup completion receipt") from error
    if any(process_identity(value[role]["pid"]) != value[role]
           for role in ("supervisor", "gateway")):
        return None
    return value


def wait_for_completion(timeout: float = 10, path: str = RECEIPT) -> dict:
    deadline = time.monotonic() + timeout
    while True:
        receipt = read_completion(path)
        if receipt is not None:
            return receipt
        if time.monotonic() >= deadline:
            raise RuntimeError("Hermes supervisor startup completion was not observed")
        time.sleep(min(0.1, max(0, deadline - time.monotonic())))


def publish_completion(gateway_pid: int, path: str = RECEIPT) -> None:
    if os.geteuid() == 0:
        raise RuntimeError("Hermes startup completion requires the non-root supervisor")
    supervisor = process_identity(os.getppid())
    gateway = process_identity(gateway_pid)
    if supervisor is None or gateway is None or gateway["parent"] != supervisor["pid"]:
        raise RuntimeError("Hermes startup completion requires a live supervised gateway")
    # Refuse unsafe existing paths before replacing a prior generation.
    read_completion(path)
    receipt = {"version": 1, "supervisor": supervisor, "gateway": gateway}
    fd, temporary = tempfile.mkstemp(prefix=".hermes-startup-", dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(receipt, output, separators=(",", ":"))
        if (process_identity(gateway_pid) != gateway
                or process_identity(supervisor["pid"]) != supervisor):
            raise RuntimeError("Hermes processes changed before startup completion")
        os.replace(temporary, path)
    finally:
        if os.path.lexists(temporary):
            os.unlink(temporary)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("expected supervised Hermes gateway PID")
    publish_completion(int(sys.argv[1]))
