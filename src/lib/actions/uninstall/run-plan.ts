// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SpawnSyncOptions, type SpawnSyncReturns, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { dockerSpawnSync } from "../../adapters/docker/exec";
import { type OpenRegularFile, openRegularFileNoFollow } from "../../adapters/fs/regular-file";
import { type AgentBranding, getAgentBranding } from "../../cli/branding";
import { isErrnoException } from "../../core/errno";
import { DEFAULT_GATEWAY_PORT, GATEWAY_PORT } from "../../core/ports";
import { isStdinTty, readLineFromStdin } from "../../core/stdin";
import { sleepMs } from "../../core/wait";
import { getSandboxDeleteOutcome } from "../../domain/sandbox/destroy";
import {
  gatewayDestroySkipMessage,
  OPENSHELL_SANDBOXES_DELETE_SKIP_MESSAGE,
  preservedRegistryUnrecoverableWarnings,
  providerDeleteSkipMessage,
  sandboxDeleteAbsentMessage,
  sandboxDeleteFailureMessage,
} from "../../domain/uninstall/messaging";
import {
  cleanupManagedLlamaCppRuntimeForSandbox,
  HOST_LOCAL_VLLM_CONTAINER_NAME,
  HOST_LOCAL_VLLM_MANAGED_LABEL,
  type ManagedLlamaCppCleanupTarget,
  resolveManagedLlamaCppCleanupTarget,
} from "../../inference/local-model-profile/cleanup";
import { isOllamaAuthProxyCommandLine } from "../../inference/ollama/process";
import {
  DUAL_STATION_VLLM_RUNTIME_RECEIPT_FILE,
  findManagedDistributedVllmRuntimeReceipts,
  isManagedClusterDiscoveryBindingStateEntry,
  isManagedClusterRuntimeBindingStateEntry,
  MANAGED_CLUSTER_VLLM_RUNTIME_RECEIPT_FILE,
  MANAGED_VLLM_API_KEY_FILE,
  MCP_LIFECYCLE_LOCK_DIRNAME,
} from "../../inference/serving/managed-runtime-receipts";
import { buildDockerGatewayDebEnvFile } from "../../onboard/docker-driver-gateway-env";
import {
  getTrustedActiveOpenShellGatewayUserServiceIdentity,
  getNemoclawOpenShellGatewayUserServicePath,
  getOpenShellUserConfigHome,
  NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE,
  NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER_LINE,
} from "../../onboard/docker-driver-gateway-service";
import { resolveGatewayName, resolveGatewayPortFromName } from "../../onboard/gateway-binding";
import { type GatewayOwner, isExternallySupervised } from "../../onboard/gateway-ownership";
import {
  type GatewayTeardownAuthorityResolver,
  resolveGatewayTeardownAuthority,
} from "../../onboard/gateway-teardown-authority";
import {
  externallySupervisedHostGatewayProcessOwnershipFailure,
  hasStateScopedSandboxNamespace,
  processUsesStateScopedSandboxNamespace,
  scopedHostGatewayProcessOwnershipFailure,
  type StopHostGatewayOptions,
  stopHostGatewayProcesses,
} from "../../onboard/host-gateway-process";
import { isModelRouterCommandLineForPort } from "../../onboard/model-router-process";
import { stopStaleDashboardListeners } from "../../onboard/stale-gateway-cleanup";
import {
  assertGatewayStatePathSafe,
  GATEWAYS_SUBDIR,
  type GatewayRegistryDocument,
  listGatewayStateRoots,
  readGatewayRegistryFile,
  registryEntryGatewayPort,
  withRegistryLockAt,
} from "../../state/gateway-registry";
import {
  managedHermesStateVolumeContext,
  type ManagedHermesStateVolumeContext,
  removeManagedHermesStateVolumes,
  stopHermesForwardWatchers,
} from "./hermes-uninstall-cleanup";
import {
  stopBedrockRuntimeAdapter,
  stopHttpsPinRuntimeAdapter,
  stopOpenRouterRuntimeAdapter,
} from "./openrouter-runtime-adapter-cleanup";
import {
  buildUninstallPlan,
  classifyShimPath,
  defaultUninstallPaths,
  NEMOCLAW_PROVIDERS,
  type FileSystemDeps,
  type UninstallPaths,
  type UninstallPlan,
} from "./plan";
import {
  HERMES_PORTABLE_UNINSTALL_JOURNAL_FILE,
  hasPortableRuntimeCleanup,
  PORTABLE_RETIREMENT_STATE_ENTRIES,
  portableRetirementPreservationEntries,
  runPortableRuntimeCleanupTransaction,
  type PortableRuntimeCleanupInput,
  type PortableRuntimeCleanupResult,
  withPortableHostFence,
} from "./portable-runtime-cleanup";

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface UninstallRunOptions {
  assumeYes: boolean;
  deleteModels: boolean;
  destroyUserData?: boolean;
  gatewayName?: string;
  keepOpenShell: boolean;
}

export interface UninstallRunDeps {
  commandExists?: (command: string) => boolean;
  env?: NodeJS.ProcessEnv;
  error?: (message: string) => void;
  existsSync?: (target: string) => boolean;
  fs?: FileSystemDeps;
  getTrustedActiveOpenShellGatewayUserServiceIdentity?: typeof getTrustedActiveOpenShellGatewayUserServiceIdentity;
  isPortFree?: (port: number) => boolean;
  isTty?: boolean;
  kill?: (pid: number, signal?: NodeJS.Signals | number) => boolean;
  log?: (message: string) => void;
  openRegularFile?: typeof openRegularFileNoFollow;
  platform?: NodeJS.Platform;
  readProcessArgv?: (pid: number) => readonly string[] | null;
  readProcessExecutable?: (pid: number) => string | null;
  readProcessEnvironment?: (pid: number) => Record<string, string> | null;
  realpathSync?: (target: string) => string;
  readProcessIdentity?: (pid: number, fresh?: boolean) => string | null;
  readLine?: () => string | null;
  requireCompleteGatewayProcessCleanup?: boolean;
  resolveGatewayTeardownAuthority?: GatewayTeardownAuthorityResolver;
  retainedGatewayPorts?: readonly number[];
  rmSync?: typeof fs.rmSync;
  run?: (command: string, args: string[], options?: SpawnSyncOptions) => RunResult;
  runDocker?: (args: string[], options?: SpawnSyncOptions) => RunResult;
  runDualStationRuntimeCleanup?: (receiptPath: string, options?: SpawnSyncOptions) => RunResult;
  runHuggingFaceCacheDataCleanup?: (options?: SpawnSyncOptions) => RunResult;
  runLocalModelRuntimeCleanup?: (options?: SpawnSyncOptions) => RunResult;
  runManagedLlamaCppRuntimeCleanup?: (sandboxName: string, gatewayPort: number) => RunResult;
  sleep?: (milliseconds: number) => void;
  hasPortableRuntimeCleanup?: (stateDir: string) => boolean;
  runPortableRuntimeCleanupTransaction?: (
    input: PortableRuntimeCleanupInput,
    continueAfterSandboxRemoval: (
      removed: number,
      sandboxNames: readonly string[],
      gatewayName: string,
    ) => boolean,
  ) => PortableRuntimeCleanupResult | null;
  stderrHasColors?: boolean;
  stderrIsTty?: boolean;
  withPortableHostFence?: typeof withPortableHostFence;
}

export interface UninstallRunOutcome {
  exitCode: number;
  otherGatewayEnvironmentsRemain?: boolean;
  plan: UninstallPlan;
}

const OPENSHELL_COMMAND_MISSING_ERROR =
  "openshell command not found. Restore it to PATH and re-run nemoclaw uninstall.";
export const MANAGED_INFERENCE_CONTAINER_NAME_PATTERN =
  /^(?:nemoclaw-vllm|nemoclaw-vllm-worker|nemoclaw-llama-cpp|nemoclaw-vllm-cluster-rank-[0-9]+)$/;

function toRunResult(result: SpawnSyncReturns<string | Buffer>): RunResult {
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : String(result.stdout ?? ""),
    stderr: typeof result.stderr === "string" ? result.stderr : String(result.stderr ?? ""),
  };
}

function defaultRun(command: string, args: string[], options: SpawnSyncOptions = {}): RunResult {
  return toRunResult(spawnSync(command, args, { encoding: "utf-8", ...options }));
}

function defaultRunDocker(args: string[], options: SpawnSyncOptions = {}): RunResult {
  return toRunResult(dockerSpawnSync(args, { encoding: "utf-8", ...options }));
}

function defaultCommandExists(command: string, env: NodeJS.ProcessEnv): boolean {
  if (!command || command.includes("\0")) return false;
  const hasPathSeparator =
    command.includes(path.sep) ||
    command.includes(path.posix.sep) ||
    command.includes(path.win32.sep);
  const candidates = hasPathSeparator
    ? [command]
    : String(env.PATH || "")
        .split(path.delimiter)
        .filter(Boolean)
        .map((entry) => path.join(entry, command));
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      // Try the next PATH entry.
    }
  }
  return false;
}

function splitNonEmptyLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pathEntryExists(target: string, runtime: Pick<UninstallRuntime, "existsSync">): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return runtime.existsSync(target);
    return true;
  }
}

type SharedRegistrySiblingStatus = "none" | "present" | "uncertain";

interface SharedRegistrySiblings {
  ports: readonly number[];
  status: SharedRegistrySiblingStatus;
}

function sharedRegistrySiblingStatus(
  paths: UninstallPaths,
  runtime: Pick<UninstallRuntime, "existsSync">,
  liveGatewayNames: () => Set<string> | null,
): SharedRegistrySiblings {
  const sharedRoot = path.dirname(paths.managedSwapMarkerPath);
  const registryFile = path.join(sharedRoot, "sandboxes.json");
  if (!pathEntryExists(registryFile, runtime)) return { ports: [], status: "none" };
  try {
    const registry = readGatewayRegistryFile(path.dirname(sharedRoot), registryFile);
    if (!registry) return { ports: [], status: "uncertain" };
    const siblingPorts = Object.values(registry.sandboxes)
      .map((entry) => registryEntryGatewayPort(entry))
      .filter((port) => port !== GATEWAY_PORT);
    if (siblingPorts.length === 0) return { ports: [], status: "none" };
    // A non-current registry row is a live sibling only while OpenShell still
    // knows its gateway; a stale row must not report "present".
    const live = liveGatewayNames();
    if (live === null) return { ports: siblingPorts, status: "present" };
    const livePorts = siblingPorts.filter((port) => live.has(resolveGatewayName(port)));
    return livePorts.length > 0
      ? { ports: livePorts, status: "present" }
      : { ports: [], status: "none" };
  } catch {
    // Unknown ownership must never permit host-global cleanup.
    return { ports: [], status: "uncertain" };
  }
}

