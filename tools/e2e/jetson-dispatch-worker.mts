// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { JetsonDispatchRequest } from "./jetson-dispatch-contract.mts";
import type {
  JetsonDeviceIdentity,
  JetsonDispatchWorker,
  JetsonWorkerResult,
} from "./jetson-dispatch-lifecycle.mts";
import {
  decodeJetsonArtifactArchive,
  MAX_JETSON_ARTIFACT_ARCHIVE_BYTES,
} from "./jetson-dispatch-lifecycle.mts";
import { readPrivateRegularFile, writePrivateRegularFile } from "./private-file.mts";

const MAX_PROCESS_OUTPUT_BYTES = 4 * 1024 * 1024;
const JETSON_SSH_DESTINATION = "nvidia@192.168.55.1";
const JETSON_CLEANUP_EXECUTABLE = "/usr/local/libexec/nemoclaw-jetson-cleanup";
const JETSON_CLEANUP_TARGET =
  "/opt/nemoclaw-jetson-dispatch/current/tools/e2e/jetson-dispatch-cleanup.sh";
const SAFE_PROCESS_ENV = {
  LANG: "C.UTF-8",
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
};
const MAX_BASELINE_OUTPUT_BYTES = 4 * 1024;
const MAX_BASELINE_RECORD_BYTES = 8 * 1024;
const MAX_OLLAMA_MODELS = 64;
const MAX_OLLAMA_MODELS_BYTES = 3 * 1024;
const MAX_CLEANUP_EVIDENCE_BYTES = 64 * 1024;
const CLEANUP_EVIDENCE_BEGIN = "nemoclaw-cleanup-evidence-v1-begin";
const CLEANUP_EVIDENCE_END = "nemoclaw-cleanup-evidence-v1-end";

interface JetsonCleanupEvidence {
  schemaVersion: 1;
  volumes: string[];
  processIds: number[];
}

const DEVICE_IDENTITY_SCRIPT = String.raw`set -eu
clean_line() { tr -d '\000\r\n\t'; }
printf 'model\t'
if [ -r /proc/device-tree/model ]; then clean_line </proc/device-tree/model; else printf 'unavailable'; fi
printf '\njetpackVersion\t'
if command -v dpkg-query >/dev/null 2>&1; then
  jetpack_version="$(dpkg-query -W -f='${"${Version}"}' nvidia-jetpack 2>/dev/null || true)"
  if [ -n "$jetpack_version" ]; then printf '%s' "$jetpack_version" | clean_line; else printf 'unavailable'; fi
else
  printf 'unavailable'
fi
printf '\njetsonLinuxRelease\t'
if [ -r /etc/nv_tegra_release ]; then sed -n '1p' /etc/nv_tegra_release | clean_line; else printf 'unavailable'; fi
printf '\nkernel\t'
uname -r | clean_line
printf '\n'
`;

const PRESERVED_BASELINE_SCRIPT = String.raw`set -euo pipefail
export LC_ALL=C
clean_line() { tr -d '\000\r\n\t'; }
node_path="$(command -v node)"
npm_path="$(command -v npm)"
ollama_path="$(command -v ollama)"
for openshell_component in openshell openshell-gateway openshell-sandbox; do
  if command -v "$openshell_component" >/dev/null 2>&1; then
    echo "Jetson dispatch requires OpenShell to be absent before the job" >&2
    exit 1
  fi
  for host_bin in "/usr/local/bin/$openshell_component" "/usr/bin/$openshell_component" "$HOME/.local/bin/$openshell_component"; do
    if [ -e "$host_bin" ] || [ -L "$host_bin" ]; then
      echo "Jetson dispatch requires host-level OpenShell binaries to be absent" >&2
      exit 1
    fi
  done
done
node_version="$(node --version)"
node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 19)) process.exit(1);
'
npm_version="$(npm --version)"
npm_major="${"${npm_version%%.*}"}"
[[ "$npm_major" =~ ^[0-9]+$ ]] && (( npm_major >= 10 ))
test -c /dev/nvmap
docker_runtimes="$(docker info --format '{{json .Runtimes}}')"
case "$docker_runtimes" in
  *nvidia*) ;;
  *) echo "Docker does not report the NVIDIA runtime" >&2; exit 1 ;;
esac
ollama_models_base64="$(
  ollama list |
    awk 'NR == 1 { if ($1 != "NAME" || $2 != "ID") exit 1; next } { if (NF < 2) exit 1; print $1 "\t" $2 } END { if (NR == 0) exit 1 }' |
    LC_ALL=C sort |
    base64 --wrap=0
)"
test_owned_images="$(docker image ls nemoclaw-sandbox-local --format '{{.Repository}}\t{{.Tag}}' | awk '$1 == "nemoclaw-sandbox-local" && index($2, "e2e-jetson-nvmap-") == 1 { print $1 ":" $2 }')"
[ -z "$test_owned_images" ] || { echo "A test-owned Jetson image remains before dispatch" >&2; exit 1; }
printf 'nodePath\t'; printf '%s' "$node_path" | clean_line
printf '\nnodeVersion\t'; printf '%s' "$node_version" | clean_line
printf '\nnpmPath\t'; printf '%s' "$npm_path" | clean_line
printf '\nnpmVersion\t'; printf '%s' "$npm_version" | clean_line
printf '\nollamaPath\t'; printf '%s' "$ollama_path" | clean_line
printf '\nollamaModelsBase64\t'; printf '%s' "$ollama_models_base64" | clean_line
printf '\nopenshellState\tabsent'
printf '\n'
`;

