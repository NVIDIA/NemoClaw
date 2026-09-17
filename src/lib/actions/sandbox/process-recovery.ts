// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import { stripAnsi } from "../../adapters/openshell/client";
import { createCliOpenShellSandboxCommandExecutor } from "../../adapters/openshell/sandbox-command-cli";
import type {
  OpenShellSandboxBufferedCommandCompletion,
  OpenShellSandboxBufferedCommandExecutor,
} from "../../adapters/openshell/sandbox-command";
import {
  namedOpenShellGateway,
  selectedOpenShellGateway,
} from "../../adapters/openshell/sandbox-observer";
import {
  buildOpenShellRuntimeSelectionEnv,
  type OpenShellRuntimeSelection,
} from "../../adapters/openshell/runtime";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "../../adapters/openshell/timeouts";
import {
  type CommandTransportDependencies,
  DEFAULT_SANDBOX_EXEC_TIMEOUT_MS,
  executeSandboxCommandTransport,
  executeSandboxExecCommandTransport,
  type SandboxCommandResult,
  type SandboxExecCommandOptions,
} from "../../adapters/sandbox/command-transport";
import * as agentRuntime from "../../agent/runtime";
import { G, R } from "../../cli/terminal-style";
import { sleepSeconds, waitUntilAsync } from "../../core/wait";
import { resolveRegisteredRuntimeProvider } from "../../onboard/runtime-provider/selection";
import { ROOT, shellQuote } from "../../runner";
import {
  isDirectSandboxContainerNotFoundError,
  isDirectSandboxFallbackUnavailableError,
  isPinnedSandboxContainerIdentityChangedError,
  executePrivilegedSandboxCommand as executeProviderPrivilegedSandboxCommand,
  resolvePrivilegedSandboxTarget,
  withPrivilegedSandboxExecutionLease,
} from "../../sandbox/privileged-exec";
import { withSandboxLifecycleLock } from "./lifecycle/lock";
import * as registry from "../../state/registry";
import { buildSubprocessEnv } from "../../subprocess-env";
import {
  ensureHermesDashboardPortForwardIfEnabled,
  ensureSandboxPortForward,
  createHermesPortableForwardRecoveryInput,
  describeSandboxForwardListener,
  HermesPortableForwardRecoveryError,
  prepareHermesPortableLaunchForwards,
  recoverDeclaredAgentForwardPorts,
  recoverHermesPortableLaunchForwards,
  recoverMessagingHostForward,
  resolveSandboxDashboardPort,
  resolveSandboxHealthProbeUrl,
  nonOwnedForwardListenerRefusal,
  verifyHermesPortableLaunchForwards,
  type HermesPortableForwardRecoveryFailure,
  type HermesPortableForwardRecoveryContext,
  type HermesPortableForwardRecoveryInput,
  type HermesPortableForwardRecoveryResult,
  type HermesPortableForwardRecoveryTimingEvidence,
  type HermesPortableForwardVerificationResult,
  type OpenShellForwardObservationAdapterFactory,
  type PreparedHermesPortableForwardRecovery,
  type SandboxForwardListener,
} from "./forward-recovery";
import {
  type GatewayRestartFailureLayer,
  type GatewayRestartResult,
  gatewayTerminalRepairLines,
  isGatewayTerminalRepairLayer,
  MANAGED_CONTROL_IDENTITY_CHANGED_MARKER,
  parseManagedGatewayControlCompletion,
  printGatewayRestartFailure,
  type RestartSandboxGatewayOptions as BaseRestartSandboxGatewayOptions,
  restartSandboxGatewayWithDeps,
  sandboxAgentName,
} from "./gateway-restart";
import { printGatewayWedgeDiagnostics } from "./gateway-wedge-diagnostics";
import {
  buildSandboxExecMarkedCommand,
  extractSandboxExecCommandStdout,
} from "./sandbox-exec-output";
export type { SandboxForwardHealth } from "./forward-recovery";
export { resolveSandboxDashboardPort, resolveSandboxLaunchForwardPorts } from "./forward-recovery";
export {
  createHermesPortableForwardRecoveryInput,
  HermesPortableForwardRecoveryError,
  prepareHermesPortableLaunchForwards,
  recoverHermesPortableLaunchForwards,
  verifyHermesPortableLaunchForwards,
};
export type {
  HermesPortableForwardRecoveryContext,
  HermesPortableForwardRecoveryFailure,
  HermesPortableForwardRecoveryInput,
  HermesPortableForwardRecoveryResult,
  HermesPortableForwardRecoveryTimingEvidence,
  HermesPortableForwardVerificationResult,
  PreparedHermesPortableForwardRecovery,
};

export type {
  GatewayRestartDeps,
  GatewayRestartFailureLayer,
  GatewayRestartResult,
  ManagedGatewayControlCompletion,
} from "./gateway-restart";

export type RestartSandboxGatewayOptions = BaseRestartSandboxGatewayOptions & {
  runtimeSelection?: OpenShellRuntimeSelection;
};

export { buildSandboxExecMarkedCommand } from "./sandbox-exec-output";

export type { SandboxCommandResult, SandboxExecCommandOptions };

export type SandboxCommandExecutionOptions = {
  runtimeSelection?: OpenShellRuntimeSelection;
  timeout?: number;
};

export type SandboxExecCommandExecutionOptions = SandboxExecCommandOptions & {
  runtimeSelection?: OpenShellRuntimeSelection;
};

type ProcessRecoveryProbeTiming = {
  measure<T>(stage: "processes" | "forward", operation: () => T): T;
  measureAsync<T>(stage: "processes" | "forward", operation: () => Promise<T>): Promise<T>;
  setForwardAction(action: "skipped" | "verified" | "restored" | "failed"): void;
};

type Awaitable<T> = T | Promise<T>;

function commandTransportDependencies(): CommandTransportDependencies {
  return {
    buildSandboxExecMarkedCommand,
    buildSubprocessEnv,
    executePrivilegedSandboxCommand: executeProviderPrivilegedSandboxCommand,
    extractSandboxExecCommandStdout,
    commandExecutor: createCliOpenShellSandboxCommandExecutor({
      hostCwd: ROOT,
    }),
    isDirectSandboxFallbackUnavailableError,
  };
}

type AuxiliaryRecoveryResult = {
  label: string;
  recovered: boolean | null;
};

type ManagedGatewaySupervisorActionResult = SandboxCommandResult & {
  readonly portableSupervisor?: true;
  readonly managedContainerDiscoveryUnavailable?: true;
  readonly managedControlRestartingContainerId?: string;
};

const MANAGED_GATEWAY_CONTROL_PATH = "/usr/local/bin/nemoclaw-gateway-control";
const MANAGED_CONTROL_TRANSITION_MAX_ATTEMPTS = 11;
const MANAGED_CONTAINER_DISCOVERY_MAX_ATTEMPTS = 21;
const MANAGED_CONTROL_RECOVERY_DEADLINE_MS = 210_000;
const DOCKER_CONTAINER_RESTARTING_ERROR =
  /^Error response from daemon: Container ([0-9a-f]{64}) is restarting, wait until the container is running$/;

function auxiliaryRecoveryFailureDetail(results: AuxiliaryRecoveryResult[]): string | null {
  const failed = results
    .filter((result) => result.recovered === false)
    .map((result) => result.label);
  if (failed.length === 0) return null;
  return `${failed.join(", ")} could not be re-established`;
}

function anyAuxiliaryRecovered(results: AuxiliaryRecoveryResult[]): boolean {
  return results.some((result) => result.recovered === true);
}

function getSandboxHealthProbeUrl(sandboxName: string): string {
  return resolveSandboxHealthProbeUrl(sandboxName);
}

/**
 * Run a command inside the sandbox via SSH and return { status, stdout, stderr }.
 * Returns null if SSH config cannot be obtained.
 */
export async function executeSandboxCommand(
  sandboxName: string,
  command: string,
  timeoutOrOptions: number | SandboxCommandExecutionOptions = DEFAULT_SANDBOX_EXEC_TIMEOUT_MS,
): Promise<SandboxCommandResult | null> {
  const timeout =
    typeof timeoutOrOptions === "number"
      ? timeoutOrOptions
      : (timeoutOrOptions.timeout ?? DEFAULT_SANDBOX_EXEC_TIMEOUT_MS);
  const runtimeSelection =
    typeof timeoutOrOptions === "number" ? undefined : timeoutOrOptions.runtimeSelection;
  const runtimeEnv = runtimeSelection
    ? buildOpenShellRuntimeSelectionEnv(buildSubprocessEnv(), runtimeSelection)
    : undefined;
  return await executeSandboxCommandTransport(
    commandTransportDependencies(),
    sandboxName,
    command,
    timeout,
    {
      ...(runtimeSelection ? { gatewayName: runtimeSelection.gatewayName } : {}),
      runtimeEnv,
    },
  );
}

/** Run one root controller argv against the registry-pinned direct container. */
export function executePrivilegedSandboxCommand(
  sandboxName: string,
  command: readonly string[],
  timeout: number,
): SandboxCommandResult | null {
  return withPrivilegedSandboxExecutionLease(
    sandboxName,
    "sandbox process recovery controller",
    () => {
      const result = executeProviderPrivilegedSandboxCommand(sandboxName, command, {
        sanitizeEnvironment: true,
        timeout,
      });
      if (result.error) return null;
      return {
        status: result.status ?? 1,
        stdout: result.stdout.toString("utf8"),
        stderr: result.stderr.toString("utf8"),
      };
    },
  );
}

