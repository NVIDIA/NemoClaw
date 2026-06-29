// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { GATEWAY_RESTART_MARKERS as MARKERS } from "../../agent/gateway-restart-markers";
import * as agentRuntime from "../../agent/runtime";
import { G, R } from "../../cli/terminal-style";
import { redactFull } from "../../security/redact";

export type GatewayRestartCommandResult = {
  status: number;
  stdout: string;
  stderr: string;
};

export type GatewayRestartFailureLayer =
  | "unsupported agent"
  | "privileged control unavailable"
  | "secret-boundary refusal"
  | "unsafe config path"
  | "config hash mismatch"
  | "launch failure"
  | "health timeout"
  | "forward recovery failure";

export type GatewayRestartResult =
  | {
      ok: true;
      restarted: true;
      healthPassed: true;
      forwardRecovered: boolean;
    }
  | {
      ok: false;
      failureLayer: GatewayRestartFailureLayer;
      detail: string;
    };

type SandboxAgentLookup = (sandboxName: string) => { agent?: string | null } | null | undefined;

type SupervisorAction = (
  sandboxName: string,
  action: "restart" | "recover" | "probe",
  timeout?: number,
) => GatewayRestartCommandResult | null;

type SandboxExec = (
  sandboxName: string,
  command: string,
  timeout?: number,
) => GatewayRestartCommandResult | null;

const GATEWAY_RESTART_SUPPORTED_AGENTS = ["openclaw", "hermes"] as const;

export type GatewayRestartDeps = {
  getSessionAgent: typeof agentRuntime.getSessionAgent;
  getSandbox: SandboxAgentLookup;
  resolveSandboxDashboardPort: (sandboxName: string) => number;
  requestGatewaySupervisorAction: SupervisorAction;
  executeSandboxExecCommand: SandboxExec;
  waitForRecoveredSandboxGateway: (
    sandboxName: string,
    options?: {
      quiet?: boolean;
      timeoutSeconds?: number;
      initialManagedHealthPassed?: boolean;
    },
  ) => boolean;
  ensureSandboxPortForward: (sandboxName: string) => boolean;
  ensureHermesDashboardPortForwardIfEnabled: (sandboxName: string) => boolean | null;
  recoverMessagingHostForward: (sandboxName: string, options: { quiet: boolean }) => boolean | null;
  recoverDeclaredAgentForwardPorts: (
    sandboxName: string,
    recoveryPort: number,
    options: { quiet: boolean },
  ) => boolean | null;
  printGatewayWedgeDiagnostics: (
    sandboxName: string,
    exec: (sandboxName: string, command: string) => GatewayRestartCommandResult | null,
  ) => boolean;
};

export type RestartSandboxGatewayOptions = {
  quiet?: boolean;
  deps?: Partial<GatewayRestartDeps>;
};

export function sandboxAgentName(
  sandboxName: string,
  getSandbox: SandboxAgentLookup,
): string | null {
  return getSandbox(sandboxName)?.agent ?? null;
}

function gatewayRestartOutput(result: GatewayRestartCommandResult): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