const CLEANUP_VERIFICATION_SCRIPT =
  String.raw`set -euo pipefail
job_id="$1"
cleanup_evidence_base64="$2"
[[ "$job_id" =~ ^[a-f0-9]{64}$ ]]
workspace="/var/tmp/nemoclaw-jetson-e2e/$job_id"
job_home="$workspace/home"
sandbox_name=e2e-jetson-nvmap
gateway_name=nemoclaw
recorded_volumes=()
recorded_process_ids=()
cleanup_rows="$(
  printf '%s' "$cleanup_evidence_base64" | base64 --decode | node -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(0, "utf8"));
    if (value.schemaVersion !== 1 || !Array.isArray(value.volumes) || !Array.isArray(value.processIds)) process.exit(1);
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
if [ -n "$cleanup_rows" ]; then
  while IFS=$'\t' read -r kind identity; do
    case "$kind" in
      volume) recorded_volumes+=("$identity") ;;
      processId) recorded_process_ids+=("$identity") ;;
      *) echo "Cleanup evidence contains an invalid identity" >&2; exit 1 ;;
    esac
  done <<<"$cleanup_rows"
fi
test ! -e "$workspace"
test ! -L "$workspace"
sandbox_container_output="$(docker ps -aq \
  --filter label=openshell.ai/managed-by=openshell \
  --filter "label=openshell.ai/sandbox-name=$sandbox_name")"
if [ -n "$sandbox_container_output" ]; then
  echo "A test-owned OpenShell sandbox container remains" >&2
  exit 1
fi
container_rows="$(docker container ls --all --no-trunc --format '{{.ID}}\t{{.Names}}')"
if printf '%s\n' "$container_rows" | awk -F '\t' -v name="openshell-cluster-$gateway_name" '$2 == name { found = 1 } END { exit found ? 0 : 1 }'; then
  echo "The test-owned OpenShell gateway container remains" >&2
  exit 1
fi
volume_names="$(docker volume ls --format '{{.Name}}')"
if printf '%s\n' "$volume_names" | grep -Fqx "openshell-cluster-$gateway_name"; then
  echo "The test-owned OpenShell gateway volume remains" >&2
  exit 1
fi
for volume in "${"${recorded_volumes[@]}"}"; do
  if printf '%s\n' "$volume_names" | grep -Fqx "$volume"; then
    echo "A recorded test-owned Docker volume remains" >&2
    exit 1
  fi
done
for pid in "${"${recorded_process_ids[@]}"}"; do
  if kill -0 "$pid" 2>/dev/null; then
    echo "A recorded test-owned helper process remains" >&2
    exit 1
  fi
done
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
` + PRESERVED_BASELINE_SCRIPT;

