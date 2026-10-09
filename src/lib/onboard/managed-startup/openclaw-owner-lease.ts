// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
while True:
    directory = None
    database = None
    try:
        directory = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
        for part in root.strip("/").split("/"):
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        before = os.stat(filename, dir_fd=directory, follow_symlinks=False)
        if not stat.S_ISREG(before.st_mode) or before.st_uid != account.pw_uid:
            raise RuntimeError("OpenClaw owner lease database identity is unsafe")
        database = sqlite3.connect(f"file:/proc/self/fd/{directory}/{filename}?mode=ro", uri=True, timeout=1)
        database.execute("PRAGMA query_only = ON")
        database.execute("PRAGMA trusted_schema = OFF")
        if not database.execute("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='state_leases'").fetchone():
            break
        row = database.execute("SELECT expires_at, payload_json FROM state_leases WHERE scope='gateway-owner' AND lease_key='global'").fetchone()
        after = os.stat(filename, dir_fd=directory, follow_symlinks=False)
        if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
            raise RuntimeError("OpenClaw owner lease database changed during observation")
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
        break
    finally:
        if database is not None:
            database.close()
        if directory is not None:
            os.close(directory)
    budget = deadline - time.monotonic()
    if budget <= 0:
        raise RuntimeError("OpenClaw owner lease remained active through its native expiry window")
    time.sleep(min(1, remaining, budget))
`;
