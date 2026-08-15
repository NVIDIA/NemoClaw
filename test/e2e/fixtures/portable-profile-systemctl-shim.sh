#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

runtime_dir="${XDG_RUNTIME_DIR:?}"
service_dir="${runtime_dir}/podman"
socket_path="${service_dir}/podman.sock"
backend_socket_path="${service_dir}/nemoclaw-podman-service.sock"
activator_pid_file="${runtime_dir}/nemoclaw-podman-socket-activator.pid"
service_pid_file="${runtime_dir}/nemoclaw-podman-service.pid"
log_file="${runtime_dir}/nemoclaw-podman-service.log"
process_identity_env="NEMOCLAW_PORTABLE_PROFILE_PROCESS_ID"
process_identity_failure_role="${NEMOCLAW_PODMAN_IDENTITY_FAILURE_ROLE:-}"
process_identity_failure_record="${NEMOCLAW_PODMAN_IDENTITY_FAILURE_RECORD:-}"

format_ps_start_time() {
  local start_time="$1"
  local -a start_time_fields
  read -r -a start_time_fields <<<"$start_time"
  [[ "${#start_time_fields[@]}" -gt 0 ]] || return 1
  printf 'ps:%s\n' "${start_time_fields[*]}"
}

process_start_time() {
  local pid="$1"
  if [[ -r "/proc/${pid}/stat" ]]; then
    local stat fields
    stat="$(<"/proc/${pid}/stat")"
    stat="${stat##*) }"
    read -r -a fields <<<"$stat"
    [[ "${#fields[@]}" -gt 19 && "${fields[19]}" =~ ^[0-9]+$ ]] || return 1
    printf 'proc:%s\n' "${fields[19]}"
    return 0
  fi
  [[ ! -e /proc/self/stat ]] || return 1

  local start_time
  start_time="$(ps -o lstart= -p "$pid" 2>/dev/null)" || return 1
  format_ps_start_time "$start_time"
}

process_has_identity() {
  local pid="$1"
  local identity="$2"
  local expected="${process_identity_env}=${identity}"
  if [[ -r "/proc/${pid}/environ" ]]; then
    local variable
    while IFS= read -r -d '' variable; do
      [[ "$variable" == "$expected" ]] && return 0
    done <"/proc/${pid}/environ"
    return 1
  fi
  [[ ! -e /proc/self/environ ]] || return 1

  local command_line
  command_line="$(ps eww -p "$pid" -o command= 2>/dev/null)" || return 1
  [[ " ${command_line} " == *" ${expected} "* ]]
}

acquired_process_start_time=""

acquire_process_identity() {
  local pid="$1"
  local identity="$2"
  local current_start_time
  for ((attempt = 0; attempt < 100; attempt += 1)); do
    if current_start_time="$(process_start_time "$pid")" \
      && process_has_identity "$pid" "$identity"; then
      acquired_process_start_time="$current_start_time"
      return 0
    fi
    kill -0 "$pid" 2>/dev/null || return 1
    sleep 0.05
  done
  return 1
}

unrecorded_process_status() {
  local pid="$1"
  local identity="$2"
  local start_time="$3"
  if ! kill -0 "$pid" 2>/dev/null || process_is_zombie "$pid"; then
    return 1
  fi
  local current_start_time
  if [[ -n "$start_time" ]]; then
    if current_start_time="$(process_start_time "$pid")"; then
      if [[ "$current_start_time" != "$start_time" ]]; then
        echo "Portable profile fixture process ${pid} no longer matches its acquired start time." >&2
        return 2
      fi
    elif kill -0 "$pid" 2>/dev/null; then
      echo "Portable profile fixture could not revalidate the start time for process ${pid}." >&2
      return 2
    else
      return 1
    fi
  fi
  if ! process_has_identity "$pid" "$identity"; then
    kill -0 "$pid" 2>/dev/null || return 1
    echo "Portable profile fixture process ${pid} no longer matches its acquired identity." >&2
    return 2
  fi
}

