// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { PodmanBoundContainerEngine } from "../../adapters/podman";
import type { SandboxGpuProofResult } from "../../state/registry";
import {
  getDockerDriverGatewayRuntimeMarkerPath,
  parseDockerDriverGatewayRuntimeMarker,
  readDockerDriverGatewayRuntimeMarker,
  resolveDockerDriverGatewayStateDir,
  writeDockerDriverGatewayPidFile,
  writeDockerDriverGatewayRuntimeMarker,
  type DockerDriverGatewayRuntimeMarker,
} from "../docker-driver-gateway-runtime-marker";
import {
  getTrustedActiveOpenShellGatewayUserServiceIdentity,
  startOpenShellGatewayUserService,
  stopOpenShellGatewayUserService,
} from "../docker-driver-gateway-service";
import { openshellSandboxCommandEnvValue } from "../docker-startup-command-env";
import type { ManagedStartupRootApplyRequest } from "../managed-startup/root-apply";
import type { RuntimeProviderBootstrapSurface } from "../runtime-provider/contract";
import {
  activateManagedBootstrapSequence,
  finalizeManagedBootstrapSequence,
  MANAGED_BOOTSTRAP_SCHEMA_VERSION,
  prepareManagedBootstrapSequence,
  renderManagedBootstrapHeldCommand,
  type ManagedBootstrapAdapter,
  type ManagedBootstrapAuthorityStore,
  type ManagedBootstrapCompletionReceipt,
  type ManagedBootstrapDiscoveredWorkload,
  type ManagedBootstrapFinalizationReceipt,
  type ManagedBootstrapHeldWorkloadHandle,
  type ManagedBootstrapObservedSnapshot,
  type ManagedBootstrapPreparedAuthority,
  type ManagedBootstrapPreparedReplacementHandle,
  type ManagedBootstrapRecoveryFailure,
  type ManagedBootstrapRecoveryReceipt,
  type ManagedBootstrapReplacementHandle,
} from "./adapter";
import { MANAGED_BOOTSTRAP_REQUEST_FILE } from "./envelope";
import {
  createFilePodmanBootstrapJournalStore,
  type PodmanBootstrapJournal,
  type PodmanBootstrapJournalStore,
  serializePodmanBootstrapJournal,
} from "./podman-bootstrap-journal";
import {
  PODMAN_BOOTSTRAP_REPLACEMENT_SCHEMA_VERSION,
  prepareStoppedPodmanBootstrapReplacement,
  rollbackPodmanBootstrapBeforeCommit,
  stopExactPodmanBootstrapOriginal,
  type PodmanBootstrapPreparedReplacement,
} from "./podman-bootstrap-replacement";
import {
  awaitPodmanBootstrapImageTransaction,
  startPodmanBootstrapImageTransaction,
  type PodmanBootstrapImageTransaction,
  type PodmanBootstrapImageTransactionCompletion,
} from "./podman-image-transaction";
import {
  inspectExactPodmanHeldWorkload,
  PODMAN_MANAGED_LABEL,
  PODMAN_SANDBOX_ID_LABEL,
  PODMAN_SANDBOX_NAME_LABEL,
  PODMAN_SANDBOX_NAMESPACE,
  PODMAN_SANDBOX_NAMESPACE_LABEL,
  PODMAN_SANDBOX_WORKSPACE,
  PODMAN_SANDBOX_WORKSPACE_LABEL,
  type PodmanHeldWorkloadObservation,
} from "./podman-held-workload";
import type {
  PodmanGatewayWatcherLease,
  PodmanGatewayWatcherLeaseHolder,
  PodmanGatewayWatcherLeaseRecord,
  PodmanGatewayWatcherLeaseStore,
  PodmanGatewayWatcherSnapshot,
  PodmanManagedGatewayWatcherController,
} from "./podman-watcher-lease";
import { createPodmanManagedGatewayWatcherController } from "./podman-watcher-lease";
import type {
  ManagedBootstrapRuntimeCreateLifecycle,
  ManagedBootstrapRuntimeCreateLifecycleInput,
  ManagedBootstrapRuntimeOnboardRouting,
  ManagedBootstrapRuntimeOnboardRoutingInput,
} from "./runtime-create";
import { createManagedBootstrapTerminalFinalizer } from "./runtime-create";

