#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

if [ "$#" -ne 0 ]; then
  echo "Jetson cleanup accepts no arguments" >&2
  exit 2
fi

state_directory=/var/lib/nemoclaw-jetson-dispatch/state
lock_file="$state_directory/device.lock"
identity_file=/var/lib/nemoclaw-jetson-dispatch/id_ed25519
known_hosts_file=/var/lib/nemoclaw-jetson-dispatch/known_hosts
destination=nvidia@192.168.55.1

IFS= read -r job_id <"$lock_file"
if ! [[ "$job_id" =~ ^[a-f0-9]{64}$ ]]; then
  echo "Jetson cleanup lock contains an invalid job ID" >&2
  exit 1
fi

exec ssh -F /dev/null -T \
  -o BatchMode=yes \
  -o ConnectTimeout=15 \
  -o IdentitiesOnly=yes \
  -o ServerAliveCountMax=2 \
  -o ServerAliveInterval=15 \
  -o StrictHostKeyChecking=yes \
  -o "UserKnownHostsFile=$known_hosts_file" \
  -i "$identity_file" \
  "$destination" bash -s -- "$job_id" <<'JETSON_CLEANUP'
set -euo pipefail

job_id="$1"
[[ "$job_id" =~ ^[a-f0-9]{64}$ ]]

workspace_root=/var/tmp/nemoclaw-jetson-e2e
workspace="$workspace_root/$job_id"
job_home="$workspace/home"
sandbox_name=e2e-jetson-nvmap
gateway_name=nemoclaw
gateway_container=openshell-cluster-nemoclaw
gateway_volume=openshell-cluster-nemoclaw
service_directory="/tmp/nemoclaw-services-$sandbox_name"

if [ -L "$workspace_root" ] || { [ -e "$workspace_root" ] && [ ! -d "$workspace_root" ]; }; then
  echo "Jetson E2E workspace root is not a trusted directory" >&2
  exit 1
fi
if [ -L "$workspace" ] || { [ -e "$workspace" ] && [ ! -d "$workspace" ]; }; then
  echo "Jetson E2E job workspace is not a trusted directory" >&2
  exit 1
fi
if [ -L "$job_home" ] || { [ -e "$job_home" ] && [ ! -d "$job_home" ]; }; then
  echo "Jetson E2E job home is not a trusted directory" >&2
  exit 1
fi

require_plain_directory_if_present() {
  local directory="$1"
  if [ -L "$directory" ] || { [ -e "$directory" ] && [ ! -d "$directory" ]; }; then
    echo "Refusing an untrusted cleanup directory: $directory" >&2
    exit 1
  fi
}

require_plain_directory_if_present "$job_home/.nemoclaw"
require_plain_directory_if_present "$job_home/.local"
require_plain_directory_if_present "$job_home/.local/state"
require_plain_directory_if_present "$job_home/.local/state/nemoclaw"
require_plain_directory_if_present "$job_home/.local/state/nemoclaw/openshell-docker-gateway"
require_plain_directory_if_present "$service_directory"

recorded_volumes=()
record_volume() {
  local volume="$1"
  [[ "$volume" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$ ]] || {
    echo "Refusing an invalid recorded Docker volume name" >&2
    exit 1
  }
  local recorded
  for recorded in "${recorded_volumes[@]}"; do
    [ "$recorded" = "$volume" ] && return 0
  done
  recorded_volumes+=("$volume")
}

record_container_volumes() {
  local container="$1" volume
  while IFS= read -r volume; do
    [ -n "$volume" ] || continue
    record_volume "$volume"
  done < <(
    docker container inspect --format \
      '{{range .Mounts}}{{if eq .Type "volume"}}{{println .Name}}{{end}}{{end}}' \
      "$container"
  )
}

mapfile -t sandbox_containers < <(
  docker ps -aq \
    --filter label=openshell.ai/managed-by=openshell \
    --filter "label=openshell.ai/sandbox-name=$sandbox_name"
)
for container in "${sandbox_containers[@]}"; do
  [[ "$container" =~ ^[a-f0-9]{12,64}$ ]] || {
    echo "Refusing an invalid recorded Docker container ID" >&2
    exit 1
  }
  record_container_volumes "$container"