unrecorded_process_matches_acquired_start_time() {
  local pid="$1"
  local start_time="$2"
  [[ -n "$start_time" ]] || return 2
  if ! kill -0 "$pid" 2>/dev/null || process_is_zombie "$pid"; then
    return 1
  fi
  local current_start_time
  if current_start_time="$(process_start_time "$pid")"; then
    :
  elif kill -0 "$pid" 2>/dev/null; then
    return 2
  else
    return 1
  fi
  [[ "$current_start_time" == "$start_time" ]] || return 2
}

unrecorded_process_matches_acquired_identity() {
  local pid="$1"
  local identity="$2"
  local start_time="$3"
  if [[ -n "$start_time" ]]; then
    unrecorded_process_matches_acquired_start_time "$pid" "$start_time"
  else
    unrecorded_process_status "$pid" "$identity" "$start_time"
  fi
}

signal_unrecorded_process() {
  local pid="$1"
  local identity="$2"
  local start_time="$3"
  local signal="$4"
  local status
  if unrecorded_process_status "$pid" "$identity" "$start_time"; then
    :
  else
    status=$?
    return "$status"
  fi
  kill -"$signal" "$pid" 2>/dev/null || {
    kill -0 "$pid" 2>/dev/null && return 2
    return 1
  }
}

stop_unrecorded_process() {
  local pid="$1"
  local identity="$2"
  local start_time="$3"
  local status
  if signal_unrecorded_process "$pid" "$identity" "$start_time" TERM; then
    :
  else
    status=$?
    [[ "$status" -eq 1 ]] && return 0
    return "$status"
  fi
  for ((attempt = 0; attempt < 100; attempt += 1)); do
    if unrecorded_process_matches_acquired_identity "$pid" "$identity" "$start_time"; then
      sleep 0.05
      continue
    fi
    status=$?
    if [[ "$status" -eq 1 ]]; then
      return 0
    fi
    return "$status"
  done

  if signal_unrecorded_process "$pid" "$identity" "$start_time" KILL; then
    :
  else
    status=$?
    [[ "$status" -eq 1 ]] && return 0
    return "$status"
  fi
  for ((attempt = 0; attempt < 100; attempt += 1)); do
    if unrecorded_process_matches_acquired_identity "$pid" "$identity" "$start_time"; then
      sleep 0.05
      continue
    fi
    status=$?
    if [[ "$status" -eq 1 ]]; then
      return 0
    fi
    return "$status"
  done
  echo "Portable profile fixture process ${pid} did not exit." >&2
  return 1
}

process_is_zombie() {
  local pid="$1"
  if [[ -r "/proc/${pid}/stat" ]]; then
    local stat fields
    stat="$(<"/proc/${pid}/stat")"
    stat="${stat##*) }"
    read -r -a fields <<<"$stat"
    [[ "${fields[0]:-}" == Z ]]
    return
  fi
  [[ ! -e /proc/self/stat ]] || return 1

  local process_state
  process_state="$(ps -o stat= -p "$pid" 2>/dev/null)" || return 1
  [[ "$process_state" == Z* ]]
}

recorded_pid=""
recorded_start_time=""
recorded_identity=""

pid_is_safe_integer_text() {
  local pid="$1"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ "${#pid}" -lt 16 ||
    ("${#pid}" -eq 16 && "$pid" -lt 9007199254740992) ]]
}

read_pid_record() {
  local pid_file="$1"
  local role="$2"
  [[ -f "$pid_file" ]] || return 1
  local value extra
  value="$(<"$pid_file")"
  IFS=$'\t' read -r recorded_pid recorded_start_time recorded_identity extra <<<"$value"
  if ! pid_is_safe_integer_text "$recorded_pid" \
    || [[ -n "${extra:-}" ||
      "$value" != "${recorded_pid}"$'\t'"${recorded_start_time}"$'\t'"${recorded_identity}" ||
      ! "$recorded_start_time" =~ ^(proc:[0-9]+|ps:.+)$ ||
      ! "$recorded_identity" =~ ^${role}:[0-9a-f]{32}$ ]]; then
    echo "Portable profile fixture PID file ${pid_file} is invalid." >&2
    return 2
  fi
}

