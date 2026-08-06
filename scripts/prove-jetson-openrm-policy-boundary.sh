#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

sandbox_name="${1:-tm}"
if [[ ! "$sandbox_name" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]; then
  printf 'Invalid sandbox name: %s\n' "$sandbox_name" >&2
  exit 2
fi

for command_name in docker nemoclaw openshell python3; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Required command not found: %s\n' "$command_name" >&2
    exit 2
  fi
done

candidate_path=/dev/nvidia-caps/nvidia-cap2
if [[ ! -c "$candidate_path" ]]; then
  printf 'Candidate OpenRM capability device is not a character device: %s\n' \
    "$candidate_path" >&2
  exit 2
fi

temporary_dir="$(mktemp -d)"
baseline_policy="$temporary_dir/baseline-policy.yaml"
candidate_policy="$temporary_dir/candidate-policy.yaml"
onboard_log="$temporary_dir/onboard.log"
onboard_pid=""
policy_changed=0

# shellcheck disable=SC2329 # Invoked by trap.
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ "$policy_changed" == "1" && -s "$baseline_policy" ]]; then
    printf '\nRestoring the original OpenShell policy...\n' >&2
    openshell policy set --policy "$baseline_policy" --wait "$sandbox_name" >/dev/null 2>&1 || true
  fi
  if [[ -n "$onboard_pid" ]]; then
    kill -CONT "$onboard_pid" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$temporary_dir"
  exit "$status"
}
trap cleanup EXIT INT TERM

cuda_probe='import ctypes
import os
import stat

print(f"identity=uid={os.getuid()} gid={os.getgid()} groups={os.getgroups()}")
for path in ("/dev/nvidia-caps/nvidia-cap1", "/dev/nvidia-caps/nvidia-cap2"):
    try:
        info = os.stat(path)
        node_type = "char" if stat.S_ISCHR(info.st_mode) else "other"
        print(f"path={path} type={node_type} mode={info.st_mode & 0o777:o} uid={info.st_uid} gid={info.st_gid}")
        try:
            fd = os.open(path, os.O_RDONLY)
            os.close(fd)
            print(f"open_read={path}:ok")
        except Exception as error:
            error_number = getattr(error, "errno", "")
            print(f"open_read={path}:{type(error).__name__}:{error_number}")
    except Exception as error:
        error_number = getattr(error, "errno", "")
        print(f"stat={path}:{type(error).__name__}:{error_number}")

try:
    cuda = ctypes.CDLL("libcuda.so.1")
except OSError as error:
    print(f"libcuda_load=OSError: {error}")
    raise SystemExit(11)

cuda.cuInit.argtypes = [ctypes.c_uint]
cuda.cuInit.restype = ctypes.c_int
result = cuda.cuInit(0)
error_name = ctypes.c_char_p()
try:
    cuda.cuGetErrorName.argtypes = [ctypes.c_int, ctypes.POINTER(ctypes.c_char_p)]
    cuda.cuGetErrorName.restype = ctypes.c_int
    name_result = cuda.cuGetErrorName(result, ctypes.byref(error_name))
    name = error_name.value.decode() if name_result == 0 and error_name.value else "unknown"
except Exception as error:
    name = f"unavailable:{type(error).__name__}"
print("libcuda_load=ok")
print(f"cuInit(0)={result} name={name}")
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

find_replacement() {
  local container_id entrypoint
  while IFS= read -r container_id; do
    [[ -n "$container_id" ]] || continue
    entrypoint="$(docker inspect --format '{{index .Config.Entrypoint 0}}' "$container_id" 2>/dev/null || true)"
    if [[ "$entrypoint" == "/usr/local/lib/nemoclaw/jetson-device-group-bootstrap.sh" ]]; then
      printf '%s\n' "$container_id"
      return 0
    fi
  done < <(
    docker ps --no-trunc \
      --filter "label=openshell.ai/sandbox-name=$sandbox_name" \
      --format '{{.ID}}'
  )
  return 1
}

printf 'sandbox=%s\n' "$sandbox_name"
printf 'candidate_read_only=%s\n' "$candidate_path"
printf 'This proof runs the real nemoclaw onboard --resume recreation, pauses the CLI while its replacement container is live, restores the original policy, and then allows normal rollback.\n'

NEMOCLAW_POLICY_TIER=balanced \
  nemoclaw onboard --resume --non-interactive </dev/null >"$onboard_log" 2>&1 &
onboard_pid=$!

