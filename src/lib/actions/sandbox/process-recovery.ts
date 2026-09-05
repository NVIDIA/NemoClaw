// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import { stripAnsi } from "../../adapters/openshell/client";
import { withSelectedOpenShellCommandOptions } from "../../adapters/openshell/command-argv";
import {
  buildOpenShellRuntimeSelectionEnv,
  captureOpenshell,
  captureOpenshellForStatus,
  captureSandboxSshConfig,
  getOpenshellBinary,
  isCommandTimeout,
  type OpenShellRuntimeSelection,
  runOpenshell,
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
  isPinnedSandboxContainerIdentityChangedError,
  executePrivilegedSandboxCommand as executeProviderPrivilegedSandboxCommand,
  resolvePrivilegedSandboxTarget,
  withPrivilegedSandboxExecutionLease,
} from "../../sandbox/privileged-exec";
import { withMcpLifecycleLockSync } from "../../state/mcp-lifecycle-lock-acquisition";
import * as registry from "../../state/registry";
import { buildSubprocessEnv } from "../../subprocess-env";
import {
  ensureHermesDashboardPortForwardIfEnabled,
  ensureSandboxPortForward,
  createHermesPortableForwardRecoveryInput,
  HermesPortableForwardRecoveryError,
  isSandboxForwardHealthy,
  prepareHermesPortableLaunchForwards,
  recoverDeclaredAgentForwardPorts,
  recoverHermesPortableLaunchForwards,
  recoverMessagingHostForward,
  resolveSandboxDashboardPort,
  resolveSandboxHealthProbeUrl,
  verifyHermesPortableLaunchForwards,
  type HermesPortableForwardRecoveryFailure,
  type HermesPortableForwardRecoveryInput,
  type HermesPortableForwardRecoveryResult,
  type HermesPortableForwardRecoveryTimingEvidence,
  type HermesPortableForwardVerificationResult,
  type PreparedHermesPortableForwardRecovery,
} from "./forward-recovery";
import {
  classifyGatewayRestartFailure,
  type GatewayRestartDeps,
  type GatewayRestartFailureLayer,
  type GatewayRestartResult,
  gatewayIntegrityRepairLines,
  isGatewayIntegrityRepairLayer,
  MANAGED_CONTROL_IDENTITY_CHANGED_MARKER,
  type ManagedGatewayControlCompletion,
  parseManagedGatewayControlCompletion,
  printGatewayRestartFailure,
  type RestartSandboxGatewayOptions as BaseRestartSandboxGatewayOptions,
  restartSandboxGatewayWithDeps,
  sandboxAgentName,
  withUnsupportedHermesPortableGatewayRestartFence,
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
  recoverRegisteredRuntimeProviderSandbox,
  relaunchManagedSupervisorSession,
  usesManagedGatewayController,
  usesLegacyManagedGatewayRecovery,
} from "./supervisor-relaunch";
export type { SandboxForwardHealth } from "./forward-health";
export { resolveSandboxDashboardPort, resolveSandboxLaunchForwardPorts } from "./forward-recovery";
export {
  createHermesPortableForwardRecoveryInput,
  HermesPortableForwardRecoveryError,
  prepareHermesPortableLaunchForwards,
  recoverHermesPortableLaunchForwards,
  verifyHermesPortableLaunchForwards,
};
export type {
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
  setForwardAction(action: "skipped" | "verified" | "restored" | "failed"): void;
};

function commandTransportDependencies(): CommandTransportDependencies {
  return {
    buildSandboxExecMarkedCommand,
    buildSubprocessEnv,
    captureSandboxSshConfig,
    executePrivilegedSandboxCommand: executeProviderPrivilegedSandboxCommand,
    extractSandboxExecCommandStdout,
    getOpenshellBinary,
    isDirectSandboxFallbackUnavailableError,
    openshellProbeTimeoutMs: OPENSHELL_PROBE_TIMEOUT_MS,
    root: ROOT,
  };
}

type AuxiliaryRecoveryResult = {
  label: string;
  recovered: boolean | null;
};

type ManagedGatewaySupervisorActionResult = SandboxCommandResult & {
  readonly managedControlRestartingContainerId?: string;
};