export async function executeSandboxExecCommand(
  sandboxName: string,
  command: string,
  timeout = DEFAULT_SANDBOX_EXEC_TIMEOUT_MS,
  options: SandboxExecCommandExecutionOptions = {},
): Promise<SandboxCommandResult | null> {
  const { runtimeSelection, ...transportOptions } = options;
  const runtimeEnv = runtimeSelection
    ? buildOpenShellRuntimeSelectionEnv(buildSubprocessEnv(), runtimeSelection)
    : options.runtimeEnv;
  return executeSandboxExecCommandTransport(
    commandTransportDependencies(),
    sandboxName,
    command,
    timeout,
    {
      ...transportOptions,
      ...(runtimeSelection
        ? {
            localDockerFallbackPolicy: "never",
            gatewayName: runtimeSelection.gatewayName,
          }
        : {}),
      ...(runtimeEnv ? { runtimeEnv } : {}),
    },
  );
}

function executeGatewaySupervisorActionPinned(
  sandboxName: string,
  action: "restart" | "recover" | "probe",
  timeout: number,
): ManagedGatewaySupervisorActionResult | null {
  const nonce = randomBytes(32).toString("hex");
  try {
    return withPrivilegedSandboxExecutionLease(sandboxName, `gateway supervisor ${action}`, () => {
      const targetContainerId = resolvePrivilegedSandboxTarget(sandboxName).resourceHandle;
      const result = executeProviderPrivilegedSandboxCommand(
        sandboxName,
        [MANAGED_GATEWAY_CONTROL_PATH, action, nonce],
        {
          sanitizeEnvironment: true,
          expectedResourceHandle: targetContainerId,
          timeout,
        },
      );
      const status = result.status ?? 1;
      const stdout = result.stdout.toString("utf8").trim();
      let stderr = result.stderr.toString("utf8").trim();
      if (result.error) return null;
      const restartingContainerMatch = stderr.match(DOCKER_CONTAINER_RESTARTING_ERROR);
      const managedControlRestartingContainerId =
        status === 1 &&
        stdout === "" &&
        restartingContainerMatch?.[1] !== undefined &&
        restartingContainerMatch[1] === targetContainerId
          ? restartingContainerMatch[1]
          : undefined;
      if (
        (status === 126 || status === 127) &&
        /(?:not found|no such file|executable file)/i.test(`${stdout}\n${stderr}`)
      ) {
        stderr = ["SUPERVISOR_REBUILD_REQUIRED", stderr].filter(Boolean).join("\n");
      }
      return {
        status,
        stdout,
        stderr,
        ...(managedControlRestartingContainerId ? { managedControlRestartingContainerId } : {}),
      };
    });
  } catch (error) {
    if (isDirectSandboxContainerNotFoundError(error)) {
      // New clones can report Ready before their labeled direct container is
      // discoverable. Keep only that typed absence retryable and sanitized;
      // identity, driver, and integrity refusals retain their detailed form.
      return {
        status: 1,
        stdout: "",
        stderr: "PRIVILEGED_CONTROL_UNAVAILABLE",
        managedContainerDiscoveryUnavailable: true,
      };
    }
    const detail = error instanceof Error ? error.message : "privileged container unavailable";
    return {
      status: 1,
      stdout: "",
      stderr: isPinnedSandboxContainerIdentityChangedError(error)
        ? `${MANAGED_CONTROL_IDENTITY_CHANGED_MARKER}\n${detail}`
        : `PRIVILEGED_CONTROL_UNAVAILABLE: ${detail}`,
    };
  }
}

export function executeGatewaySupervisorAction(
  sandboxName: string,
  action: "restart" | "recover" | "probe",
  timeout = 210000,
): ManagedGatewaySupervisorActionResult | null {
  return executeGatewaySupervisorActionPinned(sandboxName, action, timeout);
}

async function executeSandboxExecCommandForStatus(
  sandboxName: string,
  command: string,
  gatewayName?: string,
  commandExecutor: OpenShellSandboxBufferedCommandExecutor = createCliOpenShellSandboxCommandExecutor(
    { hostCwd: ROOT },
  ),
  timeoutMilliseconds = DEFAULT_SANDBOX_EXEC_TIMEOUT_MS,
): Promise<SandboxCommandResult | null> {
  const markedCommand = buildSandboxExecMarkedCommand(command);
  const result = await commandExecutor.runBuffered({
    sandboxName,
    target: gatewayName ? namedOpenShellGateway(gatewayName) : selectedOpenShellGateway(),
    command: ["sh", "-c", markedCommand],
    timeoutMilliseconds,
  });
  if (result.outcome.kind !== "completed") return null;
  const commandStdout = extractSandboxExecCommandStdout(result.stdout);
  if (commandStdout === null) return null;
  return {
    status: result.outcome.exitCode,
    stdout: commandStdout,
    stderr: result.stderr.trim(),
  };
}

function parseSandboxGatewayProbe(result: SandboxCommandResult | null): true | null {
  if (!result || result.status !== 0) return null;
  return result.stdout === "RUNNING" ? true : null;
}

function parseSandboxGatewayRecoveryProbe(result: SandboxCommandResult | null): boolean | null {
  const running = parseSandboxGatewayProbe(result);
  if (running === true) return true;
  if (!result || result.status !== 0) return null;
  return result.stdout === "STOPPED" ? false : null;
}

function sandboxGatewayHealthProbeCommand(probeUrl: string): string {
  return `HTTP_CODE=$(curl -so /dev/null -w '%{http_code}' --max-time 3 ${shellQuote(probeUrl)} 2>/dev/null); CURL_STATUS=$?; case "$CURL_STATUS:$HTTP_CODE" in 0:200|0:401) echo RUNNING ;; *) echo UNAVAILABLE ;; esac`;
}

function sandboxGatewayRecoveryProbeCommand(probeUrl: string, starting = false): string {
  return `HTTP_CODE=$(curl -so /dev/null -w '%{http_code}' --max-time 3 ${shellQuote(probeUrl)} 2>/dev/null); CURL_STATUS=$?; case "$CURL_STATUS:$HTTP_CODE" in 0:200|0:401) echo RUNNING ;; ${starting ? "7:000|" : ""}0:*) echo STOPPED ;; *) echo UNAVAILABLE ;; esac`;
}

/**
 * Check whether the OpenClaw gateway process is running inside the sandbox.
 * Uses the gateway's HTTP /health endpoint as the source of truth,
 * since the gateway runs as a separate user and pgrep may not see it.
 * Returns true (running), false (stopped), or null (cannot determine).
 *
 * Uses HTTP status code extraction instead of `curl -sf` so that
 * 401 (device auth enabled) is correctly treated as "alive".
 * Fixes #2342 — previously `curl -sf` failed on 401, causing false
 * "Health Offline" readings.
 */
async function isSandboxGatewayRunning(
  sandboxName: string,
  runtimeSelection?: OpenShellRuntimeSelection,
): Promise<boolean | null> {
  const agent = agentRuntime.getSessionAgent(sandboxName);
  if (agent && !agentRuntime.hasGatewayRuntime(agent)) return null;
  const probeUrl = getSandboxHealthProbeUrl(sandboxName);
  const command = sandboxGatewayRecoveryProbeCommand(probeUrl);
  const execProbe = parseSandboxGatewayRecoveryProbe(
    await executeSandboxExecCommand(
      sandboxName,
      command,
      DEFAULT_SANDBOX_EXEC_TIMEOUT_MS,
      runtimeSelection ? { runtimeSelection } : { localDockerFallbackPolicy: "read-only" },
    ),
  );
  if (execProbe !== null) return execProbe;

  // Built-in OpenClaw and Hermes lifecycle control is host-mediated through
  // the controller for the live topology. If the trusted sandbox-exec path is
  // unavailable or times out, do not silently cross back into the sandbox over
  // SSH just to classify the gateway and then make a privileged recovery
  // decision. Legacy custom gateway agents are the sole compatibility case:
  // their recovery contract is explicitly SSH-owned until manifests can
  // declare a trusted runtime user/supervisor.
  if (!agent || agent.name === "openclaw" || agent.name === "hermes") return null;
  return parseSandboxGatewayRecoveryProbe(
    await executeSandboxCommand(
      sandboxName,
      command,
      runtimeSelection ? { runtimeSelection } : DEFAULT_SANDBOX_EXEC_TIMEOUT_MS,
    ),
  );
}

function hasGatewayRecoveryMarker(result: SandboxCommandResult | null): boolean {
  if (!result || result.status !== 0) return false;
  if (parseManagedGatewayControlCompletion(result)) return true;
  // A structured controller response must satisfy the exact authenticated
  // completion shape above. Only output without a protocol record may use the
  // legacy/custom marker compatibility path.
  if (result.stdout.split(/\r?\n/).some((line) => line.startsWith("v1 "))) return false;
  return result.stdout.includes("GATEWAY_PID=") || result.stdout.includes("ALREADY_RUNNING");
}

// Source contract: scripts/gateway-control.sh and its installed managed helper
// emit SUPERVISOR_BUSY while another request owns the controller lease or
// publication marker. SUPERVISOR_UNAVAILABLE also covers integrity refusals,
// ambiguous discovery, and process-identity changes, so it must remain
// definitive. Retry only the exact lease-contention marker within the
// existing bounded window. Removal condition: delete this classifier and its
// retry cases once the installed controller waits through contention itself.
function isExactlyManagedControlMarker(
  result: SandboxCommandResult | null,
  marker: string,
): boolean {
  if (result === null) return false;
  if (result.status !== 1) return false;
  if (result.stdout.trim() !== "") return false;
  const lines = result.stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length === 1 && lines[0] === marker;
}