recorded_process_status() {
  local pid_file="$1"
  local role="$2"
  local status
  if read_pid_record "$pid_file" "$role"; then
    :
  else
    status=$?
    return "$status"
  fi
  if ! kill -0 "$recorded_pid" 2>/dev/null; then
    return 1
  fi
  process_is_zombie "$recorded_pid" && return 1

  local current_start_time
  if current_start_time="$(process_start_time "$recorded_pid")"; then
    :
  elif kill -0 "$recorded_pid" 2>/dev/null; then
    echo "Portable profile fixture PID file ${pid_file} cannot verify process ${recorded_pid}." >&2
    return 2
  else
    return 1
  fi
  if [[ "$current_start_time" != "$recorded_start_time" ]] \
    || ! process_has_identity "$recorded_pid" "$recorded_identity"; then
    echo "Portable profile fixture PID file ${pid_file} does not match process ${recorded_pid}." >&2
    return 2
  fi
}

recorded_process_has_recorded_start_time() {
  local pid_file="$1"
  local role="$2"
  local status
  if read_pid_record "$pid_file" "$role"; then
    :
  else
    status=$?
    return "$status"
  fi
  if ! kill -0 "$recorded_pid" 2>/dev/null || process_is_zombie "$recorded_pid"; then
    return 1
  fi

  local current_start_time
  if current_start_time="$(process_start_time "$recorded_pid")"; then
    :
  elif kill -0 "$recorded_pid" 2>/dev/null; then
    echo "Portable profile fixture PID file ${pid_file} cannot verify process ${recorded_pid}." >&2
    return 2
  else
    return 1
  fi
  if [[ "$current_start_time" != "$recorded_start_time" ]]; then
    echo "Portable profile fixture PID file ${pid_file} does not match process ${recorded_pid}." >&2
    return 2
  fi
}

signal_recorded_process() {
  local pid_file="$1"
  local role="$2"
  local signal="$3"
  local status
  if recorded_process_status "$pid_file" "$role"; then
    :
  else
    status=$?
    return "$status"
  fi
  kill -"$signal" "$recorded_pid" 2>/dev/null || {
    kill -0 "$recorded_pid" 2>/dev/null && return 2
    return 1
  }
}

recorded_process_is_active() {
  recorded_process_status "$1" "$2"
}

service_is_active() {
  local status
  if recorded_process_is_active "$activator_pid_file" activator; then
    :
  else
    status=$?
    return "$status"
  fi
  if recorded_process_is_active "$service_pid_file" service; then
    :
  else
    status=$?
    return "$status"
  fi
  [[ -S "$socket_path" ]] && [[ -S "$backend_socket_path" ]]
}

socket_is_ready() {
  [[ -S "$socket_path" ]] || return 1
  recorded_process_is_active "$activator_pid_file" activator
}

stop_recorded_process() {
  local pid_file="$1"
  local role="$2"
  [[ -f "$pid_file" ]] || return 0
  local status pid
  if recorded_process_status "$pid_file" "$role"; then
    pid="$recorded_pid"
  else
    status=$?
    if [[ "$status" -eq 1 ]]; then
      rm -f "$pid_file"
      return 0
    fi
    return "$status"
  fi

  if signal_recorded_process "$pid_file" "$role" TERM; then
    :
  else
    status=$?
    [[ "$status" -eq 1 ]] || return "$status"
  fi
  for ((attempt = 0; attempt < 100; attempt += 1)); do
    if recorded_process_has_recorded_start_time "$pid_file" "$role"; then
      sleep 0.05
      continue
    fi
    status=$?
    if [[ "$status" -eq 1 ]]; then
      rm -f "$pid_file"
      return 0
    fi
    return "$status"
  done

  if signal_recorded_process "$pid_file" "$role" KILL; then
    :
  else
    status=$?
    [[ "$status" -eq 1 ]] || return "$status"
  fi
  for ((attempt = 0; attempt < 100; attempt += 1)); do
    if recorded_process_has_recorded_start_time "$pid_file" "$role"; then
      sleep 0.05
      continue
    fi
    status=$?
    if [[ "$status" -eq 1 ]]; then
      rm -f "$pid_file"
      return 0
    fi
    return "$status"
  done
  echo "Portable profile fixture process ${pid} did not exit." >&2
  return 1
}