function globToRegExp(pattern: string): RegExp {
  return new RegExp(
    `^${path
      .basename(pattern)
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  );
}

function removeGlob(
  pattern: string,
  deps: Required<Pick<UninstallRunDeps, "existsSync" | "log" | "rmSync">>,
): void {
  const dir = path.dirname(pattern);
  const matcher = globToRegExp(pattern);
  if (!deps.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    if (!matcher.test(entry)) continue;
    const target = path.join(dir, entry);
    deps.rmSync(target, { force: true, recursive: true });
    deps.log(`Removed ${target}`);
  }
}

function removePath(
  target: string,
  deps: Required<Pick<UninstallRunDeps, "existsSync" | "log" | "rmSync">>,
): boolean {
  if (!deps.existsSync(target)) return false;
  deps.rmSync(target, { force: true, recursive: true });
  deps.log(`Removed ${target}`);
  return true;
}

// Entries under `nemoclawStateDir` (~/.nemoclaw/) that survive uninstall by
// default. `rebuild-backups/` holds host-side snapshots from
// `nemoclaw <name> snapshot create` and `nemoclaw backup-all`; `backups/`
// holds host-side workspace backups from `scripts/backup-workspace.sh`;
// `sandboxes.json` is the host-side sandbox registry. Full wipe still happens
// when NEMOCLAW_UNINSTALL_DESTROY_USER_DATA=1 is set, or when the user answers
// `y` to the interactive prompt.
const PRESERVED_USER_DATA_ENTRIES: readonly string[] = [
  "rebuild-backups",
  "backups",
  "sandboxes.json",
];

const HTTPS_PIN_RUNTIME_ADAPTER_STATE_ENTRIES: readonly string[] = [
  "https-pin-runtime-adapter.pid",
  "https-pin-runtime-adapter-token",
  "https-pin-runtime-adapter.json",
  "https-pin-runtime-adapter.lock",
  "https-pin-runtime-adapter.log",
];

const OLLAMA_AUTH_PROXY_STATE_ENTRIES: readonly string[] = [
  "ollama-proxy-token",
  "ollama-backend",
  "ollama-backend.json",
  "ollama-proxy-port",
  "ollama-auth-proxy.pid",
  "ollama-auth-proxy.status",
];
const PORTABLE_DEFERRED_STEP_MESSAGES: Readonly<Record<string, string>> = {
  "Docker resources": "Kept Podman images and containers outside receipt-owned cleanup.",
  "Model stores": "Kept model stores and every Podman image during portable cleanup.",
  "OpenShell resources": "Deferring exact portable resource cleanup until earlier work succeeds.",
  "Stopping services": "Kept shared helper and model services during portable cleanup.",
};

// These entries can exist in the shared root without representing a running
// default-port environment. Any other shared-root entry is treated
// conservatively as default-port state when uninstalling a non-default port.
const SHARED_HOST_STATE_ENTRIES = new Set([
  ...PRESERVED_USER_DATA_ENTRIES,
  "source",
  GATEWAYS_SUBDIR,
  "managed_swap",
  MANAGED_CLUSTER_VLLM_RUNTIME_RECEIPT_FILE,
  DUAL_STATION_VLLM_RUNTIME_RECEIPT_FILE,
  `${DUAL_STATION_VLLM_RUNTIME_RECEIPT_FILE}.ssh-binding`,
  MANAGED_VLLM_API_KEY_FILE,
  ...HTTPS_PIN_RUNTIME_ADAPTER_STATE_ENTRIES,
  ...OLLAMA_AUTH_PROXY_STATE_ENTRIES,
  "portable-demo-lifecycle",
]);

function isSharedHostStateEntry(entry: string): boolean {
  return (
    SHARED_HOST_STATE_ENTRIES.has(entry) ||
    isManagedClusterRuntimeBindingStateEntry(entry) ||
    isManagedClusterDiscoveryBindingStateEntry(entry)
  );
}

function managedClusterBindingStateEntries(stateDir: string): readonly string[] {
  try {
    return fs
      .readdirSync(stateDir)
      .filter(
        (entry) =>
          isManagedClusterRuntimeBindingStateEntry(entry) ||
          isManagedClusterDiscoveryBindingStateEntry(entry),
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function scopedStatePreservationEntries(
  stateDir: string,
  selectedIsDefault: boolean,
): readonly string[] {
  return [
    ...(selectedIsDefault ? OLLAMA_AUTH_PROXY_STATE_ENTRIES : []),
    ...HTTPS_PIN_RUNTIME_ADAPTER_STATE_ENTRIES,
    MANAGED_CLUSTER_VLLM_RUNTIME_RECEIPT_FILE,
    ...managedClusterBindingStateEntries(stateDir),
    DUAL_STATION_VLLM_RUNTIME_RECEIPT_FILE,
    `${DUAL_STATION_VLLM_RUNTIME_RECEIPT_FILE}.ssh-binding`,
    MANAGED_VLLM_API_KEY_FILE,
    "portable-demo-lifecycle",
  ];
}

function dormantHostGlobalLifecycleState(sharedRoot: string): boolean {
  const stateDir = path.join(sharedRoot, "state");
  try {
    const state = fs.lstatSync(stateDir);
    if (state.isSymbolicLink() || !state.isDirectory()) return false;
    const entries = fs.readdirSync(stateDir);
    if (entries.length === 0) return true;
    if (entries.length !== 1 || entries[0] !== MCP_LIFECYCLE_LOCK_DIRNAME) return false;
    const locksDir = path.join(stateDir, MCP_LIFECYCLE_LOCK_DIRNAME);
    const locks = fs.lstatSync(locksDir);
    return !locks.isSymbolicLink() && locks.isDirectory() && fs.readdirSync(locksDir).length === 0;
  } catch {
    return false;
  }
}

function removePathExcept(
  target: string,
  preserve: readonly string[],
  deps: Required<Pick<UninstallRunDeps, "existsSync" | "log" | "rmSync">> &
    Pick<UninstallRuntime, "warn">,
): boolean {
  if (!deps.existsSync(target)) return true;
  if (preserve.length === 0) {
    deps.rmSync(target, { force: true, recursive: true });
    deps.log(`Removed ${target}`);
    return true;
  }
  // Only enumerate when `target` is a real directory. A symlink or non-dir
  // would make readdirSync follow into / fail noisily; treat those as
  // wholesale removal, matching prior behaviour for unusual shapes.
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch (err) {
    // ENOENT — gone already, nothing to do. Any other error means we cannot
    // safely decide whether to enumerate or remove; surface it and report
    // failure so uninstall returns a non-zero exit instead of silently
    // claiming success while leaving state on disk.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return true;
    deps.warn(`Failed to inspect ${target}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  if (!stat.isDirectory()) {
    deps.rmSync(target, { force: true, recursive: true });
    deps.log(`Removed ${target}`);
    return true;
  }
  const preserveSet = new Set(preserve);
  const children = fs.readdirSync(target);
  for (const entry of children) {
    if (preserveSet.has(entry)) continue;
    deps.rmSync(path.join(target, entry), { force: true, recursive: true });
  }
  // Track preserved order against the declared allowlist so the log line is
  // stable across filesystems with non-deterministic readdir ordering.
  const childSet = new Set(children);
  const preserved = preserve.filter((name) => childSet.has(name));
  if (preserved.length === 0) {
    deps.rmSync(target, { force: true, recursive: true });
    deps.log(`Removed ${target}`);
    return true;
  }
  deps.log(`Removed contents of ${target} (preserved: ${preserved.join(", ")})`);
  return true;
}

function removeFileWithOptionalSudo(target: string, deps: UninstallRuntime): void {
  if (!deps.existsSync(target)) return;
  const parent = path.dirname(target);
  try {
    fs.accessSync(parent, fs.constants.W_OK);
    deps.rmSync(target, { force: true });
    deps.log(`Removed ${target}`);
  } catch {
    if (deps.env.NEMOCLAW_NON_INTERACTIVE === "1" || !deps.isTty) {
      deps.warn(`Skipping privileged removal of ${target} in non-interactive mode.`);
      return;
    }
    const result = deps.run("sudo", ["rm", "-f", target], { env: deps.env });
    if (result.status === 0) deps.log(`Removed ${target}`);
    else deps.warn(`Failed to remove ${target}`);
  }
}

interface UninstallRuntime {
  commandExists: (command: string) => boolean;
  env: NodeJS.ProcessEnv;
  error: (message: string) => void;
  existsSync: (target: string) => boolean;
  getTrustedActiveOpenShellGatewayUserServiceIdentity: typeof getTrustedActiveOpenShellGatewayUserServiceIdentity;
  isPortFree: ((port: number) => boolean) | undefined;
  isTty: boolean;
  kill: (pid: number, signal?: NodeJS.Signals | number) => boolean;
  log: (message: string) => void;
  openRegularFile: typeof openRegularFileNoFollow;
  platform: NodeJS.Platform;
  readProcessArgv: ((pid: number) => readonly string[] | null) | undefined;
  readProcessExecutable: ((pid: number) => string | null) | undefined;
  readProcessEnvironment: ((pid: number) => Record<string, string> | null) | undefined;
  realpathSync: (target: string) => string;
  readProcessIdentity: ((pid: number, fresh?: boolean) => string | null) | undefined;
  readLine: () => string | null;
  requireCompleteGatewayProcessCleanup: boolean;
  resolveGatewayTeardownAuthority: GatewayTeardownAuthorityResolver;
  retainedGatewayPorts: readonly number[];
  rmSync: typeof fs.rmSync;
  run: (command: string, args: string[], options?: SpawnSyncOptions) => RunResult;
  runDocker: (args: string[], options?: SpawnSyncOptions) => RunResult;
  runDualStationRuntimeCleanup: (receiptPath: string, options?: SpawnSyncOptions) => RunResult;
  runHuggingFaceCacheDataCleanup: (options?: SpawnSyncOptions) => RunResult;
  runLocalModelRuntimeCleanup: (options?: SpawnSyncOptions) => RunResult;
  runManagedLlamaCppRuntimeCleanup: (sandboxName: string, gatewayPort: number) => RunResult;
  sleep: (milliseconds: number) => void;
  hasPortableRuntimeCleanup: (stateDir: string) => boolean;
  runPortableRuntimeCleanupTransaction: (
    input: PortableRuntimeCleanupInput,
    continueAfterSandboxRemoval: (
      removed: number,
      sandboxNames: readonly string[],
      gatewayName: string,
    ) => boolean,
  ) => PortableRuntimeCleanupResult | null;
  stderrHasColors: boolean;
  stderrIsTty: boolean;
  warn: (message: string) => void;
}

function buildRuntime(deps: UninstallRunDeps): UninstallRuntime {
  const env = { ...process.env, ...(deps.env ?? {}) };
  return {
    commandExists: deps.commandExists ?? ((command) => defaultCommandExists(command, env)),
    env,
    error: deps.error ?? ((message) => console.error(message)),
    existsSync: deps.existsSync ?? ((target) => fs.existsSync(target)),
    getTrustedActiveOpenShellGatewayUserServiceIdentity:
      deps.getTrustedActiveOpenShellGatewayUserServiceIdentity ??
      getTrustedActiveOpenShellGatewayUserServiceIdentity,
    isPortFree: deps.isPortFree,
    // Side-effect-free TTY check + EAGAIN-tolerant reader; the
    // process.stdin/non-blocking-fd hazard is documented in core/stdin.ts.
    isTty: deps.isTty ?? isStdinTty(),
    kill:
      deps.kill ??
      ((pid, signal) => {
        try {
          process.kill(pid, signal);
          return true;
        } catch {
          return false;
        }
      }),
    log: deps.log ?? ((message) => console.log(message)),
    openRegularFile: deps.openRegularFile ?? openRegularFileNoFollow,
    platform: deps.platform ?? process.platform,
    readProcessArgv: deps.readProcessArgv,
    readProcessExecutable: deps.readProcessExecutable,
    readProcessEnvironment: deps.readProcessEnvironment,
    realpathSync: deps.realpathSync ?? fs.realpathSync.native,
    readProcessIdentity: deps.readProcessIdentity,
    readLine: deps.readLine ?? readLineFromStdin,
    requireCompleteGatewayProcessCleanup: deps.requireCompleteGatewayProcessCleanup ?? false,
    resolveGatewayTeardownAuthority:
      deps.resolveGatewayTeardownAuthority ?? resolveGatewayTeardownAuthority,
    retainedGatewayPorts: deps.retainedGatewayPorts ?? [],
    rmSync: deps.rmSync ?? fs.rmSync,
    run: deps.run ?? defaultRun,
    runDocker: deps.runDocker ?? defaultRunDocker,
    runDualStationRuntimeCleanup:
      deps.runDualStationRuntimeCleanup ??
      ((receiptPath, options = {}) =>
        defaultRun(
          process.execPath,
          [
            path.resolve(
              __dirname,
              "..",
              "..",
              "inference",
              "vllm-station-runtime-cleanup-entry.js",
            ),
            receiptPath,
          ],
          options,
        )),
    runHuggingFaceCacheDataCleanup:
      deps.runHuggingFaceCacheDataCleanup ??
      ((options = {}) =>
        defaultRun(
          process.execPath,
          [
            path.resolve(
              __dirname,
              "..",
              "..",
              "inference",
              "local-model-profile",
              "cleanup-entry.js",
            ),
            "--delete-cache-data",
          ],
          options,
        )),
    runLocalModelRuntimeCleanup:
      deps.runLocalModelRuntimeCleanup ??
      ((options = {}) =>
        defaultRun(
          process.execPath,
          [
            path.resolve(
              __dirname,
              "..",
              "..",
              "inference",
              "local-model-profile",
              "cleanup-entry.js",
            ),
            "--clean-runtimes",
          ],
          options,
        )),
    runManagedLlamaCppRuntimeCleanup:
      deps.runManagedLlamaCppRuntimeCleanup ??
      ((sandboxName, gatewayPort) => {
        const result = cleanupManagedLlamaCppRuntimeForSandbox(sandboxName, {
          env,
          gatewayPort,
          homeDir: env.HOME || os.homedir(),
        });
        return result.ok
          ? { status: 0, stdout: result.removed.join("\n"), stderr: "" }
          : {
              status: 1,
              stdout: result.removed.join("\n"),
              stderr: result.reason,
            };
      }),
    sleep: deps.sleep ?? sleepMs,
    hasPortableRuntimeCleanup: deps.hasPortableRuntimeCleanup ?? hasPortableRuntimeCleanup,
    runPortableRuntimeCleanupTransaction:
      deps.runPortableRuntimeCleanupTransaction ??
      ((input, continueAfterSandboxRemoval) =>
        runPortableRuntimeCleanupTransaction(input, continueAfterSandboxRemoval, {
          env: input.env,
          platform: deps.platform,
          podman: (args, env) =>
            (deps.run ?? defaultRun)("podman", [...args], { env: env ?? input.env }),
          systemctl: (args, env) => (deps.run ?? defaultRun)("systemctl", [...args], { env }),
          log: deps.log,
        })),
    stderrHasColors:
      deps.stderrHasColors ??
      (typeof process.stderr.hasColors === "function" && process.stderr.hasColors()),
    stderrIsTty: deps.stderrIsTty ?? process.stderr.isTTY === true,
    warn: deps.error ?? ((message) => console.warn(message)),
  };
}

function runtimeBranding(runtime: UninstallRuntime): AgentBranding {
  return getAgentBranding(runtime.env.NEMOCLAW_AGENT);
}

function yellowWarningText(message: string, runtime: UninstallRuntime): string {
  if (runtime.env.NO_COLOR !== undefined) return message;
  if (!runtime.stderrIsTty) return message;
  if (!runtime.stderrHasColors) return message;
  return `\x1b[33m${message}\x1b[39m`;
}

function planStepDisplayName(stepName: string, branding: AgentBranding): string {
  return stepName === "NemoClaw CLI" ? `${branding.display} CLI` : stepName;
}

function printBanner(
  runtime: UninstallRuntime,
  scopedToSelectedGateway = false,
  gatewayName = resolveGatewayName(GATEWAY_PORT),
): void {
  const branding = runtimeBranding(runtime);
  runtime.log(`${branding.display} Uninstaller`);
  runtime.log(
    scopedToSelectedGateway
      ? `This will remove ${branding.display} resources owned by gateway '${gatewayName}'.`
      : `This will remove all ${branding.display} resources.`,
  );
}

function printBye(runtime: UninstallRuntime): void {
  const branding = runtimeBranding(runtime);
  runtime.log(branding.display);
  runtime.log(branding.uninstallGoodbye);
}

function stateDirDisplay(paths: UninstallPaths): string {
  const sharedRoot = path.dirname(paths.managedSwapMarkerPath);
  const home = path.dirname(sharedRoot);
  return `~/${path.relative(home, paths.nemoclawStateDir)}`;
}

function userDataDispositionLine(
  options: UninstallRunOptions,
  runtime: UninstallRuntime,
  paths: UninstallPaths,
): string {
  const dir = stateDirDisplay(paths);
  if (options.destroyUserData) {
    return `  · ${dir} (removes rebuild-backups/, backups/, sandboxes.json: --destroy-user-data set)`;
  }
  if (runtime.env.NEMOCLAW_UNINSTALL_DESTROY_USER_DATA === "1") {
    return `  · ${dir} (removes rebuild-backups/, backups/, sandboxes.json: NEMOCLAW_UNINSTALL_DESTROY_USER_DATA=1)`;
  }
  return `  · ${dir} (preserves rebuild-backups/, backups/, sandboxes.json by default)`;
}

function confirm(
  options: UninstallRunOptions,
  runtime: UninstallRuntime,
  paths: UninstallPaths,
  scopedToSelectedGateway: boolean,
): boolean {
  const branding = runtimeBranding(runtime);
  if (options.assumeYes) return true;
  runtime.log("What will be removed:");
  if (scopedToSelectedGateway) {
    runtime.log(
      `  · Sandboxes and gateway '${options.gatewayName || resolveGatewayName(GATEWAY_PORT)}' for port ${String(GATEWAY_PORT)}`,
    );
    runtime.log("  · Selected gateway state and Docker volume");
    runtime.log(
      `  · Shared ${branding.display} CLI, services, images, providers, and config: kept`,
    );
  } else {
    runtime.log(`  · All OpenShell sandboxes, gateway, and ${branding.display} providers`);
    runtime.log("  · Related Docker containers, images, and volumes");
  }
  runtime.log(userDataDispositionLine(options, runtime, paths));
  runtime.log("  · ~/.config/openshell  ~/.config/nemoclaw");
  runtime.log(`  · Global ${branding.display} CLI (npm package: nemoclaw)`);
  if (scopedToSelectedGateway) {
    runtime.log("  · Ollama models: kept while sibling gateways remain");
    runtime.log("  · Shared Hugging Face model cache: kept while sibling gateways remain");
  } else {
    runtime.log(
      options.deleteModels ? "  · All installed Ollama models" : "  · Ollama models: kept",
    );
    runtime.log(
      options.deleteModels
        ? "  · Shared Hugging Face cache data: deleted; authentication files kept"
        : "  · Shared Hugging Face model cache: kept",
    );
  }
  runtime.log("Proceed? [y/N]");
  const reply = runtime.readLine();
  if (reply && /^(y|yes)$/i.test(reply.trim())) return true;
  if (reply === null) {
    runtime.log(
      "No input available on stdin (closed or non-interactive); re-run with --yes to skip this prompt.",
    );
  }
  runtime.log("Aborted.");
  return false;
}

function runOptional(
  runtime: UninstallRuntime,
  description: string,
  command: string,
  args: string[],
  opts: { onSkip?: string } = {},
): boolean {
  const result = runtime.run(command, args, { env: runtime.env, stdio: "ignore" });
  if (result.status === 0) {
    runtime.log(description);
    return true;
  }
  // #3456 sub-bug #4: when the destroy/delete call no-ops (target already
  // gone), printing `<description> skipped` was self-contradictory — e.g.
  // "Destroyed gateway 'nemoclaw' skipped" suggested the gateway was both
  // destroyed AND skipped. Callers that care can pass a `onSkip` message
  // describing the actual state (target absent or unreachable).
  runtime.warn(opts.onSkip ?? `${description} skipped`);
  return false;
}

// Homebrew owns its formula and executable links. NemoClaw can report the
// removal command, but it must not infer that it installed the formula. (#8882)
const OPENSHELL_HOMEBREW_FORMULA = "nvidia/openshell/openshell";

function reportRetainedMacOsOpenShell(runtime: UninstallRuntime): void {
  if (!runtime.commandExists("brew")) {
    runtime.log(
      `Kept OpenShell executables because Homebrew is unavailable. If Homebrew manages OpenShell, make brew available through PATH, then run: brew uninstall ${OPENSHELL_HOMEBREW_FORMULA}`,
    );
    return;
  }
  const installed = runtime.run("brew", ["list", "--formula", OPENSHELL_HOMEBREW_FORMULA], {
    env: runtime.env,
    stdio: "ignore",
  });
  runtime.log(
    installed.status === 0
      ? `Kept Homebrew-managed OpenShell. To remove it, run: brew uninstall ${OPENSHELL_HOMEBREW_FORMULA}`
      : `Kept OpenShell executables because Homebrew did not confirm ${OPENSHELL_HOMEBREW_FORMULA}. Check the formula before removing OpenShell.`,
  );
}

function deleteSelectedGatewaySandbox(
  runtime: UninstallRuntime,
  gatewayName: string,
  sandboxName: string,
): boolean {
  const result = runtime.run("openshell", ["sandbox", "delete", "-g", gatewayName, sandboxName], {
    env: runtime.env,
  });
  if (result.status === 0) {
    runtime.log(`Deleted OpenShell sandbox '${sandboxName}'`);
    return true;
  }
  if (getSandboxDeleteOutcome(result).alreadyGone) {
    runtime.warn(sandboxDeleteAbsentMessage(sandboxName));
    return true;
  }
  runtime.warn(sandboxDeleteFailureMessage(sandboxName));
  return false;
}

function portableGatewayIsReachable(runtime: UninstallRuntime, gatewayName: string): boolean {
  const result = runtime.run("openshell", ["status", "-g", gatewayName], { env: runtime.env });
  if (result.status !== 0) return false;
  const output = `${result.stdout}\n${result.stderr}`.replace(/\x1b\[[0-9;]*m/gu, "");
  const activeGateway = /^\s*Gateway:\s+(.+?)\s*$/mu.exec(output)?.[1]?.trim();
  return /^\s*Status:\s*Connected\b/imu.test(output) && activeGateway === gatewayName;
}

function isExplicitPortableSandboxAbsence(result: RunResult, sandboxName: string): boolean {
  if (result.status === 0) return false;
  const clean = `${result.stdout}\n${result.stderr}`.replace(/\x1b\[[0-9;]*m|\r/gu, "").trim();
  const escapedName = sandboxName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const namedSandbox = `(?:['\"]${escapedName}['\"]|${escapedName})`;
  return (
    /^(?:error:\s*)?(?:×\s*)?code:\s*["']Some requested entity was not found["']\s*,\s*message:\s*["']sandbox not found["']$/iu.test(
      clean,
    ) ||
    new RegExp(
      `^(?:error:\\s*)?sandbox\\s+${namedSandbox}\\s+(?:(?:is\\s+)?not\\s+(?:found|present)|does\\s+not\\s+exist)[.!]?$`,
      "iu",
    ).test(clean) ||
    new RegExp(`^(?:error:\\s*)?no\\s+such\\s+sandbox\\s+${namedSandbox}[.!]?$`, "iu").test(clean)
  );
}

function deletePortableOpenShellSandbox(
  runtime: UninstallRuntime,
  sandboxName: string,
  gatewayName: string,
): boolean {
  const result = runtime.run("openshell", ["sandbox", "delete", "-g", gatewayName, sandboxName], {
    env: runtime.env,
  });
  const deleteReportedAbsence = isExplicitPortableSandboxAbsence(result, sandboxName);
  if (result.status !== 0 && !deleteReportedAbsence) {
    runtime.warn(sandboxDeleteFailureMessage(sandboxName));
  }
  if (result.status === 0) runtime.log(`Deleted OpenShell sandbox '${sandboxName}'`);
  else if (deleteReportedAbsence) {
    runtime.warn(sandboxDeleteAbsentMessage(sandboxName));
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    if (!portableGatewayIsReachable(runtime, gatewayName)) return false;
    const verified = runtime.run("openshell", ["sandbox", "get", "-g", gatewayName, sandboxName], {
      env: runtime.env,
    });
    if (isExplicitPortableSandboxAbsence(verified, sandboxName)) return true;
    if (attempt < 4) runtime.sleep(200);
  }
  runtime.warn(`OpenShell sandbox '${sandboxName}' did not reach verified absence.`);
  return false;
}

const GATEWAY_ALREADY_ABSENT =
  /gateway[^\n]*(?:does not exist|not found)|No (?:active )?gateway|No gateway metadata found/i;
const GATEWAY_REMOVE_UNSUPPORTED =
  /unrecognized subcommand ['"]remove['"]|unknown command ['"]remove['"]/i;

function removeGatewayRegistration(
  runtime: UninstallRuntime,
  gatewayLabel: string,
  allowLegacyDestroy: boolean,
): boolean {
  const removeResult = runtime.run("openshell", ["gateway", "remove", gatewayLabel], {
    env: runtime.env,
  });
  if (removeResult.status === 0) {
    runtime.log(`Removed gateway registration '${gatewayLabel}'`);
    return true;
  }

  const removeOutput = `${removeResult.stdout}\n${removeResult.stderr}`;
  if (GATEWAY_ALREADY_ABSENT.test(removeOutput)) {
    runtime.warn(gatewayDestroySkipMessage(gatewayLabel));
    return true;
  }
  if (!GATEWAY_REMOVE_UNSUPPORTED.test(removeOutput)) {
    runtime.warn(gatewayDestroySkipMessage(gatewayLabel));
    return false;
  }
  if (!allowLegacyDestroy) {
    runtime.warn(
      `Could not remove local registration for externally supervised gateway '${gatewayLabel}'. ` +
        "NemoClaw will not use the legacy gateway destroy command for an externally supervised gateway.",
    );
    return false;
  }

  // OpenShell builds before 0.0.44 exposed `gateway destroy` instead of the
  // current `gateway remove` command. Only fall back when the modern verb is
  // explicitly unsupported so a real removal failure is not hidden.
  const destroyResult = runtime.run("openshell", ["gateway", "destroy", "-g", gatewayLabel], {
    env: runtime.env,
  });
  if (destroyResult.status === 0) {
    runtime.log(`Destroyed legacy gateway '${gatewayLabel}'`);
    return true;
  }
  if (GATEWAY_ALREADY_ABSENT.test(`${destroyResult.stdout}\n${destroyResult.stderr}`)) {
    runtime.warn(gatewayDestroySkipMessage(gatewayLabel));
    return true;
  }
  runtime.warn(gatewayDestroySkipMessage(gatewayLabel));
  return false;
}

function stopHelperServices(paths: UninstallPaths, runtime: UninstallRuntime): void {
  const startServices = path.join(paths.repoRoot, "scripts", "start-services.sh");
  if (runtime.existsSync(startServices))
    runOptional(
      runtime,
      `Stopped ${runtimeBranding(runtime).display} helper services`,
      startServices,
      ["--stop"],
    );
}

function stopMatchingPids(pattern: string, runtime: UninstallRuntime, label: string): void {
  if (!runtime.commandExists("pgrep")) {
    runtime.warn(`pgrep not found; skipping ${label}.`);
    return;
  }
  const result = runtime.run("pgrep", ["-f", pattern], { env: runtime.env });
  const pids = splitNonEmptyLines(result.stdout).map(Number).filter(Number.isFinite);
  if (pids.length === 0) {
    runtime.log(`No ${label} found`);
    return;
  }
  for (const pid of pids) {
    if (runtime.kill(pid) || runtime.kill(pid, "SIGKILL")) runtime.log(`Stopped ${label} ${pid}`);
    else runtime.warn(`Failed to stop ${label} ${pid}`);
  }
}

// Resolve the proxy port from runtime.env (rather than `process.env` at
// module-load time) so a user who onboarded with NEMOCLAW_OLLAMA_PROXY_PORT
// set to a custom value sees uninstall scan that same port. Mirrors the
// validation in `src/lib/core/ports.ts::parsePort`; falls back silently to
// the default (11435) on malformed input — uninstall is best-effort.
const DEFAULT_OLLAMA_PROXY_PORT = 11435;

function parseOllamaProxyPort(raw: unknown): number | null {
  if (raw === undefined || raw === "") return null;
  const trimmed = String(raw).trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  if (parsed < 1024 || parsed > 65535) return null;
  return parsed;
}

function resolveOllamaProxyPort(paths: UninstallPaths, runtime: UninstallRuntime): number {
  const persistedPortPath = path.join(paths.nemoclawStateDir, "ollama-proxy-port");
  if (runtime.existsSync(persistedPortPath)) {
    let opened: OpenRegularFile | null = null;
    try {
      opened = runtime.openRegularFile(persistedPortPath);
      const persistedPort = parseOllamaProxyPort(opened.readBytes(32).toString("utf8").trim());
      if (persistedPort !== null) return persistedPort;
    } catch {
      // Uninstall remains best-effort and falls back to the configured port.
    } finally {
      opened?.close();
    }
  }
  return parseOllamaProxyPort(runtime.env.NEMOCLAW_OLLAMA_PROXY_PORT) ?? DEFAULT_OLLAMA_PROXY_PORT;
}

function isOllamaAuthProxyPid(pid: number, runtime: UninstallRuntime): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const result = runtime.run("ps", ["-p", String(pid), "-o", "args="], { env: runtime.env });
  return result.status === 0 && isOllamaAuthProxyCommandLine(result.stdout);
}

// `ps -p <pid>` is preferred over `kill(pid, 0)` for existence probing here:
// `runtime.kill()` collapses every `process.kill` error to `false`, so a foreign
// PID throwing EPERM (process exists but caller can't signal it) would look
// identical to ESRCH (gone) and we'd falsely log it as Stopped. `ps` reports
// existence regardless of signalling permission.
function pidExists(pid: number, runtime: UninstallRuntime): boolean {
  return runtime.run("ps", ["-p", String(pid), "-o", "pid="], { env: runtime.env }).status === 0;
}

function waitForPidExit(pid: number, runtime: UninstallRuntime, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidExists(pid, runtime)) return true;
    sleepMs(50);
  }
  return !pidExists(pid, runtime);
}

function pidOwnedByCurrentUser(pid: number, runtime: UninstallRuntime): boolean {
  const expected = runtime.env.SUDO_USER || runtime.env.LOGNAME || os.userInfo().username;
  if (!expected) return true;
  const result = runtime.run("ps", ["-p", String(pid), "-o", "user="], { env: runtime.env });
  return result.status === 0 && result.stdout.trim() === expected;
}

function tryStopOllamaProxyPid(pid: number, runtime: UninstallRuntime): boolean {
  // `runtime.kill()` only confirms the signal was sent; the proxy may ignore
  // SIGTERM, take time to clean up, or linger as a zombie. Verify the PID is
  // actually gone before claiming success — otherwise the next install fails
  // with `Ollama auth proxy failed to start on :11435`.
  runtime.kill(pid);
  if (waitForPidExit(pid, runtime, 1000)) {
    runtime.log(`Stopped Ollama auth proxy ${pid}`);
    return true;
  }
  runtime.kill(pid, "SIGKILL");
  if (waitForPidExit(pid, runtime, 1000)) {
    runtime.log(`Stopped Ollama auth proxy ${pid}`);
    return true;
  }
  runtime.warn(`Failed to stop Ollama auth proxy ${pid}`);
  return false;
}

function stopOllamaAuthProxy(
  paths: UninstallPaths,
  runtime: UninstallRuntime,
  scanOrphans = true,
): void {
  // The auth proxy is a detached node child started by the Local Ollama
  // onboard path that listens on `NEMOCLAW_OLLAMA_PROXY_PORT` (default
  // 11435). Without this cleanup,
  // uninstall + reinstall fails with `Ollama auth proxy failed to start on
  // :11435` — the on-disk PID file is removed by the "State and binaries"
  // step but the process keeps running. The two-prong check (persisted PID
  // first, then port-bound listeners) mirrors `killStaleProxy()` in
  // `src/lib/onboard-ollama-proxy.ts` and verifies cmdline on every PID, so
  // an unrelated process on the same port (custom proxy, test setup) is
  // never killed. See issue #2759.
  const stopped = new Set<number>();

  if (!scanOrphans) {
    runtime.log("Preserving the shared Ollama auth proxy for the remaining gateway ports");
    return;
  }

  // 1. Try the persisted PID file. The proxy stays bound across NemoClaw
  //    sessions; the PID file is the most reliable signal. The path mirrors
  //    `PROXY_PID_PATH` in `src/lib/onboard-ollama-proxy.ts` (`~/.nemoclaw`).
  const pidFile = path.join(paths.nemoclawStateDir, "ollama-auth-proxy.pid");
  if (runtime.existsSync(pidFile)) {
    try {
      const raw = fs.readFileSync(pidFile, "utf-8").trim();
      const pid = Number.parseInt(raw, 10);
      if (Number.isFinite(pid) && pid > 0 && isOllamaAuthProxyPid(pid, runtime)) {
        if (tryStopOllamaProxyPid(pid, runtime)) stopped.add(pid);
      }
    } catch {
      /* ignore — the State step deletes the file shortly anyway */
    }
  }

  // 2. Fall back to the configured proxy port for orphans whose PID file is
  //    gone (e.g. a previous uninstall already wiped state but the process
  //    survived). Filter via cmdline so we never kill unrelated listeners.
  if (!runtime.commandExists("lsof")) {
    if (stopped.size === 0) {
      runtime.warn("lsof not found; skipping orphan Ollama auth proxy scan.");
    }
    return;
  }
  const proxyPort = resolveOllamaProxyPort(paths, runtime);
  const lsof = runtime.run("lsof", ["-ti", `:${proxyPort}`], { env: runtime.env });
  const pids = splitNonEmptyLines(lsof.stdout).map(Number).filter(Number.isFinite);
  for (const pid of pids) {
    if (stopped.has(pid)) continue;
    // Skip foreign-owned PIDs even if the cmdline matches: signalling them
    // would either no-op under EPERM or escalate via sudo, neither of which
    // is appropriate during a per-user uninstall.
    if (!pidOwnedByCurrentUser(pid, runtime)) continue;
    if (!isOllamaAuthProxyPid(pid, runtime)) continue;
    if (tryStopOllamaProxyPid(pid, runtime)) stopped.add(pid);
  }

  if (stopped.size === 0) runtime.log("No Ollama auth proxy processes found");
}

const DEFAULT_MODEL_ROUTER_PORT = 4000;

function resolveModelRouterPort(_runtime: UninstallRuntime): number {
  // Routed onboard profiles use blueprint port 4000 by default; a custom port
  // would require reading the blueprint, which uninstall does not do today.
  return DEFAULT_MODEL_ROUTER_PORT;
}

function readOnboardSessionRouterPid(paths: UninstallPaths): number | null {
  const sessionFile = path.join(paths.nemoclawStateDir, "onboard-session.json");
  try {
    const raw = fs.readFileSync(sessionFile, "utf-8");
    const data = JSON.parse(raw) as { routerPid?: unknown };
    const pid = data.routerPid;
    if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) return pid;
  } catch {
    /* ignore — State step deletes the file shortly anyway */
  }
  return null;
}

