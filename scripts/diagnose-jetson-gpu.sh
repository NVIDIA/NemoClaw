#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

sandbox_name="${1:-tm}"

if [[ ! "$sandbox_name" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]; then
  printf 'Invalid sandbox name: %s\n' "$sandbox_name" >&2
  exit 2
fi

section() {
  printf '\n=== %s ===\n' "$1"
}

run() {
  printf '$'
  printf ' %q' "$@"
  printf '\n'
  if "$@" 2>&1; then
    return 0
  else
    local rc=$?
    printf '[exit=%d]\n' "$rc"
    return 0
  fi
}

run_labeled() {
  local label="$1"
  shift
  printf '$ %s\n' "$label"
  if "$@" 2>&1; then
    return 0
  else
    local rc=$?
    printf '[exit=%d]\n' "$rc"
    return 0
  fi
}

print_host_device_nodes() {
  local path
  shopt -s nullglob
  for path in /dev/nvmap /dev/nvhost-* /dev/nvgpu/* /dev/nvgpu/*/*; do
    stat -Lc 'type=%F mode=%a uid=%u gid=%g major=%t minor=%T path=%n' "$path" 2>&1 || true
  done
  shopt -u nullglob
}

collect_device_gids() {
  local path gid
  shopt -s nullglob
  for path in /dev/nvmap /dev/nvhost-* /dev/nvgpu/* /dev/nvgpu/*/*; do
    [[ -c "$path" ]] || continue
    gid="$(stat -Lc '%g' "$path")"
    [[ "$gid" =~ ^[0-9]+$ ]] || continue
    printf '%s\n' "$gid"
  done
  shopt -u nullglob
}

section "Host"
run date -u '+%Y-%m-%dT%H:%M:%SZ'
run uname -a
run id
if [[ -r /etc/nv_tegra_release ]]; then
  run sed -n '1,3p' /etc/nv_tegra_release
fi
print_host_device_nodes

section "OpenShell"
run openshell --version
run openshell sandbox list
printf '$ openshell policy get --base %q | filter Jetson paths\n' "$sandbox_name"
policy_output="$(openshell policy get --base "$sandbox_name" 2>&1)" || policy_rc=$?
printf '%s\n' "$policy_output" \
  | grep -E 'read_only:|read_write:|/opt/nvidia|/dev/nvmap|/dev/nvhost|/dev/nvgpu' \
  || true
if [[ -n "${policy_rc:-}" ]]; then
  printf '[exit=%d]\n' "$policy_rc"
fi

section "Matching Docker containers"
docker_rows="$(docker ps -a --no-trunc --format '{{.ID}}\t{{.Names}}\t{{.Status}}' 2>&1)" \
  || {
    printf '%s\n' "$docker_rows"
    exit 1
  }
printf '%s\n' "$docker_rows" \
  | awk -F '\t' -v prefix="openshell-${sandbox_name}-" 'index($2, prefix) == 1 { print }'

candidate_ids=()
while IFS=$'\t' read -r short_id container_name; do
  if [[ "$container_name" == "openshell-${sandbox_name}-"* ]] \
    && [[ "$container_name" != *-nemoclaw-gpu-backup-* ]]; then
    candidate_ids+=("$short_id")
  fi
done < <(docker ps --format '{{.ID}}\t{{.Names}}')

if ((${#candidate_ids[@]} == 0)); then
  printf 'No running non-backup Docker container found for sandbox %s.\n' "$sandbox_name" >&2
  exit 1
fi
if ((${#candidate_ids[@]} > 1)); then
  printf 'Warning: found %d running containers; using Docker newest-first candidate %s.\n' \
    "${#candidate_ids[@]}" "${candidate_ids[0]}"
fi

cid="$(docker inspect --format '{{.Id}}' "${candidate_ids[0]}")"

section "Active container configuration"
run docker inspect --format 'id={{.Id}} name={{.Name}} created={{.Created}} status={{.State.Status}} pid={{.State.Pid}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid"
run docker inspect --format 'image={{.Config.Image}} runtime={{.HostConfig.Runtime}} user={{json .Config.User}}' "$cid"
run docker inspect --format 'entrypoint={{json .Config.Entrypoint}}' "$cid"
run docker inspect --format 'cmd={{json .Config.Cmd}}' "$cid"
run docker inspect --format 'group_add={{json .HostConfig.GroupAdd}}' "$cid"
run docker inspect --format 'devices={{json .HostConfig.Devices}}' "$cid"
run docker inspect --format 'device_requests={{json .HostConfig.DeviceRequests}}' "$cid"
run docker inspect --format 'security_opt={{json .HostConfig.SecurityOpt}}' "$cid"
printf '$ docker inspect NVIDIA_* environment names\n'
docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$cid" \
  | sed -n -E 's/^(NVIDIA_[A-Z0-9_]+)=.*/\1=<set>/p'

container_pid="$(docker inspect --format '{{.State.Pid}}' "$cid")"
if [[ "$container_pid" =~ ^[1-9][0-9]*$ ]] && [[ -r "/proc/$container_pid/status" ]]; then
  section "Container init process on host"
  run sed -n -E '/^(Name|Pid|PPid|Uid|Gid|Groups):/p' "/proc/$container_pid/status"
fi

section "Container process identities"
run docker top "$cid" -eo pid,ppid,user,group,comm
run docker exec -u 0 "$cid" sh -c 'printf "pid1_cmd="; tr "\\000" " " </proc/1/cmdline; printf "\\n"; sed -n -E "/^(Name|Pid|PPid|Uid|Gid|Groups):/p" /proc/1/status'

section "Image bootstrap and group database"
run docker exec -u 0 "$cid" stat -Lc 'type=%F mode=%a uid=%u gid=%g path=%n' /usr/local/lib/nemoclaw/jetson-device-group-bootstrap.sh
run docker exec -u 0 "$cid" sha256sum /usr/local/lib/nemoclaw/jetson-device-group-bootstrap.sh
run docker exec -u 0 "$cid" id sandbox
while IFS= read -r gid; do
  [[ -n "$gid" ]] || continue
  run docker exec -u 0 "$cid" getent group "$gid"
done < <(collect_device_gids | sort -nu)

probe="$(
  cat <<'PROBE'
set +e
printf 'identity: '
id
sed -n -E '/^(Name|Pid|PPid|Uid|Gid|Groups):/p' /proc/self/status
printf 'LD_LIBRARY_PATH=%s\n' "${LD_LIBRARY_PATH:-}"
python3 - <<'PY'
import ctypes
import os
import stat

path = "/dev/nvmap"
try:
    info = os.stat(path)
    print(
        "nvmap_stat="
        f"type={'char' if stat.S_ISCHR(info.st_mode) else 'directory' if stat.S_ISDIR(info.st_mode) else 'other'} "
        f"mode={info.st_mode & 0o777:o} uid={info.st_uid} gid={info.st_gid} "
        f"rdev_major={os.major(info.st_rdev)} rdev_minor={os.minor(info.st_rdev)}"
    )
except Exception as error:
    print(f"nvmap_stat_error={type(error).__name__}: {error}")

for label, flags in (("read", os.O_RDONLY), ("read_write", os.O_RDWR)):
    try:
        fd = os.open(path, flags)
        os.close(fd)
        print(f"nvmap_open_{label}=ok")
    except Exception as error:
        print(f"nvmap_open_{label}={type(error).__name__}: {error}")

try:
    cuda = ctypes.CDLL("libcuda.so.1")
    print("libcuda_load=ok")
    rc = cuda.cuInit(0)
    print(f"cuInit(0)={rc}")
    mapped = []
    with open("/proc/self/maps", encoding="utf-8") as maps:
        for line in maps:
            if "libcuda" in line:
                mapped.append(line.rsplit(maxsplit=1)[-1])
    print("libcuda_maps=" + ",".join(sorted(set(mapped))))
except Exception as error:
    print(f"libcuda_error={type(error).__name__}: {error}")
PY
printf 'relevant_mounts:\n'
grep -E '/dev/nvmap|/opt/nvidia' /proc/self/mountinfo || true
PROBE
)"

section "Direct Docker as root"
run_labeled "docker exec as root: identity, nvmap open, and cuInit" \
  docker exec -u 0 "$cid" sh -c "$probe"

section "Direct Docker as sandbox user"
run_labeled "docker exec as sandbox: identity, nvmap open, and cuInit" \
  docker exec -u sandbox "$cid" sh -c "$probe"

section "OpenShell sandbox execution"
run_labeled "openshell sandbox exec: identity, nvmap open, and cuInit" \
  openshell sandbox exec -n "$sandbox_name" -- sh -c "$probe"

section "Diagnostic conclusion inputs"
printf 'sandbox=%s\ncontainer=%s\n' "$sandbox_name" "$cid"
printf 'This script did not create, restart, rename, or remove any container or sandbox.\n'
