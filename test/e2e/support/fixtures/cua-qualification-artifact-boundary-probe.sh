#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

readonly TASK_INPUT=/run/nemoclaw-cua-artifact/task-input
readonly TARGET_SOCKET=/run/nemoclaw-cua-artifact/target.sock

status_value() {
  local key="$1"
  local status_key status_value _rest
  while read -r status_key status_value _rest; do
    if [[ "$status_key" == "$key:" ]]; then
      printf '%s\n' "$status_value"
      return 0
    fi
  done </proc/self/status
  return 1
}

[[ "$#" -ge 1 ]] || exit 20
mode="$1"
shift
[[ "$0" == "/run/nemoclaw-cua-artifact/executable" ]] || exit 21
[[ "$(/usr/bin/stat -Lc '%u:%g:%a:%F' /)" == "0:0:755:directory" ]] || exit 25

case "$mode" in
  boundary)
    [[ "$#" == "4" ]] || exit 22
    controller_pid="$1"
    controller_fd="$2"
    host_tcp_port="$3"
    target_mode="$4"
    [[ "$controller_pid" =~ ^[1-9][0-9]*$ && "$controller_fd" =~ ^[3-9][0-9]*$ &&
      "$host_tcp_port" =~ ^[1-9][0-9]{0,4}$ ]] || exit 23
    [[ "$target_mode" == "require" || "$target_mode" == "none" ]] || exit 24

    # The controller supplies one sealed input through the runner. Its source
    # path, sibling files, caller descriptors, and environment stay outside.
    [[ -f "$TASK_INPUT" && ! -L "$TASK_INPUT" ]] || exit 30
    [[ "$(/usr/bin/stat -Lc '%u:%g:%a:%h:%F' -- "$TASK_INPUT")" == "0:0:444:1:regular file" ]] || exit 31
    task_input_sha256="$(/usr/bin/sha256sum -- "$TASK_INPUT")"
    task_input_sha256="${task_input_sha256%% *}"
    [[ "$task_input_sha256" =~ ^[0-9a-f]{64}$ ]] || exit 32
    [[ ! -e /run/nemoclaw-cua-artifact/task-input-sibling ]] || exit 33
    [[ -z "${NEMOCLAW_CONTROLLER_SECRET:-}" ]] || exit 34
    [[ ! -e "/proc/${controller_pid}" && ! -e "/proc/self/fd/${controller_fd}" ]] || exit 35

    # Only the executable/runtime libraries and a small sanitized /etc exist.
    for hidden_path in /usr/local /opt /home /sys /run/host /run/systemd; do
      [[ ! -e "$hidden_path" ]] || exit 40
    done
    [[ -d /usr/bin && -d /usr/lib ]] || exit 41
    ! (printf 'write-denied\n' >/usr/bin/cua-boundary-write) 2>/dev/null || exit 42
    [[ ! -e /usr/bin/cua-boundary-write ]] || exit 43
    mapfile -t etc_children < <(printf '%s\n' /etc/*)
    [[ "${etc_children[*]}" == "/etc/group /etc/nsswitch.conf /etc/passwd" ]] || exit 44

    mapfile -t dev_children < <(printf '%s\n' /dev/*)
    [[ "${dev_children[*]}" == "/dev/fd /dev/null /dev/random /dev/shm /dev/stderr /dev/stdin /dev/stdout /dev/urandom /dev/zero" ]] \
      || exit 45
    [[ -c /dev/null && -c /dev/zero && -c /dev/random && -c /dev/urandom &&
      -d /dev/shm && ! -e /dev/nvidia0 && ! -e /dev/tty && ! -e /dev/ptmx ]] || exit 46

    artifact_uid="$(/usr/bin/id -u)"
    artifact_gid="$(/usr/bin/id -g)"
    [[ "$artifact_uid" =~ ^[1-9][0-9]*$ && "$artifact_gid" =~ ^[1-9][0-9]*$ ]] || exit 50
    [[ "$(/usr/bin/id -G)" == "$artifact_gid" ]] || exit 51
    [[ "$PWD" == "/run/nemoclaw-cua-artifact/home" ]] || exit 66
    [[ "$(/usr/bin/stat -Lc '%u:%g:%a:%F' /run/nemoclaw-cua-artifact/home)" == "$artifact_uid:$artifact_gid:700:directory" ]] || exit 69
    [[ "$(/usr/bin/stat -Lc '%u:%g:%a:%F' /run/nemoclaw-cua-artifact/tmp)" == "$artifact_uid:$artifact_gid:700:directory" ]] || exit 67
    [[ "$(/usr/bin/stat -Lc '%u:%g:%a:%F' "/run/user/$artifact_uid")" == "$artifact_uid:$artifact_gid:700:directory" ]] || exit 68
    for capability in CapInh CapPrm CapEff CapBnd CapAmb; do
      [[ "$(status_value "$capability")" =~ ^0+$ ]] || exit 52
    done
    [[ "$(status_value NoNewPrivs)" == "1" && "$(status_value Seccomp)" == "2" ]] || exit 53
    [[ "$(/usr/bin/uname -n)" == "nemoclaw-cua-artifact" ]] || exit 58

    shopt -s nullglob
    proc_entry_count=0
    for _proc_entry in /proc/[0-9]*; do
      ((proc_entry_count += 1))
    done
    ((proc_entry_count <= 3)) || exit 54
    namespace_pid=""
    while read -r status_key status_values; do
      if [[ "$status_key" == "NSpid:" ]]; then
        read -r -a namespace_pids <<<"$status_values"
        namespace_pid="${namespace_pids[-1]}"
      fi
    done </proc/self/status
    [[ "$namespace_pid" =~ ^[1-3]$ ]] || exit 55
    cgroup_path=""
    while IFS=: read -r hierarchy_id _controllers hierarchy_path; do
      [[ "$hierarchy_id" == "0" ]] && cgroup_path="$hierarchy_path"
    done </proc/self/cgroup
    [[ "$cgroup_path" == "/" ]] || exit 56
    [[ "$(ulimit -n)" == "64" && "$(ulimit -c)" == "0" ]] || exit 57
    mount_namespace="$(/usr/bin/readlink /proc/self/ns/mnt)"
    network_namespace="$(/usr/bin/readlink /proc/self/ns/net)"
    ipc_namespace="$(/usr/bin/readlink /proc/self/ns/ipc)"
    uts_namespace="$(/usr/bin/readlink /proc/self/ns/uts)"
    cgroup_namespace="$(/usr/bin/readlink /proc/self/ns/cgroup)"
    for namespace_identity in "$mount_namespace" "$network_namespace" "$ipc_namespace" \
      "$uts_namespace" "$cgroup_namespace"; do
      [[ "$namespace_identity" =~ ^[a-z]+:\[[0-9]+\]$ ]] || exit 58
    done

    # The service seccomp and address-family policies are observed rather than
    # inferred from unit text. The launcher-only namespace syscalls also fail
    # after the irreversible UID/capability drop.
    /usr/bin/python3 - <<'PY'
import ctypes
import errno
import fcntl
import os
import socket

open_fds = []
for entry in os.listdir("/proc/self/fd"):
    fd = int(entry)
    if fd <= 2:
        continue
    try:
        fcntl.fcntl(fd, fcntl.F_GETFD)
    except OSError as error:
        if error.errno != errno.EBADF:
            raise
    else:
        open_fds.append(fd)
if open_fds:
    raise SystemExit(59)

for family in (socket.AF_INET, socket.AF_VSOCK):
    try:
        socket.socket(family, socket.SOCK_STREAM)
    except OSError:
        pass
    else:
        raise SystemExit(60)

libc = ctypes.CDLL(None, use_errno=True)
checks = (
    (250, (0, 0, 0, 0, 0), {errno.ENOSYS, errno.EPERM}),  # keyctl
    (321, (0, 0, 0), {errno.ENOSYS, errno.EPERM}),        # bpf
    (298, (0, 0, 0, 0, 0), {errno.ENOSYS, errno.EPERM}),  # perf_event_open
    (425, (1, 0), {errno.ENOSYS, errno.EPERM}),            # io_uring_setup
    (323, (0,), {errno.ENOSYS, errno.EPERM}),              # userfaultfd
    (308, (-1, 0), {errno.ENOSYS, errno.EPERM}),           # setns
    (272, (0x10000000,), {errno.ENOSYS, errno.EPERM}),     # unshare(CLONE_NEWUSER)
    (56, (0x10000000, 0, 0, 0, 0), {errno.ENOSYS, errno.EPERM}),  # clone(CLONE_NEWUSER)
    (435, (0, 0), {errno.ENOSYS}),                         # clone3
)
for syscall_number, arguments, accepted in checks:
    ctypes.set_errno(0)
    result = libc.syscall(syscall_number, *arguments)
    observed = ctypes.get_errno()
    if result != -1 or observed not in accepted:
        raise SystemExit(61)
PY

    if [[ "$target_mode" == "require" ]]; then
      [[ "${NEMOCLAW_CUA_QUALIFICATION_TARGET_SOCKET:-}" == "$TARGET_SOCKET" &&
        -S "$TARGET_SOCKET" ]] || exit 62
      target_response="$(/usr/bin/node -e '
const net = require("node:net");
const client = net.createConnection(process.argv[1]);
client.setEncoding("utf8");
client.setTimeout(1000, () => client.destroy(new Error("timeout")));
let output = "";
client.on("connect", () => client.write("qualification-probe\\n"));
client.on("data", (chunk) => { output += chunk; });
client.on("end", () => process.stdout.write(output));
client.on("error", () => process.exit(1));
' "$TARGET_SOCKET")" || exit 63
      [[ "$target_response" == "target-service-ok" ]] || exit 64
    else
      [[ -z "${NEMOCLAW_CUA_QUALIFICATION_TARGET_SOCKET:-}" && ! -e "$TARGET_SOCKET" ]] || exit 65
    fi

    printf '{"kind":"boundary","taskInputSha256":"%s","uid":%s,"gid":%s,"namespacePid":%s,"procEntries":%s,"cgroup":"%s","seccomp":2,"target":"%s","mountNamespace":"%s","networkNamespace":"%s","ipcNamespace":"%s","utsNamespace":"%s","cgroupNamespace":"%s"}\n' \
      "$task_input_sha256" "$artifact_uid" "$artifact_gid" "$namespace_pid" \
      "$proc_entry_count" "$cgroup_path" "$target_mode" "$mount_namespace" \
      "$network_namespace" "$ipc_namespace" "$uts_namespace" "$cgroup_namespace"
    ;;
  pids)
    [[ "$#" == "0" ]] || exit 70
    child_pids=()
    for _index in {1..64}; do
      if /usr/bin/sleep 2 2>/dev/null & then
        child_pids+=("$!")
      else
        break
      fi
    done
    for child_pid in "${child_pids[@]}"; do
      kill "$child_pid" >/dev/null 2>&1 || true
    done
    wait >/dev/null 2>&1 || true
    ((${#child_pids[@]} < 64)) || exit 71
    printf '{"kind":"pids","started":%s}\n' "${#child_pids[@]}"
    ;;
  stdin)
    [[ "$#" == "0" ]] || exit 75
    stdin_copy="$TMPDIR/stdin"
    /usr/bin/dd of="$stdin_copy" status=none
    stdin_bytes="$(/usr/bin/wc -c <"$stdin_copy")"
    stdin_sha256="$(/usr/bin/sha256sum -- "$stdin_copy")"
    stdin_sha256="${stdin_sha256%% *}"
    printf '{"kind":"stdin","bytes":%s,"sha256":"%s"}\n' \
      "$stdin_bytes" "$stdin_sha256"
    ;;
  linger)
    [[ "$#" == "0" ]] || exit 80
    /usr/bin/sleep 120 &
    child_pid="$!"
    cgroup_path=""
    while IFS=: read -r hierarchy_id _controllers hierarchy_path; do
      [[ "$hierarchy_id" == "0" ]] && cgroup_path="$hierarchy_path"
    done </proc/self/cgroup
    printf '{"kind":"linger","childNamespacePid":%s,"cgroup":"%s"}\n' \
      "$child_pid" "$cgroup_path"
    wait "$child_pid"
    ;;
  overflow-stdout)
    [[ "$#" == "0" ]] || exit 90
    /usr/bin/head -c 20000 /dev/zero | /usr/bin/tr '\0' x
    ;;
  overflow-stderr)
    [[ "$#" == "0" ]] || exit 91
    /usr/bin/head -c 20000 /dev/zero | /usr/bin/tr '\0' x >&2
    ;;
  overflow-split)
    [[ "$#" == "0" ]] || exit 92
    /usr/bin/head -c 9000 /dev/zero | /usr/bin/tr '\0' x
    /usr/bin/head -c 9000 /dev/zero | /usr/bin/tr '\0' x >&2
    ;;
  exit-code)
    [[ "$#" == "0" ]] || exit 93
    printf 'bounded-stdout\n'
    printf 'bounded-stderr\n' >&2
    exit 23
    ;;
  cancellation-marker)
    [[ "$#" == "0" && -S "$TARGET_SOCKET" ]] || exit 94
    marker_response="$(/usr/bin/node -e '
const net = require("node:net");
const client = net.createConnection(process.argv[1]);
client.setEncoding("utf8");
client.setTimeout(1000, () => client.destroy(new Error("timeout")));
let output = "";
client.on("connect", () => client.write("cancellation-marker\\n"));
client.on("data", (chunk) => { output += chunk; });
client.on("end", () => process.stdout.write(output));
client.on("error", () => process.exit(1));
' "$TARGET_SOCKET")" || exit 95
    [[ "$marker_response" == "marker-recorded" ]] || exit 96
    ;;
  *) exit 99 ;;
esac
