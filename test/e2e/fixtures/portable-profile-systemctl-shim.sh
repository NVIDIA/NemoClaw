#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

runtime_dir="${XDG_RUNTIME_DIR:?}"
service_dir="${runtime_dir}/podman"
socket_path="${service_dir}/podman.sock"
pid_file="${runtime_dir}/nemoclaw-podman-service.pid"
log_file="${runtime_dir}/nemoclaw-podman-service.log"

service_is_active() {
  [[ -f "$pid_file" ]] || return 1
  local pid
  pid="$(<"$pid_file")"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  kill -0 "$pid" 2>/dev/null && [[ -S "$socket_path" ]]
}

stop_service() {
  if [[ -f "$pid_file" ]]; then
    local pid
    pid="$(<"$pid_file")"
    if [[ "$pid" =~ ^[1-9][0-9]*$ ]]; then
      kill "$pid" 2>/dev/null || true
    fi
  fi
  rm -f "$pid_file" "$socket_path"
}

start_socket() {
  if service_is_active; then
    return 0
  fi

  stop_service
  install -d -m 700 "$service_dir"
  nohup podman system service --time=0 "unix://$socket_path" >"$log_file" 2>&1 &
  echo $! >"$pid_file"

  for ((attempt = 0; attempt < 100; attempt += 1)); do
    if service_is_active; then
      chmod 660 "$socket_path"
      return 0
    fi
    if ! kill -0 "$(<"$pid_file")" 2>/dev/null; then
      break
    fi
    sleep 0.1
  done

  stop_service
  cat "$log_file" >&2 || true
  return 1
}

case "$*" in
  "--user set-environment NETAVARK_FW=iptables CONTAINERS_CONF="*)
    exit 0
    ;;
  "--user try-restart podman.service")
    if service_is_active; then
      stop_service
      start_socket
    fi
    ;;
  "--user is-active --quiet podman.service")
    if service_is_active; then
      exit 0
    fi
    exit 3
    ;;
  "--user start podman.socket")
    start_socket
    ;;
  *)
    echo "unexpected user-service command: $*" >&2
    exit 64
    ;;
esac