function isModelRouterPid(pid: number, port: number, runtime: UninstallRuntime): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (!pidExists(pid, runtime)) return false;
  const result = runtime.run("ps", ["-p", String(pid), "-o", "args="], { env: runtime.env });
  if (result.status !== 0) return false;
  const args = result.stdout.trim().split(/\s+/).filter(Boolean);
  return isModelRouterCommandLineForPort(args, port);
}

function tryStopModelRouterPid(pid: number, runtime: UninstallRuntime): boolean {
  runtime.kill(pid);
  if (waitForPidExit(pid, runtime, 1000)) {
    runtime.log(`Stopped model router ${pid}`);
    return true;
  }
  runtime.kill(pid, "SIGKILL");
  if (waitForPidExit(pid, runtime, 1000)) {
    runtime.log(`Stopped model router ${pid}`);
    return true;
  }
  runtime.warn(`Failed to stop model router ${pid}`);
  return false;
}

function stopModelRouter(
  paths: UninstallPaths,
  runtime: UninstallRuntime,
  scanOrphans = true,
): void {
  // The model router is a detached child started during routed onboard that
  // listens on port 4000 by default. Without this cleanup, uninstall +
  // reinstall fails with "Port 4000 already has a healthy router endpoint".
  // The tracked PID lives in ~/.nemoclaw/onboard-session.json (routerPid), not
  // a dedicated .pid file. Mirrors stopOllamaAuthProxy() and issue #5169.
  const stopped = new Set<number>();
  const routerPort = resolveModelRouterPort(runtime);

  const recordedPid = readOnboardSessionRouterPid(paths);
  if (
    recordedPid !== null &&
    pidOwnedByCurrentUser(recordedPid, runtime) &&
    isModelRouterPid(recordedPid, routerPort, runtime)
  ) {
    if (tryStopModelRouterPid(recordedPid, runtime)) stopped.add(recordedPid);
  }

  if (!scanOrphans) {
    if (stopped.size === 0) runtime.log("No selected-gateway model router found");
    return;
  }

  if (!runtime.commandExists("lsof")) {
    if (stopped.size === 0) {
      runtime.warn("lsof not found; skipping orphan model router scan.");
    }
    return;
  }
  const lsof = runtime.run("lsof", ["-ti", `:${routerPort}`], { env: runtime.env });
  const pids = splitNonEmptyLines(lsof.stdout).map(Number).filter(Number.isFinite);
  for (const pid of pids) {
    if (stopped.has(pid)) continue;
    if (!pidOwnedByCurrentUser(pid, runtime)) continue;
    if (!isModelRouterPid(pid, routerPort, runtime)) continue;
    if (tryStopModelRouterPid(pid, runtime)) stopped.add(pid);
  }

  if (stopped.size === 0) runtime.log("No model router processes found");
}

function stopOrphanedOpenShell(runtime: UninstallRuntime): void {
  if (!runtime.commandExists("pgrep")) {
    runtime.warn("pgrep not found; skipping orphaned openshell process cleanup.");
    return;
  }
  const user = runtime.env.SUDO_USER || runtime.env.LOGNAME || os.userInfo().username;
  const args = user
    ? ["-u", user, "-f", "openshell (sandbox create|ssh-proxy)"]
    : ["-f", "openshell (sandbox create|ssh-proxy)"];
  const result = runtime.run("pgrep", args, { env: runtime.env });
  const pids = splitNonEmptyLines(result.stdout).map(Number).filter(Number.isFinite);
  if (pids.length === 0) {
    runtime.log("No orphaned openshell processes found");
    return;
  }
  for (const pid of pids) {
    if (runtime.kill(pid) || runtime.kill(pid, "SIGKILL"))
      runtime.log(`Stopped orphaned openshell process ${pid}`);
    else runtime.warn(`Failed to stop orphaned openshell process ${pid}`);
  }
}

