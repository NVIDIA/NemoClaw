// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, isIP } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  exportPrototypeArtifactBundle,
  HERMES_SWITCHYARD_PROTOTYPE,
  PROTOTYPE_ARTIFACT_NAMES,
  parsePrototypeResult,
} from "./run.mts";

const MANAGED_RESULT_PREFIX = "NEMOCLAW_HERMES_SWITCHYARD_MANAGED=";
const MANAGED_TEMP_PREFIX = "nemoclaw-hermes-switchyard-managed-";
const REMOTE_PROTOTYPE_PARENT = "/sandbox/.nemoclaw-prototypes";
const COMMAND_OUTPUT_LIMIT = 32 * 1024 * 1024;
const MANAGED_BRIDGE_PROXY_IMAGE =
  "busybox@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662";
const MANAGED_BRIDGE_PROXY_LABEL = "com.nvidia.nemoclaw.prototype";
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const nemohermesCli = join(repoRoot, "bin", "nemohermes.js");
const managedInferenceProvider = fileURLToPath(
  new URL("./managed-inference-provider.mts", import.meta.url),
);

type CommandResult = {
  readonly status: number;
  readonly stderr: string;
  readonly stdout: string;
};

type CommandOptions = {
  readonly allowFailure?: boolean;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly secrets?: readonly string[];
  readonly timeoutMs: number;
};

type ManagedStatus = {
  readonly attempts?: number;
  readonly inferenceEndpoint: string;
  readonly phase: string;
};

type ManagedCleanupState = {
  bridgeProxy?: {
    readonly containerId?: string;
    readonly containerName: string;
    readonly providerPort: number;
  };
  gatewayName: string;
  gatewayPort: number;
  gatewayRegistrationDir: string;
  gatewayStateDir: string;
  managedCommandEnv?: NodeJS.ProcessEnv;
  migrationStateFingerprint: string;
  nemoclawStateRoot: string;
  onboardAttempted: boolean;
  onboardSessionPath: string;
  provider?: ChildProcess;
  providerStderr?: string;
  runStartedAtMs: number;
  sandboxName: string;
  sharedRegistryPath: string;
  sharedRegistrySha256: string | null;
  sandboxServicesDir: string;
  tempRoot: string;
};

type SupervisionState = {
  activeChild?: ChildProcess;
  interrupted?: NodeJS.Signals;
};

export type ManagedPrototypeResult = {
  readonly [key: string]: unknown;
  readonly status: "pass";
};

function signalChildTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
}

function redact(text: string, secrets: readonly string[]): string {
  let safe = text;
  for (const secret of secrets) {
    if (secret) safe = safe.split(secret).join("[REDACTED]");
  }
  return safe;
}

function commandFailureDetail(
  command: string,
  code: number | null,
  signal: NodeJS.Signals | null,
  stdout: string,
  stderr: string,
  secrets: readonly string[],
): string {
  const raw = [
    stderr.trim() ? `stderr:\n${stderr.trim().slice(-8_000)}` : "",
    stdout.trim() ? `stdout:\n${stdout.trim().slice(-8_000)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const detail = redact(raw, secrets);
  return `${command} exited with ${code ?? `signal ${signal ?? "unknown"}`}${
    detail ? `: ${detail}` : ""
  }`;
}

async function runCommand(
  command: string,
  args: string[],
  supervision: SupervisionState,
  options: CommandOptions,
): Promise<CommandResult> {
  if (supervision.interrupted) {
    throw new Error(`Managed prototype interrupted by ${supervision.interrupted}`);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    supervision.activeChild = child;
    let stdout = "";
    let stderr = "";
    let failure: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const terminate = (error: Error) => {
      if (failure) return;
      failure = error;
      try {
        signalChildTree(child, "SIGTERM");
      } catch {
        // The escalation below retries the exact process group.
      }
      killTimer = setTimeout(() => {
        try {
          signalChildTree(child, "SIGKILL");
        } catch {
          // A missing process means termination already succeeded.
        }
      }, 5_000);
    };
    const timeout = setTimeout(
      () => terminate(new Error(`${command} timed out after ${options.timeoutMs}ms`)),
      options.timeoutMs,
    );
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > COMMAND_OUTPUT_LIMIT) {
        terminate(new Error(`${command} stdout exceeded 32 MiB`));
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > COMMAND_OUTPUT_LIMIT) {
        terminate(new Error(`${command} stderr exceeded 32 MiB`));
      }
    });
    child.once("error", (error) => terminate(error));
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (supervision.activeChild === child) supervision.activeChild = undefined;
      if (supervision.interrupted) {
        reject(new Error(`Managed prototype interrupted by ${supervision.interrupted}`));
      } else if (failure) {
        reject(failure);
      } else if (code !== 0 && !options.allowFailure) {
        reject(
          new Error(
            commandFailureDetail(command, code, signal, stdout, stderr, options.secrets ?? []),
          ),
        );
      } else {
        resolve({ status: code ?? -1, stderr, stdout });
      }
    });
  });
}

export function buildManagedCleanupEnvironment(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...(env ?? process.env), NEMOCLAW_CLEANUP_GATEWAY: "1" };
}

function runCleanupCommand(
  command: string,
  args: string[],
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): {
  status: number | null;
  stderr: string;
  stdout: string;
} {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: buildManagedCleanupEnvironment(env),
    maxBuffer: 16 * 1024 * 1024,
    timeout: timeoutMs,
  });
  return {
    status: result.status,
    stderr: result.stderr ?? result.error?.message ?? "",
    stdout: result.stdout ?? "",
  };
}

export function buildManagedOnboardArgs(sandboxName: string): string[] {
  return [
    nemohermesCli,
    "onboard",
    "--non-interactive",
    "--name",
    sandboxName,
    "--agent",
    "hermes",
    "--no-gpu",
    "--no-sandbox-gpu",
    "--no-observability",
    "--yes",
    "--yes-i-accept-third-party-software",
  ];
}

export function buildManagedOnboardEnvironment(input: {
  readonly apiKey: string;
  readonly dockerHost: string;
  readonly endpointUrl: string;
  readonly gatewayName: string;
  readonly gatewayPort: number;
  readonly sandboxName: string;
  readonly source?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const env = { ...(input.source ?? process.env) };
  for (const name of Object.keys(env)) {
    if (
      name.startsWith("NEMOCLAW_") ||
      name === "CHAT_UI_URL" ||
      name === "COMPATIBLE_API_KEY" ||
      /(API_KEY|PASSWORD|SECRET|TOKEN|CREDENTIAL)/i.test(name)
    ) {
      delete env[name];
    }
  }
  delete env.DOCKER_CONTEXT;
  delete env.DOCKER_HOST;
  return {
    ...env,
    COMPATIBLE_API_KEY: input.apiKey,
    DOCKER_HOST: input.dockerHost,
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_AGENT: "hermes",
    NEMOCLAW_ENDPOINT_URL: input.endpointUrl,
    NEMOCLAW_GATEWAY_PORT: String(input.gatewayPort),
    NEMOCLAW_HEALTH_POLL_COUNT: "90",
    NEMOCLAW_MODEL: "nemoclaw-managed-bootstrap",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_NO_EXPRESS: "1",
    NEMOCLAW_POLICY_MODE: "suggested",
    NEMOCLAW_PREFERRED_API: "openai-completions",
    NEMOCLAW_PROVIDER: "custom",
    NEMOCLAW_REASONING: "true",
    NEMOCLAW_SANDBOX_GPU: "0",
    NEMOCLAW_SANDBOX_NAME: input.sandboxName,
    NEMOCLAW_WEB_SEARCH_PROVIDER: "none",
    NEMOCLAW_YES: "1",
    OPENSHELL_GATEWAY: input.gatewayName,
  };
}

export function validateManagedDockerHost(raw: string): string {
  let dockerHost: unknown;
  try {
    dockerHost = JSON.parse(raw.trim());
  } catch {
    throw new Error("Docker context returned an invalid endpoint");
  }
  if (
    typeof dockerHost !== "string" ||
    !dockerHost.startsWith("unix:///") ||
    /['\0\r\n]/.test(dockerHost)
  ) {
    throw new Error("Managed prototype requires a local absolute unix:// Docker context endpoint");
  }
  const socketPath = dockerHost.slice("unix://".length);
  if (!isAbsolute(socketPath)) {
    throw new Error("Managed prototype Docker socket path was not absolute");
  }
  let realSocketPath: string;
  try {
    realSocketPath = realpathSync(socketPath);
    if (!statSync(realSocketPath).isSocket()) {
      throw new Error("not a socket");
    }
  } catch {
    throw new Error(`Managed prototype Docker endpoint is not a live local socket: ${socketPath}`);
  }
  return `unix://${realSocketPath}`;
}

export function buildManagedDockerEnvironment(
  dockerHost: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...source };
  delete env.DOCKER_CONTEXT;
  delete env.DOCKER_HOST;
  env.DOCKER_HOST = dockerHost;
  return env;
}