const JETSON_TEST_SCRIPT = String.raw`set -euo pipefail
candidate_sha="$1"
job_id="$2"
timeout_seconds="$3"
[[ "$candidate_sha" =~ ^[a-f0-9]{40}$ ]]
[[ "$job_id" =~ ^[a-f0-9]{64}$ ]]
[[ "$timeout_seconds" =~ ^[1-9][0-9]*$ ]]

workspace_root=/var/tmp/nemoclaw-jetson-e2e
if [ -L "$workspace_root" ]; then
  echo "Jetson E2E workspace root must not be a symbolic link" >&2
  exit 1
fi
install -d -m 0700 "$workspace_root"
workspace="$workspace_root/$job_id"
if [ -e "$workspace" ]; then
  echo "Jetson E2E workspace already exists; cleanup recovery is required" >&2
  exit 1
fi
install -d -m 0700 "$workspace"
install -d -m 0700 \
  "$workspace/home" \
  "$workspace/home/.cache" \
  "$workspace/home/.config" \
  "$workspace/home/.local/bin" \
  "$workspace/home/.local/share" \
  "$workspace/home/.local/state" \
  "$workspace/npm-prefix" \
  "$workspace/runtime" \
  "$workspace/tmp"

export HOME="$workspace/home"
export TMPDIR="$workspace/tmp"
export XDG_CACHE_HOME="$workspace/home/.cache"
export XDG_CONFIG_HOME="$workspace/home/.config"
export XDG_DATA_HOME="$workspace/home/.local/share"
export XDG_STATE_HOME="$workspace/home/.local/state"
export XDG_BIN_HOME="$workspace/home/.local/bin"
export XDG_RUNTIME_DIR="$workspace/runtime"
export npm_config_prefix="$workspace/npm-prefix"
export PATH="$XDG_BIN_HOME:$workspace/npm-prefix/bin:$PATH"
export NEMOCLAW_JETSON_WORKSPACE="$workspace"
unset DBUS_SESSION_BUS_ADDRESS NEMOCLAW_OPENSHELL_BIN NEMOCLAW_OPENSHELL_GATEWAY_BIN

if [ -w /usr/local/bin ] || [ -w /usr/bin ]; then
  echo "Jetson job user must not be able to install OpenShell into a host binary directory" >&2
  exit 1
fi

git init --quiet "$workspace/repository"
git -C "$workspace/repository" remote add origin https://github.com/NVIDIA/NemoClaw.git
git -C "$workspace/repository" fetch --quiet --depth=1 --no-tags origin "$candidate_sha"
fetched_sha="$(git -C "$workspace/repository" rev-parse FETCH_HEAD)"
[[ "$fetched_sha" == "$candidate_sha" ]]
git -C "$workspace/repository" checkout --quiet --detach "$candidate_sha"
cd "$workspace/repository"

node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 19)) process.exit(1);
' || { echo "Jetson E2E requires Node.js 22.19.0 or later" >&2; exit 1; }
npm_major="$(npm --version | cut -d . -f 1)"
[[ "$npm_major" =~ ^[0-9]+$ ]] && (( npm_major >= 10 )) || {
  echo "Jetson E2E requires npm 10 or later" >&2
  exit 1
}
npm ci --ignore-scripts
npm run build:cli

export E2E_JOB=1
export E2E_TARGET_ID=jetson-nvmap-gpu
export E2E_ARTIFACT_DIR="$workspace/e2e-artifacts/live/jetson-nvmap-gpu"
export NEMOCLAW_CLI_BIN="$workspace/repository/bin/nemoclaw.js"
export NEMOCLAW_RUN_LIVE_E2E=1
export NEMOCLAW_NON_INTERACTIVE=1
export NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1
export NEMOCLAW_SANDBOX_NAME=e2e-jetson-nvmap
export NEMOCLAW_RECREATE_SANDBOX=1
export NEMOCLAW_PROVIDER=ollama
export OPENSHELL_GATEWAY=nemoclaw

timeout --foreground --signal=TERM --kill-after=30s "${"${timeout_seconds}"}s" \
  npx tsx tools/e2e/live-vitest-invocation.mts run \
  --test-path test/e2e/live/jetson-nvmap-gpu.test.ts

for installed_command in nemoclaw openshell openshell-gateway openshell-sandbox; do
  installed_path="$(command -v "$installed_command")"
  canonical_path="$(realpath -e "$installed_path")"
  case "$canonical_path" in
    "$workspace"/*) ;;
    *) echo "$installed_command resolved outside the Jetson job workspace" >&2; exit 1 ;;
  esac
done
`;

const COLLECT_ARTIFACT_SCRIPT = String.raw`set -euo pipefail
job_id="$1"
[[ "$job_id" =~ ^[a-f0-9]{64}$ ]]
workspace="/var/tmp/nemoclaw-jetson-e2e/$job_id"

artifact_directory="$workspace/e2e-artifacts/live/jetson-nvmap-gpu"
if [ ! -d "$artifact_directory" ] || [ -L "$artifact_directory" ]; then
  exit 0
fi
artifact_bytes="$(du --apparent-size --block-size=1 --summarize "$artifact_directory" | cut -f1)"
[[ "$artifact_bytes" =~ ^[0-9]+$ ]]
if (( artifact_bytes > ${MAX_JETSON_ARTIFACT_ARCHIVE_BYTES} )); then
  echo "Jetson E2E artifacts exceed ${MAX_JETSON_ARTIFACT_ARCHIVE_BYTES} bytes" >&2
  exit 1
fi
archive="$workspace/jetson-e2e-artifacts.tar.gz"
tar --one-file-system --create --gzip --file "$archive" --directory "$artifact_directory" -- .
archive_bytes="$(stat --format='%s' "$archive")"
if (( archive_bytes > ${MAX_JETSON_ARTIFACT_ARCHIVE_BYTES} )); then
  echo "Jetson E2E artifact archive exceeds ${MAX_JETSON_ARTIFACT_ARCHIVE_BYTES} bytes" >&2
  exit 1
fi
base64 --wrap=0 "$archive"
`;

