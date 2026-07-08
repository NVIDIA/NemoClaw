// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dockerSpawnSync } from "../../adapters/docker";
import {
  captureOpenshellForStatus,
  captureSandboxSshConfig,
  getOpenshellBinary,
  isCommandTimeout,
} from "../../adapters/openshell/runtime";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "../../adapters/openshell/timeouts";
import * as agentRuntime from "../../agent/runtime";
import { G, R } from "../../cli/terminal-style";
import { sleepSeconds, waitUntil } from "../../core/wait";
import { ROOT, shellQuote } from "../../runner";
import {
  isDirectSandboxFallbackUnavailableError,
  privilegedSandboxExecArgv,
} from "../../sandbox/privileged-exec";
import { createTempSshConfig } from "../../sandbox/temp-ssh-config";
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
  type GatewayRestartResult,
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
  RestartSandboxGatewayOptions,
} from "./gateway-restart";

export { buildSandboxExecMarkedCommand } from "./sandbox-exec-output";

export type SandboxCommandResult = {
  status: number;
  stdout: string;
  stderr: string;
};

export type SandboxExecCommandOptions = {
  allowLocalDockerFallback?: boolean;
};

const DEFAULT_SANDBOX_EXEC_TIMEOUT_MS = 15000;

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

function resolveSandboxExecTimeout(timeout = DEFAULT_SANDBOX_EXEC_TIMEOUT_MS): number {
  const timeoutOverride = Number(process.env.NEMOCLAW_SANDBOX_EXEC_TIMEOUT_MS || "");
  return Number.isFinite(timeoutOverride) && timeoutOverride > 0 ? timeoutOverride : timeout;
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
  const sshConfigResult = captureSandboxSshConfig(sandboxName, {
    ignoreError: true,
    timeout: OPENSHELL_PROBE_TIMEOUT_MS,
  });
  if (sshConfigResult.status !== 0) return null;
  if (!sshConfigResult.output.trim()) return null;

  const tmpSshConfig = createTempSshConfig(sshConfigResult.output, "nemoclaw-ssh-");
  try {
    const result = spawnSync(
      "ssh",
      [
        "-F",
        tmpSshConfig.file,
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "ConnectTimeout=5",
        "-o",
        "LogLevel=ERROR",
        `openshell-${sandboxName}`,
        command,
      ],
      {
        encoding: "utf-8",
        env: buildSubprocessEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15000,
      },
    );
    return {
      status: result.status ?? 1,
      stdout: (result.stdout || "").trim(),
      stderr: (result.stderr || "").trim(),
    };
  } catch {
    return null;
  } finally {
    tmpSshConfig.cleanup();
  }
}

function parseSandboxCommandResult(
  result: ReturnType<typeof spawnSync>,
): SandboxCommandResult | null {
  if (result.error) return null;
  const stdout = typeof result.stdout === "string" ? result.stdout : String(result.stdout || "");
  const stderr = typeof result.stderr === "string" ? result.stderr : String(result.stderr || "");
  const commandStdout = extractSandboxExecCommandStdout(stdout);
  if (commandStdout === null) return null;
  return {
    status: result.status ?? 1,
    stdout: commandStdout,
    stderr: stderr.trim(),
  };
}

function executeLocalDockerSandboxCommand(
  sandboxName: string,
  markedCommand: string,
  timeout: number,
): SandboxCommandResult | null {
  let argv: string[];
  try {
    argv = privilegedSandboxExecArgv(sandboxName, ["sh", "-c", markedCommand]);
  } catch (error) {
    // Docker discovery failure or a stopped/nonexistent direct container means
    // there is no local fallback. Identity refusals, unsupported drivers,
    // registry corruption, and ambiguous matches are security-boundary
    // diagnostics: let callers surface them instead of collapsing them into an
    // inconclusive OpenShell transport result.
    if (isDirectSandboxFallbackUnavailableError(error)) return null;
    throw error;
  }

  try {
    const result = dockerSpawnSync(argv, {
      encoding: "utf-8",
      env: buildSubprocessEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
    });
    return parseSandboxCommandResult(result);
  } catch {
    return null;
  }
}

export function executeSandboxExecCommand(
  sandboxName: string,
  command: string,
  timeout = DEFAULT_SANDBOX_EXEC_TIMEOUT_MS,
  options: SandboxExecCommandOptions = {},
): SandboxCommandResult | null {
  const markedCommand = buildSandboxExecMarkedCommand(command);
  const effectiveTimeout = resolveSandboxExecTimeout(timeout);
  try {
    const result = spawnSync(
      getOpenshellBinary(),
      ["sandbox", "exec", "--name", sandboxName, "--", "sh", "-c", markedCommand],
      {
        cwd: ROOT,
        encoding: "utf-8",
        env: buildSubprocessEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        timeout: effectiveTimeout,
      },
    );
    const parsed = parseSandboxCommandResult(result);
    if (parsed !== null) return parsed;
  } catch {
    // OpenShell transport failed; try the trusted direct-container fallback.
  }
  if (options.allowLocalDockerFallback === false) return null;
  // Keep the fallback outside the OpenShell try/catch so a fail-closed identity
  // refusal cannot be caught and retried against changing container state.
  return executeLocalDockerSandboxCommand(sandboxName, markedCommand, effectiveTimeout);
}

