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

mapfile -t lock_lines <"$lock_file"
if [ "${#lock_lines[@]}" -ne 1 ]; then
  echo "Jetson cleanup lock contains trailing data" >&2
  exit 1
fi
job_id="${lock_lines[0]}"
if ! [[ "$job_id" =~ ^[a-f0-9]{64}$ ]]; then
  echo "Jetson cleanup lock contains an invalid job ID" >&2
  exit 1
fi

ssh_args=(
  -F /dev/null
  -T
  -o BatchMode=yes
  -o ConnectTimeout=15
  -o IdentitiesOnly=yes
  -o ServerAliveCountMax=2
  -o ServerAliveInterval=15
  -o StrictHostKeyChecking=yes
  -o "UserKnownHostsFile=$known_hosts_file"
  -i "$identity_file"
)

discovery_output="$(
  ssh "${ssh_args[@]}" "$destination" bash -s -- "$job_id" <<'JETSON_DISCOVERY'
set -euo pipefail

job_id="$1"
[[ "$job_id" =~ ^[a-f0-9]{64}$ ]]

workspace_root=/var/tmp/nemoclaw-jetson-e2e
workspace="$workspace_root/$job_id"
job_home="$workspace/home"
sandbox_name=e2e-jetson-nvmap
gateway_container=openshell-cluster-nemoclaw
gateway_volume=openshell-cluster-nemoclaw
image_repository=nemoclaw-sandbox-local
service_directory="/tmp/nemoclaw-services-$sandbox_name"

require_plain_directory_if_present() {
  local directory="$1"
  if [ -L "$directory" ] || { [ -e "$directory" ] && [ ! -d "$directory" ]; }; then
    echo "Refusing an untrusted cleanup directory: $directory" >&2
    exit 1
  fi
}

require_plain_directory_if_present "$workspace_root"
require_plain_directory_if_present "$workspace"
require_plain_directory_if_present "$job_home"
require_plain_directory_if_present "$job_home/.nemoclaw"
require_plain_directory_if_present "$job_home/.local"
require_plain_directory_if_present "$job_home/.local/state"
require_plain_directory_if_present "$job_home/.local/state/nemoclaw"
require_plain_directory_if_present "$job_home/.local/state/nemoclaw/openshell-docker-gateway"
require_plain_directory_if_present "$service_directory"

recorded_volumes=()
record_volume() {
  local volume="$1" recorded
  [[ "$volume" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$ ]] || {
    echo "Refusing an invalid recorded Docker volume name" >&2
    exit 1
  }
  for recorded in "${recorded_volumes[@]}"; do
    [ "$recorded" = "$volume" ] && return 0
  done
  recorded_volumes+=("$volume")
}

record_container_volumes() {
  local container="$1" volume volume_output
  volume_output="$(
    docker container inspect --format \
      '{{range .Mounts}}{{if eq .Type "volume"}}{{println .Name}}{{end}}{{end}}' \
      "$container"
  )" || {
    echo "Unable to inspect a test-owned Docker container" >&2
    exit 1
  }
  while IFS= read -r volume; do
    [ -n "$volume" ] || continue
    record_volume "$volume"
  done <<<"$volume_output"
}

sandbox_container_output="$(
  docker ps -aq \
    --filter label=openshell.ai/managed-by=openshell \
    --filter "label=openshell.ai/sandbox-name=$sandbox_name"
)" || {
  echo "Unable to list test-owned Docker containers" >&2
  exit 1
}
sandbox_containers=()
if [ -n "$sandbox_container_output" ]; then
  mapfile -t sandbox_containers <<<"$sandbox_container_output"
fi
for container in "${sandbox_containers[@]}"; do
  [[ "$container" =~ ^[a-f0-9]{12,64}$ ]] || {
    echo "Refusing an invalid recorded Docker container ID" >&2
    exit 1
  }
  container_image="$(docker container inspect --format '{{.Config.Image}}' "$container")"
  case "$container_image" in
    "$image_repository:$sandbox_name-"*) ;;
    *) echo "Refusing a sandbox container whose image is not test-owned" >&2; exit 1 ;;
  esac
  record_container_volumes "$container"