done
if docker container inspect "$gateway_container" >/dev/null 2>&1; then
  record_container_volumes "$gateway_container"
fi
record_volume "$gateway_volume"

read_recorded_pid() {
  local pid_file="$1"
  if [ ! -e "$pid_file" ]; then
    return 0
  fi
  if [ -L "$pid_file" ] || [ ! -f "$pid_file" ]; then
    echo "Refusing an untrusted cleanup PID file: $pid_file" >&2
    exit 1
  fi
  local pid
  IFS= read -r pid <"$pid_file"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || {
    echo "Refusing an invalid cleanup PID file: $pid_file" >&2
    exit 1
  }
  printf '%s\n' "$pid"
}

auth_proxy_pid="$(read_recorded_pid "$job_home/.nemoclaw/ollama-auth-proxy.pid")"
gateway_pid="$(read_recorded_pid "$job_home/.local/state/nemoclaw/openshell-docker-gateway/openshell-gateway.pid")"
cloudflared_pid="$(read_recorded_pid "$service_directory/cloudflared.pid")"

validate_recorded_pid() {
  local pid="$1" marker="$2"
  [ -n "$pid" ] || return 0
  kill -0 "$pid" 2>/dev/null || return 0
  local process_uid cmdline
  process_uid="$(awk '/^Uid:/ { print $2; exit }' "/proc/$pid/status")"
  [ "$process_uid" = "$(id -u)" ] || {
    echo "Refusing to stop a process owned by another user" >&2
    exit 1
  }
  cmdline="$(tr '\000' ' ' <"/proc/$pid/cmdline")"
  case "$cmdline" in
    *"$marker"*) ;;
    *) echo "Refusing to stop a recorded PID with an unexpected command" >&2; exit 1 ;;
  esac
  if ! tr '\000' '\n' <"/proc/$pid/environ" | grep -Fqx "HOME=$job_home"; then
    echo "Refusing to stop a process outside the job home" >&2
    exit 1
  fi
}

stop_recorded_pid() {
  local pid="$1" marker="$2"
  [ -n "$pid" ] || return 0
  kill -0 "$pid" 2>/dev/null || return 0
  validate_recorded_pid "$pid" "$marker"
  kill "$pid"
  for _attempt in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.2
  done
  kill -KILL "$pid"
  for _attempt in 1 2 3 4 5; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.2
  done
  echo "Recorded cleanup process $pid did not stop" >&2
  exit 1
}

validate_recorded_pid "$auth_proxy_pid" ollama-auth-proxy.
validate_recorded_pid "$gateway_pid" openshell-gateway
validate_recorded_pid "$cloudflared_pid" cloudflared

printf '%s\n' nemoclaw-cleanup-evidence-v1-begin
for volume in "${recorded_volumes[@]}"; do
  printf 'volume\t%s\n' "$volume"
done
for pid in "$auth_proxy_pid" "$gateway_pid" "$cloudflared_pid"; do
  if [ -n "$pid" ]; then
    printf 'processId\t%s\n' "$pid"
  fi
done
printf '%s\n' nemoclaw-cleanup-evidence-v1-end

gateway_present=0
if [ -d "$job_home" ]; then
  gateway_json="$(HOME="$job_home" openshell gateway list -o json)"
  gateway_state="$(printf '%s' "$gateway_json" | node -e '
    const fs = require("node:fs");
    const rows = JSON.parse(fs.readFileSync(0, "utf8"));
    if (!Array.isArray(rows)) throw new Error("invalid gateway list");
    process.stdout.write(rows.some((row) => row && row.name === "nemoclaw") ? "present" : "absent");
  ')"
  if [ "$gateway_state" = present ]; then
    gateway_present=1
  fi
fi