export interface SshJetsonWorkerConfig {
  cleanupExecutable: string;
  destination: string;
  identityFile: string;
  knownHostsFile: string;
  stateDirectory: string;
  testTimeoutSeconds: number;
}

function requireSecureFile(
  file: string,
  options: { executable?: boolean; private?: boolean },
): void {
  if (!path.isAbsolute(file) || /[\u0000-\u001f\u007f]/u.test(file)) {
    throw new Error(`${file} must be an absolute path without control characters`);
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${file} must be a regular file`);
  if ((stat.mode & 0o022) !== 0) throw new Error(`${file} must not be group- or world-writable`);
  if (options.private && (stat.mode & 0o077) !== 0) {
    throw new Error(`${file} must be readable only by its owner`);
  }
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && stat.uid !== currentUid && stat.uid !== 0) {
    throw new Error(`${file} must be owned by root or the dispatcher user`);
  }
  if (options.executable && (stat.mode & 0o111) === 0) {
    throw new Error(`${file} must be executable`);
  }
}

function requireSecureCleanupExecutable(file: string): void {
  if (file !== JETSON_CLEANUP_EXECUTABLE) {
    requireSecureFile(file, { executable: true });
    return;
  }
  const linkStat = fs.lstatSync(file);
  if (!linkStat.isSymbolicLink()) {
    requireSecureFile(file, { executable: true });
    return;
  }
  if (linkStat.uid !== 0) {
    throw new Error(`${file} symbolic link must be owned by root`);
  }
  if (fs.readlinkSync(file) !== JETSON_CLEANUP_TARGET) {
    throw new Error(`${file} must select the managed current-release cleanup program`);
  }
  requireSecureFile(JETSON_CLEANUP_TARGET, { executable: true });
}

function positiveIntegerEnvironment(
  value: string | undefined,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!value || !/^[1-9][0-9]*$/u.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export function loadSshJetsonWorkerConfig(
  options: { stateDirectory: string },
  env: NodeJS.ProcessEnv = process.env,
): SshJetsonWorkerConfig {
  if (!path.isAbsolute(options.stateDirectory)) {
    throw new Error("Jetson dispatcher state directory must be absolute");
  }
  const destination = env.JETSON_DISPATCH_SSH_DESTINATION ?? "";
  if (destination !== JETSON_SSH_DESTINATION) {
    throw new Error(`JETSON_DISPATCH_SSH_DESTINATION must be ${JETSON_SSH_DESTINATION}`);
  }
  const identityFile = env.JETSON_DISPATCH_SSH_IDENTITY_FILE ?? "";
  const knownHostsFile = env.JETSON_DISPATCH_SSH_KNOWN_HOSTS_FILE ?? "";
  const cleanupExecutable = env.JETSON_DISPATCH_CLEANUP_EXECUTABLE ?? "";
  requireSecureFile(identityFile, { private: true });
  requireSecureFile(knownHostsFile, {});
  requireSecureCleanupExecutable(cleanupExecutable);
  return {
    cleanupExecutable,
    destination,
    identityFile,
    knownHostsFile,
    stateDirectory: options.stateDirectory,
    testTimeoutSeconds: positiveIntegerEnvironment(
      env.JETSON_DISPATCH_TEST_TIMEOUT_SECONDS,
      "JETSON_DISPATCH_TEST_TIMEOUT_SECONDS",
      60,
      50 * 60,
    ),
  };
}

interface ProcessResult {
  stdout: string;
  stderr: string;
}

export class ProcessFailure extends Error {
  readonly result: ProcessResult;

  constructor(message: string, result: ProcessResult) {
    super(message);
    this.result = result;
  }
}

function runProcess(options: {
  executable: string;
  args: string[];
  input?: string;
  signal: AbortSignal;
}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.executable, options.args, {
      env: SAFE_PROCESS_ENV,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const finish = (error?: Error, result?: ProcessResult): void => {
      if (settled) return;
      settled = true;
      options.signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(result!);
    };
    const stop = (): void => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      killTimer.unref();
    };
    const abort = (): void => stop();
    const collect = (chunks: Buffer[], chunk: Buffer): void => {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes > MAX_PROCESS_OUTPUT_BYTES) {
        stop();
        finish(new Error(`Jetson command output exceeds ${MAX_PROCESS_OUTPUT_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    };

    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") {
        stop();
        finish(error);
      }
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => {
      if (killTimer) clearTimeout(killTimer);
      if (settled) return;
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (options.signal.aborted) {
        finish(new ProcessFailure("Jetson command was interrupted", result));
        return;
      }
      if (code !== 0) {
        finish(
          new ProcessFailure(
            `Jetson command exited with ${code ?? `signal ${signal ?? "unknown"}`}: ${result.stderr.slice(-500)}`,
            result,
          ),
        );
        return;
      }
      finish(undefined, result);
    });
    if (options.input !== undefined) child.stdin.end(options.input, "utf8");
    else child.stdin.end();
  });
}

