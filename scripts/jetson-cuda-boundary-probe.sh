#!/usr/bin/env bash

# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Non-configuring boundary probe for NemoClaw/OpenShell Jetson CUDA failures.
# This script does not recreate containers, change permissions, or edit policy.

set -uo pipefail

sandbox_name="${1:-tm}"
cuda_probe='import ctypes; lib=ctypes.CDLL("libcuda.so.1"); rc=lib.cuInit(0); print(f"cuInit(0)={rc}"); raise SystemExit(rc != 0)'

section() {
  printf '\n=== %s ===\n' "$1"
}

run_stage() {
  local label="$1"
  shift

  printf '%s\n' "--- ${label} ---"
  "$@"
  local status=$?
  printf 'stage_status=%s\n' "$status"
  return 0
}

container_context() {
  local docker_user="$1"

  docker exec --user "$docker_user" "$container_id" sh -c '
    id
    grep -E "^(NoNewPrivs|Seccomp|Seccomp_filters):" /proc/self/status 2>/dev/null || true
    for device_path in \
      /dev/nvmap \
      /dev/nvhost-* \
      /dev/nvgpu/igpu0/* \
      /dev/dri/renderD* \
      /dev/nvsciipc*; do
      [ -e "$device_path" ] || continue
      stat -Lc "device type=%F mode=%a uid=%u gid=%g path=%n" "$device_path" 2>/dev/null || true
      if [ -r "$device_path" ]; then device_read=yes; else device_read=no; fi
      if [ -w "$device_path" ]; then device_write=yes; else device_write=no; fi
      printf "device_permission_check read=%s write=%s path=%s\n" "$device_read" "$device_write" "$device_path"
    done
    for candidate_path in \
      /proc/device-tree \
      /sys/firmware/devicetree/base \
      /sys/devices/platform \
      /sys/class/devfreq \
      /sys/module; do
      if [ ! -e "$candidate_path" ]; then
        printf "path_access exists=no path=%s\n" "$candidate_path"
      elif ls -A "$candidate_path" >/dev/null 2>&1; then
        printf "path_access exists=yes list=yes path=%s\n" "$candidate_path"
      else
        printf "path_access exists=yes list=no path=%s\n" "$candidate_path"
      fi
    done
  '
}

openshell_context() {
  # Variables in the next single-quoted command belong to the in-sandbox shell.
  # shellcheck disable=SC2016
  openshell sandbox exec -n "$sandbox_name" -- sh -c '
    id
    grep -E "^(NoNewPrivs|Seccomp|Seccomp_filters):" /proc/self/status 2>/dev/null || true
    for device_path in \
      /dev/nvmap \
      /dev/nvhost-* \
      /dev/nvgpu/igpu0/* \
      /dev/dri/renderD* \
      /dev/nvsciipc*; do
      [ -e "$device_path" ] || continue
      stat -Lc "device type=%F mode=%a uid=%u gid=%g path=%n" "$device_path" 2>/dev/null || true
      if [ -r "$device_path" ]; then device_read=yes; else device_read=no; fi
      if [ -w "$device_path" ]; then device_write=yes; else device_write=no; fi
      printf "device_permission_check read=%s write=%s path=%s\n" "$device_read" "$device_write" "$device_path"
    done
    for candidate_path in \
      /proc/device-tree \
      /sys/firmware/devicetree/base \
      /sys/devices/platform \
      /sys/class/devfreq \
      /sys/module; do
      if [ ! -e "$candidate_path" ]; then
        printf "path_access exists=no path=%s\n" "$candidate_path"
      elif ls -A "$candidate_path" >/dev/null 2>&1; then
        printf "path_access exists=yes list=yes path=%s\n" "$candidate_path"
      else
        printf "path_access exists=yes list=no path=%s\n" "$candidate_path"
      fi
    done
  '
}

selected_nvidia_environment() {
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" \
    | grep -E '^NVIDIA_(VISIBLE_DEVICES|DRIVER_CAPABILITIES)='
}

base_policy_gpu_paths() {
  openshell policy get --base "$sandbox_name" 2>&1 \
    | grep -E 'filesystem_policy:|read_only:|read_write:|/dev/(nv|dri)|/opt/nvidia|/proc|/sys'
}

section "host and tool versions"
printf 'sandbox=%s\n' "$sandbox_name"
run_stage "git head" git rev-parse HEAD
run_stage "nemoclaw version" nemoclaw --version
run_stage "openshell version" openshell --version
run_stage "kernel" uname -a
run_stage "host nvmap" stat -Lc 'type=%F mode=%a uid=%u gid=%g group=%G path=%n' /dev/nvmap

container_id="$({
  docker ps -q \
    --filter 'label=openshell.ai/managed-by=openshell' \
    --filter "label=openshell.ai/sandbox-name=${sandbox_name}"
} | head -n 1)"

if [ -z "$container_id" ]; then
  printf 'ERROR: no running OpenShell-managed container found for sandbox %s\n' "$sandbox_name" >&2
  exit 2
fi

section "managed container"
printf 'container=%s\n' "$container_id"
run_stage "container configuration" docker inspect --format \
  'runtime={{.HostConfig.Runtime}} user={{json .Config.User}} status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} group_add={{json .HostConfig.GroupAdd}}' \
  "$container_id"
run_stage "selected NVIDIA environment" selected_nvidia_environment

section "effective filesystem policy entries"
run_stage "OpenShell base policy GPU paths" base_policy_gpu_paths

section "Docker exec as root"
run_stage "identity, devices, sysfs, and seccomp" container_context 0
run_stage "cuInit baseline" docker exec --user 0 "$container_id" python3 -c "$cuda_probe"
run_stage "cuInit without eager JIT preload" docker exec --user 0 "$container_id" env \
  CUDA_FORCE_PRELOAD_LIBRARIES=0 python3 -c "$cuda_probe"

section "Docker exec as sandbox"
run_stage "identity, devices, sysfs, and seccomp" container_context sandbox
run_stage "cuInit baseline" docker exec --user sandbox "$container_id" python3 -c "$cuda_probe"
run_stage "cuInit without eager JIT preload" docker exec --user sandbox "$container_id" env \
  CUDA_FORCE_PRELOAD_LIBRARIES=0 python3 -c "$cuda_probe"

section "OpenShell sandbox execution"
run_stage "identity, devices, sysfs, and seccomp" openshell_context
run_stage "cuInit baseline" openshell sandbox exec -n "$sandbox_name" -- python3 -c "$cuda_probe"
run_stage "cuInit without eager JIT preload" openshell sandbox exec -n "$sandbox_name" -- env \
  CUDA_FORCE_PRELOAD_LIBRARIES=0 python3 -c "$cuda_probe"

section "interpretation"
printf '%s\n' \
  'Docker sandbox-user cuInit(0) succeeds while OpenShell cuInit(0) fails: suggests an OpenShell confinement difference.' \
  'Docker root cuInit(0) succeeds while Docker sandbox-user cuInit(0) fails: suggests an account or device-permission difference.' \
  'Docker root cuInit(0) fails: suggests a recreated-container or NVIDIA runtime difference.' \
  'Baseline cuInit(0) fails while the no-preload probe succeeds: suggests a CUDA eager JIT library preload difference.'