export function buildManagedCommandEnvironment(input: {
  readonly dockerHost: string;
  readonly gatewayName: string;
  readonly gatewayPort: number;
  readonly source?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  if (
    !Number.isInteger(input.gatewayPort) ||
    input.gatewayPort < 1024 ||
    input.gatewayPort > 65_535 ||
    input.gatewayPort === 8080 ||
    input.gatewayName !== `nemoclaw-${input.gatewayPort}`
  ) {
    throw new Error("Managed command environment requires a canonical non-default gateway");
  }
  const env = buildManagedDockerEnvironment(input.dockerHost, input.source ?? process.env);
  for (const name of Object.keys(env)) {
    if (name.startsWith("NEMOCLAW_") || name === "OPENSHELL_GATEWAY") {
      delete env[name];
    }
  }
  env.DOCKER_HOST = input.dockerHost;
  env.NEMOCLAW_GATEWAY_PORT = String(input.gatewayPort);
  env.OPENSHELL_GATEWAY = input.gatewayName;
  return env;
}

function resolveManagedHome(source: NodeJS.ProcessEnv = process.env): string {
  const home = source.HOME?.trim() || homedir();
  if (!isAbsolute(home)) {
    throw new Error("Managed prototype requires an absolute HOME");
  }
  return home;
}

function resolveManagedOpenShellConfigRoot(
  home: string,
  source: NodeJS.ProcessEnv = process.env,
): string {
  const configured = source.XDG_CONFIG_HOME?.trim();
  return configured && isAbsolute(configured) ? configured : join(home, ".config");
}

async function reserveManagedGatewayPort(
  home: string,
  openshellConfigRoot: string,
): Promise<number> {
  const forbidden = new Set([8000, 8080, 11_434, 11_435, 11_436, 11_437, 11_438]);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const server = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Failed to reserve a managed gateway port"));
          return;
        }
        resolve(address.port);
      });
    });
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    const gatewayName = `nemoclaw-${port}`;
    const statePaths = [
      join(home, ".nemoclaw", "gateways", String(port)),
      join(home, ".local", "state", "nemoclaw", `openshell-docker-gateway-${port}`),
      join(openshellConfigRoot, "openshell", "gateways", gatewayName),
    ];
    if (
      !forbidden.has(port) &&
      (port < 18_789 || port > 18_799) &&
      statePaths.every((candidate) => !existsSync(candidate))
    ) {
      return port;
    }
  }
  throw new Error("Could not reserve a non-conflicting managed gateway port");
}

function splitNonEmptyLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function assertNoManagedPortDockerResources(
  gatewayPort: number,
  containerInventory: string,
  volumeInventory: string,
): void {
  const gatewayName = `nemoclaw-${gatewayPort}`;
  const expectedContainers = new Set([
    `nemoclaw-openshell-gateway-${gatewayPort}`,
    `openshell-cluster-${gatewayName}`,
  ]);
  const collidingContainers = splitNonEmptyLines(containerInventory).filter((name) =>
    expectedContainers.has(name),
  );
  const volumePrefix = `openshell-cluster-${gatewayName}`;
  const collidingVolumes = splitNonEmptyLines(volumeInventory).filter(
    (name) => name === volumePrefix || name.startsWith(`${volumePrefix}-`),
  );
  if (collidingContainers.length > 0 || collidingVolumes.length > 0) {
    throw new Error(
      `Managed prototype refuses pre-existing Docker resources for ${gatewayName}: ${[
        ...collidingContainers,
        ...collidingVolumes,
      ].join(", ")}`,
    );
  }
}

export function validateManagedBridgeGateway(raw: string): string {
  let gateway: unknown;
  try {
    gateway = JSON.parse(raw.trim());
  } catch {
    throw new Error("Docker returned an invalid default bridge gateway");
  }
  if (
    typeof gateway !== "string" ||
    isIP(gateway) !== 4 ||
    gateway === "0.0.0.0" ||
    gateway.startsWith("127.") ||
    gateway.startsWith("169.254.")
  ) {
    throw new Error("Managed prototype requires a non-loopback IPv4 Docker bridge gateway");
  }
  return gateway;
}

export function buildManagedBridgeProxyArgs(input: {
  readonly bridgeGateway: string;
  readonly containerName: string;
  readonly gatewayPort: number;
  readonly providerPort: number;
  readonly sandboxName: string;
}): string[] {
  if (isIP(input.bridgeGateway) !== 4) {
    throw new Error("Managed bridge proxy requires an IPv4 gateway");
  }
  if (!/^[a-z0-9][a-z0-9_.-]{0,127}$/i.test(input.containerName)) {
    throw new Error("Managed bridge proxy container name is invalid");
  }
  if (
    !Number.isInteger(input.gatewayPort) ||
    input.gatewayPort < 1024 ||
    input.gatewayPort > 65_535 ||
    input.gatewayPort === 8080 ||
    !Number.isInteger(input.providerPort) ||
    input.providerPort < 1024 ||
    input.providerPort > 65_535
  ) {
    throw new Error("Managed bridge proxy provider port is invalid");
  }
  if (!/^hermes-switchyard-proto-[a-z0-9-]+$/i.test(input.sandboxName)) {
    throw new Error("Managed bridge proxy sandbox identity is invalid");
  }
  const command =
    input.providerPort === input.gatewayPort
      ? 'exec nc -lk -s "$1" -p "$2" -e nc host.docker.internal "$2"'
      : 'nc -lk -s "$1" -p "$2" -e nc host.docker.internal "$2" & exec nc -lk -s "$1" -p "$3" -e nc host.docker.internal "$3"';
  return [
    "run",
    "-d",
    "--rm",
    "--name",
    input.containerName,
    "--label",
    `${MANAGED_BRIDGE_PROXY_LABEL}=hermes-switchyard`,
    "--label",
    `${MANAGED_BRIDGE_PROXY_LABEL}.sandbox=${input.sandboxName}`,
    "--network",
    "host",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--user",
    "65534:65534",
    "--pids-limit",
    "32",
    "--memory",
    "16m",
    "--cpus",
    "0.1",
    "--pull",
    "never",
    MANAGED_BRIDGE_PROXY_IMAGE,
    "sh",
    "-c",
    command,
    "nemoclaw-bridge-proxy",
    input.bridgeGateway,
    String(input.gatewayPort),
    String(input.providerPort),
  ];
}