function isManagedContainerDiscoveryUnavailable(
  result: ManagedGatewaySupervisorActionResult | null,
): boolean {
  return (
    result?.managedContainerDiscoveryUnavailable === true &&
    isExactlyManagedControlMarker(result, "PRIVILEGED_CONTROL_UNAVAILABLE")
  );
}

function managedControlDeadlineRemaining(
  deadline: number,
  now: () => number,
  previous: { value: number },
): number {
  let current: number;
  try {
    current = now();
  } catch {
    return 0;
  }
  if (!Number.isFinite(current) || current < previous.value) return 0;
  previous.value = current;
  return Math.max(0, Math.floor(deadline - current));
}

/**
 * Creates independent retry counters for delayed container discovery and
 * managed-controller startup without allowing either class to authorize
 * supervisor identity or recreation.
 */
interface ManagedControlTransitionRetryBudget {
  readonly maxAttempts: number;
  canRetry(result: SandboxCommandResult | null): boolean;
}

function managedControlTransitionRetryBudget(): ManagedControlTransitionRetryBudget {
  let discoveryAttempts = 0;
  let transitionAttempts = 0;
  return {
    maxAttempts:
      MANAGED_CONTAINER_DISCOVERY_MAX_ATTEMPTS + MANAGED_CONTROL_TRANSITION_MAX_ATTEMPTS - 1,
    canRetry(result) {
      if (isManagedContainerDiscoveryUnavailable(result)) {
        return ++discoveryAttempts < MANAGED_CONTAINER_DISCOVERY_MAX_ATTEMPTS;
      }
      return ++transitionAttempts < MANAGED_CONTROL_TRANSITION_MAX_ATTEMPTS;
    },
  };
}

function isExactlyRetryableManagedRecoveryFailure(result: SandboxCommandResult | null): boolean {
  return isExactlyManagedControlMarker(result, "SUPERVISOR_BUSY");
}

function isExactlyManagedGatewayStartupTransition(
  result: ManagedGatewaySupervisorActionResult | null,
): boolean {
  // Discovery pending is emitted only before the controller selects a
  // supervisor, so it can delay recovery but cannot authorize relaunch or
  // accept an identity. The health timeout is likewise a read-only startup
  // observation. Any diagnostic beside an exact marker remains terminal.
  return (
    ["SUPERVISOR_NOT_RUNNING", "SUPERVISOR_DISCOVERY_PENDING", "GATEWAY_HEALTH_TIMEOUT"].some(
      (marker) => isExactlyManagedControlMarker(result, marker),
    ) || isManagedContainerDiscoveryUnavailable(result)
  );
}

function isExactlyRetryableManagedControlTransition(
  result: ManagedGatewaySupervisorActionResult | null,
): boolean {
  // The pinned Docker call records the canonical Docker error only after its
  // container ID matches the selected command target. Status 137 with no
  // output has no controller protocol result. Retry only those two results in
  // bounded managed-control loops. An exhausted transition bound, an unbound
  // error, or status 137 with output is terminal.
  if (result === null || result.stdout.trim() !== "") return false;
  if (result.status === 137) return result.stderr.trim() === "";
  if (result.status !== 1 || result.managedControlRestartingContainerId === undefined) return false;
  const restartingContainerMatch = result.stderr.trim().match(DOCKER_CONTAINER_RESTARTING_ERROR);
  return restartingContainerMatch?.[1] === result.managedControlRestartingContainerId;
}

export function waitForManagedGatewaySupervisor(
  sandboxName: string,
  options: {
    intervalSeconds?: number;
    maxAttempts?: number;
    nowImpl?: () => number;
    requestGatewaySupervisorActionImpl?: typeof executeGatewaySupervisorAction;
    sleepImpl?: (seconds: number) => void;
    totalTimeoutMs?: number;
  } = {},
): boolean {
  const requestGatewaySupervisorAction =
    options.requestGatewaySupervisorActionImpl ?? executeGatewaySupervisorAction;
  const sleep = options.sleepImpl ?? sleepSeconds;
  const intervalSeconds = options.intervalSeconds ?? 3;
  const transitionRetryBudget = managedControlTransitionRetryBudget();
  const maxAttempts = options.maxAttempts ?? transitionRetryBudget.maxAttempts;
  const now = options.nowImpl ?? (() => performance.now());
  const totalTimeoutMs = options.totalTimeoutMs ?? MANAGED_CONTROL_RECOVERY_DEADLINE_MS;
  let startedAt: number;
  try {
    startedAt = now();
  } catch {
    return false;
  }
  if (!Number.isFinite(startedAt) || !Number.isFinite(totalTimeoutMs) || totalTimeoutMs <= 0) {
    return false;
  }
  const deadline = startedAt + totalTimeoutMs;
  if (!Number.isFinite(deadline)) return false;
  const previousNow = { value: startedAt };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const remaining = managedControlDeadlineRemaining(deadline, now, previousNow);
    if (remaining <= 0) break;
    const result = requestGatewaySupervisorAction(
      sandboxName,
      "probe",
      Math.max(1, Math.min(OPENSHELL_PROBE_TIMEOUT_MS, remaining)),
    );
    const remainingAfterRequest = managedControlDeadlineRemaining(deadline, now, previousNow);
    if (remainingAfterRequest <= 0) break;
    if (hasGatewayRecoveryMarker(result)) return true;
    if (
      !isExactlyManagedGatewayStartupTransition(result) &&
      !isExactlyRetryableManagedRecoveryFailure(result) &&
      !isExactlyRetryableManagedControlTransition(result)
    ) {
      return false;
    }
    if (options.maxAttempts === undefined && !transitionRetryBudget.canRetry(result)) break;
    if (attempt < maxAttempts) {
      sleep(Math.min(intervalSeconds, remainingAfterRequest / 1000));
    }
  }
  return false;
}

function usesManagedGatewayController(entry: registry.SandboxEntry): boolean {
  const provider = resolveRegisteredRuntimeProvider(entry.openshellDriver);
  return (
    provider?.gateway.supported === true &&
    provider.gateway.launcher === "nemoclaw" &&
    provider.lifecycle.supported === true
  );
}

function recoverRegisteredRuntimeProviderSandbox(
  entry: registry.SandboxEntry,
): { readonly exitCode: number; readonly message?: string } | null {
  const provider = resolveRegisteredRuntimeProvider(entry.openshellDriver);
  if (!provider) {
    return entry.openshellDriver?.trim()
      ? {
          exitCode: 1,
          message: "The registered runtime provider does not support sandbox process recovery.",
        }
      : null;
  }
  return provider.recovery.supported
    ? provider.recovery.recover(entry)
    : { exitCode: 1, message: provider.recovery.reason };
}

type ManagedGatewayProbeOptions = {
  getSandboxImpl?: typeof registry.getSandbox;
  getSessionAgentImpl?: typeof agentRuntime.getSessionAgent;
  requestGatewaySupervisorActionImpl?: typeof executeGatewaySupervisorAction;
};

function canProbeManagedGateway(sandboxName: string, options: ManagedGatewayProbeOptions): boolean {
  const getSandbox = options.getSandboxImpl ?? registry.getSandbox;
  const entry = getSandbox(sandboxName);
  if (!entry) return false;
  const persistedAgent = entry.agent ?? "openclaw";
  if (persistedAgent !== "openclaw" && persistedAgent !== "hermes") return false;

  if (!usesManagedGatewayController(entry)) return false;

  const getSessionAgent = options.getSessionAgentImpl ?? agentRuntime.getSessionAgent;
  const agent = getSessionAgent(sandboxName);
  if (persistedAgent === "hermes" && agent?.name !== "hermes") return false;
  if (agent && !agentRuntime.hasGatewayRuntime(agent)) return false;
  return true;
}

function managedGatewayProbeHealth(
  result: ManagedGatewaySupervisorActionResult | null,
): boolean | null {
  if (hasGatewayRecoveryMarker(result)) return true;
  if (
    result === null ||
    isExactlyRetryableManagedRecoveryFailure(result) ||
    isExactlyManagedControlMarker(result, "SUPERVISOR_DISCOVERY_PENDING")
  ) {
    return null;
  }
  return false;
}

export function confirmRecoveredSandboxGatewayManaged(
  sandboxName: string,
  options: ManagedGatewayProbeOptions = {},
): boolean | null {
  if (!canProbeManagedGateway(sandboxName, options)) return null;
  return managedGatewayProbeHealth(
    (options.requestGatewaySupervisorActionImpl ?? executeGatewaySupervisorAction)(
      sandboxName,
      "probe",
    ),
  );
}

