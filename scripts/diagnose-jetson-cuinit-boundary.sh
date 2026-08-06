#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -uo pipefail

sandbox_name="${1:-tm}"
if [[ ! "$sandbox_name" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]; then
  printf 'Invalid sandbox name: %s\n' "$sandbox_name" >&2
  exit 2
fi

container_ids=()
while IFS=$'\t' read -r container_id container_name; do
  if [[ "$container_name" == "openshell-${sandbox_name}-"* ]] \
    && [[ "$container_name" != *-nemoclaw-gpu-backup-* ]]; then
    container_ids+=("$container_id")
  fi
done < <(docker ps --no-trunc --format '{{.ID}}\t{{.Names}}')

if ((${#container_ids[@]} != 1)); then
  printf 'Expected one running non-backup Docker container for sandbox %s; found %d.\n' \
    "$sandbox_name" "${#container_ids[@]}" >&2
  docker ps --no-trunc --format 'ID={{.ID}} NAME={{.Names}} STATUS={{.Status}}' >&2
  exit 1
fi

container_id="${container_ids[0]}"

cuda_probe='import ctypes
import glob
import os
import stat

print(f"identity=uid={os.getuid()} gid={os.getgid()} groups={os.getgroups()}")
for key in ("LD_LIBRARY_PATH", "NVIDIA_VISIBLE_DEVICES", "NVIDIA_DRIVER_CAPABILITIES"):
    print("env_{}={}".format(key, os.environ.get(key, "")))

patterns = (
    "/dev/nvidia*",
    "/dev/nvhost-*",
    "/dev/nvmap",
    "/dev/nvgpu/igpu0/*",
    "/dev/dri/renderD*",
)
paths = sorted({path for pattern in patterns for path in glob.glob(pattern)})
for path in paths:
    try:
        info = os.stat(path)
    except Exception as error:
        print(f"device_stat={path} {type(error).__name__}: {error}")
        continue
    if not stat.S_ISCHR(info.st_mode):
        continue
    access = []
    for label, flags in (("r", os.O_RDONLY), ("rw", os.O_RDWR)):
        try:
            fd = os.open(path, flags)
            os.close(fd)
            access.append(f"{label}=ok")
        except Exception as error:
            error_number = getattr(error, "errno", "")
            access.append(f"{label}={type(error).__name__}:{error_number}")
    print(
        f"device={path} mode={info.st_mode & 0o777:o} uid={info.st_uid} gid={info.st_gid} "
        + " ".join(access)
    )

try:
    cuda = ctypes.CDLL("libcuda.so.1")
except OSError as error:
    print(f"libcuda_load=OSError: {error}")
    raise SystemExit(11)

cuda.cuInit.argtypes = [ctypes.c_uint]
cuda.cuInit.restype = ctypes.c_int
result = cuda.cuInit(0)
print("libcuda_load=ok")
try:
    names = sorted(
        {
            line.split()[-1]
            for line in open("/proc/self/maps", encoding="utf-8")
            if "libcuda.so" in line and line.split()[-1].startswith("/")
        }
    )
    print(f"libcuda_maps={names}")
except Exception as error:
    print(f"libcuda_maps={type(error).__name__}: {error}")

error_name = ctypes.c_char_p()
try:
    cuda.cuGetErrorName.argtypes = [ctypes.c_int, ctypes.POINTER(ctypes.c_char_p)]
    cuda.cuGetErrorName.restype = ctypes.c_int
    name_result = cuda.cuGetErrorName(result, ctypes.byref(error_name))
    decoded_name = error_name.value.decode() if name_result == 0 and error_name.value else "unknown"
except Exception as error:
    decoded_name = f"unavailable:{type(error).__name__}"
print(f"cuInit(0)={result} name={decoded_name}")
raise SystemExit(0 if result == 0 else 10)'

run_probe() {
  local label="$1"
  shift
  local output status
  printf '\n=== %s ===\n' "$label"
  if output="$("$@" 2>&1)"; then
    status=0
  else
    status=$?
  fi
  printf '%s\nprobe_exit=%d\n' "$output" "$status"
  probe_output="$output"
}

extract_cuinit() {
  sed -n -E 's/^cuInit\(0\)=([0-9]+).*$/\1/p' <<<"$1" | tail -1
}

printf 'sandbox=%s\ncontainer=%s\n' "$sandbox_name" "$container_id"
printf 'This diagnostic is read-only. It does not create, restart, rename, or remove a sandbox or container.\n'
printf 'git_head=%s\n' "$(git rev-parse HEAD 2>/dev/null || printf unknown)"
printf 'openshell_version=%s\n' "$(openshell --version 2>&1 || printf unknown)"

printf '\n=== OpenShell policy paths ===\n'
openshell policy get --base "$sandbox_name" 2>&1 \
  | grep -E 'read_only:|read_write:|/opt/nvidia|/dev/nv|/dev/dri' || true

printf '\n=== Active container configuration ===\n'
docker inspect --format \
  'image={{.Image}} runtime={{.HostConfig.Runtime}} user={{json .Config.User}} group_add={{json .HostConfig.GroupAdd}} entrypoint={{json .Config.Entrypoint}} cmd={{json .Config.Cmd}} devices={{json .HostConfig.Devices}} device_requests={{json .HostConfig.DeviceRequests}}' \
  "$container_id" 2>&1 || true
docker exec --user 0 "$container_id" /usr/bin/id sandbox 2>&1 || true
docker exec --user 0 "$container_id" /usr/bin/stat -Lc \
  'wrapper=type=%F mode=%a uid=%u gid=%g path=%n' \
  /usr/local/lib/nemoclaw/jetson-device-group-bootstrap.sh 2>&1 || true

run_probe "Host account" python3 -c "$cuda_probe"
host_output="$probe_output"
run_probe "Direct Docker as root" docker exec --user 0 "$container_id" python3 -c "$cuda_probe"
docker_root_output="$probe_output"
run_probe "Direct Docker as sandbox" docker exec --user sandbox "$container_id" python3 -c "$cuda_probe"
docker_sandbox_output="$probe_output"
run_probe "OpenShell sandbox execution" openshell sandbox exec -n "$sandbox_name" -- python3 -c "$cuda_probe"
openshell_output="$probe_output"

host_cuinit="$(extract_cuinit "$host_output")"
docker_root_cuinit="$(extract_cuinit "$docker_root_output")"
docker_sandbox_cuinit="$(extract_cuinit "$docker_sandbox_output")"
openshell_cuinit="$(extract_cuinit "$openshell_output")"

printf '\n=== Boundary result ===\n'
printf 'host_cuInit=%s docker_root_cuInit=%s docker_sandbox_cuInit=%s openshell_cuInit=%s\n' \
  "${host_cuinit:-missing}" "${docker_root_cuinit:-missing}" \
  "${docker_sandbox_cuinit:-missing}" "${openshell_cuinit:-missing}"
if [[ "$docker_sandbox_cuinit" == "0" && "$openshell_cuinit" != "0" ]]; then
  printf 'ISOLATED: CUDA works in the running container as sandbox but fails through OpenShell execution. Investigate the OpenShell filesystem/device policy boundary.\n'
elif [[ "$docker_root_cuinit" == "0" && "$docker_sandbox_cuinit" != "0" ]]; then
  printf 'ISOLATED: CUDA works as root in the running container but fails as sandbox. Investigate identity, group, or device permission differences.\n'
elif [[ "$docker_root_cuinit" != "0" && "$docker_sandbox_cuinit" != "0" ]]; then
  printf 'ISOLATED: CUDA already fails in direct Docker execution. Investigate the recreated container runtime, injected driver libraries, and device set before changing OpenShell policy.\n'
else
  printf 'INCONCLUSIVE: preserve this output; the four boundaries did not produce a single failing transition.\n'
fi