const ANSI_CONTROL_RE =
  /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)|[@-_])|[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

function sanitizeGatewayRestartFailureLine(line: string): string {
  return redactFull(line.replace(ANSI_CONTROL_RE, ""));
}

function sanitizeGatewayRestartFailureDetail(detail: string): string {
  return detail
    .split(/\r?\n/)
    .map((line) => sanitizeGatewayRestartFailureLine(line.trim()))
    .filter(Boolean)
    .join("\n");
}

export function classifyGatewayRestartFailure(result: GatewayRestartCommandResult | null): {
  layer: GatewayRestartFailureLayer;
  detail: string;
} {
  if (!result) {
    return {
      layer: "privileged control unavailable",
      detail: "privileged gateway supervisor control did not return command output",
    };
  }

  const output = gatewayRestartOutput(result);
  const detail = sanitizeGatewayRestartFailureDetail(output.trim());
  if (
    output.includes(MARKERS.ROOT_EXEC_UNAVAILABLE) ||
    output.includes("PRIVILEGED_CONTROL_UNAVAILABLE") ||
    output.includes("SUPERVISOR_UNAVAILABLE") ||
    output.includes("SUPERVISOR_REBUILD_REQUIRED") ||
    output.includes("SUPERVISOR_UNSAFE_CONTROL_DIR") ||
    output.includes("SUPERVISOR_BUSY") ||
    output.includes("SUPERVISOR_SIGNAL_FAILED") ||
    output.includes("SUPERVISOR_INVALID_STATUS") ||
    output.includes(MARKERS.GOSU_MISSING) ||
    output.includes(MARKERS.GATEWAY_USER_MISSING)
  ) {
    return {
      layer: "privileged control unavailable",
      detail: detail || "privileged gateway supervisor control unavailable",
    };
  }
  if (output.includes(MARKERS.SECRET_BOUNDARY_REFUSED)) {
    return { layer: "secret-boundary refusal", detail: detail || "boundary refused" };
  }
  if (
    output.includes(MARKERS.GATEWAY_UNSAFE_CONFIG_PATH) ||
    output.includes("HERMES_UNSAFE_CONFIG_PATH") ||
    output.includes(MARKERS.HERMES_RUNTIME_CONFIG_GUARD_MISSING) ||
    output.includes(MARKERS.SECRET_BOUNDARY_VALIDATOR_MISSING)
  ) {
    return { layer: "unsafe config path", detail: detail || "unsafe config path" };
  }
  if (
    output.includes(MARKERS.GATEWAY_CONFIG_HASH_MISMATCH) ||
    output.includes("HERMES_LOCKED_HASH_MISMATCH") ||
    output.includes("HERMES_CONFIG_HASH_MISMATCH")
  ) {
    return {
      layer: "config hash mismatch",
      detail: detail || "gateway config hash mismatch",
    };
  }
  if (output.includes("GATEWAY_HEALTH_TIMEOUT") || output.includes("SUPERVISOR_TIMEOUT")) {
    return { layer: "health timeout", detail: detail || "gateway health timeout" };
  }
  return { layer: "launch failure", detail: detail || `restart exited ${result.status}` };
}

export function printGatewayRestartFailure(
  sandboxName: string,
  layer: GatewayRestartFailureLayer,
  detail: string,
): void {
  console.error(`  Failure layer: ${layer} - gateway restart failed for '${sandboxName}'.`);
  if (!detail.trim()) return;
  const lines = detail
    .split(/\r?\n/)
    .map((line) => sanitizeGatewayRestartFailureLine(line.trim()))
    .filter(Boolean)
    .slice(-12);
  for (const line of lines) {
    console.error(`  ${line}`);
  }
}

function unsupportedGatewayRestartAgentDetail(agentName: string, reason: string): string {
  return [
    `Agent '${agentName}' does not support gateway restart.`,
    `Gateway restart-supported agents: ${GATEWAY_RESTART_SUPPORTED_AGENTS.join(", ")}.`,
    reason,
  ].join("\n");
}

type RestartAuxiliaryRecoveryResult = {
  label: string;
  recovered: boolean | null;
};

function failedAuxiliaryRecoveryDetail(results: RestartAuxiliaryRecoveryResult[]): string | null {
  const failed = results
    .filter((result) => result.recovered === false)
    .map((result) => result.label);
  if (failed.length === 0) return null;
  return `gateway health passed but ${failed.join(", ")} could not be re-established`;
}

export function restartSandboxGatewayWithDeps(
  sandboxName: string,
  {
    quiet = false,
    deps,
  }: {
    quiet?: boolean;
    deps: GatewayRestartDeps;
  },
): GatewayRestartResult {
  const agent = deps.getSessionAgent(sandboxName);
  let persistedAgent: string | null;
  try {
    persistedAgent = sandboxAgentName(sandboxName, deps.getSandbox);
  } catch (error) {
    const reason =
      error instanceof Error && error.message.trim()
        ? `Sandbox agent lookup failed: ${error.message}.`
        : "Sandbox agent lookup failed.";
    const detail = unsupportedGatewayRestartAgentDetail("unknown", reason);
    printGatewayRestartFailure(sandboxName, "unsupported agent", detail);
    return { ok: false, failureLayer: "unsupported agent", detail };
  }
  const agentName = agent?.name ?? persistedAgent ?? "openclaw";
  const dashboardPort = deps.resolveSandboxDashboardPort(sandboxName);

  if (!agent && persistedAgent && persistedAgent !== "openclaw") {
    const detail = unsupportedGatewayRestartAgentDetail(
      persistedAgent,
      `${persistedAgent} agent definition could not be loaded.`,
    );
    printGatewayRestartFailure(sandboxName, "unsupported agent", detail);
    return { ok: false, failureLayer: "unsupported agent", detail };
  }
  if (agent && !agentRuntime.hasGatewayRuntime(agent)) {
    const detail = unsupportedGatewayRestartAgentDetail(
      agent.name,
      `${agentRuntime.getAgentDisplayName(agent)} has no gateway runtime.`,
    );
    printGatewayRestartFailure(sandboxName, "unsupported agent", detail);
    return { ok: false, failureLayer: "unsupported agent", detail };
  }
  if (agentName === "hermes") {
    if (!agent || agent.name !== "hermes") {
      const detail = "Hermes agent definition could not be loaded.";
      printGatewayRestartFailure(sandboxName, "unsupported agent", detail);
      return { ok: false, failureLayer: "unsupported agent", detail };
    }
  } else if (agentName !== "openclaw" || (agent && agent.name !== "openclaw")) {
    const unsupportedAgentName = agent?.name ?? agentName;
    const reason =
      `${agentRuntime.getAgentDisplayName(agent)} does not declare a supported supervisor-mediated ` +
      "gateway restart runtime.";
    const detail = unsupportedGatewayRestartAgentDetail(unsupportedAgentName, reason);
    printGatewayRestartFailure(sandboxName, "unsupported agent", detail);
    return { ok: false, failureLayer: "unsupported agent", detail };
  }

  if (!quiet) {
    console.log("");
    console.log(
      `  Restarting ${agentRuntime.getAgentDisplayName(agent)} gateway in '${sandboxName}'...`,
    );
  }
  const restartResult = deps.requestGatewaySupervisorAction(sandboxName, "restart", 210000);
  const hasRestartMarker =
    restartResult?.status === 0 &&
    restartResult.stdout.split(/\r?\n/).some((line) => line.startsWith("GATEWAY_PID="));
  if (!hasRestartMarker) {
    const failure = classifyGatewayRestartFailure(restartResult);
    printGatewayRestartFailure(sandboxName, failure.layer, failure.detail);
    return { ok: false, failureLayer: failure.layer, detail: failure.detail };
  }

  if (
    !deps.waitForRecoveredSandboxGateway(sandboxName, {
      quiet,
      initialManagedHealthPassed: true,
    })
  ) {
    const detail = "gateway process restarted but health did not pass before timeout";
    printGatewayRestartFailure(sandboxName, "health timeout", detail);
    deps.printGatewayWedgeDiagnostics(sandboxName, deps.executeSandboxExecCommand);
    return { ok: false, failureLayer: "health timeout", detail };
  }

  const forwardRecovered = deps.ensureSandboxPortForward(sandboxName);
  const dashboardForwardRecovered = deps.ensureHermesDashboardPortForwardIfEnabled(sandboxName);
  const messagingForwardRecovered = deps.recoverMessagingHostForward(sandboxName, { quiet });
  const declaredForwardsRecovered = deps.recoverDeclaredAgentForwardPorts(
    sandboxName,
    dashboardPort,
    { quiet },
  );
  const auxiliaryFailureDetail = failedAuxiliaryRecoveryDetail([
    { label: "the Hermes dashboard host forward", recovered: dashboardForwardRecovered },
    { label: "the messaging webhook host forward", recovered: messagingForwardRecovered },
    { label: "one or more agent-declared host forwards", recovered: declaredForwardsRecovered },
  ]);

  if (!forwardRecovered) {
    const detail =
      "gateway health passed but the primary dashboard/API host forward could not be re-established";
    printGatewayRestartFailure(sandboxName, "forward recovery failure", detail);
    return { ok: false, failureLayer: "forward recovery failure", detail };
  }
  if (auxiliaryFailureDetail !== null) {
    printGatewayRestartFailure(sandboxName, "forward recovery failure", auxiliaryFailureDetail);
    return { ok: false, failureLayer: "forward recovery failure", detail: auxiliaryFailureDetail };
  }

  if (!quiet) {
    console.log(
      `  ${G}✓${R} Gateway restarted; health passed; forwards checked/recovered for '${sandboxName}'.`,
    );
  }
  return {
    ok: true,
    restarted: true,
    healthPassed: true,
    forwardRecovered:
      forwardRecovered ||
      dashboardForwardRecovered === true ||
      messagingForwardRecovered === true ||
      declaredForwardsRecovered === true,
  };
}