export async function isSandboxGatewayRunningForStatus(
  sandboxName: string,
  gatewayName?: string,
  options: {
    getSessionAgent?: typeof agentRuntime.getSessionAgent;
    startup?: { timeoutMs: number };
    commandExecutor?: OpenShellSandboxBufferedCommandExecutor;
    getHealthProbeUrl?: typeof getSandboxHealthProbeUrl;
    requestGatewaySupervisorActionImpl?: typeof executeGatewaySupervisorAction;
  } = {},
): Promise<boolean | null> {
  const agent = (options.getSessionAgent ?? agentRuntime.getSessionAgent)(sandboxName);
  if (agent && !agentRuntime.hasGatewayRuntime(agent)) return null;
  if (agent?.name === "hermes") {
    const result = (options.requestGatewaySupervisorActionImpl ?? executeGatewaySupervisorAction)(
      sandboxName,
      "probe",
      OPENSHELL_PROBE_TIMEOUT_MS,
    );
    if (hasGatewayRecoveryMarker(result)) return true;
    if (isExactlyManagedControlMarker(result, "SUPERVISOR_NOT_RUNNING")) return false;
    return null;
  }
  return isSandboxGatewayHttpReachableForStatus(sandboxName, gatewayName, options);
}

export async function isSandboxGatewayHttpReachableForStatus(
  sandboxName: string,
  gatewayName?: string,
  options: {
    startup?: { timeoutMs: number };
    commandExecutor?: OpenShellSandboxBufferedCommandExecutor;
    getHealthProbeUrl?: typeof getSandboxHealthProbeUrl;
  } = {},
): Promise<boolean | null> {
  const probeUrl = (options.getHealthProbeUrl ?? getSandboxHealthProbeUrl)(sandboxName);
  // A refused loopback connection is expected while the native agent starts.
  // Ordinary status observations keep treating this as unavailable evidence.
  const command = options.startup
    ? sandboxGatewayRecoveryProbeCommand(probeUrl, true)
    : sandboxGatewayHealthProbeCommand(probeUrl);
  const result = await executeSandboxExecCommandForStatus(
    sandboxName,
    command,
    gatewayName,
    options.commandExecutor,
    options.startup?.timeoutMs,
  );
  return options.startup
    ? parseSandboxGatewayRecoveryProbe(result)
    : parseSandboxGatewayProbe(result);
}

/**
 * Recover a gateway through the registered agent's managed control boundary.
 * Legacy custom agents retain their SSH-owned compatibility path.
 */
type SandboxProcessRecovery =
  | { kind: "custom" }
  | { kind: "provider" }
  | { kind: "unsupported-provider"; failureDetail: string };

async function recoverSandboxProcesses(
  sandboxName: string,
  {
    quiet = false,
    runtimeSelection,
  }: {
    quiet?: boolean;
    runtimeSelection?: OpenShellRuntimeSelection;
  } = {},
): Promise<SandboxProcessRecovery | null> {
  const agent = agentRuntime.getSessionAgent(sandboxName);
  const dashboardPort = resolveSandboxDashboardPort(sandboxName);
  let persistedAgent: string | null;
  try {
    persistedAgent = sandboxAgentName(sandboxName, registry.getSandbox);
  } catch (error) {
    const detail =
      error instanceof Error && error.message.trim()
        ? `Sandbox agent lookup failed: ${error.message}.`
        : "Sandbox agent lookup failed.";
    quiet || printGatewayRestartFailure(sandboxName, "unsupported agent", detail);
    return null;
  }
  const persistedSandbox = registry.getSandbox(sandboxName);
  const persistedProvider = resolveRegisteredRuntimeProvider(persistedSandbox?.openshellDriver);
  // An explicit provider recovery surface owns its runtime transition.
  if (
    persistedSandbox &&
    (persistedProvider?.recovery.supported === true ||
      !usesManagedGatewayController(persistedSandbox))
  ) {
    if (persistedProvider?.recovery.supported === true && runtimeSelection) {
      return {
        kind: "unsupported-provider",
        failureDetail:
          "Provider recovery is not available for an explicitly selected OpenShell target because the provider recovery surface is host-local.",
      };
    }
    const result = recoverRegisteredRuntimeProviderSandbox(persistedSandbox);
    if (result) {
      if (result.exitCode === 0) return { kind: "provider" };
      return {
        kind: "unsupported-provider",
        failureDetail: result.message ?? "The registered runtime provider recovery failed.",
      };
    }
  }
  const recoveredSsh = (result: SandboxCommandResult | null): SandboxProcessRecovery | null =>
    result && result.status === 0 && hasGatewayRecoveryMarker(result) ? { kind: "custom" } : null;

  if (
    persistedAgent === "hermes" ||
    ((!persistedAgent || persistedAgent === "openclaw") && (!agent || agent.name === "openclaw"))
  ) {
    return {
      kind: "unsupported-provider",
      failureDetail:
        "The native agent gateway is stopped. Restart it through the agent or restart the sandbox through OpenShell.",
    };
  }

  // A persisted non-OpenClaw runtime whose manifest cannot be loaded is not
  // evidence that the sandbox is OpenClaw. Falling through here would run the
  // OpenClaw recovery script against an unknown custom or terminal runtime.
  // Keep legacy registry entries with no agent name on the OpenClaw fallback,
  // but fail closed for an explicit non-OpenClaw agent.
  if (persistedAgent && persistedAgent !== "openclaw" && !agent) {
    const detail = `${persistedAgent} agent definition could not be loaded.`;
    if (!quiet) printGatewayRestartFailure(sandboxName, "unsupported agent", detail);
    return null;
  }

  const agentScript = agentRuntime.buildRecoveryScript(agent, dashboardPort);
  if (agentRuntime.isTerminalAgentRecoveryScript(agentScript)) return null;
  if (agentScript) {
    // Non-Hermes custom manifests do not yet declare a supported host-side
    // runtime user. Recover them over SSH so the launch inherits the sandbox
    // login user instead of creating root-owned agent state under /sandbox.
    return recoveredSsh(
      await executeSandboxCommand(
        sandboxName,
        agentScript,
        runtimeSelection ? { runtimeSelection } : DEFAULT_SANDBOX_EXEC_TIMEOUT_MS,
      ),
    );
  }

  return null;
}

export async function restartSandboxGateway(
  sandboxName: string,
  { quiet = false, deps = {}, runtimeSelection }: RestartSandboxGatewayOptions = {},
): Promise<GatewayRestartResult> {
  return withSandboxLifecycleLock(sandboxName, () =>
    restartSandboxGatewayWithDeps(sandboxName, {
      quiet,
      deps: {
        getSessionAgent: agentRuntime.getSessionAgent,
        getSandbox: registry.getSandbox,
        resolveSandboxDashboardPort,
        executeSandboxExecCommand: (name, command, timeout) =>
          executeSandboxExecCommand(
            name,
            command,
            timeout,
            runtimeSelection ? { runtimeSelection } : { localDockerFallbackPolicy: "read-only" },
          ),
        waitForRecoveredSandboxGateway: (name, options) =>
          waitForRecoveredSandboxGateway(name, {
            ...options,
            runtimeSelection,
            timeoutSeconds: gatewayRecoveryTimeoutSeconds(agentRuntime.getSessionAgent(name)),
          }),
        ensureSandboxPortForward: (name) => ensureSandboxPortForward(name, { runtimeSelection }),
        ensureHermesDashboardPortForwardIfEnabled: (name) =>
          ensureHermesDashboardPortForwardIfEnabled(name, runtimeSelection),
        recoverMessagingHostForward: (name, options) =>
          recoverMessagingHostForward(name, { ...options, runtimeSelection }),
        recoverDeclaredAgentForwardPorts: (name, recoveryPort, options) =>
          recoverDeclaredAgentForwardPorts(name, recoveryPort, {
            ...options,
            runtimeSelection,
          }),
        printGatewayWedgeDiagnostics,
        ...deps,
      },
    }),
  );
}