done
container_rows="$(docker container ls --all --no-trunc --format '{{.ID}}\t{{.Names}}')" || {
  echo "Unable to list Docker containers" >&2
  exit 1
}
gateway_container_ids="$(
  printf '%s\n' "$container_rows" | awk -F '\t' -v name="$gateway_container" '$2 == name { print $1 }'
)"
if [ -n "$gateway_container_ids" ]; then
  if [[ "$gateway_container_ids" == *$'\n'* ]] || ! [[ "$gateway_container_ids" =~ ^[a-f0-9]{12,64}$ ]]; then
    echo "Refusing an ambiguous test-owned gateway container" >&2
    exit 1
  fi
  record_container_volumes "$gateway_container_ids"
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

read_proc_uid() {
  awk '/^Uid:/ { print $2; found = 1; exit } END { exit found ? 0 : 1 }' "$1/status" 2>/dev/null
}

read_proc_environment() {
  dd if="$1/environ" status=none 2>/dev/null | tr '\000' '\n'
}

read_proc_command() {
  dd if="$1/cmdline" status=none 2>/dev/null | tr '\000' ' '
}

handle_proc_read_failure() {
  local proc_dir="$1" field="$2" process_uid directory_uid
  [ -d "$proc_dir" ] || return 0
  if process_uid="$(read_proc_uid "$proc_dir")"; then
    [ "$process_uid" = "$(id -u)" ] || return 0
  else
    [ -d "$proc_dir" ] || return 0
    if ! directory_uid="$(stat -c %u "$proc_dir" 2>/dev/null)"; then
      [ -d "$proc_dir" ] || return 0
      echo "Unable to verify the owner of a live process after a failed $field read" >&2
      exit 1
    fi
    [ "$directory_uid" = "$(id -u)" ] || return 0
  fi
  echo "Unable to inspect $field for a live same-user process" >&2
  exit 1
}

validate_recorded_pid() {
  local pid="$1" marker="$2"
  [ -n "$pid" ] || return 0
  kill -0 "$pid" 2>/dev/null || return 0
  local process_uid cmdline environment proc_dir="/proc/$pid"
  if ! process_uid="$(read_proc_uid "$proc_dir")"; then
    kill -0 "$pid" 2>/dev/null || return 0
    echo "Refusing to record a live process whose owner cannot be verified" >&2
    exit 1
  fi
  [ "$process_uid" = "$(id -u)" ] || {
    echo "Refusing to record a process owned by another user" >&2
    exit 1
  }
  if ! cmdline="$(read_proc_command "$proc_dir")"; then
    kill -0 "$pid" 2>/dev/null || return 0
    echo "Refusing to record a live process whose command cannot be verified" >&2
    exit 1
  fi
  case "$cmdline" in
    *"$marker"*) ;;
    *) echo "Refusing to record a PID with an unexpected command" >&2; exit 1 ;;
  esac
  if ! environment="$(read_proc_environment "$proc_dir")"; then
    kill -0 "$pid" 2>/dev/null || return 0
    echo "Refusing to record a live process whose environment cannot be verified" >&2
    exit 1
  fi
  if ! printf '%s\n' "$environment" | grep -Fqx "HOME=$job_home"; then
    echo "Refusing to record a process outside the job home" >&2
    exit 1
  fi
}

auth_proxy_pid="$(read_recorded_pid "$job_home/.nemoclaw/ollama-auth-proxy.pid")"
gateway_pid="$(read_recorded_pid "$job_home/.local/state/nemoclaw/openshell-docker-gateway/openshell-gateway.pid")"
cloudflared_pid="$(read_recorded_pid "$service_directory/cloudflared.pid")"
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
for proc_dir in /proc/[0-9]*; do
  if ! process_uid="$(read_proc_uid "$proc_dir")"; then
    handle_proc_read_failure "$proc_dir" owner
    continue
  fi
  [ "$process_uid" = "$(id -u)" ] || continue
  if ! environment="$(read_proc_environment "$proc_dir")"; then
    handle_proc_read_failure "$proc_dir" environment
    continue
  fi
  printf '%s\n' "$environment" | grep -Fqx "HOME=$job_home" || continue
  if ! cmdline="$(read_proc_command "$proc_dir")"; then
    handle_proc_read_failure "$proc_dir" command
    continue
  fi
  case "$cmdline" in
    *ollama-auth-proxy.* | *openshell-gateway* | *openshell-forward* | *openshell\ forward* | *cloudflared*)
      printf 'processId\t%s\n' "${proc_dir##*/}"
      ;;
  esac
