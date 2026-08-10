// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { JetsonDispatchRequest } from "./jetson-dispatch-contract.mts";
import {
  decodeJetsonArtifactArchive,
  JetsonDeviceIdentity,
  JetsonDispatchWorker,
  JetsonWorkerResult,
  MAX_JETSON_ARTIFACT_ARCHIVE_BYTES,
} from "./jetson-dispatch-lifecycle.mts";

const MAX_PROCESS_OUTPUT_BYTES = 4 * 1024 * 1024;
const SSH_DESTINATION_PATTERN =
  /^[a-z_][a-z0-9_-]{0,31}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/u;
const SAFE_PROCESS_ENV = {
  LANG: "C.UTF-8",
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
};

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
  echo "Jetson E2E workspace already exists; reset recovery is required" >&2
  exit 1
fi
install -d -m 0700 "$workspace"

git init --quiet "$workspace/repository"
git -C "$workspace/repository" remote add origin https://github.com/NVIDIA/NemoClaw.git
git -C "$workspace/repository" fetch --quiet --depth=1 --no-tags origin "$candidate_sha"
fetched_sha="$(git -C "$workspace/repository" rev-parse FETCH_HEAD)"
[[ "$fetched_sha" == "$candidate_sha" ]]
git -C "$workspace/repository" checkout --quiet --detach "$candidate_sha"
cd "$workspace/repository"

node_major="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$node_major" == "22" ]] || {
  echo "Jetson E2E requires Node.js 22" >&2
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
`;

const COLLECT_ARTIFACT_SCRIPT = String.raw`set -euo pipefail
job_id="$1"
[[ "$job_id" =~ ^[a-f0-9]{64}$ ]]
workspace="/var/tmp/nemoclaw-jetson-e2e/$job_id"
cleanup() {
  rm -rf -- "$workspace"
}
trap cleanup EXIT

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
  destination: string;
  identityFile: string;
  knownHostsFile: string;
  resetExecutable: string;
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
  env: NodeJS.ProcessEnv = process.env,
): SshJetsonWorkerConfig {
  const destination = env.JETSON_DISPATCH_SSH_DESTINATION ?? "";
  if (!SSH_DESTINATION_PATTERN.test(destination)) {
    throw new Error("JETSON_DISPATCH_SSH_DESTINATION must be a fixed user and host");
  }
  const identityFile = env.JETSON_DISPATCH_SSH_IDENTITY_FILE ?? "";
  const knownHostsFile = env.JETSON_DISPATCH_SSH_KNOWN_HOSTS_FILE ?? "";
  const resetExecutable = env.JETSON_DISPATCH_RESET_EXECUTABLE ?? "";
  requireSecureFile(identityFile, { private: true });
  requireSecureFile(knownHostsFile, {});
  requireSecureFile(resetExecutable, { executable: true });
  return {
    destination,
    identityFile,
    knownHostsFile,
    resetExecutable,
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
    if (artifactCollectionError) throw artifactCollectionError;
    if (!testResult) throw new Error("Jetson E2E did not return a process result");
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

  async reset(options: { signal: AbortSignal }): Promise<void> {
    await this.#runProcess({
      executable: this.#config.resetExecutable,
      args: [],
      signal: options.signal,
    });
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
