// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openRegularFileNoFollow } from "../../adapters/fs/regular-file";
import { ensureConfigDir } from "../../state/config-io";
import { isPortableExperimentalProfile } from "../docker-driver-platform";
import {
  loadUserLocalOllamaOwnership,
  OLLAMA_PORT,
  recordUserLocalOllamaOwnership,
} from "./ollama-user-local-runtime";

const RECEIPT_DIRECTORY = "portable-demo-lifecycle";
const MAX_RECEIPT_BYTES = 4096;
const COMMAND_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;
const EXEC_READY_TIMEOUT_MS = 90_000;
const STARTUP_STOP_TIMEOUT_MS = 30_000;
const STARTUP_TIMEOUT_MS = 90_000;
const OLLAMA_STARTUP_TIMEOUT_MS = 30_000;
const PORTABLE_OLLAMA_REENROLL_ENV = "NEMOCLAW_PORTABLE_OLLAMA_REENROLL";
const MANAGED_EXECUTABLE_CHILD_FD = 3;
const POLL_INTERVAL_MS = 1_000;
const CONTAINER_ID_PATTERN = /^[a-f0-9]{64}$/u;
const SANDBOX_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/u;
const PODMAN_MANAGED_LABEL = "openshell.managed";
const PODMAN_SANDBOX_ID_LABEL = "openshell.sandbox-id";
const PODMAN_SANDBOX_NAME_LABEL = "openshell.sandbox-name";
const OPENSHELL_RUNTIME_CA_CERT = "/etc/openshell-tls/openshell-ca.pem";
const OPENSHELL_RUNTIME_CA_BUNDLE = "/etc/openshell-tls/ca-bundle.pem";
const CURRENT_RECEIPT_SCHEMA_VERSION = 2;
const STARTUP_PROCESS_PATTERN =
  "^(/usr/local/bin/nemoclaw-start|(bash|/bin/bash|/usr/bin/bash) /usr/local/bin/nemoclaw-start)( |$)";
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

type CommandResult = {
  status: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
  error?: Error;
};

interface PortableDemoLifecycleReceipt {
  schemaVersion: 1 | 2;
  sandboxName: string;
  sandboxId: string;
  containerId: string;
  dashboardPort: number;
}

interface PodmanContainerInspection {
  containerId: string;
  sandboxId: string;
  running: boolean;
}

export interface PortableDemoLifecycleDeps {
  platform?: NodeJS.Platform;
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  openshellBinary?: string;
  podman?: (args: readonly string[]) => CommandResult;
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
  log?: (message: string) => void;
}

export type PortableDemoLifecycleRecoveryResult =
  | { kind: "not-installed" }
  | { kind: "already-running" }
  | { kind: "recovered" };

export interface PortableDemoLifecycleContext {
  agent?: string | null;
  gatewayName: string;
  provider?: string | null;
}