done
printf '%s\n' nemoclaw-cleanup-evidence-v1-end
JETSON_DISCOVERY
)"

canonical_evidence="$(
  # shellcheck disable=SC2016
  printf '%s\n' "$discovery_output" | /usr/bin/node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const stateDirectory = process.argv[1];
    const jobId = process.argv[2];
    if (!/^[a-f0-9]{64}$/.test(jobId)) process.exit(1);
    const begin = "nemoclaw-cleanup-evidence-v1-begin";
    const end = "nemoclaw-cleanup-evidence-v1-end";
    const lines = fs.readFileSync(0, "utf8").replace(/\r/g, "").trimEnd().split("\n");
    const beginIndex = lines.indexOf(begin);
    const endIndex = lines.indexOf(end);
    if (beginIndex < 0 || endIndex < 0 || beginIndex !== lines.lastIndexOf(begin) || endIndex !== lines.lastIndexOf(end) || beginIndex >= endIndex) process.exit(1);
    const discovered = { schemaVersion: 1, volumes: [], processIds: [] };
    for (const line of lines.slice(beginIndex + 1, endIndex)) {
      const fields = line.split("\t");
      if (fields.length !== 2) process.exit(1);
      if (fields[0] === "volume" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/.test(fields[1])) discovered.volumes.push(fields[1]);
      else if (fields[0] === "processId" && /^[1-9][0-9]*$/.test(fields[1]) && Number.isSafeInteger(Number(fields[1]))) discovered.processIds.push(Number(fields[1]));
      else process.exit(1);
    }
    const cleanupFile = path.join(stateDirectory, `${jobId}.cleanup.json`);
    let previous = { schemaVersion: 1, volumes: [], processIds: [] };
    if (fs.existsSync(cleanupFile)) {
      const metadata = fs.lstatSync(cleanupFile);
      if (!metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0 || metadata.size > 64 * 1024) process.exit(1);
      previous = JSON.parse(fs.readFileSync(cleanupFile, "utf8"));
    }
    const validate = (record) => {
      const keys = Object.keys(record).sort();
      if (JSON.stringify(keys) !== JSON.stringify(["processIds", "schemaVersion", "volumes"]) || record.schemaVersion !== 1 || !Array.isArray(record.volumes) || !Array.isArray(record.processIds)) process.exit(1);
      if (!record.volumes.every((value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/.test(value))) process.exit(1);
      if (!record.processIds.every((value) => Number.isSafeInteger(value) && value > 0)) process.exit(1);
    };
    validate(previous);
    validate(discovered);
    const merged = {
      schemaVersion: 1,
      volumes: [...new Set([...previous.volumes, ...discovered.volumes])].sort(),
      processIds: [...new Set([...previous.processIds, ...discovered.processIds])].sort((a, b) => a - b),
    };
    const serialized = `${JSON.stringify(merged)}\n`;
    if (Buffer.byteLength(serialized) > 64 * 1024) process.exit(1);
    const temporaryFile = path.join(stateDirectory, `.${jobId}.${process.pid}.cleanup.tmp`);
    let descriptor;
    try {
      descriptor = fs.openSync(temporaryFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
      fs.fchmodSync(descriptor, 0o600);
      fs.writeFileSync(descriptor, serialized, "utf8");
      fs.fsyncSync(descriptor);
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
    fs.renameSync(temporaryFile, cleanupFile);
    const directoryDescriptor = fs.openSync(stateDirectory, fs.constants.O_RDONLY);
    try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
    process.stdout.write(serialized);
  ' "$state_directory" "$job_id"
)"

cleanup_evidence_base64="$(printf '%s\n' "$canonical_evidence" | base64 --wrap=0)"
ssh "${ssh_args[@]}" "$destination" bash -s -- "$job_id" "$cleanup_evidence_base64" <<'JETSON_CLEANUP'
set -euo pipefail

job_id="$1"
cleanup_evidence_base64="$2"
[[ "$job_id" =~ ^[a-f0-9]{64}$ ]]

workspace_root=/var/tmp/nemoclaw-jetson-e2e
workspace="$workspace_root/$job_id"
job_home="$workspace/home"
sandbox_name=e2e-jetson-nvmap
gateway_container=openshell-cluster-nemoclaw
image_repository=nemoclaw-sandbox-local
service_directory="/tmp/nemoclaw-services-$sandbox_name"

require_plain_directory_if_present() {
  local directory="$1"
  if [ -L "$directory" ] || { [ -e "$directory" ] && [ ! -d "$directory" ]; }; then
    echo "Refusing an untrusted cleanup directory: $directory" >&2
    exit 1
  fi
}

require_plain_directory_if_present "$workspace_root"
require_plain_directory_if_present "$workspace"
require_plain_directory_if_present "$job_home"
require_plain_directory_if_present "$job_home/.nemoclaw"
require_plain_directory_if_present "$job_home/.local"
require_plain_directory_if_present "$job_home/.local/state"
require_plain_directory_if_present "$job_home/.local/state/nemoclaw"
require_plain_directory_if_present "$job_home/.local/state/nemoclaw/openshell-docker-gateway"
require_plain_directory_if_present "$service_directory"

cleanup_rows="$(
  printf '%s' "$cleanup_evidence_base64" | base64 --decode | node -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(0, "utf8"));
    const keys = Object.keys(value).sort();
    if (JSON.stringify(keys) !== JSON.stringify(["processIds", "schemaVersion", "volumes"]) || value.schemaVersion !== 1 || !Array.isArray(value.volumes) || !Array.isArray(value.processIds)) process.exit(1);
    for (const volume of value.volumes) {
      if (typeof volume !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/.test(volume)) process.exit(1);
      process.stdout.write("volume\t" + volume + "\n");
    }
    for (const pid of value.processIds) {
      if (!Number.isSafeInteger(pid) || pid < 1) process.exit(1);
      process.stdout.write("processId\t" + pid + "\n");
    }
  '
)"
recorded_volumes=()
recorded_process_ids=()
if [ -n "$cleanup_rows" ]; then
  while IFS=$'\t' read -r kind identity; do
    case "$kind" in
      volume) recorded_volumes+=("$identity") ;;
      processId) recorded_process_ids+=("$identity") ;;
      *) exit 1 ;;
    esac
  done <<<"$cleanup_rows"