stop_service() {
  stop_recorded_process "$service_pid_file" service
  rm -f "$backend_socket_path"
}

stop_runtime() {
  stop_service
  stop_recorded_process "$activator_pid_file" activator
  rm -f "$socket_path" "$backend_socket_path"
}

refresh_service() {
  local status
  if service_is_active; then
    :
  else
    status=$?
    [[ "$status" -eq 1 ]] && return 0
    return "$status"
  fi

  local previous_record
  previous_record="$(<"$service_pid_file")"
  signal_recorded_process "$activator_pid_file" activator HUP

  for ((attempt = 0; attempt < 100; attempt += 1)); do
    if [[ -f "$service_pid_file" && "$(<"$service_pid_file")" != "$previous_record" ]]; then
      if service_is_active; then
        return 0
      else
        status=$?
        [[ "$status" -eq 1 ]] || return "$status"
      fi
    elif recorded_process_has_recorded_start_time "$service_pid_file" service; then
      :
    else
      status=$?
      [[ "$status" -eq 1 ]] || return "$status"
    fi
    if recorded_process_is_active "$activator_pid_file" activator; then
      :
    else
      status=$?
      [[ "$status" -eq 1 ]] || return "$status"
      break
    fi
    sleep 0.1
  done

  cat "$log_file" >&2 || true
  return 1
}

start_socket() {
  local status
  if socket_is_ready; then
    return 0
  else
    status=$?
    [[ "$status" -eq 1 ]] || return "$status"
  fi

  stop_runtime
  install -d -m 700 "$service_dir"
  NEMOCLAW_PODMAN_LOG_FILE="$log_file"
  export NEMOCLAW_PODMAN_LOG_FILE
  local activator_identity activator_pid
  activator_identity="activator:$(node -e 'process.stdout.write(require("node:crypto").randomBytes(16).toString("hex"))')"
  NEMOCLAW_PORTABLE_PROFILE_PROCESS_ID="$activator_identity" nohup node - "$socket_path" "$backend_socket_path" "$service_pid_file" \
    "$activator_pid_file" \
    >>"$log_file" 2>&1 <<'NODE' &
const { spawn, spawnSync } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");

const [socketPath, backendSocketPath, servicePidFile, activatorPidFile] = process.argv.slice(2);
const logFile = process.env.NEMOCLAW_PODMAN_LOG_FILE;
const refreshGate = process.env.NEMOCLAW_PODMAN_REFRESH_GATE;
const processIdentityEnv = "NEMOCLAW_PORTABLE_PROFILE_PROCESS_ID";
const processIdentityFailureRole = process.env.NEMOCLAW_PODMAN_IDENTITY_FAILURE_ROLE;
const processIdentityFailureRecord = process.env.NEMOCLAW_PODMAN_IDENTITY_FAILURE_RECORD;
const processQueryTimeoutMs = 5000;
let lifecycleTail = Promise.resolve();

function removeActivatorState() {
  fs.rmSync(activatorPidFile, { force: true });
}

function readProcessRecord(pidFile, role) {
  try {
    const value = fs.readFileSync(pidFile, "utf8").trim();
    const [pidText, startTime, identity, ...extra] = value.split("\t");
    const pid = Number(pidText);
    if (
      extra.length !== 0 ||
      !/^[1-9][0-9]*$/.test(pidText || "") ||
      !Number.isSafeInteger(pid) ||
      !/^(?:proc:[0-9]+|ps:.+)$/.test(startTime || "") ||
      !new RegExp(`^${role}:[0-9a-f]{32}$`).test(identity || "")
    ) {
      throw new Error(`Portable profile fixture PID file ${pidFile} is invalid.`);
    }
    return { identity, pid, pidFile, startTime };
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function writeProcessRecord(pidFile, processIdentity) {
  const temporaryPidFile = `${pidFile}.${process.pid}.tmp`;
  fs.writeFileSync(
    temporaryPidFile,
    `${processIdentity.pid}\t${processIdentity.startTime}\t${processIdentity.identity}\n`,
    { mode: 0o600 },
  );
  fs.renameSync(temporaryPidFile, pidFile);
}

function processIsActive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
    return false;
  }
}

function processIsZombie(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/)[0] === "Z";
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (fs.existsSync("/proc/self/stat")) return false;
  }

  const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
    encoding: "utf8",
    killSignal: "SIGKILL",
    timeout: processQueryTimeoutMs,
  });
  return result.status === 0 && result.stdout.trim().startsWith("Z");
}