export function assertInactiveHomebrewGatewayService(raw: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Homebrew returned invalid OpenShell service state");
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("Homebrew returned ambiguous OpenShell service state");
  }
  const service = parsed[0] as Record<string, unknown>;
  if (
    service.name !== "openshell" ||
    service.service_name !== "homebrew.mxcl.openshell" ||
    service.running !== false ||
    service.loaded !== false ||
    service.registered !== false
  ) {
    throw new Error(
      "Managed prototype requires the official OpenShell Homebrew service to be inactive",
    );
  }
}

function prototypeGatewayRegistered(raw: string, state: ManagedCleanupState): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("OpenShell gateway inventory was not valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("OpenShell gateway inventory was not a JSON array");
  }
  if (parsed.length === 0) return false;
  if (parsed.length !== 1) {
    throw new Error("Refusing cleanup of ambiguous OpenShell gateway registrations");
  }
  const gateway = parsed[0] as Record<string, unknown>;
  if (
    gateway.name !== state.gatewayName ||
    gateway.endpoint !== `https://127.0.0.1:${state.gatewayPort}` ||
    gateway.is_remote !== false ||
    gateway.type !== "local"
  ) {
    throw new Error("Refusing cleanup of an OpenShell gateway not owned by this prototype");
  }
  return true;
}

export function buildManagedTurnExecArgs(
  sandboxName: string,
  remoteRoot: string,
  relayBinarySha256: string,
): string[] {
  if (!/^[0-9a-f]{64}$/.test(relayBinarySha256)) {
    throw new Error("Managed turn requires an exact Relay SHA-256");
  }
  if (!remoteRoot.startsWith(`${REMOTE_PROTOTYPE_PARENT}/`)) {
    throw new Error("Managed turn remote root escaped the prototype directory");
  }
  return [
    nemohermesCli,
    "sandbox",
    "exec",
    sandboxName,
    "--workdir",
    remoteRoot,
    "--no-tty",
    "--no-stdin",
    "--timeout",
    "180",
    "--",
    "env",
    `OPENAI_API_KEY=${HERMES_SWITCHYARD_PROTOTYPE.clientApiKey}`,
    `PROTOTYPE_PROVIDER_AUTHORIZATION=${HERMES_SWITCHYARD_PROTOTYPE.providerAuthorization}`,
    "PROTOTYPE_RUNTIME=nemoclaw-managed",
    `PROTOTYPE_EXPECTED_RELAY_SHA256=${relayBinarySha256}`,
    "HOME=/tmp/nemoclaw-hermes-switchyard-home",
    "HERMES_HOME=/tmp/nemoclaw-hermes-switchyard-hermes",
    "PYTHONDONTWRITEBYTECODE=1",
    "XDG_CACHE_HOME=/tmp/nemoclaw-hermes-switchyard-cache",
    "bash",
    "./run.sh",
  ];
}

export function validateManagedStatus(raw: string, sandboxName: string): ManagedStatus {
  const parsed = JSON.parse(raw) as {
    failureLayer?: unknown;
    found?: unknown;
    gatewayState?: unknown;
    inferenceHealth?: { endpoint?: unknown; ok?: unknown; probed?: unknown };
    name?: unknown;
    phase?: unknown;
    rpcIssue?: unknown;
    terminalRuntimeHealth?: { kind?: unknown };
  };
  if (
    parsed.name !== sandboxName ||
    parsed.found !== true ||
    parsed.gatewayState !== "present" ||
    parsed.failureLayer != null ||
    parsed.rpcIssue != null ||
    parsed.inferenceHealth?.ok !== true ||
    parsed.inferenceHealth.probed !== true ||
    parsed.terminalRuntimeHealth?.kind === "degraded"
  ) {
    throw new Error(`Managed sandbox status was not healthy: ${raw.slice(0, 4_000)}`);
  }
  return {
    inferenceEndpoint: String(parsed.inferenceHealth.endpoint ?? ""),
    phase: String(parsed.phase ?? "unknown"),
  };
}

async function waitForManagedHealthyStatus(
  sandboxName: string,
  supervision: SupervisionState,
  env: NodeJS.ProcessEnv,
  secrets: readonly string[],
  maxAttempts: number,
): Promise<ManagedStatus> {
  let lastDetail = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await runCommand(
      process.execPath,
      [nemohermesCli, "sandbox", "status", sandboxName, "--json"],
      supervision,
      {
        allowFailure: true,
        cwd: repoRoot,
        env,
        secrets,
        timeoutMs: 120_000,
      },
    );
    try {
      const status = validateManagedStatus(result.stdout, sandboxName);
      if (result.status === 0) return { ...status, attempts: attempt };
      lastDetail = `status command exited ${result.status}`;
    } catch (error) {
      lastDetail = error instanceof Error ? error.message : String(error);
    }
    if (attempt < maxAttempts) {
      if (attempt === 1) {
        console.log("[managed] Waiting for inference.local to recover after sandbox exec");
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  throw new Error(
    `Managed sandbox did not return to healthy status after ${maxAttempts} attempts: ${redact(
      lastDetail,
      secrets,
    ).slice(-8_000)}`,
  );
}

export function assertNoRegisteredGateways(raw: string): void {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("OpenShell gateway inventory was not a JSON array");
  }
  if (parsed.length > 0) {
    throw new Error(
      "Managed prototype refuses to change a shared OpenShell gateway; destroy or isolate existing gateways first",
    );
  }
}

export function isOwnedManagedTempRoot(candidate: string): boolean {
  try {
    const realCandidate = realpathSync(candidate);
    const realTemp = realpathSync(tmpdir());
    return (
      dirname(realCandidate) === realTemp &&
      basename(realCandidate).startsWith(MANAGED_TEMP_PREFIX) &&
      basename(realCandidate).length > MANAGED_TEMP_PREFIX.length
    );
  } catch {
    return false;
  }
}

function registryContainsSandbox(state: ManagedCleanupState): boolean {
  const registryPath = join(state.nemoclawStateRoot, "sandboxes.json");
  if (!existsSync(registryPath)) return false;
  const parsed = JSON.parse(readFileSync(registryPath, "utf8")) as {
    sandboxes?: Record<string, unknown>;
  };
  return Object.hasOwn(parsed.sandboxes ?? {}, state.sandboxName);
}

function fingerprintFile(path: string): string | null {
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Managed prototype refuses non-regular shared registry: ${path}`);
  }
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fingerprintManagedMigrationState(stateRoot: string): string {
  const hash = createHash("sha256");
  if (!existsSync(stateRoot)) {
    return hash.digest("hex");
  }
  const rootStat = lstatSync(stateRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Managed prototype refuses non-directory state root: ${stateRoot}`);
  }

  const hashEntry = (absolutePath: string, relativePath: string): void => {
    const stat = lstatSync(absolutePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Managed prototype refuses symlinked migration state: ${absolutePath}`);
    }
    if (stat.isDirectory()) {
      hash.update(`directory:${relativePath}\0`);
      for (const entry of readdirSync(absolutePath).sort()) {
        hashEntry(join(absolutePath, entry), join(relativePath, entry));
      }
      return;
    }
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) {
      throw new Error(`Managed prototype refuses unsupported migration state: ${absolutePath}`);
    }
    hash.update(`file:${relativePath}:${stat.mode & 0o777}\0`);
    hash.update(readFileSync(absolutePath));
    hash.update("\0");
  };

  for (const entry of readdirSync(stateRoot)
    .filter((name) => name.startsWith(".gateway-state-migration"))
    .sort()) {
    hashEntry(join(stateRoot, entry), entry);
  }
  return hash.digest("hex");
}

function removeOwnedManagedDirectory(
  candidate: string,
  expectedParent: string,
  expectedBasename: string,
): void {
  if (!existsSync(candidate)) return;
  if (dirname(candidate) !== expectedParent || basename(candidate) !== expectedBasename) {
    throw new Error(`Refusing to remove unowned managed state path: ${candidate}`);
  }
  const stat = lstatSync(candidate);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Refusing to remove non-directory managed state path: ${candidate}`);
  }
  rmSync(candidate, { recursive: true });
}