const PROVIDER_ID = "podman";
const BOOTSTRAP_EXECUTABLE = "/usr/local/bin/nemoclaw-managed-bootstrap";
const FULL_ID = /^[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ENV = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const LEASE_FILE = "managed-bootstrap-podman-watcher.json";
const STANDALONE_LAUNCH_FILE = "managed-bootstrap-podman-gateway-launch.json";
const MANAGED_BOOTSTRAP_TIMEOUT_MS = 300_000;
const PERSISTABLE_ENVIRONMENT_KEYS = new Set([
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LD_LIBRARY_PATH",
  "LOGNAME",
  "NEMOCLAW_DOCKER_ENABLE_BIND_MOUNTS",
  "NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE",
  "NEMOCLAW_RUNTIME_PROVIDER_ID",
  "NETAVARK_FW",
  "OPENSHELL_BIND_ADDRESS",
  "OPENSHELL_DB_URL",
  "OPENSHELL_DOCKER_NETWORK_NAME",
  "OPENSHELL_DOCKER_SUPERVISOR_BIN",
  "OPENSHELL_DOCKER_SUPERVISOR_IMAGE",
  "OPENSHELL_DRIVERS",
  "OPENSHELL_GATEWAY_CONFIG",
  "OPENSHELL_GRPC_ENDPOINT",
  "OPENSHELL_LOCAL_TLS_DIR",
  "OPENSHELL_PODMAN_SOCKET",
  "OPENSHELL_SERVER_PORT",
  "OPENSHELL_SSH_GATEWAY_HOST",
  "OPENSHELL_SSH_GATEWAY_PORT",
  "PATH",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TMPDIR",
  "USER",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "XDG_STATE_HOME",
]);

type JsonRecord = Record<string, unknown>;

interface PodmanManagedBootstrapAdapterOptions {
  readonly engine: PodmanBoundContainerEngine;
  readonly stateRoot: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly gatewayPort: number;
  readonly gatewayName?: string;
  readonly watcherController?: PodmanManagedGatewayWatcherController;
}

interface TransactionState {
  readonly held: PodmanHeldWorkloadObservation;
  readonly rawInspect: JsonRecord;
  readonly request: ManagedStartupRootApplyRequest;
  watcherLease?: PodmanGatewayWatcherLease;
  prepared?: PodmanBootstrapPreparedReplacement;
  imageTransaction?: PodmanBootstrapImageTransaction;
  completion?: PodmanBootstrapImageTransactionCompletion;
  contractReplacementSpecCanonical?: string;
  contractReplacementSpecHash?: string;
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Managed bootstrap Podman ${label} must be an object.`);
  }
  return value as JsonRecord;
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.includes("\0"))
  ) {
    throw new Error(`Managed bootstrap Podman ${label} must be a bounded string array.`);
  }
  return Object.freeze([...value]);
}

function commandFailure(
  action: string,
  result: ReturnType<PodmanBoundContainerEngine["capture"]>,
): never {
  const detail = (result.stderr || result.stdout || result.error?.message || "unknown failure")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(-600);
  throw new Error(
    `Managed bootstrap Podman ${action} failed (exit ${String(result.status)}): ${detail}`,
  );
}

function capture(
  engine: PodmanBoundContainerEngine,
  args: readonly string[],
  action: string,
  timeout = MANAGED_BOOTSTRAP_TIMEOUT_MS,
) {
  const result = engine.capture(args, timeout);
  if (result.status !== 0 || result.error) commandFailure(action, result);
  return result;
}

function inspectRuntime(engine: PodmanBoundContainerEngine, runtimeId: string): JsonRecord {
  if (!FULL_ID.test(runtimeId)) throw new Error("Managed bootstrap Podman runtime ID is invalid.");
  const result = capture(engine, ["container", "inspect", runtimeId], "container inspect", 15_000);
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error("Managed bootstrap Podman inspect returned unreadable JSON.");
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("Managed bootstrap Podman inspect must resolve exactly one container.");
  }
  const inspected = record(parsed[0], "inspect entry");
  if (String(inspected.Id ?? "").toLowerCase() !== runtimeId) {
    throw new Error("Managed bootstrap Podman inspect returned another runtime identity.");
  }
  return inspected;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalInspect(inspect: JsonRecord): string {
  // Podman emits its inspect object in a stable field order. Persist only the
  // provider-owned launch facets used to reproduce the exact replacement.
  const config = record(inspect.Config, "Config");
  const hostConfig = record(inspect.HostConfig ?? {}, "HostConfig");
  const networkSettings = record(inspect.NetworkSettings ?? {}, "NetworkSettings");
  const canonical = {
    Config: {
      Cmd: stringArray(config.Cmd ?? [], "Config.Cmd"),
      Entrypoint: stringArray(config.Entrypoint ?? [], "Config.Entrypoint"),
      Env: stringArray(config.Env ?? [], "Config.Env"),
      Labels: record(config.Labels ?? {}, "Config.Labels"),
      WorkingDir: String(config.WorkingDir ?? ""),
    },
    HostConfig: hostConfig,
    Mounts: Array.isArray(inspect.Mounts) ? inspect.Mounts : [],
    NetworkSettings: { Networks: networkSettings.Networks ?? {} },
  };
  return JSON.stringify(canonical);
}

function replacementCommand(
  handle: ManagedBootstrapHeldWorkloadHandle,
  snapshot: ManagedBootstrapObservedSnapshot,
): readonly string[] {
  return Object.freeze([
    "--agent",
    handle.plan.profile.agent,
    "--profile-fingerprint",
    handle.plan.profile.fingerprint,
    "--bootstrap-identity",
    handle.bootstrapIdentity,
    "--agent-uid",
    String(snapshot.agentIdentity.uid),
    "--agent-gid",
    String(snapshot.agentIdentity.gid),
    "--agent-workdir",
    snapshot.agentIdentity.workdir,
    "--request-file",
    MANAGED_BOOTSTRAP_REQUEST_FILE,
    "--",
    ...snapshot.supervisorArgv,
  ]);
}

function replacementEnvironment(
  inspect: JsonRecord,
  handle: ManagedBootstrapHeldWorkloadHandle,
): readonly string[] {
  const config = record(inspect.Config, "Config");
  const intended = openshellSandboxCommandEnvValue(handle.intendedWorkloadArgv);
  if (!intended) throw new Error("Managed bootstrap Podman intended workload argv is invalid.");
  const values = stringArray(config.Env ?? [], "Config.Env").filter(
    (entry) => !entry.startsWith("OPENSHELL_SANDBOX_COMMAND="),
  );
  if (values.some((entry) => !SAFE_ENV.test(entry))) {
    throw new Error("Managed bootstrap Podman environment contains an invalid assignment.");
  }
  values.push(`OPENSHELL_SANDBOX_COMMAND=${intended}`);
  return Object.freeze(values);
}

function networkArgs(inspect: JsonRecord): string[] {
  const settings = record(inspect.NetworkSettings ?? {}, "NetworkSettings");
  const networks = record(settings.Networks ?? {}, "NetworkSettings.Networks");
  const names = Object.keys(networks).sort();
  if (names.length > 1) {
    throw new Error(
      "Managed bootstrap Podman cannot reproduce an ambiguous multi-network runtime.",
    );
  }
  return names[0] ? ["--network", names[0]] : [];
}

function mountArgs(inspect: JsonRecord): string[] {
  if (!Array.isArray(inspect.Mounts)) return [];
  const args: string[] = [];
  for (const value of inspect.Mounts) {
    const mount = record(value, "mount");
    const type = String(mount.Type ?? "");
    const source = String(mount.Name ?? mount.Source ?? "");
    const destination = String(mount.Destination ?? "");
    if (!source || !destination || !path.isAbsolute(destination)) {
      throw new Error("Managed bootstrap Podman mount cannot be reproduced exactly.");
    }
    if (type !== "volume" && type !== "bind") {
      throw new Error(`Managed bootstrap Podman mount type '${type}' is unsupported.`);
    }
    const options = mount.RW === false ? ",ro" : "";
    args.push("--mount", `type=${type},source=${source},destination=${destination}${options}`);
  }
  return args;
}

function optionArgs(
  values: Readonly<Record<string, string | number | boolean | readonly string[]>>,
): string[] {
  const args: string[] = [];
  const gpu = values.gpuModeArgs;
  if (Array.isArray(gpu)) {
    for (let index = 0; index < gpu.length; index += 1) {
      const current = String(gpu[index]);
      if (current === "--gpus") {
        const selector = String(gpu[index + 1] ?? "");
        if (selector === "all") args.push("--device", "nvidia.com/gpu=all");
        index += 1;
      } else if (current === "--device") {
        args.push(current, String(gpu[index + 1] ?? ""));
        index += 1;
      }
    }
  }
  const limits = values.requiredUlimits;
  if (Array.isArray(limits)) {
    for (const limit of limits) args.push("--ulimit", String(limit));
  }
  const groups = values.extraGroupGids;
  if (Array.isArray(groups)) {
    for (const group of groups) args.push("--group-add", String(group));
  }
  return args;
}

function processStartIdentity(pid: number): string {
  const stat = fs.readFileSync(`/proc/${String(pid)}/stat`, "utf8");
  const end = stat.lastIndexOf(")");
  const fields = stat.slice(end + 2).split(" ");
  const start = fields[19];
  if (!start || !/^\d+$/u.test(start))
    throw new Error("Podman gateway process start identity is unavailable.");
  return `linux:${start}`;
}

function processState(pid: number): string | null {
  try {
    const status = fs.readFileSync(`/proc/${String(pid)}/status`, "utf8");
    return status.match(/^State:\s+([A-Z])/mu)?.[1] ?? null;
  } catch {
    return null;
  }
}

function processInstanceAlive(snapshot: PodmanGatewayWatcherSnapshot): boolean {
  const state = processState(snapshot.pid);
  if (state === null || state === "X" || state === "Z") return false;
  try {
    return processStartIdentity(snapshot.pid) === snapshot.processStartIdentity;
  } catch {
    return false;
  }
}

function atomicLeaseWrite(file: string, recordValue: PodmanGatewayWatcherLeaseRecord): void {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const descriptor = fs.openSync(
    temporary,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(recordValue)}\n`, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
  const directoryDescriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(directoryDescriptor);
  } finally {
    fs.closeSync(directoryDescriptor);
  }
}