function readNonNegativeNumberEnv(
  name: string,
  fallback: number,
  environment: NodeJS.ProcessEnv = process.env,
): number {
  const raw = environment[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Resolve the shared override; HTTP health defaults to 30s, OpenShell readiness supplies 120s. */
export function resolveGatewayRecoveryWaitSeconds(
  fallbackSeconds = 30,
  environment: NodeJS.ProcessEnv = process.env,
): number {
  return Math.min(
    readNonNegativeNumberEnv(
      "NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS",
      fallbackSeconds,
      environment,
    ),
    Number.MAX_SAFE_INTEGER / 1_000,
  );
}

const OPENSHELL_SANDBOX_NOT_READY = `Error: code: 'The system is not in a state required for the operation's execution', message: "sandbox is not ready"`;
const OPENSHELL_SERVICE_UNAVAILABLE = "code: 'The service is currently unavailable'";
const OPENSHELL_STATUS_UNAVAILABLE = "status: Unavailable";
const OPENSHELL_RELAY_OPEN_TIMED_OUT = 'message: "relay open timed out"';
const OPENSHELL_SUPERVISOR_RELAY_DEADLINE = "supervisor relay failed: status: DeadlineExceeded";
const OPENSHELL_RELAY_CHANNEL_TIMED_OUT = "relay channel timed out";
const OPENSHELL_RELAY_CHANNEL_DROPPED = 'message: "relay channel dropped"';
const OPENSHELL_RELAY_TARGET_NOT_FOUND = 'message: "No such file or directory (os error 2)"';
const OPENSHELL_RELAY_TARGET_REFUSED = 'message: "Connection refused (os error 111)"';

function normalizeOpenshellStructuredError(value: string): string {
  return stripAnsi(value)
    .replace(/[×│]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function hasRetryableOpenshellFailureShape(
  result: OpenShellSandboxBufferedCommandCompletion,
): boolean {
  return (
    result.outcome.kind === "completed" &&
    result.outcome.exitCode === 1 &&
    result.stderr.trim() !== ""
  );
}

function isRetryableOpenshellReRegistrationState(
  result: OpenShellSandboxBufferedCommandCompletion,
  sandboxName: string,
): boolean {
  if (!hasRetryableOpenshellFailureShape(result)) return false;
  const error = normalizeOpenshellStructuredError(result.stderr);
  // OpenShell can publish Ready before sandbox control-plane readiness settles.
  // Retry only if the readiness probe reports phase Error for this sandbox.
  // The CLI can emit informational stdout before this exact stderr refusal;
  // stdout does not change the result of the read-only `true` probe.
  if (
    error ===
    `Error: sandbox '${sandboxName}' is not ready (phase: Error); wait for it to reach Ready state.`
  ) {
    return true;
  }
  // All less-specific transient signatures remain constrained to an otherwise
  // empty stdout stream so unrelated command output cannot be reclassified.
  if (result.stdout.trim() !== "") return false;
  if (error === OPENSHELL_SANDBOX_NOT_READY) return true;

  // OpenShell 0.0.85 can keep the recovering sandbox's cached phase at Ready
  // while its supervisor session is still registering. The exec
  // RPC can fail before a session connects, after a session disconnects, while
  // the supervisor's local SSH relay target is starting, or after
  // the session connects but does not claim its reverse relay within OpenShell's
  // 10-second relay deadline. These exact results are control-plane
  // re-registration states; all other OpenShell failures remain terminal.
  // NemoClaw cannot repair this OpenShell-owned phase/session state without
  // bypassing the control plane. Remove these matches when supported OpenShell
  // versions publish Ready only after the supervisor session and relay are
  // usable, or report the standard sandbox-not-ready state until then.
  const sessionUnavailable =
    error.includes(OPENSHELL_SERVICE_UNAVAILABLE) &&
    error.includes("supervisor relay failed: status: Unavailable") &&
    (error.includes("supervisor session not connected") ||
      error.includes("supervisor session disconnected"));
  const relayChannelTimedOut =
    error.includes(OPENSHELL_SERVICE_UNAVAILABLE) &&
    error.includes(OPENSHELL_SUPERVISOR_RELAY_DEADLINE) &&
    error.includes(OPENSHELL_RELAY_CHANNEL_TIMED_OUT);
  const relayChannelDropped =
    (error.includes(OPENSHELL_SERVICE_UNAVAILABLE) ||
      error.includes(OPENSHELL_STATUS_UNAVAILABLE)) &&
    error.includes(OPENSHELL_RELAY_CHANNEL_DROPPED);
  const relayTargetUnavailable =
    error.includes(OPENSHELL_SERVICE_UNAVAILABLE) &&
    (error.includes(OPENSHELL_RELAY_TARGET_NOT_FOUND) ||
      error.includes(OPENSHELL_RELAY_TARGET_REFUSED));
  return (
    sessionUnavailable ||
    relayChannelTimedOut ||
    relayChannelDropped ||
    relayTargetUnavailable ||
    error.includes(OPENSHELL_RELAY_OPEN_TIMED_OUT)
  );
}

type RecreatedSandboxOpenShellReadinessFailure =
  | "managed-health-definitive-failure"
  | "managed-health-inconclusive-timeout"
  | "openshell-readiness-failure";

type RecreatedSandboxOpenShellReadinessResult =
  | { ready: true }
  | {
      failure: RecreatedSandboxOpenShellReadinessFailure;
      openshellError?: string;
      ready: false;
    };

type RecreatedSandboxOpenShellReadyOptions = {
  commandExecutor?: OpenShellSandboxBufferedCommandExecutor;
  beforeProbe?: (timeoutMs: number) => boolean | null;
  intervalSeconds?: number;
  nowImpl?: () => number;
  sleepImpl?: (seconds: number) => void;
  timeoutSeconds?: number;
  runtimeSelection?: OpenShellRuntimeSelection;
};

function recreatedSandboxOpenShellReadinessFailureDetail(
  failure: RecreatedSandboxOpenShellReadinessFailure,
  openshellError?: string,
  managedHealthFailureDetail?: string,
): string {
  const detail = (() => {
    switch (failure) {
      case "managed-health-definitive-failure":
        return "the managed supervisor health check did not pass after gateway recovery. NemoClaw did not start the primary dashboard/API host forward";
      case "managed-health-inconclusive-timeout":
        return "the managed supervisor health check stayed inconclusive within the OpenShell readiness deadline after gateway recovery. NemoClaw did not start the primary dashboard/API host forward";
      case "openshell-readiness-failure":
        return "the sandbox did not become ready in OpenShell after gateway recovery. NemoClaw did not start the primary dashboard/API host forward";
    }
  })();
  const managedHealthResult = managedHealthFailureDetail
    ? ` Managed supervisor health check result: ${managedHealthFailureDetail}`
    : "";
  const openshellResult = openshellError
    ? ` Last OpenShell readiness error: ${openshellError}`
    : "";
  return `${detail}${managedHealthResult}${openshellResult}`;
}

// Default seconds to wait for OpenShell to report a recovering sandbox as Ready
// before returning a classified recovery failure. Aligned with
// `connect`'s readiness budget (`waitForSandboxReadyOrExit` defaults to 120s):
// both prove the same sandbox readiness, but this path used to
// give up 4x sooner (30s), so a cold-start `phase: Error` settling window that
// exceeded 30s but was within `connect`'s 120s left the primary dashboard/API
// forward unstarted — exactly why `connect --probe-only` recovers what `start`
// abandons (#7227). Env-tunable via NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS.
const GATEWAY_RECOVERY_WAIT_DEFAULT_SECONDS = 120;

/**
 * Wait until OpenShell reports a recovering sandbox as ready. This probe
 * deliberately has no direct-container or SSH fallback: it proves the
 * control-plane readiness that gates forward restoration.
 */
async function waitForRecreatedSandboxOpenShellReadyResult(
  sandboxName: string,
  options: RecreatedSandboxOpenShellReadyOptions = {},
): Promise<RecreatedSandboxOpenShellReadinessResult> {
  const commandExecutor =
    options.commandExecutor ?? createCliOpenShellSandboxCommandExecutor({ hostCwd: ROOT });
  const now = options.nowImpl ?? Date.now;
  const sleep = options.sleepImpl ?? sleepSeconds;
  const requestedTimeoutSeconds =
    typeof options.timeoutSeconds === "number" &&
    Number.isFinite(options.timeoutSeconds) &&
    options.timeoutSeconds >= 0
      ? options.timeoutSeconds
      : GATEWAY_RECOVERY_WAIT_DEFAULT_SECONDS;
  const timeoutSeconds = resolveGatewayRecoveryWaitSeconds(requestedTimeoutSeconds);
  const intervalSeconds = readNonNegativeNumberEnv(
    "NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS",
    options.intervalSeconds ?? 3,
  );
  const deadlineMs = now() + timeoutSeconds * 1000;
  const maxAttempts =
    intervalSeconds > 0
      ? Math.max(1, Math.floor(timeoutSeconds / intervalSeconds) + 1)
      : Math.max(1, Math.floor(timeoutSeconds) + 1);
  let lastOpenshellError: string | undefined;
  let observedRetryableReRegistrationState = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const preGuardRemainingMs = deadlineMs - now();
    if (attempt > 1 && preGuardRemainingMs <= 0) {
      return { failure: "managed-health-inconclusive-timeout", ready: false };
    }
    const guardBudgetMs = Math.max(1, Math.min(OPENSHELL_PROBE_TIMEOUT_MS, preGuardRemainingMs));
    const guardResult = options.beforeProbe?.(guardBudgetMs);
    if (guardResult === false) {
      return { failure: "managed-health-definitive-failure", ready: false };
    }
    if (guardResult === null) {
      if (attempt === maxAttempts) {
        return { failure: "managed-health-inconclusive-timeout", ready: false };
      }
      const postGuardRemainingMs = deadlineMs - now();
      if (postGuardRemainingMs <= 0) {
        return { failure: "managed-health-inconclusive-timeout", ready: false };
      }
      sleep(Math.min(intervalSeconds * 1000, postGuardRemainingMs) / 1000);
      continue;
    }
    const remainingMs = deadlineMs - now();
    if (attempt > 1 && remainingMs <= 0) {
      return {
        failure: "openshell-readiness-failure",
        openshellError: lastOpenshellError,
        ready: false,
      };
    }
    const result = await commandExecutor.runBuffered({
      sandboxName,
      target: options.runtimeSelection
        ? namedOpenShellGateway(options.runtimeSelection.gatewayName)
        : selectedOpenShellGateway(),
      command: ["true"],
      environment: options.runtimeSelection
        ? buildOpenShellRuntimeSelectionEnv(buildSubprocessEnv(), options.runtimeSelection)
        : buildSubprocessEnv(),
      timeoutMilliseconds: Math.max(1, Math.min(OPENSHELL_PROBE_TIMEOUT_MS, remainingMs)),
    });
    if (result.outcome.kind === "completed" && result.outcome.exitCode === 0) {
      return { ready: true };
    }
    const openshellError = normalizeOpenshellStructuredError(result.stderr);
    if (openshellError) lastOpenshellError = openshellError;
    // This probe executes only `true`, so an OpenShell process timeout has no
    // mutation outcome to reconcile. Treat that exact timeout as inconclusive
    // and retry behind the pinned managed-health guard on the next iteration.
    // All other unexpected OpenShell failures remain definitive.
    const retryableReRegistrationState = isRetryableOpenshellReRegistrationState(
      result,
      sandboxName,
    );
    if (retryableReRegistrationState) observedRetryableReRegistrationState = true;
    const emptyReadOnlyProbeAfterReRegistration =
      observedRetryableReRegistrationState &&
      result.outcome.kind === "completed" &&
      result.outcome.exitCode === 1 &&
      result.stdout.trim() === "" &&
      result.stderr.trim() === "";
    // OpenShell can briefly return an empty exit-1 result after first exposing
    // the exact replacement re-registration state. Keep that result
    // inconclusive only inside the same bounded wait and behind the pinned
    // managed-health guard. It is never accepted as Ready, and an empty first
    // failure or any diagnostic-bearing unknown failure remains terminal.
    if (
      !retryableReRegistrationState &&
      !emptyReadOnlyProbeAfterReRegistration &&
      !(result.outcome.kind === "failed" && result.outcome.error.kind === "timeout")
    ) {
      return {
        failure: "openshell-readiness-failure",
        openshellError: lastOpenshellError,
        ready: false,
      };
    }
    if (attempt === maxAttempts) {
      return {
        failure: "openshell-readiness-failure",
        openshellError: lastOpenshellError,
        ready: false,
      };
    }
    const postProbeRemainingMs = deadlineMs - now();
    if (postProbeRemainingMs <= 0) {
      return {
        failure: "openshell-readiness-failure",
        openshellError: lastOpenshellError,
        ready: false,
      };
    }
    sleep(Math.min(intervalSeconds * 1000, postProbeRemainingMs) / 1000);
  }
  return {
    failure: "openshell-readiness-failure",
    openshellError: lastOpenshellError,
    ready: false,
  };
}

export async function waitForRecreatedSandboxOpenShellReady(
  sandboxName: string,
  options: RecreatedSandboxOpenShellReadyOptions = {},
): Promise<boolean> {
  return (await waitForRecreatedSandboxOpenShellReadyResult(sandboxName, options)).ready;
}

function gatewayRecoveryTimeoutSeconds(
  agent: ReturnType<typeof agentRuntime.getSessionAgent>,
): number {
  const timeoutSeconds = agent?.healthProbe?.timeout_seconds;
  return typeof timeoutSeconds === "number" &&
    Number.isFinite(timeoutSeconds) &&
    timeoutSeconds >= 0
    ? timeoutSeconds
    : 30;
}

function printHostManagedGatewayRecoveryHints(
  sandboxName: string,
  agent: ReturnType<typeof agentRuntime.getSessionAgent>,
  failureLayer: GatewayRestartFailureLayer | null = null,
): void {
  const quotedSandboxName = shellQuote(sandboxName);
  if (failureLayer === "supervisor not running") {
    console.error("  The in-sandbox supervisor is not running, and trusted container recovery");
    console.error("  could not restore a managed supervisor and healthy gateway.");
    console.error("  Recreate the sandbox runtime to restore it:");
    console.error(`    nemoclaw ${quotedSandboxName} rebuild --yes`);
    console.error("  If rebuild is blocked, destroy and re-onboard the sandbox to restore it.");
    return;
  }
  // These terminal states need their specific repair before another managed
  // restart. The generic hint below would otherwise repeat the same failure.
  if (isGatewayTerminalRepairLayer(failureLayer)) {
    for (const line of gatewayTerminalRepairLines(quotedSandboxName, failureLayer)) {
      console.error(`  ${line}`);
    }
    return;
  }
  let agentName = agent?.name ?? null;
  if (!agentName) {
    try {
      agentName = registry.getSandbox(sandboxName)?.agent ?? null;
    } catch {
      // Preserve the legacy OpenClaw hint when registry lookup itself failed.
    }
  }
  if (!agentName || agentName === "openclaw" || agentName === "hermes") {
    console.error("  Retry the managed restart from the host:");
    console.error(`    nemoclaw ${quotedSandboxName} gateway restart`);
  } else {
    console.error("  This custom agent does not support the managed gateway restart command.");
    console.error("  After addressing its gateway log, retry agent-aware recovery from the host:");
    console.error(`    nemoclaw ${quotedSandboxName} recover`);
  }
  console.error("  If the sandbox image is incompatible or restart still fails, rebuild it:");
  console.error(`    nemoclaw ${quotedSandboxName} rebuild --yes`);
}

function recoveryAgentDisplayName(
  sandboxName: string,
  agent: ReturnType<typeof agentRuntime.getSessionAgent>,
): string {
  if (agent) return agentRuntime.getAgentDisplayName(agent);
  try {
    const persistedAgent = registry.getSandbox(sandboxName)?.agent;
    if (persistedAgent && persistedAgent !== "openclaw") return persistedAgent;
  } catch {
    // The recovery path below reports registry lookup failures with the
    // structured unsupported-agent diagnostic.
  }
  return agentRuntime.getAgentDisplayName(null);
}

async function confirmManagedGatewayWithinSettleWindowAsync(
  sandboxName: string,
  managedProbe: (sandboxName: string) => Awaitable<boolean | null>,
  sleep: (seconds: number) => Awaitable<void>,
  settleSeconds: number,
  intervalSeconds: number,
): Promise<boolean> {
  const retryLeadSeconds =
    intervalSeconds > 0 ? Math.min(intervalSeconds, settleSeconds) : settleSeconds;
  const beforeDeadlineSeconds = settleSeconds - retryLeadSeconds;
  if (beforeDeadlineSeconds > 0) await sleep(beforeDeadlineSeconds);

  const beforeDeadlineResult = await managedProbe(sandboxName);
  if (beforeDeadlineResult === false) return false;
  if (retryLeadSeconds > 0) await sleep(retryLeadSeconds);
  const atDeadlineResult = await managedProbe(sandboxName);
  if (atDeadlineResult !== null) return atDeadlineResult;
  return beforeDeadlineResult === true;
}

export async function waitForRecoveredSandboxGateway(
  sandboxName: string,
  options: {
    managedProbeImpl?: (sandboxName: string) => Awaitable<boolean | null>;
    initialManagedHealthPassed?: boolean;
    probeImpl?: (sandboxName: string) => Promise<boolean | null>;
    sleepImpl?: (seconds: number) => Awaitable<void>;
    quiet?: boolean;
    timeoutSeconds?: number;
    requireManagedProbe?: boolean;
    runtimeSelection?: OpenShellRuntimeSelection;
  } = {},
): Promise<boolean> {
  const probe =
    options.probeImpl ??
    ((name: string) => isSandboxGatewayRunning(name, options.runtimeSelection));
  const managedProbe =
    options.managedProbeImpl ?? (options.probeImpl ? null : confirmRecoveredSandboxGatewayManaged);
  const sleep = options.sleepImpl ?? sleepSeconds;
  const requestedTimeoutSeconds =
    typeof options.timeoutSeconds === "number" &&
    Number.isFinite(options.timeoutSeconds) &&
    options.timeoutSeconds >= 0
      ? options.timeoutSeconds
      : GATEWAY_RECOVERY_WAIT_DEFAULT_SECONDS;
  const timeoutSeconds = resolveGatewayRecoveryWaitSeconds(requestedTimeoutSeconds);
  const intervalSeconds = readNonNegativeNumberEnv(
    "NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS",
    3,
  );
  const attempts =
    intervalSeconds > 0
      ? Math.max(1, Math.floor(timeoutSeconds / intervalSeconds) + 1)
      : Math.max(1, Math.floor(timeoutSeconds) + 1);

  const probeDuringRecoveryWait = async () => {
    const managedResult = managedProbe ? await managedProbe(sandboxName) : null;
    if (managedResult !== null) return managedResult;
    if (options.requireManagedProbe) return false;
    return await probe(sandboxName);
  };

  // A successful managed restart/recover marker is already emitted only after
  // the controller proves the exact child, listener, HTTP health, and declared
  // auxiliaries from inside the gateway network namespace. Trust that as the
  // initial observation; the settle check below still independently re-proves
  // health and catches a delayed #4710 wedge.
  const initialManagedHealthPassed = options.initialManagedHealthPassed === true;
  const recovered =
    initialManagedHealthPassed ||
    (await waitUntilAsync(async () => (await probeDuringRecoveryWait()) === true, {
      initialIntervalMs: intervalSeconds * 1000,
      maxIntervalMs: intervalSeconds * 1000,
      backoffFactor: 1,
      maxAttempts: attempts,
      sleep: async (ms) => await sleep(ms / 1000),
    }));
  if (!recovered) return false;

  // #4710: a freshly relaunched gateway can serve for ~20s and then drop
  // its HTTP listener while the process stays alive (a failed in-process
  // restart triggered by a post-launch config write parks it deaf). One
  // successful probe inside that window is not proof of recovery — wait
  // out a settle window and require the gateway to still be serving.
  // 0 disables the settle confirm.
  // Source boundary and removal condition for this detection live in
  // gateway-wedge-diagnostics.ts.
  const settleSeconds = readNonNegativeNumberEnv("NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS", 25);
  if (settleSeconds <= 0) {
    return true;
  }
  if (!options.quiet) {
    console.log(`  Confirming the gateway stays responsive (~${settleSeconds}s)...`);
  }
  if (initialManagedHealthPassed) {
    // The managed probe is a read-only, authenticated point check in the exact
    // gateway network namespace. Probe once inside the final poll interval and
    // again at the settle deadline, so one authenticated controller race can
    // clear without extending the configured settle window. A recent
    // authenticated success remains authoritative when only the deadline
    // attempt is transient; a definitive failure is authoritative, and an
    // outer-namespace HTTP response must never override either result.
    if (!managedProbe) return false;
    return confirmManagedGatewayWithinSettleWindowAsync(
      sandboxName,
      managedProbe,
      sleep,
      settleSeconds,
      intervalSeconds,
    );
  }
  await sleep(settleSeconds);
  // A stopped HTTP probe is still only a point-in-time observation. PID 1 can
  // have respawned the gateway while OpenClaw is still finishing its startup
  // transition, so multiple stopped results may precede a healthy listener.
  // Give stopped and inconclusive probes the same bounded recovery window.
  // A persistent #4710 wedge still fails closed when that window expires.
  return waitUntilAsync(async () => (await probeDuringRecoveryWait()) === true, {
    initialIntervalMs: intervalSeconds * 1000,
    maxIntervalMs: intervalSeconds * 1000,
    backoffFactor: 1,
    maxAttempts: attempts,
    sleep: async (ms) => await sleep(ms / 1000),
  });
}

/** Recover a classified dashboard listener without signalling a non-owned listener. */
async function recoverUnhealthyDashboardForward(
  sandboxName: string,
  listener: SandboxForwardListener,
  {
    quiet,
    isWsl,
    runtimeSelection,
    ensureSandboxPortForwardImpl,
  }: {
    quiet: boolean;
    isWsl?: boolean;
    runtimeSelection?: OpenShellRuntimeSelection;
    ensureSandboxPortForwardImpl: typeof ensureSandboxPortForward;
  },
): Promise<{ recovered: boolean; failureDetail: string }> {
  if (!quiet) {
    console.log("");
    if (listener === "foreign" || listener === "indeterminate") {
      console.log(
        `  Dashboard port forward to '${sandboxName}' is held by a listener whose ownership NemoClaw cannot prove.`,
      );
    } else {
      console.log(`  Dashboard port forward to '${sandboxName}' is missing or dead.`);
      console.log("  Re-establishing...");
    }
  }
  if (listener === "foreign" || listener === "indeterminate") {
    console.error(
      nonOwnedForwardListenerRefusal(sandboxName, resolveSandboxDashboardPort(sandboxName)),
    );
    return {
      recovered: false,
      failureDetail: `host port ${String(resolveSandboxDashboardPort(sandboxName))} is held by a listener that NemoClaw cannot attribute to this sandbox's OpenShell forward, so the dashboard forward was not restored`,
    };
  }
  return {
    recovered: await ensureSandboxPortForwardImpl(sandboxName, {
      isWsl,
      runtimeSelection,
    }),
    failureDetail: "the primary dashboard/API host forward could not be re-established",
  };
}

/**
 * Detect and recover from a sandbox that survived a gateway restart but
 * whose OpenClaw processes are not running. Also re-establishes the
 * host-side dashboard port-forward when it has gone dead independently
 * of the gateway. Returns an object describing the outcome:
 * `{ checked, wasRunning, recovered, forwardRecovered, forwardRecoveryFailed?, recoveryFailureDetail?, secretBoundaryRefused?, secretBoundaryReason? }`.
 * Failures before forward recovery use `recoveryFailureDetail`; actual forward
 * failures retain `forwardRecoveryFailed` and their forward detail.
 */
async function checkAndRecoverSandboxProcessesWithoutHostLock(
  sandboxName: string,
  {
    quiet = false,
    isSandboxGatewayRunningImpl = isSandboxGatewayRunning,
    waitForRecoveredSandboxGatewayImpl = waitForRecoveredSandboxGateway,
    waitForRecreatedSandboxOpenShellReadyImpl = waitForRecreatedSandboxOpenShellReady,
    commandExecutor,
    isWsl: isWslOverride,
    onRecoveryFailureLayer,
    probeTiming,
    runtimeSelection,
    ensureSandboxPortForwardImpl = ensureSandboxPortForward,
    describeSandboxForwardListenerImpl = describeSandboxForwardListener,
    forwardAdapterForAuthority,
  }: {
    quiet?: boolean;
    isSandboxGatewayRunningImpl?: (
      sandboxName: string,
      runtimeSelection?: OpenShellRuntimeSelection,
    ) => Promise<boolean | null>;
    waitForRecoveredSandboxGatewayImpl?: typeof waitForRecoveredSandboxGateway;
    waitForRecreatedSandboxOpenShellReadyImpl?: typeof waitForRecreatedSandboxOpenShellReady;
    commandExecutor?: OpenShellSandboxBufferedCommandExecutor;
    isWsl?: boolean;
    onRecoveryFailureLayer?: (layer: GatewayRestartFailureLayer | null, detail?: string) => void;
    probeTiming?: ProcessRecoveryProbeTiming;
    runtimeSelection?: OpenShellRuntimeSelection;
    ensureSandboxPortForwardImpl?: typeof ensureSandboxPortForward;
    describeSandboxForwardListenerImpl?: typeof describeSandboxForwardListener;
    forwardAdapterForAuthority?: OpenShellForwardObservationAdapterFactory;
  } = {},
) {
  const measureAsync = <T>(
    stage: "processes" | "forward",
    operation: () => Promise<T>,
  ): Promise<T> => (probeTiming ? probeTiming.measureAsync(stage, operation) : operation());
  const recoveryAgent = agentRuntime.getSessionAgent(sandboxName);
  const recoveryDisplayName = recoveryAgentDisplayName(sandboxName, recoveryAgent);
  if (recoveryAgent && !agentRuntime.hasGatewayRuntime(recoveryAgent)) {
    return {
      checked: true,
      wasRunning: null,
      recovered: false,
      forwardRecovered: false,
      runtime: "terminal" as const,
    };
  }
  const running = await measureAsync("processes", () =>
    isSandboxGatewayRunningImpl(sandboxName, runtimeSelection),
  );
  if (running === null) {
    return {
      checked: false,
      wasRunning: null,
      recovered: false,
      forwardRecovered: false,
    };
  }
  const recoveryPort = resolveSandboxDashboardPort(sandboxName);
  if (running) {
    // Gateway is alive but the host-side forward can still be dead or
    // owned by another sandbox. Probe and re-establish only when
    // necessary so the live-and-healthy path stays a no-op.
    const forwardListener = await measureAsync("forward", () =>
      describeSandboxForwardListenerImpl(sandboxName, {
        forwardAdapterForAuthority,
        isWsl: isWslOverride,
        runtimeSelection,
      }),
    );
    const forwardHealthy = forwardListener === "owned";
    if (forwardHealthy === false) {
      const { recovered: forwardRecovered, failureDetail: forwardRecoveryFailureDetail } =
        await measureAsync("forward", () =>
          recoverUnhealthyDashboardForward(sandboxName, forwardListener, {
            quiet,
            isWsl: isWslOverride,
            runtimeSelection,
            ensureSandboxPortForwardImpl,
          }),
        );
      const dashboardForwardRecovered = await measureAsync("forward", () =>
        ensureHermesDashboardPortForwardIfEnabled(sandboxName, runtimeSelection),
      );
      const messagingForwardRecovered = await measureAsync("forward", () =>
        recoverMessagingHostForward(sandboxName, { quiet, runtimeSelection }),
      );
      const declaredForwardsRecovered = await measureAsync("forward", () =>
        recoverDeclaredAgentForwardPorts(sandboxName, recoveryPort, {
          quiet,
          runtimeSelection,
        }),
      );
      const auxiliaryResults = [
        {
          label: "the Hermes dashboard host forward",
          recovered: dashboardForwardRecovered,
        },
        {
          label: "the messaging webhook host forward",
          recovered: messagingForwardRecovered,
        },
        {
          label: "one or more agent-declared host forwards",
          recovered: declaredForwardsRecovered,
        },
      ];
      const auxiliaryFailureDetail = auxiliaryRecoveryFailureDetail(auxiliaryResults);
      if (!quiet) {
        if (forwardRecovered) {
          console.log(`  ${G}✓${R} Dashboard port forward re-established.`);
        } else {
          console.error("  Failed to re-establish the dashboard port forward.");
          console.error(`  Run \`nemoclaw ${sandboxName} recover\` after resolving the error.`);
        }
      }
      if (!forwardRecovered) {
        probeTiming?.setForwardAction("failed");
        return {
          checked: true,
          wasRunning: true,
          recovered: false,
          forwardRecovered: false,
          forwardRecoveryFailed: true,
          forwardRecoveryFailureDetail,
        };
      }
      if (auxiliaryFailureDetail !== null) {
        probeTiming?.setForwardAction("failed");
        if (!quiet) console.error(`  ${auxiliaryFailureDetail}.`);
        return {
          checked: true,
          wasRunning: true,
          recovered: false,
          forwardRecovered: false,
          forwardRecoveryFailed: true,
          forwardRecoveryFailureDetail: auxiliaryFailureDetail,
        };
      }
      probeTiming?.setForwardAction("restored");
      return {
        checked: true,
        wasRunning: true,
        recovered: false,
        forwardRecovered: forwardRecovered || anyAuxiliaryRecovered(auxiliaryResults),
      };
    }
    const dashboardForwardRecovered = await measureAsync("forward", () =>
      ensureHermesDashboardPortForwardIfEnabled(sandboxName, runtimeSelection),
    );
    const messagingForwardRecovered = await measureAsync("forward", () =>
      recoverMessagingHostForward(sandboxName, { quiet, runtimeSelection }),
    );
    const declaredForwardsRecovered = await measureAsync("forward", () =>
      recoverDeclaredAgentForwardPorts(sandboxName, recoveryPort, {
        quiet,
        runtimeSelection,
      }),
    );
    const auxiliaryResults = [
      {
        label: "the Hermes dashboard host forward",
        recovered: dashboardForwardRecovered,
      },
      {
        label: "the messaging webhook host forward",
        recovered: messagingForwardRecovered,
      },
      {
        label: "one or more agent-declared host forwards",
        recovered: declaredForwardsRecovered,
      },
    ];
    const auxiliaryFailureDetail = auxiliaryRecoveryFailureDetail(auxiliaryResults);
    if (auxiliaryFailureDetail !== null) {
      probeTiming?.setForwardAction("failed");
      if (!quiet) console.error(`  ${auxiliaryFailureDetail}.`);
      return {
        checked: true,
        wasRunning: true,
        recovered: false,
        forwardRecovered: false,
        forwardRecoveryFailed: true,
        forwardRecoveryFailureDetail: auxiliaryFailureDetail,
      };
    }
    probeTiming?.setForwardAction(
      anyAuxiliaryRecovered(auxiliaryResults) ? "restored" : "verified",
    );
    return {
      checked: true,
      wasRunning: true,
      recovered: false,
      forwardRecovered: anyAuxiliaryRecovered(auxiliaryResults),
    };
  }

  // Gateway not running — attempt recovery
  if (!quiet) {
    console.log("");
    console.log(
      `  ${recoveryDisplayName} gateway is not running inside the sandbox (sandbox likely restarted).`,
    );
    console.log("  Recovering...");
  }

  const recovery = await measureAsync(
    "processes",
    async () =>
      await recoverSandboxProcesses(sandboxName, {
        quiet,
        runtimeSelection,
      }),
  );
  if (recovery?.kind === "unsupported-provider") {
    if (!quiet) console.error(recovery.failureDetail);
    onRecoveryFailureLayer?.("unsupported agent", recovery.failureDetail);
    return {
      checked: true,
      wasRunning: false,
      recovered: false,
      forwardRecovered: false,
      recoveryFailureDetail: recovery.failureDetail,
    };
  }
  if (recovery !== null) {
    // Wait for gateway to bind its HTTP port before declaring success. The
    // recovered process can be alive before the OpenAI-compatible API is ready.
    const gatewayReady = await measureAsync("processes", () =>
      waitForRecoveredSandboxGatewayImpl(sandboxName, {
        quiet,
        initialManagedHealthPassed: false,
        runtimeSelection,
        timeoutSeconds: gatewayRecoveryTimeoutSeconds(recoveryAgent),
        managedProbeImpl: () => null,
      }),
    );
    if (!gatewayReady) {
      const recoveryFailureDetail =
        "the recovered gateway did not become responsive before the recovery timeout";
      if (!quiet) {
        console.error("  Gateway process started but is not responding.");
        await printGatewayWedgeDiagnostics(sandboxName, (name, command) =>
          executeSandboxExecCommand(
            name,
            command,
            DEFAULT_SANDBOX_EXEC_TIMEOUT_MS,
            runtimeSelection ? { runtimeSelection } : { localDockerFallbackPolicy: "read-only" },
          ),
        );
        console.error("  Check /tmp/gateway.log inside the sandbox for details.");
        printHostManagedGatewayRecoveryHints(sandboxName, recoveryAgent, null);
      }
      onRecoveryFailureLayer?.(null);
      return {
        checked: true,
        wasRunning: false,
        recovered: false,
        forwardRecovered: false,
        recoveryFailureDetail,
      };
    }
    const recoveryRequiresReadiness = recovery.kind === "provider";
    const waitForRecoveryReadiness = async () => {
      const readinessOptions: RecreatedSandboxOpenShellReadyOptions = {
        commandExecutor,
        runtimeSelection,
      };
      const readiness =
        waitForRecreatedSandboxOpenShellReadyImpl === waitForRecreatedSandboxOpenShellReady
          ? await waitForRecreatedSandboxOpenShellReadyResult(sandboxName, readinessOptions)
          : (await waitForRecreatedSandboxOpenShellReadyImpl(sandboxName, readinessOptions))
            ? ({ ready: true } as const)
            : ({
                failure: "openshell-readiness-failure",
                ready: false,
              } as const);
      return readiness.ready
        ? null
        : recreatedSandboxOpenShellReadinessFailureDetail(
            readiness.failure,
            "openshellError" in readiness ? readiness.openshellError : undefined,
          );
    };
    const readinessFailureDetail = recoveryRequiresReadiness
      ? await measureAsync("processes", waitForRecoveryReadiness)
      : null;
    if (readinessFailureDetail) {
      return {
        checked: true,
        wasRunning: false,
        recovered: false,
        forwardRecovered: false,
        recoveryFailureDetail: readinessFailureDetail,
      };
    }
    const forwardRecovered = await measureAsync("forward", () =>
      ensureSandboxPortForwardImpl(sandboxName, {
        isWsl: isWslOverride,
        runtimeSelection,
      }),
    );
    const dashboardForwardRecovered = await measureAsync("forward", () =>
      ensureHermesDashboardPortForwardIfEnabled(sandboxName, runtimeSelection),
    );
    const messagingForwardRecovered = await measureAsync("forward", () =>
      recoverMessagingHostForward(sandboxName, { quiet, runtimeSelection }),
    );
    const declaredForwardsRecovered = await measureAsync("forward", () =>
      recoverDeclaredAgentForwardPorts(sandboxName, recoveryPort, {
        quiet,
        runtimeSelection,
      }),
    );
    const auxiliaryResults = [
      {
        label: "the Hermes dashboard host forward",
        recovered: dashboardForwardRecovered,
      },
      {
        label: "the messaging webhook host forward",
        recovered: messagingForwardRecovered,
      },
      {
        label: "one or more agent-declared host forwards",
        recovered: declaredForwardsRecovered,
      },
    ];
    const auxiliaryFailureDetail = auxiliaryRecoveryFailureDetail(auxiliaryResults);
    if (!quiet) {
      console.log(`  ${G}✓${R} ${recoveryDisplayName} gateway restarted inside sandbox.`);
      if (forwardRecovered) {
        console.log(`  ${G}✓${R} Dashboard port forward re-established.`);
      } else {
        console.error("  Failed to re-establish the dashboard port forward.");
        console.error(`  Run \`nemoclaw ${sandboxName} recover\` after resolving the error.`);
      }
    }
    if (!forwardRecovered) {
      probeTiming?.setForwardAction("failed");
      return {
        checked: true,
        wasRunning: false,
        recovered: true,
        forwardRecovered: false,
        forwardRecoveryFailed: true,
        forwardRecoveryFailureDetail:
          "the primary dashboard/API host forward could not be re-established",
      };
    }
    if (auxiliaryFailureDetail !== null) {
      probeTiming?.setForwardAction("failed");
      if (!quiet) console.error(`  ${auxiliaryFailureDetail}.`);
      return {
        checked: true,
        wasRunning: false,
        recovered: true,
        forwardRecovered: false,
        forwardRecoveryFailed: true,
        forwardRecoveryFailureDetail: auxiliaryFailureDetail,
      };
    }
    probeTiming?.setForwardAction("restored");
    return {
      checked: true,
      wasRunning: false,
      recovered: true,
      forwardRecovered: forwardRecovered || anyAuxiliaryRecovered(auxiliaryResults),
    };
  }
  if (!quiet) {
    console.error(`  Could not restart ${recoveryDisplayName} gateway automatically.`);
    printHostManagedGatewayRecoveryHints(sandboxName, recoveryAgent, null);
  }

  onRecoveryFailureLayer?.(null);
  return {
    checked: true,
    wasRunning: false,
    recovered: false,
    forwardRecovered: false,
  };
}

export async function checkAndRecoverSandboxProcesses(
  sandboxName: string,
  options: {
    quiet?: boolean;
    isSandboxGatewayRunningImpl?: (
      sandboxName: string,
      runtimeSelection?: OpenShellRuntimeSelection,
    ) => Promise<boolean | null>;
    waitForRecoveredSandboxGatewayImpl?: typeof waitForRecoveredSandboxGateway;
    waitForRecreatedSandboxOpenShellReadyImpl?: typeof waitForRecreatedSandboxOpenShellReady;
    commandExecutor?: OpenShellSandboxBufferedCommandExecutor;
    isWsl?: boolean;
    onRecoveryFailureLayer?: (layer: GatewayRestartFailureLayer | null, detail?: string) => void;
    probeTiming?: ProcessRecoveryProbeTiming;
    runtimeSelection?: OpenShellRuntimeSelection;
    ensureSandboxPortForwardImpl?: typeof ensureSandboxPortForward;
    describeSandboxForwardListenerImpl?: typeof describeSandboxForwardListener;
    forwardAdapterForAuthority?: OpenShellForwardObservationAdapterFactory;
    withLifecycleLock?: typeof withSandboxLifecycleLock;
  } = {},
) {
  const { withLifecycleLock = withSandboxLifecycleLock, ...recoveryOptions } = options;
  return withLifecycleLock(sandboxName, () =>
    checkAndRecoverSandboxProcessesWithoutHostLock(sandboxName, recoveryOptions),
  );
}