function defaultPodman(args: readonly string[], env: NodeJS.ProcessEnv): CommandResult {
  return spawnSync("podman", [...args], {
    encoding: "utf-8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: COMMAND_TIMEOUT_MS,
  });
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function receiptPath(sandboxName: string, stateDir: string): string {
  const fileName = `${createHash("sha256").update(sandboxName).digest("hex")}.json`;
  return path.join(stateDir, RECEIPT_DIRECTORY, fileName);
}

function defaultStateDir(env: NodeJS.ProcessEnv): string {
  return path.join(env.HOME ?? os.homedir(), ".nemoclaw");
}

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
  if (keys.join(",") !== "containerId,dashboardPort,sandboxId,sandboxName,schemaVersion") {
    throw new Error("Portable demo lifecycle receipt fields are invalid");
  }
  if (
    (receipt.schemaVersion !== 1 && receipt.schemaVersion !== CURRENT_RECEIPT_SCHEMA_VERSION) ||
    receipt.sandboxName !== sandboxName ||
    typeof receipt.containerId !== "string" ||
    !CONTAINER_ID_PATTERN.test(receipt.containerId) ||
    typeof receipt.sandboxId !== "string" ||
    !SANDBOX_ID_PATTERN.test(receipt.sandboxId) ||
    !Number.isInteger(receipt.dashboardPort) ||
    Number(receipt.dashboardPort) < 1024 ||
    Number(receipt.dashboardPort) > 65535
  ) {
    throw new Error("Portable demo lifecycle receipt values are invalid");
  }
  return receipt as unknown as PortableDemoLifecycleReceipt;
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
  if (
    inspection.Id !== containerId ||
    labels?.[PODMAN_MANAGED_LABEL] !== "true" ||
    labels?.[PODMAN_SANDBOX_NAME_LABEL] !== sandboxName ||
    typeof sandboxId !== "string" ||
    !SANDBOX_ID_PATTERN.test(sandboxId) ||
    typeof state?.Running !== "boolean"
  ) {
    throw new Error(
      `Portable demo lifecycle refused container '${containerId}' because its OpenShell identity does not match sandbox '${sandboxName}'`,
    );
  }
  return { containerId, sandboxId, running: state.Running };
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

function startupArgv(receipt: PortableDemoLifecycleReceipt): string[] {
  const port = String(receipt.dashboardPort);
  // A raw Podman restart can preserve a merged CA bundle from the previous
  // OpenShell supervisor generation. Seed recovery from the current root-owned
  // v0.0.85 OpenShell CA paths. The startup-applied marker skips the stale
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

function gatewayIsRunning(
  receipt: PortableDemoLifecycleReceipt,
  gatewayName: string,
  capture: NonNullable<PortableDemoLifecycleDeps["captureOpenshell"]>,
  timeoutMs: number,
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
  return result.status === 0 && /(?:^|\D)(?:200|401)\s*$/u.test(String(result.stdout ?? ""));
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
  if (ollamaIsHealthy(captureHost, PROBE_TIMEOUT_MS)) return;

  const binPath = deps.loadManagedOllama
    ? deps.loadManagedOllama()
    : loadUserLocalOllamaOwnership({ homeDir, stateDir });
  if (!binPath) return;
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
    ollamaIsHealthy(captureHost, remainingMs),
  );
  if (!recovered) {
    throw new Error(
      `NemoClaw-managed Ollama did not become healthy at http://127.0.0.1:${String(OLLAMA_PORT)}/api/tags within 30 seconds; start the receipt-bound executable at ${JSON.stringify(binPath)} with the 'serve' argument, then retry`,
    );
  }
  (deps.log ?? console.log)("  Portable demo lifecycle restarted NemoClaw-managed Ollama.");
}

/** Configure the hidden portable profile for one exact container. */
export function installPortableDemoSandboxLifecycle(
  sandboxName: string,
  createdStartupArgv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  deps: PortableDemoLifecycleDeps = {},
): void {
  if (!isPortableExperimentalProfile(env)) return;
  if (
    createdStartupArgv[createdStartupArgv.length - 1] !== "/usr/local/bin/nemoclaw-start" ||
    startupEnvValue(createdStartupArgv, "OPENCLAW_HOME") === null
  ) {
    return;
  }
  if ((deps.platform ?? process.platform) !== "linux") {
    throw new Error("Portable demo lifecycle requires Linux");
  }
  const commandEnv = deps.env ?? env;
  const podman = deps.podman ?? ((args) => defaultPodman(args, commandEnv));
  const inspection = discoverPodmanContainer(sandboxName, podman);
  const receipt: PortableDemoLifecycleReceipt = {
    schemaVersion: CURRENT_RECEIPT_SCHEMA_VERSION,
    sandboxName,
    sandboxId: inspection.sandboxId,
    containerId: inspection.containerId,
    dashboardPort: parseDashboardPort(createdStartupArgv, sandboxName),
  };
  requireCommand(
    podman(["update", "--restart=unless-stopped", inspection.containerId]),
    `Setting the portable restart policy for sandbox '${sandboxName}'`,
  );
  writeReceipt(receipt, deps.stateDir ?? defaultStateDir(env));
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
  const commandEnv = deps.env ?? process.env;
  const receipt = loadReceipt(sandboxName, deps.stateDir ?? defaultStateDir(commandEnv));
  if (!receipt) return { kind: "not-installed" };
  if ((deps.platform ?? process.platform) !== "linux") {
    throw new Error("Portable demo lifecycle receipt is only valid on Linux");
  }

  const podman = deps.podman ?? ((args) => defaultPodman(args, commandEnv));
  const stateDir = deps.stateDir ?? defaultStateDir(commandEnv);
  const initialInspection = podman(["inspect", receipt.containerId]);
  if (isMissingPodmanContainer(initialInspection)) {
    removeReceipt(sandboxName, stateDir);
    return { kind: "not-installed" };
  }
  let inspection = inspectPodmanContainer(
    receipt.containerId,
    sandboxName,
    podman,
    initialInspection,
  );
  if (inspection.sandboxId !== receipt.sandboxId) {
    throw new Error(
      `Portable demo lifecycle refused container '${receipt.containerId}' because its OpenShell sandbox ID changed`,
    );
  }
  if (!inspection.running) {
    requireCommand(
      podman(["start", receipt.containerId]),
      `Starting portable sandbox '${sandboxName}'`,
    );
    inspection = inspectPodmanContainer(receipt.containerId, sandboxName, podman);
    if (!inspection.running) {
      throw new Error(`Portable sandbox '${sandboxName}' did not enter the running state`);
    }
  }

  const openshellBinary = deps.openshellBinary ?? commandEnv.NEMOCLAW_OPENSHELL_BIN ?? "openshell";
  const capture =
    deps.captureOpenshell ??
    ((args, timeoutMs) => defaultCaptureOpenshell(openshellBinary, args, timeoutMs, commandEnv));
  const timing = { now: deps.now ?? Date.now, sleep: deps.sleep ?? defaultSleep };
  const gatewayName = context.gatewayName;
  const execReady = waitFor(EXEC_READY_TIMEOUT_MS, timing, (remainingMs) => {
    const result = capture(
      openshellExecArgs(gatewayName, sandboxName, ["true"]),
      Math.min(PROBE_TIMEOUT_MS, remainingMs),
    );
    return result.status === 0 && !result.error;
  });
  if (!execReady) {
    throw new Error(`Portable sandbox '${sandboxName}' did not reconnect to the OpenShell gateway`);
  }
  recoverManagedOllama(context, commandEnv, stateDir, timing, deps);
  const gatewayRunning = gatewayIsRunning(receipt, gatewayName, capture, PROBE_TIMEOUT_MS);
  const refreshStartup = receipt.schemaVersion < CURRENT_RECEIPT_SCHEMA_VERSION;
  if (!refreshStartup && gatewayRunning) {
    return { kind: "already-running" };
  }
  let startupProbe = capture(
    openshellExecArgs(gatewayName, sandboxName, ["pgrep", "-f", STARTUP_PROCESS_PATTERN]),
    PROBE_TIMEOUT_MS,
  );
  if (refreshStartup && gatewayRunning && startupProbe.status === 1 && !startupProbe.error) {
    throw new Error(
      `Portable sandbox '${sandboxName}' has an agent gateway without its managed startup process`,
    );
  }
  if (refreshStartup && startupProbe.status === 0 && !startupProbe.error) {
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
  }
  if (startupProbe.status !== 1 || startupProbe.error) {
    if (startupProbe.status === 0 && !startupProbe.error) {
      const recovered = waitFor(STARTUP_TIMEOUT_MS, timing, (remainingMs) =>
        gatewayIsRunning(receipt, gatewayName, capture, remainingMs),
      );
      if (recovered) return { kind: "already-running" };
    }
    throw new Error(
      startupProbe.status === 0
        ? `Portable sandbox '${sandboxName}' has a startup process, but its agent gateway did not pass the dashboard health check`
        : `Portable sandbox '${sandboxName}' startup process state could not be determined`,
    );
  }

  const launch =
    deps.launchOpenshell ??
    ((args: readonly string[]) => defaultLaunchOpenshell(openshellBinary, args, commandEnv));
  launch(openshellExecArgs(gatewayName, sandboxName, startupArgv(receipt)));
  const recovered = waitFor(STARTUP_TIMEOUT_MS, timing, (remainingMs) =>
    gatewayIsRunning(receipt, gatewayName, capture, remainingMs),
  );
  if (!recovered) {
    throw new Error(
      `Portable sandbox '${sandboxName}' startup did not start its agent gateway; inspect /tmp/nemoclaw-start.log inside the sandbox`,
    );
  }
  if (refreshStartup) {
    writeReceipt(
      { ...receipt, schemaVersion: CURRENT_RECEIPT_SCHEMA_VERSION },
      deps.stateDir ?? defaultStateDir(commandEnv),
    );
  }
  (deps.log ?? console.log)(`  Portable demo lifecycle recovered sandbox '${sandboxName}'.`);
  return { kind: "recovered" };
}

export const portableDemoLifecycleInternals = { receiptPath };