function readProcessStartTime(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/);
    const startTime = fields[19];
    if (!startTime || !/^[0-9]+$/.test(startTime)) {
      throw new Error(`Portable profile fixture process ${pid} has invalid /proc stat data.`);
    }
    return `proc:${startTime}`;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (fs.existsSync("/proc/self/stat")) return undefined;
  }

  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    killSignal: "SIGKILL",
    timeout: processQueryTimeoutMs,
  });
  const startTime = result.status === 0 ? result.stdout.trim().replace(/\s+/g, " ") : "";
  return startTime ? `ps:${startTime}` : undefined;
}

function processHasIdentity(pid, identity) {
  const expected = `${processIdentityEnv}=${identity}`;
  try {
    return fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(expected);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (fs.existsSync("/proc/self/environ")) return false;
  }

  const result = spawnSync("ps", ["eww", "-p", String(pid), "-o", "command="], {
    encoding: "utf8",
    killSignal: "SIGKILL",
    timeout: processQueryTimeoutMs,
  });
  return result.status === 0 && result.stdout.split(/\s+/).includes(expected);
}

function recordedProcessIsActive(processIdentity) {
  if (!processIsActive(processIdentity.pid)) return false;
  if (processIsZombie(processIdentity.pid)) return false;
  if (
    readProcessStartTime(processIdentity.pid) !== processIdentity.startTime ||
    !processHasIdentity(processIdentity.pid, processIdentity.identity)
  ) {
    if (!processIsActive(processIdentity.pid)) return false;
    throw new Error(
      `Portable profile fixture PID file ${processIdentity.pidFile} does not match process ${processIdentity.pid}.`,
    );
  }
  return true;
}

function unrecordedProcessIsActive(pid, identity) {
  if (!processIsActive(pid)) return false;
  if (processIsZombie(pid)) return false;
  if (!processHasIdentity(pid, identity)) {
    if (!processIsActive(pid)) return false;
    throw new Error(
      `Portable profile fixture process ${pid} no longer matches its acquired identity.`,
    );
  }
  return true;
}

function signalUnrecordedProcess(pid, identity, signal) {
  if (!unrecordedProcessIsActive(pid, identity)) return false;
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
    return false;
  }
}

async function acquireProcessIdentity(pid, identity, pidFile) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const startTime = readProcessStartTime(pid);
    if (startTime && processHasIdentity(pid, identity)) {
      return { identity, pid, pidFile, startTime };
    }
    if (!processIsActive(pid)) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return undefined;
}