function removeNemoclawOpenShellGatewayUserService(
  runtime: UninstallRuntime,
  scopedStateDir?: string,
): boolean {
  if (runtime.platform !== "linux") return true;
  const servicePath = getNemoclawOpenShellGatewayUserServicePath(
    runtime.env.HOME || os.homedir(),
    runtime.env,
  );
  if (!runtime.existsSync(servicePath)) return true;

  let serviceFile: OpenRegularFile;
  try {
    serviceFile = runtime.openRegularFile(servicePath);
  } catch (error) {
    runtime.warn(
      isErrnoException(error) && error.code === "ELOOP"
        ? `Leaving ${servicePath} in place because it is a symbolic link.`
        : `Failed to read ${servicePath}; leaving gateway user service in place.`,
    );
    return false;
  }
  let managed = false;
  try {
    managed = serviceFile
      .readUtf8()
      .split(/\r?\n/)
      .some((line) => line.trimEnd() === NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER_LINE);
  } catch {
    runtime.warn(`Failed to read ${servicePath}; leaving gateway user service in place.`);
    return false;
  } finally {
    serviceFile.close();
  }
  if (!managed) {
    runtime.warn(`Leaving ${servicePath} in place because it is not NemoClaw-managed.`);
    return true;
  }

  const hasSystemctl = runtime.commandExists("systemctl");
  if (hasSystemctl) {
    if (scopedStateDir !== undefined) {
      const inspected = runtime.run(
        "systemctl",
        [
          "--user",
          "show",
          NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE,
          "--property=MainPID",
          "--value",
        ],
        { env: runtime.env },
      );
      const mainPid = Number(inspected.stdout.trim());
      if (
        !hasStateScopedSandboxNamespace(scopedStateDir) ||
        inspected.status !== 0 ||
        !inspected.stdout.trim() ||
        !Number.isSafeInteger(mainPid) ||
        mainPid < 0 ||
        (mainPid > 0 && !processUsesStateScopedSandboxNamespace(mainPid, scopedStateDir, runtime))
      ) {
        runtime.warn(
          "Refusing scoped gateway service stop because its loaded sandbox namespace cannot be proven.",
        );
        return false;
      }
    }
    const disabled = runtime.run(
      "systemctl",
      ["--user", "disable", "--now", NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE],
      { env: runtime.env, stdio: "ignore" },
    );
    if (disabled.status !== 0) {
      runtime.warn(`Failed to disable ${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE}.service`);
      return false;
    }
    runtime.log(`Disabled ${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE}.service`);
  } else {
    runtime.warn("systemctl not found; removing NemoClaw gateway user service file only.");
  }
  try {
    runtime.rmSync(servicePath, { force: true });
    runtime.log(`Removed ${servicePath}`);
  } catch (error) {
    runtime.warn(
      `Failed to remove ${servicePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
  if (hasSystemctl) {
    const reloaded = runtime.run("systemctl", ["--user", "daemon-reload"], {
      env: runtime.env,
      stdio: "ignore",
    });
    if (reloaded.status !== 0) {
      runtime.warn("Failed to reload the user systemd manager.");
      return false;
    }
  }
  return true;
}

// scripts/install.sh stages the NemoClaw-managed gateway user service only for
// the default gateway port, so an uninstall run for any other port leaves it in
// place. `--keep-openshell` and an externally supervised authority leave it in
// place too.
function removeManagedDefaultGatewayUserService(
  runtime: UninstallRuntime,
  options: UninstallRunOptions,
  externallySupervised: boolean,
  selectedStateDir?: string,
  scoped = false,
): boolean {
  if (options.keepOpenShell || externallySupervised || GATEWAY_PORT !== DEFAULT_GATEWAY_PORT) {
    return true;
  }
  return removeNemoclawOpenShellGatewayUserService(runtime, scoped ? selectedStateDir : undefined);
}

function removeNemoclawOpenShellGatewayEnv(
  paths: UninstallPaths,
  runtime: UninstallRuntime,
): { keptUnrelatedContent: boolean; ok: boolean } {
  const envPath = path.join(paths.openshellConfigDir, "gateway.env");
  if (!runtime.existsSync(envPath)) return { keptUnrelatedContent: false, ok: true };
  let envFile: OpenRegularFile;
  try {
    envFile = runtime.openRegularFile(envPath, { writable: true });
  } catch (error) {
    runtime.warn(
      isErrnoException(error) && error.code === "ELOOP"
        ? `Leaving ${envPath} in place because it is a symbolic link.`
        : `Failed to clean ${envPath}: ${formatError(error)}`,
    );
    return { keptUnrelatedContent: true, ok: false };
  }
  try {
    const preserved = buildDockerGatewayDebEnvFile(envFile.readUtf8(), {});
    if (preserved.trim()) {
      envFile.replaceUtf8(preserved, 0o600);
      runtime.log(`Removed NemoClaw gateway settings from ${envPath}`);
      return { keptUnrelatedContent: true, ok: true };
    }
    envFile.close();
    runtime.rmSync(envPath, { force: true });
    runtime.log(`Removed ${envPath}`);
    return { keptUnrelatedContent: false, ok: true };
  } catch (error) {
    runtime.warn(`Failed to clean ${envPath}: ${formatError(error)}`);
    return { keptUnrelatedContent: true, ok: false };
  } finally {
    envFile.close();
  }
}

interface SelectedRegistrySandboxState {
  managedHermesStateVolumes: ManagedHermesStateVolumeContext[];
  names: string[];
}

function selectedRegistrySandboxState(
  paths: UninstallPaths,
  runtime: UninstallRuntime,
): SelectedRegistrySandboxState {
  const sharedRoot = path.dirname(paths.managedSwapMarkerPath);
  const home = path.dirname(sharedRoot);
  const registryFile = path.join(paths.nemoclawStateDir, "sandboxes.json");
  if (!pathEntryExists(registryFile, runtime)) {
    return { managedHermesStateVolumes: [], names: [] };
  }
  const registry = readGatewayRegistryFile(home, registryFile);
  if (!registry) return { managedHermesStateVolumes: [], names: [] };
  const managedHermesStateVolumes: ManagedHermesStateVolumeContext[] = [];
  const names: string[] = [];
  for (const [name, entry] of Object.entries(registry.sandboxes)) {
    const entryPort = registryEntryGatewayPort(entry);
    if (entryPort !== GATEWAY_PORT && GATEWAY_PORT === DEFAULT_GATEWAY_PORT) {
      // A pre-segregation default registry may still carry an explicitly
      // non-default sibling row. Leave it for that gateway's migration.
      continue;
    }
    if (entryPort !== GATEWAY_PORT) {
      throw new Error(
        `Refusing to uninstall: selected registry row ${JSON.stringify(name)} belongs to another gateway port.`,
      );
    }
    names.push(name);
    managedHermesStateVolumes.push(managedHermesStateVolumeContext(name, entry));
  }
  return {
    managedHermesStateVolumes: managedHermesStateVolumes.sort((left, right) =>
      left.sandboxName.localeCompare(right.sandboxName),
    ),
    names: names.sort(),
  };
}

function writeRegistryAtomic(
  home: string,
  registryFile: string,
  registry: GatewayRegistryDocument,
): void {
  assertGatewayStatePathSafe(home, path.dirname(registryFile));
  const tempFile = `${registryFile}.uninstall.${String(process.pid)}.${String(Date.now())}`;
  let fd: number | null = null;
  try {
    fd = fs.openSync(
      tempFile,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    fs.writeFileSync(fd, `${JSON.stringify(registry, null, 2)}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempFile, registryFile);
  } finally {
    if (fd !== null) fs.closeSync(fd);
    try {
      fs.rmSync(tempFile, { force: true });
    } catch {
      // Best effort after an interrupted atomic write.
    }
  }
}

