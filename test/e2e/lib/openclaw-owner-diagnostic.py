# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Read native ownership facts without granting lifecycle authority."""

import argparse
import json
import os
import re
import signal
import stat
import time

MAX_BYTES = 16384
MAX_DIRECTORIES = 8
MAX_LOCKS = 32
MAX_PROCESSES = 256
LOCK_NAME = re.compile(r"(?:state\.[a-f0-9]{16}|gateway\.state)\.lock\Z")


def directory(name, parent=None):
    return os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)


def bounded_file(name, parent, limit=MAX_BYTES):
    fd = os.open(name, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=parent)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_size > limit:
            raise ValueError("unsupported file")
        data = os.read(fd, limit + 1)
        after = os.fstat(fd)
        if len(data) > limit or (before.st_size, before.st_mtime_ns) != (
            after.st_size, after.st_mtime_ns
        ):
            raise ValueError("unstable file")
        return data, after
    finally:
        os.close(fd)


def positive_integer(value):
    return isinstance(value, int) and not isinstance(value, bool) and 0 < value < 2**53


def process_facts(proc, pid):
    if not positive_integer(pid):
        return {"status": "invalid-pid"}
    child = None
    try:
        child = directory(str(pid), proc)
        data, _ = bounded_file("stat", child)
        # Linux comm can contain spaces and parentheses. Fields after its last
        # closing parenthesis begin at field 3; starttime is field 22.
        fields = data.decode("ascii").rsplit(") ", 1)[1].split()
        state, parent, started = fields[0], int(fields[1]), int(fields[19])
        if state not in "RSDZTWtXxKWPIN" or parent < 0 or started < 0:
            raise ValueError("invalid process stat")
        # procfs reports regular files with size zero. Read only the bounded
        # command line needed to classify a worker; never emit its arguments.
        command, _ = bounded_file("cmdline", child)
        verified, _ = bounded_file("stat", child)
        verified_fields = verified.decode("ascii").rsplit(") ", 1)[1].split()
        if int(verified_fields[19]) != started:
            raise ValueError("process changed during observation")
        worker = any(argument.endswith(b"/infra/sqlite-readonly-location.worker.js")
                     for argument in command.split(b"\x00"))
        return {"status": "observed", "pid": pid, "parentPid": parent,
                "state": state, "startTicks": started, "sqliteWorker": worker}
    except (OSError, ValueError, IndexError, UnicodeError):
        return {"status": "unavailable", "pid": pid}
    finally:
        if child is not None:
            os.close(child)


def owner_facts(payload, metadata, proc, now):
    if not isinstance(payload, dict):
        raise ValueError("invalid owner")
    pid = payload.get("pid")
    namespace = payload.get("processNamespace")
    result = {"status": "observed", "mtimeMs": metadata.st_mtime_ns // 1000000,
              "ageMs": now - metadata.st_mtime_ns // 1000000,
              "ownerProcess": process_facts(proc, pid)}
    if positive_integer(pid):
        result["pid"] = pid
    if positive_integer(payload.get("startTime")):
        result["recordedStartTime"] = payload["startTime"]
    role = payload.get("role")
    if isinstance(role, str) and role in {"gateway", "agent-embedded", "skill-workshop-apply", "sqlite-maintenance"}:
        result["role"] = role
    if payload.get("stateOwnerKind") == "schema":
        result["stateOwnerKind"] = "schema"
    if isinstance(namespace, dict) and namespace.get("platform") == "linux":
        host = namespace.get("host")
        if isinstance(host, str) and 0 < len(host) <= 256:
            result["hostMatchesCurrent"] = host == os.uname().nodename
        boot = namespace.get("identity")
        if isinstance(boot, str) and re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", boot):
            result["ownerBootIdentity"] = boot
        inode = namespace.get("pidNsInode")
        if isinstance(inode, str) and re.fullmatch(r"[0-9]{1,24}", inode):
            result["pidNamespaceInode"] = inode
    return result