function processHasRecordedStartTime(processIdentity) {
  if (!processIsActive(processIdentity.pid)) return false;
  if (processIsZombie(processIdentity.pid)) return false;
  const startTime = readProcessStartTime(processIdentity.pid);
  if (!startTime && !processIsActive(processIdentity.pid)) return false;
  if (startTime !== processIdentity.startTime) {
    throw new Error(
      `Portable profile fixture PID file ${processIdentity.pidFile} does not match process ${processIdentity.pid}.`,
    );
  }
  return true;
}

function signalProcess(processIdentity, signal) {
  if (!recordedProcessIsActive(processIdentity)) return false;
  try {
    process.kill(processIdentity.pid, signal);
    return true;
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
    return false;
  }
}

function serviceIsActive() {
  const processIdentity = readProcessRecord(servicePidFile, "service");
  return processIdentity !== undefined && recordedProcessIsActive(processIdentity);
}

function backendIsReady() {
  try {
    return serviceIsActive() && fs.statSync(backendSocketPath).isSocket();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return false;
  }
}

async function waitForProcessExit(processIdentity) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!processHasRecordedStartTime(processIdentity)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function terminateProcessIdentity(processIdentity) {
  if (!recordedProcessIsActive(processIdentity)) return;
  const termSent = signalProcess(processIdentity, "SIGTERM");
  if (termSent && !(await waitForProcessExit(processIdentity))) {
    const killSent = signalProcess(processIdentity, "SIGKILL");
    if (killSent && !(await waitForProcessExit(processIdentity))) {
      throw new Error(`Portable profile fixture process ${processIdentity.pid} did not exit.`);
    }
  }
}

async function waitForUnrecordedProcessExit(pid, identity) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!unrecordedProcessIsActive(pid, identity)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function terminateUnrecordedProcess(pid, identity) {
  if (!unrecordedProcessIsActive(pid, identity)) return;
  const termSent = signalUnrecordedProcess(pid, identity, "SIGTERM");
  if (termSent && !(await waitForUnrecordedProcessExit(pid, identity))) {
    const killSent = signalUnrecordedProcess(pid, identity, "SIGKILL");
    if (killSent && !(await waitForUnrecordedProcessExit(pid, identity))) {
      throw new Error(`Portable profile fixture process ${pid} did not exit.`);
    }
  }
}

async function stopService() {
  const processIdentity = readProcessRecord(servicePidFile, "service");
  if (processIdentity !== undefined) await terminateProcessIdentity(processIdentity);
  fs.rmSync(servicePidFile, { force: true });
  fs.rmSync(backendSocketPath, { force: true });
}