function pruneSelectedRowsFromRegistry(
  paths: UninstallPaths,
  expectedSelectedNames: readonly string[],
  runtime: UninstallRuntime,
): boolean {
  const sharedRoot = path.dirname(paths.managedSwapMarkerPath);
  const home = path.dirname(sharedRoot);
  const registryFile = path.join(paths.nemoclawStateDir, "sandboxes.json");
  if (!pathEntryExists(registryFile, runtime) && expectedSelectedNames.length === 0) return true;
  try {
    assertGatewayStatePathSafe(home, `${registryFile}.lock`);
    // The canonical registry lock owns this directory: it writes an owner file,
    // retries a live holder, and recovers a lock abandoned by an interrupted run.
    return withRegistryLockAt(registryFile, () => {
      const registry = readGatewayRegistryFile(home, registryFile);
      if (!registry) throw new Error(`${registryFile} disappeared during scoped uninstall`);
      const selectedNames = Object.entries(registry.sandboxes)
        .filter(([, entry]) => registryEntryGatewayPort(entry) === GATEWAY_PORT)
        .map(([name]) => name)
        .sort();
      if (JSON.stringify(selectedNames) !== JSON.stringify([...expectedSelectedNames].sort())) {
        throw new Error(`${registryFile} changed during scoped uninstall`);
      }

      if (selectedNames.length === 0) return true;
      const remainingSandboxes = Object.fromEntries(
        Object.entries(registry.sandboxes).filter(
          ([, entry]) => registryEntryGatewayPort(entry) !== GATEWAY_PORT,
        ),
      );
      const defaultSandbox =
        registry.defaultSandbox && Object.hasOwn(remainingSandboxes, registry.defaultSandbox)
          ? registry.defaultSandbox
          : (Object.keys(remainingSandboxes).sort()[0] ?? null);
      writeRegistryAtomic(home, registryFile, {
        ...registry,
        defaultSandbox,
        sandboxes: remainingSandboxes,
      });
      runtime.log(
        `Removed ${String(selectedNames.length)} selected-gateway row(s) from the sandbox registry.`,
      );
      return true;
    });
  } catch (error) {
    runtime.warn(
      `Could not safely update the sandbox registry: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

function finishScopedOpenShellCleanup(
  paths: UninstallPaths,
  options: UninstallRunOptions,
  runtime: UninstallRuntime,
  sandboxNames: readonly string[],
  externallySupervised: boolean,
): boolean {
  // Removing selected rows checkpoints successful sandbox deletion, so a retry
  // can skip sandbox deletion after gateway registration cleanup has started.
  if (!pruneSelectedRowsFromRegistry(paths, sandboxNames, runtime)) return false;
  return removeGatewayRegistration(
    runtime,
    options.gatewayName || resolveGatewayName(GATEWAY_PORT),
    !externallySupervised,
  );
}

function removeOpenShellResources(
  paths: UninstallPaths,
  options: UninstallRunOptions,
  runtime: UninstallRuntime,
  scopedToSelectedGateway: boolean,
  sandboxNames: readonly string[],
  teardownAuthority: GatewayOwner,
): boolean {
  if (!runtime.commandExists("openshell")) {
    runtime.error(OPENSHELL_COMMAND_MISSING_ERROR);
    return false;
  }
  const gatewayLabel = options.gatewayName || resolveGatewayName(GATEWAY_PORT);
  const externallySupervised = isExternallySupervised(teardownAuthority);
  if (scopedToSelectedGateway) {
    let removedSelectedResources = true;
    for (const sandboxName of sandboxNames) {
      if (
        !canRemoveScopedOpenShellResources(
          paths,
          options,
          runtime,
          scopedToSelectedGateway,
          teardownAuthority,
          true,
        )
      ) {
        return false;
      }
      removedSelectedResources =
        deleteSelectedGatewaySandbox(runtime, gatewayLabel, sandboxName) &&
        removedSelectedResources;
    }
    if (!removedSelectedResources) {
      runtime.warn("Selected gateway cleanup was incomplete; preserving its state for retry.");
      return false;
    }
    runtime.log("Sibling gateways remain; kept shared OpenShell provider registrations.");
    return true;
  }
  // #6520 sub-bug: a no-op delete must not print `Deleted … skipped`;
  // wording lives in domain/uninstall/messaging.ts.
  runOptional(
    runtime,
    "Deleted all OpenShell sandboxes",
    "openshell",
    ["sandbox", "delete", "--all"],
    {
      onSkip: OPENSHELL_SANDBOXES_DELETE_SKIP_MESSAGE,
    },
  );
  for (const provider of NEMOCLAW_PROVIDERS) {
    runOptional(
      runtime,
      `Deleted provider '${provider}'`,
      "openshell",
      ["provider", "delete", provider],
      { onSkip: providerDeleteSkipMessage(provider) },
    );
  }
  removeGatewayRegistration(runtime, gatewayLabel, !externallySupervised);
  return true;
}

function normalizeGatewayProcessExecutable(
  executablePath: string,
  runtime: UninstallRuntime,
): string {
  try {
    return runtime.realpathSync(executablePath);
  } catch {
    return path.resolve(executablePath);
  }
}

function readGatewayProcessExecutable(pid: number, runtime: UninstallRuntime): string | null {
  const provided = runtime.readProcessExecutable?.(pid);
  if (provided !== undefined) return provided;
  if (runtime.platform === "linux") {
    try {
      return runtime.realpathSync(`/proc/${String(pid)}/exe`);
    } catch {
      return null;
    }
  }
  if (runtime.platform !== "darwin") return null;
  const inspected = runtime.run("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "txt", "-Fn"], {
    env: runtime.env,
  });
  if (inspected.status !== 0) return null;
  const executable = inspected.stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith("n/"))
    ?.slice(1)
    .trim();
  return executable && path.isAbsolute(executable) ? executable : null;
}

function packageManagedServiceGatewayProcessOwnershipFailure(
  stateDir: string,
  runtime: UninstallRuntime,
): string | null {
  const inspectService = () =>
    runtime.getTrustedActiveOpenShellGatewayUserServiceIdentity({
      commandExists: runtime.commandExists,
      env: runtime.env,
      existsSync: runtime.existsSync,
      home: runtime.env.HOME || os.homedir(),
      platform: runtime.platform,
      spawnSyncImpl: runtime.run,
      suppressUnsupportedVersionWarning: true,
    });
  const before = inspectService();
  if (!before?.executablePath) {
    return "active package-managed OpenShell gateway service identity is unavailable";
  }
  const expectedExecutable = normalizeGatewayProcessExecutable(before.executablePath, runtime);
  const executableBefore = readGatewayProcessExecutable(before.pid, runtime);
  if (
    !executableBefore ||
    normalizeGatewayProcessExecutable(executableBefore, runtime) !== expectedExecutable
  ) {
    return "live process executable does not match the trusted service executable";
  }
  if (!processUsesStateScopedSandboxNamespace(before.pid, stateDir, runtime)) {
    return "gateway process owner and loaded sandbox namespace cannot be proven";
  }
  const after = inspectService();
  if (
    !after?.executablePath ||
    after.pid !== before.pid ||
    normalizeGatewayProcessExecutable(after.executablePath, runtime) !== expectedExecutable
  ) {
    return "package-managed OpenShell gateway service identity changed during validation";
  }
  const executableAfter = readGatewayProcessExecutable(after.pid, runtime);
  if (
    !executableAfter ||
    normalizeGatewayProcessExecutable(executableAfter, runtime) !== expectedExecutable
  ) {
    return "package-managed OpenShell gateway service identity changed during validation";
  }
  if (!processUsesStateScopedSandboxNamespace(after.pid, stateDir, runtime)) {
    return "package-managed OpenShell gateway service sandbox namespace changed during validation";
  }
  return null;
}

function canRemoveScopedOpenShellResources(
  paths: UninstallPaths,
  options: UninstallRunOptions,
  runtime: UninstallRuntime,
  scopedToSelectedGateway: boolean,
  teardownAuthority: GatewayOwner,
  requireLiveManagedProcess = false,
): boolean {
  if (!scopedToSelectedGateway) return true;
  if (isExternallySupervised(teardownAuthority)) {
    const stateDir = teardownAuthority.stateDir;
    const supervisor = teardownAuthority.supervisor;
    if (stateDir && supervisor && hasStateScopedSandboxNamespace(stateDir)) {
      const inspected = runtime.run(
        "systemctl",
        [
          ...(supervisor.kind === "systemd-user" ? ["--user"] : []),
          "show",
          supervisor.serviceName,
          "--property=MainPID",
          "--value",
        ],
        { env: runtime.env },
      );
      const mainPid = Number(inspected.stdout.trim());
      if (
        inspected.status === 0 &&
        Number.isSafeInteger(mainPid) &&
        // A stopped external unit has no live process that can prove deletion authority.
        mainPid > 0
      ) {
        const reason = externallySupervisedHostGatewayProcessOwnershipFailure(
          {
            env: runtime.env,
            readProcessEnvironment: runtime.readProcessEnvironment,
            readProcessExecutable: runtime.readProcessExecutable,
            run: runtime.run,
          },
          {
            gatewayBin: supervisor.execPath,
            gatewayName: teardownAuthority.gatewayName,
            gatewayPort: teardownAuthority.gatewayPort,
            pid: mainPid,
            stateDir,
          },
        );
        if (reason === null) return true;
        runtime.warn(
          `Refusing scoped gateway cleanup because the externally supervised process identity cannot be proven: ${reason}.`,
        );
        return false;
      }
    }
    runtime.warn(
      "Refusing scoped gateway cleanup because the externally supervised process's loaded sandbox namespace cannot be proven.",
    );
    return false;
  }
  const stateDir = paths.selectedGatewayLocalStateDir;
  if (!hasStateScopedSandboxNamespace(stateDir)) {
    runtime.warn("Refusing scoped gateway cleanup because its sandbox namespace cannot be proven.");
    return false;
  }
  if (!requireLiveManagedProcess) return true;
  if (teardownAuthority.source === "packaged-service") {
    const reason = packageManagedServiceGatewayProcessOwnershipFailure(stateDir, runtime);
    if (reason === null) return true;
    runtime.warn(
      `Refusing scoped gateway cleanup because the package-managed OpenShell gateway service identity cannot be proven: ${reason}.`,
    );
    return false;
  }
  const reason = scopedHostGatewayProcessOwnershipFailure(
    {
      env: runtime.env,
      kill: runtime.kill,
      readProcessEnvironment: runtime.readProcessEnvironment,
      run: runtime.run,
    },
    {
      gatewayBin: runtime.env.NEMOCLAW_OPENSHELL_GATEWAY_BIN,
      openShellGatewayName: options.gatewayName || resolveGatewayName(GATEWAY_PORT),
      openShellGatewayPort: GATEWAY_PORT,
      stateDir,
    },
  );
  if (reason === null) return true;
  runtime.warn(
    `Refusing scoped gateway cleanup because the selected process identity cannot be proven: ${reason}.`,
  );
  return false;
}

function removePortableOpenShellResources(
  runtime: UninstallRuntime,
  sandboxNames: readonly string[],
  gatewayName: string,
): boolean {
  if (!runtime.commandExists("openshell")) {
    runtime.error(OPENSHELL_COMMAND_MISSING_ERROR);
    return false;
  }
  for (const sandboxName of sandboxNames) {
    if (!portableGatewayIsReachable(runtime, gatewayName)) {
      runtime.warn(
        `Portable OpenShell cleanup requires connected gateway '${gatewayName}'; preserving its state for retry.`,
      );
      return false;
    }
    if (!deletePortableOpenShellSandbox(runtime, sandboxName, gatewayName)) {
      runtime.warn("Portable OpenShell cleanup was incomplete; preserving its state for retry.");
      return false;
    }
  }
  runtime.log("Kept shared OpenShell provider and gateway registrations for unrelated sandboxes.");
  return true;
}

function removeAliases(paths: UninstallPaths, runtime: UninstallRuntime): void {
  for (const profile of paths.shellProfilePaths) {
    if (!runtime.existsSync(profile)) continue;
    try {
      const original = fs.readFileSync(profile, "utf-8");
      const updated = original
        .replace(/^# NemoClaw PATH setup\n[\s\S]*?^# end NemoClaw PATH setup\n?/gm, "")
        .replace(/^# NemoClaw CLI alias\n.*\n?/gm, "");
      if (updated !== original) {
        fs.writeFileSync(profile, updated);
        runtime.log(`Removed ${runtimeBranding(runtime).display} PATH entries from ${profile}`);
      }
    } catch {
      runtime.warn(`Failed to update ${profile}`);
    }
  }
}

/** Direct entries of `dir`, or none when it is absent or unreadable. */
function dirEntries(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function nvmPackageBinTargets(packageDir: string): Map<string, string> {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8")) as {
      bin?: unknown;
    };
    if (!manifest.bin || typeof manifest.bin !== "object" || Array.isArray(manifest.bin)) {
      return new Map();
    }
    const packageRoot = `${path.resolve(packageDir)}${path.sep}`;
    return new Map(
      Object.entries(manifest.bin).flatMap(([binName, rawTarget]) => {
        if (typeof rawTarget !== "string") return [];
        const target = path.resolve(packageDir, rawTarget);
        return target.startsWith(packageRoot) ? ([[binName, target]] as const) : [];
      }),
    );
  } catch {
    return new Map();
  }
}

function nvmBinBelongsToPackage(target: string, expectedTarget: string): boolean {
  try {
    if (fs.realpathSync(target) === fs.realpathSync(expectedTarget)) return true;
    const targetStat = fs.statSync(target);
    const expectedStat = fs.statSync(expectedTarget);
    return targetStat.dev === expectedStat.dev && targetStat.ino === expectedStat.ino;
  } catch {
    try {
      return (
        path.resolve(path.dirname(target), fs.readlinkSync(target)) === path.resolve(expectedTarget)
      );
    } catch {
      return false;
    }
  }
}

function removeNvmLeftovers(paths: UninstallPaths, runtime: UninstallRuntime): void {
  const nodeVersionsDir = path.join(paths.nvmDir, "versions", "node");
  if (!runtime.existsSync(nodeVersionsDir)) return;
  // npm publishes every declared bin as a symlink, so an `isFile()` test never matched them.
  const cliBinNames = ["nemoclaw", ...paths.agentAliasShimPaths.map((shim) => shim.binName)];
  for (const version of dirEntries(nodeVersionsDir)) {
    if (!version.isDirectory()) continue;
    const versionDir = path.join(nodeVersionsDir, version.name);
    const modulesDir = path.join(versionDir, "lib", "node_modules");
    const packageEntry = dirEntries(modulesDir).find(
      (entry) => (entry.isDirectory() || entry.isSymbolicLink()) && entry.name === "nemoclaw",
    );
    const packageDir = packageEntry ? path.join(modulesDir, packageEntry.name) : null;
    const packageBins = packageDir ? nvmPackageBinTargets(packageDir) : new Map<string, string>();
    const binDir = path.join(versionDir, "bin");
    for (const entry of dirEntries(binDir)) {
      const removable = entry.isFile() || entry.isSymbolicLink();
      const target = path.join(binDir, entry.name);
      const expectedTarget = packageBins.get(entry.name);
      if (
        !removable ||
        !cliBinNames.includes(entry.name) ||
        !expectedTarget ||
        !nvmBinBelongsToPackage(target, expectedTarget)
      ) {
        continue;
      }
      runtime.rmSync(target, { force: true });
      runtime.log(`Removed leftover ${entry.name} binary at ${target}`);
    }
    if (packageDir && packageEntry?.isDirectory()) {
      runtime.rmSync(packageDir, { force: true, recursive: true });
      runtime.log(`Removed leftover nemoclaw module at ${packageDir}`);
    }
  }
}

/**
 * Remove installer-managed user-local CLI shims (`~/.local/bin/nemoclaw` and
 * agent-alias siblings). Classification still preserves foreign files of those
 * names. Shared npm global package removal stays in `removeNemoclawCli`.
 * Returns how many shim paths `removePath` actually deleted.
 */
function removeManagedCliShims(paths: UninstallPaths, runtime: UninstallRuntime): number {
  let removed = 0;
  const shim = classifyShimPath(paths.nemoclawShimPath);
  if (shim.remove) {
    if (removePath(paths.nemoclawShimPath, runtime)) removed += 1;
  } else if (shim.kind === "preserve-foreign-file") {
    runtime.warn(
      `Leaving ${paths.nemoclawShimPath} in place because it is not an installer-managed shim.`,
    );
  }
  // Also remove the sibling agent-alias shims (nemohermes, nemo-deepagents) the
  // installer creates; uninstall previously left them resolving on PATH (#6098).
  // The same classification guard preserves any non-managed file of that name.
  for (const alias of paths.agentAliasShimPaths) {
    const aliasShim = classifyShimPath(alias.path, {}, alias.binName);
    if (aliasShim.remove) {
      if (removePath(alias.path, runtime)) removed += 1;
    } else if (aliasShim.kind === "preserve-foreign-file") {
      runtime.warn(`Leaving ${alias.path} in place because it is not an installer-managed shim.`);
    }
  }
  return removed;
}

function removeNemoclawCli(paths: UninstallPaths, runtime: UninstallRuntime): void {
  const branding = runtimeBranding(runtime);
  if (runtime.commandExists("npm")) {
    runtime.run("npm", ["unlink", "-g", "nemoclaw"], { env: runtime.env, stdio: "ignore" });
    const result = runtime.run("npm", ["uninstall", "-g", "--loglevel=error", "nemoclaw"], {
      env: runtime.env,
      stdio: "ignore",
    });
    if (result.status === 0) runtime.log(`Removed global ${branding.display} CLI package`);
    else runtime.warn(`Global ${branding.display} CLI package not found or already removed`);
  } else {
    runtime.warn(`npm not found; skipping ${branding.display} CLI uninstall.`);
  }

  removeManagedCliShims(paths, runtime);
  removeNvmLeftovers(paths, runtime);
  removeAliases(paths, runtime);
}

/**
 * CLI uninstall step for `executePlan`. Extracted so the plan loop stays under
 * the run-plan cognitive-complexity budget when scoped destroy needs the
 * confirmed-sibling vs unidentified shim split (#9277).
 */
function runNemoclawCliUninstallStep(
  paths: UninstallPaths,
  options: UninstallRunOptions,
  runtime: UninstallRuntime,
  scopedToSelectedGateway: boolean,
  otherGatewayPorts: readonly number[],
): void {
  if (!scopedToSelectedGateway) {
    removeNemoclawCli(paths, runtime);
    return;
  }
  // Confirmed sibling gateway ports share ~/.local/bin shims. Only the
  // unidentified / unproven scoped path (#9277 false positives: odd
  // gateways/ entries, unreadable gateway list, etc.) may drop managed
  // shims on `--destroy-user-data` while keeping the shared npm package.
  const confirmedSiblingPortsRemain = otherGatewayPorts.length > 0;
  if (options.destroyUserData && !confirmedSiblingPortsRemain) {
    runtime.log("Sibling gateways remain; kept the shared NemoClaw CLI package.");
    const removedShims = removeManagedCliShims(paths, runtime);
    if (removedShims > 0) {
      runtime.log("Removed managed user-local CLI shims because --destroy-user-data was set.");
    }
    return;
  }
  runtime.log("Sibling gateways remain; kept the shared NemoClaw CLI and shell shims.");
}

function dockerIsAvailable(runtime: UninstallRuntime): boolean {
  if (!runtime.commandExists("docker")) {
    runtime.warn("docker not found; skipping Docker cleanup.");
    return false;
  }
  if (runtime.runDocker(["info"], { env: runtime.env, stdio: "ignore" }).status !== 0) {
    runtime.warn("docker is not running; skipping Docker cleanup.");
    return false;
  }
  return true;
}

function managedDistributedVllmStateRootStatus(
  paths: UninstallPaths,
  runtime: Pick<UninstallRuntime, "error">,
): "absent" | "directory" | "unsafe" {
  const sharedRoot = path.dirname(paths.managedSwapMarkerPath);
  try {
    const root = fs.lstatSync(sharedRoot);
    if (root.isSymbolicLink() || !root.isDirectory()) {
      runtime.error(`Managed distributed vLLM state root is not a real directory: ${sharedRoot}`);
      return "unsafe";
    }
    return "directory";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    runtime.error(`Could not inspect managed distributed vLLM state root: ${formatError(error)}`);
    return "unsafe";
  }
}

function removeManagedDistributedVllmRuntime(
  paths: UninstallPaths,
  runtime: UninstallRuntime,
  preserveApiKeyWithoutReceipt = false,
): boolean {
  const rootStatus = managedDistributedVllmStateRootStatus(paths, runtime);
  if (rootStatus !== "directory") return rootStatus === "absent";
  const apiKeyPath = path.join(
    path.dirname(paths.managedSwapMarkerPath),
    MANAGED_VLLM_API_KEY_FILE,
  );
  let state: ReturnType<typeof findManagedDistributedVllmRuntimeReceipts>;
  try {
    state = findManagedDistributedVllmRuntimeReceipts({
      homeDir: runtime.env.HOME || os.homedir(),
    });
  } catch (error) {
    runtime.error(
      "Could not inspect managed distributed vLLM rollback state. NemoClaw refused uninstall before making changes.",
    );
    return false;
  }
  const receipts = [
    ...(state.managedClusterPath ? [state.managedClusterPath] : []),
    ...state.stationPaths,
  ];
  const bindingPaths = [
    ...state.managedClusterBindingPaths,
    ...state.managedClusterDiscoveryBindingPaths,
    ...state.stationBindingPaths,
  ];
  const expectedBindingPaths = new Set(
    state.stationPaths.map((receiptPath) => `${receiptPath}.ssh-binding`),
  );
  if (state.managedClusterPath) {
    const stateDir = path.dirname(state.managedClusterPath);
    for (const bindingPath of [
      ...state.managedClusterBindingPaths,
      ...state.managedClusterDiscoveryBindingPaths,
    ]) {
      if (path.dirname(bindingPath) === stateDir) expectedBindingPaths.add(bindingPath);
    }
  }
  const orphanBinding = bindingPaths.find((bindingPath) => !expectedBindingPaths.has(bindingPath));
  if (orphanBinding) {
    runtime.error(
      "A managed distributed vLLM SSH binding exists without its ownership receipt. NemoClaw refused uninstall before making changes. Recover or remove that state explicitly, then retry.",
    );
    return false;
  }
  if (receipts.length === 0) {
    if (!preserveApiKeyWithoutReceipt) removePath(apiKeyPath, runtime);
    return true;
  }
  if (state.managedClusterPath && state.stationPaths.length > 0) {
    runtime.error(
      "Both managed cluster and dual-Station managed runtime receipts exist. NemoClaw refused ambiguous cleanup before making changes.",
    );
    return false;
  }
  if (receipts.length !== 1) {
    runtime.error(
      "Multiple managed distributed vLLM runtime receipts exist. NemoClaw refused ambiguous cleanup before making changes.",
    );
    return false;
  }
  const result = runtime.runDualStationRuntimeCleanup(receipts[0]!, {
    env: runtime.env,
    stdio: "inherit",
  });
  if (result.status === 0) {
    removePath(apiKeyPath, runtime);
    return true;
  }
  runtime.error(
    "Managed distributed vLLM cleanup did not complete. NemoClaw did not start the remaining uninstall steps. Resolve the reported cleanup error and retry uninstall.",
  );
  return false;
}

function removeHostLocalModelRuntimes(paths: UninstallPaths, runtime: UninstallRuntime): boolean {
  const sharedRoot = path.dirname(paths.managedSwapMarkerPath);
  const hasLlamaState = runtime.existsSync(path.join(sharedRoot, "managed-llama-cpp"));
  const hasManagedKey = runtime.existsSync(path.join(sharedRoot, MANAGED_VLLM_API_KEY_FILE));
  const hasDistributedReceipt = [
    MANAGED_CLUSTER_VLLM_RUNTIME_RECEIPT_FILE,
    DUAL_STATION_VLLM_RUNTIME_RECEIPT_FILE,
  ].some((name) => runtime.existsSync(path.join(sharedRoot, name)));
  if (!hasLlamaState && (!hasManagedKey || hasDistributedReceipt)) {
    if (!hasManagedKey && !hasDistributedReceipt && !removeOrphanedManagedHostLocalVllm(runtime)) {
      return false;
    }
    return true;
  }
  const result = runtime.runLocalModelRuntimeCleanup({
    env: runtime.env,
    stdio: "inherit",
  });
  if (result.status === 0) return true;
  runtime.error(
    "Host-local model runtime cleanup did not complete. NemoClaw did not start the remaining uninstall steps. Resolve the reported ownership or Docker error and retry uninstall.",
  );
  return false;
}

function removeOrphanedManagedHostLocalVllm(runtime: UninstallRuntime): boolean {
  if (!runtime.commandExists("docker")) return true;
  const inspection = runtime.runDocker(
    [
      "container",
      "inspect",
      "--format",
      `{{.Id}} {{index .Config.Labels ${JSON.stringify(HOST_LOCAL_VLLM_MANAGED_LABEL)}}}`,
      HOST_LOCAL_VLLM_CONTAINER_NAME,
    ],
    { env: runtime.env, timeout: 10_000 },
  );
  if (inspection.status !== 0 || !inspection.stdout.trim()) return true;
  const [containerId, managedLabel, ...extra] = inspection.stdout.trim().split(/\s+/);
  if (!/^[0-9a-f]{64}$/u.test(containerId ?? "") || managedLabel !== "true" || extra.length > 0) {
    return true;
  }
  const removal = runtime.runDocker(["rm", "-f", containerId], {
    env: runtime.env,
    timeout: 10_000,
  });
  if (removal.status === 0) return true;
  runtime.error(
    `Could not remove orphaned managed inference container '${HOST_LOCAL_VLLM_CONTAINER_NAME}'. NemoClaw did not start the remaining uninstall steps.`,
  );
  return false;
}

function managedLlamaCppCleanupPorts(homeDir: string, scopedToSelectedGateway: boolean): number[] {
  const ports = new Set<number>([GATEWAY_PORT]);
  if (scopedToSelectedGateway) return [...ports];
  for (const { gatewayPort } of listGatewayStateRoots(homeDir)) ports.add(gatewayPort);
  return [...ports].sort((left, right) => left - right);
}

function managedLlamaCppCleanupTargets(
  runtime: UninstallRuntime,
  scopedToSelectedGateway: boolean,
): ManagedLlamaCppCleanupTarget[] | null {
  const homeDir = runtime.env.HOME || os.homedir();
  try {
    const targets: ManagedLlamaCppCleanupTarget[] = [];
    for (const gatewayPort of managedLlamaCppCleanupPorts(homeDir, scopedToSelectedGateway)) {
      const target = resolveManagedLlamaCppCleanupTarget(homeDir, gatewayPort);
      if (target) targets.push(target);
    }
    return targets;
  } catch (error) {
    runtime.error(
      "Managed llama.cpp cleanup could not safely inventory gateway-scoped ownership state. NemoClaw did not start the remaining uninstall steps.",
    );
    return null;
  }
}

interface ManagedLlamaCppCleanupOutcome {
  readonly failedStateDirs: readonly string[];
  readonly ok: boolean;
}

function removeManagedLlamaCppRuntimes(
  runtime: UninstallRuntime,
  scopedToSelectedGateway: boolean,
): ManagedLlamaCppCleanupOutcome {
  const targets = managedLlamaCppCleanupTargets(runtime, scopedToSelectedGateway);
  if (targets === null) return { failedStateDirs: [], ok: false };
  for (const target of targets) {
    const result = runtime.runManagedLlamaCppRuntimeCleanup(target.sandboxName, target.gatewayPort);
    for (const removed of splitNonEmptyLines(result.stdout)) runtime.log(`Removed ${removed}`);
    if (result.status !== 0) {
      runtime.error(
        `Managed llama.cpp cleanup for sandbox '${target.sandboxName}' on gateway port ${String(target.gatewayPort)} did not complete: ${result.stderr.trim() || "unknown cleanup error"}. NemoClaw will preserve its ownership state and continue unrelated uninstall steps.`,
      );
      return { failedStateDirs: [target.stateDir], ok: true };
    }
    if (fs.lstatSync(target.stateDir, { throwIfNoEntry: false }) !== undefined) {
      runtime.error(
        `Managed llama.cpp cleanup for sandbox '${target.sandboxName}' on gateway port ${String(target.gatewayPort)} returned without retiring its ownership state. NemoClaw will preserve its ownership state and continue unrelated uninstall steps.`,
      );
      return { failedStateDirs: [target.stateDir], ok: true };
    }
  }
  return { failedStateDirs: [], ok: true };
}

function removeManagedModelRuntimes(
  paths: UninstallPaths,
  runtime: UninstallRuntime,
  scopedToSelectedGateway: boolean,
): ManagedLlamaCppCleanupOutcome {
  const llama = removeManagedLlamaCppRuntimes(runtime, scopedToSelectedGateway);
  if (!llama.ok || llama.failedStateDirs.length > 0) return llama;
  if (scopedToSelectedGateway) return llama;
  const sharedRoot = path.dirname(paths.managedSwapMarkerPath);
  const hasDistributedReceipt = [
    MANAGED_CLUSTER_VLLM_RUNTIME_RECEIPT_FILE,
    DUAL_STATION_VLLM_RUNTIME_RECEIPT_FILE,
  ].some((name) => runtime.existsSync(path.join(sharedRoot, name)));
  if (!removeManagedDistributedVllmRuntime(paths, runtime, !hasDistributedReceipt)) {
    return { failedStateDirs: [], ok: false };
  }
  if (!removeHostLocalModelRuntimes(paths, runtime)) {
    return { failedStateDirs: [], ok: false };
  }
  if (!hasDistributedReceipt) {
    removePath(path.join(sharedRoot, MANAGED_VLLM_API_KEY_FILE), runtime);
  }
  if (!runtime.commandExists("docker")) return llama;
  const inventory = runtime.runDocker(["ps", "-a", "--format", "{{.Names}}"], {
    env: runtime.env,
    timeout: 10_000,
  });
  if (inventory.status !== 0) {
    runtime.error(
      "Docker could not inventory reserved managed inference container names. NemoClaw refused the remaining uninstall steps so it cannot report incomplete cleanup as success.",
    );
    return { failedStateDirs: [], ok: false };
  }
  const residual = splitNonEmptyLines(inventory.stdout).find((name) =>
    MANAGED_INFERENCE_CONTAINER_NAME_PATTERN.test(name),
  );
  if (!residual) return llama;
  runtime.error(
    `Managed inference container '${residual}' remains after ownership-aware cleanup. NemoClaw refused the remaining uninstall steps; restore its ownership state or remove it after manual review, then retry.`,
  );
  return { failedStateDirs: [], ok: false };
}

function recordManagedModelCleanup(
  paths: UninstallPaths,
  runtime: UninstallRuntime,
  scopedToSelectedGateway: boolean,
  failedStateDirs: string[],
  onPartialFailure: () => void,
): boolean {
  const result = removeManagedModelRuntimes(paths, runtime, scopedToSelectedGateway);
  failedStateDirs.push(...result.failedStateDirs);
  if (result.failedStateDirs.length > 0) onPartialFailure();
  return result.ok;
}

function stopBedrockRuntimeAdapterForUninstall(
  paths: UninstallPaths,
  runtime: UninstallRuntime,
  scopedToSelectedGateway: boolean,
): void {
  const result = stopBedrockRuntimeAdapter(paths, runtime, {
    gatewayPort: GATEWAY_PORT,
    scanOrphans: !scopedToSelectedGateway,
  });
  if (result.ok) return;
  runtime.error(result.message);
  throw new IncompleteBedrockRuntimeAdapterCleanupError();
}

function removeDockerContainers(runtime: UninstallRuntime, gatewayName?: string): void {
  const result = runtime.runDocker(["ps", "-a", "--format", "{{.ID}} {{.Image}} {{.Names}}"], {
    env: runtime.env,
  });
  const ids = splitNonEmptyLines(result.stdout)
    .filter((line) => {
      const fields = dockerInventoryFields(line, 3);
      const image = fields[1] ?? "";
      const name = fields[2] ?? "";
      if (!gatewayName) {
        if (MANAGED_INFERENCE_CONTAINER_NAME_PATTERN.test(name)) {
          return false;
        }
        // `openclaw` is deliberately absent: NemoClaw's containers are
        // `openshell-*` (cluster and sandbox) and `nemoclaw-*` (gateway compat
        // and managed inference), so that term only ever selected the separate
        // OpenClaw project's containers for `docker rm -f` (#8496).
        // Probe containers that run with `--rm` and no `--name`, such as
        // `hermesBaseImageSupportsMcp`, take a random Docker name. Their
        // NemoClaw image reference is the only way to reclaim one that an
        // interrupted run orphaned.
        return isOwnedDockerContainerName(name) || isOwnedDockerImageRepository(image);
      }
      return (
        name === `openshell-cluster-${gatewayName}` ||
        name ===
          (GATEWAY_PORT === DEFAULT_GATEWAY_PORT
            ? "nemoclaw-openshell-gateway"
            : `nemoclaw-openshell-gateway-${String(GATEWAY_PORT)}`)
      );
    })
    .map((line) => line.split(/\s+/)[0]);
  if (ids.length === 0) {
    runtime.log(`No ${runtimeBranding(runtime).display}/OpenShell Docker containers found`);
    return;
  }
  for (const id of [...new Set(ids)]) {
    if (runtime.runDocker(["rm", "-f", id], { env: runtime.env, stdio: "ignore" }).status === 0)
      runtime.log(`Removed Docker container ${id}`);
    else runtime.warn(`Failed to remove Docker container ${id}`);
  }
}

function removeDockerImages(runtime: UninstallRuntime): void {
  const result = runtime.runDocker(["images", "--format", "{{.ID}} {{.Repository}}:{{.Tag}}"], {
    env: runtime.env,
  });
  const ids = splitNonEmptyLines(result.stdout)
    // `openclaw` is deliberately absent: NemoClaw builds no image under that
    // name, so the term only ever selected the separate OpenClaw project's
    // images — including any `ghcr.io/openclaw/*` pulled by an unrelated
    // workload — for `docker rmi -f` (#8496).
    .filter((line) => isOwnedDockerImageRepository(dockerInventoryFields(line, 2)[1] ?? ""))
    .map((line) => line.split(/\s+/)[0]);
  if (ids.length === 0) {
    runtime.log(`No ${runtimeBranding(runtime).display}/OpenShell Docker images found`);
    return;
  }
  for (const id of [...new Set(ids)]) {
    if (runtime.runDocker(["rmi", "-f", id], { env: runtime.env, stdio: "ignore" }).status === 0)
      runtime.log(`Removed Docker image ${id}`);
    else runtime.warn(`Failed to remove Docker image ${id}`);
  }
}

function dockerInventoryFields(line: string, expectedFields: number): string[] {
  return line.trim().split(/\s+/, expectedFields);
}

function dockerImageRepository(imageRef: string): string {
  const withoutDigest = imageRef.split("@", 1)[0] ?? "";
  const tagSeparator = withoutDigest.lastIndexOf(":");
  if (tagSeparator === -1) return withoutDigest;
  const slashSeparator = withoutDigest.lastIndexOf("/");
  return tagSeparator > slashSeparator ? withoutDigest.slice(0, tagSeparator) : withoutDigest;
}

function isOwnedDockerContainerName(name: string): boolean {
  return /^openshell-(?:cluster-)?/iu.test(name) || /^nemoclaw-/iu.test(name);
}

function isOwnedDockerImageRepository(imageRef: string): boolean {
  const repository = dockerImageRepository(imageRef);
  return (
    /^nemoclaw-/iu.test(repository) ||
    /^openshell\//iu.test(repository) ||
    /^ghcr\.io\/nvidia\/nemoclaw(?:[/-]|$)/iu.test(repository)
  );
}

function removeDockerVolume(name: string, runtime: UninstallRuntime): void {
  if (
    runtime.runDocker(["volume", "inspect", name], { env: runtime.env, stdio: "ignore" }).status !==
    0
  )
    return;
  if (
    runtime.runDocker(["volume", "rm", "-f", name], { env: runtime.env, stdio: "ignore" })
      .status === 0
  )
    runtime.log(`Removed Docker volume ${name}`);
  else runtime.warn(`Failed to remove Docker volume ${name}`);
}

function parseOllamaModelInventory(output: string): string[] {
  const rows = output
    .split(/\r?\n/u)
    .map((row) => row.trim())
    .filter(Boolean);
  const header = rows.shift()?.split(/\s+/u) ?? [];
  if (header.length < 2 || header[0] !== "NAME" || header[1] !== "ID") {
    throw new Error("Ollama model inventory did not contain the expected NAME and ID columns");
  }
  const models = new Set<string>();
  for (const row of rows) {
    const columns = row.split(/\s+/u);
    const model = columns[0] ?? "";
    if (
      columns.length < 2 ||
      model.length === 0 ||
      model.length > 512 ||
      model.startsWith("-") ||
      /[\u0000-\u001f\u007f]/u.test(model)
    ) {
      throw new Error("Ollama model inventory contained an unsafe or malformed model name");
    }
    models.add(model);
  }
  return [...models];
}

function localOllamaEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, OLLAMA_HOST: "127.0.0.1:11434" };
}

function removeOllamaModels(options: UninstallRunOptions, runtime: UninstallRuntime): boolean {
  if (!options.deleteModels) {
    runtime.log("Keeping Ollama models as requested.");
    return true;
  }
  if (!runtime.commandExists("ollama")) {
    runtime.log("Ollama is not installed; no Ollama model inventory is available to remove.");
    return true;
  }
  const ollamaEnv = localOllamaEnvironment(runtime.env);
  const inventory = runtime.run("ollama", ["list"], {
    env: ollamaEnv,
    timeout: 10_000,
  });
  if (inventory.status !== 0) {
    runtime.error(
      `Ollama model inventory failed${inventory.stderr.trim() ? `: ${inventory.stderr.trim()}` : "."}`,
    );
    return false;
  }
  let models: string[];
  try {
    models = parseOllamaModelInventory(inventory.stdout);
  } catch (error) {
    runtime.error(`${formatError(error)}. No Ollama models were removed.`);
    return false;
  }
  if (models.length === 0) {
    runtime.log("No installed Ollama models found.");
    return true;
  }
  let ok = true;
  for (const model of models) {
    if (
      runtime.run("ollama", ["rm", model], {
        env: ollamaEnv,
        stdio: "ignore",
        timeout: 60_000,
      }).status === 0
    )
      runtime.log(`Removed Ollama model '${model}'`);
    else {
      runtime.error(`Failed to remove Ollama model '${model}'`);
      ok = false;
    }
  }
  return ok;
}

function removeHostModelStores(
  paths: UninstallPaths,
  options: UninstallRunOptions,
  runtime: UninstallRuntime,
  scopedToSelectedGateway: boolean,
  preserveForFailedLlamaCleanup: boolean,
): boolean {
  if (preserveForFailedLlamaCleanup) {
    runtime.log(
      "Managed llama.cpp cleanup did not complete. NemoClaw kept model stores for retry.",
    );
    return true;
  }
  if (scopedToSelectedGateway) {
    runtime.log(
      "Sibling gateways remain; kept host-shared Ollama models and the Hugging Face model cache.",
    );
    return true;
  }
  const ollamaOk = removeOllamaModels(options, runtime);
  if (!options.deleteModels) {
    runtime.log("Keeping Hugging Face cache data as requested.");
    return ollamaOk;
  }
  if (!runtime.existsSync(paths.huggingFaceModelCacheDir)) {
    runtime.log("No Hugging Face cache data found.");
    return ollamaOk;
  }
  const result = runtime.runHuggingFaceCacheDataCleanup({
    env: runtime.env,
    stdio: "inherit",
  });
  if (result.status === 0) return ollamaOk;
  runtime.error(
    "Hugging Face cache-data cleanup did not complete during Model stores. Resolve the reported ownership or path error and retry uninstall.",
  );
  return false;
}

interface OtherGatewayInspection {
  otherGatewayEnvironmentsRemain: boolean;
  otherGatewayPorts: readonly number[];
  sharedRegistryMustBePreserved: boolean;
  unidentifiedOtherGateways: boolean;
}

const NO_OTHER_GATEWAY_ENVIRONMENTS: OtherGatewayInspection = {
  otherGatewayEnvironmentsRemain: false,
  otherGatewayPorts: [],
  sharedRegistryMustBePreserved: false,
  unidentifiedOtherGateways: false,
};

function otherGatewaysRemain(
  ports: readonly number[],
  sharedRegistryMustBePreserved = false,
  unidentifiedOtherGateways = false,
): OtherGatewayInspection {
  return {
    otherGatewayEnvironmentsRemain: true,
    otherGatewayPorts: [...new Set(ports)].sort((left, right) => left - right),
    sharedRegistryMustBePreserved,
    unidentifiedOtherGateways: unidentifiedOtherGateways || ports.length === 0,
  };
}

/**
 * Names of the gateways OpenShell currently knows about, or `null` when that
 * cannot be determined (OpenShell missing, the query failed, or its output was
 * unparseable). `null` always means "stay conservative": callers must not treat
 * an absence they cannot prove as evidence that a gateway is gone. (#7315)
 */
function collectLiveOpenShellGatewayNames(runtime: UninstallRuntime): Set<string> | null {
  if (!runtime.commandExists("openshell")) return null;
  const result = runtime.run("openshell", ["gateway", "list", "-o", "json"], {
    env: runtime.env,
  });
  if (result.status !== 0) return null;
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(parsed)) return null;
    const names = new Set<string>();
    for (const item of parsed) {
      if (item === null || typeof item !== "object") return null;
      const name = (item as { name?: unknown }).name;
      if (typeof name !== "string" || name.length === 0) return null;
      names.add(name);
    }
    return names;
  } catch {
    return null;
  }
}

/**
 * A caller that already uninstalled the other gateway ports knows which of them
 * failed, and a failed port keeps residual state even when its gateway is gone.
 * Observation alone can no longer see such a port, so the caller's list is added
 * to whatever this run discovers, keeping cleanup gateway-scoped (#7791).
 */
function inspectOtherGatewayEnvironments(
  paths: UninstallPaths,
  runtime: UninstallRuntime,
): OtherGatewayInspection {
  const discovered = discoverOtherGatewayEnvironments(paths, runtime);
  if (runtime.retainedGatewayPorts.length === 0) return discovered;
  // A retained port may still own rows in the shared registry, so keep the
  // shared default-root state rather than pruning it out from under it.
  return otherGatewaysRemain(
    [...discovered.otherGatewayPorts, ...runtime.retainedGatewayPorts],
    true,
    discovered.unidentifiedOtherGateways,
  );
}

// Names a desktop environment writes into a directory it displays. macOS writes
// .DS_Store and .localized, and ._<name> to carry a resource fork and extended
// attributes on a filesystem that lacks them. None of them hold gateway state.
function isDesktopMetadataEntry(name: string): boolean {
  // "._" alone names no file it could carry, so it stays conservative.
  return (
    name === ".DS_Store" || name === ".localized" || (name.startsWith("._") && name.length > 2)
  );
}

function discoverOtherGatewayEnvironments(
  paths: UninstallPaths,
  runtime: UninstallRuntime,
): OtherGatewayInspection {
  const sharedRoot = path.dirname(paths.managedSwapMarkerPath);
  const selectedRoot = path.resolve(paths.nemoclawStateDir);
  const selectedIsDefault = selectedRoot === path.resolve(sharedRoot);
  // The gateways OpenShell actually knows about, queried at most once and shared
  // by both sibling-detection surfaces below, so stale filesystem or registry
  // state (e.g. a shared CI runner reusing ~/.nemoclaw across jobs) can't pin
  // host-shared cleanup like the openshell-gateway binary on a gone gateway. (#7315)
  let liveGatewayNamesCache: Set<string> | null | undefined;
  const liveGatewayNames = (): Set<string> | null => {
    if (liveGatewayNamesCache === undefined) {
      liveGatewayNamesCache = collectLiveOpenShellGatewayNames(runtime);
    }
    return liveGatewayNamesCache;
  };
  const sharedRegistrySiblings = sharedRegistrySiblingStatus(paths, runtime, liveGatewayNames);
  if (sharedRegistrySiblings.status !== "none") {
    return otherGatewaysRemain(sharedRegistrySiblings.ports, true);
  }
  const liveNames = liveGatewayNames();
  if (liveNames === null) {
    return otherGatewaysRemain([]);
  }
  const liveSiblingNames = [...liveNames].filter(
    (name) => name !== resolveGatewayName(GATEWAY_PORT),
  );
  if (liveSiblingNames.length > 0) {
    const livePorts = liveSiblingNames
      .map((name) => resolveGatewayPortFromName(name))
      .filter((port): port is number => port !== null);
    return otherGatewaysRemain(livePorts, false, livePorts.length !== liveSiblingNames.length);
  }

  if (!selectedIsDefault && pathEntryExists(sharedRoot, runtime)) {
    try {
      if (
        fs
          .readdirSync(sharedRoot)
          .some(
            (entry) =>
              !isSharedHostStateEntry(entry) &&
              !(entry === "state" && dormantHostGlobalLifecycleState(sharedRoot)),
          )
      ) {
        return otherGatewaysRemain([DEFAULT_GATEWAY_PORT]);
      }
    } catch {
      // Do not remove a host-shared resource when we cannot prove that the
      // default-port environment is absent.
      return otherGatewaysRemain([]);
    }
  }

  const gatewaysDir = path.join(sharedRoot, GATEWAYS_SUBDIR);
  if (!pathEntryExists(gatewaysDir, runtime)) {
    return NO_OTHER_GATEWAY_ENVIRONMENTS;
  }
  try {
    const gatewaysStat = fs.lstatSync(gatewaysDir);
    if (gatewaysStat.isSymbolicLink() || !gatewaysStat.isDirectory()) {
      return otherGatewaysRemain([]);
    }
    const siblingPorts: number[] = [];
    let unidentified = false;
    for (const entry of fs.readdirSync(gatewaysDir, { withFileTypes: true })) {
      const candidate = path.resolve(gatewaysDir, entry.name);
      if (candidate === selectedRoot) continue;
      // Counting desktop metadata as unidentified scopes the whole uninstall,
      // which keeps the CLI and shell shims on PATH after a run that reports
      // success (#7905). Only a regular file matches, so a directory or a
      // symlink with the same name still gets the conservative treatment.
      if (entry.isFile() && isDesktopMetadataEntry(entry.name)) continue;
      // Never follow or dismiss a symlink or non-directory: a surprising shape
      // may hide live gateway state, so keep the conservative treatment.
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        unidentified = true;
        continue;
      }
      const port = Number(entry.name);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        unidentified = true;
        continue;
      }
      // A directory named for the gateway being uninstalled is that gateway's
      // own state, never a sibling. Path identity alone does not catch it: for
      // the default port `selectedRoot` is the shared root, so
      // `<shared>/gateways/<DEFAULT_GATEWAY_PORT>` never equals it and the
      // selected gateway counts itself as a sibling, scoping cleanup to
      // preserve resources nothing else owns (#7987). Match on port identity
      // like every other sibling filter here and like `listGatewayStateRoots`.
      if (port === GATEWAY_PORT) continue;
      // A per-port directory whose gateway OpenShell no longer knows is an
      // orphan; dismiss it only when the live set positively lacks it.
      const live = liveGatewayNames();
      if (live === null) {
        unidentified = true;
        continue;
      }
      if (live.has(resolveGatewayName(port))) siblingPorts.push(port);
    }
    return siblingPorts.length > 0 || unidentified
      ? otherGatewaysRemain(siblingPorts, false, unidentified)
      : NO_OTHER_GATEWAY_ENVIRONMENTS;
  } catch {
    // An unreadable sibling registry is still potentially live.
    return otherGatewaysRemain([]);
  }
}