fi

read_proc_uid() {
  awk '/^Uid:/ { print $2; found = 1; exit } END { exit found ? 0 : 1 }' "$1/status" 2>/dev/null
}

read_proc_environment() {
  dd if="$1/environ" status=none 2>/dev/null | tr '\000' '\n'
}

read_proc_command() {
  dd if="$1/cmdline" status=none 2>/dev/null | tr '\000' ' '
}

handle_proc_read_failure() {
  local proc_dir="$1" field="$2" process_uid directory_uid
  [ -d "$proc_dir" ] || return 0
  if process_uid="$(read_proc_uid "$proc_dir")"; then
    [ "$process_uid" = "$(id -u)" ] || return 0
  else
    [ -d "$proc_dir" ] || return 0
    if ! directory_uid="$(stat -c %u "$proc_dir" 2>/dev/null)"; then
      [ -d "$proc_dir" ] || return 0
      echo "Unable to verify the owner of a live process after a failed $field read" >&2
      exit 1
    fi
    [ "$directory_uid" = "$(id -u)" ] || return 0
  fi
  echo "Unable to inspect $field for a live same-user process" >&2
  exit 1
}

stop_recorded_pid() {
  local pid="$1"
  kill -0 "$pid" 2>/dev/null || return 0
  local process_uid cmdline environment proc_dir="/proc/$pid"
  if ! process_uid="$(read_proc_uid "$proc_dir")"; then
    kill -0 "$pid" 2>/dev/null || return 0
    echo "Refusing to stop a live process whose owner cannot be verified" >&2
    exit 1
  fi
  [ "$process_uid" = "$(id -u)" ] || {
    echo "Refusing to stop a process owned by another user" >&2
    exit 1
  }
  if ! cmdline="$(read_proc_command "$proc_dir")"; then
    kill -0 "$pid" 2>/dev/null || return 0
    echo "Refusing to stop a live process whose command cannot be verified" >&2
    exit 1
  fi
  case "$cmdline" in
    *ollama-auth-proxy.* | *openshell-gateway* | *openshell-forward* | *openshell\ forward* | *cloudflared*) ;;
    *) echo "Refusing to stop a recorded PID with an unexpected command" >&2; exit 1 ;;
  esac
  if ! environment="$(read_proc_environment "$proc_dir")"; then
    kill -0 "$pid" 2>/dev/null || return 0
    echo "Refusing to stop a live process whose environment cannot be verified" >&2
    exit 1
  fi
  if ! printf '%s\n' "$environment" | grep -Fqx "HOME=$job_home"; then
    echo "Refusing to stop a process outside the job home" >&2
    exit 1
  fi
  if ! kill "$pid" 2>/dev/null; then
    kill -0 "$pid" 2>/dev/null || return 0
    echo "Unable to stop a validated cleanup process" >&2
    exit 1
  fi
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

