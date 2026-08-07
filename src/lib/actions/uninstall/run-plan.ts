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
  defaultUninstallPaths,
  NEMOCLAW_OLLAMA_MODELS,
  NEMOCLAW_PROVIDERS,
  type UninstallPaths,
} from "../../domain/uninstall/paths";
import { buildUninstallPlan, type UninstallPlan } from "../../domain/uninstall/plan";
import {
  cleanupManagedLlamaCppRuntimeForSandbox,
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
  getNemoclawOpenShellGatewayUserServicePath,
  getOpenShellUserConfigHome,
  NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE,
  NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER_LINE,
} from "../../onboard/docker-driver-gateway-service";
import { resolveGatewayName, resolveGatewayPortFromName } from "../../onboard/gateway-binding";
import { isExternallySupervised } from "../../onboard/gateway-ownership";
import {
  type GatewayTeardownAuthorityResolver,
  resolveGatewayTeardownAuthority,
} from "../../onboard/gateway-teardown-authority";
import {
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
} from "../../state/gateway-registry";
import { stopHermesForwardWatchers } from "./hermes-forward-watcher-cleanup";
import {
  stopHttpsPinRuntimeAdapter,
  stopOpenRouterRuntimeAdapter,
} from "./openrouter-runtime-adapter-cleanup";
import { classifyShimPath, type FileSystemDeps } from "./plan";

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
  isTty?: boolean;
  kill?: (pid: number, signal?: NodeJS.Signals | number) => boolean;
  log?: (message: string) => void;
  openRegularFile?: typeof openRegularFileNoFollow;
  platform?: NodeJS.Platform;
  readProcessArgv?: (pid: number) => readonly string[] | null;
  readLine?: () => string | null;
  requireCompleteGatewayProcessCleanup?: boolean;
  resolveGatewayTeardownAuthority?: GatewayTeardownAuthorityResolver;
  retainedGatewayPorts?: readonly number[];
  rmSync?: typeof fs.rmSync;
  run?: (command: string, args: string[], options?: SpawnSyncOptions) => RunResult;
  runDocker?: (args: string[], options?: SpawnSyncOptions) => RunResult;
  runDualStationRuntimeCleanup?: (receiptPath: string, options?: SpawnSyncOptions) => RunResult;
  runLocalModelRuntimeCleanup?: (deleteModels: boolean, options?: SpawnSyncOptions) => RunResult;
  runManagedLlamaCppRuntimeCleanup?: (sandboxName: string, gatewayPort: number) => RunResult;
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
): void {
  if (!deps.existsSync(target)) return;
  deps.rmSync(target, { force: true, recursive: true });
  deps.log(`Removed ${target}`);
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
  isTty: boolean;
  kill: (pid: number, signal?: NodeJS.Signals | number) => boolean;
  log: (message: string) => void;
  openRegularFile: typeof openRegularFileNoFollow;
  platform: NodeJS.Platform;
  readProcessArgv: ((pid: number) => readonly string[] | null) | undefined;
  readLine: () => string | null;
  requireCompleteGatewayProcessCleanup: boolean;
  resolveGatewayTeardownAuthority: GatewayTeardownAuthorityResolver;
  retainedGatewayPorts: readonly number[];
  rmSync: typeof fs.rmSync;
  run: (command: string, args: string[], options?: SpawnSyncOptions) => RunResult;
  runDocker: (args: string[], options?: SpawnSyncOptions) => RunResult;
  runDualStationRuntimeCleanup: (receiptPath: string, options?: SpawnSyncOptions) => RunResult;
  runLocalModelRuntimeCleanup: (deleteModels: boolean, options?: SpawnSyncOptions) => RunResult;
  runManagedLlamaCppRuntimeCleanup: (sandboxName: string, gatewayPort: number) => RunResult;
  warn: (message: string) => void;
}

