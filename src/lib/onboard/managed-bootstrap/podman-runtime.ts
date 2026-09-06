// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { PodmanBoundContainerEngine } from "../../adapters/podman";
import type { SandboxGpuProofResult } from "../../state/registry";
import {
  getDockerDriverGatewayRuntimeMarkerPath,
  parseDockerDriverGatewayRuntimeMarker,
  readDockerDriverGatewayRuntimeMarker,
  writeDockerDriverGatewayPidFile,
  writeDockerDriverGatewayRuntimeMarker,
  type DockerDriverGatewayRuntimeMarker,
} from "../docker-driver-gateway-runtime-marker";
import {
  getTrustedActiveOpenShellGatewayUserServiceIdentity,
  startOpenShellGatewayUserService,
  stopOpenShellGatewayUserService,
  waitForOpenShellGatewayRetry,
} from "../docker-driver-gateway-service";
import { shouldOmitOpenShellOciImageUser } from "../docker-gpu-patch-clone";
import type { DockerContainerInspect } from "../docker-gpu-patch-types";
import { openshellSandboxCommandEnvValue } from "../docker-startup-command-env";
import { resolveGatewayName, resolveGatewayStateDirName } from "../gateway-binding/identity";
import type { ManagedStartupRootApplyRequest } from "../managed-startup/root-apply";
import type { ManagedStartupWorkspaceRoot } from "../managed-startup/state-roots";
import type { RuntimeProviderManagedImageBootstrapSurface } from "../runtime-provider/contract";
import {
  normalizePodmanLogicalMounts,
  resolvePodmanStorageGraphRoot,
} from "../runtime-provider/podman-runtime-surfaces";
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
  PODMAN_OPENSHELL_MANAGED_BY_LABEL,
  PODMAN_OPENSHELL_MANAGED_BY_VALUE,
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
import { prepareManagedBootstrapStateRoots } from "./state-root-authority";

const PROVIDER_ID = "podman";
const BOOTSTRAP_EXECUTABLE = "/usr/local/bin/nemoclaw-managed-bootstrap";
const FULL_ID = /^[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ENV = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const SAFE_RESOURCE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,252}$/u;
const LEASE_FILE = "managed-bootstrap-podman-watcher.json";
const STANDALONE_LAUNCH_FILE = "managed-bootstrap-podman-gateway-launch.json";
const MANAGED_BOOTSTRAP_TIMEOUT_MS = 300_000;
const REPLACEMENT_OBSERVATION_TIMEOUT_MS = 30_000;
const REPLACEMENT_OBSERVATION_INTERVAL_SECONDS = 0.25;
const OPENSHELL_TOKEN_SECRET_PREFIX = "openshell-token-";
const OPENSHELL_PROXY_SECRET_PREFIX = "openshell-proxy-auth-";
const OPENSHELL_WORKSPACE_VOLUME_PREFIX = "openshell-sandbox-";
const OPENSHELL_WORKSPACE_VOLUME_SUFFIX = "-workspace";
const OPENSHELL_WORKSPACE_DIRECTORY = "/sandbox";
const PODMAN_BOOTSTRAP_CAPABILITY_DROP_ENV = "NEMOCLAW_MANAGED_BOOTSTRAP_DROP_CAPABILITIES=0x32";
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
  readonly workspaceRoot: ManagedStartupWorkspaceRoot;
  readonly watcherController?: PodmanManagedGatewayWatcherController;
  readonly runCaptureOpenshell?: (args: string[], options?: Record<string, unknown>) => string;
  readonly sleep?: (seconds: number) => void;
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