if [ "$gateway_present" -eq 1 ]; then
  forward_list="$(HOME="$job_home" openshell forward list --gateway "$gateway_name")"
  while IFS= read -r port; do
    [ -n "$port" ] || continue
    [[ "$port" =~ ^[1-9][0-9]{0,4}$ ]] || {
      echo "Refusing an invalid recorded OpenShell forward port" >&2
      exit 1
    }
    HOME="$job_home" openshell forward stop "$port" "$sandbox_name"
  done < <(
    printf '%s\n' "$forward_list" | awk -v sandbox="$sandbox_name" \
      '$1 == sandbox && $3 ~ /^[0-9]+$/ { print $3 }'
  )

  sandbox_names="$(HOME="$job_home" openshell sandbox list --names -g "$gateway_name")"
  if printf '%s\n' "$sandbox_names" | grep -Fqx "$sandbox_name"; then
    HOME="$job_home" openshell sandbox delete "$sandbox_name"
  fi
  sandbox_names="$(HOME="$job_home" openshell sandbox list --names -g "$gateway_name")"
  if printf '%s\n' "$sandbox_names" | grep -Fqx "$sandbox_name"; then
    echo "The test-owned OpenShell sandbox remains" >&2
    exit 1
  fi
  forward_list="$(HOME="$job_home" openshell forward list --gateway "$gateway_name")"
  if printf '%s\n' "$forward_list" | awk -v sandbox="$sandbox_name" \
    '$1 == sandbox && $3 ~ /^[0-9]+$/ { found = 1 } END { exit found ? 0 : 1 }'; then
    echo "A test-owned OpenShell forward remains" >&2
    exit 1
  fi
  HOME="$job_home" openshell gateway remove "$gateway_name" \
    || HOME="$job_home" openshell gateway destroy -g "$gateway_name"
  gateway_json="$(HOME="$job_home" openshell gateway list -o json)"
  gateway_state="$(printf '%s' "$gateway_json" | node -e '
    const fs = require("node:fs");
    const rows = JSON.parse(fs.readFileSync(0, "utf8"));
    if (!Array.isArray(rows)) throw new Error("invalid gateway list");
    process.stdout.write(rows.some((row) => row && row.name === "nemoclaw") ? "present" : "absent");
  ')"
  if [ "$gateway_state" = present ]; then
    echo "The test-owned OpenShell gateway remains" >&2
    exit 1
  fi
fi

stop_recorded_pid "$auth_proxy_pid" ollama-auth-proxy.
stop_recorded_pid "$gateway_pid" openshell-gateway
stop_recorded_pid "$cloudflared_pid" cloudflared

for container in "${sandbox_containers[@]}"; do
  if docker container inspect "$container" >/dev/null 2>&1; then
    docker container rm --force "$container"
  fi
done
if docker container inspect "$gateway_container" >/dev/null 2>&1; then
  docker container rm --force "$gateway_container"
fi
for volume in "${recorded_volumes[@]}"; do
  if docker volume inspect "$volume" >/dev/null 2>&1; then
    docker volume rm "$volume"
  fi
done

if [ -e "$service_directory" ]; then
  rm -rf -- "$service_directory"
fi
if [ -e "$workspace" ]; then
  rm -rf -- "$workspace"
fi

test ! -e "$workspace"
test ! -e "$service_directory"
test -z "$(docker ps -aq \
  --filter label=openshell.ai/managed-by=openshell \
  --filter "label=openshell.ai/sandbox-name=$sandbox_name")"
if docker container inspect "$gateway_container" >/dev/null 2>&1; then
  echo "The test-owned gateway container remains" >&2
  exit 1
fi
for volume in "${recorded_volumes[@]}"; do
  if docker volume inspect "$volume" >/dev/null 2>&1; then
    echo "A recorded test-owned Docker volume remains" >&2
    exit 1
  fi
done
for pid in "$auth_proxy_pid" "$gateway_pid" "$cloudflared_pid"; do
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    echo "A recorded test-owned helper process remains" >&2
    exit 1
  fi
done
JETSON_CLEANUP
