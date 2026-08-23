// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { ContainerEngineCommandCapture } from "../../adapters/container-engine";
import { openRegularFileNoFollow } from "../../adapters/fs/regular-file";
import {
  assertPodmanSocketAuthority,
  createPodmanContainerEngine,
  hardenPodmanSocketDirectory,
  type PodmanSocketAuthorityDeps,
} from "../../adapters/podman";
import { ensureConfigDir } from "../../state/config-io";
import type { CheckpointPortableRuntimeAuthority } from "../../state/onboard-checkpoint-types";
import { parsePortableRuntimeAuthority } from "../../state/onboard/portable-runtime-authority";
import { isPortableExperimentalProfile } from "./portable-profile";
import {
  PODMAN_MANAGED_LABEL,
  PODMAN_SANDBOX_CONTAINER_PREFIX,
  PODMAN_SANDBOX_ID_LABEL,
  PODMAN_SANDBOX_NAME_LABEL,
  PODMAN_SANDBOX_NAMESPACE,
  PODMAN_SANDBOX_NAMESPACE_LABEL,
  PODMAN_SANDBOX_WORKSPACE,
  PODMAN_SANDBOX_WORKSPACE_LABEL,
} from "../runtime-provider/podman-lifecycle";
import {
  loadUserLocalOllamaOwnership,
  OLLAMA_PORT,
  recordUserLocalOllamaOwnership,
} from "./ollama-user-local-runtime";
import {
  createPortableLifecycleTimingRecorder,
  type PortableLifecycleAttemptOutcome,
  type PortableLifecycleTimingRecorder,
} from "./portable-demo-lifecycle-timing";
import {
  inspectPortablePodmanReadiness,
  portablePodmanCommandEnvironment,
  portablePodmanReadinessError,
  type PortablePodmanReadinessDeps,
  type PortablePodmanReadinessResult,
} from "./portable-runtime-readiness";
import {
  defaultPortableDemoStateDir,
  inspectPortableRuntimeReceiptReadiness,
  portableDemoReceiptDirectory,
  portableDemoReceiptPath,
} from "./portable-runtime-receipt-readiness";

const MAX_RECEIPT_BYTES = 4096;
const MAX_RECEIPT_DIRECTORY_ENTRIES = 1024;
const COMMAND_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;
const EXEC_READY_TIMEOUT_MS = 90_000;
const STOP_SETTLEMENT_TIMEOUT_MS = 30_000;
const STARTUP_STOP_TIMEOUT_MS = 30_000;
const STARTUP_TIMEOUT_MS = 90_000;
const OLLAMA_STARTUP_TIMEOUT_MS = 30_000;
const PORTABLE_OLLAMA_REENROLL_ENV = "NEMOCLAW_PORTABLE_OLLAMA_REENROLL";
const MANAGED_EXECUTABLE_CHILD_FD = 3;
const POLL_INTERVAL_MS = 1_000;
const CONTAINER_ID_PATTERN = /^[a-f0-9]{64}$/u;
const SANDBOX_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/u;
const OPENSHELL_RUNTIME_CA_CERT = "/etc/openshell-tls/openshell-ca.pem";
const OPENSHELL_RUNTIME_CA_BUNDLE = "/etc/openshell-tls/ca-bundle.pem";
const CURRENT_RECEIPT_SCHEMA_VERSION = 4;
const STARTUP_PROCESS_PATTERN =
  "^(/usr/local/bin/nemoclaw-start|(bash|/bin/bash|/usr/bin/bash) /usr/local/bin/nemoclaw-start)( |$)";
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

export type PortablePodmanLifecycleCommandResult = {
  status: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
  error?: Error;
};

type CommandResult = PortablePodmanLifecycleCommandResult;

interface PortableDemoLifecycleReceipt {
  schemaVersion: 1 | 2 | 3 | 4;
  sandboxName: string;
  sandboxId: string;
  containerId: string;
  dashboardPort: number;
  registryGeneration?: string;
  runtimeAuthority?: CheckpointPortableRuntimeAuthority;
}

export interface PortableDemoLifecycleReceiptRecord {
  readonly sandboxName: string;
  readonly sandboxId: string;
  readonly containerId: string;
  readonly dashboardPort: number;
  readonly registryGeneration: string;
  readonly runtimeAuthority: CheckpointPortableRuntimeAuthority;
}

export interface PortablePodmanLifecycleTransport {
  readonly assertRuntimeAuthority: () => void;
  readonly dockerHost: string;
  readonly podman: (args: readonly string[]) => PortablePodmanLifecycleCommandResult;
}

export interface PreparedPortableDemoSandboxRemoval {
  readonly present: boolean;
  readonly receipt: PortableDemoLifecycleReceiptRecord;
  revalidate(): void;
  removeAndVerify(): void;
  verifyAbsent(): void;
}

export interface PreparedPortableDemoSandboxDestroyAuthority {
  revalidate(): void;
  verifyAbsent(): void;
}

interface PodmanContainerInspection {
  containerId: string;
  sandboxId: string;
  running: boolean;
  status: string | null;
}

export interface PortableDemoPrivilegedExecTarget {
  readonly assertRuntimeAuthority: () => void;
  readonly containerId: string;
  readonly dockerHost: string;
}

export interface PortableDemoLifecycleDeps {
  platform?: NodeJS.Platform;
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  openshellBinary?: string;
  podman?: (args: readonly string[], env?: NodeJS.ProcessEnv) => CommandResult;
  podmanSocketAuthorityDeps?: PodmanSocketAuthorityDeps;
  runtimeAuthority?: CheckpointPortableRuntimeAuthority | null;
  runtimeReadiness?: PortablePodmanReadinessDeps;
  hardenSocketDirectory?: (socketPath: string, uid: number) => void;
  registryGeneration?: string;
  backfillRegistryGeneration?: (registryGeneration: string) => boolean;
  captureOpenshell?: (args: readonly string[], timeoutMs: number) => CommandResult;
  launchOpenshell?: (args: readonly string[]) => void;
  captureHost?: (command: string, args: readonly string[], timeoutMs: number) => CommandResult;
  launchHost?: (
    command: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
    executableFd: number,
  ) => void;
  loadManagedOllama?: () => string | null;
  sleep?: (milliseconds: number) => void;
  now?: () => number;
  /** Diagnostic-only clock; never used for lifecycle deadlines. */
  timingNow?: () => number;
  log?: (message: string) => void;
}

export type PortableDemoLifecycleRecoveryResult =
  | { kind: "not-installed" }
  | { kind: "already-running" }
  | { kind: "recovered" };

export type PortableDemoLifecycleStopResult =
  | { kind: "not-installed" }
  | { kind: "already-stopped" }
  | { kind: "stopped" };

export interface PortableDemoLifecycleContext {
  agent?: string | null;
  gatewayName: string;
  lifecycleGeneration?: string;
  openshellDriver?: string | null;
  provider?: string | null;
}

export type PortableDemoDestroyContext = Pick<
  PortableDemoLifecycleContext,
  "agent" | "lifecycleGeneration" | "openshellDriver"
>;

