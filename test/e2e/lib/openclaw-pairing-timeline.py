# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Collect a redacted OpenClaw pairing timeline from inside a NemoClaw sandbox.

Usage: python3 openclaw-pairing-timeline.py STATE_DIR STATUS_PATH AUTO_PAIR_LOG PROC_ROOT WAIT_SECONDS

Reads the OpenClaw pairing state files, the auto-pair watcher status and log,
and /proc, then prints one JSON line of allowlisted fields and timestamps. When the
local CLI device is absent from the paired records it keeps polling for up to
WAIT_SECONDS. The collector never prints tokens, public keys, device or request
identifiers, or file paths, and it always exits 0 so it cannot replace the
scenario's primary result.
"""
import hashlib
import json
import os
import re
import stat
import sys
import time

SAFE_SCOPES = {
    "operator.pairing",
    "operator.read",
    "operator.write",
    "operator.admin",
    "operator.approvals",
    "operator.questions",
    "operator.talk",
    "operator.talk.secrets",
}
SAFE_CLIENTS = {"cli", "openclaw-cli", "openclaw-control-ui", "webchat"}
SAFE_ROLES = {"operator", "node"}
SAFE_STATES = {
    "running",
    "request-not-produced",
    "request-observed",
    "request-rejected",
    "approval-timeout",
    "approval-failed",
    "approval-completed",
    "canonical-settled",
    "stopped",
    "unavailable",
}
SAFE_STAGE_OUTCOMES = {
    "request-creation:observed",
    "request-creation:waiting",
    "listing:failed",
    "validation:accepted",
    "validation:rejected",
    "approval:attempting",
    "approval:failed",
    "watcher-execution:failed",
}
SAFE_REASONS = {
    "allowlisted-initial-cli",
    "allowlisted-request",
    "command-failed",
    "disallowed-scopes",
    "empty-output",
    "invalid-json",
    "invalid-response",
    "malformed-request-id",
    "malformed-scopes",
    "no-request",
    "not-allowlisted",
    "pairing-required",
    "timeout",
    "unknown-client",
}
AUTO_PAIR_STAGE_RE = re.compile(
    r"^\[auto-pair\] stage=(request-creation|listing|validation|approval|watcher-execution) "
    r"(observed|waiting|failed|accepted|rejected|attempting)\b"
)
AUTO_PAIR_REASON_RE = re.compile(r"\breason=([a-z-]+)\b")
AUTO_PAIR_MARKERS = {
    "watcherStarted": "[auto-pair] watcher started",
    "initialApproved": "[auto-pair] approved initial CLI pairing request=",
    "bootstrapCompleted": "[auto-pair] loopback CLI pairing bootstrap completed",
}
GATEWAY_TITLES = {"openclaw", "openclaw-gateway"}
GATEWAY_COMMAND_RE = re.compile(r"openclaw(?:\.mjs)? gateway run\b")
# nemoclaw-start.sh launches the auto-pair watcher as the only `python3 -u -` process.
WATCHER_COMMAND = "python3 -u -"
POLL_INTERVAL_MS = 2000
MAX_WAIT_SECONDS = 600
MAX_ENTRY_BYTES = 512 * 1024
MAX_LOG_BYTES = 384 * 1024
MAX_LISTED_ENTRIES = 20
MAX_LOG_EVENTS = 200
# Linux USER_HZ. /proc/<pid>/stat field 22 counts these ticks since boot; 100 is the standard kernel value.
CLOCK_TICKS_PER_SECOND = 100


def now_ms():
    return int(time.time() * 1000)


def is_record(value):
    return isinstance(value, dict)


def sha256_hex(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def read_bytes_nofollow(path, limit):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > limit:
            return None, None
        chunks = []
        remaining = limit + 1
        while remaining > 0:
            chunk = os.read(fd, min(remaining, 65536))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks), int(metadata.st_mtime * 1000)
    finally:
        os.close(fd)


def read_json_entry(path):
    try:
        data, mtime_ms = read_bytes_nofollow(path, MAX_ENTRY_BYTES)
        if data is None:
            return {"readable": False}
        return {"readable": True, "value": json.loads(data.decode("utf-8")), "mtimeMs": mtime_ms}
    except (OSError, ValueError):
        return {"readable": False}


def safe_string(value, allowlist):
    if not isinstance(value, str):
        return None
    return value if value in allowlist else "other"


def safe_scopes(value):
    if not isinstance(value, list):
        return {"scopes": None, "otherScopeCount": 0}
    scopes = sorted(scope for scope in value if isinstance(scope, str) and scope in SAFE_SCOPES)
    return {"scopes": scopes, "otherScopeCount": len(value) - len(scopes)}


def project_device(device):
    projection = {
        "clientId": safe_string(device.get("clientId"), SAFE_CLIENTS),
        "clientMode": safe_string(device.get("clientMode"), SAFE_CLIENTS),
        "role": safe_string(device.get("role"), SAFE_ROLES),
    }
    projection.update(safe_scopes(device.get("scopes")))
    return projection


def project_token(tokens):
    operator = tokens.get("operator") if is_record(tokens) else None
    if not is_record(operator):
        return {"present": False}
    token = operator.get("token")
    projection = {
        "present": isinstance(token, str) and len(token) > 0,
        "revoked": operator.get("revokedAtMs") is not None,
    }
    projection.update(safe_scopes(operator.get("scopes")))
    return projection


def local_device_id(entry):
    value = entry["value"].get("deviceId") if entry["readable"] and is_record(entry["value"]) else None
    return value if isinstance(value, str) and value else None


def project_identity(entry, device_id):
    return {
        "readable": entry["readable"],
        "deviceIdSha256": sha256_hex(device_id) if device_id is not None else None,
        "mtimeMs": entry.get("mtimeMs") if entry["readable"] else None,
    }


def project_paired(entry, device_id):
    if not entry["readable"] or not is_record(entry["value"]):
        return {"readable": False, "mtimeMs": None, "deviceCount": 0, "local": {"present": False}, "otherDevices": []}
    devices = [device for device in entry["value"].values() if is_record(device)]
    local = next((device for device in devices if device_id is not None and device.get("deviceId") == device_id), None)
    others = [project_device(device) for device in devices if device is not local][:MAX_LISTED_ENTRIES]
    if local is None:
        local_view = {"present": False}
    else:
        local_view = {"present": True}
        local_view.update(project_device(local))
        local_view["approved"] = safe_scopes(local.get("approvedScopes"))
        local_view["token"] = project_token(local.get("tokens"))
    return {
        "readable": True,
        "mtimeMs": entry["mtimeMs"],
        "deviceCount": len(devices),
        "local": local_view,
        "otherDevices": others,
    }


def project_pending(entry, device_id):
    if not entry["readable"] or not is_record(entry["value"]):
        return {"readable": False, "mtimeMs": None, "count": 0, "local": []}
    requests = [request for request in entry["value"].values() if is_record(request)]
    local = []
    for request in requests:
        if device_id is None or request.get("deviceId") != device_id:
            continue
        projection = project_device(request)
        projection["isRepair"] = request.get("isRepair") is True
        local.append(projection)
    return {"readable": True, "mtimeMs": entry["mtimeMs"], "count": len(requests), "local": local[:MAX_LISTED_ENTRIES]}


def project_status(entry):
    if not entry["readable"] or not is_record(entry["value"]):
        return {"readable": False, "state": None, "mtimeMs": None}
    return {"readable": True, "state": safe_string(entry["value"].get("state"), SAFE_STATES), "mtimeMs": entry["mtimeMs"]}


def read_log_tail(path):
    try:
        data, _mtime = read_bytes_nofollow(path, MAX_LOG_BYTES)
    except OSError:
        return None
    if data is None:
        try:
            with open(path, "rb") as handle:
                handle.seek(0, os.SEEK_END)
                size = handle.tell()
                handle.seek(max(0, size - MAX_LOG_BYTES))
                data = handle.read()
        except OSError:
            return None
        newline = data.find(b"\n")
        data = data[newline + 1 :] if newline >= 0 else b""
    return data.decode("utf-8", errors="replace")


def project_auto_pair_log(path):
    text = read_log_tail(path)
    markers = {key: None for key in AUTO_PAIR_MARKERS}
    if text is None:
        return {"readable": False, "lineCount": 0, "events": [], "markers": markers}
    lines = text.rstrip("\n").split("\n") if text.strip("\n") else []
    events = []
    for index, line in enumerate(lines):
        for key, prefix in AUTO_PAIR_MARKERS.items():
            if markers[key] is None and line.startswith(prefix):
                markers[key] = index
        match = AUTO_PAIR_STAGE_RE.match(line)
        if match is None or len(events) >= MAX_LOG_EVENTS:
            continue
        stage, outcome = match.group(1), match.group(2)
        if f"{stage}:{outcome}" not in SAFE_STAGE_OUTCOMES:
            continue
        event = {"index": index, "stage": stage, "outcome": outcome}
        reason_match = AUTO_PAIR_REASON_RE.search(line)
        if reason_match is not None and reason_match.group(1) in SAFE_REASONS:
            event["reason"] = reason_match.group(1)
        events.append(event)
    return {"readable": True, "lineCount": len(lines), "events": events, "markers": markers}


def read_proc_text(proc_root, *segments):
    try:
        with open(os.path.join(proc_root, *segments), "rb") as handle:
            return handle.read(65536).decode("utf-8", errors="replace")
    except OSError:
        return ""


def boot_time_ms(proc_root):
    match = re.search(r"^btime (\d+)$", read_proc_text(proc_root, "stat"), re.MULTILINE)
    return int(match.group(1)) * 1000 if match else None


def process_start_ms(proc_root, pid, boot_ms):
    text = read_proc_text(proc_root, str(pid), "stat")
    if boot_ms is None or ") " not in text:
        return None
    fields = text.rsplit(") ", 1)[1].split()
    if len(fields) < 20 or not fields[19].isdigit():
        return None
    return boot_ms + int(fields[19]) * 1000 // CLOCK_TICKS_PER_SECOND


def command_line(proc_root, pid):
    return read_proc_text(proc_root, str(pid), "cmdline").replace("\0", " ").strip()


def stdout_target(proc_root, pid):
    try:
        return os.readlink(os.path.join(proc_root, str(pid), "fd", "1"))
    except OSError:
        return ""


def is_gateway(command):
    return command in GATEWAY_TITLES or GATEWAY_COMMAND_RE.search(command) is not None


def find_process(proc_root, pids, predicate, boot_ms):
    pid = next((candidate for candidate in pids if predicate(candidate)), None)
    if pid is None:
        return None, {"running": False, "startedAtMs": None}
    return pid, {"running": True, "startedAtMs": process_start_ms(proc_root, pid, boot_ms)}


def stdout_is_auto_pair_log(proc_root, pid, auto_pair_log_path):
    # /proc/<pid>/fd needs the same uid or CAP_SYS_PTRACE; report None when unreadable.
    if pid is None:
        return None
    target = stdout_target(proc_root, pid)
    return None if target == "" else target == auto_pair_log_path


def project_processes(proc_root, auto_pair_log_path):
    boot_ms = boot_time_ms(proc_root)
    try:
        pids = sorted(int(name) for name in os.listdir(proc_root) if name.isdigit())
    except OSError:
        pids = []
    _gateway_pid, gateway = find_process(
        proc_root, pids, lambda pid: is_gateway(command_line(proc_root, pid)), boot_ms
    )
    watcher_pid, watcher = find_process(
        proc_root, pids, lambda pid: command_line(proc_root, pid) == WATCHER_COMMAND, boot_ms
    )
    watcher["stdoutIsAutoPairLog"] = stdout_is_auto_pair_log(proc_root, watcher_pid, auto_pair_log_path)
    return {
        "containerStartedAtMs": process_start_ms(proc_root, 1, boot_ms) if 1 in pids else None,
        "gateway": gateway,
        "autoPairWatcher": watcher,
    }


def snapshot(state_dir, status_path):
    identity_entry = read_json_entry(os.path.join(state_dir, "identity", "device.json"))
    device_id = local_device_id(identity_entry)
    return {
        "identity": project_identity(identity_entry, device_id),
        "paired": project_paired(read_json_entry(os.path.join(state_dir, "devices", "paired.json")), device_id),
        "pending": project_pending(read_json_entry(os.path.join(state_dir, "devices", "pending.json")), device_id),
        "status": project_status(read_json_entry(status_path)),
    }


def emit(record):
    sys.stdout.write(json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def collect(argv):
    if len(argv) != 5 or any(not isinstance(arg, str) or not arg for arg in argv):
        return {"schemaVersion": 1, "status": "unavailable"}
    state_dir, status_path, auto_pair_log_path, proc_root, wait_raw = argv
    if not wait_raw.isdigit() or int(wait_raw) > MAX_WAIT_SECONDS:
        return {"schemaVersion": 1, "status": "unavailable"}
    wait_budget_ms = int(wait_raw) * 1000
    collected_at_ms = now_ms()
    deadline_ms = collected_at_ms + wait_budget_ms
    current = snapshot(state_dir, status_path)
    while not current["paired"]["local"]["present"] and now_ms() + POLL_INTERVAL_MS <= deadline_ms:
        time.sleep(POLL_INTERVAL_MS / 1000)
        current = snapshot(state_dir, status_path)
    observed_at_ms = now_ms()
    record = {
        "schemaVersion": 1,
        "collectedAtMs": collected_at_ms,
        "observedAtMs": observed_at_ms,
        "appearance": {
            "pollIntervalMs": POLL_INTERVAL_MS,
            "waitBudgetMs": wait_budget_ms,
            "waitedMs": observed_at_ms - collected_at_ms,
            "present": current["paired"]["local"]["present"],
        },
        "autoPairLog": project_auto_pair_log(auto_pair_log_path),
        "processes": project_processes(proc_root, auto_pair_log_path),
    }
    record.update(current)
    return record


def main():
    try:
        emit(collect(sys.argv[1:]))
    except Exception:  # noqa: BLE001 - the collector must never replace the primary result.
        emit({"schemaVersion": 1, "status": "unavailable"})


if __name__ == "__main__":
    main()