export function observePodmanBootstrapReplacementReady(input: {
  readonly engine: PodmanBoundContainerEngine;
  readonly runtimeId: string;
  readonly sandboxName: string;
  readonly sandboxId: string;
  readonly gatewayName: string;
  readonly runCaptureOpenshell: NonNullable<
    PodmanManagedBootstrapAdapterOptions["runCaptureOpenshell"]
  >;
  readonly sleep?: (seconds: number) => void;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}): void {
  if (!FULL_ID.test(input.runtimeId)) {
    throw new Error("Managed bootstrap Podman replacement runtime ID is invalid.");
  }
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? waitForOpenShellGatewayRetry;
  const timeoutMs = input.timeoutMs ?? REPLACEMENT_OBSERVATION_TIMEOUT_MS;
  const deadline = now() + timeoutMs;
  const maxAttempts = Math.ceil(timeoutMs / (REPLACEMENT_OBSERVATION_INTERVAL_SECONDS * 1000));
  let lastPhase = "unobserved";
  let lastHealthFailure = "none";

  for (let attempt = 0; attempt <= maxAttempts; attempt += 1) {
    const health = input.engine.capture(["healthcheck", "run", input.runtimeId], 15_000);
    if (health.error || (health.status !== 0 && health.status !== 1)) {
      commandFailure("replacement health observation", health);
    }
    if (health.status !== 0) {
      lastHealthFailure = (health.stderr || health.stdout || "unhealthy").trim().slice(-300);
    }

    const output = input.runCaptureOpenshell(
      ["sandbox", "get", "-g", input.gatewayName, input.sandboxName, "--output", "json"],
      { ignoreError: true, timeout: 5_000 },
    );
    if (output.trim()) {
      let observed: JsonRecord;
      try {
        observed = record(JSON.parse(output), "OpenShell replacement observation");
      } catch {
        throw new Error("Managed bootstrap Podman OpenShell observation returned unreadable JSON.");
      }
      if (observed.id !== input.sandboxId) {
        throw new Error("Managed bootstrap Podman OpenShell sandbox identity changed.");
      }
      lastPhase = typeof observed.phase === "string" ? observed.phase : "unknown";
      if (lastPhase === "Ready" && health.status === 0) return;
    }
    if (attempt < maxAttempts && now() < deadline) {
      sleep(REPLACEMENT_OBSERVATION_INTERVAL_SECONDS);
    } else {
      break;
    }
  }

  throw new Error(
    `Managed bootstrap Podman replacement health was not observed by OpenShell before timeout (phase ${lastPhase}; health ${lastHealthFailure}).`,
  );
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
      Healthcheck: record(config.Healthcheck, "Config.Healthcheck"),
      Labels: record(config.Labels ?? {}, "Config.Labels"),
      Secrets: Array.isArray(config.Secrets) ? config.Secrets : [],
      WorkingDir: String(config.WorkingDir ?? ""),
    },
    HostConfig: hostConfig,
    Mounts: Array.isArray(inspect.Mounts) ? inspect.Mounts : [],
    NetworkSettings: { Networks: networkSettings.Networks ?? {} },
  };
  return JSON.stringify(canonical);
}

function healthDuration(value: unknown, label: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`Managed bootstrap Podman ${label} is invalid.`);
  }
  return value;
}

/** Reproduce OpenShell's exact Podman health contract on the managed replacement. */
export function renderPodmanReplacementHealthArgs(inspect: JsonRecord): readonly string[] {
  const config = record(inspect.Config, "Config");
  const health = record(config.Healthcheck, "Config.Healthcheck");
  const test = stringArray(health.Test, "Config.Healthcheck.Test");
  if (test.length !== 2 || test[0] !== "CMD-SHELL" || test[1]?.trim().length === 0) {
    throw new Error("Managed bootstrap Podman health check must be one CMD-SHELL command.");
  }
  const interval = healthDuration(health.Interval, "health-check interval", 1);
  const timeout = healthDuration(health.Timeout, "health-check timeout", 1_000_000_000);
  const retries = healthDuration(health.Retries, "health-check retries", 1);
  const startPeriod = healthDuration(health.StartPeriod, "health-check start period", 0);
  return Object.freeze([
    "--health-cmd",
    test[1] as string,
    "--health-interval",
    `${String(interval)}ns`,
    "--health-timeout",
    `${String(timeout)}ns`,
    "--health-retries",
    String(retries),
    "--health-start-period",
    `${String(startPeriod)}ns`,
  ]);
}

function boundedRuntimeValue(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4_096 ||
    value.includes("\0") ||
    /[\r\n]/u.test(value)
  ) {
    throw new Error(`Managed bootstrap Podman ${label} is invalid.`);
  }
  return value;
}