/**
 * Name the gateway-port environments this uninstall deliberately leaves alone.
 * Without this the surviving gateway keeps its port bound with nothing to
 * explain why, which reads as a leaked listener rather than a second
 * environment (#7791).
 */
function reportOtherGatewayEnvironments(
  inspection: OtherGatewayInspection,
  runtime: UninstallRuntime,
): void {
  if (!inspection.otherGatewayEnvironmentsRemain) return;
  const branding = runtimeBranding(runtime);
  const [firstPort] = inspection.otherGatewayPorts;
  const warningLines = [
    `  ⚠ Other ${branding.display} gateway-port environments remain on this host and are outside this uninstall:`,
    ...inspection.otherGatewayPorts.map(
      (port) => `  · gateway '${resolveGatewayName(port)}' on port ${String(port)}`,
    ),
    ...(inspection.unidentifiedOtherGateways
      ? ["  · one or more gateway environments whose port could not be read"]
      : []),
    ...(firstPort !== undefined
      ? [
          `  Remove one of them: NEMOCLAW_GATEWAY_PORT=${String(firstPort)} ${branding.cli} uninstall`,
        ]
      : []),
    `  Remove every gateway port: ${branding.cli} uninstall --all-gateway-ports`,
  ];
  for (const line of warningLines) {
    runtime.warn(yellowWarningText(line, runtime));
  }
}