function parseDeviceIdentity(output: string): JetsonDeviceIdentity {
  if (Buffer.byteLength(output) > 8 * 1024) throw new Error("Jetson identity output is too large");
  const entries = new Map<string, string>();
  for (const line of output.trimEnd().split("\n")) {
    const separator = line.indexOf("\t");
    if (separator < 1) throw new Error("Jetson identity output is malformed");
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (entries.has(key) || value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw new Error("Jetson identity output is malformed");
    }
    entries.set(key, value.slice(0, 500));
  }
  const expected = ["jetpackVersion", "jetsonLinuxRelease", "kernel", "model"];
  if (entries.size !== expected.length || expected.some((key) => !entries.has(key))) {
    throw new Error("Jetson identity output is incomplete");
  }
  return {
    model: entries.get("model")!,
    jetpackVersion: entries.get("jetpackVersion")!,
    jetsonLinuxRelease: entries.get("jetsonLinuxRelease")!,
    kernel: entries.get("kernel")!,
  };
}

interface JetsonPreservedBaseline {
  nodePath: string;
  nodeVersion: string;
  npmPath: string;
  npmVersion: string;
  ollamaPath: string;
  ollamaModels: JetsonOllamaModel[];
  openshellState: "absent";
}

interface JetsonOllamaModel {
  name: string;
  id: string;
}

function parseOllamaModelsBase64(value: string): JetsonOllamaModel[] {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error("Jetson protected-baseline Ollama model data is malformed");
  }
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.length > MAX_OLLAMA_MODELS_BYTES ||
    decoded.toString("base64") !== value ||
    decoded.includes(0)
  ) {
    throw new Error("Jetson protected-baseline Ollama model data is malformed or oversized");
  }
  const rows = decoded.length === 0 ? [] : decoded.toString("utf8").trimEnd().split("\n");
  if (rows.length > MAX_OLLAMA_MODELS) {
    throw new Error("Jetson protected-baseline Ollama model data is malformed or oversized");
  }
  const models = rows.map((row) => {
    const fields = row.split("\t");
    if (
      fields.length !== 2 ||
      !/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/u.test(fields[0]!) ||
      !/^[a-f0-9]{12,64}$/u.test(fields[1]!)
    ) {
      throw new Error("Jetson protected-baseline Ollama model data is malformed");
    }
    return { name: fields[0]!, id: fields[1]! };
  });
  const sorted = [...models].sort((left, right) => {
    if (left.name !== right.name) return left.name < right.name ? -1 : 1;
    if (left.id === right.id) return 0;
    return left.id < right.id ? -1 : 1;
  });
  const names = new Set<string>();
  if (
    models.some((model) => {
      if (names.has(model.name)) return true;
      names.add(model.name);
      return false;
    }) ||
    models.some(
      (model, index) => model.name !== sorted[index]!.name || model.id !== sorted[index]!.id,
    )
  ) {
    throw new Error("Jetson protected-baseline Ollama model data is duplicate or ambiguous");
  }
  return models;
}

function validateOllamaModels(value: unknown): JetsonOllamaModel[] {
  if (!Array.isArray(value) || value.length > MAX_OLLAMA_MODELS) {
    throw new Error("Jetson protected-baseline Ollama model record is malformed or oversized");
  }
  const serialized = value
    .map((model) => {
      if (!model || typeof model !== "object" || Array.isArray(model)) {
        throw new Error("Jetson protected-baseline Ollama model record is malformed");
      }
      const record = model as Record<string, unknown>;
      if (
        Object.keys(record).sort().join(",") !== "id,name" ||
        typeof record.name !== "string" ||
        typeof record.id !== "string"
      ) {
        throw new Error("Jetson protected-baseline Ollama model record is malformed");
      }
      return `${record.name}\t${record.id}`;
    })
    .join("\n");
  if (Buffer.byteLength(serialized) > MAX_OLLAMA_MODELS_BYTES) {
    throw new Error("Jetson protected-baseline Ollama model record is malformed or oversized");
  }
  return parseOllamaModelsBase64(Buffer.from(serialized).toString("base64"));
}

