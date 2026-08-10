// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import { dockerSpawnSync } from "../../adapters/docker";
import { stripAnsi } from "../../adapters/openshell/client";
import {
  captureOpenshell,
  captureOpenshellForStatus,
  captureSandboxSshConfig,
  getOpenshellBinary,
  isCommandTimeout,
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
import { sleepSeconds, waitUntil } from "../../core/wait";
import { ROOT, shellQuote } from "../../runner";
import {
  isDirectSandboxFallbackUnavailableError,
  privilegedSandboxExecArgv,
} from "../../sandbox/privileged-exec";
import { withTimerBoundShieldsMutationLock } from "../../shields/timer-bound-lock";
import * as registry from "../../state/registry";
import { buildSubprocessEnv } from "../../subprocess-env";
import {
  ensureHermesDashboardPortForwardIfEnabled,
  ensureSandboxPortForward,
  isSandboxForwardHealthy,
  recoverDeclaredAgentForwardPorts,
  recoverMessagingHostForward,
  resolveSandboxDashboardPort,
} from "./forward-recovery";
import {
  classifyGatewayRestartFailure,
  type GatewayRestartDeps,
  type GatewayRestartFailureLayer,
  type GatewayRestartResult,
  gatewayIntegrityRepairLines,
  isGatewayIntegrityRepairLayer,
  type ManagedGatewayControlCompletion,
  parseManagedGatewayControlCompletion,
  printGatewayRestartFailure,
  type RestartSandboxGatewayOptions,
  restartSandboxGatewayWithDeps,
  sandboxAgentName,
} from "./gateway-restart";
import { printGatewayWedgeDiagnostics } from "./gateway-wedge-diagnostics";
import { enforceHermesSecretBoundaryOnRunningGateway } from "./hermes-secret-boundary-recovery";
import {
  inspectHermesMcpReconciliationRefusal,
  processRecoveryMcpReconciliationRefusal,
} from "./mcp-bridge-recovery";
import {
  buildSandboxExecMarkedCommand,
  extractSandboxExecCommandStdout,
} from "./sandbox-exec-output";
import {
  type ManagedSupervisorRelaunch,
  relaunchManagedSupervisorSession,
} from "./supervisor-relaunch";

export type { SandboxForwardHealth, SandboxForwardListEntry } from "./forward-health";
export {
  classifyForwardHealthWithReachability,
  classifySandboxForwardHealth,
} from "./forward-health";
export { resolveSandboxDashboardPort } from "./forward-recovery";
export type {
  GatewayRestartDeps,
  GatewayRestartFailureLayer,
  GatewayRestartResult,
  ManagedGatewayControlCompletion,
  RestartSandboxGatewayOptions,
} from "./gateway-restart";

export { buildSandboxExecMarkedCommand } from "./sandbox-exec-output";

export type { SandboxCommandResult, SandboxExecCommandOptions };

function commandTransportDependencies(): CommandTransportDependencies {
  return {
    buildSandboxExecMarkedCommand,
    buildSubprocessEnv,
    captureSandboxSshConfig,
    dockerSpawnSync,
    extractSandboxExecCommandStdout,
    getOpenshellBinary,
    isDirectSandboxFallbackUnavailableError,
    openshellProbeTimeoutMs: OPENSHELL_PROBE_TIMEOUT_MS,
    privilegedSandboxExecArgv,
    root: ROOT,
  };
}

type AuxiliaryRecoveryResult = {
  label: string;
  recovered: boolean | null;
};

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
  const agent = agentRuntime.getSessionAgent(sandboxName);
  if (agent && agentRuntime.hasGatewayRuntime(agent)) return agentRuntime.getHealthProbeUrl(agent);
  return `http://127.0.0.1:${resolveSandboxDashboardPort(sandboxName)}/health`;
}

/**
 * Run a command inside the sandbox via SSH and return { status, stdout, stderr }.
 * Returns null if SSH config cannot be obtained.
 */
export function executeSandboxCommand(
  sandboxName: string,
  command: string,
): SandboxCommandResult | null {
  return executeSandboxCommandTransport(commandTransportDependencies(), sandboxName, command);
}

/** Run one root controller argv against the registry-pinned direct container. */
export function executePrivilegedSandboxCommand(
  sandboxName: string,
  command: readonly string[],
  timeout: number,
  expectedContainerId?: string,
): SandboxCommandResult | null {
  const argv = privilegedSandboxExecArgv(
    sandboxName,
    [...command],
    false,
    true,
    expectedContainerId,
  );
  const result = dockerSpawnSync(argv, {
    cwd: ROOT,
    encoding: "utf-8",
    env: buildSubprocessEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
  });
  if (result.error) return null;
  return {
    status: result.status ?? 1,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
  };
}

export function executeSandboxExecCommand(
  sandboxName: string,
  command: string,
  timeout = DEFAULT_SANDBOX_EXEC_TIMEOUT_MS,
  options: SandboxExecCommandOptions = {},
): SandboxCommandResult | null {
  return executeSandboxExecCommandTransport(
    commandTransportDependencies(),
    sandboxName,
    command,
    timeout,
    options,
  );
}

function executeGatewaySupervisorActionPinned(
  sandboxName: string,
  action: "restart" | "recover" | "probe",
  timeout: number,
  expectedContainerId?: string,
): SandboxCommandResult | null {
  const nonce = randomBytes(32).toString("hex");
  let argv: string[];
  try {
    argv = privilegedSandboxExecArgv(
      sandboxName,
      ["/usr/local/bin/nemoclaw-gateway-control", action, nonce],
      false,
      true,
      expectedContainerId,
    );
  } catch (error) {
    if (isDirectSandboxFallbackUnavailableError(error)) {
      // New clones can report Ready before their labeled direct container is
      // discoverable. Keep only that typed absence retryable and sanitized;
      // identity, driver, and integrity refusals retain their detailed form.
      return {
        status: 1,
        stdout: "",
        stderr: "PRIVILEGED_CONTROL_UNAVAILABLE",
      };
    }
    const detail = error instanceof Error ? error.message : "privileged container unavailable";
    return {
      status: 1,
      stdout: "",
      stderr: `PRIVILEGED_CONTROL_UNAVAILABLE: ${detail}`,
    };
  }

  const result = dockerSpawnSync(argv, {
    cwd: ROOT,
    encoding: "utf-8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
  });
  if (result.error) return null;
  const status = result.status ?? 1;
  const stdout = String(result.stdout || "").trim();
  let stderr = String(result.stderr || "").trim();
  if (
    (status === 126 || status === 127) &&
    /(?:not found|no such file|executable file)/i.test(`${stdout}\n${stderr}`)
  ) {
    stderr = ["SUPERVISOR_REBUILD_REQUIRED", stderr].filter(Boolean).join("\n");
  }
  return { status, stdout, stderr };
}

type RequestPinnedGatewaySupervisorAction = typeof executeGatewaySupervisorActionPinned;

export function executeGatewaySupervisorAction(
  sandboxName: string,
  action: "restart" | "recover" | "probe",
  timeout = 210000,
): SandboxCommandResult | null {
  return executeGatewaySupervisorActionPinned(sandboxName, action, timeout);
}

async function executeSandboxExecCommandForStatus(
  sandboxName: string,
  command: string,
): Promise<SandboxCommandResult | null> {
  const markedCommand = buildSandboxExecMarkedCommand(command);
  const result = await captureOpenshellForStatus(
    ["sandbox", "exec", "--name", sandboxName, "--", "sh", "-c", markedCommand],
    { ignoreError: true },
  );
  if (isCommandTimeout(result) || result.error) return null;
  const commandStdout = extractSandboxExecCommandStdout(result.output || "");
  if (commandStdout === null) return null;
  return {
    status: result.status ?? 1,
    stdout: commandStdout,
    stderr: "",
  };
}