export function isOwnedManagedOnboardSession(
  raw: string,
  sandboxName: string,
  runStartedAtMs: number,
  gatewayName?: string,
  gatewayPort?: number,
): boolean {
  try {
    const parsed = JSON.parse(raw) as {
      agent?: unknown;
      checkpoint?: {
        gatewayAuthority?: {
          kind?: unknown;
          value?: { gatewayName?: unknown; gatewayPort?: unknown };
        };
      };
      sandboxName?: unknown;
      startedAt?: unknown;
      status?: unknown;
    };
    const startedAtMs =
      typeof parsed.startedAt === "string" ? Date.parse(parsed.startedAt) : Number.NaN;
    if (
      parsed.agent !== "hermes" ||
      !Number.isFinite(startedAtMs) ||
      startedAtMs < runStartedAtMs - 1_000
    ) {
      return false;
    }
    if (parsed.sandboxName === sandboxName) return true;
    if (parsed.sandboxName != null) return false;
    if (parsed.status === "failed") return true;
    const authority = parsed.checkpoint?.gatewayAuthority;
    return (
      parsed.status === "complete" &&
      authority?.kind === "selected" &&
      authority.value?.gatewayName === gatewayName &&
      authority.value?.gatewayPort === gatewayPort
    );
  } catch {
    return false;
  }
}

function assertNoLiveOpenShellGatewayContainers(raw: string): void {
  const names = raw
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter(Boolean)
    .filter((name) => name.startsWith("openshell-cluster-"));
  if (names.length > 0) {
    throw new Error(
      `Managed prototype refuses unregistered live OpenShell gateways: ${names.join(", ")}`,
    );
  }
}

export function assertNoManagedBridgeProxyContainers(raw: string): void {
  const names = raw
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.length > 0) {
    throw new Error(`Managed prototype refuses residual bridge proxies: ${names.join(", ")}`);
  }
}

async function loopbackPortIsBindable(port: number): Promise<boolean> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve());
    });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") return false;
    throw error;
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
}