for pid in "${recorded_process_ids[@]}"; do
  stop_recorded_pid "$pid"
done

sandbox_container_output="$(
  docker ps -aq \
    --filter label=openshell.ai/managed-by=openshell \
    --filter "label=openshell.ai/sandbox-name=$sandbox_name"
)" || {
  echo "Unable to list test-owned Docker containers" >&2
  exit 1
}
sandbox_containers=()
if [ -n "$sandbox_container_output" ]; then
  mapfile -t sandbox_containers <<<"$sandbox_container_output"
fi
for container in "${sandbox_containers[@]}"; do
  [[ "$container" =~ ^[a-f0-9]{12,64}$ ]] || exit 1
  container_image="$(docker container inspect --format '{{.Config.Image}}' "$container")"
  case "$container_image" in
    "$image_repository:$sandbox_name-"*) ;;
    *) echo "Refusing a sandbox container whose image is not test-owned" >&2; exit 1 ;;
  esac
  docker container rm --force "$container"
done
container_rows="$(docker container ls --all --no-trunc --format '{{.ID}}\t{{.Names}}')" || {
  echo "Unable to list Docker containers" >&2
  exit 1
}
gateway_container_ids="$(
  printf '%s\n' "$container_rows" | awk -F '\t' -v name="$gateway_container" '$2 == name { print $1 }'
)"
if [ -n "$gateway_container_ids" ]; then
  if [[ "$gateway_container_ids" == *$'\n'* ]] || ! [[ "$gateway_container_ids" =~ ^[a-f0-9]{12,64}$ ]]; then
    echo "Refusing an ambiguous test-owned gateway container" >&2
    exit 1
  fi
  docker container rm --force "$gateway_container_ids"
fi
volume_names="$(docker volume ls --format '{{.Name}}')" || {
  echo "Unable to list Docker volumes" >&2
  exit 1
}
for volume in "${recorded_volumes[@]}"; do
  if printf '%s\n' "$volume_names" | grep -Fqx "$volume"; then
    docker volume rm "$volume"
  fi
done

list_test_owned_images() {
  local image_rows repository tag
  image_rows="$(docker image ls "$image_repository" --format '{{.Repository}}\t{{.Tag}}')" || {
    echo "Unable to list test-owned Docker images" >&2
    return 1
  }
  while IFS=$'\t' read -r repository tag; do
    [ -n "$repository" ] || continue
    if [ "$repository" = "$image_repository" ] && [[ "$tag" =~ ^e2e-jetson-nvmap-[a-z0-9_.-]+$ ]]; then
      printf '%s:%s\n' "$repository" "$tag"
    fi
  done <<<"$image_rows"
}