function parseSandboxGatewayProbe(result: SandboxCommandResult | null): boolean | null {
  if (!result) return null;
  if (result.stdout === "RUNNING") return true;
  if (result.stdout === "STOPPED") return false;
  return null;
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
function isSandboxGatewayRunning(sandboxName: string): boolean | null {
  const agent = agentRuntime.getSessionAgent(sandboxName);
  if (agent && !agentRuntime.hasGatewayRuntime(agent)) return null;
  const probeUrl = getSandboxHealthProbeUrl(sandboxName);
  const command = `HTTP_CODE=$(curl -so /dev/null -w '%{http_code}' --max-time 3 ${shellQuote(probeUrl)} 2>/dev/null || echo 000); case "$HTTP_CODE" in 200|401) echo RUNNING ;; *) echo STOPPED ;; esac`;
  const execProbe = parseSandboxGatewayProbe(executeSandboxExecCommand(sandboxName, command));
  if (execProbe !== null) return execProbe;

  // Built-in OpenClaw and Hermes lifecycle control is host-mediated through
  // the controller for the live topology. If the trusted sandbox-exec path is
  // unavailable or times out, do not silently cross back into the sandbox over
  // SSH just to classify the gateway and then make a privileged recovery
  // decision. Legacy custom gateway agents are the sole compatibility case:
  // their recovery contract is explicitly SSH-owned until manifests can
  // declare a trusted runtime user/supervisor.
  if (!agent || agent.name === "openclaw" || agent.name === "hermes") return null;
  return parseSandboxGatewayProbe(executeSandboxCommand(sandboxName, command));
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
function isExactlyRetryableManagedRecoveryFailure(result: SandboxCommandResult | null): boolean {
  if (result === null) return false;
  if (result.status !== 1) return false;
  if (result.stdout.trim() !== "") return false;
  const lines = result.stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length === 1 && lines[0] === "SUPERVISOR_BUSY";
}

function isExactlyMissingManagedSupervisor(result: SandboxCommandResult | null): boolean {
  if (result === null || result.status !== 1 || result.stdout.trim() !== "") return false;
  const lines = result.stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length === 1 && lines[0] === "SUPERVISOR_NOT_RUNNING";
}

function isExactlyStartingManagedSupervisor(result: SandboxCommandResult | null): boolean {
  if (result === null || result.status !== 1 || result.stdout.trim() !== "") return false;
  const lines = result.stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    (lines.length === 1 && lines[0] === "SUPERVISOR_NOT_RUNNING") ||
    (lines.length === 2 &&
      lines[0] === "SUPERVISOR_NOT_RUNNING" &&
      lines[1] === "NEMOCLAW_CONTROL_STAGE=discover-supervisor")
  );
}

function isExactlyPendingManagedSupervisorControl(result: SandboxCommandResult | null): boolean {
  if (result === null || result.status !== 1 || result.stdout.trim() !== "") return false;
  const lines = result.stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length === 1 && lines[0] === "PRIVILEGED_CONTROL_UNAVAILABLE";
}

function isExactlyPendingManagedGatewayHealth(result: SandboxCommandResult | null): boolean {
  if (result === null || result.status !== 1 || result.stdout.trim() !== "") return false;
  const lines = result.stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  // This waiter only performs read-only probes before snapshot state is
  // applied. A bare health timeout means the proven managed gateway is still
  // starting; any diagnostic or refusal beside it remains terminal.
  return lines.length === 1 && lines[0] === "GATEWAY_HEALTH_TIMEOUT";
}

export function waitForManagedGatewaySupervisor(
  sandboxName: string,
  options: {
    acceptGatewayHealthPending?: boolean;
    intervalSeconds?: number;
    maxAttempts?: number;
    onFailureResult?: (result: SandboxCommandResult | null) => void;
    requestGatewaySupervisorActionImpl?: typeof executeGatewaySupervisorAction;
    sleepImpl?: (seconds: number) => void;
  } = {},
): boolean {
  const requestGatewaySupervisorAction =
    options.requestGatewaySupervisorActionImpl ?? executeGatewaySupervisorAction;
  const sleep = options.sleepImpl ?? sleepSeconds;
  const intervalSeconds = options.intervalSeconds ?? 3;
  const maxAttempts = options.maxAttempts ?? 11;

  let lastResult: SandboxCommandResult | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = requestGatewaySupervisorAction(sandboxName, "probe", OPENSHELL_PROBE_TIMEOUT_MS);
    lastResult = result;
    if (hasGatewayRecoveryMarker(result)) return true;
    if (
      options.acceptGatewayHealthPending === true &&
      isExactlyPendingManagedGatewayHealth(result)
    ) {
      return true;
    }
    if (
      !isExactlyStartingManagedSupervisor(result) &&
      !isExactlyRetryableManagedRecoveryFailure(result) &&
      !isExactlyPendingManagedSupervisorControl(result) &&
      !isExactlyPendingManagedGatewayHealth(result)
    ) {
      options.onFailureResult?.(result);
      return false;
    }
    if (attempt < maxAttempts) sleep(intervalSeconds);
  }
  options.onFailureResult?.(lastResult);
  return false;
}

export function confirmRecoveredSandboxGatewayManaged(
  sandboxName: string,
  options: {
    getSandboxImpl?: typeof registry.getSandbox;
    getSessionAgentImpl?: typeof agentRuntime.getSessionAgent;
    requestGatewaySupervisorActionImpl?: typeof executeGatewaySupervisorAction;
  } = {},
): boolean | null {
  const getSandbox = options.getSandboxImpl ?? registry.getSandbox;
  const entry = getSandbox(sandboxName);
  if (!entry) return null;
  const persistedAgent = entry.agent ?? "openclaw";
  if (persistedAgent !== "openclaw" && persistedAgent !== "hermes") return null;

  const driver = entry.openshellDriver?.trim().toLowerCase() ?? null;
  if (driver !== null && driver !== "docker" && driver !== "vm") return null;

  const getSessionAgent = options.getSessionAgentImpl ?? agentRuntime.getSessionAgent;
  const agent = getSessionAgent(sandboxName);
  if (persistedAgent === "hermes" && agent?.name !== "hermes") return null;
  if (agent && !agentRuntime.hasGatewayRuntime(agent)) return null;
  const requestGatewaySupervisorAction =
    options.requestGatewaySupervisorActionImpl ?? executeGatewaySupervisorAction;
  const result = requestGatewaySupervisorAction(sandboxName, "probe");
  if (hasGatewayRecoveryMarker(result)) return true;
  if (result === null || isExactlyRetryableManagedRecoveryFailure(result)) return null;
  return false;
}

export async function isSandboxGatewayRunningForStatus(
  sandboxName: string,
): Promise<boolean | null> {
  const agent = agentRuntime.getSessionAgent(sandboxName);
  if (agent && !agentRuntime.hasGatewayRuntime(agent)) return null;
  const probeUrl = getSandboxHealthProbeUrl(sandboxName);
  const command = `HTTP_CODE=$(curl -so /dev/null -w '%{http_code}' --max-time 3 ${shellQuote(probeUrl)} 2>/dev/null || echo 000); case "$HTTP_CODE" in 200|401) echo RUNNING ;; *) echo STOPPED ;; esac`;
  return parseSandboxGatewayProbe(await executeSandboxExecCommandForStatus(sandboxName, command));
}

/**
 * Recover a gateway through the registered agent's managed control boundary.
 * Legacy custom agents retain their SSH-owned compatibility path. Built-in
 * agents may return a transactional supervisor relaunch that the caller must
 * commit or roll back after the managed health gate.
 */
type SandboxProcessRecovery =
  | { kind: "managed"; managedControlCompletion?: ManagedGatewayControlCompletion }
  | { kind: "custom" }
  | { kind: "relaunched"; relaunch: ManagedSupervisorRelaunch };

export type ManagedGatewayRecoveryFailure = ReturnType<typeof classifyGatewayRestartFailure>;

function managedSupervisorProbeFailure(
  sandboxName: string,
  waitForSupervisor: typeof waitForManagedGatewaySupervisor,
  requestGatewaySupervisorAction: typeof executeGatewaySupervisorAction,
  acceptGatewayHealthPending: boolean,
): ManagedGatewayRecoveryFailure | null {
  const failureResult: { current: SandboxCommandResult | null } = { current: null };
  const supervisorReady = waitForSupervisor(sandboxName, {
    acceptGatewayHealthPending,
    onFailureResult: (result) => {
      failureResult.current = result;
    },
    requestGatewaySupervisorActionImpl: requestGatewaySupervisorAction,
  });
  return supervisorReady ? null : classifyGatewayRestartFailure(failureResult.current);
}

/**
 * Re-prove the authenticated managed gateway against the exact Docker
 * container captured by lifecycle start. This is intentionally read-only and
 * is used after connect-time inference/pairing reconciliation so `start`
 * cannot return success after a same-name container swap.
 */
export function pinnedManagedGatewayProbeFailure(
  sandboxName: string,
  expectedContainerId: string,
  {
    requestPinnedGatewaySupervisorActionImpl = executeGatewaySupervisorActionPinned,
    waitForManagedGatewaySupervisorImpl = waitForManagedGatewaySupervisor,
  }: {
    requestPinnedGatewaySupervisorActionImpl?: RequestPinnedGatewaySupervisorAction;
    waitForManagedGatewaySupervisorImpl?: typeof waitForManagedGatewaySupervisor;
  } = {},
): ManagedGatewayRecoveryFailure | null {
  try {
    return managedSupervisorProbeFailure(
      sandboxName,
      waitForManagedGatewaySupervisorImpl,
      (name, action, timeout = 210000) =>
        requestPinnedGatewaySupervisorActionImpl(name, action, timeout, expectedContainerId),
      false,
    );
  } catch {
    return {
      layer: "privileged control unavailable",
      detail: "the pinned runtime identity changed during final managed gateway verification",
    };
  }
}