function parsePreservedBaseline(output: string): JetsonPreservedBaseline {
  if (Buffer.byteLength(output) > MAX_BASELINE_OUTPUT_BYTES) {
    throw new Error("Jetson protected-baseline output is too large");
  }
  const entries = new Map<string, string>();
  for (const line of output.trimEnd().split("\n")) {
    const separator = line.indexOf("\t");
    if (separator < 1) throw new Error("Jetson protected-baseline output is malformed");
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (
      entries.has(key) ||
      (value.length === 0 && key !== "ollamaModelsBase64") ||
      /[\u0000-\u001f\u007f]/u.test(value)
    ) {
      throw new Error("Jetson protected-baseline output is malformed");
    }
    entries.set(key, value);
  }
  const expected = [
    "nodePath",
    "nodeVersion",
    "npmPath",
    "npmVersion",
    "ollamaPath",
    "ollamaModelsBase64",
    "openshellState",
  ] as const;
  if (entries.size !== expected.length || expected.some((key) => !entries.has(key))) {
    throw new Error("Jetson protected-baseline output is incomplete");
  }
  const baseline: JetsonPreservedBaseline = {
    nodePath: entries.get("nodePath")!,
    nodeVersion: entries.get("nodeVersion")!,
    npmPath: entries.get("npmPath")!,
    npmVersion: entries.get("npmVersion")!,
    ollamaPath: entries.get("ollamaPath")!,
    ollamaModels: parseOllamaModelsBase64(entries.get("ollamaModelsBase64")!),
    openshellState: entries.get("openshellState") as "absent",
  };
  if (baseline.openshellState !== "absent") {
    throw new Error("Jetson protected-baseline OpenShell state is malformed");
  }
  if (Buffer.byteLength(`${JSON.stringify(baseline)}\n`) > MAX_BASELINE_RECORD_BYTES) {
    throw new Error("Jetson protected-baseline record is too large");
  }
  return baseline;
}

function parsePreservedBaselineJson(output: string): JetsonPreservedBaseline {
  if (Buffer.byteLength(output) > MAX_BASELINE_RECORD_BYTES) {
    throw new Error("Jetson protected-baseline record is too large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("Jetson protected-baseline record is malformed");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Jetson protected-baseline record is malformed");
  }
  const record = parsed as Record<string, unknown>;
  const expected = [
    "nodePath",
    "nodeVersion",
    "npmPath",
    "npmVersion",
    "ollamaPath",
    "ollamaModels",
    "openshellState",
  ];
  if (
    Object.keys(record).length !== expected.length ||
    expected.some((key) => key !== "ollamaModels" && typeof record[key] !== "string")
  ) {
    throw new Error("Jetson protected-baseline record is incomplete");
  }
  const ollamaModels = validateOllamaModels(record.ollamaModels);
  const baselineOutput = [
    `nodePath\t${record.nodePath}`,
    `nodeVersion\t${record.nodeVersion}`,
    `npmPath\t${record.npmPath}`,
    `npmVersion\t${record.npmVersion}`,
    `ollamaPath\t${record.ollamaPath}`,
    `ollamaModelsBase64\t${Buffer.from(
      ollamaModels.map((model) => `${model.name}\t${model.id}`).join("\n"),
    ).toString("base64")}`,
    `openshellState\t${record.openshellState}`,
  ].join("\n");
  return parsePreservedBaseline(baselineOutput);
}

function protectedHostBaselineMatches(
  expected: JetsonPreservedBaseline,
  actual: JetsonPreservedBaseline,
): boolean {
  return (
    expected.nodePath === actual.nodePath &&
    expected.nodeVersion === actual.nodeVersion &&
    expected.npmPath === actual.npmPath &&
    expected.npmVersion === actual.npmVersion &&
    expected.ollamaPath === actual.ollamaPath &&
    expected.openshellState === actual.openshellState
  );
}

function preservesOllamaModels(
  expected: JetsonPreservedBaseline,
  actual: JetsonPreservedBaseline,
): boolean {
  const actualModels = new Map(actual.ollamaModels.map((model) => [model.name, model.id]));
  return expected.ollamaModels.every((model) => actualModels.get(model.name) === model.id);
}

function validateCleanupEvidence(value: unknown): JetsonCleanupEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Jetson cleanup evidence is malformed");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 3 ||
    record.schemaVersion !== 1 ||
    !Array.isArray(record.volumes) ||
    !Array.isArray(record.processIds)
  ) {
    throw new Error("Jetson cleanup evidence is malformed");
  }
  const volumes = record.volumes;
  const processIds = record.processIds;
  if (
    volumes.some(
      (volume) => typeof volume !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/u.test(volume),
    ) ||
    processIds.some((pid) => typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1)
  ) {
    throw new Error("Jetson cleanup evidence contains an invalid resource identity");
  }
  return {
    schemaVersion: 1,
    volumes: [...new Set(volumes as string[])].sort(),
    processIds: [...new Set(processIds as number[])].sort((left, right) => left - right),
  };
}

