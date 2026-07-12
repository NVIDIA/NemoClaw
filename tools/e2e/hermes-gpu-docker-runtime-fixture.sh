#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

command_name="${1:-}"
state_dir="${2:-}"
daemon_json="${3:-}"
artifact_dir="${4:-}"

fail() {
  echo "$*" >&2
  return 1
}

wait_for_docker() {
  local failure_message="$1"
  local attempt
  for attempt in $(seq 1 30); do
    if docker info >/dev/null 2>&1; then
      return 0
    fi
    if [ "$attempt" -eq 30 ]; then
      fail "$failure_message"
      return 1
    fi
    sleep 2
  done
}

validate_state_dir() {
  local state_mode=""
  local state_uid=""
  [ -n "$state_dir" ] && [ "$state_dir" != / ] && [ -d "$state_dir" ] || return 1
  read -r state_mode state_uid < <(stat -c '%a %u' "$state_dir") || return 1
  [ "$state_mode" = 700 ] && [ "$state_uid" = "$(id -u)" ]
}

capture_original() {
  local original_runtime=""
  local original_mode=""
  local original_uid=""
  local original_gid=""

  umask 077
  validate_state_dir || fail "Docker fallback state directory must be private and runner-owned"
  [ -n "$daemon_json" ] || fail "Docker daemon path is required"
  [ -n "$artifact_dir" ] || fail "Docker fixture artifact directory is required"
  mkdir -p "$artifact_dir"
  sudo -n true

  original_runtime="$(docker info --format '{{.DefaultRuntime}}')"
  [ -n "$original_runtime" ] || fail "Docker did not report its original default runtime"
  printf '%s\n' "$original_runtime" >"$state_dir/default-runtime.original"
  chmod 0600 "$state_dir/default-runtime.original"
  printf '%s\n' "$original_runtime" >"$artifact_dir/docker-default-runtime-before.txt"

  if sudo test -f "$daemon_json"; then
    read -r original_mode original_uid original_gid < <(sudo stat -c '%a %u %g' "$daemon_json")
    [[ "$original_mode" =~ ^[0-7]{3,4}$ ]] || fail "Docker daemon mode could not be recorded"
    [[ "$original_uid" =~ ^[0-9]+$ ]] || fail "Docker daemon UID could not be recorded"
    [[ "$original_gid" =~ ^[0-9]+$ ]] || fail "Docker daemon GID could not be recorded"
    printf '%s %s %s\n' "$original_mode" "$original_uid" "$original_gid" \
      >"$state_dir/daemon.json.metadata"
    chmod 0600 "$state_dir/daemon.json.metadata"
    install -m 0600 /dev/null "$state_dir/daemon.json.original"
    # The runner-owned redirection is intentional; sudo is needed only to read
    # the root-owned source while the private backup remains runner-owned.
    # shellcheck disable=SC2024
    sudo cat "$daemon_json" >"$state_dir/daemon.json.original"
    chmod 0600 "$state_dir/daemon.json.original"
  elif sudo test -e "$daemon_json"; then
    fail "$daemon_json exists but is not a regular file"
  else
    install -m 0600 /dev/null "$state_dir/daemon.json.absent"
    printf '{}\n' >"$state_dir/daemon.json.original"
    chmod 0600 "$state_dir/daemon.json.original"
  fi

  install -m 0600 /dev/null "$state_dir/capture.complete"
}

select_runc() {
  local original_runtime=""
  local selected_runtime=""

  umask 077
  validate_state_dir || fail "Docker fallback state directory must be private and runner-owned"
  [ -f "$state_dir/capture.complete" ] || fail "Docker fallback snapshot is incomplete"
  original_runtime="$(cat "$state_dir/default-runtime.original")"
  if [ "$original_runtime" != runc ]; then
    node - "$state_dir/daemon.json.original" "$state_dir/daemon.json.runc" <<'NODE'
const fs = require("node:fs");
const [inputPath, outputPath] = process.argv.slice(2);
const source = fs.readFileSync(inputPath, "utf8").trim();
const config = source ? JSON.parse(source) : {};
if (config === null || Array.isArray(config) || typeof config !== "object") {
  throw new Error("Docker daemon.json must contain a top-level object");
}
config["default-runtime"] = "runc";
fs.writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
NODE
    chmod 0600 "$state_dir/daemon.json.runc"

    # Mark the host mutation before it begins so either cleanup path knows that
    # exact restoration and a daemon restart are mandatory after cancellation.
    install -m 0600 /dev/null "$state_dir/default-runtime.modified"
    sudo install -m 0600 "$state_dir/daemon.json.runc" "$daemon_json"
    sudo systemctl restart docker
    wait_for_docker "Docker did not recover after selecting the runc default runtime"
  fi

  selected_runtime="$(docker info --format '{{.DefaultRuntime}}')"
  [ "$selected_runtime" = runc ] || fail "Docker did not select the runc default runtime"
  docker info --format '{{json .Runtimes}}' | grep -q 'nvidia' \
    || fail "Docker no longer reports the nvidia runtime"
  printf '%s\n' "$selected_runtime" >"$artifact_dir/docker-default-runtime-during.txt"
}