function strictManagedGatewayProbeFailureResult(
  sandboxName: string,
  {
    required,
    requestGatewaySupervisorAction,
    waitForSupervisor,
    wasRunning,
    onRecoveryFailure,
    onRecoveryFailureLayer,
  }: {
    required: boolean;
    requestGatewaySupervisorAction: typeof executeGatewaySupervisorAction;
    waitForSupervisor: typeof waitForManagedGatewaySupervisor;
    wasRunning: boolean;
    onRecoveryFailure?: (failure: ManagedGatewayRecoveryFailure) => void;
    onRecoveryFailureLayer?: (layer: GatewayRestartFailureLayer | null) => void;
  },
) {
  if (!required) return null;
  const failure = managedSupervisorProbeFailure(
    sandboxName,
    waitForSupervisor,
    requestGatewaySupervisorAction,
    false,
  );
  if (!failure) return null;
  onRecoveryFailure?.(failure);
  onRecoveryFailureLayer?.(failure.layer);
  return {
    checked: true as const,
    wasRunning,
    recovered: false as const,
    forwardRecovered: false as const,
    forwardRecoveryFailed: undefined,
    forwardRecoveryFailureDetail: undefined,
    managedGatewayProbeFailed: true as const,
    managedGatewayProbeFailureDetail: `${failure.layer}: ${failure.detail}`,
  };
}

function createPreservedManagedForwardVerification(
  sandboxName: string,
  {
    required,
    requestGatewaySupervisorAction,
    onRecoveryFailure,
    onRecoveryFailureLayer,
  }: {
    required: boolean;
    requestGatewaySupervisorAction: typeof executeGatewaySupervisorAction;
    onRecoveryFailure?: (failure: ManagedGatewayRecoveryFailure) => void;
    onRecoveryFailureLayer?: (layer: GatewayRestartFailureLayer | null) => void;
  },
) {
  const failureState: { current: ManagedGatewayRecoveryFailure | null } = { current: null };
  const guard = required
    ? () => {
        let probeResult: SandboxCommandResult | null = null;
        try {
          const confirmed = confirmRecoveredSandboxGatewayManaged(sandboxName, {
            requestGatewaySupervisorActionImpl: (name, action) => {
              probeResult = requestGatewaySupervisorAction(
                name,
                action,
                OPENSHELL_PROBE_TIMEOUT_MS,
              );
              return probeResult;
            },
          });
          failureState.current =
            confirmed === true ? null : classifyGatewayRestartFailure(probeResult);
          return confirmed === true;
        } catch {
          failureState.current = {
            layer: "privileged control unavailable",
            detail: "the pinned container identity changed during host-forward verification",
          };
          return false;
        }
      }
    : undefined;
  const failureResult = (wasRunning: boolean) => {
    const failure =
      failureState.current ??
      ({
        layer: "health timeout",
        detail: "the pinned managed gateway health changed during host-forward verification",
      } satisfies ManagedGatewayRecoveryFailure);
    onRecoveryFailure?.(failure);
    onRecoveryFailureLayer?.(failure.layer);
    return {
      checked: true as const,
      wasRunning,
      recovered: false as const,
      forwardRecovered: false as const,
      forwardRecoveryFailed: undefined,
      forwardRecoveryFailureDetail: undefined,
      managedGatewayProbeFailed: true as const,
      managedGatewayProbeFailureDetail: `${failure.layer}: ${failure.detail}`,
    };
  };
  return {
    guard,
    preferFailure<T>(wasRunning: boolean, fallback: T) {
      return failureState.current ? failureResult(wasRunning) : fallback;
    },
    verifySuccess<T>(wasRunning: boolean, success: T) {
      return guard && !guard() ? failureResult(wasRunning) : success;
    },
  };
}

function runningSandboxRecoveryPreflight(
  sandboxName: string,
  {
    recoveryAgent,
    requestGatewaySupervisorAction,
    requireManagedHealth,
    waitForSupervisor,
    onRecoveryFailure,
    onRecoveryFailureLayer,
  }: {
    recoveryAgent: ReturnType<typeof agentRuntime.getSessionAgent>;
    requestGatewaySupervisorAction: typeof executeGatewaySupervisorAction;
    requireManagedHealth: boolean;
    waitForSupervisor: typeof waitForManagedGatewaySupervisor;
    onRecoveryFailure?: (failure: ManagedGatewayRecoveryFailure) => void;
    onRecoveryFailureLayer?: (layer: GatewayRestartFailureLayer | null) => void;
  },
) {
  const enforcement = enforceHermesSecretBoundaryOnRunningGateway(
    sandboxName,
    recoveryAgent,
    requestGatewaySupervisorAction,
  );
  if (enforcement?.refused) {
    return {
      checked: true as const,
      wasRunning: true,
      recovered: false as const,
      forwardRecovered: false as const,
      forwardRecoveryFailed: undefined,
      forwardRecoveryFailureDetail: undefined,
      secretBoundaryRefused: true as const,
      secretBoundaryReason: enforcement.reason,
    };
  }
  const mcpRefusal = processRecoveryMcpReconciliationRefusal(sandboxName, true);
  if (mcpRefusal) return mcpRefusal;
  return strictManagedGatewayProbeFailureResult(sandboxName, {
    required: requireManagedHealth,
    requestGatewaySupervisorAction,
    waitForSupervisor,
    wasRunning: true,
    onRecoveryFailure,
    onRecoveryFailureLayer,
  });
}

function shouldUseManagedStartupRecovery(
  sandboxName: string,
  agent: ReturnType<typeof agentRuntime.getSessionAgent>,
  preserveContainer: boolean,
): boolean {
  if (!preserveContainer) return false;
  if (agent) return agent.name === "openclaw" || agent.name === "hermes";
  try {
    const persistedAgent = registry.getSandbox(sandboxName)?.agent;
    return !persistedAgent || persistedAgent === "openclaw" || persistedAgent === "hermes";
  } catch {
    return false;
  }
}

function inspectManagedStartupRecovery(
  sandboxName: string,
  agent: ReturnType<typeof agentRuntime.getSessionAgent>,
  preserveContainer: boolean,
  inspectGateway: typeof isSandboxGatewayRunning,
  waitForSupervisor: typeof waitForManagedGatewaySupervisor,
  requestGatewaySupervisorAction: typeof executeGatewaySupervisorAction,
): {
  failure: ManagedGatewayRecoveryFailure | null;
  managedStartupRecovery: boolean;
  running: boolean | null;
} {
  const running = inspectGateway(sandboxName);
  const managedStartupRecovery =
    running === null && shouldUseManagedStartupRecovery(sandboxName, agent, preserveContainer);
  return {
    failure: managedStartupRecovery
      ? managedSupervisorProbeFailure(
          sandboxName,
          waitForSupervisor,
          requestGatewaySupervisorAction,
          true,
        )
      : null,
    managedStartupRecovery,
    running,
  };
}