function removeManagedSwap(
  paths: UninstallPaths,
  runtime: UninstallRuntime,
  otherGatewayEnvironmentsRemain: boolean,
): void {
  if (!runtime.existsSync("/swapfile")) {
    runtime.log("No /swapfile found; skipping swap cleanup.");
    removePath(paths.managedSwapMarkerPath, runtime);
    return;
  }
  if (!runtime.existsSync(paths.managedSwapMarkerPath)) {
    runtime.warn(
      `No ${runtimeBranding(runtime).display}-managed swap marker found, skipping swap cleanup.`,
    );
    return;
  }
  if (otherGatewayEnvironmentsRemain) {
    runtime.log(
      "Other NemoClaw gateway-port environments remain; keeping the host-shared /swapfile.",
    );
    return;
  }
  if (runtime.env.NEMOCLAW_NON_INTERACTIVE === "1" || !runtime.isTty) {
    runtime.warn("Skipping swap cleanup in non-interactive mode (requires sudo).");
    return;
  }
  const swapoff = runtime.run("sudo", ["swapoff", "/swapfile"], {
    env: runtime.env,
    stdio: "ignore",
  });
  if (swapoff.status !== 0) {
    runtime.warn("Failed to disable /swapfile; skipping swap cleanup.");
    return;
  }
  const rm = runtime.run("sudo", ["rm", "-f", "/swapfile"], { env: runtime.env, stdio: "ignore" });
  if (rm.status === 0) {
    runtime.log("Swap file removed");
    removePath(paths.managedSwapMarkerPath, runtime);
  } else runtime.warn("Failed to remove /swapfile.");
}

function detectPreservableEntries(paths: UninstallPaths, runtime: UninstallRuntime): string[] {
  if (!runtime.existsSync(paths.nemoclawStateDir)) return [];
  return PRESERVED_USER_DATA_ENTRIES.filter((name) =>
    runtime.existsSync(path.join(paths.nemoclawStateDir, name)),
  );
}

// #6520: wording lives in domain/uninstall/messaging.ts; empty when
// sandboxes.json is not being preserved.
function warnPreservedRegistryUnrecoverable(
  preservable: readonly string[],
  runtime: UninstallRuntime,
): void {
  for (const line of preservedRegistryUnrecoverableWarnings(
    preservable,
    runtimeBranding(runtime).cli,
  ))
    runtime.warn(line);
}

function resolvePreserveSet(
  paths: UninstallPaths,
  options: UninstallRunOptions,
  runtime: UninstallRuntime,
): readonly string[] {
  if (options.destroyUserData) {
    runtime.log("--destroy-user-data set; purging user data under ~/.nemoclaw/.");
    return [];
  }
  if (runtime.env.NEMOCLAW_UNINSTALL_DESTROY_USER_DATA === "1") {
    runtime.log(
      "NEMOCLAW_UNINSTALL_DESTROY_USER_DATA=1 set; purging user data under ~/.nemoclaw/.",
    );
    return [];
  }
  const preservable = detectPreservableEntries(paths, runtime);
  if (preservable.length === 0) return PRESERVED_USER_DATA_ENTRIES;
  const nonInteractive =
    !runtime.isTty || options.assumeYes || runtime.env.NEMOCLAW_NON_INTERACTIVE === "1";
  if (nonInteractive) {
    runtime.log(`Preserving ${preservable.join(", ")} under ${paths.nemoclawStateDir}.`);
    runtime.log(
      "  Pass --destroy-user-data (or set NEMOCLAW_UNINSTALL_DESTROY_USER_DATA=1) to purge user data on uninstall.",
    );
    warnPreservedRegistryUnrecoverable(preservable, runtime);
    return PRESERVED_USER_DATA_ENTRIES;
  }
  runtime.log(`The following user data under ${paths.nemoclawStateDir} is preserved by default:`);
  for (const name of preservable) runtime.log(`  · ${name}`);
  runtime.log("Also remove them? [y/N]");
  const reply = runtime.readLine();
  if (reply && /^(y|yes)$/i.test(reply.trim())) {
    runtime.log("Acknowledged; purging user data.");
    return [];
  }
  runtime.log("Keeping user data.");
  warnPreservedRegistryUnrecoverable(preservable, runtime);
  return PRESERVED_USER_DATA_ENTRIES;
}

function executeOpenShellResourceCleanup(
  paths: UninstallPaths,
  options: UninstallRunOptions,
  runtime: UninstallRuntime,
  scopedToSelectedGateway: boolean,
  sandboxNames: readonly string[],
  managedHermesStateVolumes: readonly ManagedHermesStateVolumeContext[],
  teardownAuthority: GatewayOwner,
  portableRuntimeCleanup: boolean,
): boolean {
  const externallySupervised = isExternallySupervised(teardownAuthority);
  const portableCleanupInput: PortableRuntimeCleanupInput = {
    env: runtime.env,
    gatewayName: options.gatewayName || resolveGatewayName(GATEWAY_PORT),
    gatewayPort: GATEWAY_PORT,
    homeDir: runtime.env.HOME || os.homedir(),
    registryFile: path.join(paths.nemoclawStateDir, "sandboxes.json"),
    stateDir: path.dirname(paths.managedSwapMarkerPath),
  };
  if (portableRuntimeCleanup) {
    try {
      const cleanup = runtime.runPortableRuntimeCleanupTransaction(
        portableCleanupInput,
        (removed, receiptSandboxNames, receiptGatewayName) => {
          runtime.log(`Removed ${String(removed)} receipt-owned portable sandbox container(s).`);
          if (!removePortableOpenShellResources(runtime, receiptSandboxNames, receiptGatewayName)) {
            return false;
          }
          return true;
        },
      );
      if (cleanup === null) return false;
      if (cleanup.registryRemoved) runtime.log("Removed the managed portable registry container.");
      if (cleanup.selectorsRemoved.length > 0) {
        runtime.log(
          `Cleared NemoClaw portable selectors from the current-user systemd manager: ${cleanup.selectorsRemoved.join(", ")}.`,
        );
      }
    } catch (error) {
      runtime.error(`Portable runtime cleanup failed: ${formatError(error)}`);
      return false;
    }
  } else if (
    !removeOpenShellResources(
      paths,
      options,
      runtime,
      scopedToSelectedGateway,
      sandboxNames,
      teardownAuthority,
    )
  ) {
    return false;
  }
  if (
    !portableRuntimeCleanup &&
    !externallySupervised &&
    !removeManagedHermesStateVolumes(managedHermesStateVolumes, runtime)
  ) {
    return false;
  }
  if (
    scopedToSelectedGateway &&
    !finishScopedOpenShellCleanup(paths, options, runtime, sandboxNames, externallySupervised)
  ) {
    return false;
  }
  if (scopedToSelectedGateway && !options.keepOpenShell && !externallySupervised) {
    if (
      !removeManagedDefaultGatewayUserService(
        runtime,
        options,
        externallySupervised,
        paths.selectedGatewayLocalStateDir,
        true,
      )
    ) {
      return false;
    }
    stopHostGatewayProcessesForUninstall(runtime, {
      gatewayBin: runtime.env.NEMOCLAW_OPENSHELL_GATEWAY_BIN,
      logNoProcesses: true,
      openShellGatewayName: options.gatewayName || resolveGatewayName(GATEWAY_PORT),
      openShellGatewayPort: GATEWAY_PORT,
      preserveRuntimeFilesOnNonMatching: true,
      scopedGatewayStop: true,
      stateDir: paths.selectedGatewayLocalStateDir,
      usePgrepFallback: false,
    });
  } else if (scopedToSelectedGateway && externallySupervised) {
    runtime.log("Kept the externally supervised OpenShell gateway process running.");
  }
  return true;
}