def snapshot(state_root, proc_root):
    result = {"kind": "openclaw-owner-diagnostic-v1", "owners": [],
              "workers": [], "unavailableProcesses": 0,
              "stateScan": "unavailable", "processScan": "unavailable",
              "processIdentityCaveat": "numeric PID is an observation in the current namespace, not proof of owner liveness"}
    proc = root = temporary = None
    try:
        proc = directory(proc_root)
        try:
            result["currentPidNamespaceInode"] = str(os.stat("self/ns/pid", dir_fd=proc).st_ino)
        except OSError:
            pass
        # Kernel boot ID contains no credentials. Preserve only a UUID-shaped value.
        try:
            data, _ = bounded_file("sys/kernel/random/boot_id", proc, 64)
            boot_id = data.decode("ascii").strip()
            if re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", boot_id):
                result["currentBootId"] = boot_id
        except (OSError, ValueError, UnicodeError):
            pass
        count = 0
        with os.scandir(proc) as entries:
            for visited_process, entry in enumerate(entries):
                if visited_process >= 512:
                    result["processScan"] = "truncated"
                    break
                if not re.fullmatch(r"[1-9][0-9]{0,9}", entry.name):
                    continue
                if count >= MAX_PROCESSES:
                    result["processScan"] = "truncated"
                    break
                count += 1
                facts = process_facts(proc, int(entry.name))
                if facts["status"] != "observed":
                    result["unavailableProcesses"] += 1
                if facts.get("sqliteWorker"):
                    result["workers"].append(facts)
            else:
                result["processScan"] = "complete"
        # state_root is a caller-bound canonical directory. All children are
        # opened relative to held directory descriptors without following links.
        root = directory(state_root)
        temporary = directory("tmp", root)
        directories = locks = 0
        with os.scandir(temporary) as entries:
            for visited, entry in enumerate(entries):
                if visited >= 128:
                    result["stateScan"] = "truncated"
                    break
                if not re.fullmatch(r"openclaw(?:-[0-9]{1,10})?", entry.name):
                    continue
                if directories >= MAX_DIRECTORIES:
                    result["stateScan"] = "truncated"
                    break
                directories += 1
                owner_dir = None
                try:
                    owner_dir = directory(entry.name, temporary)
                    with os.scandir(owner_dir) as candidates:
                        for visited_lock, candidate in enumerate(candidates):
                            if visited_lock >= 128:
                                result["stateScan"] = "truncated"
                                break
                            if not LOCK_NAME.fullmatch(candidate.name):
                                continue
                            if locks >= MAX_LOCKS:
                                result["stateScan"] = "truncated"
                                break
                            locks += 1
                            try:
                                data, metadata = bounded_file(candidate.name, owner_dir)
                                facts = owner_facts(json.loads(data), metadata, proc, time.time_ns() // 1000000)
                            except (OSError, ValueError, UnicodeError, RecursionError):
                                facts = {"status": "unavailable"}
                            # The hash in the filename identifies the DB without
                            # disclosing payload config paths, hostnames or owner IDs.
                            result["owners"].append({"lock": candidate.name, **facts})
                except OSError:
                    result["owners"].append({"status": "directory-unavailable"})
                finally:
                    if owner_dir is not None:
                        os.close(owner_dir)
            else:
                if result["stateScan"] != "truncated":
                    result["stateScan"] = "complete"
    except OSError:
        pass
    finally:
        for fd in (temporary, root, proc):
            if fd is not None:
                os.close(fd)
    return result


if __name__ == "__main__":
    # Docker/Podman CLI termination alone need not stop an exec process.
    # Bound this observer inside the container as well as at the host transport.
    signal.alarm(8)
    parser = argparse.ArgumentParser()
    parser.add_argument("--state-root", required=True)
    parser.add_argument("--proc-root", default="/proc")
    args = parser.parse_args()
    print(json.dumps(snapshot(args.state_root, args.proc_root), separators=(",", ":")))