function createFileWatcherLeaseStore(stateRoot: string): PodmanGatewayWatcherLeaseStore {
  const file = path.join(stateRoot, LEASE_FILE);
  const read = (): PodmanGatewayWatcherLeaseRecord | null => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as PodmanGatewayWatcherLeaseRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  return Object.freeze({
    read,
    acquire(recordValue: PodmanGatewayWatcherLeaseRecord) {
      if (read() !== null)
        throw new Error("Managed bootstrap Podman watcher lease already exists.");
      const directory = path.dirname(file);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const descriptor = fs.openSync(
        file,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_NOFOLLOW,
        0o600,
      );
      try {
        fs.writeFileSync(descriptor, `${JSON.stringify(recordValue)}\n`, "utf8");
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      const directoryDescriptor = fs.openSync(directory, "r");
      try {
        fs.fsyncSync(directoryDescriptor);
      } finally {
        fs.closeSync(directoryDescriptor);
      }
    },
    advance(expectedLeaseId: string, recordValue: PodmanGatewayWatcherLeaseRecord) {
      const current = read();
      if (!current || current.leaseId !== expectedLeaseId) {
        throw new Error("Managed bootstrap Podman watcher lease changed before advance.");
      }
      atomicLeaseWrite(file, recordValue);
    },
    clear(expectedLeaseId: string) {
      const current = read();
      if (!current || current.leaseId !== expectedLeaseId) {
        throw new Error("Managed bootstrap Podman watcher lease changed before release.");
      }
      fs.unlinkSync(file);
      const descriptor = fs.openSync(path.dirname(file), "r");
      try {
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
    },
  });
}

interface StandaloneGatewayLaunch {
  readonly executable: string;
  readonly argv0: string;
  readonly args: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly marker: DockerDriverGatewayRuntimeMarker;
  readonly pidFile: string;
  readonly markerFile: string;
}

export interface PersistedStandaloneGatewayEnvironmentEntry {
  readonly key: string;
  readonly valueHash: string;
  readonly literalValue?: string;
}

export function buildPodmanStandaloneGatewayEnvironmentAuthority(
  environment: NodeJS.ProcessEnv,
): readonly PersistedStandaloneGatewayEnvironmentEntry[] {
  return Object.freeze(
    Object.entries(environment)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .filter(([key]) => PERSISTABLE_ENVIRONMENT_KEYS.has(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => Object.freeze({ key, valueHash: sha256(value), literalValue: value })),
  );
}

interface PersistedStandaloneGatewayLaunch {
  readonly schemaVersion: 1;
  readonly launchIdentity: string;
  readonly executable: string;
  readonly argv0: string;
  readonly args: readonly string[];
  readonly environment: readonly PersistedStandaloneGatewayEnvironmentEntry[];
  readonly cwd: string;
  readonly marker: DockerDriverGatewayRuntimeMarker;
  readonly pidFile: string;
  readonly markerFile: string;
}

function writePrivateJson(file: string, value: unknown): void {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
    const directoryDescriptor = fs.openSync(directory, "r");
    try {
      fs.fsyncSync(directoryDescriptor);
    } finally {
      fs.closeSync(directoryDescriptor);
    }
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function persistedStandaloneGatewayLaunch(
  launchIdentity: string,
  launch: StandaloneGatewayLaunch,
): PersistedStandaloneGatewayLaunch {
  const environment = buildPodmanStandaloneGatewayEnvironmentAuthority(launch.environment);
  return Object.freeze({
    schemaVersion: 1 as const,
    launchIdentity,
    executable: launch.executable,
    argv0: launch.argv0,
    args: launch.args,
    environment: Object.freeze(environment),
    cwd: launch.cwd,
    marker: launch.marker,
    pidFile: launch.pidFile,
    markerFile: launch.markerFile,
  });
}

function loadPersistedStandaloneGatewayLaunch(
  file: string,
  expectedLaunchIdentity: string,
): StandaloneGatewayLaunch {
  const parsed = record(JSON.parse(fs.readFileSync(file, "utf8")), "gateway launch authority") as
    | JsonRecord
    | PersistedStandaloneGatewayLaunch;
  if (
    parsed.schemaVersion !== 1 ||
    parsed.launchIdentity !== expectedLaunchIdentity ||
    !Array.isArray(parsed.args) ||
    !Array.isArray(parsed.environment)
  ) {
    throw new Error("Managed Podman standalone gateway launch authority is invalid.");
  }
  const executable = String(parsed.executable ?? "");
  const argv0 = String(parsed.argv0 ?? "");
  const cwd = String(parsed.cwd ?? "");
  const pidFile = String(parsed.pidFile ?? "");
  const markerFile = String(parsed.markerFile ?? "");
  if (
    argv0.length === 0 ||
    argv0.includes("\0") ||
    ![executable, cwd, pidFile, markerFile].every(
      (value) => path.isAbsolute(value) && path.normalize(value) === value && !value.includes("\0"),
    )
  ) {
    throw new Error("Managed Podman standalone gateway launch paths are invalid.");
  }
  const args = stringArray(parsed.args, "gateway launch argv");
  const environment: NodeJS.ProcessEnv = {};
  for (const rawEntry of parsed.environment) {
    const entry = record(rawEntry, "gateway launch environment entry");
    const key = String(entry.key ?? "");
    const expectedHash = String(entry.valueHash ?? "");
    if (!PERSISTABLE_ENVIRONMENT_KEYS.has(key) || !SHA256.test(expectedHash)) {
      throw new Error("Managed Podman standalone gateway environment authority is invalid.");
    }
    const value = entry.literalValue;
    if (typeof value !== "string" || sha256(value) !== expectedHash) {
      throw new Error(
        `Managed Podman standalone gateway environment value '${key}' is unavailable for exact recovery.`,
      );
    }
    environment[key] = value;
  }
  const marker = parseDockerDriverGatewayRuntimeMarker(JSON.stringify(parsed.marker));
  if (
    !marker ||
    marker.driver !== PROVIDER_ID ||
    (marker.gatewayBin !== null && marker.gatewayBin !== executable)
  ) {
    throw new Error("Managed Podman standalone gateway runtime marker authority changed.");
  }
  return Object.freeze({
    executable,
    argv0,
    args,
    environment: Object.freeze(environment),
    cwd,
    marker,
    pidFile,
    markerFile,
  });
}

function removeStandaloneGatewayLaunchAuthority(
  file: string,
  expectedLaunchIdentity: string | null,
): void {
  let contents: unknown;
  try {
    contents = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const persisted = record(contents, "gateway launch authority");
  if (expectedLaunchIdentity !== null && persisted.launchIdentity !== expectedLaunchIdentity) {
    throw new Error("Managed Podman standalone gateway launch authority changed before cleanup.");
  }
  fs.unlinkSync(file);
  const descriptor = fs.openSync(path.dirname(file), "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function readProcessEnvironment(pid: number): NodeJS.ProcessEnv {
  return Object.fromEntries(
    fs
      .readFileSync(`/proc/${String(pid)}/environ`, "utf8")
      .split("\0")
      .filter(Boolean)
      .map((entry) => {
        const separator = entry.indexOf("=");
        if (separator <= 0)
          throw new Error("Managed bootstrap Podman gateway environment is invalid.");
        return [entry.slice(0, separator), entry.slice(separator + 1)];
      }),
  );
}

function readStandaloneGatewayLaunch(
  pid: number,
  marker: DockerDriverGatewayRuntimeMarker,
  pidFile: string,
  markerFile: string,
): StandaloneGatewayLaunch {
  const argv = fs
    .readFileSync(`/proc/${String(pid)}/cmdline`, "utf8")
    .split("\0")
    .filter(Boolean);
  if (argv.length === 0) throw new Error("Managed bootstrap Podman gateway argv is unavailable.");
  const executable = fs.realpathSync(`/proc/${String(pid)}/exe`);
  if (marker.gatewayBin && fs.realpathSync(marker.gatewayBin) !== executable) {
    throw new Error("Managed bootstrap Podman gateway executable changed from its runtime marker.");
  }
  return Object.freeze({
    executable,
    argv0: argv[0] as string,
    args: Object.freeze(argv.slice(1)),
    environment: Object.freeze(readProcessEnvironment(pid)),
    cwd: fs.realpathSync(`/proc/${String(pid)}/cwd`),
    marker,
    pidFile,
    markerFile,
  });
}

function waitForProcessExit(pid: number): void {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (processState(pid) === null || ["X", "Z"].includes(processState(pid) ?? "")) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  throw new Error("Managed bootstrap Podman gateway owner did not stop.");
}

function listenerPids(port: number): readonly number[] {
  const result = spawnSync("lsof", ["-ti", `:${String(port)}`, "-sTCP:LISTEN"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    throw new Error(
      "Managed bootstrap Podman could not enumerate the complete gateway listener set.",
    );
  }
  if (result.status === 1) return Object.freeze([]);
  return Object.freeze(
    String(result.stdout ?? "")
      .split(/\r?\n/u)
      .map((value) => Number(value.trim()))
      .filter((pid) => Number.isSafeInteger(pid) && pid > 0),
  );
}

function createProductionWatcherController(
  options: PodmanManagedBootstrapAdapterOptions,
): PodmanManagedGatewayWatcherController {
  const gatewayName = options.gatewayName ?? "nemoclaw";
  const stateDir = resolveDockerDriverGatewayStateDir(options.environment);
  const pidFile = path.join(stateDir, "openshell-gateway.pid");
  const markerFile = getDockerDriverGatewayRuntimeMarkerPath(stateDir);
  const standaloneLaunchFile = path.join(options.stateRoot, STANDALONE_LAUNCH_FILE);
  const standaloneLaunches = new Map<string, StandaloneGatewayLaunch>();
  const watcherStore = createFileWatcherLeaseStore(options.stateRoot);

  const snapshotForKnownPid = (pid: number): PodmanGatewayWatcherSnapshot => {
    const service = getTrustedActiveOpenShellGatewayUserServiceIdentity({
      env: options.environment,
      home: options.environment.HOME,
      platform: "linux",
    });
    const processStart = processStartIdentity(pid);
    if (service?.pid === pid) {
      const ownerIdentity = `managed-service:${service.executablePath ?? "openshell-gateway"}`;
      return Object.freeze({
        gatewayName,
        gatewayPort: options.gatewayPort,
        launchIdentity: sha256(`${gatewayName}\0${String(options.gatewayPort)}\0${ownerIdentity}`),
        ownerIdentity,
        ownerKind: "managed-service" as const,
        pid,
        processStartIdentity: processStart,
      });
    }
    const marker = readDockerDriverGatewayRuntimeMarker(markerFile);
    const recordedPid = Number(fs.readFileSync(pidFile, "utf8").trim());
    if (!marker || marker.driver !== PROVIDER_ID || marker.pid !== pid || recordedPid !== pid) {
      throw new Error("Managed bootstrap Podman gateway runtime marker does not own its listener.");
    }
    const endpoint = new URL(marker.endpoint);
    if (Number(endpoint.port) !== options.gatewayPort || marker.platform !== "linux") {
      throw new Error("Managed bootstrap Podman gateway runtime marker targets another gateway.");
    }
    const ownerIdentity = `standalone:${stateDir}:${marker.gatewayBin ?? "gateway"}`;
    const launchIdentity = sha256(
      `${gatewayName}\0${String(options.gatewayPort)}\0${ownerIdentity}\0${marker.desiredEnvHash}\0${marker.createdAt}`,
    );
    if (!standaloneLaunches.has(launchIdentity)) {
      const launch = readStandaloneGatewayLaunch(pid, marker, pidFile, markerFile);
      standaloneLaunches.set(launchIdentity, launch);
      writePrivateJson(
        standaloneLaunchFile,
        persistedStandaloneGatewayLaunch(launchIdentity, launch),
      );
    }
    return Object.freeze({
      gatewayName,
      gatewayPort: options.gatewayPort,
      launchIdentity,
      ownerIdentity,
      ownerKind: "standalone" as const,
      pid,
      processStartIdentity: processStart,
    });
  };

  const listTargetWatchers = (): readonly PodmanGatewayWatcherSnapshot[] =>
    listenerPids(options.gatewayPort).map((pid) => {
      try {
        return snapshotForKnownPid(pid);
      } catch {
        return Object.freeze({
          gatewayName,
          gatewayPort: options.gatewayPort,
          launchIdentity: `unproven-launch:${String(pid)}`,
          ownerIdentity: `unproven-owner:${String(pid)}`,
          ownerKind: "standalone" as const,
          pid,
          processStartIdentity: processStartIdentity(pid),
        });
      }
    });

  const controller = createPodmanManagedGatewayWatcherController({
    store: watcherStore,
    captureCurrent() {
      const listeners = listenerPids(options.gatewayPort);
      if (listeners.length !== 1) {
        throw new Error("Managed bootstrap Podman requires exactly one gateway listener.");
      }
      return snapshotForKnownPid(listeners[0] as number);
    },
    listTargetWatchers,
    isProcessInstanceAlive: processInstanceAlive,
    captureLeaseHolder: (): PodmanGatewayWatcherLeaseHolder => ({
      pid: process.pid,
      processStartIdentity: processStartIdentity(process.pid),
    }),
    isLeaseHolderAlive: (holder) =>
      processInstanceAlive({
        gatewayName,
        gatewayPort: options.gatewayPort,
        launchIdentity: "lease-holder",
        ownerIdentity: "lease-holder",
        ownerKind: "standalone",
        pid: holder.pid,
        processStartIdentity: holder.processStartIdentity,
      }),
    isOwnerStopped(snapshot) {
      if (snapshot.ownerKind === "managed-service") {
        return (
          getTrustedActiveOpenShellGatewayUserServiceIdentity({
            env: options.environment,
            home: options.environment.HOME,
            platform: "linux",
          }) === null
        );
      }
      return !listTargetWatchers().some(
        (candidate) =>
          candidate.ownerKind === snapshot.ownerKind &&
          candidate.ownerIdentity === snapshot.ownerIdentity &&
          candidate.launchIdentity === snapshot.launchIdentity,
      );
    },
    stopExactOwner(snapshot) {
      if (snapshot.ownerKind === "managed-service") {
        const stopped = stopOpenShellGatewayUserService({
          env: options.environment,
          home: options.environment.HOME,
          platform: "linux",
        });
        if (!stopped.attempted || !stopped.stopped) {
          throw new Error(stopped.reason ?? "Managed Podman gateway service did not stop.");
        }
        return;
      }
      process.kill(snapshot.pid, "SIGTERM");
      waitForProcessExit(snapshot.pid);
    },
    resumeSameOwner(snapshot) {
      if (snapshot.ownerKind === "managed-service") {
        const started = startOpenShellGatewayUserService({
          env: options.environment,
          home: options.environment.HOME,
          platform: "linux",
        });
        if (!started.attempted || !started.started) {
          throw new Error(started.reason ?? "Managed Podman gateway service did not resume.");
        }
        return;
      }
      const launch =
        standaloneLaunches.get(snapshot.launchIdentity) ??
        loadPersistedStandaloneGatewayLaunch(standaloneLaunchFile, snapshot.launchIdentity);
      const child = spawn(launch.executable, [...launch.args], {
        argv0: launch.argv0,
        cwd: launch.cwd,
        detached: true,
        env: launch.environment,
        stdio: "ignore",
      });
      child.unref();
      if (!child.pid) throw new Error("Managed Podman standalone gateway did not return a pid.");
      writeDockerDriverGatewayPidFile(launch.pidFile, child.pid);
      writeDockerDriverGatewayRuntimeMarker(launch.markerFile, {
        ...launch.marker,
        pid: child.pid,
      });
    },
    isHealthy(snapshot) {
      return (
        processInstanceAlive(snapshot) && listenerPids(options.gatewayPort).includes(snapshot.pid)
      );
    },
  });
  const wrapLease = (lease: PodmanGatewayWatcherLease): PodmanGatewayWatcherLease =>
    Object.freeze({
      record: lease.record,
      assertStillStopped: lease.assertStillStopped,
      resumeAndProve() {
        lease.resumeAndProve();
        if (lease.record.ownerKind === "standalone") {
          removeStandaloneGatewayLaunchAuthority(standaloneLaunchFile, lease.record.launchIdentity);
          standaloneLaunches.delete(lease.record.launchIdentity);
        }
      },
    });
  return Object.freeze({
    recoverUnfinishedLease() {
      const recordValue = watcherStore.read();
      controller.recoverUnfinishedLease();
      if (recordValue?.ownerKind === "standalone") {
        removeStandaloneGatewayLaunchAuthority(standaloneLaunchFile, recordValue.launchIdentity);
        standaloneLaunches.delete(recordValue.launchIdentity);
      }
    },
    reclaimStoppedLease: (expectedLeaseId: string) =>
      wrapLease(controller.reclaimStoppedLease(expectedLeaseId)),
    quiesceAndProve() {
      try {
        return wrapLease(controller.quiesceAndProve());
      } catch (error) {
        // When quiescence restored the exact owner and cleared its lease, its
        // launch authority must not remain consumable by a later transaction.
        if (watcherStore.read() === null) {
          removeStandaloneGatewayLaunchAuthority(standaloneLaunchFile, null);
          standaloneLaunches.clear();
        }
        throw error;
      }
    },
  });
}

function sandboxIdentity(journal: PodmanBootstrapJournal) {
  return Object.freeze({
    sandboxName: journal.sandboxName,
    sandboxId: journal.sandboxId,
    driverId: PROVIDER_ID,
  });
}

function heldFromJournal(
  journal: PodmanBootstrapJournal,
  engine: PodmanBoundContainerEngine,
): PodmanHeldWorkloadObservation {
  const inspect = inspectRuntime(engine, journal.originalRuntimeId);
  const config = record(inspect.Config, "Config");
  return Object.freeze({
    containerName: journal.originalContainerName,
    heldWorkloadArgv: [],
    imageContentId: journal.originalImageContentId,
    labels: record(config.Labels ?? {}, "Config.Labels") as Readonly<Record<string, string>>,
    runtimeId: journal.originalRuntimeId,
    // The journal records the original after stable running capture. Recovery
    // separately re-inspects its current state before deciding whether to start it.
    running: true,
    sandboxId: journal.sandboxId,
    sandboxName: journal.sandboxName,
    supervisorArgv: Object.freeze([
      ...stringArray(config.Entrypoint ?? [], "Config.Entrypoint"),
      ...stringArray(config.Cmd ?? [], "Config.Cmd"),
    ]),
  });
}

function runtimeExists(engine: PodmanBoundContainerEngine, runtimeId: string): boolean {
  const result = engine.capture(["container", "exists", runtimeId], 15_000);
  if (!result.error && result.status === 0) return true;
  if (!result.error && result.status === 1) return false;
  return commandFailure("container existence proof", result);
}

function exactImageContentId(value: unknown): string {
  const normalized = String(value ?? "").toLowerCase();
  const match = normalized.match(/^(?:sha256:)?([a-f0-9]{64})$/u);
  if (!match?.[1]) {
    throw new Error("Managed bootstrap Podman inspect image identity is invalid.");
  }
  return `sha256:${match[1]}`;
}

function proveJournalRuntime(
  engine: PodmanBoundContainerEngine,
  journal: PodmanBootstrapJournal,
  runtimeId: string,
  allowedNames: readonly string[],
  expectedImageContentId: string,
): JsonRecord {
  const first = inspectRuntime(engine, runtimeId);
  const second = inspectRuntime(engine, runtimeId);
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    throw new Error("Managed bootstrap Podman runtime changed during stable inspection.");
  }
  const name = String(second.Name ?? "").replace(/^\//u, "");
  const config = record(second.Config, "Config");
  const labels = record(config.Labels ?? {}, "Config.Labels") as Readonly<Record<string, string>>;
  if (
    !allowedNames.includes(name) ||
    exactImageContentId(second.Image) !== expectedImageContentId ||
    labels[PODMAN_MANAGED_LABEL] !== "true" ||
    labels[PODMAN_SANDBOX_ID_LABEL] !== journal.sandboxId ||
    labels[PODMAN_SANDBOX_NAME_LABEL] !== journal.sandboxName ||
    labels[PODMAN_SANDBOX_NAMESPACE_LABEL] !== PODMAN_SANDBOX_NAMESPACE ||
    labels[PODMAN_SANDBOX_WORKSPACE_LABEL] !== PODMAN_SANDBOX_WORKSPACE
  ) {
    throw new Error(
      "Managed bootstrap Podman runtime does not match its exact durable ownership authority.",
    );
  }
  return second;
}

interface FinishCommittedPodmanBootstrapInput {
  readonly engine: PodmanBoundContainerEngine;
  readonly journalStore: PodmanBootstrapJournalStore;
  readonly journal: PodmanBootstrapJournal;
  readonly watcherLease: PodmanGatewayWatcherLease;
}

/** Finish a durably authorized Podman replacement without guessing a runtime identity. */
export function finishCommittedPodmanBootstrap(
  input: FinishCommittedPodmanBootstrapInput,
): PodmanBootstrapJournal {
  const { engine, journalStore, watcherLease } = input;
  const journal = journalStore.load(input.journal.bootstrapIdentity);
  if (
    !journal ||
    (journal.phase !== "commit-authorized" && journal.phase !== "committed") ||
    journal.engineAuthorityId !== engine.authorityId ||
    journal.watcherLeaseId !== watcherLease.record.leaseId ||
    journal.replacementRuntimeId === null
  ) {
    throw new Error("Managed bootstrap Podman commit authority changed before finalization.");
  }
  watcherLease.assertStillStopped();

  if (runtimeExists(engine, journal.originalRuntimeId)) {
    proveJournalRuntime(
      engine,
      journal,
      journal.originalRuntimeId,
      [journal.originalContainerName],
      journal.originalImageContentId,
    );
    capture(engine, ["container", "rm", journal.originalRuntimeId], "original cleanup");
  }
  if (runtimeExists(engine, journal.originalRuntimeId)) {
    throw new Error("Managed bootstrap Podman original remained after exact commit removal.");
  }
  if (!runtimeExists(engine, journal.replacementRuntimeId)) {
    throw new Error("Managed bootstrap Podman replacement disappeared after commit authorization.");
  }
  const replacement = proveJournalRuntime(
    engine,
    journal,
    journal.replacementRuntimeId,
    [journal.replacementStagingName, journal.originalContainerName],
    journal.replacementImageContentId,
  );
  const currentName = String(replacement.Name ?? "").replace(/^\//u, "");
  if (currentName === journal.replacementStagingName) {
    capture(
      engine,
      ["container", "rename", journal.replacementRuntimeId, journal.originalContainerName],
      "replacement activation rename",
    );
  }
  proveJournalRuntime(
    engine,
    journal,
    journal.replacementRuntimeId,
    [journal.originalContainerName],
    journal.replacementImageContentId,
  );
  watcherLease.assertStillStopped();
  const committed = journalStore.recordCommitted(journal.bootstrapIdentity);
  journalStore.removeAfterCommit(journal.bootstrapIdentity);
  return committed;
}

function completionReceipt(
  handle: ManagedBootstrapHeldWorkloadHandle,
  snapshot: ManagedBootstrapObservedSnapshot,
  replacement: PodmanBootstrapPreparedReplacement,
  completion: PodmanBootstrapImageTransactionCompletion,
  replacementSpecHash: string,
): ManagedBootstrapCompletionReceipt {
  return Object.freeze({
    schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
    sandbox: handle.sandbox,
    runtimeId: replacement.replacementRuntimeId,
    image: snapshot.image,
    runtimeImageContentId: replacement.replacementImageContentId,
    originalSpecHash: snapshot.specHash,
    replacementSpecHash,
    profileFingerprint: handle.plan.profile.fingerprint,
    bootstrapIdentity: handle.bootstrapIdentity,
    transactionPending: completion.transactionPending,
    completedAt: completion.completedAt,
  });
}

export function createPodmanManagedBootstrapAdapter(
  options: PodmanManagedBootstrapAdapterOptions,
): ManagedBootstrapAdapter {
  if (options.engine.operation !== "managed-bootstrap" || options.engine.engineId !== PROVIDER_ID) {
    throw new Error("Managed bootstrap Podman requires an operation-scoped engine.");
  }
  const journalStore = createFilePodmanBootstrapJournalStore(options.stateRoot);
  const watcherController = options.watcherController ?? createProductionWatcherController(options);
  const transactions = new Map<string, TransactionState>();

  return Object.freeze({
    async recoverUnfinishedTransactions() {
      const receipts: ManagedBootstrapRecoveryReceipt[] = [];
      const failures: ManagedBootstrapRecoveryFailure[] = [];
      const unfinished = journalStore.listUnfinished();
      if (unfinished.length === 0) {
        // Commit/rollback compacts its journal before resuming the gateway. A
        // crash in that final window leaves only the durable watcher lease.
        watcherController.recoverUnfinishedLease();
      }
      for (const journal of unfinished) {
        try {
          const lease = watcherController.reclaimStoppedLease(journal.watcherLeaseId);
          const committed = journal.phase === "commit-authorized" || journal.phase === "committed";
          if (committed) {
            finishCommittedPodmanBootstrap({
              engine: options.engine,
              journalStore,
              journal,
              watcherLease: lease,
            });
          } else {
            const held = heldFromJournal(journal, options.engine);
            rollbackPodmanBootstrapBeforeCommit({
              bootstrapIdentity: journal.bootstrapIdentity,
              engine: options.engine,
              heldWorkload: held,
              journalStore,
              watcherLease: lease,
            });
          }
          lease.resumeAndProve();
          receipts.push(
            Object.freeze({
              schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
              providerId: PROVIDER_ID,
              sourcePhase: journal.phase,
              sandbox: sandboxIdentity(journal),
              bootstrapIdentity: journal.bootstrapIdentity,
              outcome: committed ? ("committed" as const) : ("rolled-back" as const),
              finalization: Object.freeze({
                schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
                sandbox: sandboxIdentity(journal),
                bootstrapIdentity: journal.bootstrapIdentity,
                outcome: committed ? ("committed" as const) : ("rolled-back" as const),
                restoredRuntimeId: committed
                  ? journal.replacementRuntimeId
                  : journal.originalRuntimeId,
                restoredSpecHash: committed
                  ? journal.replacementSpecFingerprint
                  : journal.originalSpecFingerprint,
                heldWorkloadRemoved: committed,
                alreadyRolledBack: false,
                finalizedAt: new Date().toISOString(),
              }),
            }),
          );
        } catch (error) {
          failures.push(
            Object.freeze({
              schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
              providerId: PROVIDER_ID,
              sourcePhase: journal.phase,
              sandbox: sandboxIdentity(journal),
              bootstrapIdentity: journal.bootstrapIdentity,
              code:
                journal.phase === "commit-authorized" || journal.phase === "committed"
                  ? "podman-commit-incomplete"
                  : "podman-rollback-incomplete",
              retryable: true,
              detail: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      }
      return Object.freeze({
        receipts: Object.freeze(receipts),
        failures: Object.freeze(failures),
      });
    },

    async createHeldWorkload(input: Parameters<ManagedBootstrapAdapter["createHeldWorkload"]>[0]) {
      if (input.plan.driverId !== PROVIDER_ID) {
        throw new Error("Managed bootstrap Podman received another provider plan.");
      }
      const bootstrapIdentity = input.bootstrapIdentity;
      if (!bootstrapIdentity || !SHA256.test(bootstrapIdentity)) {
        throw new Error("Managed bootstrap Podman bootstrap identity is invalid.");
      }
      const heldWorkloadArgv = renderManagedBootstrapHeldCommand(
        input.request,
        bootstrapIdentity,
        input.plan.intendedWorkloadArgv,
      );
      const createReceipt = await input.launch({ heldWorkloadArgv, bootstrapIdentity });
      const held = inspectExactPodmanHeldWorkload({
        engine: options.engine,
        sandboxName: input.plan.sandboxName,
        sandboxId: createReceipt.sandbox.sandboxId,
        sandboxNamespace: "",
        bootstrapIdentity,
        expectedHeldWorkloadArgv: heldWorkloadArgv,
        expectedSupervisorArgv: input.plan.expectedSupervisorArgv,
      });
      transactions.set(bootstrapIdentity, {
        held,
        rawInspect: inspectRuntime(options.engine, held.runtimeId),
        request: input.request,
      });
      return Object.freeze({
        schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
        sandbox: createReceipt.sandbox,
        bootstrapIdentity,
        heldWorkloadArgv: Object.freeze(heldWorkloadArgv),
        intendedWorkloadArgv: Object.freeze([...input.plan.intendedWorkloadArgv]),
        plan: input.plan,
        createReceipt,
      });
    },

    async cleanupIncompleteCreate(
      input: Parameters<ManagedBootstrapAdapter["cleanupIncompleteCreate"]>[0],
    ) {
      const observation = inspectExactPodmanHeldWorkload({
        engine: options.engine,
        sandboxName: input.plan.sandboxName,
        sandboxId: input.createReceipt.sandbox.sandboxId,
        sandboxNamespace: "",
        bootstrapIdentity: input.bootstrapIdentity,
        expectedHeldWorkloadArgv: input.heldWorkloadArgv,
        expectedSupervisorArgv: input.plan.expectedSupervisorArgv,
      });
      capture(
        options.engine,
        ["container", "rm", "--force", observation.runtimeId],
        "incomplete create cleanup",
      );
      return Object.freeze({
        schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
        sandbox: input.createReceipt.sandbox,
        bootstrapIdentity: input.bootstrapIdentity,
        outcome: "rolled-back",
        restoredRuntimeId: null,
        restoredSpecHash: null,
        heldWorkloadRemoved: true,
        alreadyRolledBack: false,
        finalizedAt: new Date().toISOString(),
      });
    },

    async discoverHeldWorkload(
      input: Parameters<ManagedBootstrapAdapter["discoverHeldWorkload"]>[0],
    ): Promise<ManagedBootstrapDiscoveredWorkload> {
      const pending = transactions.get(input.bootstrapIdentity);
      const handle = pending?.held;
      if (handle) {
        return Object.freeze({
          sandbox: input.sandbox,
          runtimeId: handle.runtimeId,
          bootstrapIdentity: input.bootstrapIdentity,
        });
      }
      throw new Error("Managed bootstrap Podman discovery has no exact create authority.");
    },

    async inspectHeldWorkload({
      handle,
      discovered,
    }: Parameters<ManagedBootstrapAdapter["inspectHeldWorkload"]>[0]) {
      const existing = transactions.get(handle.bootstrapIdentity);
      if (!existing) {
        throw new Error("Managed bootstrap Podman lost its exact create authority.");
      }
      const held = existing.held;
      if (held.runtimeId !== discovered.runtimeId) {
        throw new Error("Managed bootstrap Podman discovery identity changed.");
      }
      const rawInspect = inspectRuntime(options.engine, held.runtimeId);
      const canonical = canonicalInspect(rawInspect);
      transactions.set(handle.bootstrapIdentity, {
        held,
        rawInspect,
        request: existing.request,
      });
      return Object.freeze({
        schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
        sandbox: handle.sandbox,
        runtimeId: held.runtimeId,
        bootstrapIdentity: handle.bootstrapIdentity,
        image: handle.plan.image,
        runtimeImageContentId: held.imageContentId,
        specHash: sha256(canonical),
        specCanonicalJson: canonical,
        agentIdentity: handle.plan.agentIdentity,
        supervisorArgv: held.supervisorArgv,
        heldWorkloadArgv: handle.heldWorkloadArgv,
        metadata: handle.plan.metadata,
      });
    },

    async prepareBootstrapReplacement({
      handle,
      snapshot,
      request,
      replacementOptions,
    }: Parameters<ManagedBootstrapAdapter["prepareBootstrapReplacement"]>[0]) {
      const current = transactions.get(handle.bootstrapIdentity);
      if (!current || current.held.runtimeId !== snapshot.runtimeId) {
        throw new Error("Managed bootstrap Podman lost its exact held workload authority.");
      }
      const watcherLease = watcherController.quiesceAndProve();
      current.watcherLease = watcherLease;
      let prepared: PodmanBootstrapPreparedReplacement;
      try {
        prepared = prepareStoppedPodmanBootstrapReplacement({
          engine: options.engine,
          journalStore,
          watcherLease,
          plan: {
            schemaVersion: PODMAN_BOOTSTRAP_REPLACEMENT_SCHEMA_VERSION,
            bootstrapIdentity: handle.bootstrapIdentity,
            heldWorkload: current.held,
            runtimeArgs: Object.freeze([
              ...networkArgs(current.rawInspect),
              ...mountArgs(current.rawInspect),
              ...optionArgs(replacementOptions.values),
            ]),
            environment: replacementEnvironment(current.rawInspect, handle),
            entrypointArgv: [BOOTSTRAP_EXECUTABLE],
            commandArgv: replacementCommand(handle, snapshot),
            replacementImageContentId: snapshot.runtimeImageContentId,
          },
        });
      } catch (error) {
        try {
          if (journalStore.load(handle.bootstrapIdentity)) {
            rollbackPodmanBootstrapBeforeCommit({
              bootstrapIdentity: handle.bootstrapIdentity,
              engine: options.engine,
              heldWorkload: current.held,
              journalStore,
              watcherLease,
            });
          }
        } finally {
          watcherLease.resumeAndProve();
        }
        throw error;
      }
      current.prepared = prepared;
      const contractReplacementSpecCanonical = JSON.stringify({
        providerId: PROVIDER_ID,
        originalRuntimeId: snapshot.runtimeId,
        replacementRuntimeId: prepared.replacementRuntimeId,
        replacementImageContentId: prepared.replacementImageContentId,
        replacementSpecFingerprint: prepared.replacementSpecFingerprint,
      });
      const contractReplacementSpecHash = sha256(contractReplacementSpecCanonical);
      current.contractReplacementSpecCanonical = contractReplacementSpecCanonical;
      current.contractReplacementSpecHash = contractReplacementSpecHash;
      return Object.freeze({
        schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
        sandbox: handle.sandbox,
        bootstrapIdentity: handle.bootstrapIdentity,
        originalRuntimeId: snapshot.runtimeId,
        preparedRuntimeId: prepared.replacementRuntimeId,
        image: snapshot.image,
        runtimeImageContentId: prepared.replacementImageContentId,
        originalSpecHash: snapshot.specHash,
        preparedSpecHash: contractReplacementSpecHash,
        preparedSpecCanonicalJson: contractReplacementSpecCanonical,
        expectedActivatedSpecHash: contractReplacementSpecHash,
        expectedActivatedSpecCanonicalJson: contractReplacementSpecCanonical,
        profileFingerprint: request.profileFingerprint,
        rollbackAuthority: serializePodmanBootstrapJournal(prepared.journal),
      });
    },

    async activateBootstrapReplacement({
      handle,
      snapshot,
      prepared,
    }: Parameters<ManagedBootstrapAdapter["activateBootstrapReplacement"]>[0]) {
      const current = transactions.get(handle.bootstrapIdentity);
      if (
        !current?.prepared ||
        !current.watcherLease ||
        !current.contractReplacementSpecHash ||
        !current.contractReplacementSpecCanonical ||
        current.prepared.replacementRuntimeId !== prepared.preparedRuntimeId
      ) {
        throw new Error("Managed bootstrap Podman prepared authority changed before activation.");
      }
      current.prepared = stopExactPodmanBootstrapOriginal({
        engine: options.engine,
        heldWorkload: current.held,
        journalStore,
        prepared: current.prepared,
        watcherLease: current.watcherLease,
      });
      current.imageTransaction = startPodmanBootstrapImageTransaction({
        engine: options.engine,
        journalStore,
        watcherLease: current.watcherLease,
        agent: handle.plan.profile.agent,
        prepared: current.prepared,
        profileFingerprint: handle.plan.profile.fingerprint,
        request: current.request,
      });
      return Object.freeze({
        schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
        sandbox: handle.sandbox,
        bootstrapIdentity: handle.bootstrapIdentity,
        originalRuntimeId: snapshot.runtimeId,
        replacementRuntimeId: current.prepared.replacementRuntimeId,
        image: snapshot.image,
        runtimeImageContentId: current.prepared.replacementImageContentId,
        originalSpecHash: snapshot.specHash,
        replacementSpecHash: current.contractReplacementSpecHash,
        replacementSpecCanonicalJson: current.contractReplacementSpecCanonical,
        profileFingerprint: handle.plan.profile.fingerprint,
      });
    },

    async awaitBootstrap({
      handle,
      snapshot,
      replacement: _replacement,
      timeoutSecs,
    }: Parameters<ManagedBootstrapAdapter["awaitBootstrap"]>[0]) {
      const current = transactions.get(handle.bootstrapIdentity);
      if (
        !current?.prepared ||
        !current.imageTransaction ||
        !current.watcherLease ||
        !current.contractReplacementSpecHash
      ) {
        throw new Error("Managed bootstrap Podman image transaction is unavailable.");
      }
      const completion = awaitPodmanBootstrapImageTransaction({
        engine: options.engine,
        journalStore,
        prepared: current.prepared,
        watcherLease: current.watcherLease,
        transaction: current.imageTransaction,
        timeoutSecs,
      });
      current.completion = completion;
      return completionReceipt(
        handle,
        snapshot,
        current.prepared,
        completion,
        current.contractReplacementSpecHash,
      );
    },

    async finalizeBootstrap(
      input: Parameters<ManagedBootstrapAdapter["finalizeBootstrap"]>[0],
    ): Promise<ManagedBootstrapFinalizationReceipt> {
      const current = transactions.get(input.handle.bootstrapIdentity);
      if (!current?.prepared || !current.watcherLease)
        throw new Error("Managed bootstrap Podman transaction is unavailable.");
      if (input.outcome === "rollback") {
        const receipt = rollbackPodmanBootstrapBeforeCommit({
          bootstrapIdentity: input.handle.bootstrapIdentity,
          engine: options.engine,
          heldWorkload: current.held,
          journalStore,
          watcherLease: current.watcherLease,
        });
        current.watcherLease.resumeAndProve();
        transactions.delete(input.handle.bootstrapIdentity);
        return Object.freeze({
          schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
          sandbox: input.handle.sandbox,
          bootstrapIdentity: input.handle.bootstrapIdentity,
          outcome: "rolled-back",
          restoredRuntimeId: receipt.originalRuntimeId,
          restoredSpecHash: input.snapshot?.specHash ?? null,
          heldWorkloadRemoved: false,
          alreadyRolledBack: false,
          finalizedAt: new Date().toISOString(),
        });
      }
      if (!current.completion || !input.completion) {
        throw new Error("Managed bootstrap Podman commit requires image completion authority.");
      }
      const journal = journalStore.authorizeCommit(input.handle.bootstrapIdentity, [
        "original-stopped",
      ]);
      finishCommittedPodmanBootstrap({
        engine: options.engine,
        journalStore,
        journal,
        watcherLease: current.watcherLease,
      });
      current.watcherLease.resumeAndProve();
      transactions.delete(input.handle.bootstrapIdentity);
      return Object.freeze({
        schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
        sandbox: input.handle.sandbox,
        bootstrapIdentity: input.handle.bootstrapIdentity,
        outcome: "committed",
        restoredRuntimeId: current.prepared.replacementRuntimeId,
        restoredSpecHash:
          current.contractReplacementSpecHash ?? current.prepared.replacementSpecFingerprint,
        heldWorkloadRemoved: true,
        alreadyRolledBack: false,
        finalizedAt: new Date().toISOString(),
      });
    },
  });
}

export function createPodmanManagedBootstrapAuthorityStore(
  stateRoot: string,
): ManagedBootstrapAuthorityStore {
  const store = createFilePodmanBootstrapJournalStore(stateRoot);
  return Object.freeze({
    async recordPreparedAuthority(authority: ManagedBootstrapPreparedAuthority) {
      const journal = store.load(authority.bootstrapIdentity);
      if (!journal || serializePodmanBootstrapJournal(journal) !== authority.rollbackAuthority) {
        throw new Error(
          "Managed bootstrap Podman prepared authority does not match its durable journal.",
        );
      }
      return Object.freeze({
        schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
        sandbox: authority.sandbox,
        bootstrapIdentity: authority.bootstrapIdentity,
        authorityFingerprint: authority.authorityFingerprint,
        recordId: `podman-managed-bootstrap/${authority.bootstrapIdentity}`,
        recordedAt: new Date().toISOString(),
      });
    },
  });
}

function createPodmanRuntimePatch(
  sandboxName: string,
  input: ManagedBootstrapRuntimeCreateLifecycleInput,
) {
  let finalizer: ReturnType<typeof createManagedBootstrapTerminalFinalizer> | null = null;
  const selectedMode = input.sandboxGpuConfig.sandboxGpuEnabled
    ? Object.freeze({
        kind: "podman-cdi",
        label: "Podman CDI",
        device: input.sandboxGpuConfig.sandboxGpuDevice ?? "",
        args: Object.freeze(
          input.sandboxGpuConfig.sandboxGpuDevice
            ? ["--device", input.sandboxGpuConfig.sandboxGpuDevice]
            : [],
        ),
      })
    : null;
  return {
    attach(value: ReturnType<typeof createManagedBootstrapTerminalFinalizer>) {
      finalizer = value;
    },
    patch: Object.freeze({
      maybeApplyDuringCreate: () => undefined,
      replacementRuntimeId: () => null,
      createFailureMessage: () => null,
      exitOnPatchError: () => undefined,
      rollbackManagedStartupAfterCreateFailure: async () => {
        await finalizer?.rollback();
      },
      ensureApplied: () => undefined,
      waitForSupervisorReconnectIfNeeded: () => undefined,
      commitAfterReady: async () => {
        await finalizer?.commit();
      },
      selectedMode: () => selectedMode,
      printReadinessFailureIfEnabled: () => undefined,
      verifyGpuOrExit: async (
        verify: (sandboxName: string) => SandboxGpuProofResult,
      ): Promise<SandboxGpuProofResult> => verify(sandboxName),
    }),
  };
}

function createLifecycle(
  engine: PodmanBoundContainerEngine,
  input: ManagedBootstrapRuntimeCreateLifecycleInput,
): ManagedBootstrapRuntimeCreateLifecycle {
  if (input.providerId !== PROVIDER_ID) {
    throw new Error("Managed bootstrap Podman received another provider identity.");
  }
  const adapter =
    input.adapterOverride ??
    createPodmanManagedBootstrapAdapter({
      engine,
      stateRoot: input.stateRoot,
      environment: process.env,
      gatewayPort: input.network.gatewayPort,
    });
  const authorityStore = input.authorityStore;
  const runtimePatch = createPodmanRuntimePatch(input.sandboxName, input);
  return Object.freeze({
    launchArgv: input.launchArgv,
    patch: runtimePatch.patch,
    recoverUnfinished: () => adapter.recoverUnfinishedTransactions(),
    prepareNetwork: async () => undefined,
    async runCreate<T>(
      launch: (value: {
        readonly heldWorkloadArgv: readonly string[];
        readonly bootstrapIdentity: string;
      }) => Promise<{
        readonly value: T;
        readonly receipt: import("./adapter").ManagedBootstrapCreateReceipt;
      }>,
    ) {
      const gpuDevice = input.sandboxGpuConfig.sandboxGpuDevice;
      if (input.sandboxGpuConfig.sandboxGpuEnabled && !gpuDevice) {
        throw new Error("Managed bootstrap Podman GPU selection has no CDI device authority.");
      }
      const plan = {
        schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
        sandboxName: input.sandboxName,
        driverId: PROVIDER_ID,
        image: input.image,
        profile: { agent: input.request.agent, fingerprint: input.request.profileFingerprint },
        agentIdentity: input.agentIdentity,
        intendedWorkloadArgv: input.intendedWorkloadArgv,
        expectedSupervisorArgv: input.expectedSupervisorArgv,
        metadata: {},
      } as const;
      let launched: {
        readonly value: T;
        readonly receipt: import("./adapter").ManagedBootstrapCreateReceipt;
      } | null = null;
      const prepared = await prepareManagedBootstrapSequence(adapter, {
        create: {
          plan,
          request: input.request,
          bootstrapIdentity: input.bootstrapIdentity,
          launch: async (value) => {
            launched = await launch(value);
            return launched.receipt;
          },
        },
        request: input.request,
        replacementOptions: {
          values: {
            gpuModeArgs: input.sandboxGpuConfig.sandboxGpuEnabled
              ? ["--device", gpuDevice as string]
              : [],
            requiredUlimits: input.requiredLimits.map(
              (limit) => `${limit.name}=${String(limit.soft)}:${String(limit.hard)}`,
            ),
            extraGroupGids: [],
          },
        },
      });
      const activated = await activateManagedBootstrapSequence(adapter, {
        transaction: prepared,
        authorityStore,
        timeoutSecs: input.timeoutSecs,
      });
      runtimePatch.attach(
        createManagedBootstrapTerminalFinalizer((outcome) =>
          finalizeManagedBootstrapSequence(adapter, { outcome, transaction: activated }).then(
            () => undefined,
          ),
        ),
      );
      if (!launched) throw new Error("Managed bootstrap Podman did not return its create receipt.");
      return (launched as { readonly value: T }).value;
    },
  });
}

export function createPodmanManagedBootstrapSurface(
  engine: PodmanBoundContainerEngine,
): Extract<RuntimeProviderBootstrapSurface, { readonly supported: true }> {
  return Object.freeze({
    providerId: PROVIDER_ID,
    supported: true,
    createAuthorityStore: ({ stateRoot }: { readonly stateRoot: string }) =>
      createPodmanManagedBootstrapAuthorityStore(stateRoot),
    createLifecycle: (input: ManagedBootstrapRuntimeCreateLifecycleInput) =>
      createLifecycle(engine, input),
    createOnboardRouting: (
      _input: ManagedBootstrapRuntimeOnboardRoutingInput,
    ): ManagedBootstrapRuntimeOnboardRouting => ({
      nativeFallbackHasCleanBaseline: false,
      inspectNativeRuntime: () => null,
      isNativeCreateRoutingFailure: () => false,
      isTrustedNativeRuntimeError: () => false,
      isNativeReadinessRoutingFailure: () => false,
      prepareCompatibilityLaunch: () => {
        throw new Error("Managed Podman onboarding does not use Docker compatibility fallback.");
      },
    }),
  });
}