export function executeGatewaySupervisorAction(
  sandboxName: string,
  action: "restart" | "recover" | "probe",
  timeout = 210000,
): SandboxCommandResult | null {
  const nonce = randomBytes(32).toString("hex");
  let argv: string[];
  try {
    argv = privilegedSandboxExecArgv(
      sandboxName,
      ["/usr/local/bin/nemoclaw-gateway-control", action, nonce],
      false,
      true,
    );
  } catch (error) {
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
  return !!(
    result &&
    result.status === 0 &&
    (result.stdout.includes("GATEWAY_PID=") || result.stdout.includes("ALREADY_RUNNING"))
  );
}

function isExactlyRetryableManagedRecoveryFailure(result: SandboxCommandResult | null): boolean {
  if (result === null) return false;
  if (result.status !== 1) return false;
  if (result.stdout.trim() !== "") return false;
  const lines = result.stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length === 1 && ["SUPERVISOR_UNAVAILABLE", "SUPERVISOR_BUSY"].includes(lines[0]);
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
  return result === null ? null : false;
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
 * Restart the gateway process inside the sandbox after a pod restart.
 * Cleans stale lock/temp files, sources proxy config, and launches the gateway
 * in the background. Returns true on success.
 */
function recoverSandboxProcesses(
  sandboxName: string,
  {
    quiet = false,
    requestGatewaySupervisorAction = executeGatewaySupervisorAction,
  }: {
    quiet?: boolean;
    requestGatewaySupervisorAction?: typeof executeGatewaySupervisorAction;
  } = {},
): "managed" | "custom" | null {
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
  const recoveredSsh = (result: SandboxCommandResult | null) =>
    !!(result && result.status === 0 && hasGatewayRecoveryMarker(result));
  const recoverManagedGateway = (): boolean => {
    const maxAttempts = 3;
    const retryIntervalSeconds = readNonNegativeNumberEnv(
      "NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS",
      3,
    );
    let execResult: SandboxCommandResult | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      execResult = requestGatewaySupervisorAction(sandboxName, "recover");
      if (hasGatewayRecoveryMarker(execResult)) return true;

      // PID 1 may replace the gateway between the host's stopped observation
      // and the controller's process-tree capture. Retry only exact transient
      // controller results; integrity/config/launch refusals are terminal.
      if (!isExactlyRetryableManagedRecoveryFailure(execResult) || attempt === maxAttempts) break;
      sleepSeconds(retryIntervalSeconds);
    }
    const failure = classifyGatewayRestartFailure(execResult);
    if (!quiet) printGatewayRestartFailure(sandboxName, failure.layer, failure.detail);
    return false;
  };
  if (persistedAgent === "hermes") {
    if (!isHermesAgent(agent)) {
      const detail = "Hermes agent definition could not be loaded.";
      if (!quiet) printGatewayRestartFailure(sandboxName, "unsupported agent", detail);
      return null;
    }
    return recoverManagedGateway() ? "managed" : null;
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
    return recoverManagedGateway() ? "managed" : null;
  }

  const agentScript = agentRuntime.buildRecoveryScript(agent, dashboardPort);
  if (agentRuntime.isTerminalAgentRecoveryScript(agentScript)) return null;
  if (agentScript) {
    // Non-Hermes custom manifests do not yet declare a supported host-side
    // runtime user. Recover them over SSH so the launch inherits the sandbox
    // login user instead of creating root-owned agent state under /sandbox.
    return recoveredSsh(executeSandboxCommand(sandboxName, agentScript)) ? "custom" : null;
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
): void {
  const quotedSandboxName = shellQuote(sandboxName);
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

export function waitForRecoveredSandboxGateway(
  sandboxName: string,
  options: {
    managedProbeImpl?: (sandboxName: string) => boolean | null;
    initialManagedHealthPassed?: boolean;
    probeImpl?: (sandboxName: string) => boolean | null;
    sleepImpl?: (seconds: number) => void;
    quiet?: boolean;
    timeoutSeconds?: number;
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
      : 30;
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
  sleep(settleSeconds);
  if (initialManagedHealthPassed) {
    // The managed probe is a read-only, authenticated point check in the exact
    // gateway network namespace. Its typed failure is authoritative: never let
    // an outer-namespace HTTP response override it or extend this settle check
    // beyond the controller's single bounded probe.
    return managedProbe?.(sandboxName) === true;
  }
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
 * `{ checked, wasRunning, recovered, forwardRecovered, forwardRecoveryFailed?, secretBoundaryRefused?, secretBoundaryReason? }`.
 */
function checkAndRecoverSandboxProcessesWithoutHostLock(
  sandboxName: string,
  {
    quiet = false,
    requestGatewaySupervisorAction = executeGatewaySupervisorAction,
  }: {
    quiet?: boolean;
    requestGatewaySupervisorAction?: typeof executeGatewaySupervisorAction;
  } = {},
) {
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
  const running = isSandboxGatewayRunning(sandboxName);
  if (running === null) {
    return { checked: false, wasRunning: null, recovered: false, forwardRecovered: false };
  }
  const recoveryPort = resolveSandboxDashboardPort(sandboxName);
  if (running) {
    const enforcement = enforceHermesSecretBoundaryOnRunningGateway(
      sandboxName,
      recoveryAgent,
      requestGatewaySupervisorAction,
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
    const mcpRefusal = processRecoveryMcpReconciliationRefusal(sandboxName, true);
    if (mcpRefusal) return mcpRefusal;
  }
  if (running) {
    // Gateway is alive but the host-side forward can still be dead or
    // owned by another sandbox. Probe and re-establish only when
    // necessary so the live-and-healthy path stays a no-op.
    const forwardHealthy = isSandboxForwardHealthy(sandboxName);
    if (forwardHealthy === false) {
      if (!quiet) {
        console.log("");
        console.log(`  Dashboard port forward to '${sandboxName}' is missing or dead.`);
        console.log("  Re-establishing...");
      }
      const forwardRecovered = ensureSandboxPortForward(sandboxName);
      const dashboardForwardRecovered = ensureHermesDashboardPortForwardIfEnabled(sandboxName);
      const messagingForwardRecovered = recoverMessagingHostForward(sandboxName, { quiet });
      const declaredForwardsRecovered = recoverDeclaredAgentForwardPorts(
        sandboxName,
        recoveryPort,
        {
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
      return {
        checked: true,
        wasRunning: true,
        recovered: false,
        forwardRecovered: forwardRecovered || anyAuxiliaryRecovered(auxiliaryResults),
      };
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
    const dashboardForwardRecovered = ensureHermesDashboardPortForwardIfEnabled(sandboxName);
    const messagingForwardRecovered = recoverMessagingHostForward(sandboxName, { quiet });
    const declaredForwardsRecovered = recoverDeclaredAgentForwardPorts(sandboxName, recoveryPort, {
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
      return {
        checked: true,
        wasRunning: true,
        recovered: false,
        forwardRecovered: false,
        forwardRecoveryFailed: true,
        forwardRecoveryFailureDetail: auxiliaryFailureDetail,
      };
    }
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

  const recoveryKind = recoverSandboxProcesses(sandboxName, {
    quiet,
    requestGatewaySupervisorAction,
  });
  if (recoveryKind !== null) {
    // Wait for gateway to bind its HTTP port before declaring success. The
    // recovered process can be alive before the OpenAI-compatible API is ready.
    if (
      !waitForRecoveredSandboxGateway(sandboxName, {
        quiet,
        initialManagedHealthPassed: recoveryKind === "managed",
        timeoutSeconds: gatewayRecoveryTimeoutSeconds(recoveryAgent),
        managedProbeImpl: (name) =>
          confirmRecoveredSandboxGatewayManaged(name, {
            requestGatewaySupervisorActionImpl: requestGatewaySupervisorAction,
          }),
      })
    ) {
      if (!quiet) {
        console.error("  Gateway process started but is not responding.");
        printGatewayWedgeDiagnostics(sandboxName, executeSandboxExecCommand);
        console.error("  Check /tmp/gateway.log inside the sandbox for details.");
        printHostManagedGatewayRecoveryHints(sandboxName, recoveryAgent);
      }
      return { checked: true, wasRunning: false, recovered: false, forwardRecovered: false };
    }
    const mcpRefusal = processRecoveryMcpReconciliationRefusal(sandboxName, false);
    if (mcpRefusal) return mcpRefusal;
    const forwardRecovered = ensureSandboxPortForward(sandboxName);
    const dashboardForwardRecovered = ensureHermesDashboardPortForwardIfEnabled(sandboxName);
    const messagingForwardRecovered = recoverMessagingHostForward(sandboxName, { quiet });
    const declaredForwardsRecovered = recoverDeclaredAgentForwardPorts(sandboxName, recoveryPort, {
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
    return {
      checked: true,
      wasRunning: false,
      recovered: true,
      forwardRecovered: forwardRecovered || anyAuxiliaryRecovered(auxiliaryResults),
    };
  }
  if (!quiet) {
    console.error(`  Could not restart ${recoveryDisplayName} gateway automatically.`);
    printHostManagedGatewayRecoveryHints(sandboxName, recoveryAgent);
  }

  return { checked: true, wasRunning: false, recovered: false, forwardRecovered: false };
}

export function checkAndRecoverSandboxProcesses(
  sandboxName: string,
  options: {
    quiet?: boolean;
    requestGatewaySupervisorAction?: typeof executeGatewaySupervisorAction;
  } = {},
) {
  return withTimerBoundShieldsMutationLock(sandboxName, "gateway process recovery", () =>
    checkAndRecoverSandboxProcessesWithoutHostLock(sandboxName, options),
  );
}