replacement_id=""
for _ in {1..360}; do
  if replacement_id="$(find_replacement)"; then
    break
  fi
  if ! kill -0 "$onboard_pid" 2>/dev/null; then
    printf 'Onboarding exited before a Jetson replacement container appeared.\n' >&2
    sed -n '1,240p' "$onboard_log" >&2
    exit 1
  fi
  sleep 0.25
done
if [[ -z "$replacement_id" ]]; then
  printf 'Timed out waiting for the Jetson replacement container.\n' >&2
  exit 1
fi

kill -STOP "$onboard_pid"
printf 'replacement=%s\n' "$replacement_id"
docker inspect --format \
  'runtime={{.HostConfig.Runtime}} group_add={{json .HostConfig.GroupAdd}} entrypoint={{json .Config.Entrypoint}} cmd={{json .Config.Cmd}}' \
  "$replacement_id"

for _ in {1..240}; do
  container_status="$(docker inspect --format '{{.State.Status}}' "$replacement_id" 2>/dev/null || true)"
  health_status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$replacement_id" 2>/dev/null || true)"
  if [[ "$container_status" == "running" && "$health_status" == "healthy" ]]; then
    break
  fi
  if [[ "$container_status" == "exited" || "$container_status" == "dead" ]]; then
    printf 'Replacement container stopped before the A/B probe.\n' >&2
    docker logs --tail 160 "$replacement_id" >&2 || true
    exit 1
  fi
  sleep 0.25
done
if [[ "$container_status" != "running" || "$health_status" != "healthy" ]]; then
  printf 'Replacement did not become healthy: status=%s health=%s\n' \
    "$container_status" "$health_status" >&2
  exit 1
fi

nemoclaw "$sandbox_name" policy get >"$baseline_policy"
if [[ ! -s "$baseline_policy" ]]; then
  printf 'Could not export the live base policy for sandbox %s.\n' "$sandbox_name" >&2
  exit 1
fi
if grep -Fxq "  - $candidate_path" "$baseline_policy"; then
  printf 'The live baseline policy already grants %s; this A/B test requires it to be absent.\n' \
    "$candidate_path" >&2
  exit 2
fi

awk -v candidate="$candidate_path" '
  /^  read_only:$/ && !inserted {
    print
    print "  - " candidate
    inserted = 1
    next
  }
  { print }
  END {
    if (!inserted) exit 42
  }
' "$baseline_policy" >"$candidate_policy" || {
  printf 'Could not add %s to filesystem_policy.read_only.\n' "$candidate_path" >&2
  exit 1
}

run_probe "Direct Docker as sandbox with the recreated container" \
  docker exec --user sandbox "$replacement_id" python3 -c "$cuda_probe"
direct_output="$probe_output"

run_probe "OpenShell with the unchanged baseline policy" \
  openshell sandbox exec -n "$sandbox_name" -- python3 -c "$cuda_probe"
baseline_output="$probe_output"

printf '\nApplying the one-path candidate policy...\n'
policy_changed=1
openshell policy set --policy "$candidate_policy" --wait "$sandbox_name"

run_probe "OpenShell with nvidia-cap2 read-only" \
  openshell sandbox exec -n "$sandbox_name" -- python3 -c "$cuda_probe"
candidate_output="$probe_output"

printf '\nRestoring the unchanged baseline policy...\n'
openshell policy set --policy "$baseline_policy" --wait "$sandbox_name"
policy_changed=0

direct_cuinit="$(extract_cuinit "$direct_output")"
baseline_cuinit="$(extract_cuinit "$baseline_output")"
candidate_cuinit="$(extract_cuinit "$candidate_output")"

printf '\n=== A/B result ===\n'
printf 'direct_docker_cuInit=%s baseline_openshell_cuInit=%s candidate_openshell_cuInit=%s\n' \
  "${direct_cuinit:-missing}" "${baseline_cuinit:-missing}" "${candidate_cuinit:-missing}"

kill -CONT "$onboard_pid"
if wait "$onboard_pid"; then
  onboard_status=0
else
  onboard_status=$?
fi
onboard_pid=""
printf 'onboard_exit_after_baseline_restore=%d\n' "$onboard_status"

if [[ "$direct_cuinit" == "0" && "$baseline_cuinit" == "801" && "$candidate_cuinit" == "0" ]]; then
  printf '\nPROVEN: the replacement and sandbox identity can initialize CUDA, but OpenShell denies the world-readable OpenRM capability device. Granting only %s read-only changes cuInit from 801 to 0.\n' \
    "$candidate_path"
  exit 0
fi

printf '\nINCONCLUSIVE: this A/B did not isolate %s. Do not implement that policy change from this result.\n' \
  "$candidate_path" >&2
exit 1