const MANAGED_GATEWAY_CONTROL_PATH = "/usr/local/bin/nemoclaw-gateway-control";
const MANAGED_CONTROL_TRANSITION_MAX_ATTEMPTS = 11;
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
export function executeSandboxCommand(
  sandboxName: string,
  command: string,
  timeoutOrOptions: number | SandboxCommandExecutionOptions = DEFAULT_SANDBOX_EXEC_TIMEOUT_MS,
): SandboxCommandResult | null {
  const timeout =
    typeof timeoutOrOptions === "number"
      ? timeoutOrOptions
      : (timeoutOrOptions.timeout ?? DEFAULT_SANDBOX_EXEC_TIMEOUT_MS);
  const runtimeSelection =
    typeof timeoutOrOptions === "number" ? undefined : timeoutOrOptions.runtimeSelection;
  const runtimeEnv = runtimeSelection
    ? buildOpenShellRuntimeSelectionEnv(buildSubprocessEnv(), runtimeSelection)
    : undefined;
  return executeSandboxCommandTransport(
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

export function executeSandboxExecCommand(
  sandboxName: string,
  command: string,
  timeout = DEFAULT_SANDBOX_EXEC_TIMEOUT_MS,
  options: SandboxExecCommandExecutionOptions = {},
): SandboxCommandResult | null {
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
            allowLocalDockerFallback: false,
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
  expectedContainerId?: string,
): ManagedGatewaySupervisorActionResult | null {
  const nonce = randomBytes(32).toString("hex");
  try {
    return withPrivilegedSandboxExecutionLease(sandboxName, `gateway supervisor ${action}`, () => {
      const targetContainerId =
        expectedContainerId ?? resolvePrivilegedSandboxTarget(sandboxName).resourceHandle;
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
      stderr: isPinnedSandboxContainerIdentityChangedError(error)
        ? `${MANAGED_CONTROL_IDENTITY_CHANGED_MARKER}\n${detail}`
        : `PRIVILEGED_CONTROL_UNAVAILABLE: ${detail}`,
    };
  }
}

type RequestPinnedGatewaySupervisorAction = typeof executeGatewaySupervisorActionPinned;

export function executeGatewaySupervisorAction(
  sandboxName: string,
  action: "restart" | "recover" | "probe",
  timeout = 210000,
): ManagedGatewaySupervisorActionResult | null {
  return executeGatewaySupervisorActionPinned(sandboxName, action, timeout);
}

function refuseHostLocalSupervisorForSelectedRuntime(
  _sandboxName: string,
  _action: "restart" | "recover" | "probe",
  _timeout = 210000,
  _expectedContainerId?: string,
): ManagedGatewaySupervisorActionResult {
  return {
    status: 1,
    stdout: "",
    stderr:
      "PRIVILEGED_CONTROL_UNAVAILABLE\nSELECTED_RUNTIME_SUPERVISOR_UNAVAILABLE: host-local supervisor control is not valid for an explicitly selected OpenShell target",
  };
}

async function executeSandboxExecCommandForStatus(
  sandboxName: string,
  command: string,
  gatewayName?: string,
  capture: typeof captureOpenshellForStatus = captureOpenshellForStatus,
): Promise<SandboxCommandResult | null> {
  const markedCommand = buildSandboxExecMarkedCommand(command);
  const result = await capture(
    [
      "sandbox",
      "exec",
      "--name",
      sandboxName,
      ...(gatewayName ? ["-g", gatewayName] : []),
      "--",
      "sh",
      "-c",
      markedCommand,
    ],
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
function isSandboxGatewayRunning(
  sandboxName: string,
  runtimeSelection?: OpenShellRuntimeSelection,
): boolean | null {
  const agent = agentRuntime.getSessionAgent(sandboxName);
  if (agent && !agentRuntime.hasGatewayRuntime(agent)) return null;
  const probeUrl = getSandboxHealthProbeUrl(sandboxName);
  const command = `HTTP_CODE=$(curl -so /dev/null -w '%{http_code}' --max-time 3 ${shellQuote(probeUrl)} 2>/dev/null || echo 000); case "$HTTP_CODE" in 200|401) echo RUNNING ;; *) echo STOPPED ;; esac`;
  const execProbe = parseSandboxGatewayProbe(
    executeSandboxExecCommand(
      sandboxName,
      command,
      DEFAULT_SANDBOX_EXEC_TIMEOUT_MS,
      runtimeSelection ? { runtimeSelection } : {},
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
  return parseSandboxGatewayProbe(
    executeSandboxCommand(
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
  return [
    "SUPERVISOR_NOT_RUNNING",
    "PRIVILEGED_CONTROL_UNAVAILABLE",
    "SUPERVISOR_DISCOVERY_PENDING",
    "GATEWAY_HEALTH_TIMEOUT",
  ].some((marker) => isExactlyManagedControlMarker(result, marker));
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
    requestGatewaySupervisorActionImpl?: typeof executeGatewaySupervisorAction;
    sleepImpl?: (seconds: number) => void;
  } = {},
): boolean {
  const requestGatewaySupervisorAction =
    options.requestGatewaySupervisorActionImpl ?? executeGatewaySupervisorAction;
  const sleep = options.sleepImpl ?? sleepSeconds;
  const intervalSeconds = options.intervalSeconds ?? 3;
  const maxAttempts = options.maxAttempts ?? MANAGED_CONTROL_TRANSITION_MAX_ATTEMPTS;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = requestGatewaySupervisorAction(sandboxName, "probe", OPENSHELL_PROBE_TIMEOUT_MS);
    if (hasGatewayRecoveryMarker(result)) return true;
    if (
      !isExactlyManagedGatewayStartupTransition(result) &&
      !isExactlyRetryableManagedRecoveryFailure(result) &&
      !isExactlyRetryableManagedControlTransition(result)
    ) {
      return false;
    }
    if (attempt < maxAttempts) sleep(intervalSeconds);
  }
  return false;
}

type FinalRelaunchManagedSupervisorReadiness =
  | { ready: true }
  | { failure: ReturnType<typeof classifyGatewayRestartFailure>; ready: false };

function waitForFinalRelaunchManagedSupervisor(
  sandboxName: string,
  requestGatewaySupervisorAction: typeof executeGatewaySupervisorAction,
): FinalRelaunchManagedSupervisorReadiness {
  let probeResult: ManagedGatewaySupervisorActionResult | null = null;
  try {
    const ready = waitForManagedGatewaySupervisor(sandboxName, {
      intervalSeconds: readNonNegativeNumberEnv(
        "NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS",
        3,
      ),
      requestGatewaySupervisorActionImpl: (name, action, timeout) => {
        probeResult = requestGatewaySupervisorAction(name, action, timeout);
        return probeResult;
      },
    });
    if (ready) return { ready: true };
  } catch {
    return {
      failure: {
        layer: "privileged control unavailable",
        detail:
          "the pinned managed supervisor probe could not be completed during the final replacement container health check",
      },
      ready: false,
    };
  }
  return { failure: classifyGatewayRestartFailure(probeResult), ready: false };
}

function finalRelaunchContainerFailureDetail(
  completion: ReturnType<ManagedSupervisorRelaunch["finalize"]>,
): string | null {
  if (completion.lifecycleStopAcknowledged === false) {
    return "OpenShell did not acknowledge the authoritative stop before the final replacement handoff. NemoClaw did not start the primary dashboard/API host forward";
  }
  if (completion.replacementStoppedForCommit === false) {
    return "Docker could not stop the replacement container for the final recovery handoff. NemoClaw did not start the primary dashboard/API host forward";
  }
  if (completion.replacementRestarted === false) {
    return "OpenShell could not start the replacement container through the authoritative lifecycle path. NemoClaw did not start the primary dashboard/API host forward";
  }
  if (completion.finalHandoffAcknowledged === false) {
    return `OpenShell did not acknowledge the final replacement container handoff${
      completion.lastSandboxPhase ? `; last sandbox phase was ${completion.lastSandboxPhase}` : ""
    }. NemoClaw did not start the primary dashboard/API host forward`;
  }
  return null;
}

type FinalRelaunchRecoveryFailure = {
  checked: true;
  forwardRecovered: false;
  forwardRecoveryFailed?: undefined;
  forwardRecoveryFailureDetail?: undefined;
  recovered: false;
  recoveryFailureDetail?: string;
  wasRunning: false;
};

function finalRelaunchRecoveryFailure(
  recoveryFailureDetail?: string,
): FinalRelaunchRecoveryFailure {
  const failure = {
    checked: true,
    forwardRecovered: false,
    recovered: false,
    wasRunning: false,
  } as const;
  return recoveryFailureDetail ? { ...failure, recoveryFailureDetail } : failure;
}

function finalizeRelaunchedRecovery(
  sandboxName: string,
  relaunch: ManagedSupervisorRelaunch,
  {
    printRecoveryHints,
    quiet,
    requestManagedProbe,
    waitForRecoveryReadiness,
  }: {
    printRecoveryHints: () => void;
    quiet: boolean;
    requestManagedProbe: typeof executeGatewaySupervisorAction;
    waitForRecoveryReadiness: () => string | null;
  },
): FinalRelaunchRecoveryFailure | null {
  let completion: ReturnType<ManagedSupervisorRelaunch["finalize"]>;
  try {
    completion = relaunch.finalize(true);
    if (completion.stateRestored === false || completion.rolledBack) {
      const recoveryFailureDetail = completion.rolledBack
        ? "Sandbox recovery did not complete; the previous container was restored"
        : "Sandbox recovery failed and the previous container could not be restored automatically";
      if (!quiet) {
        console.error(`  ${recoveryFailureDetail}.`);
        if (completion.rolledBack && completion.stateBackupRemoved === false) {
          console.error("  Warning: the temporary sandbox state backup could not be removed.");
        }
        if (!completion.rolledBack) printRecoveryHints();
      }
      return finalRelaunchRecoveryFailure(recoveryFailureDetail);
    }
  } catch {
    if (!quiet) {
      console.error(
        "  NemoClaw could not confirm the final replacement container handoff. It did not start the primary dashboard/API host forward.",
      );
    }
    return finalRelaunchRecoveryFailure(
      "NemoClaw could not confirm the final replacement container handoff. It did not start the primary dashboard/API host forward",
    );
  }

  const containerFailureDetail = finalRelaunchContainerFailureDetail(completion);
  if (containerFailureDetail) return finalRelaunchRecoveryFailure(containerFailureDetail);

  if (completion.replacementRestarted === true) {
    const managedSupervisor = waitForFinalRelaunchManagedSupervisor(
      sandboxName,
      requestManagedProbe,
    );
    if (!managedSupervisor.ready) {
      if (managedSupervisor.failure.layer === "container identity changed") {
        return finalRelaunchRecoveryFailure(
          "the replacement container identity changed during the final managed supervisor health check. NemoClaw did not start the primary dashboard/API host forward",
        );
      }
      return finalRelaunchRecoveryFailure(
        `the managed supervisor health check for the pinned replacement container did not pass after the final replacement container restart. NemoClaw did not start the primary dashboard/API host forward. Managed supervisor health check result: ${managedSupervisor.failure.layer}: ${managedSupervisor.failure.detail}`,
      );
    }
    const finalReadinessFailureDetail = waitForRecoveryReadiness();
    if (finalReadinessFailureDetail) {
      return finalRelaunchRecoveryFailure(finalReadinessFailureDetail);
    }
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
  return null;
}

function recoveryDetailAfterRelaunchRollback(
  relaunch: ManagedSupervisorRelaunch,
  recoveryFailureDetail: string,
): string {
  try {
    if (relaunch.finalize(false).rolledBack) return recoveryFailureDetail;
  } catch {
    // Report only the fixed rollback classification below. Finalizer errors can
    // contain Docker paths, container IDs, or other untrusted runtime detail.
  }
  return `NemoClaw could not confirm rollback to the previous sandbox container. Inspect Docker state before retrying. Recovery failure before rollback: ${recoveryFailureDetail}`;
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

  if (!usesManagedGatewayController(entry)) return null;

  const getSessionAgent = options.getSessionAgentImpl ?? agentRuntime.getSessionAgent;
  const agent = getSessionAgent(sandboxName);
  if (persistedAgent === "hermes" && agent?.name !== "hermes") return null;
  if (agent && !agentRuntime.hasGatewayRuntime(agent)) return null;
  const requestGatewaySupervisorAction =
    options.requestGatewaySupervisorActionImpl ?? executeGatewaySupervisorAction;
  const result = requestGatewaySupervisorAction(sandboxName, "probe");
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

export async function isSandboxGatewayRunningForStatus(
  sandboxName: string,
  gatewayName?: string,
  options: {
    getSessionAgent?: typeof agentRuntime.getSessionAgent;
    capture?: typeof captureOpenshellForStatus;
    getHealthProbeUrl?: typeof getSandboxHealthProbeUrl;
  } = {},
): Promise<boolean | null> {
  const agent = (options.getSessionAgent ?? agentRuntime.getSessionAgent)(sandboxName);
  if (agent && !agentRuntime.hasGatewayRuntime(agent)) return null;
  const probeUrl = (options.getHealthProbeUrl ?? getSandboxHealthProbeUrl)(sandboxName);
  const command = `HTTP_CODE=$(curl -so /dev/null -w '%{http_code}' --max-time 3 ${shellQuote(probeUrl)} 2>/dev/null || echo 000); case "$HTTP_CODE" in 200|401) echo RUNNING ;; *) echo STOPPED ;; esac`;
  return parseSandboxGatewayProbe(
    await executeSandboxExecCommandForStatus(sandboxName, command, gatewayName, options.capture),
  );
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
  | { kind: "provider" }
  | { kind: "relaunched"; relaunch: ManagedSupervisorRelaunch };

function recoverSandboxProcesses(
  sandboxName: string,
  {
    quiet = false,
    requestGatewaySupervisorAction = executeGatewaySupervisorAction,
    requestPinnedGatewaySupervisorAction = executeGatewaySupervisorActionPinned,
    relaunchManagedSupervisorSessionImpl = relaunchManagedSupervisorSession,
    onFailureLayer,
    runtimeSelection,
  }: {
    quiet?: boolean;
    requestGatewaySupervisorAction?: typeof executeGatewaySupervisorAction;
    requestPinnedGatewaySupervisorAction?: RequestPinnedGatewaySupervisorAction;
    relaunchManagedSupervisorSessionImpl?: typeof relaunchManagedSupervisorSession;
    onFailureLayer?: (layer: GatewayRestartFailureLayer, detail: string) => void;
    runtimeSelection?: OpenShellRuntimeSelection;
  } = {},
): SandboxProcessRecovery | null {
  const effectiveGatewaySupervisorAction =
    runtimeSelection && requestGatewaySupervisorAction === executeGatewaySupervisorAction
      ? refuseHostLocalSupervisorForSelectedRuntime
      : requestGatewaySupervisorAction;
  const effectivePinnedGatewaySupervisorAction =
    runtimeSelection &&
    requestPinnedGatewaySupervisorAction === executeGatewaySupervisorActionPinned
      ? refuseHostLocalSupervisorForSelectedRuntime
      : requestPinnedGatewaySupervisorAction;
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
  // Providers that launch NemoClaw's managed in-sandbox controller recover the
  // gateway through that controller. Restarting their runtime first replaces
  // the still-healthy supervisor and changes gateway parentage.
  if (persistedSandbox && !usesManagedGatewayController(persistedSandbox)) {
    const result = recoverRegisteredRuntimeProviderSandbox(persistedSandbox);
    if (result) {
      if (result.exitCode === 0) return { kind: "provider" };
      if (!quiet && result.message) console.error(result.message);
      return null;
    }
  }
  const recoveredSsh = (result: SandboxCommandResult | null): SandboxProcessRecovery | null =>
    result && result.status === 0 && hasGatewayRecoveryMarker(result) ? { kind: "custom" } : null;
  const recoverManagedGateway = (): SandboxProcessRecovery | null => {
    const maxAttempts = MANAGED_CONTROL_TRANSITION_MAX_ATTEMPTS;
    const maxBusyAttempts = 3;
    const retryIntervalSeconds = readNonNegativeNumberEnv(
      "NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS",
      3,
    );
    let execResult: ManagedGatewaySupervisorActionResult | null = null;
    let busyAttempts = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      execResult = effectiveGatewaySupervisorAction(sandboxName, "recover");
      const managedControlCompletion = parseManagedGatewayControlCompletion(execResult);
      if (managedControlCompletion) return { kind: "managed", managedControlCompletion };
      if (hasGatewayRecoveryMarker(execResult)) return { kind: "managed" };

      // The restarted sandbox can report Ready before its managed controller
      // and gateway finish starting. Retry only exact startup, controller
      // contention, status 137 with no output, and ID-bound Docker transition
      // results. Identity, integrity, configuration, and launch refusals are
      // diagnostic-bearing and remain terminal.
      if (isExactlyRetryableManagedRecoveryFailure(execResult)) {
        busyAttempts += 1;
        if (busyAttempts >= maxBusyAttempts) break;
      } else if (
        !isExactlyManagedGatewayStartupTransition(execResult) &&
        !isExactlyRetryableManagedControlTransition(execResult)
      ) {
        break;
      }
      if (attempt === maxAttempts) break;
      sleepSeconds(retryIntervalSeconds);
    }
    const failure = classifyGatewayRestartFailure(execResult);
    onFailureLayer?.(failure.layer, failure.detail);
    if (
      failure.layer === "supervisor not running" &&
      isExactlyManagedControlMarker(execResult, "SUPERVISOR_NOT_RUNNING")
    ) {
      const relaunch = relaunchManagedSupervisorSessionImpl(sandboxName, {
        quiet,
        deps: {
          runOpenshell: (args, options) =>
            runOpenshell(
              args,
              withSelectedOpenShellCommandOptions(options ?? {}, runtimeSelection),
            ),
          runCaptureOpenshell: (args, options) =>
            captureOpenshell(
              args,
              withSelectedOpenShellCommandOptions(
                {
                  ignoreError: true,
                  includeStderr: true,
                  killProcessTreeOnTimeout: options?.killProcessTreeOnTimeout === true,
                  killSignal: options?.killSignal === "SIGKILL" ? "SIGKILL" : undefined,
                  timeout:
                    typeof options?.timeout === "number"
                      ? options.timeout
                      : OPENSHELL_PROBE_TIMEOUT_MS,
                },
                runtimeSelection,
              ),
            ).output,
          confirmMissingSupervisor: (containerId) =>
            isExactlyManagedControlMarker(
              effectivePinnedGatewaySupervisorAction(
                sandboxName,
                "probe",
                210000,
                containerId,
              ),
              "SUPERVISOR_NOT_RUNNING",
            ),
          restartRestoredManagedGateway: (containerId) => {
            const restarted = parseManagedGatewayControlCompletion(
              effectivePinnedGatewaySupervisorAction(
                sandboxName,
                "restart",
                210000,
                containerId,
              ),
            );
            if (restarted?.disposition !== "ok") return false;
            return waitForRecoveredSandboxGateway(sandboxName, {
              quiet,
              initialManagedHealthPassed: true,
              requireManagedProbe: true,
              timeoutSeconds: gatewayRecoveryTimeoutSeconds(agent),
              runtimeSelection,
              managedProbeImpl: (name) =>
                confirmRecoveredSandboxGatewayManaged(name, {
                  requestGatewaySupervisorActionImpl: (name, action) =>
                    effectivePinnedGatewaySupervisorAction(name, action, 210000, containerId),
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
    return recoveredSsh(
      executeSandboxCommand(
        sandboxName,
        agentScript,
        runtimeSelection ? { runtimeSelection } : DEFAULT_SANDBOX_EXEC_TIMEOUT_MS,
      ),
    );
  }

  return null;
}

export function restartSandboxGateway(
  sandboxName: string,
  { quiet = false, deps = {}, runtimeSelection }: RestartSandboxGatewayOptions = {},
): GatewayRestartResult {
  return withUnsupportedHermesPortableGatewayRestartFence(sandboxName, () => {
    const defaultSupervisorAction = runtimeSelection
      ? refuseHostLocalSupervisorForSelectedRuntime
      : executeGatewaySupervisorAction;
    return withMcpLifecycleLockSync(sandboxName, () =>
      restartSandboxGatewayWithDeps(sandboxName, {
        quiet,
        deps: {
          getSessionAgent: agentRuntime.getSessionAgent,
          getSandbox: registry.getSandbox,
          resolveSandboxDashboardPort,
          requestGatewaySupervisorAction: defaultSupervisorAction,
          executeSandboxExecCommand: (name, command, timeout) =>
            executeSandboxExecCommand(
              name,
              command,
              timeout,
              runtimeSelection ? { runtimeSelection } : {},
            ),
          waitForRecoveredSandboxGateway: (name, options) =>
            waitForRecoveredSandboxGateway(name, {
              ...options,
              initialManagedHealthPassed: true,
              runtimeSelection,
              timeoutSeconds: gatewayRecoveryTimeoutSeconds(agentRuntime.getSessionAgent(name)),
              managedProbeImpl: (sandboxName) =>
                confirmRecoveredSandboxGatewayManaged(sandboxName, {
                  requestGatewaySupervisorActionImpl:
                    deps.requestGatewaySupervisorAction ?? defaultSupervisorAction,
                }),
            }),
          ensureSandboxPortForward: (name) =>
            ensureSandboxPortForward(name, { runtimeSelection }),
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
          inspectHermesMcpReconciliationRefusal: (name) =>
            inspectHermesMcpReconciliationRefusal(
              name,
              undefined,
              runtimeSelection,
            ),
          ...deps,
        },
      }),
    );
  });
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
  return stripAnsi(value)
    .replace(/[×│]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
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
        return "the managed supervisor health check for the pinned replacement container did not pass. NemoClaw did not start the primary dashboard/API host forward";
      case "managed-health-inconclusive-timeout":
        return "the managed supervisor health check for the pinned replacement container stayed inconclusive within the OpenShell readiness deadline. NemoClaw did not start the primary dashboard/API host forward";
      case "openshell-readiness-failure":
        return "the recreated sandbox did not become ready in OpenShell. NemoClaw did not start the primary dashboard/API host forward";
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

// Default seconds to wait for OpenShell to re-register a recreated sandbox as
// Ready before returning a classified recovery failure. Aligned with
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
    const result = capture(
      ["sandbox", "exec", "--name", sandboxName, "--", "true"],
      withSelectedOpenShellCommandOptions(
        {
          ignoreError: true,
          includeStderr: true,
          includeStreams: true,
          timeout: Math.max(1, Math.min(OPENSHELL_PROBE_TIMEOUT_MS, remainingMs)),
        },
        options.runtimeSelection,
      ),
    );
    if (result.status === 0 && !result.error) return { ready: true };
    const openshellError = normalizeOpenshellStructuredError(String(result.stderr ?? ""));
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
      result.status === 1 &&
      !result.error &&
      String(result.stdout ?? "").trim() === "" &&
      String(result.stderr ?? "").trim() === "";
    // OpenShell can briefly return an empty exit-1 result after first exposing
    // the exact replacement re-registration state. Keep that result
    // inconclusive only inside the same bounded wait and behind the pinned
    // managed-health guard. It is never accepted as Ready, and an empty first
    // failure or any diagnostic-bearing unknown failure remains terminal.
    if (
      !retryableReRegistrationState &&
      !emptyReadOnlyProbeAfterReRegistration &&
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
    runtimeSelection?: OpenShellRuntimeSelection;
  } = {},
): boolean {
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

/**
 * Detect and recover from a sandbox that survived a gateway restart but
 * whose OpenClaw processes are not running. Also re-establishes the
 * host-side dashboard port-forward when it has gone dead independently
 * of the gateway. Returns an object describing the outcome:
 * `{ checked, wasRunning, recovered, forwardRecovered, forwardRecoveryFailed?, recoveryFailureDetail?, secretBoundaryRefused?, secretBoundaryReason? }`.
 * `onRecoveryFailureLayer` reports the classified managed-restart failure so a
 * quiet caller (`recover`, `connect --probe-only`) can still explain why
 * recovery is not retryable instead of printing a generic "check the gateway
 * log". Failures before forward recovery use `recoveryFailureDetail`; actual
 * forward failures retain `forwardRecoveryFailed` and their forward detail.
 */
function checkAndRecoverSandboxProcessesWithoutHostLock(
  sandboxName: string,
  {
    quiet = false,
    requestGatewaySupervisorAction = executeGatewaySupervisorAction,
    requestPinnedGatewaySupervisorAction = executeGatewaySupervisorActionPinned,
    relaunchManagedSupervisorSessionImpl = relaunchManagedSupervisorSession,
    isSandboxGatewayRunningImpl = isSandboxGatewayRunning,
    waitForRecreatedSandboxOpenShellReadyImpl = waitForRecreatedSandboxOpenShellReady,
    isWsl: isWslOverride,
    onRecoveryFailureLayer,
    probeTiming,
    runtimeSelection,
  }: {
    quiet?: boolean;
    requestGatewaySupervisorAction?: typeof executeGatewaySupervisorAction;
    requestPinnedGatewaySupervisorAction?: RequestPinnedGatewaySupervisorAction;
    relaunchManagedSupervisorSessionImpl?: typeof relaunchManagedSupervisorSession;
    isSandboxGatewayRunningImpl?: typeof isSandboxGatewayRunning;
    waitForRecreatedSandboxOpenShellReadyImpl?: typeof waitForRecreatedSandboxOpenShellReady;
    isWsl?: boolean;
    onRecoveryFailureLayer?: (layer: GatewayRestartFailureLayer | null, detail?: string) => void;
    probeTiming?: ProcessRecoveryProbeTiming;
    runtimeSelection?: OpenShellRuntimeSelection;
  } = {},
) {
  const measure = <T>(stage: "processes" | "forward", operation: () => T): T =>
    probeTiming ? probeTiming.measure(stage, operation) : operation();
  const effectiveGatewaySupervisorAction =
    runtimeSelection && requestGatewaySupervisorAction === executeGatewaySupervisorAction
      ? refuseHostLocalSupervisorForSelectedRuntime
      : requestGatewaySupervisorAction;
  const effectivePinnedGatewaySupervisorAction =
    runtimeSelection &&
    requestPinnedGatewaySupervisorAction === executeGatewaySupervisorActionPinned
      ? refuseHostLocalSupervisorForSelectedRuntime
      : requestPinnedGatewaySupervisorAction;
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
  const running = measure("processes", () =>
    isSandboxGatewayRunningImpl(sandboxName, runtimeSelection),
  );
  if (running === null) {
    return { checked: false, wasRunning: null, recovered: false, forwardRecovered: false };
  }
  const recoveryPort = resolveSandboxDashboardPort(sandboxName);
  if (running) {
    const enforcement = enforceHermesSecretBoundaryOnRunningGateway(
      sandboxName,
      recoveryAgent,
      effectiveGatewaySupervisorAction,
    );
    if (enforcement?.refused) {
      return {
        checked: true,
        wasRunning: true,
        recovered: false,
        forwardRecovered: false,
        secretBoundaryRefused: true,
        secretBoundaryReason: enforcement.reason,
      };
    }
    const mcpRefusal = processRecoveryMcpReconciliationRefusal(
      sandboxName,
      true,
      undefined,
      runtimeSelection,
    );
    if (mcpRefusal) return mcpRefusal;
  }
  if (running) {
    // Gateway is alive but the host-side forward can still be dead or
    // owned by another sandbox. Probe and re-establish only when
    // necessary so the live-and-healthy path stays a no-op.
    const forwardHealthy = measure("forward", () =>
      isSandboxForwardHealthy(sandboxName, {
        isWsl: isWslOverride,
        runtimeSelection,
      }),
    );
    if (forwardHealthy === false) {
      if (!quiet) {
        console.log("");
        console.log(`  Dashboard port forward to '${sandboxName}' is missing or dead.`);
        console.log("  Re-establishing...");
      }
      const forwardRecovered = measure("forward", () =>
        ensureSandboxPortForward(sandboxName, { isWsl: isWslOverride, runtimeSelection }),
      );
      const dashboardForwardRecovered = measure("forward", () =>
        ensureHermesDashboardPortForwardIfEnabled(sandboxName, runtimeSelection),
      );
      const messagingForwardRecovered = measure("forward", () =>
        recoverMessagingHostForward(sandboxName, { quiet, runtimeSelection }),
      );
      const declaredForwardsRecovered = measure("forward", () =>
        recoverDeclaredAgentForwardPorts(sandboxName, recoveryPort, {
          quiet,
          runtimeSelection,
        }),
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
          forwardRecoveryFailureDetail:
            "the primary dashboard/API host forward could not be re-established",
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
    const dashboardForwardRecovered = measure("forward", () =>
      ensureHermesDashboardPortForwardIfEnabled(sandboxName, runtimeSelection),
    );
    const messagingForwardRecovered = measure("forward", () =>
      recoverMessagingHostForward(sandboxName, { quiet, runtimeSelection }),
    );
    const declaredForwardsRecovered = measure("forward", () =>
      recoverDeclaredAgentForwardPorts(sandboxName, recoveryPort, { quiet, runtimeSelection }),
    );
    const auxiliaryResults = [
      { label: "the Hermes dashboard host forward", recovered: dashboardForwardRecovered },
      { label: "the messaging webhook host forward", recovered: messagingForwardRecovered },
      { label: "one or more agent-declared host forwards", recovered: declaredForwardsRecovered },
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

  let managedRecoveryFailureLayer: GatewayRestartFailureLayer | null = null;
  let managedRecoveryFailureDetail: string | null = null;
  const recovery = measure("processes", () =>
    recoverSandboxProcesses(sandboxName, {
      quiet,
      requestGatewaySupervisorAction: effectiveGatewaySupervisorAction,
      requestPinnedGatewaySupervisorAction: effectivePinnedGatewaySupervisorAction,
      relaunchManagedSupervisorSessionImpl,
      runtimeSelection,
      onFailureLayer: (layer, detail) => {
        managedRecoveryFailureLayer = layer;
        managedRecoveryFailureDetail = detail;
      },
    }),
  );
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
          effectivePinnedGatewaySupervisorAction(name, action, timeout, relaunch.containerId)
      : effectiveGatewaySupervisorAction;
    const relaunchedManagedHealth = {
      failure: null as ReturnType<typeof classifyGatewayRestartFailure> | null,
    };
    const confirmRelaunchedManagedHealth = relaunch
      ? (timeout = OPENSHELL_PROBE_TIMEOUT_MS) => {
          relaunchedManagedHealth.failure = null;
          let probeResult: ManagedGatewaySupervisorActionResult | null = null;
          try {
            const confirmed = confirmRecoveredSandboxGatewayManaged(sandboxName, {
              requestGatewaySupervisorActionImpl: (name, action) => {
                probeResult = requestManagedProbe(name, action, timeout);
                return probeResult;
              },
            });
            if (confirmed === false) {
              relaunchedManagedHealth.failure = classifyGatewayRestartFailure(probeResult);
            }
            return confirmed;
          } catch {
            relaunchedManagedHealth.failure = {
              layer: "privileged control unavailable",
              detail: "the pinned managed supervisor probe could not be completed",
            };
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
      gatewayReady = measure("processes", () =>
        waitForRecoveredSandboxGateway(sandboxName, {
          quiet,
          initialManagedHealthPassed: recovery.kind === "managed",
          requireManagedProbe: recovery.kind === "relaunched",
          runtimeSelection,
          // A legacy keepalive relaunch starts a new OpenClaw container. The
          // #10153 failure exhausted the ordinary 30-second health budget
          // during that full recreation. Give only this OpenClaw transition
          // the existing 120-second recreated-sandbox readiness budget;
          // other agents retain their declared gateway health timeout.
          timeoutSeconds:
            relaunch && (recoveryAgent === null || recoveryAgent.name === "openclaw")
              ? Math.max(
                  gatewayRecoveryTimeoutSeconds(recoveryAgent),
                  GATEWAY_RECOVERY_WAIT_DEFAULT_SECONDS,
                )
              : gatewayRecoveryTimeoutSeconds(recoveryAgent),
          managedProbeImpl: relaunch
            ? () => confirmRelaunchedManagedHealth?.(210000) ?? null
            : (name) =>
                confirmRecoveredSandboxGatewayManaged(name, {
                  requestGatewaySupervisorActionImpl: requestManagedProbe,
                }),
        }),
      );
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
      const gatewayWaitFailureDetail = relaunchedManagedHealth.failure
        ? `the managed supervisor health check for the recreated sandbox did not pass while NemoClaw waited for its gateway. Managed supervisor health check result: ${relaunchedManagedHealth.failure.layer}: ${relaunchedManagedHealth.failure.detail}`
        : "the recovered gateway did not become responsive before the recovery timeout";
      const recoveryFailureDetail = relaunch
        ? recoveryDetailAfterRelaunchRollback(relaunch, gatewayWaitFailureDetail)
        : gatewayWaitFailureDetail;
      const rollbackUnconfirmed = recoveryFailureDetail !== gatewayWaitFailureDetail;
      if (!quiet) {
        console.error("  Gateway process started but is not responding.");
        printGatewayWedgeDiagnostics(sandboxName, (name, command) =>
          executeSandboxExecCommand(
            name,
            command,
            DEFAULT_SANDBOX_EXEC_TIMEOUT_MS,
            runtimeSelection ? { runtimeSelection } : {},
          ),
        );
        console.error("  Check /tmp/gateway.log inside the sandbox for details.");
        if (rollbackUnconfirmed) {
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
      onRecoveryFailureLayer?.(
        managedRecoveryFailureLayer,
        managedRecoveryFailureDetail ?? undefined,
      );
      return {
        checked: true,
        wasRunning: false,
        recovered: false,
        forwardRecovered: false,
        recoveryFailureDetail,
      };
    }
    // Host-forward recovery requires an OpenShell-ready sandbox. Managed
    // recovery has already passed its authenticated control and health gates;
    // a replacement also rechecks its pinned identity before readiness.
    const recoveryRequiresReadiness =
      recovery.kind === "managed" || recovery.kind === "provider" || relaunch;
    const waitForRecoveryReadiness = () => {
      const readinessOptions: RecreatedSandboxOpenShellReadyOptions = {
        beforeProbe: relaunch
          ? (timeoutMs) => confirmRelaunchedManagedHealth?.(timeoutMs) ?? null
          : undefined,
        runtimeSelection,
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
              ? relaunchedManagedHealth.failure
                ? `${relaunchedManagedHealth.failure.layer}: ${relaunchedManagedHealth.failure.detail}`
                : undefined
              : undefined,
          );
    };
    const readinessFailureDetail = recoveryRequiresReadiness
      ? measure("processes", waitForRecoveryReadiness)
      : null;
    if (readinessFailureDetail) {
      const recoveryFailureDetail = relaunch
        ? recoveryDetailAfterRelaunchRollback(relaunch, readinessFailureDetail)
        : readinessFailureDetail;
      return {
        checked: true,
        wasRunning: false,
        recovered: false,
        forwardRecovered: false,
        recoveryFailureDetail,
      };
    }
    if (relaunch) {
      const finalizationFailure = measure("processes", () =>
        finalizeRelaunchedRecovery(sandboxName, relaunch, {
          printRecoveryHints: () =>
            printHostManagedGatewayRecoveryHints(
              sandboxName,
              recoveryAgent,
              managedRecoveryFailureLayer,
            ),
          quiet,
          requestManagedProbe,
          waitForRecoveryReadiness,
        }),
      );
      if (finalizationFailure) return finalizationFailure;
    }
    const mcpRefusal = processRecoveryMcpReconciliationRefusal(
      sandboxName,
      false,
      undefined,
      runtimeSelection,
    );
    if (mcpRefusal) return mcpRefusal;
    const forwardRecovered = measure("forward", () =>
      ensureSandboxPortForward(sandboxName, {
        afterSuccess: confirmRelaunchedManagedHealthForForward ?? undefined,
        beforeStart: confirmRelaunchedManagedHealthForForward ?? undefined,
        isWsl: isWslOverride,
        runtimeSelection,
      }),
    );
    if (!forwardRecovered && relaunchedManagedHealth.failure) {
      probeTiming?.setForwardAction("failed");
      return {
        checked: true,
        wasRunning: false,
        recovered: false,
        forwardRecovered: false,
        recoveryFailureDetail:
          relaunchedManagedHealth.failure.layer === "container identity changed"
            ? "the replacement container identity changed during the primary dashboard/API host forward check"
            : `the managed supervisor health check for the pinned replacement container did not pass during the primary dashboard/API host forward check. Managed supervisor health check result: ${relaunchedManagedHealth.failure.layer}: ${relaunchedManagedHealth.failure.detail}`,
      };
    }
    const dashboardForwardRecovered = measure("forward", () =>
      ensureHermesDashboardPortForwardIfEnabled(sandboxName, runtimeSelection),
    );
    const messagingForwardRecovered = measure("forward", () =>
      recoverMessagingHostForward(sandboxName, { quiet, runtimeSelection }),
    );
    const declaredForwardsRecovered = measure("forward", () =>
      recoverDeclaredAgentForwardPorts(sandboxName, recoveryPort, { quiet, runtimeSelection }),
    );
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
        console.error(`  Run \`nemoclaw ${sandboxName} recover\` after resolving the error.`);
      }
    }
    if (!forwardRecovered) {
      probeTiming?.setForwardAction("failed");
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
    if (auxiliaryFailureDetail !== null) {
      probeTiming?.setForwardAction("failed");
      if (!quiet) console.error(`  ${auxiliaryFailureDetail}.`);
      return withManagedControlCompletion({
        checked: true,
        wasRunning: false,
        recovered: true,
        forwardRecovered: false,
        forwardRecoveryFailed: true,
        forwardRecoveryFailureDetail: auxiliaryFailureDetail,
      });
    }
    probeTiming?.setForwardAction("restored");
    return withManagedControlCompletion({
      checked: true,
      wasRunning: false,
      recovered: true,
      forwardRecovered: forwardRecovered || anyAuxiliaryRecovered(auxiliaryResults),
    });
  }
  if (!quiet) {
    console.error(`  Could not restart ${recoveryDisplayName} gateway automatically.`);
    printHostManagedGatewayRecoveryHints(sandboxName, recoveryAgent, managedRecoveryFailureLayer);
  }

  onRecoveryFailureLayer?.(managedRecoveryFailureLayer, managedRecoveryFailureDetail ?? undefined);
  return { checked: true, wasRunning: false, recovered: false, forwardRecovered: false };
}

export function checkAndRecoverSandboxProcesses(
  sandboxName: string,
  options: {
    quiet?: boolean;
    requestGatewaySupervisorAction?: typeof executeGatewaySupervisorAction;
    requestPinnedGatewaySupervisorAction?: RequestPinnedGatewaySupervisorAction;
    relaunchManagedSupervisorSessionImpl?: typeof relaunchManagedSupervisorSession;
    isSandboxGatewayRunningImpl?: typeof isSandboxGatewayRunning;
    waitForRecreatedSandboxOpenShellReadyImpl?: typeof waitForRecreatedSandboxOpenShellReady;
    isWsl?: boolean;
    onRecoveryFailureLayer?: (layer: GatewayRestartFailureLayer | null, detail?: string) => void;
    probeTiming?: ProcessRecoveryProbeTiming;
    runtimeSelection?: OpenShellRuntimeSelection;
  } = {},
) {
  return withMcpLifecycleLockSync(sandboxName, () =>
    checkAndRecoverSandboxProcessesWithoutHostLock(sandboxName, options),
  );
}