job_images_output="$(list_test_owned_images)"
job_images=()
if [ -n "$job_images_output" ]; then
  mapfile -t job_images <<<"$job_images_output"
fi
for image in "${job_images[@]}"; do
  docker image rm "$image"
done

if [ -e "$service_directory" ]; then
  rm -rf -- "$service_directory"
fi
if [ -e "$workspace" ]; then
  rm -rf -- "$workspace"
fi

test ! -e "$workspace"
test ! -e "$service_directory"
sandbox_container_output="$(docker ps -aq \
  --filter label=openshell.ai/managed-by=openshell \
  --filter "label=openshell.ai/sandbox-name=$sandbox_name")" || {
  echo "Unable to verify test-owned Docker container absence" >&2
  exit 1
}
if [ -n "$sandbox_container_output" ]; then
  echo "A test-owned sandbox container remains" >&2
  exit 1
fi
container_rows="$(docker container ls --all --no-trunc --format '{{.ID}}\t{{.Names}}')" || {
  echo "Unable to verify Docker container absence" >&2
  exit 1
}
if printf '%s\n' "$container_rows" | awk -F '\t' -v name="$gateway_container" '$2 == name { found = 1 } END { exit found ? 0 : 1 }'; then
  echo "The test-owned gateway container remains" >&2
  exit 1
fi
volume_names="$(docker volume ls --format '{{.Name}}')" || {
  echo "Unable to verify Docker volume absence" >&2
  exit 1
}
for volume in "${recorded_volumes[@]}"; do
  if printf '%s\n' "$volume_names" | grep -Fqx "$volume"; then
    echo "A recorded test-owned Docker volume remains" >&2
    exit 1
  fi
done
for pid in "${recorded_process_ids[@]}"; do
  if kill -0 "$pid" 2>/dev/null; then
    echo "A recorded test-owned helper process remains" >&2
    exit 1
  fi
done
for proc_dir in /proc/[0-9]*; do
  if ! process_uid="$(read_proc_uid "$proc_dir")"; then
    handle_proc_read_failure "$proc_dir" owner
    continue
  fi
  [ "$process_uid" = "$(id -u)" ] || continue
  if ! environment="$(read_proc_environment "$proc_dir")"; then
    handle_proc_read_failure "$proc_dir" environment
    continue
  fi
  printf '%s\n' "$environment" | grep -Fqx "HOME=$job_home" || continue
  if ! cmdline="$(read_proc_command "$proc_dir")"; then
    handle_proc_read_failure "$proc_dir" command
    continue
  fi
  case "$cmdline" in
    *ollama-auth-proxy.* | *openshell-gateway* | *openshell-forward* | *openshell\ forward* | *cloudflared*)
      echo "A job-owned helper process remains" >&2
      exit 1
      ;;
  esac
done
remaining_job_images="$(list_test_owned_images)" || exit 1
if [ -n "$remaining_job_images" ]; then
  echo "A test-owned Jetson image remains" >&2
  exit 1
fi
for openshell_component in openshell openshell-gateway openshell-sandbox; do
  if PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    command -v "$openshell_component" >/dev/null 2>&1; then
    echo "A host-level OpenShell binary remains after cleanup" >&2
    exit 1
  fi
  for host_bin in "/usr/local/bin/$openshell_component" "/usr/bin/$openshell_component" "$HOME/.local/bin/$openshell_component"; do
    if [ -e "$host_bin" ] || [ -L "$host_bin" ]; then
      echo "A host-level OpenShell binary remains after cleanup" >&2
      exit 1
    fi
  done
done
JETSON_CLEANUP

printf '%s\n' nemoclaw-cleanup-evidence-v1-begin
# shellcheck disable=SC2016
printf '%s\n' "$canonical_evidence" | /usr/bin/node -e '
  const fs = require("node:fs");
  const value = JSON.parse(fs.readFileSync(0, "utf8"));
  for (const volume of value.volumes) console.log(`volume\t${volume}`);
  for (const pid of value.processIds) console.log(`processId\t${pid}`);
'
printf '%s\n' nemoclaw-cleanup-evidence-v1-end