function gatewayPidIsAlive(state: ManagedCleanupState): boolean {
  const pidFile = join(state.gatewayStateDir, "openshell-gateway.pid");
  if (!existsSync(pidFile)) return false;
  const pidRaw = readFileSync(pidFile, "utf8").trim();
  if (!/^[1-9][0-9]*$/.test(pidRaw)) {
    throw new Error(`Managed gateway retained an invalid PID file: ${pidFile}`);
  }
  const pid = Number(pidRaw);
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function startManagedInferenceProvider(
  state: ManagedCleanupState,
  apiKey: string,
): Promise<{ endpointUrl: string; port: number; requestLog: string }> {
  const readyFile = join(state.tempRoot, "managed-inference-ready");
  const requestLog = join(state.tempRoot, "managed-inference-requests.jsonl");
  writeFileSync(requestLog, "", { mode: 0o600 });
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", managedInferenceProvider],
    {
      detached: process.platform !== "win32",
      env: {
        NEMOCLAW_MANAGED_PROTOTYPE_API_KEY: apiKey,
        NEMOCLAW_MANAGED_PROTOTYPE_BIND_HOST: "0.0.0.0",
        NEMOCLAW_MANAGED_PROTOTYPE_BIND_PORT: "0",
        NEMOCLAW_MANAGED_PROTOTYPE_READY_FILE: readyFile,
        NEMOCLAW_MANAGED_PROTOTYPE_REQUEST_LOG: requestLog,
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  state.provider = child;
  state.providerStderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    state.providerStderr = `${state.providerStderr ?? ""}${chunk}`.slice(-16_000);
  });

  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Managed inference provider exited before readiness: ${redact(state.providerStderr ?? "", [
          apiKey,
        ])}`,
      );
    }
    if (existsSync(readyFile)) {
      const port = Number(readFileSync(readyFile, "utf8").trim());
      if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
        throw new Error(`Managed inference provider returned invalid port: ${port}`);
      }
      const response = await fetch(`http://127.0.0.1:${port}/v1/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) {
        throw new Error(`Managed inference provider readiness returned HTTP ${response.status}`);
      }
      return {
        endpointUrl: `http://host.openshell.internal:${port}/v1`,
        port,
        requestLog,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Managed inference provider did not become ready within 10 seconds");
}

async function probeManagedBridgePort(
  port: number,
  host: "host.docker.internal" | "host.openshell.internal",
  supervision: SupervisionState,
  dockerEnv: NodeJS.ProcessEnv,
): Promise<boolean> {
  const addHostArgs =
    host === "host.openshell.internal"
      ? ["--add-host", "host.openshell.internal:host-gateway"]
      : [];
  const probe = await runCommand(
    "docker",
    [
      "run",
      "--rm",
      "--pull=missing",
      "--network",
      "bridge",
      ...addHostArgs,
      MANAGED_BRIDGE_PROXY_IMAGE,
      "nc",
      "-zvw2",
      host,
      String(port),
    ],
    supervision,
    {
      allowFailure: true,
      cwd: repoRoot,
      env: dockerEnv,
      timeoutMs: 30_000,
    },
  );
  return probe.status === 0;
}

async function probeManagedLoopbackPort(
  port: number,
  host: "host.docker.internal" | "host.openshell.internal",
  supervision: SupervisionState,
  dockerEnv: NodeJS.ProcessEnv,
): Promise<boolean> {
  const server = createServer((socket) => socket.end());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  try {
    return await probeManagedBridgePort(port, host, supervision, dockerEnv);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function prepareManagedBridgeProxy(
  state: ManagedCleanupState,
  providerPort: number,
  dockerHost: string,
  supervision: SupervisionState,
): Promise<boolean> {
  const dockerEnv = buildManagedDockerEnvironment(dockerHost);
  const hostGatewayCanReachProvider = await probeManagedBridgePort(
    providerPort,
    "host.openshell.internal",
    supervision,
    dockerEnv,
  );
  const hostGatewayCanReachLoopback = await probeManagedLoopbackPort(
    state.gatewayPort,
    "host.openshell.internal",
    supervision,
    dockerEnv,
  );
  if (hostGatewayCanReachProvider && hostGatewayCanReachLoopback) {
    return false;
  }
  const dockerInternalCanReachProvider = await probeManagedBridgePort(
    providerPort,
    "host.docker.internal",
    supervision,
    dockerEnv,
  );
  const dockerInternalCanReachLoopback = await probeManagedLoopbackPort(
    state.gatewayPort,
    "host.docker.internal",
    supervision,
    dockerEnv,
  );
  if (!dockerInternalCanReachProvider || !dockerInternalCanReachLoopback) {
    throw new Error(
      "Docker containers cannot reach both the disposable provider and a loopback-only gateway through either supported host alias",
    );
  }

  const bridgeGatewayRaw = await runCommand(
    "docker",
    ["network", "inspect", "bridge", "--format", "{{json (index .IPAM.Config 0).Gateway}}"],
    supervision,
    { cwd: repoRoot, env: dockerEnv, timeoutMs: 30_000 },
  );
  const bridgeGateway = validateManagedBridgeGateway(bridgeGatewayRaw.stdout);
  const hostAddresses = await runCommand(
    "docker",
    [
      "run",
      "--rm",
      "--pull=never",
      "--network",
      "host",
      MANAGED_BRIDGE_PROXY_IMAGE,
      "ip",
      "-4",
      "addr",
      "show",
    ],
    supervision,
    { cwd: repoRoot, env: dockerEnv, timeoutMs: 30_000 },
  );
  const gatewayIsLocal = hostAddresses.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .some((fields) => fields[0] === "inet" && fields[1]?.split("/")[0] === bridgeGateway);
  if (!gatewayIsLocal) {
    throw new Error(`Docker bridge gateway ${bridgeGateway} is not local to the runtime VM`);
  }

  const containerName = `nemoclaw-hs-bridge-${process.pid}-${randomUUID().slice(0, 8)}`;
  state.bridgeProxy = { containerName, providerPort };
  const start = await runCommand(
    "docker",
    buildManagedBridgeProxyArgs({
      bridgeGateway,
      containerName,
      gatewayPort: state.gatewayPort,
      providerPort,
      sandboxName: state.sandboxName,
    }),
    supervision,
    { cwd: repoRoot, env: dockerEnv, timeoutMs: 30_000 },
  );
  const containerId = start.stdout.trim();
  if (!/^[0-9a-f]{64}$/.test(containerId)) {
    throw new Error("Managed bridge proxy returned an invalid container identity");
  }
  state.bridgeProxy = { containerId, containerName, providerPort };

  for (const port of new Set([state.gatewayPort, providerPort])) {
    if (!(await probeManagedBridgePort(port, "host.openshell.internal", supervision, dockerEnv))) {
      throw new Error(`Managed bridge proxy did not accept host-gateway port ${port}`);
    }
  }
  return true;
}

async function stopManagedInferenceProvider(
  state: ManagedCleanupState,
): Promise<string | undefined> {
  const child = state.provider;
  if (!child || child.exitCode !== null || child.signalCode !== null) return undefined;
  try {
    signalChildTree(child, "SIGTERM");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  await Promise.race([
    new Promise<void>((resolve) => child.once("close", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      signalChildTree(child, "SIGKILL");
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  return undefined;
}

function cleanupManagedBridgeProxy(state: ManagedCleanupState): string | undefined {
  const proxy = state.bridgeProxy;
  if (!proxy) return undefined;
  const inspectFormat = [
    "{{.Id}}",
    "{{.Name}}",
    `{{index .Config.Labels "${MANAGED_BRIDGE_PROXY_LABEL}"}}`,
    `{{index .Config.Labels "${MANAGED_BRIDGE_PROXY_LABEL}.sandbox"}}`,
  ].join("\t");
  const inspect = runCleanupCommand(
    "docker",
    ["inspect", "--format", inspectFormat, proxy.containerId ?? proxy.containerName],
    30_000,
    state.managedCommandEnv,
  );
  if (inspect.status !== 0) return undefined;
  const [containerId, containerName, prototypeLabel, sandboxLabel] = inspect.stdout
    .trim()
    .split("\t");
  if (
    !/^[0-9a-f]{64}$/.test(containerId ?? "") ||
    (proxy.containerId !== undefined && containerId !== proxy.containerId) ||
    containerName !== `/${proxy.containerName}` ||
    prototypeLabel !== "hermes-switchyard" ||
    sandboxLabel !== state.sandboxName
  ) {
    return "refused to stop a bridge proxy whose identity or ownership labels changed";
  }
  const stop = runCleanupCommand(
    "docker",
    ["stop", "--time", "2", containerId],
    30_000,
    state.managedCommandEnv,
  );
  const remaining = runCleanupCommand(
    "docker",
    ["inspect", containerId],
    30_000,
    state.managedCommandEnv,
  );
  if (remaining.status === 0) {
    const remove = runCleanupCommand(
      "docker",
      ["rm", "-f", containerId],
      30_000,
      state.managedCommandEnv,
    );
    if (remove.status !== 0) {
      return `failed to remove exact managed bridge proxy: ${(remove.stderr || remove.stdout).trim()}`;
    }
  } else if (stop.status !== 0 && !/No such (object|container)/i.test(stop.stderr)) {
    return `failed to stop exact managed bridge proxy: ${(stop.stderr || stop.stdout).trim()}`;
  }
  return undefined;
}

async function uploadArtifactBundle(
  sandboxName: string,
  artifactDirectory: string,
  remoteRoot: string,
  supervision: SupervisionState,
  managedEnv: NodeJS.ProcessEnv,
): Promise<void> {
  await runCommand(
    process.execPath,
    [
      nemohermesCli,
      "sandbox",
      "exec",
      sandboxName,
      "--no-tty",
      "--no-stdin",
      "--timeout",
      "30",
      "--",
      "mkdir",
      "-m",
      "0700",
      "-p",
      remoteRoot,
    ],
    supervision,
    { cwd: repoRoot, env: managedEnv, timeoutMs: 60_000 },
  );
  for (const name of PROTOTYPE_ARTIFACT_NAMES) {
    await runCommand(
      process.execPath,
      [
        nemohermesCli,
        "sandbox",
        "upload",
        sandboxName,
        join(artifactDirectory, name),
        `${remoteRoot}/${name}`,
      ],
      supervision,
      { cwd: repoRoot, env: managedEnv, timeoutMs: 120_000 },
    );
  }
  await runCommand(
    process.execPath,
    [
      nemohermesCli,
      "sandbox",
      "exec",
      sandboxName,
      "--no-tty",
      "--no-stdin",
      "--timeout",
      "30",
      "--",
      "chmod",
      "0555",
      `${remoteRoot}/fake-provider.py`,
      `${remoteRoot}/nemo-relay`,
      `${remoteRoot}/run.sh`,
      `${remoteRoot}/verify.py`,
    ],
    supervision,
    { cwd: repoRoot, env: managedEnv, timeoutMs: 60_000 },
  );
  await runCommand(
    process.execPath,
    [
      nemohermesCli,
      "sandbox",
      "exec",
      sandboxName,
      "--no-tty",
      "--no-stdin",
      "--timeout",
      "30",
      "--",
      "chmod",
      "0444",
      `${remoteRoot}/classifier-plugins.toml`,
      `${remoteRoot}/relay-revision`,
    ],
    supervision,
    { cwd: repoRoot, env: managedEnv, timeoutMs: 60_000 },
  );
}

function validateManagedInferenceRequests(
  requestLog: string,
  apiKey: string,
): {
  readonly authenticatedRequestCount: number;
  readonly modelsProbeSeen: boolean;
} {
  const raw = readFileSync(requestLog, "utf8");
  if (raw.includes(apiKey)) {
    throw new Error("Managed inference request log exposed its disposable credential");
  }
  const requests = raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  if (requests.length === 0 || requests.some((request) => request.auth_matches !== true)) {
    throw new Error("Managed inference provider observed a missing or invalid credential");
  }
  const modelsProbeSeen = requests.some(
    (request) => request.method === "GET" && request.path === "/v1/models",
  );
  if (!modelsProbeSeen) {
    throw new Error("Managed inference.local route was not validated through /v1/models");
  }
  return { authenticatedRequestCount: requests.length, modelsProbeSeen };
}

async function cleanupManagedState(state: ManagedCleanupState): Promise<string[]> {
  const errors: string[] = [];
  let destroyFailure = "";
  if (state.onboardAttempted) {
    const destroy = runCleanupCommand(
      process.execPath,
      [nemohermesCli, "sandbox", "destroy", state.sandboxName, "--yes", "--cleanup-gateway"],
      5 * 60_000,
      state.managedCommandEnv,
    );
    if (destroy.status !== 0) {
      destroyFailure = (destroy.stderr || destroy.stdout).trim();
    }
  }

  let gatewayRegistrationClean = false;
  try {
    const beforeRemoval = runCleanupCommand(
      "openshell",
      ["gateway", "list", "--output", "json"],
      30_000,
      state.managedCommandEnv,
    );
    if (prototypeGatewayRegistered(beforeRemoval.stdout, state)) {
      const remove = runCleanupCommand(
        "openshell",
        ["gateway", "remove", state.gatewayName],
        30_000,
        state.managedCommandEnv,
      );
      if (remove.status !== 0) {
        throw new Error(`failed to remove prototype gateway registration: ${remove.stderr.trim()}`);
      }
    }
    const afterRemoval = runCleanupCommand(
      "openshell",
      ["gateway", "list", "--output", "json"],
      30_000,
      state.managedCommandEnv,
    );
    assertNoRegisteredGateways(afterRemoval.stdout);
    gatewayRegistrationClean = true;
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  const bridgeProxyError = cleanupManagedBridgeProxy(state);
  if (bridgeProxyError) errors.push(bridgeProxyError);
  const residualBridgeProxies = runCleanupCommand(
    "docker",
    [
      "ps",
      "-a",
      "--filter",
      `label=${MANAGED_BRIDGE_PROXY_LABEL}=hermes-switchyard`,
      "--format",
      "{{.Names}}",
    ],
    30_000,
    state.managedCommandEnv,
  );
  try {
    assertNoManagedBridgeProxyContainers(residualBridgeProxies.stdout);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  const providerError = await stopManagedInferenceProvider(state);
  if (providerError) errors.push(`failed to stop managed inference provider: ${providerError}`);

  const registryClean = !registryContainsSandbox(state);
  if (!registryClean) {
    errors.push(`NemoClaw registry retained sandbox ${state.sandboxName}`);
  }
  if (destroyFailure) {
    errors.push(`failed to destroy exact managed sandbox ${state.sandboxName}: ${destroyFailure}`);
  }

  let gatewayRuntimeClean = false;
  try {
    const containerInventory = runCleanupCommand(
      "docker",
      ["ps", "-a", "--format", "{{.Names}}"],
      30_000,
      state.managedCommandEnv,
    );
    if (containerInventory.status !== 0) {
      throw new Error(
        `failed to inspect managed Docker containers: ${(
          containerInventory.stderr || containerInventory.stdout
        ).trim()}`,
      );
    }
    const volumeInventory = runCleanupCommand(
      "docker",
      ["volume", "ls", "--format", "{{.Name}}"],
      30_000,
      state.managedCommandEnv,
    );
    if (volumeInventory.status !== 0) {
      throw new Error(
        `failed to inspect managed Docker volumes: ${(
          volumeInventory.stderr || volumeInventory.stdout
        ).trim()}`,
      );
    }
    assertNoManagedPortDockerResources(
      state.gatewayPort,
      containerInventory.stdout,
      volumeInventory.stdout,
    );
    const residualSandboxContainers = splitNonEmptyLines(containerInventory.stdout).filter(
      (name) =>
        name === `openshell-${state.sandboxName}` ||
        name.startsWith(`openshell-${state.sandboxName}-`),
    );
    if (residualSandboxContainers.length > 0) {
      throw new Error(
        `Managed prototype retained sandbox containers: ${residualSandboxContainers.join(", ")}`,
      );
    }
    if (gatewayPidIsAlive(state)) {
      throw new Error(`Managed gateway process for ${state.gatewayName} is still alive`);
    }
    if (!(await loopbackPortIsBindable(state.gatewayPort))) {
      throw new Error(`Managed gateway port ${state.gatewayPort} still has a loopback listener`);
    }
    gatewayRuntimeClean = true;
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  if (existsSync(state.onboardSessionPath)) {
    try {
      const raw = readFileSync(state.onboardSessionPath, "utf8");
      if (
        isOwnedManagedOnboardSession(
          raw,
          state.sandboxName,
          state.runStartedAtMs,
          state.gatewayName,
          state.gatewayPort,
        )
      ) {
        rmSync(state.onboardSessionPath);
      } else {
        errors.push("refused to remove an onboarding session not owned by this prototype run");
      }
    } catch (error) {
      errors.push(
        `failed to remove the prototype onboarding session: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (registryClean && !destroyFailure && existsSync(state.sandboxServicesDir)) {
    try {
      removeOwnedManagedDirectory(
        state.sandboxServicesDir,
        "/tmp",
        `nemoclaw-services-${state.sandboxName}`,
      );
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (gatewayRegistrationClean && gatewayRuntimeClean && !destroyFailure) {
    const ownedDirectories = [
      {
        path: state.nemoclawStateRoot,
        parent: dirname(state.nemoclawStateRoot),
        basename: String(state.gatewayPort),
      },
      {
        path: state.gatewayStateDir,
        parent: dirname(state.gatewayStateDir),
        basename: `openshell-docker-gateway-${state.gatewayPort}`,
      },
      {
        path: state.gatewayRegistrationDir,
        parent: dirname(state.gatewayRegistrationDir),
        basename: state.gatewayName,
      },
    ];
    for (const owned of ownedDirectories) {
      try {
        removeOwnedManagedDirectory(owned.path, owned.parent, owned.basename);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }
  try {
    if (fingerprintFile(state.sharedRegistryPath) !== state.sharedRegistrySha256) {
      errors.push("Managed prototype changed the default NemoClaw sandbox registry");
    }
    if (
      fingerprintManagedMigrationState(dirname(state.sharedRegistryPath)) !==
      state.migrationStateFingerprint
    ) {
      errors.push("Managed prototype changed shared NemoClaw gateway-migration state");
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  if (isOwnedManagedTempRoot(state.tempRoot)) {
    try {
      rmSync(state.tempRoot, { force: true, recursive: true });
    } catch (error) {
      errors.push(
        `failed to remove managed prototype temporary root: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  } else {
    errors.push(`refused to remove unowned managed temporary path ${state.tempRoot}`);
  }
  return errors;
}

export async function runManagedHermesSwitchyardPrototype(): Promise<ManagedPrototypeResult> {
  if (!["darwin", "linux"].includes(process.platform)) {
    throw new Error("The managed Hermes Switchyard prototype requires macOS or Linux");
  }
  const supervision: SupervisionState = {};
  const managedHome = resolveManagedHome();
  const openshellConfigRoot = resolveManagedOpenShellConfigRoot(managedHome);
  const gatewayPort = await reserveManagedGatewayPort(managedHome, openshellConfigRoot);
  const gatewayName = `nemoclaw-${gatewayPort}`;
  const sharedStateRoot = join(managedHome, ".nemoclaw");
  const nemoclawStateRoot = join(sharedStateRoot, "gateways", String(gatewayPort));
  const sharedRegistryPath = join(sharedStateRoot, "sandboxes.json");
  const sandboxName = `hermes-switchyard-proto-${process.pid}-${randomUUID().slice(0, 8)}`;
  const tempRoot = mkdtempSync(join(tmpdir(), MANAGED_TEMP_PREFIX));
  chmodSync(tempRoot, 0o700);
  const state: ManagedCleanupState = {
    gatewayName,
    gatewayPort,
    gatewayRegistrationDir: join(openshellConfigRoot, "openshell", "gateways", gatewayName),
    gatewayStateDir: join(
      managedHome,
      ".local",
      "state",
      "nemoclaw",
      `openshell-docker-gateway-${gatewayPort}`,
    ),
    migrationStateFingerprint: fingerprintManagedMigrationState(sharedStateRoot),
    nemoclawStateRoot,
    onboardAttempted: false,
    onboardSessionPath: join(nemoclawStateRoot, "onboard-session.json"),
    runStartedAtMs: Date.now(),
    sandboxName,
    sharedRegistryPath,
    sharedRegistrySha256: fingerprintFile(sharedRegistryPath),
    sandboxServicesDir: `/tmp/nemoclaw-services-${sandboxName}`,
    tempRoot,
  };
  const bootstrapApiKey = `nemoclaw-managed-${randomUUID()}-${randomUUID()}`;
  const remoteRoot = `${REMOTE_PROTOTYPE_PARENT}/${sandboxName}`;
  let managedBridgeProxyUsed = false;
  let result: ManagedPrototypeResult | undefined;
  let primaryError: unknown;

  const onInterrupt = () => {
    supervision.interrupted = "SIGINT";
    if (supervision.activeChild) {
      try {
        signalChildTree(supervision.activeChild, "SIGTERM");
      } catch {
        // The normal cleanup path still runs when the child closes.
      }
    }
  };
  const onTerminate = () => {
    supervision.interrupted = "SIGTERM";
    if (supervision.activeChild) {
      try {
        signalChildTree(supervision.activeChild, "SIGTERM");
      } catch {
        // The normal cleanup path still runs when the child closes.
      }
    }
  };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);

  try {
    console.log("[managed] Verifying an isolated OpenShell lifecycle");
    const dockerDiscoveryEnv = { ...process.env };
    delete dockerDiscoveryEnv.DOCKER_HOST;
    const dockerContext = await runCommand(
      "docker",
      ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"],
      supervision,
      { cwd: repoRoot, env: dockerDiscoveryEnv, timeoutMs: 30_000 },
    );
    const dockerHost = validateManagedDockerHost(dockerContext.stdout);
    state.managedCommandEnv = buildManagedCommandEnvironment({
      dockerHost,
      gatewayName,
      gatewayPort,
    });
    const dockerEnv = buildManagedDockerEnvironment(dockerHost);
    await runCommand("docker", ["info", "--format", "{{json .ServerVersion}}"], supervision, {
      cwd: repoRoot,
      env: dockerEnv,
      timeoutMs: 30_000,
    });

    const registeredGateways = await runCommand(
      "openshell",
      ["gateway", "list", "--output", "json"],
      supervision,
      { cwd: repoRoot, env: state.managedCommandEnv, timeoutMs: 30_000 },
    );
    assertNoRegisteredGateways(registeredGateways.stdout);
    if (
      existsSync(state.onboardSessionPath) ||
      existsSync(state.nemoclawStateRoot) ||
      existsSync(state.gatewayStateDir) ||
      existsSync(state.gatewayRegistrationDir)
    ) {
      throw new Error(
        "Managed prototype refuses to replace existing state for its reserved gateway port",
      );
    }
    if (existsSync(state.sandboxServicesDir)) {
      throw new Error("Managed prototype refuses an existing sandbox service directory");
    }
    if (!(await loopbackPortIsBindable(gatewayPort))) {
      throw new Error(`Managed gateway port ${gatewayPort} became busy before onboarding`);
    }
    const liveContainers = await runCommand(
      "docker",
      ["ps", "--format", "{{.Names}}"],
      supervision,
      { cwd: repoRoot, env: dockerEnv, timeoutMs: 30_000 },
    );
    assertNoLiveOpenShellGatewayContainers(liveContainers.stdout);
    const allContainers = await runCommand(
      "docker",
      ["ps", "-a", "--format", "{{.Names}}"],
      supervision,
      { cwd: repoRoot, env: dockerEnv, timeoutMs: 30_000 },
    );
    const allVolumes = await runCommand(
      "docker",
      ["volume", "ls", "--format", "{{.Name}}"],
      supervision,
      { cwd: repoRoot, env: dockerEnv, timeoutMs: 30_000 },
    );
    assertNoManagedPortDockerResources(gatewayPort, allContainers.stdout, allVolumes.stdout);
    const prototypeProxyInventory = await runCommand(
      "docker",
      [
        "ps",
        "-a",
        "--filter",
        `label=${MANAGED_BRIDGE_PROXY_LABEL}=hermes-switchyard`,
        "--format",
        "{{.Names}}",
      ],
      supervision,
      { cwd: repoRoot, env: dockerEnv, timeoutMs: 30_000 },
    );
    assertNoManagedBridgeProxyContainers(prototypeProxyInventory.stdout);
    if (process.platform === "darwin") {
      const serviceState = await runCommand(
        "brew",
        ["services", "info", "openshell", "--json"],
        supervision,
        { cwd: repoRoot, timeoutMs: 60_000 },
      );
      assertInactiveHomebrewGatewayService(serviceState.stdout);
    }

    console.log("[managed] Exporting the exact pinned Relay and Switchyard bundle");
    const artifact = await exportPrototypeArtifactBundle(join(tempRoot, "artifact"), dockerEnv);

    console.log("[managed] Starting a disposable authenticated inference.local backend");
    const inference = await startManagedInferenceProvider(state, bootstrapApiKey);
    managedBridgeProxyUsed = await prepareManagedBridgeProxy(
      state,
      inference.port,
      dockerHost,
      supervision,
    );
    if (managedBridgeProxyUsed) {
      console.log("[managed] Bridging Rancher host-gateway ports inside the runtime VM");
    }
    const onboardEnv = buildManagedOnboardEnvironment({
      apiKey: bootstrapApiKey,
      dockerHost,
      endpointUrl: inference.endpointUrl,
      gatewayName,
      gatewayPort,
      sandboxName,
    });

    console.log(`[managed] Onboarding disposable Hermes sandbox ${sandboxName}`);
    state.onboardAttempted = true;
    await runCommand(process.execPath, buildManagedOnboardArgs(sandboxName), supervision, {
      cwd: repoRoot,
      env: onboardEnv,
      secrets: [bootstrapApiKey],
      timeoutMs: 30 * 60_000,
    });

    const statusBefore = await waitForManagedHealthyStatus(
      sandboxName,
      supervision,
      state.managedCommandEnv,
      [bootstrapApiKey],
      3,
    );

    console.log("[managed] Uploading the sentinel-only bundle through NemoClaw");
    await uploadArtifactBundle(
      sandboxName,
      artifact.directory,
      remoteRoot,
      supervision,
      state.managedCommandEnv,
    );
    const uploadedHash = await runCommand(
      process.execPath,
      [
        nemohermesCli,
        "sandbox",
        "exec",
        sandboxName,
        "--no-tty",
        "--no-stdin",
        "--timeout",
        "30",
        "--",
        "sha256sum",
        `${remoteRoot}/nemo-relay`,
      ],
      supervision,
      { cwd: repoRoot, env: state.managedCommandEnv, timeoutMs: 60_000 },
    );
    if (!uploadedHash.stdout.includes(artifact.relayBinarySha256)) {
      throw new Error("Uploaded Relay binary did not match the exported artifact");
    }

    const basePolicy = await runCommand(
      process.execPath,
      [nemohermesCli, "sandbox", "policy", "get", sandboxName],
      supervision,
      { cwd: repoRoot, env: state.managedCommandEnv, timeoutMs: 60_000 },
    );
    const effectivePolicy = await runCommand(
      "openshell",
      ["policy", "get", "--full", "--output", "json", sandboxName],
      supervision,
      { cwd: repoRoot, env: state.managedCommandEnv, timeoutMs: 60_000 },
    );
    if (!basePolicy.stdout.trim() || !effectivePolicy.stdout.trim()) {
      throw new Error("Managed sandbox policy evidence was empty");
    }
    if (
      basePolicy.stdout.includes(bootstrapApiKey) ||
      effectivePolicy.stdout.includes(bootstrapApiKey)
    ) {
      throw new Error("Managed sandbox policy exposed the disposable inference credential");
    }

    console.log("[managed] Running weak/fast and strong/quality Hermes routing turns");
    const turn = await runCommand(
      process.execPath,
      buildManagedTurnExecArgs(sandboxName, remoteRoot, artifact.relayBinarySha256),
      supervision,
      {
        cwd: repoRoot,
        env: state.managedCommandEnv,
        secrets: [
          bootstrapApiKey,
          HERMES_SWITCHYARD_PROTOTYPE.clientApiKey,
          HERMES_SWITCHYARD_PROTOTYPE.providerAuthorization,
        ],
        timeoutMs: 5 * 60_000,
      },
    );
    const turnResult = parsePrototypeResult(turn.stdout, turn.stderr);
    if (
      turnResult.runtime !== "nemoclaw-managed" ||
      turnResult.network !== "openshell-managed" ||
      turnResult.relay_binary_sha256 !== artifact.relayBinarySha256
    ) {
      throw new Error("Managed turn evidence did not match its sandbox and artifact contract");
    }
    const demoTurns = turnResult.demo_turns;
    if (!Array.isArray(demoTurns) || demoTurns.length !== 2) {
      throw new Error("Managed routing demo did not return exactly two turns");
    }
    console.log("[managed] Weak/fast and strong/quality routes verified with streaming");
    console.log("\nHermes → Relay → in-process Switchyard\n");
    for (const [index, turn] of demoTurns.entries()) {
      if (
        !turn ||
        typeof turn !== "object" ||
        typeof turn.tier !== "string" ||
        typeof turn.target !== "string" ||
        typeof turn.model !== "string" ||
        typeof turn.prompt !== "string" ||
        typeof turn.reason !== "string" ||
        typeof turn.answer !== "string"
      ) {
        throw new Error(`Managed routing demo turn ${index + 1} was invalid`);
      }
      console.log(`Turn ${index + 1}: ${turn.tier.toUpperCase()} → ${turn.target}`);
      console.log(`  Prompt: ${turn.prompt}`);
      console.log(`  Model:  ${turn.model}`);
      console.log(`  Why:    ${turn.reason}`);
      console.log(`  Hermes: ${turn.answer}\n`);
    }

    const statusAfter = await waitForManagedHealthyStatus(
      sandboxName,
      supervision,
      state.managedCommandEnv,
      [bootstrapApiKey],
      15,
    );
    const inferenceEvidence = validateManagedInferenceRequests(
      inference.requestLog,
      bootstrapApiKey,
    );
    const cliVersion = await runCommand(
      process.execPath,
      [nemohermesCli, "--version"],
      supervision,
      { cwd: repoRoot, env: state.managedCommandEnv, timeoutMs: 30_000 },
    );
    const openshellVersion = await runCommand("openshell", ["--version"], supervision, {
      cwd: repoRoot,
      env: state.managedCommandEnv,
      timeoutMs: 30_000,
    });

    result = {
      ...turnResult,
      base_policy_sha256: createHash("sha256").update(basePolicy.stdout).digest("hex"),
      effective_policy_sha256: createHash("sha256").update(effectivePolicy.stdout).digest("hex"),
      inference_local_authenticated_requests: inferenceEvidence.authenticatedRequestCount,
      inference_local_models_probe: inferenceEvidence.modelsProbeSeen,
      managed_execution_boundary: "nemoclaw-upload-exec",
      managed_gateway_healthy_after: true,
      managed_gateway_healthy_before: true,
      managed_health_attempts_after: statusAfter.attempts,
      managed_health_attempts_before: statusBefore.attempts,
      managed_gateway_name: gatewayName,
      managed_gateway_port: gatewayPort,
      managed_host_gateway_proxy: managedBridgeProxyUsed,
      managed_host_gateway_proxy_image: managedBridgeProxyUsed ? MANAGED_BRIDGE_PROXY_IMAGE : null,
      managed_inference_endpoint: statusBefore.inferenceEndpoint,
      managed_sandbox: sandboxName,
      managed_state_isolated: true,
      shared_default_registry_unchanged: true,
      nemoclaw_cli_version: cliVersion.stdout.trim(),
      openshell_version: openshellVersion.stdout.trim(),
      relay_pull_ref: HERMES_SWITCHYARD_PROTOTYPE.relayPullRef,
      relay_revision: HERMES_SWITCHYARD_PROTOTYPE.relayRevision,
      sandbox_phase_after: statusAfter.phase,
      sandbox_phase_before: statusBefore.phase,
      switchyard_revision: HERMES_SWITCHYARD_PROTOTYPE.switchyardRevision,
    };
  } catch (error) {
    primaryError = error;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
  }

  console.log(`[managed] Destroying disposable sandbox ${sandboxName} and its gateway`);
  const cleanupErrors = await cleanupManagedState(state);
  if (primaryError) {
    if (cleanupErrors.length > 0) {
      throw new Error(
        `${redact(primaryError instanceof Error ? primaryError.message : String(primaryError), [
          bootstrapApiKey,
        ])}\nCleanup also failed:\n${cleanupErrors.join("\n")}`,
        { cause: primaryError },
      );
    }
    throw primaryError;
  }
  if (cleanupErrors.length > 0) {
    throw new Error(cleanupErrors.join("\n"));
  }
  if (!result) throw new Error("Managed prototype completed without a result");

  const completeResult: ManagedPrototypeResult = {
    ...result,
    gateway_destroyed: true,
    sandbox_destroyed: true,
    status: "pass",
  };
  console.log(MANAGED_RESULT_PREFIX + JSON.stringify(completeResult));
  console.log(JSON.stringify(completeResult, null, 2));
  return completeResult;
}

function printHelp(): void {
  console.log(`Experimental managed Hermes -> Relay -> Switchyard prototype

Usage:
  npm run prototype:hermes-switchyard:managed

The command requires no real provider credentials. It refuses a shared
OpenShell gateway, onboards a unique disposable Hermes sandbox through the source
NemoClaw CLI, validates inference.local with a short-lived authenticated fake
inference provider, uploads the exact pinned Relay/Switchyard bundle, runs weak/fast
and strong/quality routed turns through NemoClaw sandbox exec, verifies managed
status and policy evidence, and destroys the disposable sandbox. It also removes
the gateway, build artifacts, and inference provider.
On VM-backed Docker runtimes whose host-gateway alias cannot reach host
loopback, it also creates and removes a pinned unprivileged TCP bridge for only
the gateway and disposable-provider ports.

The result verifies one pinned upload-and-exec path in a NemoClaw-managed
sandbox. This experimental developer check is not a supported NemoClaw
integration. It does not make uploaded artifacts trusted, integrate Relay into
the supervised always-on Hermes gateway, or authorize real provider credentials.`);
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    return;
  }
  if (process.argv.length > 2) {
    throw new Error("This managed prototype accepts no options; use --help for usage and limits");
  }
  await runManagedHermesSwitchyardPrototype();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