function recoverSandboxProcesses(
  sandboxName: string,
  {
    quiet = false,
    requestGatewaySupervisorAction = executeGatewaySupervisorAction,
    requestPinnedGatewaySupervisorAction = executeGatewaySupervisorActionPinned,
    relaunchManagedSupervisorSessionImpl = relaunchManagedSupervisorSession,
    preserveContainer = false,
    onFailure,
  }: {
    quiet?: boolean;
    requestGatewaySupervisorAction?: typeof executeGatewaySupervisorAction;
    requestPinnedGatewaySupervisorAction?: RequestPinnedGatewaySupervisorAction;
    relaunchManagedSupervisorSessionImpl?: typeof relaunchManagedSupervisorSession;
    preserveContainer?: boolean;
    onFailure?: (failure: ManagedGatewayRecoveryFailure) => void;
  } = {},
): SandboxProcessRecovery | null {
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
    onFailure?.({ layer: "unsupported agent", detail });
    quiet || printGatewayRestartFailure(sandboxName, "unsupported agent", detail);
    return null;
  }
  const recoveredSsh = (result: SandboxCommandResult | null): SandboxProcessRecovery | null =>
    result && result.status === 0 && hasGatewayRecoveryMarker(result) ? { kind: "custom" } : null;
  const recoverManagedGateway = (): SandboxProcessRecovery | null => {
    const maxAttempts = 3;
    const retryIntervalSeconds = readNonNegativeNumberEnv(
      "NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS",
      3,
    );
    let execResult: SandboxCommandResult | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      execResult = requestGatewaySupervisorAction(sandboxName, "recover");
      const managedControlCompletion = parseManagedGatewayControlCompletion(execResult);
      if (managedControlCompletion) return { kind: "managed", managedControlCompletion };
      if (hasGatewayRecoveryMarker(execResult)) return { kind: "managed" };

      // PID 1 may replace the gateway between the host's stopped observation
      // and the controller's process-tree capture. Retry only exact transient
      // controller results; integrity/config/launch refusals are terminal.
      if (!isExactlyRetryableManagedRecoveryFailure(execResult) || attempt === maxAttempts) break;
      sleepSeconds(retryIntervalSeconds);
    }
    const failure = classifyGatewayRestartFailure(execResult);
    onFailure?.(failure);
    if (
      !preserveContainer &&
      failure.layer === "supervisor not running" &&
      isExactlyMissingManagedSupervisor(execResult)
    ) {
      const relaunch = relaunchManagedSupervisorSessionImpl(sandboxName, {
        quiet,
        deps: {
          confirmMissingSupervisor: (containerId) =>
            isExactlyMissingManagedSupervisor(
              requestPinnedGatewaySupervisorAction(sandboxName, "probe", 210000, containerId),
            ),
          restartRestoredManagedGateway: (containerId) => {
            const restarted = parseManagedGatewayControlCompletion(
              requestPinnedGatewaySupervisorAction(sandboxName, "restart", 210000, containerId),
            );
            if (restarted?.disposition !== "ok") return false;
            return waitForRecoveredSandboxGateway(sandboxName, {
              quiet,
              initialManagedHealthPassed: true,
              requireManagedProbe: true,
              timeoutSeconds: gatewayRecoveryTimeoutSeconds(agent),
              managedProbeImpl: (name) =>
                confirmRecoveredSandboxGatewayManaged(name, {
                  requestGatewaySupervisorActionImpl: (name, action) =>
                    requestPinnedGatewaySupervisorAction(name, action, 210000, containerId),
                }),
            });
          },
        },
      });
      if (relaunch) return { kind: "relaunched", relaunch };
    }
    if (!quiet) printGatewayRestartFailure(sandboxName, failure.layer, failure.detail);
    return null;
  };
  if (persistedAgent === "hermes") {
    if (!isHermesAgent(agent)) {
      const detail = "Hermes agent definition could not be loaded.";
      onFailure?.({ layer: "unsupported agent", detail });
      if (!quiet) printGatewayRestartFailure(sandboxName, "unsupported agent", detail);
      return null;
    }
    return recoverManagedGateway();
  }

  // A persisted non-OpenClaw runtime whose manifest cannot be loaded is not
  // evidence that the sandbox is OpenClaw. Falling through here would run the
  // OpenClaw recovery script against an unknown custom or terminal runtime.
  // Keep legacy registry entries with no agent name on the OpenClaw fallback,
  // but fail closed for an explicit non-OpenClaw agent.
  if (persistedAgent && persistedAgent !== "openclaw" && !agent) {
    const detail = `${persistedAgent} agent definition could not be loaded.`;
    onFailure?.({ layer: "unsupported agent", detail });
    if (!quiet) printGatewayRestartFailure(sandboxName, "unsupported agent", detail);
    return null;
  }

  if ((!persistedAgent || persistedAgent === "openclaw") && (!agent || agent.name === "openclaw")) {
    return recoverManagedGateway();
  }

  const agentScript = agentRuntime.buildRecoveryScript(agent, dashboardPort);
  if (agentRuntime.isTerminalAgentRecoveryScript(agentScript)) return null;
  if (agentScript) {
    // Non-Hermes custom manifests do not yet declare a supported host-side
    // runtime user. Recover them over SSH so the launch inherits the sandbox
    // login user instead of creating root-owned agent state under /sandbox.
    return recoveredSsh(executeSandboxCommand(sandboxName, agentScript));
  }

  return null;
}

export function restartSandboxGateway(
  sandboxName: string,
  { quiet = false, deps = {} }: RestartSandboxGatewayOptions = {},
): GatewayRestartResult {
  return withTimerBoundShieldsMutationLock(sandboxName, "gateway restart", () =>
    restartSandboxGatewayWithDeps(sandboxName, {
      quiet,
      deps: {
        getSessionAgent: agentRuntime.getSessionAgent,
        getSandbox: registry.getSandbox,
        resolveSandboxDashboardPort,
        requestGatewaySupervisorAction: executeGatewaySupervisorAction,
        executeSandboxExecCommand,
        waitForRecoveredSandboxGateway: (name, options) =>
          waitForRecoveredSandboxGateway(name, {
            ...options,
            initialManagedHealthPassed: true,
            timeoutSeconds: gatewayRecoveryTimeoutSeconds(agentRuntime.getSessionAgent(name)),
            managedProbeImpl: (sandboxName) =>
              confirmRecoveredSandboxGatewayManaged(sandboxName, {
                requestGatewaySupervisorActionImpl:
                  deps.requestGatewaySupervisorAction ?? executeGatewaySupervisorAction,
              }),
          }),
        ensureSandboxPortForward,
        ensureHermesDashboardPortForwardIfEnabled,
        recoverMessagingHostForward,
        recoverDeclaredAgentForwardPorts,
        printGatewayWedgeDiagnostics,
        inspectHermesMcpReconciliationRefusal,
        ...deps,
      },
    }),
  );
}

function readNonNegativeNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
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
  return stripAnsi(value).replace(/[×│]/gu, " ").replace(/\s+/gu, " ").trim();
}

function hasRetryableOpenshellFailureShape(result: ReturnType<typeof captureOpenshell>): boolean {
  return result.status === 1 && !result.error && String(result.stderr ?? "").trim() !== "";
}

function isRetryableOpenshellReRegistrationState(
  result: ReturnType<typeof captureOpenshell>,
  sandboxName: string,
): boolean {
  if (!hasRetryableOpenshellFailureShape(result)) return false;
  const error = normalizeOpenshellStructuredError(String(result.stderr));
  // OpenShell can publish Ready before replacement registration settles.
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
  if (String(result.stdout ?? "").trim() !== "") return false;
  if (error === OPENSHELL_SANDBOX_NOT_READY) return true;

  // OpenShell 0.0.85 can keep the recreated sandbox's cached phase at Ready
  // while its replacement supervisor session is still registering. The exec
  // RPC can fail before a session connects, after a session disconnects, while
  // the replacement supervisor's local SSH relay target is starting, or after
  // the session connects but does not claim its reverse relay within OpenShell's
  // 10-second relay deadline. These exact results are control-plane
  // re-registration states; all other OpenShell failures remain terminal.
  // NemoClaw cannot repair this OpenShell-owned phase/session state without
  // bypassing the control plane. Remove these matches when supported OpenShell
  // versions publish Ready only after the replacement session and relay are
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
  captureOpenshellImpl?: typeof captureOpenshell;
  beforeProbe?: (timeoutMs: number) => boolean | null;
  intervalSeconds?: number;
  nowImpl?: () => number;
  sleepImpl?: (seconds: number) => void;
  timeoutSeconds?: number;
};

function recreatedSandboxOpenShellReadinessFailureDetail(
  failure: RecreatedSandboxOpenShellReadinessFailure,
  openshellError?: string,
  managedHealthFailureDetail?: string,
): string {
  const detail = (() => {
    switch (failure) {
      case "managed-health-definitive-failure":
        return "the sandbox failed the managed health guard, so the primary dashboard/API host forward was not started";
      case "managed-health-inconclusive-timeout":
        return "the sandbox managed health guard stayed inconclusive within the readiness deadline, so the primary dashboard/API host forward was not started";
      case "openshell-readiness-failure":
        return "the sandbox did not become ready in OpenShell, so the primary dashboard/API host forward was not started";
    }
  })();
  const managedHealthResult = managedHealthFailureDetail
    ? ` Managed health result: ${managedHealthFailureDetail}`
    : "";
  const openshellResult = openshellError
    ? ` Last OpenShell readiness error: ${openshellError}`
    : "";
  return `${detail}${managedHealthResult}${openshellResult}`;
}

// Default seconds to wait for OpenShell to re-register a recreated sandbox as
// Ready before giving up and surfacing the manual-recover hint. Aligned with
// `connect`'s readiness budget (`waitForSandboxReadyOrExit` defaults to 120s):
// both prove the same post-recreate sandbox readiness, but this path used to
// give up 4x sooner (30s), so a cold-start `phase: Error` settling window that
// exceeded 30s but was within `connect`'s 120s left the primary dashboard/API
// forward unstarted — exactly why `connect --probe-only` recovers what `start`
// abandons (#7227). Env-tunable via NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS.
const GATEWAY_RECOVERY_WAIT_DEFAULT_SECONDS = 120;