async function waitForRefreshGate() {
  if (!refreshGate) return;
  fs.writeFileSync(`${refreshGate}.waiting`, `${process.pid}\n`, { mode: 0o600 });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (fs.existsSync(`${refreshGate}.release`)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for the test to release the portable profile refresh gate.");
}

async function startService() {
  if (backendIsReady()) return;
  await stopService();
  const output = fs.openSync(logFile, "a");
  const identity = `service:${randomBytes(16).toString("hex")}`;
  const service = spawn(
    "podman",
    ["system", "service", "--time=0", `unix://${backendSocketPath}`],
    {
      detached: true,
      env: { ...process.env, [processIdentityEnv]: identity },
      stdio: ["ignore", output, output],
    },
  );
  fs.closeSync(output);
  if (!service.pid) throw new Error("Podman service did not report a process ID.");
  let processIdentity;
  try {
    processIdentity = await acquireProcessIdentity(service.pid, identity, servicePidFile);
  } catch (error) {
    await terminateUnrecordedProcess(service.pid, identity);
    throw error;
  }
  if (!processIdentity) {
    await terminateUnrecordedProcess(service.pid, identity);
    throw new Error(
      `Portable profile fixture could not create the process identity record for service ${service.pid}.`,
    );
  }
  if (processIdentityFailureRole === "service") {
    if (processIdentityFailureRecord) {
      writeProcessRecord(processIdentityFailureRecord, processIdentity);
    }
    await terminateProcessIdentity(processIdentity);
    fs.rmSync(backendSocketPath, { force: true });
    throw new Error(
      `Portable profile fixture could not create the process identity record for service ${service.pid}.`,
    );
  }
  writeProcessRecord(servicePidFile, processIdentity);
  service.unref();

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (backendIsReady()) return;
    if (!recordedProcessIsActive(processIdentity)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  await stopService();
  throw new Error("Podman service did not create its backend socket.");
}

async function refreshService() {
  await stopService();
  await waitForRefreshGate();
  await startService();
}

function runLifecycle(operation) {
  const result = lifecycleTail.then(operation, operation);
  lifecycleTail = result.catch(() => undefined);
  return result;
}

function connectBackend(client) {
  return new Promise((resolve, reject) => {
    const backend = net.createConnection(backendSocketPath);
    const fail = (error) => {
      client.off("close", clientClosed);
      backend.destroy();
      reject(error);
    };
    const clientClosed = () => fail(new Error("Portable profile client closed before proxying."));
    client.once("close", clientClosed);
    backend.once("error", fail);
    backend.once("connect", () => {
      client.off("close", clientClosed);
      backend.off("error", fail);
      resolve(backend);
    });
  });
}

async function proxy(client) {
  const lifecycle = runLifecycle(async () => {
    await startService();
    return connectBackend(client);
  });
  if (refreshGate && fs.existsSync(`${refreshGate}.waiting`)) {
    fs.writeFileSync(`${refreshGate}.client`, `${process.pid}\n`, { mode: 0o600 });
  }
  const backend = await lifecycle;
  backend.once("error", () => client.destroy());
  client.once("error", () => backend.destroy());
  client.pipe(backend).pipe(client);
}

const server = net.createServer((client) => {
  void proxy(client).catch((error) => {
    console.error(error);
    client.destroy();
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
process.on("SIGHUP", () => {
  void runLifecycle(refreshService).catch((error) => console.error(error));
});
NODE
  activator_pid=$!
  if acquire_process_identity "$activator_pid" "$activator_identity"; then
    if [[ "$process_identity_failure_role" == activator ]]; then
      if [[ -n "$process_identity_failure_record" ]]; then
        printf '%s\t%s\t%s\n' "$activator_pid" "$acquired_process_start_time" "$activator_identity" \
          >"$process_identity_failure_record"
        chmod 600 "$process_identity_failure_record"
      fi
      stop_unrecorded_process "$activator_pid" "$activator_identity" "$acquired_process_start_time" || true
      echo "Portable profile fixture could not create the process identity record for activator ${activator_pid}." >&2
      cat "$log_file" >&2 || true
      return 1
    fi
    local activator_pid_file_tmp="${activator_pid_file}.$$.tmp"
    printf '%s\t%s\t%s\n' "$activator_pid" "$acquired_process_start_time" "$activator_identity" \
      >"$activator_pid_file_tmp"
    chmod 600 "$activator_pid_file_tmp"
    mv "$activator_pid_file_tmp" "$activator_pid_file"
  else
    stop_unrecorded_process "$activator_pid" "$activator_identity" "" || true
    echo "Portable profile fixture could not create the process identity record for activator ${activator_pid}." >&2
    cat "$log_file" >&2 || true
    return 1
  fi

  for ((attempt = 0; attempt < 100; attempt += 1)); do
    if socket_is_ready; then
      return 0
    fi
    if recorded_process_is_active "$activator_pid_file" activator; then
      :
    else
      status=$?
      [[ "$status" -eq 1 ]] || return "$status"
      break
    fi
    sleep 0.1
  done

  stop_runtime
  cat "$log_file" >&2 || true
  return 1
}

if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi

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
  refresh_service
  exit 0
fi

if [[ "$#" -eq 4 &&
  "$1" == "--user" &&
  "$2" == "is-active" &&
  "$3" == "--quiet" &&
  "$4" == "podman.service" ]]; then
  if service_is_active; then
    exit 0
  else
    status=$?
    [[ "$status" -eq 1 ]] || exit "$status"
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