function buildRuntime(deps: UninstallRunDeps): UninstallRuntime {
  const env = { ...process.env, ...(deps.env ?? {}) };
  return {
    commandExists: deps.commandExists ?? ((command) => defaultCommandExists(command, env)),
    env,
    error: deps.error ?? ((message) => console.error(message)),
    existsSync: deps.existsSync ?? ((target) => fs.existsSync(target)),
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
    runLocalModelRuntimeCleanup:
      deps.runLocalModelRuntimeCleanup ??
      ((deleteModels, options = {}) =>
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
            deleteModels ? "--delete-models" : "--keep-models",
          ],
          options,
        )),
    runManagedLlamaCppRuntimeCleanup:
      deps.runManagedLlamaCppRuntimeCleanup ??
      ((sandboxName, gatewayPort) => {
        const result = cleanupManagedLlamaCppRuntimeForSandbox(sandboxName, {
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
    warn: deps.error ?? ((message) => console.warn(message)),
  };
}

function runtimeBranding(runtime: UninstallRuntime): AgentBranding {
  return getAgentBranding(runtime.env.NEMOCLAW_AGENT);
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
  runtime.log(
    options.deleteModels
      ? `  · Ollama models: ${NEMOCLAW_OLLAMA_MODELS.join(" ")}`
      : "  · Ollama models: kept",
  );
  runtime.log("  · Shared Hugging Face model cache: kept");
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

function deleteSelectedGatewaySandbox(runtime: UninstallRuntime, sandboxName: string): boolean {
  const result = runtime.run("openshell", ["sandbox", "delete", sandboxName], {
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

function resolveOllamaProxyPort(runtime: UninstallRuntime): number {
  const raw = runtime.env.NEMOCLAW_OLLAMA_PROXY_PORT;
  if (raw === undefined || raw === "") return DEFAULT_OLLAMA_PROXY_PORT;
  const trimmed = String(raw).trim();
  if (!/^\d+$/.test(trimmed)) return DEFAULT_OLLAMA_PROXY_PORT;
  const parsed = Number(trimmed);
  if (parsed < 1024 || parsed > 65535) return DEFAULT_OLLAMA_PROXY_PORT;
  return parsed;
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

  if (!scanOrphans) {
    if (stopped.size === 0) runtime.log("No selected-gateway Ollama auth proxy found");
    return;
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
  const proxyPort = resolveOllamaProxyPort(runtime);
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

function removeNemoclawOpenShellGatewayUserService(runtime: UninstallRuntime): boolean {
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
): boolean {
  return options.keepOpenShell || externallySupervised || GATEWAY_PORT !== DEFAULT_GATEWAY_PORT
    ? true
    : removeNemoclawOpenShellGatewayUserService(runtime);
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

function selectedRegistrySandboxNames(paths: UninstallPaths, runtime: UninstallRuntime): string[] {
  const sharedRoot = path.dirname(paths.managedSwapMarkerPath);
  const home = path.dirname(sharedRoot);
  const registryFile = path.join(paths.nemoclawStateDir, "sandboxes.json");
  if (!pathEntryExists(registryFile, runtime)) return [];
  const registry = readGatewayRegistryFile(home, registryFile);
  if (!registry) return [];
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
  }
  return names.sort();
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

function pruneSelectedRowsFromSharedRegistry(
  paths: UninstallPaths,
  expectedSelectedNames: readonly string[],
  runtime: UninstallRuntime,
): boolean {
  const sharedRoot = path.dirname(paths.managedSwapMarkerPath);
  const home = path.dirname(sharedRoot);
  const registryFile = path.join(sharedRoot, "sandboxes.json");
  const lock = `${registryFile}.lock`;
  let acquired = false;
  try {
    assertGatewayStatePathSafe(home, lock);
    fs.mkdirSync(lock, { mode: 0o700 });
    acquired = true;

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
      `Removed ${String(selectedNames.length)} selected-gateway row(s) from the shared sandbox registry.`,
    );
    return true;
  } catch (error) {
    const detail =
      isErrnoException(error) && error.code === "EEXIST"
        ? `another state operation owns ${lock}`
        : error instanceof Error
          ? error.message
          : String(error);
    runtime.warn(`Could not safely update the shared sandbox registry: ${detail}`);
    return false;
  } finally {
    if (acquired) fs.rmSync(lock, { recursive: true, force: true });
  }
}

function removeOpenShellResources(
  options: UninstallRunOptions,
  runtime: UninstallRuntime,
  scopedToSelectedGateway: boolean,
  sandboxNames: readonly string[],
  externallySupervised: boolean,
): boolean {
  if (!runtime.commandExists("openshell")) {
    runtime.error(OPENSHELL_COMMAND_MISSING_ERROR);
    return false;
  }
  const gatewayLabel = options.gatewayName || resolveGatewayName(GATEWAY_PORT);
  if (scopedToSelectedGateway) {
    const selected = runtime.run("openshell", ["gateway", "select", gatewayLabel], {
      env: runtime.env,
      stdio: "ignore",
    });
    if (selected.status !== 0) {
      runtime.warn(
        `Could not select gateway '${gatewayLabel}'; refusing sandbox deletion so sibling gateways remain untouched.`,
      );
      return false;
    }
    let removedSelectedResources = true;
    for (const sandboxName of sandboxNames) {
      removedSelectedResources =
        deleteSelectedGatewaySandbox(runtime, sandboxName) && removedSelectedResources;
    }
    if (!removedSelectedResources) {
      runtime.warn("Selected gateway cleanup was incomplete; preserving its state for retry.");
      return false;
    }
    removedSelectedResources =
      removeGatewayRegistration(runtime, gatewayLabel, !externallySupervised) &&
      removedSelectedResources;
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

function removeNvmLeftovers(paths: UninstallPaths, runtime: UninstallRuntime): void {
  const nodeVersionsDir = path.join(paths.nvmDir, "versions", "node");
  if (!runtime.existsSync(nodeVersionsDir)) return;
  const stack = [nodeVersionsDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (target.endsWith(path.join("lib", "node_modules", "nemoclaw"))) {
          runtime.rmSync(target, { force: true, recursive: true });
          runtime.log(`Removed leftover nemoclaw module at ${target}`);
        } else {
          stack.push(target);
        }
      } else if (entry.isFile() && target.endsWith(path.join("bin", "nemoclaw"))) {
        runtime.rmSync(target, { force: true });
        runtime.log(`Removed leftover nemoclaw binary at ${target}`);
      }
    }
  }
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

  const shim = classifyShimPath(paths.nemoclawShimPath);
  if (shim.remove) removePath(paths.nemoclawShimPath, runtime);
  else if (shim.kind === "preserve-foreign-file") {
    runtime.warn(
      `Leaving ${paths.nemoclawShimPath} in place because it is not an installer-managed shim.`,
    );
  }
  // Also remove the sibling agent-alias shims (nemohermes, nemo-deepagents) the
  // installer creates; uninstall previously left them resolving on PATH (#6098).
  // The same classification guard preserves any non-managed file of that name.
  for (const alias of paths.agentAliasShimPaths) {
    const aliasShim = classifyShimPath(alias.path, {}, alias.binName);
    if (aliasShim.remove) removePath(alias.path, runtime);
    else if (aliasShim.kind === "preserve-foreign-file") {
      runtime.warn(`Leaving ${alias.path} in place because it is not an installer-managed shim.`);
    }
  }
  removeNvmLeftovers(paths, runtime);
  removeAliases(paths, runtime);
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
      `Could not inspect managed distributed vLLM rollback state: ${formatError(error)}`,
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
      `Managed distributed vLLM SSH binding exists without its ownership receipt at ${orphanBinding}. NemoClaw refused uninstall before making changes. Recover or remove that state explicitly, then retry.`,
    );
    return false;
  }
  if (receipts.length === 0) {
    removePath(apiKeyPath, runtime);
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

function removeHostLocalModelRuntimes(
  paths: UninstallPaths,
  deleteModels: boolean,
  runtime: UninstallRuntime,
): boolean {
  const sharedRoot = path.dirname(paths.managedSwapMarkerPath);
  const hasLlamaState = runtime.existsSync(path.join(sharedRoot, "managed-llama-cpp"));
  const hasManagedKey = runtime.existsSync(path.join(sharedRoot, MANAGED_VLLM_API_KEY_FILE));
  const hasDistributedReceipt = [
    MANAGED_CLUSTER_VLLM_RUNTIME_RECEIPT_FILE,
    DUAL_STATION_VLLM_RUNTIME_RECEIPT_FILE,
  ].some((name) => runtime.existsSync(path.join(sharedRoot, name)));
  if (!hasLlamaState && (!hasManagedKey || hasDistributedReceipt)) {
    return true;
  }
  const result = runtime.runLocalModelRuntimeCleanup(deleteModels, {
    env: runtime.env,
    stdio: "inherit",
  });
  if (result.status === 0) return true;
  runtime.error(
    "Host-local model cleanup did not complete. NemoClaw did not start the remaining uninstall steps. Resolve the reported ownership or Docker error and retry uninstall.",
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
      `Managed llama.cpp cleanup could not safely inventory gateway-scoped ownership state: ${formatError(error)}. NemoClaw did not start the remaining uninstall steps.`,
    );
    return null;
  }
}

function removeManagedLlamaCppRuntimes(
  runtime: UninstallRuntime,
  scopedToSelectedGateway: boolean,
): boolean {
  const targets = managedLlamaCppCleanupTargets(runtime, scopedToSelectedGateway);
  if (targets === null) return false;
  for (const target of targets) {
    const result = runtime.runManagedLlamaCppRuntimeCleanup(target.sandboxName, target.gatewayPort);
    for (const removed of splitNonEmptyLines(result.stdout)) runtime.log(`Removed ${removed}`);
    if (result.status !== 0) {
      runtime.error(
        `Managed llama.cpp cleanup for sandbox '${target.sandboxName}' on gateway port ${String(target.gatewayPort)} did not complete: ${result.stderr.trim() || "unknown cleanup error"}. NemoClaw did not start the remaining uninstall steps.`,
      );
      return false;
    }
    if (fs.lstatSync(target.stateDir, { throwIfNoEntry: false }) !== undefined) {
      runtime.error(
        `Managed llama.cpp cleanup for sandbox '${target.sandboxName}' on gateway port ${String(target.gatewayPort)} returned without retiring its ownership state. NemoClaw did not start the remaining uninstall steps.`,
      );
      return false;
    }
  }
  return true;
}

function removeManagedModelRuntimes(
  paths: UninstallPaths,
  deleteModels: boolean,
  runtime: UninstallRuntime,
  scopedToSelectedGateway: boolean,
): boolean {
  if (!removeManagedLlamaCppRuntimes(runtime, scopedToSelectedGateway)) return false;
  if (scopedToSelectedGateway) return true;
  if (!removeHostLocalModelRuntimes(paths, deleteModels, runtime)) return false;
  if (!removeManagedDistributedVllmRuntime(paths, runtime)) return false;
  if (!runtime.commandExists("docker")) return true;
  const inventory = runtime.runDocker(["ps", "-a", "--format", "{{.Names}}"], {
    env: runtime.env,
    timeout: 10_000,
  });
  if (inventory.status !== 0) {
    runtime.error(
      "Docker could not inventory reserved managed inference container names. NemoClaw refused the remaining uninstall steps so it cannot report incomplete cleanup as success.",
    );
    return false;
  }
  const residual = splitNonEmptyLines(inventory.stdout).find((name) =>
    MANAGED_INFERENCE_CONTAINER_NAME_PATTERN.test(name),
  );
  if (!residual) return true;
  runtime.error(
    `Managed inference container '${residual}' remains after ownership-aware cleanup. NemoClaw refused the remaining uninstall steps; restore its ownership state or remove it after manual review, then retry.`,
  );
  return false;
}

function removeDockerContainers(runtime: UninstallRuntime, gatewayName?: string): void {
  const result = runtime.runDocker(["ps", "-a", "--format", "{{.ID}} {{.Image}} {{.Names}}"], {
    env: runtime.env,
  });
  const ids = splitNonEmptyLines(result.stdout)
    .filter((line) => {
      const name = line.trim().split(/\s+/).at(-1) ?? "";
      if (!gatewayName) {
        if (MANAGED_INFERENCE_CONTAINER_NAME_PATTERN.test(name)) {
          return false;
        }
        return /openshell-cluster|openshell|openclaw|nemoclaw/i.test(line);
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
    .filter((line) => /openshell|openclaw|nemoclaw/i.test(line))
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

function removeOllamaModels(options: UninstallRunOptions, runtime: UninstallRuntime): void {
  if (!options.deleteModels) {
    runtime.log("Keeping Ollama models as requested.");
    return;
  }
  if (!runtime.commandExists("ollama")) {
    runtime.warn("ollama not found; skipping model cleanup.");
    return;
  }
  for (const model of NEMOCLAW_OLLAMA_MODELS) {
    if (runtime.run("ollama", ["rm", model], { env: runtime.env, stdio: "ignore" }).status === 0)
      runtime.log(`Removed Ollama model '${model}'`);
    else runtime.warn(`Ollama model '${model}' not found or already removed`);
  }
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
  runtime.log(
    `Other ${branding.display} gateway-port environments remain on this host and are outside this uninstall:`,
  );
  for (const port of inspection.otherGatewayPorts) {
    runtime.log(`  · gateway '${resolveGatewayName(port)}' on port ${String(port)}`);
  }
  if (inspection.unidentifiedOtherGateways) {
    runtime.log("  · one or more gateway environments whose port could not be read");
  }
  const [firstPort] = inspection.otherGatewayPorts;
  if (firstPort !== undefined) {
    runtime.log(
      `  Remove one of them: NEMOCLAW_GATEWAY_PORT=${String(firstPort)} ${branding.cli} uninstall`,
    );
  }
  runtime.log(`  Remove every gateway port: ${branding.cli} uninstall --all-gateway-ports`);
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

function executePlan(
  plan: UninstallPlan,
  paths: UninstallPaths,
  options: UninstallRunOptions,
  runtime: UninstallRuntime,
  preserveUnderStateDir: readonly string[],
  scopedToSelectedGateway: boolean,
  sharedRegistryMustBePreserved: boolean,
  sandboxNames: readonly string[],
  externallySupervised: boolean,
): { ok: boolean } {
  let ok = true;
  const branding = runtimeBranding(runtime);
  for (const [index, step] of plan.steps.entries()) {
    runtime.log(`[${index + 1}/${plan.steps.length}] ${planStepDisplayName(step.name, branding)}`);
    if (step.name === "Stopping services") {
      if (
        !removeManagedModelRuntimes(paths, options.deleteModels, runtime, scopedToSelectedGateway)
      ) {
        return { ok: false };
      }
      // #8220: a gateway-scoped uninstall still needs the selected OpenShell
      // gateway service running to delete its sandbox, so "OpenShell resources"
      // removes that unit after the sandbox delete succeeds.
      if (
        !scopedToSelectedGateway &&
        !removeManagedDefaultGatewayUserService(runtime, options, externallySupervised)
      ) {
        ok = false;
      }
      if (!scopedToSelectedGateway) {
        stopHelperServices(paths, runtime);
        removeGlob(paths.helperServiceGlob, runtime);
        if (options.keepOpenShell) {
          runtime.log(
            "Keeping OpenShell gateway service, configuration, and processes as requested.",
          );
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
    } else if (step.name === "OpenShell resources") {
      if (
        !removeOpenShellResources(
          options,
          runtime,
          scopedToSelectedGateway,
          sandboxNames,
          externallySupervised,
        )
      ) {
        return { ok: false };
      }
      if (scopedToSelectedGateway && !options.keepOpenShell && !externallySupervised) {
        if (!removeManagedDefaultGatewayUserService(runtime, options, externallySupervised)) {
          ok = false;
        }
        stopHostGatewayProcessesForUninstall(runtime, {
          gatewayBin: runtime.env.NEMOCLAW_OPENSHELL_GATEWAY_BIN,
          logNoProcesses: true,
          openShellGatewayName: options.gatewayName || resolveGatewayName(GATEWAY_PORT),
          openShellGatewayPort: GATEWAY_PORT,
          preserveRuntimeFilesOnNonMatching: true,
          stateDir: paths.selectedGatewayLocalStateDir,
        });
      } else if (scopedToSelectedGateway && externallySupervised) {
        runtime.log("Kept the externally supervised OpenShell gateway process running.");
      }
    } else if (step.name === "NemoClaw CLI") {
      if (scopedToSelectedGateway) {
        runtime.log("Sibling gateways remain; kept the shared NemoClaw CLI and shell shims.");
      } else {
        removeNemoclawCli(paths, runtime);
      }
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
    } else if (step.name === "Ollama models") {
      if (scopedToSelectedGateway) {
        runtime.log("Sibling gateways remain; kept host-shared Ollama models.");
      } else {
        removeOllamaModels(options, runtime);
      }
    } else if (step.name === "State and binaries") {
      removeManagedSwap(paths, runtime, scopedToSelectedGateway);
      if (!scopedToSelectedGateway) {
        for (const pattern of paths.runtimeTempGlobs) removeGlob(pattern, runtime);
        if (options.keepOpenShell || externallySupervised) {
          runtime.log(
            externallySupervised
              ? "Keeping OpenShell binaries used by the externally supervised gateway."
              : "Keeping OpenShell binaries as requested.",
          );
        } else if (GATEWAY_PORT !== DEFAULT_GATEWAY_PORT) {
          runtime.log("Keeping OpenShell binaries used by the default gateway service.");
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
        if (
          !preserveUnderStateDir.includes("sandboxes.json") &&
          !pruneSelectedRowsFromSharedRegistry(paths, sandboxNames, runtime)
        ) {
          return { ok: false };
        }
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
            ...(selectedIsDefault
              ? [GATEWAYS_SUBDIR, path.basename(paths.managedSwapMarkerPath)]
              : []),
            ...(scopedToSelectedGateway && selectedIsDefault ? ["source"] : []),
            ...(scopedToSelectedGateway
              ? [
                  ...HTTPS_PIN_RUNTIME_ADAPTER_STATE_ENTRIES,
                  MANAGED_CLUSTER_VLLM_RUNTIME_RECEIPT_FILE,
                  ...managedClusterBindingStateEntries(paths.nemoclawStateDir),
                  DUAL_STATION_VLLM_RUNTIME_RECEIPT_FILE,
                  `${DUAL_STATION_VLLM_RUNTIME_RECEIPT_FILE}.ssh-binding`,
                  MANAGED_VLLM_API_KEY_FILE,
                ]
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
        if (!options.keepOpenShell && !externallySupervised)
          removePath(paths.gatewayLocalStateDir, runtime);
        if (options.keepOpenShell || externallySupervised)
          runtime.log(
            externallySupervised
              ? "Keeping OpenShell gateway configuration used by the externally supervised gateway."
              : "Keeping OpenShell gateway configuration as requested.",
          );
        else if (GATEWAY_PORT === DEFAULT_GATEWAY_PORT) {
          const envCleanup = removeNemoclawOpenShellGatewayEnv(paths, runtime);
          if (!envCleanup.ok) ok = false;
          if (envCleanup.keptUnrelatedContent) {
            if (!removePathExcept(paths.openshellConfigDir, ["gateway.env"], runtime)) ok = false;
          } else {
            removePath(paths.openshellConfigDir, runtime);
          }
        } else runtime.log("Keeping OpenShell configuration used by the default gateway service.");
        removePath(paths.nemoclawConfigDir, runtime);
      }
    }
  }
  return { ok };
}

class IncompleteHostGatewayCleanupError extends Error {}

function stopHostGatewayProcessesForUninstall(
  runtime: UninstallRuntime,
  options: StopHostGatewayOptions,
): void {
  const result = stopHostGatewayProcesses(
    {
      run: runtime.run,
      kill: runtime.kill,
      env: runtime.env,
      log: runtime.log,
      warn: runtime.warn,
      commandExists: runtime.commandExists,
    },
    options,
  );
  if (!runtime.requireCompleteGatewayProcessCleanup) return;
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
  let externallySupervised: boolean;
  try {
    externallySupervised = isExternallySupervised(
      runtime.resolveGatewayTeardownAuthority(
        { gatewayName: expectedGatewayName, gatewayPort: GATEWAY_PORT },
        { allowMissingPackagedServiceTeardown: true, env: runtime.env },
      ),
    );
  } catch (error) {
    runtime.error(
      `Refusing gateway teardown because lifecycle authority could not be revalidated: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { exitCode: 1, plan };
  }
  let gatewayInspection = inspectOtherGatewayEnvironments(paths, runtime);
  let { otherGatewayEnvironmentsRemain: scopedToSelectedGateway } = gatewayInspection;
  let sandboxNames: string[] = [];
  if (scopedToSelectedGateway) {
    try {
      sandboxNames = selectedRegistrySandboxNames(paths, runtime);
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
        sandboxNames = selectedRegistrySandboxNames(paths, runtime);
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
  if (!runtime.commandExists("openshell")) {
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
      sandboxNames,
      externallySupervised,
    ));
  } catch (error) {
    if (!(error instanceof IncompleteHostGatewayCleanupError)) throw error;
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