function executePlan(
  plan: UninstallPlan,
  paths: UninstallPaths,
  options: UninstallRunOptions,
  runtime: UninstallRuntime,
  preserveUnderStateDir: readonly string[],
  scopedToSelectedGateway: boolean,
  sharedRegistryMustBePreserved: boolean,
  otherGatewayPorts: readonly number[],
  sandboxNames: readonly string[],
  managedHermesStateVolumes: readonly ManagedHermesStateVolumeContext[],
  teardownAuthority: GatewayOwner,
  portableRuntimeCleanup: boolean,
  portableRetirementEntries: ReturnType<typeof portableRetirementPreservationEntries>,
): { ok: boolean } {
  const externallySupervised = isExternallySupervised(teardownAuthority);
  if (
    !canRemoveScopedOpenShellResources(
      paths,
      options,
      runtime,
      scopedToSelectedGateway,
      teardownAuthority,
    )
  ) {
    return { ok: false };
  }
  let ok = true;
  const failedManagedLlamaStateDirs: string[] = [];
  const branding = runtimeBranding(runtime);
  const preserveSharedOpenShell =
    options.keepOpenShell || externallySupervised || portableRuntimeCleanup;
  const portableStateEntries = portableRuntimeCleanup
    ? [
        "portable-demo-lifecycle",
        "sandboxes.json",
        "sandboxes.json.lock",
        "portable-inference",
        "state",
        HERMES_PORTABLE_UNINSTALL_JOURNAL_FILE,
        ...PORTABLE_RETIREMENT_STATE_ENTRIES,
        ...portableRetirementEntries.stateRoot,
      ]
    : [];
  const serviceKeepMessage = portableRuntimeCleanup
    ? "Keeping shared OpenShell gateway service, configuration, and processes for unrelated sandboxes."
    : "Keeping OpenShell gateway service, configuration, and processes as requested.";
  const sharedOpenShellReason = portableRuntimeCleanup
    ? "portable"
    : externallySupervised
      ? "external"
      : "requested";
  const binaryKeepMessage = {
    external: "Keeping OpenShell binaries used by the externally supervised gateway.",
    portable: "Keeping shared OpenShell binaries for unrelated sandboxes.",
    requested: "Keeping OpenShell binaries as requested.",
  }[sharedOpenShellReason];
  const configKeepMessage = {
    external: "Keeping OpenShell gateway configuration used by the externally supervised gateway.",
    portable: "Keeping shared OpenShell configuration for unrelated sandboxes.",
    requested: "Keeping OpenShell gateway configuration as requested.",
  }[sharedOpenShellReason];
  for (const [index, step] of plan.steps.entries()) {
    runtime.log(`[${index + 1}/${plan.steps.length}] ${planStepDisplayName(step.name, branding)}`);
    const portableStepMessage = PORTABLE_DEFERRED_STEP_MESSAGES[step.name];
    if (portableRuntimeCleanup && portableStepMessage) {
      runtime.log(portableStepMessage);
      continue;
    }
    if (step.name === "Stopping services") {
      if (
        !portableRuntimeCleanup &&
        !recordManagedModelCleanup(
          paths,
          runtime,
          scopedToSelectedGateway,
          failedManagedLlamaStateDirs,
          () => {
            ok = false;
          },
        )
      ) {
        return { ok: false };
      }
      // #8220: a gateway-scoped uninstall still needs the selected OpenShell
      // gateway service running to delete its sandbox, so "OpenShell resources"
      // removes that unit after the sandbox delete succeeds.
      if (
        !scopedToSelectedGateway &&
        !portableRuntimeCleanup &&
        !removeManagedDefaultGatewayUserService(runtime, options, externallySupervised)
      ) {
        ok = false;
      }
      if (!scopedToSelectedGateway) {
        stopHelperServices(paths, runtime);
        removeGlob(paths.helperServiceGlob, runtime);
        if (options.keepOpenShell || portableRuntimeCleanup) {
          runtime.log(serviceKeepMessage);
        } else {
          stopMatchingPids(
            `openshell.*forward.*${runtime.env.NEMOCLAW_DASHBOARD_PORT || "18789"}`,
            runtime,
            "local OpenShell forward processes",
          );
          stopStaleDashboardListeners({
            run: runtime.run,
            kill: runtime.kill,
            env: runtime.env,
            log: runtime.log,
            warn: runtime.warn,
            commandExists: runtime.commandExists,
          });
          stopOrphanedOpenShell(runtime);
          if (!externallySupervised) {
            stopHostGatewayProcessesForUninstall(
              runtime,
              GATEWAY_PORT === DEFAULT_GATEWAY_PORT
                ? { logNoProcesses: true }
                : {
                    gatewayBin: runtime.env.NEMOCLAW_OPENSHELL_GATEWAY_BIN,
                    logNoProcesses: true,
                    openShellGatewayName: options.gatewayName || resolveGatewayName(GATEWAY_PORT),
                    openShellGatewayPort: GATEWAY_PORT,
                    preserveRuntimeFilesOnNonMatching: true,
                    stateDir: paths.selectedGatewayLocalStateDir,
                  },
            );
          }
        }
      } else {
        runtime.log("Sibling gateways remain; kept shared helper services and sibling forwards.");
      }
      if (!stopHermesForwardWatchers(paths.nemoclawStateDir, runtime)) return { ok: false };
      if (externallySupervised) {
        runtime.log("Kept the externally supervised OpenShell gateway process running.");
      }
      stopOllamaAuthProxy(paths, runtime, !scopedToSelectedGateway);
      stopOpenRouterRuntimeAdapter(paths, runtime, {
        scanOrphans: !scopedToSelectedGateway,
      });
      if (scopedToSelectedGateway) {
        runtime.log("Sibling gateways remain; kept the shared HTTPS Pin Runtime adapter.");
      } else {
        stopHttpsPinRuntimeAdapter(paths, runtime);
      }
      stopModelRouter(paths, runtime, !scopedToSelectedGateway);
      stopBedrockRuntimeAdapterForUninstall(paths, runtime, scopedToSelectedGateway);
    } else if (step.name === "OpenShell resources") {
      if (
        !executeOpenShellResourceCleanup(
          paths,
          options,
          runtime,
          scopedToSelectedGateway,
          sandboxNames,
          managedHermesStateVolumes,
          teardownAuthority,
          false,
        )
      ) {
        return { ok: false };
      }
    } else if (step.name === "NemoClaw CLI") {
      const completion = completePortablePlan(
        ok,
        portableRuntimeCleanup,
        paths,
        options,
        runtime,
        scopedToSelectedGateway,
        sandboxNames,
        teardownAuthority,
      );
      if (!completion.ok) return completion;
      runNemoclawCliUninstallStep(
        paths,
        options,
        runtime,
        scopedToSelectedGateway,
        otherGatewayPorts,
      );
    } else if (step.name === "Docker resources") {
      if (externallySupervised) {
        runtime.log(
          "Kept Docker containers, images, and volumes used by the externally supervised gateway.",
        );
      } else if (dockerIsAvailable(runtime)) {
        removeDockerContainers(
          runtime,
          scopedToSelectedGateway
            ? options.gatewayName || resolveGatewayName(GATEWAY_PORT)
            : undefined,
        );
        if (scopedToSelectedGateway) {
          runtime.log("Sibling gateways remain; kept shared Docker images.");
        } else {
          removeDockerImages(runtime);
        }
        for (const action of step.actions)
          if (action.kind === "delete-docker-volume") removeDockerVolume(action.name, runtime);
      }
    } else if (step.name === "Model stores") {
      if (
        !removeHostModelStores(
          paths,
          options,
          runtime,
          scopedToSelectedGateway,
          failedManagedLlamaStateDirs.length > 0,
        )
      ) {
        ok = false;
      }
    } else if (step.name === "State and binaries") {
      removeManagedSwap(paths, runtime, scopedToSelectedGateway);
      if (!scopedToSelectedGateway) {
        for (const pattern of paths.runtimeTempGlobs) removeGlob(pattern, runtime);
        if (preserveSharedOpenShell) {
          runtime.log(binaryKeepMessage);
        } else if (GATEWAY_PORT !== DEFAULT_GATEWAY_PORT) {
          runtime.log("Keeping OpenShell binaries used by the default gateway service.");
        } else if (runtime.platform === "darwin") {
          reportRetainedMacOsOpenShell(runtime);
        } else {
          for (const target of paths.openshellInstallPaths)
            removeFileWithOptionalSudo(target, runtime);
        }
      } else {
        runtime.log("Sibling gateways remain; kept shared runtime files and OpenShell binaries.");
      }
      const sharedRoot = path.dirname(paths.managedSwapMarkerPath);
      const selectedIsDefault = path.resolve(paths.nemoclawStateDir) === path.resolve(sharedRoot);
      if (scopedToSelectedGateway && selectedIsDefault && sharedRegistryMustBePreserved) {
        if (!options.keepOpenShell && !externallySupervised)
          removePath(paths.selectedGatewayLocalStateDir, runtime);
        else
          runtime.log(
            externallySupervised
              ? "Keeping OpenShell gateway configuration used by the externally supervised gateway."
              : "Keeping OpenShell gateway configuration as requested.",
          );
        runtime.log(
          "Legacy sibling gateway rows remain; kept the shared default-root state for their recovery.",
        );
        runtime.log("Sibling gateways remain; kept shared OpenShell and NemoClaw config.");
        continue;
      }
      if (
        !removePathExcept(
          paths.nemoclawStateDir,
          [
            ...preserveUnderStateDir,
            ...portableStateEntries,
            ...failedManagedLlamaStateDirs.flatMap((stateDir) => {
              const relative = path.relative(paths.nemoclawStateDir, stateDir);
              return relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
                ? [relative.split(path.sep)[0]!]
                : [];
            }),
            ...(selectedIsDefault
              ? [GATEWAYS_SUBDIR, path.basename(paths.managedSwapMarkerPath)]
              : []),
            ...(scopedToSelectedGateway && selectedIsDefault ? ["source"] : []),
            ...(scopedToSelectedGateway
              ? scopedStatePreservationEntries(paths.nemoclawStateDir, selectedIsDefault)
              : []),
          ],
          runtime,
        )
      )
        ok = false;
      if (scopedToSelectedGateway) {
        if (!options.keepOpenShell && !externallySupervised)
          removePath(paths.selectedGatewayLocalStateDir, runtime);
        else
          runtime.log(
            externallySupervised
              ? "Keeping OpenShell gateway configuration used by the externally supervised gateway."
              : "Keeping OpenShell gateway configuration as requested.",
          );
        if (GATEWAY_PORT === DEFAULT_GATEWAY_PORT && !options.keepOpenShell) {
          const envCleanup = removeNemoclawOpenShellGatewayEnv(paths, runtime);
          if (!envCleanup.ok) ok = false;
        }
        runtime.log("Sibling gateways remain; kept shared OpenShell and NemoClaw config.");
      } else {
        if (!preserveSharedOpenShell) removePath(paths.gatewayLocalStateDir, runtime);
        if (preserveSharedOpenShell) runtime.log(configKeepMessage);
        else if (GATEWAY_PORT === DEFAULT_GATEWAY_PORT) {
          const envCleanup = removeNemoclawOpenShellGatewayEnv(paths, runtime);
          if (!envCleanup.ok) ok = false;
          if (envCleanup.keptUnrelatedContent) {
            if (!removePathExcept(paths.openshellConfigDir, ["gateway.env"], runtime)) ok = false;
          } else {
            removePath(paths.openshellConfigDir, runtime);
          }
        } else runtime.log("Keeping OpenShell configuration used by the default gateway service.");
        if (portableRuntimeCleanup) {
          const portableConfigDir = path.join(paths.nemoclawConfigDir, "portable");
          const portableConfigEntries = ["containers.conf", ...portableRetirementEntries.config];
          if (
            portableConfigEntries.some((entry) =>
              runtime.existsSync(path.join(portableConfigDir, entry)),
            ) &&
            !removePathExcept(portableConfigDir, portableConfigEntries, runtime)
          )
            ok = false;
          if (!removePathExcept(paths.nemoclawConfigDir, ["portable"], runtime)) ok = false;
        } else {
          removePath(paths.nemoclawConfigDir, runtime);
        }
      }
    }
  }
  return { ok };
}

function completePortablePlan(
  ok: boolean,
  portable: boolean,
  paths: UninstallPaths,
  options: UninstallRunOptions,
  runtime: UninstallRuntime,
  scoped: boolean,
  sandboxNames: readonly string[],
  authority: GatewayOwner,
): { ok: boolean } {
  if (!portable) return { ok: true };
  if (!ok) return { ok };
  if (
    !executeOpenShellResourceCleanup(
      paths,
      options,
      runtime,
      scoped,
      sandboxNames,
      [],
      authority,
      true,
    )
  )
    return { ok: false };
  runtime.log(
    "Kept secret-free portable cleanup evidence for exact retry and lifecycle reconciliation.",
  );
  return { ok };
}

class IncompleteHostGatewayCleanupError extends Error {}
class IncompleteBedrockRuntimeAdapterCleanupError extends Error {}

function stopHostGatewayProcessesForUninstall(
  runtime: UninstallRuntime,
  options: StopHostGatewayOptions,
  requireComplete = false,
): void {
  const result = stopHostGatewayProcesses(
    {
      run: runtime.run,
      kill: runtime.kill,
      env: runtime.env,
      log: runtime.log,
      warn: runtime.warn,
      commandExists: runtime.commandExists,
      isPortFree: runtime.isPortFree,
      readProcessEnvironment: runtime.readProcessEnvironment,
    },
    options,
  );
  if (options.scopedGatewayStop && (result.ownershipFailures?.length || result.failed.length)) {
    runtime.error(
      "Cannot prove ownership of or stop the selected host gateway process; retaining its runtime evidence.",
    );
    throw new IncompleteHostGatewayCleanupError();
  }
  if (!requireComplete && !runtime.requireCompleteGatewayProcessCleanup) return;
  if (result.failed.length === 0 && result.orphanScanComplete !== false) return;
  runtime.error("Cannot continue uninstall because host gateway process cleanup did not complete.");
  throw new IncompleteHostGatewayCleanupError();
}

export function buildRunPlan(
  options: UninstallRunOptions,
  deps: UninstallRunDeps = {},
): { paths: UninstallPaths; plan: UninstallPlan } {
  const env = { ...process.env, ...(deps.env ?? {}) };
  const home = env.HOME || os.homedir();
  const paths = {
    ...defaultUninstallPaths({
      home,
      repoRoot: path.resolve(__dirname, "..", "..", ".."),
      tmpDir: env.TMPDIR,
      xdgBinHome: env.XDG_BIN_HOME,
    }),
    openshellConfigDir: path.join(getOpenShellUserConfigHome(home, env), "openshell"),
  };
  const gatewayName = options.gatewayName || resolveGatewayName(GATEWAY_PORT);
  const plan = buildUninstallPlan(paths, {
    deleteModels: options.deleteModels,
    gatewayName,
    keepOpenShell: options.keepOpenShell,
    shim: classifyShimPath(paths.nemoclawShimPath, deps.fs),
  });
  return { paths, plan };
}

export function runUninstallPlan(
  options: UninstallRunOptions,
  deps: UninstallRunDeps = {},
): UninstallRunOutcome {
  const runtime = buildRuntime(deps);
  const expectedGatewayName = resolveGatewayName(GATEWAY_PORT);
  if (options.gatewayName && options.gatewayName !== expectedGatewayName) {
    runtime.error(
      `Refusing to uninstall gateway '${options.gatewayName}': NEMOCLAW_GATEWAY_PORT=${String(GATEWAY_PORT)} selects '${expectedGatewayName}'.`,
    );
    const { plan } = buildRunPlan(options, { ...deps, env: runtime.env });
    return { exitCode: 1, plan };
  }
  const resolvedOptions = { ...options, gatewayName: expectedGatewayName };
  const { paths, plan } = buildRunPlan(resolvedOptions, { ...deps, env: runtime.env });
  if (managedDistributedVllmStateRootStatus(paths, runtime) === "unsafe") {
    return { exitCode: 1, plan };
  }
  let teardownAuthority: GatewayOwner;
  try {
    teardownAuthority = runtime.resolveGatewayTeardownAuthority(
      { gatewayName: expectedGatewayName, gatewayPort: GATEWAY_PORT },
      { allowMissingPackagedServiceTeardown: true, env: runtime.env },
    );
  } catch (error) {
    runtime.error(
      `Refusing gateway teardown because lifecycle authority could not be revalidated: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { exitCode: 1, plan };
  }
  const externallySupervised = isExternallySupervised(teardownAuthority);
  let gatewayInspection = inspectOtherGatewayEnvironments(paths, runtime);
  let { otherGatewayEnvironmentsRemain: scopedToSelectedGateway } = gatewayInspection;
  let selectedSandboxState: SelectedRegistrySandboxState = {
    managedHermesStateVolumes: [],
    names: [],
  };
  if (scopedToSelectedGateway) {
    try {
      selectedSandboxState = selectedRegistrySandboxState(paths, runtime);
    } catch (error) {
      runtime.error(error instanceof Error ? error.message : String(error));
      return { exitCode: 1, plan };
    }
  }
  printBanner(runtime, scopedToSelectedGateway, expectedGatewayName);
  reportOtherGatewayEnvironments(gatewayInspection, runtime);
  if (!confirm(resolvedOptions, runtime, paths, scopedToSelectedGateway)) {
    return { exitCode: 0, plan };
  }
  if (!scopedToSelectedGateway) {
    const boundaryInspection = inspectOtherGatewayEnvironments(paths, runtime);
    if (boundaryInspection.otherGatewayEnvironmentsRemain) {
      gatewayInspection = boundaryInspection;
      scopedToSelectedGateway = true;
      try {
        selectedSandboxState = selectedRegistrySandboxState(paths, runtime);
      } catch (error) {
        runtime.error(error instanceof Error ? error.message : String(error));
        return { exitCode: 1, plan };
      }
      runtime.warn(
        "A sibling gateway appeared during uninstall preparation; switching to gateway-scoped cleanup.",
      );
      reportOtherGatewayEnvironments(boundaryInspection, runtime);
    }
  }
  if (!scopedToSelectedGateway) {
    try {
      selectedSandboxState = selectedRegistrySandboxState(paths, runtime);
    } catch (error) {
      runtime.error(error instanceof Error ? error.message : String(error));
      return { exitCode: 1, plan };
    }
  }
  let portableRuntimeCleanup = false;
  let portableRetirementEntries = { config: [] as string[], stateRoot: [] as string[] };
  if (!scopedToSelectedGateway && !resolvedOptions.keepOpenShell && !externallySupervised) {
    try {
      portableRuntimeCleanup = runtime.hasPortableRuntimeCleanup(
        path.dirname(paths.managedSwapMarkerPath),
      );
      if (portableRuntimeCleanup)
        portableRetirementEntries = portableRetirementPreservationEntries(
          path.dirname(paths.managedSwapMarkerPath),
        );
    } catch (error) {
      runtime.error(`Portable lifecycle state is unsafe: ${formatError(error)}`);
      return { exitCode: 1, plan };
    }
  }
  if (!portableRuntimeCleanup && !runtime.commandExists("openshell")) {
    runtime.error(OPENSHELL_COMMAND_MISSING_ERROR);
    return { exitCode: 1, plan };
  }
  const preserveUnderStateDir = resolvePreserveSet(paths, resolvedOptions, runtime);
  let ok = false;
  try {
    ({ ok } = executePlan(
      plan,
      paths,
      resolvedOptions,
      runtime,
      preserveUnderStateDir,
      scopedToSelectedGateway,
      gatewayInspection.sharedRegistryMustBePreserved,
      gatewayInspection.otherGatewayPorts,
      selectedSandboxState.names,
      selectedSandboxState.managedHermesStateVolumes,
      teardownAuthority,
      portableRuntimeCleanup,
      portableRetirementEntries,
    ));
  } catch (error) {
    if (
      !(error instanceof IncompleteHostGatewayCleanupError) &&
      !(error instanceof IncompleteBedrockRuntimeAdapterCleanupError)
    ) {
      throw error;
    }
  }
  if (ok) {
    printBye(runtime);
  } else {
    runtime.error(
      "Uninstall completed with errors. Some state may remain on disk; see warnings above.",
    );
  }
  return { exitCode: ok ? 0 : 1, otherGatewayEnvironmentsRemain: scopedToSelectedGateway, plan };
}

/** Production entry: hold the host-wide portable authority fence through the sync plan. */
export async function runUninstallPlanProduction(
  options: UninstallRunOptions,
  deps: UninstallRunDeps = {},
): Promise<UninstallRunOutcome> {
  const env = { ...process.env, ...(deps.env ?? {}) };
  const home = env.HOME || os.homedir();
  try {
    return await (deps.withPortableHostFence ?? withPortableHostFence)(home, () => {
      return runUninstallPlan(options, { ...deps, env });
    });
  } catch (error) {
    (deps.error ?? ((message: string) => console.error(message)))(
      `Uninstall could not acquire or release portable host authority: ${formatError(error)}`,
    );
    return { exitCode: 1, plan: buildRunPlan(options, { ...deps, env }).plan };
  }
}