/**
 * Wait until OpenShell has re-registered a directly recreated sandbox as
 * ready. This probe deliberately has no direct-Docker or SSH fallback: it is
 * proving the control-plane readiness that gates state restoration and the
 * replacement-container commit.
 */
function waitForRecreatedSandboxOpenShellReadyResult(
  sandboxName: string,
  options: RecreatedSandboxOpenShellReadyOptions = {},
): RecreatedSandboxOpenShellReadinessResult {
  const capture = options.captureOpenshellImpl ?? captureOpenshell;
  const now = options.nowImpl ?? Date.now;
  const sleep = options.sleepImpl ?? sleepSeconds;
  const requestedTimeoutSeconds =
    typeof options.timeoutSeconds === "number" &&
    Number.isFinite(options.timeoutSeconds) &&
    options.timeoutSeconds >= 0
      ? options.timeoutSeconds
      : GATEWAY_RECOVERY_WAIT_DEFAULT_SECONDS;
  const timeoutSeconds = readNonNegativeNumberEnv(
    "NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS",
    requestedTimeoutSeconds,
  );
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
    const result = capture(["sandbox", "exec", "--name", sandboxName, "--", "true"], {
      ignoreError: true,
      includeStderr: true,
      includeStreams: true,
      timeout: Math.max(1, Math.min(OPENSHELL_PROBE_TIMEOUT_MS, remainingMs)),
    });
    if (result.status === 0 && !result.error) return { ready: true };
    const openshellError = normalizeOpenshellStructuredError(String(result.stderr ?? ""));
    if (openshellError) lastOpenshellError = openshellError;
    // This probe executes only `true`, so an OpenShell process timeout has no
    // mutation outcome to reconcile. Treat that exact timeout as inconclusive
    // and retry behind the pinned managed-health guard on the next iteration.
    // All other unexpected OpenShell failures remain definitive.
    if (
      !isRetryableOpenshellReRegistrationState(result, sandboxName) &&
      !isCommandTimeout(result)
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

export function waitForRecreatedSandboxOpenShellReady(
  sandboxName: string,
  options: RecreatedSandboxOpenShellReadyOptions = {},
): boolean {
  return waitForRecreatedSandboxOpenShellReadyResult(sandboxName, options).ready;
}

type ManagedGatewayProbeRequest = (
  sandboxName: string,
  action: "restart" | "recover" | "probe",
  timeout?: number,
) => SandboxCommandResult | null;

function managedStartupOpenShellReadinessFailureDetail(
  sandboxName: string,
  requestManagedProbe: ManagedGatewayProbeRequest,
  waitForOpenShellReady: typeof waitForRecreatedSandboxOpenShellReady,
): string | null {
  let managedHealthFailureDetail: string | null = null;
  const readinessOptions: RecreatedSandboxOpenShellReadyOptions = {
    beforeProbe: (timeoutMs) => {
      let probeResult: SandboxCommandResult | null = null;
      try {
        const confirmed = confirmRecoveredSandboxGatewayManaged(sandboxName, {
          requestGatewaySupervisorActionImpl: (name, action) => {
            probeResult = requestManagedProbe(name, action, timeoutMs);
            return probeResult;
          },
        });
        if (confirmed === false) {
          const failure = classifyGatewayRestartFailure(probeResult);
          managedHealthFailureDetail = `${failure.layer}: ${failure.detail}`;
        } else if (confirmed === true) {
          managedHealthFailureDetail = null;
        }
        return confirmed;
      } catch {
        managedHealthFailureDetail =
          "the existing sandbox identity changed during its managed readiness probe";
        return false;
      }
    },
  };
  const readiness =
    waitForOpenShellReady === waitForRecreatedSandboxOpenShellReady
      ? waitForRecreatedSandboxOpenShellReadyResult(sandboxName, readinessOptions)
      : waitForOpenShellReady(sandboxName, readinessOptions)
        ? ({ ready: true } as const)
        : ({ failure: "openshell-readiness-failure", ready: false } as const);
  return readiness.ready
    ? null
    : recreatedSandboxOpenShellReadinessFailureDetail(
        readiness.failure,
        "openshellError" in readiness ? readiness.openshellError : undefined,
        readiness.failure === "managed-health-definitive-failure"
          ? (managedHealthFailureDetail ?? undefined)
          : undefined,
      );
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
  // A drifted protected config and a quarantined supervisor both refuse every
  // relaunch deterministically, so the generic "retry the managed restart" hint
  // below would send the operator into a loop that cannot succeed (#7801).
  if (isGatewayIntegrityRepairLayer(failureLayer)) {
    for (const line of gatewayIntegrityRepairLines(quotedSandboxName, failureLayer)) {
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

function confirmManagedGatewayWithinSettleWindow(
  sandboxName: string,
  managedProbe: (sandboxName: string) => boolean | null,
  sleep: (seconds: number) => void,
  settleSeconds: number,
  intervalSeconds: number,
): boolean {
  const retryLeadSeconds =
    intervalSeconds > 0 ? Math.min(intervalSeconds, settleSeconds) : settleSeconds;
  const beforeDeadlineSeconds = settleSeconds - retryLeadSeconds;
  if (beforeDeadlineSeconds > 0) sleep(beforeDeadlineSeconds);

  const beforeDeadlineResult = managedProbe(sandboxName);
  if (beforeDeadlineResult === false) return false;
  if (retryLeadSeconds > 0) sleep(retryLeadSeconds);
  const atDeadlineResult = managedProbe(sandboxName);
  if (atDeadlineResult !== null) return atDeadlineResult;
  return beforeDeadlineResult === true;
}

export function waitForRecoveredSandboxGateway(
  sandboxName: string,
  options: {
    managedProbeImpl?: (sandboxName: string) => boolean | null;
    initialManagedHealthPassed?: boolean;
    probeImpl?: (sandboxName: string) => boolean | null;
    sleepImpl?: (seconds: number) => void;
    quiet?: boolean;
    timeoutSeconds?: number;
    requireManagedProbe?: boolean;
  } = {},
): boolean {
  const probe = options.probeImpl ?? isSandboxGatewayRunning;
  const managedProbe =
    options.managedProbeImpl ?? (options.probeImpl ? null : confirmRecoveredSandboxGatewayManaged);
  const sleep = options.sleepImpl ?? sleepSeconds;
  const requestedTimeoutSeconds =
    typeof options.timeoutSeconds === "number" &&
    Number.isFinite(options.timeoutSeconds) &&
    options.timeoutSeconds >= 0
      ? options.timeoutSeconds
      : GATEWAY_RECOVERY_WAIT_DEFAULT_SECONDS;
  const timeoutSeconds = readNonNegativeNumberEnv(
    "NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS",
    requestedTimeoutSeconds,
  );
  const intervalSeconds = readNonNegativeNumberEnv(
    "NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS",
    3,
  );
  const attempts =
    intervalSeconds > 0
      ? Math.max(1, Math.floor(timeoutSeconds / intervalSeconds) + 1)
      : Math.max(1, Math.floor(timeoutSeconds) + 1);

  const probeDuringRecoveryWait = () => {
    const managedResult = managedProbe?.(sandboxName) ?? null;
    if (managedResult !== null) return managedResult;
    if (options.requireManagedProbe) return false;
    return probe(sandboxName);
  };

  // A successful managed restart/recover marker is already emitted only after
  // the controller proves the exact child, listener, HTTP health, and declared
  // auxiliaries from inside the gateway network namespace. Trust that as the
  // initial observation; the settle check below still independently re-proves
  // health and catches a delayed #4710 wedge.
  const initialManagedHealthPassed = options.initialManagedHealthPassed === true;
  const recovered =
    initialManagedHealthPassed ||
    waitUntil(() => probeDuringRecoveryWait() === true, {
      initialIntervalMs: intervalSeconds * 1000,
      maxIntervalMs: intervalSeconds * 1000,
      backoffFactor: 1,
      maxAttempts: attempts,
      sleep: (ms) => sleep(ms / 1000),
    });
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
    return confirmManagedGatewayWithinSettleWindow(
      sandboxName,
      managedProbe,
      sleep,
      settleSeconds,
      intervalSeconds,
    );
  }
  sleep(settleSeconds);
  // A stopped HTTP probe is still only a point-in-time observation. PID 1 can
  // have respawned the gateway while OpenClaw is still finishing its startup
  // transition, so multiple stopped results may precede a healthy listener.
  // Give stopped and inconclusive probes the same bounded recovery window.
  // A persistent #4710 wedge still fails closed when that window expires.
  return waitUntil(() => probeDuringRecoveryWait() === true, {
    initialIntervalMs: intervalSeconds * 1000,
    maxIntervalMs: intervalSeconds * 1000,
    backoffFactor: 1,
    maxAttempts: attempts,
    sleep: (ms) => sleep(ms / 1000),
  });
}

function isHermesAgent(
  agent: ReturnType<typeof agentRuntime.getSessionAgent>,
): agent is NonNullable<ReturnType<typeof agentRuntime.getSessionAgent>> & { name: "hermes" } {
  return !!agent && agent.name === "hermes";
}

function isTerminalRecoveryAgent(agent: ReturnType<typeof agentRuntime.getSessionAgent>): boolean {
  return !!agent && !agentRuntime.hasGatewayRuntime(agent);
}

/**
 * Detect and recover from a sandbox that survived a gateway restart but
 * whose OpenClaw processes are not running. Also re-establishes the
 * host-side dashboard port-forward when it has gone dead independently
 * of the gateway. Returns an object describing the outcome:
 * `{ checked, wasRunning, recovered, forwardRecovered, forwardRecoveryFailed?, secretBoundaryRefused?, secretBoundaryReason? }`.
 * `onRecoveryFailureLayer` reports the classified managed-restart failure so a
 * quiet caller (`recover`, `connect --probe-only`) can still explain why
 * recovery is not retryable instead of printing a generic "check the gateway
 * log". `onRecoveryFailure` retains the sanitized controller detail for
 * startup callers without changing the long-standing result shape.
 */
export interface SandboxProcessRecoveryOptions {
  /** Immutable direct-container identity captured by lifecycle `start`. */
  expectedContainerId?: string;
  quiet?: boolean;
  requestGatewaySupervisorAction?: typeof executeGatewaySupervisorAction;
  requestPinnedGatewaySupervisorAction?: RequestPinnedGatewaySupervisorAction;
  relaunchManagedSupervisorSessionImpl?: typeof relaunchManagedSupervisorSession;
  isSandboxGatewayRunningImpl?: typeof isSandboxGatewayRunning;
  waitForRecreatedSandboxOpenShellReadyImpl?: typeof waitForRecreatedSandboxOpenShellReady;
  waitForManagedGatewaySupervisorImpl?: typeof waitForManagedGatewaySupervisor;
  isWsl?: boolean;
  onRecoveryFailure?: (failure: ManagedGatewayRecoveryFailure) => void;
  onRecoveryFailureLayer?: (layer: GatewayRestartFailureLayer | null) => void;
  /**
   * Recover only through the supervisor in the already-started container.
   * This mode never authorizes the legacy transactional container-relaunch
   * fallback and may use the pinned managed controller while OpenShell exec is
   * still gated on Provisioning.
   */
  preserveContainer?: boolean;
}

function checkAndRecoverSandboxProcessesWithoutHostLock(
  sandboxName: string,
  {
    expectedContainerId,
    quiet = false,
    requestGatewaySupervisorAction = executeGatewaySupervisorAction,
    requestPinnedGatewaySupervisorAction = executeGatewaySupervisorActionPinned,
    relaunchManagedSupervisorSessionImpl = relaunchManagedSupervisorSession,
    isSandboxGatewayRunningImpl = isSandboxGatewayRunning,
    waitForRecreatedSandboxOpenShellReadyImpl = waitForRecreatedSandboxOpenShellReady,
    waitForManagedGatewaySupervisorImpl = waitForManagedGatewaySupervisor,
    isWsl: isWslOverride,
    onRecoveryFailure,
    onRecoveryFailureLayer,
    preserveContainer = false,
  }: SandboxProcessRecoveryOptions = {},
) {
  const recoveryAgent = agentRuntime.getSessionAgent(sandboxName);
  const recoveryDisplayName = recoveryAgentDisplayName(sandboxName, recoveryAgent);
  if (isTerminalRecoveryAgent(recoveryAgent)) {
    return {
      checked: true,
      wasRunning: null,
      recovered: false,
      forwardRecovered: false,
      runtime: "terminal" as const,
    };
  }
  const requestManagedAction: typeof executeGatewaySupervisorAction = expectedContainerId
    ? (name, action, timeout = 210000) =>
        requestPinnedGatewaySupervisorAction(name, action, timeout, expectedContainerId)
    : requestGatewaySupervisorAction;
  const requirePreservedManagedHealth = shouldUseManagedStartupRecovery(
    sandboxName,
    recoveryAgent,
    preserveContainer,
  );
  const preservedManagedForwardVerification = createPreservedManagedForwardVerification(
    sandboxName,
    {
      required: requirePreservedManagedHealth,
      requestGatewaySupervisorAction: requestManagedAction,
      onRecoveryFailure,
      onRecoveryFailureLayer,
    },
  );
  const preservedManagedForwardGuard = preservedManagedForwardVerification.guard;
  const startupInspection = inspectManagedStartupRecovery(
    sandboxName,
    recoveryAgent,
    preserveContainer,
    isSandboxGatewayRunningImpl,
    waitForManagedGatewaySupervisorImpl,
    requestManagedAction,
  );
  const { managedStartupRecovery, running } = startupInspection;
  if (startupInspection.failure) {
    // OpenShell v0.0.99+ keeps exec gated while its authenticated supervisor
    // session is still Provisioning. Use the registry-pinned root controller
    // as the startup barrier so recovery does not wait on the readiness state
    // it is responsible for establishing. A bare managed health timeout is
    // accepted only as proof of the pinned OpenShell PID 1, its non-root
    // NemoClaw supervisor child, and successful managed preflight. It does not
    // prove OpenShell session readiness; the read-only readiness gate after
    // gateway recovery does that before any host-forward mutation.
    onRecoveryFailure?.(startupInspection.failure);
    onRecoveryFailureLayer?.(startupInspection.failure.layer);
    return {
      checked: false,
      wasRunning: null,
      recovered: false,
      forwardRecovered: false,
      managedSupervisorUnavailable: true,
      managedSupervisorFailureDetail: `${startupInspection.failure.layer}: ${startupInspection.failure.detail}`,
    };
  }
  if (running === null && !managedStartupRecovery) {
    return { checked: false, wasRunning: null, recovered: false, forwardRecovered: false };
  }
  const recoveryPort = resolveSandboxDashboardPort(sandboxName);
  const runningPreflightFailure = running
    ? runningSandboxRecoveryPreflight(sandboxName, {
        recoveryAgent,
        requestGatewaySupervisorAction: requestManagedAction,
        requireManagedHealth: requirePreservedManagedHealth,
        waitForSupervisor: waitForManagedGatewaySupervisorImpl,
        onRecoveryFailure,
        onRecoveryFailureLayer,
      })
    : null;
  if (runningPreflightFailure) return runningPreflightFailure;
  if (running) {
    // Gateway is alive but the host-side forward can still be dead or
    // owned by another sandbox. Probe and re-establish only when
    // necessary so the live-and-healthy path stays a no-op.
    const forwardHealthy = isSandboxForwardHealthy(sandboxName, { isWsl: isWslOverride });
    if (forwardHealthy === false) {
      if (!quiet) {
        console.log("");
        console.log(`  Dashboard port forward to '${sandboxName}' is missing or dead.`);
        console.log("  Re-establishing...");
      }
      const forwardRecovered = ensureSandboxPortForward(sandboxName, {
        afterSuccess: preservedManagedForwardGuard,
        beforeStart: preservedManagedForwardGuard,
        isWsl: isWslOverride,
      });
      const dashboardForwardRecovered = ensureHermesDashboardPortForwardIfEnabled(sandboxName, {
        afterSuccess: preservedManagedForwardGuard,
        beforeStart: preservedManagedForwardGuard,
      });
      const messagingForwardRecovered = recoverMessagingHostForward(sandboxName, {
        afterSuccess: preservedManagedForwardGuard,
        beforeStart: preservedManagedForwardGuard,
        quiet,
      });
      const declaredForwardsRecovered = recoverDeclaredAgentForwardPorts(
        sandboxName,
        recoveryPort,
        {
          afterSuccess: preservedManagedForwardGuard,
          beforeStart: preservedManagedForwardGuard,
          quiet,
        },
      );
      const auxiliaryResults = [
        { label: "the Hermes dashboard host forward", recovered: dashboardForwardRecovered },
        { label: "the messaging webhook host forward", recovered: messagingForwardRecovered },
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
          console.error(
            `  Run \`openshell forward start --background ${recoveryPort} ${sandboxName}\` manually.`,
          );
        }
      }
      if (!forwardRecovered) {
        return preservedManagedForwardVerification.preferFailure(true, {
          checked: true as const,
          wasRunning: true,
          recovered: false as const,
          forwardRecovered: false as const,
          forwardRecoveryFailed: true as const,
          forwardRecoveryFailureDetail:
            "the primary dashboard/API host forward could not be re-established",
        });
      }
      if (auxiliaryFailureDetail !== null) {
        if (!quiet) console.error(`  ${auxiliaryFailureDetail}.`);
        return preservedManagedForwardVerification.preferFailure(true, {
          checked: true as const,
          wasRunning: true,
          recovered: false as const,
          forwardRecovered: false as const,
          forwardRecoveryFailed: true as const,
          forwardRecoveryFailureDetail: auxiliaryFailureDetail,
        });
      }
      return preservedManagedForwardVerification.verifySuccess(true, {
        checked: true as const,
        wasRunning: true,
        recovered: false as const,
        forwardRecovered: forwardRecovered || anyAuxiliaryRecovered(auxiliaryResults),
      });
    }
    if (forwardHealthy === "occupied") {
      if (!quiet) {
        console.log("");
        console.error(`  Dashboard port forward for '${sandboxName}' is owned by another sandbox.`);
        console.error("  Leaving the existing port forward unchanged.");
      }
      return {
        checked: true,
        wasRunning: true,
        recovered: false,
        forwardRecovered: false,
        forwardRecoveryFailed: true,
        forwardRecoveryFailureDetail:
          "the primary dashboard/API host forward is owned by another sandbox",
      };
    }
    if (forwardHealthy === null) {
      return {
        checked: true,
        wasRunning: true,
        recovered: false,
        forwardRecovered: false,
        forwardRecoveryFailed: true,
        forwardRecoveryFailureDetail:
          "the primary dashboard/API host forward could not be verified because OpenShell forward state was unavailable",
      };
    }
    const dashboardForwardRecovered = ensureHermesDashboardPortForwardIfEnabled(sandboxName, {
      afterSuccess: preservedManagedForwardGuard,
      beforeStart: preservedManagedForwardGuard,
    });
    const messagingForwardRecovered = recoverMessagingHostForward(sandboxName, {
      afterSuccess: preservedManagedForwardGuard,
      beforeStart: preservedManagedForwardGuard,
      quiet,
    });
    const declaredForwardsRecovered = recoverDeclaredAgentForwardPorts(sandboxName, recoveryPort, {
      afterSuccess: preservedManagedForwardGuard,
      beforeStart: preservedManagedForwardGuard,
      quiet,
    });
    const auxiliaryResults = [
      { label: "the Hermes dashboard host forward", recovered: dashboardForwardRecovered },
      { label: "the messaging webhook host forward", recovered: messagingForwardRecovered },
      { label: "one or more agent-declared host forwards", recovered: declaredForwardsRecovered },
    ];
    const auxiliaryFailureDetail = auxiliaryRecoveryFailureDetail(auxiliaryResults);
    if (auxiliaryFailureDetail !== null) {
      if (!quiet) console.error(`  ${auxiliaryFailureDetail}.`);
      return preservedManagedForwardVerification.preferFailure(true, {
        checked: true as const,
        wasRunning: true,
        recovered: false as const,
        forwardRecovered: false as const,
        forwardRecoveryFailed: true as const,
        forwardRecoveryFailureDetail: auxiliaryFailureDetail,
      });
    }
    return preservedManagedForwardVerification.verifySuccess(true, {
      checked: true as const,
      wasRunning: true,
      recovered: false as const,
      forwardRecovered: anyAuxiliaryRecovered(auxiliaryResults),
    });
  }

  // Gateway not running — attempt recovery
  if (!quiet) {
    console.log("");
    console.log(
      `  ${recoveryDisplayName} gateway is not running inside the sandbox (sandbox likely restarted).`,
    );
    console.log("  Recovering...");
  }

  const managedRecoveryFailureState: { current: ManagedGatewayRecoveryFailure | null } = {
    current: null,
  };
  const recovery = recoverSandboxProcesses(sandboxName, {
    quiet,
    requestGatewaySupervisorAction: requestManagedAction,
    requestPinnedGatewaySupervisorAction,
    relaunchManagedSupervisorSessionImpl,
    preserveContainer,
    onFailure: (failure) => {
      managedRecoveryFailureState.current = failure;
    },
  });
  const managedRecoveryFailure = managedRecoveryFailureState.current;
  const managedRecoveryFailureLayer = managedRecoveryFailure?.layer ?? null;
  if (recovery !== null) {
    const withManagedControlCompletion = <T extends { recovered: true }>(
      result: T,
    ): T | (T & { managedControlCompletion: ManagedGatewayControlCompletion }) =>
      recovery.kind === "managed" && recovery.managedControlCompletion
        ? { ...result, managedControlCompletion: recovery.managedControlCompletion }
        : result;
    const relaunch = recovery.kind === "relaunched" ? recovery.relaunch : null;
    const requestManagedProbe = relaunch
      ? (name: string, action: "restart" | "recover" | "probe", timeout = 210000) =>
          requestPinnedGatewaySupervisorAction(name, action, timeout, relaunch.containerId)
      : requestManagedAction;
    let relaunchedIdentityRejected = false;
    let relaunchedManagedHealthFailureDetail: string | null = null;
    const confirmRelaunchedManagedHealth = relaunch
      ? (timeout = OPENSHELL_PROBE_TIMEOUT_MS) => {
          let probeResult: SandboxCommandResult | null = null;
          try {
            const confirmed = confirmRecoveredSandboxGatewayManaged(sandboxName, {
              requestGatewaySupervisorActionImpl: (name, action) => {
                probeResult = requestManagedProbe(name, action, timeout);
                return probeResult;
              },
            });
            if (confirmed === false) {
              relaunchedIdentityRejected = true;
              const failure = classifyGatewayRestartFailure(probeResult);
              relaunchedManagedHealthFailureDetail = `${failure.layer}: ${failure.detail}`;
            } else if (confirmed === true) {
              relaunchedManagedHealthFailureDetail = null;
            }
            return confirmed;
          } catch {
            relaunchedIdentityRejected = true;
            relaunchedManagedHealthFailureDetail =
              "the pinned replacement sandbox identity changed during the managed probe";
            return false;
          }
        }
      : null;
    const confirmRelaunchedManagedHealthForForward = relaunch
      ? () => confirmRelaunchedManagedHealth?.() === true
      : null;
    // Wait for gateway to bind its HTTP port before declaring success. The
    // recovered process can be alive before the OpenAI-compatible API is ready.
    let gatewayReady = false;
    try {
      gatewayReady = waitForRecoveredSandboxGateway(sandboxName, {
        quiet,
        initialManagedHealthPassed: recovery.kind === "managed",
        requireManagedProbe: recovery.kind === "relaunched",
        timeoutSeconds: gatewayRecoveryTimeoutSeconds(recoveryAgent),
        managedProbeImpl: relaunch
          ? () => confirmRelaunchedManagedHealth?.(210000) ?? null
          : (name) =>
              confirmRecoveredSandboxGatewayManaged(name, {
                requestGatewaySupervisorActionImpl: requestManagedProbe,
              }),
      });
    } catch (error) {
      try {
        relaunch?.finalize(false);
      } catch {
        // Preserve the original recovery error; the failure path below will
        // direct the operator to inspect/rebuild the sandbox.
      }
      throw error;
    }
    if (!gatewayReady) {
      let rolledBack = true;
      if (relaunch) {
        try {
          rolledBack = relaunch.finalize(false).rolledBack;
        } catch {
          rolledBack = false;
        }
      }
      if (!quiet) {
        console.error("  Gateway process started but is not responding.");
        printGatewayWedgeDiagnostics(sandboxName, executeSandboxExecCommand);
        console.error("  Check /tmp/gateway.log inside the sandbox for details.");
        if (!rolledBack) {
          console.error(
            "  Automatic rollback of the previous sandbox container failed; inspect Docker state before retrying.",
          );
        }
        printHostManagedGatewayRecoveryHints(
          sandboxName,
          recoveryAgent,
          managedRecoveryFailureLayer,
        );
      }
      onRecoveryFailureLayer?.(managedRecoveryFailureLayer);
      onRecoveryFailure?.(
        managedRecoveryFailure ?? {
          layer: "health timeout",
          detail: "the managed gateway did not pass health verification",
        },
      );
      if (relaunchedManagedHealthFailureDetail) {
        return {
          checked: true,
          wasRunning: false,
          recovered: false,
          forwardRecovered: false,
          forwardRecoveryFailed: true,
          forwardRecoveryFailureDetail: `the recreated sandbox failed the managed health guard while waiting for its gateway. Managed health result: ${relaunchedManagedHealthFailureDetail}`,
        };
      }
      return { checked: true, wasRunning: false, recovered: false, forwardRecovered: false };
    }
    if (managedStartupRecovery) {
      const readinessFailureDetail = managedStartupOpenShellReadinessFailureDetail(
        sandboxName,
        requestManagedProbe,
        waitForRecreatedSandboxOpenShellReadyImpl,
      );
      if (readinessFailureDetail) {
        return {
          checked: true,
          wasRunning: false,
          recovered: false,
          forwardRecovered: false,
          openshellReadinessFailed: true,
          openshellReadinessFailureDetail: readinessFailureDetail,
        };
      }
    }
    // State restore crosses the OpenShell SSH boundary. Prove the replacement
    // is both identity-pinned and registered before asking finalize(true) to
    // mutate it; otherwise a slow control-plane handoff can make a healthy
    // replacement look like a failed restore and trigger rollback.
    const readinessFailureDetail = relaunch
      ? (() => {
          const readinessOptions: RecreatedSandboxOpenShellReadyOptions = {
            beforeProbe: (timeoutMs) => confirmRelaunchedManagedHealth?.(timeoutMs) ?? null,
          };
          const readiness =
            waitForRecreatedSandboxOpenShellReadyImpl === waitForRecreatedSandboxOpenShellReady
              ? waitForRecreatedSandboxOpenShellReadyResult(sandboxName, readinessOptions)
              : waitForRecreatedSandboxOpenShellReadyImpl(sandboxName, readinessOptions)
                ? ({ ready: true } as const)
                : ({ failure: "openshell-readiness-failure", ready: false } as const);
          return readiness.ready
            ? null
            : recreatedSandboxOpenShellReadinessFailureDetail(
                readiness.failure,
                "openshellError" in readiness ? readiness.openshellError : undefined,
                readiness.failure === "managed-health-definitive-failure"
                  ? (relaunchedManagedHealthFailureDetail ?? undefined)
                  : undefined,
              );
        })()
      : null;
    if (readinessFailureDetail) {
      try {
        relaunch?.finalize(false);
      } catch {
        // The readiness error remains authoritative. The detail below directs
        // the operator to the failed replacement without trusting it.
      }
      return {
        checked: true,
        wasRunning: false,
        recovered: false,
        forwardRecovered: false,
        forwardRecoveryFailed: true,
        forwardRecoveryFailureDetail: readinessFailureDetail,
      };
    }
    if (relaunch) {
      try {
        const completion = relaunch.finalize(true);
        if (completion.stateRestored === false || completion.rolledBack) {
          if (!quiet) {
            console.error(
              completion.rolledBack
                ? "  Sandbox recovery did not complete; the previous container was restored."
                : "  Sandbox recovery failed and the previous container could not be restored automatically.",
            );
            if (completion.rolledBack && completion.stateBackupRemoved === false) {
              console.error("  Warning: the temporary sandbox state backup could not be removed.");
            }
            if (!completion.rolledBack) {
              printHostManagedGatewayRecoveryHints(
                sandboxName,
                recoveryAgent,
                managedRecoveryFailureLayer,
              );
            }
          }
          return {
            checked: true,
            wasRunning: false,
            recovered: false,
            forwardRecovered: false,
          };
        }
        if (!completion.backupRemoved && !quiet) {
          console.error(
            "  Warning: the recovered sandbox is healthy, but its previous container backup could not be removed.",
          );
        }
        if (completion.stateBackupRemoved === false && !quiet) {
          console.error(
            "  Warning: the recovered sandbox is healthy, but its temporary state backup could not be removed.",
          );
        }
      } catch {
        if (!quiet) {
          console.error(
            "  Warning: the recovered sandbox is healthy, but container transaction cleanup could not be confirmed.",
          );
        }
      }
    }
    const mcpRefusal = processRecoveryMcpReconciliationRefusal(sandboxName, false);
    if (mcpRefusal) return mcpRefusal;
    const managedProbeFailure = strictManagedGatewayProbeFailureResult(sandboxName, {
      required: requirePreservedManagedHealth,
      requestGatewaySupervisorAction: requestManagedProbe,
      waitForSupervisor: waitForManagedGatewaySupervisorImpl,
      wasRunning: false,
      onRecoveryFailure,
      onRecoveryFailureLayer,
    });
    if (managedProbeFailure) return managedProbeFailure;
    const managedForwardGuard =
      confirmRelaunchedManagedHealthForForward ?? preservedManagedForwardGuard;
    const forwardRecovered = ensureSandboxPortForward(sandboxName, {
      afterSuccess: managedForwardGuard,
      beforeStart: managedForwardGuard,
      isWsl: isWslOverride,
    });
    if (!forwardRecovered && relaunchedIdentityRejected) {
      return withManagedControlCompletion({
        checked: true,
        wasRunning: false,
        recovered: true,
        forwardRecovered: false,
        forwardRecoveryFailed: true,
        forwardRecoveryFailureDetail:
          "the primary dashboard/API host forward could not be re-established",
      });
    }
    const dashboardForwardRecovered = ensureHermesDashboardPortForwardIfEnabled(sandboxName, {
      afterSuccess: managedForwardGuard,
      beforeStart: managedForwardGuard,
    });
    const messagingForwardRecovered = recoverMessagingHostForward(sandboxName, {
      afterSuccess: managedForwardGuard,
      beforeStart: managedForwardGuard,
      quiet,
    });
    const declaredForwardsRecovered = recoverDeclaredAgentForwardPorts(sandboxName, recoveryPort, {
      afterSuccess: managedForwardGuard,
      beforeStart: managedForwardGuard,
      quiet,
    });
    const auxiliaryResults = [
      { label: "the Hermes dashboard host forward", recovered: dashboardForwardRecovered },
      { label: "the messaging webhook host forward", recovered: messagingForwardRecovered },
      { label: "one or more agent-declared host forwards", recovered: declaredForwardsRecovered },
    ];
    const auxiliaryFailureDetail = auxiliaryRecoveryFailureDetail(auxiliaryResults);
    if (!quiet) {
      console.log(`  ${G}✓${R} ${recoveryDisplayName} gateway restarted inside sandbox.`);
      if (forwardRecovered) {
        console.log(`  ${G}✓${R} Dashboard port forward re-established.`);
      } else {
        console.error("  Failed to re-establish the dashboard port forward.");
        console.error(
          `  Run \`openshell forward start --background ${recoveryPort} ${sandboxName}\` manually.`,
        );
      }
    }
    if (!forwardRecovered) {
      return preservedManagedForwardVerification.preferFailure(
        false,
        withManagedControlCompletion({
          checked: true as const,
          wasRunning: false,
          recovered: true as const,
          forwardRecovered: false as const,
          forwardRecoveryFailed: true as const,
          forwardRecoveryFailureDetail:
            "the primary dashboard/API host forward could not be re-established",
        }),
      );
    }
    if (auxiliaryFailureDetail !== null) {
      if (!quiet) console.error(`  ${auxiliaryFailureDetail}.`);
      return preservedManagedForwardVerification.preferFailure(
        false,
        withManagedControlCompletion({
          checked: true as const,
          wasRunning: false,
          recovered: true as const,
          forwardRecovered: false as const,
          forwardRecoveryFailed: true as const,
          forwardRecoveryFailureDetail: auxiliaryFailureDetail,
        }),
      );
    }
    return preservedManagedForwardVerification.verifySuccess(
      false,
      withManagedControlCompletion({
        checked: true as const,
        wasRunning: false,
        recovered: true as const,
        forwardRecovered: forwardRecovered || anyAuxiliaryRecovered(auxiliaryResults),
      }),
    );
  }
  if (!quiet) {
    console.error(`  Could not restart ${recoveryDisplayName} gateway automatically.`);
    printHostManagedGatewayRecoveryHints(sandboxName, recoveryAgent, managedRecoveryFailureLayer);
  }

  onRecoveryFailureLayer?.(managedRecoveryFailureLayer);
  onRecoveryFailure?.(
    managedRecoveryFailure ?? {
      layer: "launch failure",
      detail: "the managed gateway recovery did not return a completion result",
    },
  );
  return { checked: true, wasRunning: false, recovered: false, forwardRecovered: false };
}

export function checkAndRecoverSandboxProcesses(
  sandboxName: string,
  options: SandboxProcessRecoveryOptions = {},
) {
  return withTimerBoundShieldsMutationLock(sandboxName, "gateway process recovery", () =>
    checkAndRecoverSandboxProcessesWithoutHostLock(sandboxName, options),
  );
}
