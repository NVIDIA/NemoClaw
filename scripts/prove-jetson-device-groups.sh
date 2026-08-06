#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

sandbox_name="${1:-tm}"

if [[ ! "$sandbox_name" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]; then
  printf 'Invalid sandbox name: %s\n' "$sandbox_name" >&2
  exit 2
fi

collect_device_gids() {
  local path gid mode file_type group_digit other_digit group_access other_access
  local paths=(
    /dev/nvmap
    /dev/nvhost-ctrl
    /dev/nvhost-ctrl-gpu
    /dev/nvhost-gpu
    /dev/nvhost-as-gpu
    /dev/nvhost-prof-gpu
    /dev/nvhost-dbg-gpu
    /dev/nvhost-tsg-gpu
    /dev/nvgpu/igpu0/ctrl
    /dev/nvgpu/igpu0/as
    /dev/nvgpu/igpu0/prof
    /dev/dri/renderD*
  )
  shopt -s nullglob
  for path in "${paths[@]}"; do
    read -r gid mode file_type < <(stat -Lc '%g %a %F' "$path" 2>/dev/null) || continue
    [[ "$file_type" == "character special file" ]] || continue
    [[ "$gid" =~ ^[1-9][0-9]{0,9}$ ]] || continue
    ((gid <= 2147483647)) || continue
    group_digit=$(((10#$mode / 10) % 10))
    other_digit=$((10#$mode % 10))
    group_access=$((group_digit & 6))
    other_access=$((other_digit & 6))
    if (((group_access & ~other_access) != 0)); then
      printf '%s\n' "$gid"
    fi
  done
  shopt -u nullglob
}

candidate_ids=()
while IFS=$'\t' read -r short_id container_name; do
  if [[ "$container_name" == "openshell-${sandbox_name}-"* ]] \
    && [[ "$container_name" != *-nemoclaw-gpu-backup-* ]]; then
    candidate_ids+=("$short_id")
  fi
done < <(docker ps --format '{{.ID}}\t{{.Names}}')

if ((${#candidate_ids[@]} != 1)); then
  printf 'Expected one running non-backup Docker container for sandbox %s; found %d.\n' \
    "$sandbox_name" "${#candidate_ids[@]}" >&2
  exit 1
fi

container_id="$(docker inspect --format '{{.Id}}' "${candidate_ids[0]}")"
image_id="$(docker inspect --format '{{.Image}}' "$container_id")"
if [[ ! "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  printf 'Could not resolve the immutable sandbox image ID.\n' >&2
  exit 1
fi

gids=()
while IFS= read -r gid; do
  [[ -n "$gid" ]] && gids+=("$gid")
done < <(collect_device_gids | sort -nu)
if ((${#gids[@]} == 0 || ${#gids[@]} > 16)); then
  printf 'Detected an invalid Jetson device group count: %d.\n' "${#gids[@]}" >&2
  exit 1
fi

saved_ifs="$IFS"
IFS=,
gid_csv="${gids[*]}"
IFS="$saved_ifs"

container_probe="$({
  cat <<'PROBE'
set -euo pipefail

mode="$1"
group_gids="$2"

if [[ "$mode" == "proposed" ]]; then
  [[ -f /etc/group && ! -L /etc/group ]]
  IFS=',' read -r -a gids <<<"$group_gids"
  for gid in "${gids[@]}"; do
    group_record="$(getent group "$gid" || true)"
    if [[ -z "$group_record" ]]; then
      group_name="nemoclaw_gpu_$gid"
      groupadd --gid "$gid" "$group_name"
    else
      IFS=':' read -r group_name _ resolved_gid _ <<<"$group_record"
      [[ -n "$group_name" && "$resolved_gid" == "$gid" ]]
    fi
    usermod --append --groups "$group_name" sandbox
  done
fi

printf 'group_database_identity: '
id sandbox

python3 - <<'PY'
import ctypes
import os
import pwd
import stat
import sys

account = pwd.getpwnam("sandbox")
os.initgroups(account.pw_name, account.pw_gid)
os.setgid(account.pw_gid)
os.setuid(account.pw_uid)
print(f"post_initgroups_identity=uid={os.getuid()} gid={os.getgid()} groups={os.getgroups()}")

path = "/dev/nvmap"
try:
    info = os.stat(path)
    node_type = "char" if stat.S_ISCHR(info.st_mode) else "directory" if stat.S_ISDIR(info.st_mode) else "other"
    print(
        f"nvmap_stat=type={node_type} mode={info.st_mode & 0o777:o} "
        f"uid={info.st_uid} gid={info.st_gid}"
    )
except Exception as error:
    print(f"nvmap_stat_error={type(error).__name__}: {error}")

try:
    fd = os.open(path, os.O_RDWR)
    os.close(fd)
    print("nvmap_open_read_write=ok")
except Exception as error:
    print(f"nvmap_open_read_write={type(error).__name__}: {error}")

try:
    cuda = ctypes.CDLL("libcuda.so.1")
    cuda.cuInit.argtypes = [ctypes.c_uint]
    cuda.cuInit.restype = ctypes.c_int
    print("libcuda_load=ok")
    result = cuda.cuInit(0)
    print(f"cuInit(0)={result}")
    raise SystemExit(0 if result == 0 else 10)
except OSError as error:
    print(f"libcuda_error=OSError: {error}")
    raise SystemExit(11)
PY
PROBE
})"

docker_args=(
  run
  --rm
  --network none
  --user 0
  --runtime nvidia
  --env NVIDIA_VISIBLE_DEVICES=all
  --env "NVIDIA_DRIVER_CAPABILITIES=compute,utility"
  --cap-add SYS_PTRACE
  --security-opt apparmor=unconfined
)
for gid in "${gids[@]}"; do
  docker_args+=(--group-add "$gid")
done
docker_args+=(--entrypoint /bin/bash "$image_id" -c "$container_probe" --)

run_case() {
  local mode="$1"
  if case_output="$(docker "${docker_args[@]}" "$mode" "$gid_csv" 2>&1)"; then
    case_rc=0
  else
    case_rc=$?
  fi
}

printf 'sandbox=%s\ncontainer=%s\nimage=%s\ndetected_device_gids=%s\n' \
  "$sandbox_name" "$container_id" "$image_id" "$gid_csv"
printf 'The proof uses disposable --rm containers and does not modify the OpenShell sandbox.\n'

printf '\n=== Baseline: Docker groups followed by unchanged initgroups() ===\n'
run_case baseline
baseline_output="$case_output"
baseline_rc="$case_rc"
printf '%s\ncase_exit=%d\n' "$baseline_output" "$baseline_rc"

printf '\n=== Proposed: update /etc/group before the same initgroups() ===\n'
run_case proposed
proposed_output="$case_output"
proposed_rc="$case_rc"
printf '%s\ncase_exit=%d\n' "$proposed_output" "$proposed_rc"

baseline_cuda="$(printf '%s\n' "$baseline_output" | sed -n -E 's/^cuInit\(0\)=([0-9]+)$/\1/p' | tail -1)"
proposed_cuda="$(printf '%s\n' "$proposed_output" | sed -n -E 's/^cuInit\(0\)=([0-9]+)$/\1/p' | tail -1)"

if [[ "$baseline_rc" -ne 0 &&
  -n "$baseline_cuda" &&
  "$baseline_cuda" -ne 0 &&
  "$baseline_output" == *"libcuda_load=ok"* &&
  "$baseline_output" == *"nvmap_open_read_write=PermissionError"* &&
  "$proposed_rc" -eq 0 &&
  "$proposed_cuda" == "0" &&
  "$proposed_output" == *"nvmap_open_read_write=ok"* ]]; then
  printf '\nPROVEN: rebuilding sandbox supplementary groups from the unchanged container group database causes the failure; recording the device groups before initgroups fixes both nvmap access and CUDA initialization.\n'
  exit 0
fi

printf '\nINCONCLUSIVE: the A/B result did not isolate device-group persistence. Do not implement the proposed change from this result.\n' >&2
exit 1
