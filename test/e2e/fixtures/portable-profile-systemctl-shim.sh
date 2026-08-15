#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

runtime_dir="${XDG_RUNTIME_DIR:?}"
service_dir="${runtime_dir}/podman"
socket_path="${service_dir}/podman.sock"
activator_pid_file="${runtime_dir}/nemoclaw-podman-socket-activator.pid"
service_pid_file="${runtime_dir}/nemoclaw-podman-service.pid"
log_file="${runtime_dir}/nemoclaw-podman-service.log"

pid_is_active() {
  local pid_file="$1"
  [[ -f "$pid_file" ]] || return 1
  local pid
  pid="$(<"$pid_file")"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  kill -0 "$pid" 2>/dev/null
}

service_is_active() {
  pid_is_active "$service_pid_file" && [[ -S "$socket_path" ]]
}

socket_is_ready() {
  [[ -S "$socket_path" ]] \
    && { service_is_active || pid_is_active "$activator_pid_file"; }
}

stop_pid() {
  local pid_file="$1"
  [[ -f "$pid_file" ]] || return 0
  local pid
  pid="$(<"$pid_file")"
  if [[ "$pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    for ((attempt = 0; attempt < 100; attempt += 1)); do
      if ! kill -0 "$pid" 2>/dev/null; then
        break
      fi
      sleep 0.05
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
  fi
  rm -f "$pid_file"
}

stop_service() {
  stop_pid "$service_pid_file"
  rm -f "$socket_path"
}

stop_runtime() {
  stop_service
  stop_pid "$activator_pid_file"
  rm -f "$socket_path"
}

wait_for_service() {
  for ((attempt = 0; attempt < 100; attempt += 1)); do
    if service_is_active; then
      chmod 660 "$socket_path"
      return 0
    fi
    if ! pid_is_active "$service_pid_file"; then
      break
    fi
    sleep 0.1
  done

  stop_service
  cat "$log_file" >&2 || true
  return 1
}

start_service() {
  stop_service
  install -d -m 700 "$service_dir"
  nohup podman system service --time=0 "unix://$socket_path" >>"$log_file" 2>&1 &
  echo $! >"$service_pid_file"
  wait_for_service
}

start_socket() {
  if socket_is_ready; then
    return 0
  fi

  stop_runtime
  install -d -m 700 "$service_dir"
  NEMOCLAW_PODMAN_LOG_FILE="$log_file"
  export NEMOCLAW_PODMAN_LOG_FILE
  nohup node - "$socket_path" "$service_pid_file" "$activator_pid_file" \
    >>"$log_file" 2>&1 <<'NODE' &
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");

const [socketPath, servicePidFile, activatorPidFile] = process.argv.slice(2);
const logFile = process.env.NEMOCLAW_PODMAN_LOG_FILE;
let activationStarted = false;

function removeActivatorState() {
  fs.rmSync(activatorPidFile, { force: true });
}

function serviceIsRunning(service) {
  return service.exitCode === null && service.signalCode === null;
}

async function activate(client, server) {
  activationStarted = true;
  client.destroy();
  server.close();
  fs.rmSync(socketPath, { force: true });
  const output = fs.openSync(logFile, "a");
  const service = spawn("podman", ["system", "service", "--time=0", `unix://${socketPath}`], {
    detached: true,
    stdio: ["ignore", output, output],
  });
  fs.closeSync(output);
  if (!service.pid) throw new Error("Podman service did not report a process ID.");
  fs.writeFileSync(servicePidFile, `${service.pid}\n`, { mode: 0o600 });
  service.unref();

  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if (fs.statSync(socketPath).isSocket()) {
        fs.chmodSync(socketPath, 0o660);
        removeActivatorState();
        process.exit(0);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (!serviceIsRunning(service)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  if (serviceIsRunning(service)) service.kill("SIGTERM");
  fs.rmSync(servicePidFile, { force: true });
  removeActivatorState();
  throw new Error("Podman service did not create its activation socket.");
}

const server = net.createServer((client) => {
  if (activationStarted) {
    client.destroy();
    return;
  }
  void activate(client, server).catch((error) => {
    console.error(error);
    process.exit(1);
  });
});

server.listen(socketPath, () => fs.chmodSync(socketPath, 0o660));
const stop = () => {
  server.close();
  fs.rmSync(socketPath, { force: true });
  removeActivatorState();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
NODE
  echo $! >"$activator_pid_file"

  for ((attempt = 0; attempt < 100; attempt += 1)); do
    if socket_is_ready; then
      return 0
    fi
    if ! pid_is_active "$activator_pid_file"; then
      break
    fi
    sleep 0.1
  done

  stop_runtime
  cat "$log_file" >&2 || true
  return 1
}

if [[ "$#" -eq 4 &&
  "$1" == "--user" &&
  "$2" == "set-environment" &&
  "$3" == "NETAVARK_FW=iptables" &&
  "$4" == CONTAINERS_CONF=?* ]]; then
  exit 0
fi

if [[ "$#" -eq 3 &&
  "$1" == "--user" &&
  "$2" == "try-restart" &&
  "$3" == "podman.service" ]]; then
  if service_is_active; then
    start_service
  fi
  exit 0
fi

if [[ "$#" -eq 4 &&
  "$1" == "--user" &&
  "$2" == "is-active" &&
  "$3" == "--quiet" &&
  "$4" == "podman.service" ]]; then
  if service_is_active; then
    exit 0
  fi
  exit 3
fi

if [[ "$#" -eq 3 &&
  "$1" == "--user" &&
  "$2" == "start" &&
  "$3" == "podman.socket" ]]; then
  start_socket
  exit 0
fi

if [[ "$#" -eq 4 &&
  "$1" == "--user" &&
  "$2" == "enable" &&
  "$3" == "--now" &&
  "$4" == "podman.socket" ]]; then
  start_socket
  exit 0
fi

echo "unexpected user-service command: $*" >&2
exit 64