function parseCleanupEvidenceJson(output: string): JetsonCleanupEvidence {
  if (Buffer.byteLength(output) > MAX_CLEANUP_EVIDENCE_BYTES) {
    throw new Error("Jetson cleanup evidence is too large");
  }
  try {
    return validateCleanupEvidence(JSON.parse(output));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Jetson cleanup evidence")) throw error;
    throw new Error("Jetson cleanup evidence is malformed");
  }
}

function parseCleanupCommandEvidence(output: string): JetsonCleanupEvidence {
  if (Buffer.byteLength(output) > MAX_PROCESS_OUTPUT_BYTES) {
    throw new Error("Jetson cleanup output is too large");
  }
  const lines = output.replace(/\r/gu, "").split("\n");
  while (lines.at(-1) === "") lines.pop();
  const beginIndex = lines.indexOf(CLEANUP_EVIDENCE_BEGIN);
  const endIndex = lines.indexOf(CLEANUP_EVIDENCE_END);
  if (
    beginIndex < 0 ||
    endIndex < 0 ||
    beginIndex !== lines.lastIndexOf(CLEANUP_EVIDENCE_BEGIN) ||
    endIndex !== lines.lastIndexOf(CLEANUP_EVIDENCE_END) ||
    beginIndex >= endIndex
  ) {
    throw new Error("Jetson cleanup did not return bounded resource evidence");
  }
  const volumes: string[] = [];
  const processIds: number[] = [];
  for (const line of lines.slice(beginIndex + 1, endIndex)) {
    const fields = line.split("\t");
    if (fields.length !== 2) throw new Error("Jetson cleanup evidence is malformed");
    const [kind, identity] = fields;
    if (kind === "volume") {
      volumes.push(identity!);
    } else if (kind === "processId" && /^[1-9][0-9]*$/u.test(identity!)) {
      processIds.push(Number(identity));
    } else {
      throw new Error("Jetson cleanup evidence is malformed");
    }
  }
  return validateCleanupEvidence({ schemaVersion: 1, volumes, processIds });
}

export class SshJetsonDispatchWorker implements JetsonDispatchWorker {
  readonly #config: SshJetsonWorkerConfig;
  readonly #runProcess: typeof runProcess;

  constructor(config: SshJetsonWorkerConfig, processRunner: typeof runProcess = runProcess) {
    this.#config = config;
    this.#runProcess = processRunner;
  }

