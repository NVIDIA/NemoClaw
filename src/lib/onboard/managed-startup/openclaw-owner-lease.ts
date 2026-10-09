// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Allow container execution and Python startup/teardown outside the native
// five-minute lease window. The observer itself still waits at most 300 seconds.
export const OPENCLAW_OWNER_LEASE_EXECUTION_TIMEOUT_MS = 330_000;

/**
 * OpenShell force-deletes containers while preserving the managed state volume.
 * OpenClaw cannot prove that a foreign-container owner is dead. Wait for its
 * native five-minute lease to expire before releasing the replacement's startup
 * hold, so the native gateway retains sole authority to reclaim and acquire it.
 * A renewing owner, malformed database, or unavailable observation fails closed.
 */
export const WAIT_FOR_OPENCLAW_OWNER_LEASE = String.raw`
import json, os, pwd, socket, sqlite3, stat, time
account = pwd.getpwnam("sandbox")
if os.geteuid() == 0:
    os.setgroups([])
    os.setgid(account.pw_gid)
    os.setuid(account.pw_uid)
root = "/sandbox/.openclaw/state"
filename = "openclaw.sqlite"
deadline = time.monotonic() + 300

def open_state_directory():
    directory = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in root.strip("/").split("/"):
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        return directory
    except BaseException:
        os.close(directory)
        raise

def identity(metadata):
    return metadata.st_dev, metadata.st_ino

def database_metadata(metadata):
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != account.pw_uid or metadata.st_nlink != 1:
        raise RuntimeError("OpenClaw owner lease database identity is unsafe")
    return (*identity(metadata), metadata.st_uid, metadata.st_gid, metadata.st_mode, metadata.st_nlink)

def open_database_handles(expected):
    # SQLite's VFS reopens paths even when handed a /proc descriptor URI. Verify
    # its actual descriptor, as the canonical pairing-state adapter does.
    descriptor_root = "/proc/self/fd" if os.path.isdir("/proc/self/fd") else "/dev/fd"
    count = 0
    for name in os.listdir(descriptor_root):
        if not name.isdecimal():
            continue
        try:
            metadata = os.fstat(int(name))
        except OSError:
            continue
        if stat.S_ISREG(metadata.st_mode) and identity(metadata) == expected:
            count += 1
    return count

def require_current(directory, database_fd, expected):
    current = open_state_directory()
    try:
        if identity(os.fstat(current)) != identity(os.fstat(directory)):
            raise RuntimeError("OpenClaw owner lease directory changed during observation")
        if database_metadata(os.stat(filename, dir_fd=current, follow_symlinks=False)) != expected or database_metadata(os.fstat(database_fd)) != expected:
            raise RuntimeError("OpenClaw owner lease database changed during observation")
    finally:
        os.close(current)

while True:
    directory = None
    database_fd = None
    database = None
    try:
        directory = open_state_directory()
        database_fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        before = database_metadata(os.fstat(database_fd))
        require_current(directory, database_fd, before)
        handles = open_database_handles(before[:2])
        database = sqlite3.connect(f"file:/proc/self/fd/{directory}/{filename}?mode=ro", uri=True, timeout=1)
        if open_database_handles(before[:2]) != handles + 1:
            raise RuntimeError("SQLite reopened an unvalidated OpenClaw owner lease database")
        database.execute("PRAGMA query_only = ON")
        database.execute("PRAGMA trusted_schema = OFF")
        database.execute("BEGIN")
        row = None
        if database.execute("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='state_leases'").fetchone():
            row = database.execute("SELECT expires_at, payload_json FROM state_leases WHERE scope='gateway-owner' AND lease_key='global'").fetchone()
        # Every successful observation, including an absent table or owner, must
        # still refer to the pinned database at the current state-directory path.
        if open_database_handles(before[:2]) != handles + 1:
            raise RuntimeError("SQLite reopened an unvalidated OpenClaw owner lease database")
        require_current(directory, database_fd, before)
        if row is None:
            break
        expires, payload = row
        owner = json.loads(payload)["owner"]
        if not isinstance(owner.get("host"), str) or not owner["host"]:
            raise RuntimeError("OpenClaw owner lease has no host identity")
        if owner["host"] == socket.gethostname():
            break
        if type(expires) is not int:
            raise RuntimeError("OpenClaw owner lease has no bounded expiry")
        remaining = (expires - time.time() * 1000) / 1000
        if remaining <= 0:
            break
    except FileNotFoundError:
        if database_fd is not None:
            raise RuntimeError("OpenClaw owner lease database disappeared during observation") from None
        break
    finally:
        if database is not None:
            database.close()
        if database_fd is not None:
            os.close(database_fd)
        if directory is not None:
            os.close(directory)
    budget = deadline - time.monotonic()
    if budget <= 0:
        raise RuntimeError("OpenClaw owner lease remained active through its native expiry window")
    time.sleep(min(1, remaining, budget))
`;