function defaultPodmanCapture(env: NodeJS.ProcessEnv): ContainerEngineCommandCapture {
  return (_executable, args, timeoutMs) => {
    const result = spawnSync("podman", [...args], {
      encoding: "utf-8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    });
    return {
      status: result.status ?? 1,
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? ""),
      ...(result.error ? { error: result.error } : {}),
    };
  };
}

function defaultCaptureOpenshell(
  binary: string,
  args: readonly string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): CommandResult {
  return spawnSync(binary, [...args], {
    encoding: "utf-8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
  });
}

function defaultLaunchOpenshell(
  binary: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): void {
  const child = spawn(binary, [...args], {
    detached: true,
    env,
    shell: false,
    stdio: "ignore",
  });
  child.once("error", () => undefined);
  child.unref();
}

function defaultCaptureHost(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): CommandResult {
  return spawnSync(command, [...args], {
    encoding: "utf-8",
    env,
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
  });
}

function defaultLaunchHost(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  executableFd: number,
): void {
  const child = spawn(command, [...args], {
    detached: true,
    env,
    shell: false,
    stdio: ["ignore", "ignore", "ignore", executableFd],
  });
  child.once("error", () => undefined);
  child.unref();
}

function defaultSleep(milliseconds: number): void {
  if (milliseconds > 0) Atomics.wait(SLEEP_BUFFER, 0, 0, milliseconds);
}

function commandDetail(result: CommandResult): string {
  if (result.error)
    return (result.error as NodeJS.ErrnoException).code ?? "command execution error";
  return `exit ${String(result.status)}`;
}

function requireCommand(result: CommandResult, action: string): void {
  if (result.status === 0 && !result.error) return;
  throw new Error(`${action} failed: ${commandDetail(result)}`);
}

function isCommandTimeout(result: CommandResult): boolean {
  return (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const receiptPath = portableDemoReceiptPath;
const defaultStateDir = defaultPortableDemoStateDir;

function writeReceipt(receipt: PortableDemoLifecycleReceipt, stateDir: string): void {
  const filePath = receiptPath(receipt.sandboxName, stateDir);
  ensureConfigDir(path.dirname(filePath));
  let file;
  try {
    file = openRegularFileNoFollow(filePath, { writable: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    file = openRegularFileNoFollow(filePath, { create: true, mode: 0o600, writable: true });
  }
  try {
    file.replaceUtf8(`${JSON.stringify(receipt, null, 2)}\n`, 0o600);
  } finally {
    file.close();
  }
}

function parseReceipt(value: unknown, sandboxName: string): PortableDemoLifecycleReceipt {
  if (!isRecord(value)) {
    throw new Error("Portable demo lifecycle receipt is malformed");
  }
  const receipt = value;
  const keys = Object.keys(receipt).sort();
  const expectedKeys =
    receipt.schemaVersion === CURRENT_RECEIPT_SCHEMA_VERSION
      ? "containerId,dashboardPort,registryGeneration,runtimeAuthority,sandboxId,sandboxName,schemaVersion"
      : receipt.schemaVersion === 3
        ? "containerId,dashboardPort,registryGeneration,sandboxId,sandboxName,schemaVersion"
        : "containerId,dashboardPort,sandboxId,sandboxName,schemaVersion";
  if (keys.join(",") !== expectedKeys) {
    throw new Error("Portable demo lifecycle receipt fields are invalid");
  }
  if (
    (receipt.schemaVersion !== 1 &&
      receipt.schemaVersion !== 2 &&
      receipt.schemaVersion !== 3 &&
      receipt.schemaVersion !== CURRENT_RECEIPT_SCHEMA_VERSION) ||
    receipt.sandboxName !== sandboxName ||
    typeof receipt.containerId !== "string" ||
    !CONTAINER_ID_PATTERN.test(receipt.containerId) ||
    typeof receipt.sandboxId !== "string" ||
    !SANDBOX_ID_PATTERN.test(receipt.sandboxId) ||
    !Number.isInteger(receipt.dashboardPort) ||
    Number(receipt.dashboardPort) < 1024 ||
    Number(receipt.dashboardPort) > 65535 ||
    ((receipt.schemaVersion === 3 || receipt.schemaVersion === CURRENT_RECEIPT_SCHEMA_VERSION) &&
      (typeof receipt.registryGeneration !== "string" ||
        !SANDBOX_ID_PATTERN.test(receipt.registryGeneration))) ||
    (receipt.schemaVersion === CURRENT_RECEIPT_SCHEMA_VERSION &&
      parsePortableRuntimeAuthority(receipt.runtimeAuthority) === null)
  ) {
    throw new Error("Portable demo lifecycle receipt values are invalid");
  }
  if (receipt.schemaVersion === CURRENT_RECEIPT_SCHEMA_VERSION) {
    return {
      ...(receipt as unknown as PortableDemoLifecycleReceipt),
      runtimeAuthority: parsePortableRuntimeAuthority(receipt.runtimeAuthority)!,
    };
  }
  return receipt as unknown as PortableDemoLifecycleReceipt;
}

function requireCurrentRegistryGeneration(
  receipt: PortableDemoLifecycleReceipt,
  registryGeneration: string | undefined,
): boolean {
  // Legacy receipts predate an explicit generation field. Their immutable
  // container ID may claim a missing registry generation only after exact
  // local runtime validation; an existing generation must already match.
  const receiptGeneration =
    receipt.schemaVersion >= 3 ? receipt.registryGeneration : receipt.containerId;
  if (registryGeneration === undefined && receipt.schemaVersion < 3) return true;
  if (receiptGeneration !== registryGeneration) {
    throw new Error(
      `Portable demo lifecycle receipt for sandbox '${receipt.sandboxName}' does not belong to the current registry generation`,
    );
  }
  return false;
}

function loadReceipt(sandboxName: string, stateDir: string): PortableDemoLifecycleReceipt | null {
  let file;
  try {
    file = openRegularFileNoFollow(receiptPath(sandboxName, stateDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    return parseReceipt(JSON.parse(file.readUtf8(MAX_RECEIPT_BYTES)), sandboxName);
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new Error("Portable demo lifecycle receipt is malformed");
    throw error;
  } finally {
    file.close();
  }
}

function currentReceipt(receipt: PortableDemoLifecycleReceipt): PortableDemoLifecycleReceiptRecord {
  if (
    receipt.schemaVersion !== CURRENT_RECEIPT_SCHEMA_VERSION ||
    !receipt.registryGeneration ||
    !receipt.runtimeAuthority
  ) {
    throw new Error(
      `Portable demo lifecycle receipt for sandbox '${receipt.sandboxName}' predates recorded runtime authority`,
    );
  }
  return {
    sandboxName: receipt.sandboxName,
    sandboxId: receipt.sandboxId,
    containerId: receipt.containerId,
    dashboardPort: receipt.dashboardPort,
    registryGeneration: receipt.registryGeneration,
    runtimeAuthority: receipt.runtimeAuthority,
  };
}

/** Enumerate every strict current portable lifecycle receipt without following links. */
export function listPortableDemoSandboxLifecycleReceipts(
  stateDir = defaultStateDir(process.env),
): PortableDemoLifecycleReceiptRecord[] {
  const directory = portableDemoReceiptDirectory(stateDir);
  let opened: fs.Dir;
  try {
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(
        `Portable demo lifecycle receipt path '${directory}' is not a real directory`,
      );
    }
    opened = fs.opendirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const receipts: PortableDemoLifecycleReceiptRecord[] = [];
  const names = new Set<string>();
  let inspected = 0;
  try {
    let entry: fs.Dirent | null;
    while ((entry = opened.readSync()) !== null) {
      inspected += 1;
      if (inspected > MAX_RECEIPT_DIRECTORY_ENTRIES) {
        throw new Error(
          `Portable demo lifecycle receipt directory exceeds ${String(MAX_RECEIPT_DIRECTORY_ENTRIES)} entries`,
        );
      }
      if (entry.isSymbolicLink() || !entry.isFile() || !/^[a-f0-9]{64}\.json$/u.test(entry.name)) {
        throw new Error(
          `Portable demo lifecycle receipt directory contains an unsafe entry '${entry.name}'`,
        );
      }
      const filePath = path.join(directory, entry.name);
      let file;
      try {
        file = openRegularFileNoFollow(filePath);
        const raw: unknown = JSON.parse(file.readUtf8(MAX_RECEIPT_BYTES));
        const sandboxName = isRecord(raw) ? raw.sandboxName : null;
        if (typeof sandboxName !== "string") {
          throw new Error("Portable demo lifecycle receipt is malformed");
        }
        const receipt = currentReceipt(parseReceipt(raw, sandboxName));
        if (
          receiptPath(receipt.sandboxName, stateDir) !== filePath ||
          names.has(receipt.sandboxName)
        ) {
          throw new Error(
            `Portable demo lifecycle receipt identity is ambiguous for sandbox '${receipt.sandboxName}'`,
          );
        }
        names.add(receipt.sandboxName);
        receipts.push(receipt);
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new Error(`Portable demo lifecycle receipt '${filePath}' is malformed`);
        }
        throw error;
      } finally {
        file?.close();
      }
    }
  } finally {
    opened.closeSync();
  }
  return receipts.sort((left, right) => left.sandboxName.localeCompare(right.sandboxName));
}

function removeReceipt(sandboxName: string, stateDir: string): void {
  try {
    fs.unlinkSync(receiptPath(sandboxName, stateDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function startupEnvValue(startupArgv: readonly string[], name: string): string | null {
  const prefix = `${name}=`;
  for (let index = startupArgv.length - 2; index >= 1; index -= 1) {
    const argument = startupArgv[index];
    if (argument?.startsWith(prefix)) return argument.slice(prefix.length);
  }
  return null;
}

function parseDashboardPort(startupArgv: readonly string[], sandboxName: string): number {
  if (
    startupArgv[0] !== "env" ||
    startupArgv[startupArgv.length - 1] !== "/usr/local/bin/nemoclaw-start" ||
    startupEnvValue(startupArgv, "OPENCLAW_HOME") !== "/sandbox" ||
    startupEnvValue(startupArgv, "OPENCLAW_STATE_DIR") !== "/sandbox/.openclaw" ||
    startupEnvValue(startupArgv, "OPENCLAW_WORKSPACE_DIR") !== "/sandbox/.openclaw/workspace" ||
    startupEnvValue(startupArgv, "NEMOCLAW_SANDBOX_NAME") !== sandboxName
  ) {
    throw new Error("Portable demo lifecycle requires the default OpenClaw startup command");
  }
  const port = Number(startupEnvValue(startupArgv, "NEMOCLAW_DASHBOARD_PORT"));
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("Portable demo lifecycle requires a valid dashboard port");
  }
  return port;
}

function inspectPodmanContainer(
  containerId: string,
  sandboxName: string,
  podman: NonNullable<PortableDemoLifecycleDeps["podman"]>,
  result: CommandResult = podman(["inspect", containerId]),
): PodmanContainerInspection {
  requireCommand(result, `Inspecting portable sandbox '${sandboxName}'`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(result.stdout ?? ""));
  } catch {
    throw new Error(`Inspecting portable sandbox '${sandboxName}' returned invalid JSON`);
  }
  if (!Array.isArray(parsed) || parsed.length !== 1 || !isRecord(parsed[0])) {
    throw new Error(`Inspecting portable sandbox '${sandboxName}' returned an invalid record`);
  }
  const inspection = parsed[0];
  const config = isRecord(inspection.Config) ? inspection.Config : null;
  const labels = config && isRecord(config.Labels) ? config.Labels : null;
  const state = isRecord(inspection.State) ? inspection.State : null;
  const sandboxId = labels?.[PODMAN_SANDBOX_ID_LABEL];
  const expectedContainerName =
    typeof sandboxId === "string"
      ? `${PODMAN_SANDBOX_CONTAINER_PREFIX}${sandboxName}-${sandboxId}`
      : null;
  if (
    inspection.Id !== containerId ||
    inspection.Name !== expectedContainerName ||
    labels?.[PODMAN_MANAGED_LABEL] !== "true" ||
    labels?.[PODMAN_SANDBOX_NAME_LABEL] !== sandboxName ||
    labels?.[PODMAN_SANDBOX_NAMESPACE_LABEL] !== PODMAN_SANDBOX_NAMESPACE ||
    labels?.[PODMAN_SANDBOX_WORKSPACE_LABEL] !== PODMAN_SANDBOX_WORKSPACE ||
    typeof sandboxId !== "string" ||
    !SANDBOX_ID_PATTERN.test(sandboxId) ||
    typeof state?.Running !== "boolean"
  ) {
    throw new Error(
      `Portable demo lifecycle refused container '${containerId}' because its OpenShell identity does not match sandbox '${sandboxName}'`,
    );
  }
  const status =
    typeof state.Status === "string" && state.Status.trim().length > 0
      ? state.Status.trim().toLowerCase()
      : null;
  return { containerId, sandboxId, running: state.Running, status };
}

function isMissingPodmanContainer(result: CommandResult): boolean {
  if (result.status === 0 && !result.error) return false;
  const detail = `${String(result.stderr ?? "")}\n${String(result.stdout ?? "")}`;
  return /\b(?:no such (?:object|container)|no container with (?:name|id)|container .* not found)\b/iu.test(
    detail,
  );
}

function discoverPodmanContainer(
  sandboxName: string,
  podman: NonNullable<PortableDemoLifecycleDeps["podman"]>,
): PodmanContainerInspection {
  const result = podman([
    "ps",
    "-a",
    "--no-trunc",
    "--filter",
    `label=${PODMAN_MANAGED_LABEL}=true`,
    "--filter",
    `label=${PODMAN_SANDBOX_NAME_LABEL}=${sandboxName}`,
    "--filter",
    `label=${PODMAN_SANDBOX_WORKSPACE_LABEL}=${PODMAN_SANDBOX_WORKSPACE}`,
    "--format",
    "{{.ID}}",
  ]);
  requireCommand(result, `Finding portable sandbox '${sandboxName}'`);
  const matches = String(result.stdout ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (matches.length !== 1 || !CONTAINER_ID_PATTERN.test(matches[0] ?? "")) {
    throw new Error(
      `Portable demo lifecycle requires one exact Podman container for sandbox '${sandboxName}'; found ${matches.length}`,
    );
  }
  return inspectPodmanContainer(matches[0]!, sandboxName, podman);
}

function podmanCapture(
  podman: NonNullable<PortableDemoLifecycleDeps["podman"]>,
  env: NodeJS.ProcessEnv,
): ContainerEngineCommandCapture {
  return (_executable, args) => {
    const result = podman(args, env);
    return {
      status: result.status ?? 1,
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? ""),
      ...(result.error ? { error: result.error } : {}),
    };
  };
}

function qualifiedPodmanAuthority(
  receipt: PortableDemoLifecycleReceipt,
  commandEnv: NodeJS.ProcessEnv,
  deps: PortableDemoLifecycleDeps,
) {
  if (receipt.schemaVersion !== CURRENT_RECEIPT_SCHEMA_VERSION || !receipt.runtimeAuthority) {
    throw new Error(
      "The lifecycle receipt predates recorded portable Podman authority; rerun onboarding.",
    );
  }
  return createPortablePodmanLifecycleTransport(receipt.runtimeAuthority, {
    ...deps,
    env: commandEnv,
  });
}

/** Bind portable lifecycle commands to one revalidated current-user Podman socket. */
export function createPortablePodmanLifecycleTransport(
  runtimeAuthority: CheckpointPortableRuntimeAuthority,
  deps: PortableDemoLifecycleDeps = {},
): PortablePodmanLifecycleTransport {
  const commandEnv = deps.env ?? process.env;
  const podmanEnv = portablePodmanCommandEnvironment(runtimeAuthority, commandEnv);
  const capture = deps.podman
    ? podmanCapture(deps.podman, podmanEnv)
    : defaultPodmanCapture(podmanEnv);
  const readiness = inspectPortablePodmanReadiness(runtimeAuthority, {
    platform: deps.platform,
    env: commandEnv,
    socketAuthorityDeps: deps.podmanSocketAuthorityDeps,
    hardenSocketDirectory: deps.hardenSocketDirectory ?? hardenPodmanSocketDirectory,
    podmanCapture: capture,
    ...deps.runtimeReadiness,
  });
  if (!readiness.ok) throw portablePodmanReadinessError(readiness);
  (deps.log ?? console.log)(
    `  Portable Podman readiness: ${readiness.timing.mode}; activation ${String(readiness.timing.activationMs)} ms; API ${String(readiness.timing.apiMs)} ms; total ${String(readiness.timing.totalMs)} ms.`,
  );
  const socketAuthority = readiness.authority;
  const provider = createPodmanContainerEngine({
    operation: "sandbox-lifecycle",
    socketAuthority,
    authorityDeps: deps.podmanSocketAuthorityDeps,
    capture,
    assertAuthority: deps.runtimeReadiness?.assertSocketAuthority,
  });
  return {
    assertRuntimeAuthority: () =>
      (deps.runtimeReadiness?.assertSocketAuthority ?? assertPodmanSocketAuthority)(
        socketAuthority,
        deps.podmanSocketAuthorityDeps,
      ),
    dockerHost: readiness.dockerHost,
    podman: (args: readonly string[]) => provider.capture(args, COMMAND_TIMEOUT_MS),
  };
}

function matchingPortableSandboxContainerIds(
  sandboxName: string,
  podman: PortablePodmanLifecycleTransport["podman"],
): string[] {
  const args = [
    "ps",
    "-a",
    "--no-trunc",
    "--filter",
    `label=${PODMAN_MANAGED_LABEL}=true`,
    "--filter",
    `label=${PODMAN_SANDBOX_NAME_LABEL}=${sandboxName}`,
    "--filter",
    `label=${PODMAN_SANDBOX_WORKSPACE_LABEL}=${PODMAN_SANDBOX_WORKSPACE}`,
    "--format",
    "{{.ID}}",
  ] as const;
  let result = podman(args);
  if (result.status === 125) {
    result = podman(args);
  }
  requireCommand(result, `Finding portable sandbox '${sandboxName}'`);
  const ids = String(result.stdout ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (ids.some((id) => !CONTAINER_ID_PATTERN.test(id))) {
    throw new Error(`Finding portable sandbox '${sandboxName}' returned an invalid container ID`);
  }
  return ids;
}

/** Prevalidate one exact receipt-owned sandbox before a full uninstall mutates Podman. */
export function preparePortableDemoSandboxRemoval(
  receiptRecord: PortableDemoLifecycleReceiptRecord,
  transport: PortablePodmanLifecycleTransport,
  stateDir = defaultStateDir(process.env),
): PreparedPortableDemoSandboxRemoval {
  const assertReceiptAndAuthority = (): PortableDemoLifecycleReceipt => {
    const current = loadReceipt(receiptRecord.sandboxName, stateDir);
    if (!current || !isDeepStrictEqual(currentReceipt(current), receiptRecord)) {
      throw new Error(
        `Portable demo lifecycle receipt changed for sandbox '${receiptRecord.sandboxName}'`,
      );
    }
    requireCurrentRegistryGeneration(current, receiptRecord.registryGeneration);
    transport.assertRuntimeAuthority();
    return current;
  };
  const inspectPresence = (): boolean => {
    const loaded = assertReceiptAndAuthority();
    const matches = matchingPortableSandboxContainerIds(
      receiptRecord.sandboxName,
      transport.podman,
    );
    if (matches.length > 1 || (matches.length === 1 && matches[0] !== receiptRecord.containerId)) {
      throw new Error(
        `Portable demo lifecycle found a replaced or ambiguous container for sandbox '${receiptRecord.sandboxName}'`,
      );
    }
    const result = transport.podman(["inspect", receiptRecord.containerId]);
    if (isMissingPodmanContainer(result)) {
      if (matches.length === 0) return false;
      throw new Error(
        `Portable demo lifecycle found a replacement container for sandbox '${receiptRecord.sandboxName}'`,
      );
    }
    const inspection = inspectPodmanContainer(
      receiptRecord.containerId,
      receiptRecord.sandboxName,
      transport.podman,
      result,
    );
    requireReceiptOwnedInspection(loaded, inspection);
    if (matches.length !== 1) {
      throw new Error(
        `Portable demo lifecycle could not prove the label index for sandbox '${receiptRecord.sandboxName}'`,
      );
    }
    transport.assertRuntimeAuthority();
    return true;
  };
  const present = inspectPresence();
  const revalidate = (): void => {
    if (inspectPresence() !== present) {
      throw new Error(
        `Portable demo lifecycle container presence changed for sandbox '${receiptRecord.sandboxName}'`,
      );
    }
  };
  const verifyAbsent = (): void => {
    assertReceiptAndAuthority();
    const inspected = transport.podman(["inspect", receiptRecord.containerId]);
    if (!isMissingPodmanContainer(inspected)) {
      if (inspected.status !== 0 || inspected.error) {
        requireCommand(
          inspected,
          `Verifying portable sandbox '${receiptRecord.sandboxName}' removal`,
        );
      }
      throw new Error(
        `Portable sandbox '${receiptRecord.sandboxName}' still has its recorded Podman container`,
      );
    }
    const remaining = matchingPortableSandboxContainerIds(
      receiptRecord.sandboxName,
      transport.podman,
    );
    if (remaining.length !== 0) {
      throw new Error(
        `Portable demo lifecycle found a replacement container for sandbox '${receiptRecord.sandboxName}'`,
      );
    }
    transport.assertRuntimeAuthority();
  };
  return {
    present,
    receipt: receiptRecord,
    revalidate,
    removeAndVerify: () => {
      assertReceiptAndAuthority();
      if (present) transport.podman(["rm", "--force", receiptRecord.containerId]);
      verifyAbsent();
    },
    verifyAbsent,
  };
}

function requirePortableDemoDestroyContext(
  sandboxName: string,
  receipt: PortableDemoLifecycleReceiptRecord,
  context: PortableDemoDestroyContext | null,
): void {
  if (
    context?.agent !== "openclaw" ||
    context.openshellDriver !== "docker" ||
    context.lifecycleGeneration !== receipt.registryGeneration
  ) {
    throw new Error(
      `Portable demo lifecycle receipt does not match the OpenClaw sandbox registry record for '${sandboxName}'`,
    );
  }
}

/** Revalidate schema-4 receipt and Podman identity without granting Podman removal authority. */
export function preparePortableDemoSandboxDestroyAuthority(
  sandboxName: string,
  readContext: () => PortableDemoDestroyContext | null,
  deps: PortableDemoLifecycleDeps = {},
): PreparedPortableDemoSandboxDestroyAuthority | null {
  const commandEnv = deps.env ?? process.env;
  const stateDir = deps.stateDir ?? defaultStateDir(commandEnv);
  const receipt = loadReceipt(sandboxName, stateDir);
  if (!receipt) return null;
  const receiptRecord = currentReceipt(receipt);
  if ((deps.platform ?? process.platform) !== "linux") {
    throw new Error("Portable demo lifecycle receipt is only valid on Linux");
  }
  requirePortableDemoDestroyContext(sandboxName, receiptRecord, readContext());
  const transport = qualifiedPodmanAuthority(receipt, commandEnv, deps);
  const prepared = preparePortableDemoSandboxRemoval(receiptRecord, transport, stateDir);
  const assertRegistryAuthority = (): void =>
    requirePortableDemoDestroyContext(sandboxName, receiptRecord, readContext());
  return {
    revalidate: () => {
      assertRegistryAuthority();
      prepared.revalidate();
    },
    verifyAbsent: () => {
      assertRegistryAuthority();
      prepared.verifyAbsent();
    },
  };
}

function requireReceiptOwnedInspection(
  receipt: PortableDemoLifecycleReceipt,
  inspection: PodmanContainerInspection,
): void {
  if (inspection.containerId !== receipt.containerId) {
    throw new Error(
      `Portable demo lifecycle refused container '${inspection.containerId}' because the recorded container identity changed`,
    );
  }
  if (inspection.sandboxId !== receipt.sandboxId) {
    throw new Error(
      `Portable demo lifecycle refused container '${receipt.containerId}' because its OpenShell sandbox ID changed`,
    );
  }
}

/** Inspect the receipt-owned portable runtime, or return null for an ordinary sandbox. */
export function inspectPortableDemoRuntimeReadiness(
  sandboxName: string,
  deps: PortableDemoLifecycleDeps = {},
): PortablePodmanReadinessResult | null {
  return inspectPortableRuntimeReceiptReadiness(sandboxName, deps);
}

/** Whether the sandbox has a receipt that requires authority-bound lifecycle operations. */
export function hasPortableDemoSandboxLifecycleReceipt(
  sandboxName: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return loadReceipt(sandboxName, defaultStateDir(env)) !== null;
}

/** Resolve the receipt-owned portable container for a host-side privileged exec. */
export function resolvePortableDemoPrivilegedExecTarget(
  sandboxName: string,
  deps: PortableDemoLifecycleDeps = {},
): PortableDemoPrivilegedExecTarget | null {
  const commandEnv = deps.env ?? process.env;
  const stateDir = deps.stateDir ?? defaultStateDir(commandEnv);
  const receipt = loadReceipt(sandboxName, stateDir);
  if (!receipt) return null;
  if ((deps.platform ?? process.platform) !== "linux") {
    throw new Error("Portable demo lifecycle receipt is only valid on Linux");
  }
  requireCurrentRegistryGeneration(receipt, deps.registryGeneration);
  const authority = qualifiedPodmanAuthority(receipt, commandEnv, deps);
  const inspection = discoverPodmanContainer(sandboxName, authority.podman);
  requireReceiptOwnedInspection(receipt, inspection);
  if (!inspection.running) {
    throw new Error(`Portable sandbox '${sandboxName}' is not running`);
  }
  authority.assertRuntimeAuthority();
  return {
    assertRuntimeAuthority: authority.assertRuntimeAuthority,
    containerId: inspection.containerId,
    dockerHost: authority.dockerHost,
  };
}

function startupArgv(receipt: PortableDemoLifecycleReceipt): string[] {
  const port = String(receipt.dashboardPort);
  // A raw Podman restart can preserve a merged CA bundle from the previous
  // OpenShell supervisor generation. Seed recovery from the current root-owned
  // v0.0.106 OpenShell CA paths. The startup-applied marker skips the stale
  // bundle merge, and the cleared merged marker prevents connect shells from
  // inheriting stale CA paths. #8058 removes this direct startup contract.
  return [
    "env",
    "NEMOCLAW_MANAGED_STARTUP_APPLIED=1",
    "_NEMOCLAW_CORPORATE_CA_MERGED=0",
    `NODE_EXTRA_CA_CERTS=${OPENSHELL_RUNTIME_CA_CERT}`,
    `DENO_CERT=${OPENSHELL_RUNTIME_CA_CERT}`,
    `SSL_CERT_FILE=${OPENSHELL_RUNTIME_CA_BUNDLE}`,
    `REQUESTS_CA_BUNDLE=${OPENSHELL_RUNTIME_CA_BUNDLE}`,
    `CURL_CA_BUNDLE=${OPENSHELL_RUNTIME_CA_BUNDLE}`,
    `GIT_SSL_CAINFO=${OPENSHELL_RUNTIME_CA_BUNDLE}`,
    `CHAT_UI_URL=http://127.0.0.1:${port}`,
    `NEMOCLAW_DASHBOARD_PORT=${port}`,
    "OPENCLAW_HOME=/sandbox",
    "OPENCLAW_STATE_DIR=/sandbox/.openclaw",
    "OPENCLAW_WORKSPACE_DIR=/sandbox/.openclaw/workspace",
    `NEMOCLAW_SANDBOX_NAME=${receipt.sandboxName}`,
    "/usr/local/bin/nemoclaw-start",
  ];
}

function openshellExecArgs(
  gatewayName: string,
  sandboxName: string,
  command: readonly string[],
): string[] {
  return [
    "sandbox",
    "exec",
    "-g",
    gatewayName,
    "--name",
    sandboxName,
    "--no-tty",
    "--",
    ...command,
  ];
}

function waitFor(
  timeoutMs: number,
  deps: Required<Pick<PortableDemoLifecycleDeps, "now" | "sleep">>,
  probe: (remainingMs: number) => boolean,
): boolean {
  const deadline = deps.now() + timeoutMs;
  do {
    const remaining = Math.max(1, deadline - deps.now());
    if (probe(remaining)) return true;
    if (deps.now() >= deadline) return false;
    deps.sleep(Math.min(POLL_INTERVAL_MS, deadline - deps.now()));
  } while (deps.now() < deadline);
  return false;
}

function commandAttemptOutcome(
  result: CommandResult,
  ready: boolean,
): PortableLifecycleAttemptOutcome {
  if (ready) return "ready";
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
    return "timeout";
  }
  if (result.error) return "error";
  return "not-ready";
}

function gatewayIsRunning(
  receipt: PortableDemoLifecycleReceipt,
  gatewayName: string,
  capture: NonNullable<PortableDemoLifecycleDeps["captureOpenshell"]>,
  timeoutMs: number,
  lifecycleTiming: PortableLifecycleTimingRecorder,
): boolean {
  const result = capture(
    openshellExecArgs(gatewayName, receipt.sandboxName, [
      "curl",
      "-so",
      "/dev/null",
      "-w",
      "%{http_code}",
      "--max-time",
      "3",
      `http://127.0.0.1:${String(receipt.dashboardPort)}/health`,
    ]),
    Math.min(PROBE_TIMEOUT_MS, timeoutMs),
  );
  const ready = result.status === 0 && /(?:^|\D)(?:200|401)\s*$/u.test(String(result.stdout ?? ""));
  lifecycleTiming.recordGatewayAttempt(commandAttemptOutcome(result, ready));
  return ready;
}

function ollamaIsHealthy(
  captureHost: NonNullable<PortableDemoLifecycleDeps["captureHost"]>,
  timeoutMs: number,
): boolean {
  const result = captureHost(
    "curl",
    [
      "-fsS",
      "--noproxy",
      "127.0.0.1",
      "--max-time",
      String(Math.max(1, Math.ceil(Math.min(PROBE_TIMEOUT_MS, timeoutMs) / 1_000))),
      `http://127.0.0.1:${String(OLLAMA_PORT)}/api/tags`,
    ],
    Math.min(PROBE_TIMEOUT_MS, timeoutMs),
  );
  if (result.status !== 0 || result.error) return false;
  try {
    const response = JSON.parse(String(result.stdout ?? ""));
    return isRecord(response) && Array.isArray(response.models);
  } catch {
    return false;
  }
}

interface OpenManagedOllamaBinary {
  descriptor: number;
  close(): void;
}

function openManagedOllamaBinary(binPath: string): OpenManagedOllamaBinary {
  if (typeof fs.constants.O_NOFOLLOW !== "number") {
    throw new Error("O_NOFOLLOW is unavailable");
  }
  const nonblock = typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0;
  let descriptor: number;
  try {
    descriptor = fs.openSync(binPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | nonblock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(
        `NemoClaw-managed Ollama binary '${binPath}' is not a regular executable; reinstall Ollama through nemoclaw onboard`,
      );
    }
    throw new Error(
      `NemoClaw-managed Ollama binary '${binPath}' is missing; reinstall Ollama through nemoclaw onboard`,
    );
  }
  try {
    const descriptorStats = fs.fstatSync(descriptor);
    const pathStats = fs.lstatSync(binPath);
    if (
      !descriptorStats.isFile() ||
      (descriptorStats.mode & 0o111) === 0 ||
      pathStats.isSymbolicLink() ||
      !pathStats.isFile() ||
      descriptorStats.dev !== pathStats.dev ||
      descriptorStats.ino !== pathStats.ino
    ) {
      throw new Error("invalid executable identity");
    }
  } catch {
    fs.closeSync(descriptor);
    throw new Error(
      `NemoClaw-managed Ollama binary '${binPath}' is not a regular executable; reinstall Ollama through nemoclaw onboard`,
    );
  }
  let closed = false;
  return {
    descriptor,
    close: () => {
      if (closed) return;
      closed = true;
      fs.closeSync(descriptor);
    },
  };
}

function assertManagedOllamaBinary(binPath: string): void {
  const executable = openManagedOllamaBinary(binPath);
  executable.close();
}

function recoverManagedOllama(
  context: PortableDemoLifecycleContext,
  commandEnv: NodeJS.ProcessEnv,
  stateDir: string,
  timing: Required<Pick<PortableDemoLifecycleDeps, "now" | "sleep">>,
  deps: PortableDemoLifecycleDeps,
  lifecycleTiming: PortableLifecycleTimingRecorder,
): void {
  const reenrollRequested = commandEnv[PORTABLE_OLLAMA_REENROLL_ENV] === "1";
  const homeDir = commandEnv.HOME ?? os.homedir();
  if (context.provider !== "ollama-local") {
    if (reenrollRequested) {
      throw new Error(
        `${PORTABLE_OLLAMA_REENROLL_ENV}=1 requires a portable sandbox with the recorded ollama-local provider`,
      );
    }
    return;
  }
  lifecycleTiming.setOllamaAction("checking");
  if (reenrollRequested) {
    const binPath = path.join(homeDir, ".local", "bin", "ollama");
    assertManagedOllamaBinary(binPath);
    recordUserLocalOllamaOwnership(binPath, { homeDir, stateDir });
    (deps.log ?? console.log)(
      "  Portable demo lifecycle recorded the explicitly re-enrolled user-local Ollama.",
    );
  }
  const captureHost =
    deps.captureHost ??
    ((command, args, timeoutMs) => defaultCaptureHost(command, args, timeoutMs, commandEnv));
  const checkOllamaHealth = (timeoutMs: number): boolean => {
    lifecycleTiming.incrementOllamaAttempts();
    return ollamaIsHealthy(captureHost, timeoutMs);
  };
  if (checkOllamaHealth(PROBE_TIMEOUT_MS)) {
    lifecycleTiming.setOllamaAction("reused");
    return;
  }

  const binPath = deps.loadManagedOllama
    ? deps.loadManagedOllama()
    : loadUserLocalOllamaOwnership({ homeDir, stateDir });
  if (!binPath) {
    lifecycleTiming.setOllamaAction("not-owned");
    return;
  }
  const executable = openManagedOllamaBinary(binPath);

  try {
    const processProbe = captureHost("pgrep", ["-x", "ollama"], PROBE_TIMEOUT_MS);
    if (processProbe.status === 0 && !processProbe.error) {
      throw new Error(
        `An Ollama process already exists, but http://127.0.0.1:${String(OLLAMA_PORT)}/api/tags is unavailable; NemoClaw refused to launch a duplicate`,
      );
    }
    if (processProbe.status !== 1 || processProbe.error) {
      throw new Error(
        `Ollama process state could not be determined: ${commandDetail(processProbe)}`,
      );
    }

    const launchHost = deps.launchHost ?? defaultLaunchHost;
    const launchEnv: NodeJS.ProcessEnv = {
      ...commandEnv,
      HOME: homeDir,
      OLLAMA_HOST: `127.0.0.1:${String(OLLAMA_PORT)}`,
    };
    delete launchEnv[PORTABLE_OLLAMA_REENROLL_ENV];
    lifecycleTiming.setOllamaAction("start-attempted");
    launchHost(
      `/proc/self/fd/${String(MANAGED_EXECUTABLE_CHILD_FD)}`,
      ["serve"],
      launchEnv,
      executable.descriptor,
    );
  } finally {
    executable.close();
  }
  const recovered = waitFor(OLLAMA_STARTUP_TIMEOUT_MS, timing, (remainingMs) =>
    checkOllamaHealth(remainingMs),
  );
  if (!recovered) {
    throw new Error(
      `NemoClaw-managed Ollama did not become healthy at http://127.0.0.1:${String(OLLAMA_PORT)}/api/tags within 30 seconds; start the receipt-bound executable at ${JSON.stringify(binPath)} with the 'serve' argument, then retry`,
    );
  }
  lifecycleTiming.setOllamaAction("started");
  (deps.log ?? console.log)("  Portable demo lifecycle restarted NemoClaw-managed Ollama.");
}

/** Configure the hidden portable profile for one exact container. */
export function installPortableDemoSandboxLifecycle(
  sandboxName: string,
  createdStartupArgv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  deps: PortableDemoLifecycleDeps = {},
): string | null {
  const stateDir = deps.stateDir ?? defaultStateDir(env);
  if (
    !isPortableExperimentalProfile(env) ||
    createdStartupArgv[createdStartupArgv.length - 1] !== "/usr/local/bin/nemoclaw-start" ||
    startupEnvValue(createdStartupArgv, "OPENCLAW_HOME") === null
  ) {
    removeReceipt(sandboxName, stateDir);
    return null;
  }
  if ((deps.platform ?? process.platform) !== "linux") {
    throw new Error("Portable demo lifecycle requires Linux");
  }
  const commandEnv = deps.env ?? env;
  const runtimeAuthority = deps.runtimeAuthority;
  if (!runtimeAuthority || !parsePortableRuntimeAuthority(runtimeAuthority)) {
    throw new Error(
      "Portable demo lifecycle requires the checkpoint-owned Podman runtime authority",
    );
  }
  const podmanEnv = portablePodmanCommandEnvironment(runtimeAuthority, commandEnv);
  const readinessCapture = deps.podman
    ? podmanCapture(deps.podman, podmanEnv)
    : defaultPodmanCapture(podmanEnv);
  const readiness = inspectPortablePodmanReadiness(runtimeAuthority, {
    platform: deps.platform,
    env: commandEnv,
    socketAuthorityDeps: deps.podmanSocketAuthorityDeps,
    hardenSocketDirectory: deps.hardenSocketDirectory ?? hardenPodmanSocketDirectory,
    podmanCapture: readinessCapture,
    ...deps.runtimeReadiness,
  });
  if (!readiness.ok) throw portablePodmanReadinessError(readiness);
  (deps.log ?? console.log)(
    `  Portable Podman readiness: ${readiness.timing.mode}; activation ${String(readiness.timing.activationMs)} ms; API ${String(readiness.timing.apiMs)} ms; total ${String(readiness.timing.totalMs)} ms.`,
  );
  const provider = createPodmanContainerEngine({
    operation: "sandbox-lifecycle",
    socketAuthority: readiness.authority,
    authorityDeps: deps.podmanSocketAuthorityDeps,
    capture: readinessCapture,
    assertAuthority: deps.runtimeReadiness?.assertSocketAuthority,
  });
  const podman = (args: readonly string[]) => provider.capture(args, COMMAND_TIMEOUT_MS);
  const inspection = discoverPodmanContainer(sandboxName, podman);
  const registryGeneration = deps.registryGeneration ?? inspection.containerId;
  if (!SANDBOX_ID_PATTERN.test(registryGeneration)) {
    throw new Error("Portable demo lifecycle registry generation is invalid");
  }
  const receipt: PortableDemoLifecycleReceipt = {
    schemaVersion: CURRENT_RECEIPT_SCHEMA_VERSION,
    sandboxName,
    sandboxId: inspection.sandboxId,
    containerId: inspection.containerId,
    dashboardPort: parseDashboardPort(createdStartupArgv, sandboxName),
    registryGeneration,
    runtimeAuthority,
  };
  requireCommand(
    podman(["update", "--restart=unless-stopped", inspection.containerId]),
    `Setting the portable restart policy for sandbox '${sandboxName}'`,
  );
  writeReceipt(receipt, stateDir);
  return registryGeneration;
}

/** Retire portable lifecycle authority only after its sandbox registry entry is removed. */
export function removePortableDemoSandboxLifecycleReceipt(
  sandboxName: string,
  stateDir = defaultStateDir(process.env),
): void {
  removeReceipt(sandboxName, stateDir);
}

/**
 * Recover the hidden portable profile after its Podman container or startup session stops.
 * Remove this temporary recovery path after #8058 supplies the durable provider lifecycle contract.
 */
export function recoverPortableDemoSandboxLifecycle(
  sandboxName: string,
  context: PortableDemoLifecycleContext,
  deps: PortableDemoLifecycleDeps = {},
): PortableDemoLifecycleRecoveryResult {
  if ((context.agent ?? "openclaw") !== "openclaw") return { kind: "not-installed" };
  if (context.openshellDriver !== "docker") return { kind: "not-installed" };
  const commandEnv = deps.env ?? process.env;
  const stateDir = deps.stateDir ?? defaultStateDir(commandEnv);
  const receipt = loadReceipt(sandboxName, stateDir);
  if (!receipt) return { kind: "not-installed" };
  const clock = deps.now ?? Date.now;
  const lifecycleTiming = createPortableLifecycleTimingRecorder({
    now: deps.timingNow,
    write: deps.log ?? console.log,
  });
  const authority = lifecycleTiming.measure("authority", () => {
    if ((deps.platform ?? process.platform) !== "linux") {
      throw new Error("Portable demo lifecycle receipt is only valid on Linux");
    }
    requireCurrentRegistryGeneration(receipt, context.lifecycleGeneration);
    return qualifiedPodmanAuthority(receipt, commandEnv, deps);
  });
  const podman = authority.podman;
  const initialInspection = lifecycleTiming.measure("inspect", () =>
    podman(["inspect", receipt.containerId]),
  );
  if (isMissingPodmanContainer(initialInspection)) {
    lifecycleTiming.measure("inspect", () => removeReceipt(sandboxName, stateDir));
    lifecycleTiming.finish("not-installed");
    return { kind: "not-installed" };
  }
  let inspection = lifecycleTiming.measure("inspect", () =>
    inspectPodmanContainer(receipt.containerId, sandboxName, podman, initialInspection),
  );
  if (inspection.sandboxId !== receipt.sandboxId) {
    lifecycleTiming.markFailureStage("inspect");
    lifecycleTiming.finish("failed");
    throw new Error(
      `Portable demo lifecycle refused container '${receipt.containerId}' because its OpenShell sandbox ID changed`,
    );
  }
  if (!inspection.running) {
    lifecycleTiming.setContainerAction("started");
    inspection = lifecycleTiming.measure("containerStart", () => {
      requireCommand(
        podman(["start", receipt.containerId]),
        `Starting portable sandbox '${sandboxName}'`,
      );
      return inspectPodmanContainer(receipt.containerId, sandboxName, podman);
    });
    if (!inspection.running) {
      lifecycleTiming.markFailureStage("containerStart");
      lifecycleTiming.finish("failed");
      throw new Error(`Portable sandbox '${sandboxName}' did not enter the running state`);
    }
  } else {
    lifecycleTiming.setContainerAction("reused");
  }

  const openshellBinary = deps.openshellBinary ?? commandEnv.NEMOCLAW_OPENSHELL_BIN ?? "openshell";
  const capture =
    deps.captureOpenshell ??
    ((args, timeoutMs) => defaultCaptureOpenshell(openshellBinary, args, timeoutMs, commandEnv));
  const timing = { now: clock, sleep: deps.sleep ?? defaultSleep };
  const gatewayName = context.gatewayName;
  const execReady = lifecycleTiming.measure("execReady", () =>
    waitFor(EXEC_READY_TIMEOUT_MS, timing, (remainingMs) => {
      const result = capture(
        openshellExecArgs(gatewayName, sandboxName, ["true"]),
        Math.min(PROBE_TIMEOUT_MS, remainingMs),
      );
      const ready = result.status === 0 && !result.error;
      lifecycleTiming.recordExecAttempt(commandAttemptOutcome(result, ready));
      return ready;
    }),
  );
  if (!execReady) {
    lifecycleTiming.markFailureStage("execReady");
    lifecycleTiming.finish("failed");
    throw new Error(`Portable sandbox '${sandboxName}' did not reconnect to the OpenShell gateway`);
  }
  lifecycleTiming.measure("ollama", () =>
    recoverManagedOllama(context, commandEnv, stateDir, timing, deps, lifecycleTiming),
  );
  const gatewayRunning = lifecycleTiming.measure("gatewayHealth", () =>
    gatewayIsRunning(receipt, gatewayName, capture, PROBE_TIMEOUT_MS, lifecycleTiming),
  );
  const refreshStartup = receipt.schemaVersion === 1;
  if (!refreshStartup && gatewayRunning) {
    lifecycleTiming.setGatewayAction("reused");
    lifecycleTiming.finish("already-running");
    return { kind: "already-running" };
  }
  let startupProbe = lifecycleTiming.measure("startupProbe", () =>
    capture(
      openshellExecArgs(gatewayName, sandboxName, ["pgrep", "-f", STARTUP_PROCESS_PATTERN]),
      PROBE_TIMEOUT_MS,
    ),
  );
  if (refreshStartup && gatewayRunning && startupProbe.status === 1 && !startupProbe.error) {
    lifecycleTiming.markFailureStage("startupProbe");
    lifecycleTiming.finish("failed");
    throw new Error(
      `Portable sandbox '${sandboxName}' has an agent gateway without its managed startup process`,
    );
  }
  if (refreshStartup && startupProbe.status === 0 && !startupProbe.error) {
    lifecycleTiming.measure("startupProbe", () => {
      const stopped = capture(
        openshellExecArgs(gatewayName, sandboxName, [
          "pkill",
          "-TERM",
          "-f",
          STARTUP_PROCESS_PATTERN,
        ]),
        PROBE_TIMEOUT_MS,
      );
      if (stopped.error || (stopped.status !== 0 && stopped.status !== 1)) {
        throw new Error(
          `Stopping the stale managed startup process for portable sandbox '${sandboxName}' failed: ${commandDetail(stopped)}`,
        );
      }
      const startupStopped = waitFor(STARTUP_STOP_TIMEOUT_MS, timing, (remainingMs) => {
        startupProbe = capture(
          openshellExecArgs(gatewayName, sandboxName, ["pgrep", "-f", STARTUP_PROCESS_PATTERN]),
          Math.min(PROBE_TIMEOUT_MS, remainingMs),
        );
        return startupProbe.status === 1 && !startupProbe.error;
      });
      if (!startupStopped) {
        throw new Error(
          `Portable sandbox '${sandboxName}' stale managed startup process did not stop`,
        );
      }
    });
  }
  if (startupProbe.status !== 1 || startupProbe.error) {
    if (startupProbe.status === 0 && !startupProbe.error) {
      lifecycleTiming.setGatewayAction("waited");
      const recovered = lifecycleTiming.measure("gatewayReady", () =>
        waitFor(STARTUP_TIMEOUT_MS, timing, (remainingMs) => {
          return gatewayIsRunning(receipt, gatewayName, capture, remainingMs, lifecycleTiming);
        }),
      );
      if (recovered) {
        lifecycleTiming.finish("already-running");
        return { kind: "already-running" };
      }
    }
    lifecycleTiming.markFailureStage(
      startupProbe.status === 0 && !startupProbe.error ? "gatewayReady" : "startupProbe",
    );
    lifecycleTiming.finish("failed");
    throw new Error(
      startupProbe.status === 0 && !startupProbe.error
        ? `Portable sandbox '${sandboxName}' has a startup process, but its agent gateway did not pass the dashboard health check`
        : `Portable sandbox '${sandboxName}' startup process state could not be determined`,
    );
  }

  const launch =
    deps.launchOpenshell ??
    ((args: readonly string[]) => defaultLaunchOpenshell(openshellBinary, args, commandEnv));
  lifecycleTiming.setGatewayAction("started");
  lifecycleTiming.measure("startupLaunch", () =>
    launch(openshellExecArgs(gatewayName, sandboxName, startupArgv(receipt))),
  );
  const recovered = lifecycleTiming.measure("gatewayReady", () =>
    waitFor(STARTUP_TIMEOUT_MS, timing, (remainingMs) => {
      return gatewayIsRunning(receipt, gatewayName, capture, remainingMs, lifecycleTiming);
    }),
  );
  if (!recovered) {
    lifecycleTiming.markFailureStage("gatewayReady");
    lifecycleTiming.finish("failed");
    throw new Error(
      `Portable sandbox '${sandboxName}' startup did not start its agent gateway; inspect /tmp/nemoclaw-start.log inside the sandbox`,
    );
  }
  (deps.log ?? console.log)(`  Portable demo lifecycle recovered sandbox '${sandboxName}'.`);
  lifecycleTiming.finish("recovered");
  return { kind: "recovered" };
}

/** Stop the exact receipt-owned portable container through its recorded Podman authority. */
export function stopPortableDemoSandboxLifecycle(
  sandboxName: string,
  context: PortableDemoLifecycleContext,
  beforeStop: () => void,
  deps: PortableDemoLifecycleDeps = {},
): PortableDemoLifecycleStopResult {
  if ((context.agent ?? "openclaw") !== "openclaw") return { kind: "not-installed" };
  if (context.openshellDriver !== "docker") return { kind: "not-installed" };
  const commandEnv = deps.env ?? process.env;
  const stateDir = deps.stateDir ?? defaultStateDir(commandEnv);
  const receipt = loadReceipt(sandboxName, stateDir);
  if (!receipt) return { kind: "not-installed" };
  if ((deps.platform ?? process.platform) !== "linux") {
    throw new Error("Portable demo lifecycle receipt is only valid on Linux");
  }
  requireCurrentRegistryGeneration(receipt, context.lifecycleGeneration);
  const authority = qualifiedPodmanAuthority(receipt, commandEnv, deps);
  const initialInspection = authority.podman(["inspect", receipt.containerId]);
  if (isMissingPodmanContainer(initialInspection)) {
    throw new Error(
      `Portable sandbox '${sandboxName}' no longer has its recorded Podman container`,
    );
  }
  const inspection = inspectPodmanContainer(
    receipt.containerId,
    sandboxName,
    authority.podman,
    initialInspection,
  );
  requireReceiptOwnedInspection(receipt, inspection);
  const timing = { now: deps.now ?? Date.now, sleep: deps.sleep ?? defaultSleep };
  const inspectExitedState = (): boolean => {
    const result = authority.podman(["inspect", receipt.containerId]);
    if (isMissingPodmanContainer(result)) {
      throw new Error(
        `Portable sandbox '${sandboxName}' no longer has its recorded Podman container`,
      );
    }
    const stopped = inspectPodmanContainer(
      receipt.containerId,
      sandboxName,
      authority.podman,
      result,
    );
    requireReceiptOwnedInspection(receipt, stopped);
    return !stopped.running && stopped.status === "exited";
  };

  if (!inspection.running) {
    if (inspection.status === "exited") return { kind: "already-stopped" };
    if (inspection.status !== "stopping") {
      throw new Error(`Portable sandbox '${sandboxName}' is not in the exited state`);
    }
    if (waitFor(STOP_SETTLEMENT_TIMEOUT_MS, timing, inspectExitedState)) {
      return { kind: "already-stopped" };
    }
    throw new Error(`Portable sandbox '${sandboxName}' did not settle into the exited state`);
  }

  beforeStop();
  const stop = authority.podman(["stop", receipt.containerId]);
  if (isCommandTimeout(stop)) {
    // The rootless Podman service can continue an accepted stop after its CLI
    // client times out. Reconcile only the exact receipt-owned container; do
    // not retry the mutation or weaken socket and container identity checks.
    if (waitFor(STOP_SETTLEMENT_TIMEOUT_MS, timing, inspectExitedState)) {
      return { kind: "stopped" };
    }
    requireCommand(stop, `Stopping portable sandbox '${sandboxName}'`);
  }
  requireCommand(stop, `Stopping portable sandbox '${sandboxName}'`);
  if (!waitFor(STOP_SETTLEMENT_TIMEOUT_MS, timing, inspectExitedState)) {
    throw new Error(`Portable sandbox '${sandboxName}' did not settle into the exited state`);
  }
  return { kind: "stopped" };
}

export const portableDemoLifecycleInternals = { receiptPath };