  async run(
    request: JetsonDispatchRequest,
    options: { jobId: string; signal: AbortSignal },
  ): Promise<JetsonWorkerResult> {
    fs.rmSync(this.#baselinePath(options.jobId), { force: true });
    const baselineResult = await this.#runProcess({
      executable: "ssh",
      args: [...this.#sshArgs(), this.#config.destination, "bash", "-s"],
      input: PRESERVED_BASELINE_SCRIPT,
      signal: options.signal,
    });
    const baseline = parsePreservedBaseline(baselineResult.stdout);
    writePrivateRegularFile(this.#baselinePath(options.jobId), `${JSON.stringify(baseline)}\n`);
    const identityResult = await this.#runProcess({
      executable: "ssh",
      args: [...this.#sshArgs(), this.#config.destination, "bash", "-s"],
      input: DEVICE_IDENTITY_SCRIPT,
      signal: options.signal,
    });
    const device = parseDeviceIdentity(identityResult.stdout);
    let testResult: ProcessResult | undefined;
    let testError: unknown;
    try {
      testResult = await this.#runProcess({
        executable: "ssh",
        args: [
          ...this.#sshArgs(),
          this.#config.destination,
          "bash",
          "-s",
          "--",
          request.candidateSha,
          options.jobId,
          String(this.#config.testTimeoutSeconds),
        ],
        input: JETSON_TEST_SCRIPT,
        signal: options.signal,
      });
    } catch (error) {
      testError = error;
    }
    let artifactArchiveBase64: string | undefined;
    let artifactCollectionError: unknown;
    if (!options.signal.aborted) {
      try {
        artifactArchiveBase64 = await this.#collectArtifact(options.jobId, options.signal);
      } catch (error) {
        artifactCollectionError = error;
      }
    }
    if (testError instanceof ProcessFailure) {
      const collectionFailure =
        artifactCollectionError instanceof Error
          ? `; artifact collection failed: ${artifactCollectionError.message}`
          : "";
      const failure = new Error(`${testError.message}${collectionFailure}`) as Error & {
        artifactArchiveBase64?: string;
        log: string;
      };
      failure.log = [
        "=== Jetson identity ===",
        identityResult.stdout.trimEnd(),
        "=== Jetson E2E stdout ===",
        testError.result.stdout.trimEnd(),
        "=== Jetson E2E stderr ===",
        testError.result.stderr.trimEnd(),
        "",
      ].join("\n");
      if (artifactArchiveBase64 !== undefined) {
        failure.artifactArchiveBase64 = artifactArchiveBase64;
      }
      throw failure;
    }
    if (testError) throw testError;
    if (!testResult) throw new Error("Jetson E2E did not return a process result");
    if (artifactCollectionError) {
      const collectionMessage =
        artifactCollectionError instanceof Error
          ? artifactCollectionError.message
          : "artifact collection failed";
      const failure = new Error(collectionMessage) as Error & { log: string };
      failure.log = [
        "=== Jetson identity ===",
        identityResult.stdout.trimEnd(),
        "=== Jetson E2E stdout ===",
        testResult.stdout.trimEnd(),
        "=== Jetson E2E stderr ===",
        testResult.stderr.trimEnd(),
        "=== Jetson artifact collection error ===",
        collectionMessage,
        "",
      ].join("\n");
      throw failure;
    }
    if (artifactArchiveBase64 === undefined) {
      throw new Error("Successful Jetson E2E did not produce a bounded artifact archive");
    }
    return {
      artifactArchiveBase64,
      device,
      log: [
        "=== Jetson identity ===",
        identityResult.stdout.trimEnd(),
        "=== Jetson E2E stdout ===",
        testResult.stdout.trimEnd(),
        "=== Jetson E2E stderr ===",
        testResult.stderr.trimEnd(),
        "",
      ].join("\n"),
    };
  }

  async #collectArtifact(jobId: string, signal: AbortSignal): Promise<string | undefined> {
    const result = await this.#runProcess({
      executable: "ssh",
      args: [...this.#sshArgs(), this.#config.destination, "bash", "-s", "--", jobId],
      input: COLLECT_ARTIFACT_SCRIPT,
      signal,
    });
    if (result.stdout.length === 0) return undefined;
    decodeJetsonArtifactArchive(result.stdout);
    return result.stdout;
  }

  async cleanup(options: { jobId: string; signal: AbortSignal }): Promise<void> {
    const cleanupResult = await this.#runProcess({
      executable: this.#config.cleanupExecutable,
      args: [],
      signal: options.signal,
    });
    const reportedEvidence = parseCleanupCommandEvidence(cleanupResult.stdout);
    const evidencePath = this.#cleanupEvidencePath(options.jobId);
    const persistedRaw = readPrivateRegularFile(evidencePath, {
      allowMissing: true,
      maxBytes: MAX_CLEANUP_EVIDENCE_BYTES,
    });
    if (persistedRaw === null) throw new Error("Jetson cleanup evidence is missing");
    const persistedEvidence = parseCleanupEvidenceJson(persistedRaw);
    if (JSON.stringify(reportedEvidence) !== JSON.stringify(persistedEvidence)) {
      throw new Error("Jetson cleanup output differs from its durable resource evidence");
    }
    const serializedEvidence = `${JSON.stringify(persistedEvidence)}\n`;
    const expectedRaw = readPrivateRegularFile(this.#baselinePath(options.jobId), {
      allowMissing: true,
      maxBytes: MAX_BASELINE_RECORD_BYTES,
    });
    const verification = await this.#runProcess({
      executable: "ssh",
      args: [
        ...this.#sshArgs(),
        this.#config.destination,
        "bash",
        "-s",
        "--",
        options.jobId,
        Buffer.from(serializedEvidence).toString("base64"),
      ],
      input: CLEANUP_VERIFICATION_SCRIPT,
      signal: options.signal,
    });
    const actual = parsePreservedBaseline(verification.stdout);
    if (expectedRaw === null) return;
    const expected = parsePreservedBaselineJson(expectedRaw);
    if (!protectedHostBaselineMatches(expected, actual)) {
      throw new Error("Jetson protected tool baseline differs after cleanup");
    }
    if (!preservesOllamaModels(expected, actual)) {
      throw new Error("Jetson cleanup did not preserve every pre-existing Ollama model");
    }
  }

  #baselinePath(jobId: string): string {
    if (!/^[a-f0-9]{64}$/u.test(jobId)) throw new Error("Jetson job ID is invalid");
    return path.join(this.#config.stateDirectory, `${jobId}.baseline.json`);
  }

  #cleanupEvidencePath(jobId: string): string {
    if (!/^[a-f0-9]{64}$/u.test(jobId)) throw new Error("Jetson job ID is invalid");
    return path.join(this.#config.stateDirectory, `${jobId}.cleanup.json`);
  }

  #sshArgs(): string[] {
    return [
      "-F",
      "/dev/null",
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=15",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "ServerAliveCountMax=2",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      `UserKnownHostsFile=${this.#config.knownHostsFile}`,
      "-i",
      this.#config.identityFile,
    ];
  }
}