function optionalNonNegativeIntegerFlag(
  args: string[],
  flag: string,
  value: unknown,
  label: string,
): void {
  if (value === undefined || value === null || value === 0 || value === "") return;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Managed bootstrap Podman ${label} is invalid.`);
  }
  args.push(flag, String(value));
}

function optionalStringFlag(args: string[], flag: string, value: unknown, label: string): void {
  if (value === undefined || value === null || value === "") return;
  args.push(flag, boundedRuntimeValue(value, label));
}

/** Reproduce the provider-owned OpenShell Podman launch contract. */
export function renderPodmanReplacementRuntimeArgs(inspect: JsonRecord): readonly string[] {
  const config = record(inspect.Config, "Config");
  const host = record(inspect.HostConfig ?? {}, "HostConfig");
  const args: string[] = [];

  const user = String(config.User ?? "").trim();
  if (!["0", "0:0", "root", "root:root"].includes(user)) {
    throw new Error("Managed bootstrap Podman supervisor user must remain root.");
  }
  args.push("--user", "0:0");
  optionalStringFlag(args, "--hostname", config.Hostname, "hostname");
  const workingDirectory = String(config.WorkingDir ?? "");
  if (workingDirectory) {
    if (
      !path.isAbsolute(workingDirectory) ||
      path.normalize(workingDirectory) !== workingDirectory
    ) {
      throw new Error("Managed bootstrap Podman working directory is invalid.");
    }
    args.push("--workdir", workingDirectory);
  }
  optionalNonNegativeIntegerFlag(args, "--stop-timeout", config.StopTimeout, "stop timeout");

  const capability = (value: unknown, label: string): string => {
    const normalized = boundedRuntimeValue(value, label).replace(/^CAP_/u, "");
    if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(normalized)) {
      throw new Error(`Managed bootstrap Podman ${label} is invalid.`);
    }
    return normalized;
  };
  const addedCapabilities = stringArray(host.CapAdd ?? [], "HostConfig.CapAdd").map((value) =>
    capability(value, "added capability"),
  );
  // OpenShell's long-running Podman supervisor deliberately drops these
  // capabilities. The short-lived managed bootstrap replacement needs them
  // to mutate the agent-owned workspace, preserve setgid state roots, and
  // signal only its exact pidfd-pinned child before resuming that supervisor.
  const bootstrapCapabilities: ReadonlySet<string> = new Set(["DAC_OVERRIDE", "FSETID", "KILL"]);
  for (const value of new Set([...addedCapabilities, ...bootstrapCapabilities])) {
    args.push("--cap-add", value);
  }
  for (const value of stringArray(host.CapDrop ?? [], "HostConfig.CapDrop")) {
    const dropped = capability(value, "dropped capability");
    if (!bootstrapCapabilities.has(dropped)) {
      args.push("--cap-drop", dropped);
    }
  }
  for (const value of stringArray(host.SecurityOpt ?? [], "HostConfig.SecurityOpt")) {
    args.push("--security-opt", boundedRuntimeValue(value, "security option"));
  }
  for (const value of stringArray(host.ExtraHosts ?? [], "HostConfig.ExtraHosts")) {
    args.push("--add-host", boundedRuntimeValue(value, "host alias"));
  }
  for (const value of stringArray(host.GroupAdd ?? [], "HostConfig.GroupAdd")) {
    args.push("--group-add", boundedRuntimeValue(value, "supplementary group"));
  }
  for (const value of stringArray(host.Dns ?? [], "HostConfig.Dns")) {
    args.push("--dns", boundedRuntimeValue(value, "DNS server"));
  }
  for (const value of stringArray(host.DnsSearch ?? [], "HostConfig.DnsSearch")) {
    args.push("--dns-search", boundedRuntimeValue(value, "DNS search domain"));
  }

  if (host.Tmpfs !== undefined && host.Tmpfs !== null) {
    const tmpfs = record(host.Tmpfs, "HostConfig.Tmpfs");
    for (const destination of Object.keys(tmpfs).sort()) {
      if (!path.isAbsolute(destination) || path.normalize(destination) !== destination) {
        throw new Error("Managed bootstrap Podman tmpfs destination is invalid.");
      }
      const options = tmpfs[destination];
      const rendered = options
        ? `${destination}:${boundedRuntimeValue(options, "tmpfs options")}`
        : destination;
      args.push("--tmpfs", rendered);
    }
  }

  if (host.PortBindings !== undefined && host.PortBindings !== null) {
    const bindings = record(host.PortBindings, "HostConfig.PortBindings");
    for (const containerEndpoint of Object.keys(bindings).sort()) {
      const match = /^(\d{1,5})\/(tcp|udp|sctp)$/u.exec(containerEndpoint);
      const containerPort = Number(match?.[1]);
      if (!match || containerPort < 1 || containerPort > 65_535) {
        throw new Error("Managed bootstrap Podman published container endpoint is invalid.");
      }
      const rows = bindings[containerEndpoint];
      if (!Array.isArray(rows) || rows.length !== 1) {
        throw new Error("Managed bootstrap Podman published host endpoint is ambiguous.");
      }
      const binding = record(rows[0], "HostConfig.PortBindings entry");
      const hostPort = Number(binding.HostPort);
      if (!Number.isSafeInteger(hostPort) || hostPort < 1 || hostPort > 65_535) {
        throw new Error("Managed bootstrap Podman published host port is invalid.");
      }
      const hostIp = String(binding.HostIp ?? "");
      if (hostIp.includes("\0") || /[\r\n]/u.test(hostIp)) {
        throw new Error("Managed bootstrap Podman published host address is invalid.");
      }
      const endpoint = `${hostIp ? `${hostIp}:` : ""}${String(hostPort)}:${String(containerPort)}/${match[2]}`;
      args.push("--publish", endpoint);
    }
  }

  if (host.Ulimits !== undefined && host.Ulimits !== null) {
    if (!Array.isArray(host.Ulimits)) {
      throw new Error("Managed bootstrap Podman ulimits are invalid.");
    }
    for (const value of host.Ulimits) {
      const limit = record(value, "HostConfig.Ulimits entry");
      const name = boundedRuntimeValue(limit.Name, "ulimit name");
      const soft = Number(limit.Soft);
      const hard = Number(limit.Hard);
      if (![soft, hard].every((entry) => Number.isSafeInteger(entry) && entry >= -1)) {
        throw new Error("Managed bootstrap Podman ulimit bounds are invalid.");
      }
      args.push("--ulimit", `${name}=${String(soft)}:${String(hard)}`);
    }
  }

  optionalNonNegativeIntegerFlag(args, "--memory", host.Memory, "memory limit");
  optionalNonNegativeIntegerFlag(
    args,
    "--memory-reservation",
    host.MemoryReservation,
    "memory reservation",
  );
  optionalNonNegativeIntegerFlag(args, "--memory-swap", host.MemorySwap, "memory swap limit");
  optionalNonNegativeIntegerFlag(args, "--cpu-shares", host.CpuShares, "CPU shares");
  optionalNonNegativeIntegerFlag(args, "--cpu-quota", host.CpuQuota, "CPU quota");
  optionalNonNegativeIntegerFlag(args, "--cpu-period", host.CpuPeriod, "CPU period");
  optionalNonNegativeIntegerFlag(args, "--pids-limit", host.PidsLimit, "PID limit");
  optionalNonNegativeIntegerFlag(args, "--oom-score-adj", host.OomScoreAdj, "OOM score adjustment");
  optionalStringFlag(args, "--cpuset-cpus", host.CpusetCpus, "CPU set");
  optionalStringFlag(args, "--cpuset-mems", host.CpusetMems, "memory-node set");
  return Object.freeze(args);
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

export function renderPodmanReplacementEnvironment(
  inspect: JsonRecord,
  handle: ManagedBootstrapHeldWorkloadHandle,
): readonly string[] {
  const config = record(inspect.Config, "Config");
  const intended = openshellSandboxCommandEnvValue(handle.intendedWorkloadArgv);
  if (!intended) throw new Error("Managed bootstrap Podman intended workload argv is invalid.");
  const inspectedUser = String(config.User ?? "").trim();
  const labels = record(config.Labels ?? {}, "Config.Labels");
  const exactPodmanBoundary = labels[PODMAN_MANAGED_LABEL] === "true";
  const workspaceInspect = exactPodmanBoundary
    ? {
        ...inspect,
        Config: {
          ...config,
          User: ["0:0", "root", "root:root"].includes(inspectedUser) ? "0" : inspectedUser,
          WorkingDir: "/",
          Labels: { ...labels, "openshell.ai/managed-by": "openshell" },
        },
      }
    : inspect;
  const omitOciImageUser = shouldOmitOpenShellOciImageUser(
    workspaceInspect as unknown as DockerContainerInspect,
    handle.intendedWorkloadArgv,
  );
  const values = stringArray(config.Env ?? [], "Config.Env").filter(
    (entry) =>
      !entry.startsWith("OPENSHELL_SANDBOX_COMMAND=") &&
      !entry.startsWith("NEMOCLAW_MANAGED_BOOTSTRAP_DROP_CAPABILITIES=") &&
      (!omitOciImageUser || !entry.startsWith("OPENSHELL_OCI_IMAGE_USER=")),
  );
  if (values.some((entry) => !SAFE_ENV.test(entry))) {
    throw new Error("Managed bootstrap Podman environment contains an invalid assignment.");
  }
  values.push(`OPENSHELL_SANDBOX_COMMAND=${intended}`);
  values.push(PODMAN_BOOTSTRAP_CAPABILITY_DROP_ENV);
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

export function renderPodmanReplacementMountArgs(
  inspect: JsonRecord,
  storageGraphRoot: string,
): string[] {
  if (!Array.isArray(inspect.Mounts)) return [];
  const args: string[] = [];
  const mounts = normalizePodmanLogicalMounts(
    inspect.Mounts.map((value) => record(value, "mount")),
    storageGraphRoot,
    String(inspect.Id ?? ""),
  ) as readonly JsonRecord[];
  const destinations = new Set<string>();
  for (const mount of mounts) {
    const destination = String(mount.Destination ?? "");
    if (!destination || !path.isAbsolute(destination)) {
      throw new Error("Managed bootstrap Podman mount cannot be reproduced exactly.");
    }
    if (destinations.has(destination)) {
      throw new Error(
        "Managed bootstrap Podman mount destination resolves to ambiguous runtime mounts.",
      );
    }
    destinations.add(destination);
    const type = String(mount.Type ?? "");
    const name = String(mount.Name ?? "");
    const source = name || String(mount.Source ?? "");
    if (!source) {
      throw new Error("Managed bootstrap Podman mount cannot be reproduced exactly.");
    }
    if (type !== "volume" && type !== "bind" && type !== "image") {
      throw new Error(`Managed bootstrap Podman mount type '${type}' is unsupported.`);
    }
    const options =
      type === "image"
        ? `,rw=${mount.RW === true ? "true" : "false"}`
        : mount.RW === false
          ? ",ro"
          : "";
    args.push("--mount", `type=${type},source=${source},destination=${destination}${options}`);
  }
  return args;
}

function exactPodmanManagedWorkspaceVolume(
  inspect: JsonRecord,
  sandboxId: string,
): { readonly name: string; readonly mountpoint: string } {
  const expectedName = `${OPENSHELL_WORKSPACE_VOLUME_PREFIX}${sandboxId}${OPENSHELL_WORKSPACE_VOLUME_SUFFIX}`;
  if (!SAFE_RESOURCE_NAME.test(expectedName) || !Array.isArray(inspect.Mounts)) {
    throw new Error("Managed bootstrap Podman workspace-volume identity is invalid.");
  }
  const matches = inspect.Mounts.map((value) => record(value, "mount")).filter(
    (mount) => mount.Destination === OPENSHELL_WORKSPACE_DIRECTORY,
  );
  if (matches.length !== 1) {
    throw new Error("Managed bootstrap Podman workspace must resolve to one exact mount.");
  }
  const mount = matches[0] as JsonRecord;
  const mountpoint = String(mount.Source ?? "");
  if (
    mount.Type !== "volume" ||
    mount.Name !== expectedName ||
    mount.RW !== true ||
    (mount.Driver !== undefined && mount.Driver !== "" && mount.Driver !== "local") ||
    !path.isAbsolute(mountpoint) ||
    path.normalize(mountpoint) !== mountpoint ||
    mountpoint === path.parse(mountpoint).root
  ) {
    throw new Error("Managed bootstrap Podman workspace-volume authority is invalid.");
  }
  return Object.freeze({ name: expectedName, mountpoint });
}

/** Restore the image contract on OpenShell's exact persistent Podman workspace root. */
export function preparePodmanManagedWorkspaceAuthority(input: {
  readonly engine: PodmanBoundContainerEngine;
  readonly inspect: JsonRecord;
  readonly sandboxId: string;
  readonly workspaceRoot: ManagedStartupWorkspaceRoot;
}): void {
  const workspace = exactPodmanManagedWorkspaceVolume(input.inspect, input.sandboxId);
  const inspected = capture(
    input.engine,
    ["volume", "inspect", "--format", "{{.Name}}\n{{.Mountpoint}}", workspace.name],
    "workspace-volume inspection",
    15_000,
  ).stdout.trimEnd();
  if (inspected !== `${workspace.name}\n${workspace.mountpoint}`) {
    throw new Error("Managed bootstrap Podman workspace-volume mountpoint identity changed.");
  }
  const prepare = input.engine.prepareManagedWorkspaceRoot;
  if (!prepare) {
    throw new Error("Managed bootstrap Podman workspace-root preparation is unavailable.");
  }
  const receipt = prepare({
    path: workspace.mountpoint,
    uid: input.workspaceRoot.uid,
    gid: input.workspaceRoot.gid,
    mode: input.workspaceRoot.mode,
  });
  if (
    receipt.path !== workspace.mountpoint ||
    receipt.uid !== input.workspaceRoot.uid ||
    receipt.gid !== input.workspaceRoot.gid ||
    receipt.mode !== input.workspaceRoot.mode ||
    !/^\d+$/u.test(receipt.device) ||
    !/^\d+$/u.test(receipt.inode)
  ) {
    throw new Error("Managed bootstrap Podman workspace-root receipt is invalid.");
  }
}

function exactSecretTarget(value: string, label: string): string {
  if (
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    value === path.parse(value).root ||
    value.includes(",")
  ) {
    throw new Error(`Managed bootstrap Podman ${label} secret target is invalid.`);
  }
  return value;
}

export function renderPodmanReplacementSecretArgs(
  engine: PodmanBoundContainerEngine,
  inspect: JsonRecord,
  sandboxId: string,
): string[] {
  const config = record(inspect.Config, "Config");
  const environmentEntries = stringArray(config.Env ?? [], "Config.Env");
  if (environmentEntries.some((entry) => !SAFE_ENV.test(entry))) {
    throw new Error("Managed bootstrap Podman environment contains an invalid assignment.");
  }
  const environment = new Map(
    environmentEntries.map((entry) => {
      const separator = entry.indexOf("=");
      return [entry.slice(0, separator), entry.slice(separator + 1)] as const;
    }),
  );
  const command = stringArray(config.Cmd ?? [], "Config.Cmd");
  const proxyFlag = command.indexOf("--upstream-proxy-auth-file");
  const targets = new Map<string, string>();
  const tokenName = `${OPENSHELL_TOKEN_SECRET_PREFIX}${sandboxId}`;
  const tokenTarget = environment.get("OPENSHELL_SANDBOX_TOKEN_FILE");
  if (!tokenTarget) {
    throw new Error("Managed bootstrap Podman token secret target is unavailable.");
  }
  targets.set(tokenName, exactSecretTarget(tokenTarget, "token"));
  const proxyName = `${OPENSHELL_PROXY_SECRET_PREFIX}${sandboxId}`;
  const proxyTarget = proxyFlag >= 0 ? command[proxyFlag + 1] : undefined;
  if (proxyTarget) targets.set(proxyName, exactSecretTarget(proxyTarget, "proxy"));

  const secrets = Array.isArray(config.Secrets)
    ? config.Secrets.map((value) => record(value, "Config.Secrets entry"))
    : [];
  const args: string[] = [];
  for (const secret of secrets) {
    const name = String(secret.Name ?? "");
    const id = String(secret.ID ?? "");
    const target = targets.get(name);
    if (!SAFE_RESOURCE_NAME.test(name) || !id || !target) {
      throw new Error("Managed bootstrap Podman cannot reproduce an unknown runtime secret.");
    }
    const uid = Number(secret.UID);
    const gid = Number(secret.GID);
    const mode = Number(secret.Mode);
    if (
      !Number.isSafeInteger(uid) ||
      uid < 0 ||
      !Number.isSafeInteger(gid) ||
      gid < 0 ||
      !Number.isSafeInteger(mode) ||
      mode < 0 ||
      mode > 0o777
    ) {
      throw new Error("Managed bootstrap Podman runtime secret ownership is invalid.");
    }
    const inspected = capture(
      engine,
      ["secret", "inspect", "--format", "{{.ID}}", name],
      "runtime secret inspection",
      15_000,
    ).stdout.trim();
    if (inspected !== id) {
      throw new Error("Managed bootstrap Podman runtime secret identity changed.");
    }
    args.push(
      "--secret",
      `${name},target=${target},uid=${String(uid)},gid=${String(gid)},mode=${mode.toString(8).padStart(4, "0")}`,
    );
    targets.delete(name);
  }
  if (targets.size !== 0) {
    throw new Error("Managed bootstrap Podman required runtime secret is unavailable.");
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

function processInstanceSuspended(snapshot: PodmanGatewayWatcherSnapshot): boolean {
  if (processState(snapshot.pid) !== "T") return false;
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

function waitForProcessExit(snapshot: PodmanGatewayWatcherSnapshot): boolean {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (!processInstanceAlive(snapshot)) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  return !processInstanceAlive(snapshot);
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

/** Resolve the name and state directory that own one native Podman gateway port. */
export function resolvePodmanManagedGatewayAuthority(
  environment: NodeJS.ProcessEnv,
  gatewayPort: number,
  gatewayName?: string,
  homeDir: string = environment.HOME || os.homedir(),
): { readonly gatewayName: string; readonly stateDir: string } {
  const configured = environment.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR;
  const stateDir =
    configured && configured.trim()
      ? path.resolve(configured.trim())
      : path.join(homeDir, ".local", "state", "nemoclaw", resolveGatewayStateDirName(gatewayPort));
  return Object.freeze({
    gatewayName: gatewayName ?? resolveGatewayName(gatewayPort),
    stateDir,
  });
}

function createProductionWatcherController(
  options: PodmanManagedBootstrapAdapterOptions,
  authority: ReturnType<typeof resolvePodmanManagedGatewayAuthority>,
): PodmanManagedGatewayWatcherController {
  const { gatewayName, stateDir } = authority;
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
      if (processInstanceSuspended(snapshot)) return true;
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
      if (!processInstanceAlive(snapshot)) {
        throw new Error(
          "Managed bootstrap Podman standalone gateway identity changed before stop.",
        );
      }
      process.kill(snapshot.pid, "SIGTERM");
      if (waitForProcessExit(snapshot)) return;
      if (!processInstanceAlive(snapshot)) return;
      process.kill(snapshot.pid, "SIGKILL");
      if (!waitForProcessExit(snapshot)) {
        throw new Error("Managed bootstrap Podman standalone gateway did not stop.");
      }
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
      if (processInstanceSuspended(snapshot)) {
        process.kill(snapshot.pid, "SIGCONT");
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
        processInstanceAlive(snapshot) &&
        !processInstanceSuspended(snapshot) &&
        listenerPids(options.gatewayPort).includes(snapshot.pid)
      );
    },
  });
  const wrapLease = (lease: PodmanGatewayWatcherLease): PodmanGatewayWatcherLease =>
    Object.freeze({
      get record() {
        return lease.record;
      },
      assertStillHeld: lease.assertStillHeld,
      assertStillStopped: lease.assertStillStopped,
      resumeForObservationAndProve: lease.resumeForObservationAndProve,
      requiesceAndProve: lease.requiesceAndProve,
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
  requireCurrentOwnership = false,
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
    labels[PODMAN_SANDBOX_WORKSPACE_LABEL] !== PODMAN_SANDBOX_WORKSPACE ||
    (requireCurrentOwnership &&
      labels[PODMAN_OPENSHELL_MANAGED_BY_LABEL] !== PODMAN_OPENSHELL_MANAGED_BY_VALUE)
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
    true,
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
    true,
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
  const gatewayAuthority = resolvePodmanManagedGatewayAuthority(
    options.environment,
    options.gatewayPort,
    options.gatewayName,
  );
  const watcherController =
    options.watcherController ?? createProductionWatcherController(options, gatewayAuthority);
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
                restoredRuntimeId: committed ? null : journal.originalRuntimeId,
                restoredSpecHash: committed ? null : journal.originalSpecFingerprint,
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
              blockingScope: "provider",
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
        watcherLease.resumeForObservationAndProve();
        prepared = prepareStoppedPodmanBootstrapReplacement({
          engine: options.engine,
          journalStore,
          watcherLease,
          plan: {
            schemaVersion: PODMAN_BOOTSTRAP_REPLACEMENT_SCHEMA_VERSION,
            bootstrapIdentity: handle.bootstrapIdentity,
            heldWorkload: current.held,
            runtimeArgs: Object.freeze([
              ...renderPodmanReplacementRuntimeArgs(current.rawInspect),
              ...networkArgs(current.rawInspect),
              ...renderPodmanReplacementMountArgs(
                current.rawInspect,
                resolvePodmanStorageGraphRoot(options.engine),
              ),
              ...renderPodmanReplacementSecretArgs(
                options.engine,
                current.rawInspect,
                current.held.sandboxId,
              ),
              ...renderPodmanReplacementHealthArgs(current.rawInspect),
              ...optionArgs(replacementOptions.values),
            ]),
            environment: renderPodmanReplacementEnvironment(current.rawInspect, handle),
            entrypointArgv: [BOOTSTRAP_EXECUTABLE],
            commandArgv: replacementCommand(handle, snapshot),
            replacementImageContentId: snapshot.runtimeImageContentId,
          },
        });
      } catch (error) {
        try {
          watcherLease.requiesceAndProve();
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
      current.watcherLease.requiesceAndProve();
      current.prepared = stopExactPodmanBootstrapOriginal({
        engine: options.engine,
        heldWorkload: current.held,
        journalStore,
        prepared: current.prepared,
        watcherLease: current.watcherLease,
      });
      preparePodmanManagedWorkspaceAuthority({
        engine: options.engine,
        inspect: current.rawInspect,
        sandboxId: current.held.sandboxId,
        workspaceRoot: options.workspaceRoot,
      });
      const prepareStateRoot = options.engine.prepareManagedVolumeRoot;
      if (handle.plan.managedStateRoots.length > 0 && !prepareStateRoot) {
        throw new Error("Managed bootstrap Podman volume-root preparation is unavailable.");
      }
      prepareManagedBootstrapStateRoots({
        inspect: current.rawInspect,
        roots: handle.plan.managedStateRoots,
        captureVolume: (args) =>
          capture(options.engine, ["volume", ...args], "state-volume inspection", 15_000).stdout,
        ...(prepareStateRoot
          ? {
              prepareRoot: (input) => prepareStateRoot(input),
            }
          : {}),
      });
      current.watcherLease.resumeForObservationAndProve();
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
      const runCaptureOpenshell = options.runCaptureOpenshell;
      if (!runCaptureOpenshell) {
        throw new Error("Managed bootstrap Podman requires OpenShell observation authority.");
      }
      observePodmanBootstrapReplacementReady({
        engine: options.engine,
        runtimeId: current.prepared.replacementRuntimeId,
        sandboxName: handle.sandbox.sandboxName,
        sandboxId: handle.sandbox.sandboxId,
        gatewayName: gatewayAuthority.gatewayName,
        runCaptureOpenshell,
        ...(options.sleep ? { sleep: options.sleep } : {}),
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
      current.watcherLease.requiesceAndProve();
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
      const runCaptureOpenshell = options.runCaptureOpenshell;
      if (!runCaptureOpenshell) {
        throw new Error("Managed bootstrap Podman requires OpenShell observation authority.");
      }
      observePodmanBootstrapReplacementReady({
        engine: options.engine,
        runtimeId: current.prepared.replacementRuntimeId,
        sandboxName: input.handle.sandbox.sandboxName,
        sandboxId: input.handle.sandbox.sandboxId,
        gatewayName: gatewayAuthority.gatewayName,
        runCaptureOpenshell,
        ...(options.sleep ? { sleep: options.sleep } : {}),
      });
      transactions.delete(input.handle.bootstrapIdentity);
      return Object.freeze({
        schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
        sandbox: input.handle.sandbox,
        bootstrapIdentity: input.handle.bootstrapIdentity,
        outcome: "committed",
        restoredRuntimeId: null,
        restoredSpecHash: null,
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
      environment: input.environment,
      gatewayPort: input.network.gatewayPort,
      workspaceRoot: input.workspaceRoot,
      ...(input.dependencies.runCaptureOpenshell
        ? { runCaptureOpenshell: input.dependencies.runCaptureOpenshell }
        : {}),
      ...(input.dependencies.sleep ? { sleep: input.dependencies.sleep } : {}),
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
      const plan = {
        schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
        sandboxName: input.sandboxName,
        driverId: PROVIDER_ID,
        image: input.image,
        profile: { agent: input.request.agent, fingerprint: input.request.profileFingerprint },
        agentIdentity: input.agentIdentity,
        managedStateRoots: input.managedStateRoots,
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
              ? gpuDevice
                ? ["--device", gpuDevice]
                : ["--gpus", "all"]
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
): RuntimeProviderManagedImageBootstrapSurface {
  return Object.freeze({
    providerId: PROVIDER_ID,
    supported: true,
    bootstrapKind: "managed-image",
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