restore_original() {
  local restore_failed=0
  local original_runtime=""
  local restored_runtime=""
  local original_mode=""
  local original_uid=""
  local original_gid=""
  local restored_mode=""
  local restored_uid=""
  local restored_gid=""

  set +e
  if ! validate_state_dir; then
    restore_failed=1
  elif [ -f "$state_dir/default-runtime.modified" ]; then
    if [ ! -f "$state_dir/capture.complete" ]; then
      restore_failed=1
    elif [ -f "$state_dir/daemon.json.absent" ]; then
      sudo rm -f "$daemon_json" || restore_failed=1
    else
      read -r original_mode original_uid original_gid \
        <"$state_dir/daemon.json.metadata" || restore_failed=1
      [[ "$original_mode" =~ ^[0-7]{3,4}$ ]] || restore_failed=1
      [[ "$original_uid" =~ ^[0-9]+$ ]] || restore_failed=1
      [[ "$original_gid" =~ ^[0-9]+$ ]] || restore_failed=1
      [ "$(stat -c '%a' "$state_dir/daemon.json.original" 2>/dev/null)" = 600 ] || restore_failed=1
      if [ "$restore_failed" -eq 0 ]; then
        sudo install -m "$original_mode" "$state_dir/daemon.json.original" "$daemon_json" \
          || restore_failed=1
        sudo chown "$original_uid:$original_gid" "$daemon_json" || restore_failed=1
        sudo chmod "$original_mode" "$daemon_json" || restore_failed=1
      fi
    fi

    # Restart even when a preceding restore operation failed. This is best-effort
    # recovery; the verification below still refuses to report success.
    sudo systemctl restart docker || restore_failed=1
    wait_for_docker "Docker did not recover while restoring its original default runtime" \
      || restore_failed=1
  fi

  if [ -f "$state_dir/capture.complete" ]; then
    original_runtime="$(cat "$state_dir/default-runtime.original")" || restore_failed=1
    restored_runtime="$(docker info --format '{{.DefaultRuntime}}')" || restore_failed=1
    if [ -z "$original_runtime" ] || [ "$restored_runtime" != "$original_runtime" ]; then
      echo "Docker default runtime was not restored: expected ${original_runtime:-<missing>}, got ${restored_runtime:-<missing>}" >&2
      restore_failed=1
    fi

    if [ -f "$state_dir/daemon.json.absent" ]; then
      sudo test ! -e "$daemon_json" || restore_failed=1
    else
      sudo cmp -s "$state_dir/daemon.json.original" "$daemon_json" || restore_failed=1
      read -r original_mode original_uid original_gid \
        <"$state_dir/daemon.json.metadata" || restore_failed=1
      read -r restored_mode restored_uid restored_gid \
        < <(sudo stat -c '%a %u %g' "$daemon_json") || restore_failed=1
      if [ "$restored_mode $restored_uid $restored_gid" != \
        "$original_mode $original_uid $original_gid" ]; then
        echo "Docker daemon metadata was not restored" >&2
        restore_failed=1
      fi
    fi
  elif [ -f "$state_dir/default-runtime.modified" ]; then
    restore_failed=1
  fi

  if [ -n "$restored_runtime" ] && [ -n "$artifact_dir" ]; then
    mkdir -p "$artifact_dir" || restore_failed=1
    printf '%s\n' "$restored_runtime" \
      >"$artifact_dir/docker-default-runtime-restored.txt" || restore_failed=1
  fi

  # The snapshot may contain registry/proxy credentials. Remove it regardless of
  # whether restoration or verification succeeded, but preserve the failing exit.
  rm -rf -- "$state_dir" || restore_failed=1
  if [ "$restore_failed" -ne 0 ]; then
    fail "Failed to prove restoration of the Docker daemon after the fallback fixture"
    return 1
  fi
  return 0
}

case "$command_name" in
  capture)
    capture_original
    ;;
  select-runc)
    select_runc
    ;;
  restore)
    if [ ! -e "$state_dir" ]; then
      exit 0
    fi
    restore_original
    ;;
  *)
    fail "usage: $0 {capture|select-runc|restore} STATE_DIR DAEMON_JSON ARTIFACT_DIR"
    exit 2
    ;;
esac
