// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { SandboxCommandTransportError } from "../../adapters/sandbox/command-transport";
import { GATEWAY_RESTART_MARKERS as MARKERS } from "../../agent/gateway-restart-markers";
import * as agentRuntime from "../../agent/runtime";
import { G, R } from "../../cli/terminal-style";
import { redactFullWithUrls } from "../../security/redact";

export type GatewayRestartCommandResult = {
  status: number;
  stdout: string;
  stderr: string;
};

export const MANAGED_CONTROL_IDENTITY_CHANGED_MARKER = "MANAGED_CONTROL_IDENTITY_CHANGED";

export type ManagedGatewayControlCompletion = {
  disposition: "ok" | "already-running";
  oldPid: number;
  newPid: number;
};

export function parseManagedGatewayControlCompletion(
  result: GatewayRestartCommandResult | null,
): ManagedGatewayControlCompletion | null {
  if (!result || result.status !== 0 || result.stderr.trim()) return null;
  const lines = result.stdout.trim().split(/\r?\n/);
  if (lines.length !== 2) return null;
  const completion = lines[0]?.match(
    /^v1 ([0-9a-f]{64}) complete (ok|already-running) ([0-9]+) ([1-9][0-9]*)$/,
  );
  if (completion === null || lines[1] !== `GATEWAY_PID=${completion[4]}`) return null;
  const disposition = completion[2] as ManagedGatewayControlCompletion["disposition"];
  const oldPid = Number.parseInt(completion[3], 10);
  const newPid = Number.parseInt(completion[4], 10);
  if (!Number.isSafeInteger(oldPid) || !Number.isSafeInteger(newPid)) {
    return null;
  }
  return {
    disposition,
    oldPid,
    newPid,
  };
}

export type GatewayRestartFailureLayer =
  | "unsupported agent"
  | "native agent command"
  | "privileged control unavailable"
  | "supervisor not running"
  | "supervisor unavailable"
  | "container identity changed"
  | "secret-boundary refusal"
  | "unsafe config path"
  | "config hash mismatch"
  | "mcp configuration drift"
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
      restarted?: never;
      healthPassed?: never;
    };

type SandboxAgentLookup = (sandboxName: string) => { agent?: string | null } | null | undefined;

type SandboxExec = (
  sandboxName: string,
  command: string,
  timeout?: number,
) => Promise<GatewayRestartCommandResult | null>;

const GATEWAY_RESTART_SUPPORTED_AGENTS = ["openclaw", "hermes"] as const;

export type GatewayRestartDeps = {
  getSessionAgent: typeof agentRuntime.getSessionAgent;
  getSandbox: SandboxAgentLookup;
  resolveSandboxDashboardPort: (sandboxName: string) => number;
  buildOpenClawReadinessProbeCommand: (sandboxName: string) => string;
  executeSandboxExecCommand: SandboxExec;
  waitForSandboxControlPlaneReady: (sandboxName: string) => Promise<boolean>;
  waitForRecoveredSandboxGateway: (
    sandboxName: string,
    options?: {
      quiet?: boolean;
      timeoutSeconds?: number;
      initialManagedHealthPassed?: boolean;
      managedProbeImpl?: (sandboxName: string) => boolean | null;
      probeImpl?: (sandboxName: string) => Promise<boolean | null>;
    },
  ) => Promise<boolean>;
  ensureSandboxPortForward: (sandboxName: string) => boolean | Promise<boolean>;
  ensureHermesDashboardPortForwardIfEnabled: (
    sandboxName: string,
  ) => boolean | null | Promise<boolean | null>;
  recoverMessagingHostForward: (
    sandboxName: string,
    options: { quiet: boolean },
  ) => boolean | null | Promise<boolean | null>;
  recoverDeclaredAgentForwardPorts: (
    sandboxName: string,
    recoveryPort: number,
    options: { quiet: boolean },
  ) => boolean | null | Promise<boolean | null>;
  printGatewayWedgeDiagnostics: (
    sandboxName: string,
    exec: (sandboxName: string, command: string) => Promise<GatewayRestartCommandResult | null>,
  ) => Promise<boolean>;
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

/** Hermes can replace its gateway successfully while closing the exec relay that issued restart. */
const HERMES_RESTART_RELAY_CLOSED = "exec relay closed before the command reported an exit status";
const OPENSHELL_SERVICE_UNAVAILABLE = "code: 'The service is currently unavailable'";

export function isExpectedHermesRestartRelayClosure(
  result: GatewayRestartCommandResult | null,
): boolean {
  if (!result || result.status === 0) return false;
  const output = gatewayRestartOutput(result).replace(/[\s│]+/gu, " ");
  return (
    output.includes(OPENSHELL_SERVICE_UNAVAILABLE) && output.includes(HERMES_RESTART_RELAY_CLOSED)
  );
}

const ANSI_CONTROL_RE =
  /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)|[@-_])|[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

function sanitizeGatewayRestartFailureLine(line: string): string {
  const withoutControls = line.replace(ANSI_CONTROL_RE, "");
  return redactFullWithUrls(withoutControls);
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
  const outputLines = output.split(/\r?\n/);
  const isIdentityChangedMarkerLine = (line: string) =>
    line.trim() === MANAGED_CONTROL_IDENTITY_CHANGED_MARKER;
  const hasIdentityChangedMarker = outputLines.some(isIdentityChangedMarkerLine);
  const detail = sanitizeGatewayRestartFailureDetail(output.trim());
  if (output.includes("SUPERVISOR_NOT_RUNNING")) {
    return {
      layer: "supervisor not running",
      detail: detail || "the in-sandbox gateway supervisor is not running",
    };
  }
  if (output.includes("SUPERVISOR_DISCOVERY_PENDING")) {
    return {
      layer: "supervisor unavailable",
      detail: detail || "the managed gateway supervisor is still starting",
    };
  }
  if (output.includes("SUPERVISOR_UNAVAILABLE") && output.includes("NEMOCLAW_CONTROL_STAGE=")) {
    return {
      layer: "supervisor unavailable",
      detail: detail || "the managed gateway supervisor became unavailable",
    };
  }
  if (hasIdentityChangedMarker) {
    return {
      layer: "container identity changed",
      detail:
        sanitizeGatewayRestartFailureDetail(
          outputLines
            .filter((line) => !isIdentityChangedMarkerLine(line))
            .join("\n")
            .trim(),
        ) || "the selected container identity changed",
    };
  }
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
    return {
      layer: "secret-boundary refusal",
      detail: detail || "boundary refused",
    };
  }
  if (
    output.includes(MARKERS.GATEWAY_UNSAFE_CONFIG_PATH) ||
    output.includes("HERMES_UNSAFE_CONFIG_PATH") ||
    output.includes(MARKERS.HERMES_RUNTIME_CONFIG_GUARD_MISSING) ||
    output.includes(MARKERS.SECRET_BOUNDARY_VALIDATOR_MISSING)
  ) {
    return {
      layer: "unsafe config path",
      detail: detail || "unsafe config path",
    };
  }
  if (output.includes("HERMES_MCP_CONFIG_DRIFT")) {
    return {
      layer: "mcp configuration drift",
      detail: detail || "Hermes MCP configuration integrity check failed",
    };
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
    return {
      layer: "health timeout",
      detail: detail || "gateway health timeout",
    };
  }
  return {
    layer: "launch failure",
    detail: detail || `restart exited ${result.status}`,
  };
}

export function isGatewayTerminalRepairLayer(
  layer: GatewayRestartFailureLayer | null | undefined,
): layer is "config hash mismatch" | "mcp configuration drift" {
  return layer === "config hash mismatch" || layer === "mcp configuration drift";
}

/** Report terminal native configuration repair guidance. */
export function gatewayTerminalRepairLines(
  sandboxName: string,
  layer: "config hash mismatch" | "mcp configuration drift",
): readonly string[] {
  if (layer === "mcp configuration drift") {
    return [
      "Hermes refused the gateway restart because its native MCP configuration is missing, conflicting, or not reconciled.",
      `Inspect the source-backed state with \`nemoclaw ${sandboxName} mcp status --json\`.`,
      `Migrate legacy entries with \`nemoclaw ${sandboxName} mcp migrate --apply\`; repair a missing or conflicting entry explicitly, or remove and add it again.`,
      "Retry the gateway restart only after MCP status reports configured policy and provider sources.",
    ];
  }
  return [
    "The restart transaction could not validate its integrity metadata.",
    `Restore the registered configuration and refresh its integrity metadata with \`nemoclaw ${sandboxName} rebuild --yes\`.`,
  ];
}

const HERMES_GATEWAY_LOG_TAIL_LINES = 12;
const HERMES_GATEWAY_LOG_TAIL_COMMAND = `tail -n ${String(HERMES_GATEWAY_LOG_TAIL_LINES)} /tmp/gateway.log 2>/dev/null || true`;

async function hermesGatewayLogTail(
  sandboxName: string,
  exec: (sandboxName: string, command: string) => Promise<GatewayRestartCommandResult | null>,
): Promise<string[]> {
  const result = await exec(sandboxName, HERMES_GATEWAY_LOG_TAIL_COMMAND).catch(
    (error: unknown) => {
      if (!(error instanceof SandboxCommandTransportError)) throw error;
      return null;
    },
  );
  if (!result || result.status !== 0) return [];
  return sanitizeGatewayRestartFailureDetail(result.stdout)
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-HERMES_GATEWAY_LOG_TAIL_LINES);
}

export function printGatewayRestartFailure(
  sandboxName: string,
  layer: GatewayRestartFailureLayer,
  detail: string,
  gatewayLogTail: readonly string[] = [],
): void {
  console.error(`  Failure layer: ${layer} - gateway restart failed for '${sandboxName}'.`);
  if (detail.trim()) {
    const lines = detail
      .split(/\r?\n/)
      .map((line) => sanitizeGatewayRestartFailureLine(line.trim()))
      .filter(Boolean)
      .slice(-12);
    for (const line of lines) {
      console.error(`  ${line}`);
    }
  }
  // Remediation is emitted outside the detail guard: an empty controller detail
  // is exactly the case where the operator has nothing else to go on.
  if (gatewayLogTail.length > 0) {
    console.error("  Hermes gateway log tail (sanitized):");
    for (const line of gatewayLogTail) console.error(`  ${line}`);
  }
  if (isGatewayTerminalRepairLayer(layer)) {
    for (const line of gatewayTerminalRepairLines(sandboxName, layer)) {
      console.error(`  ${line}`);
    }
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

function openClawRestartReady(result: GatewayRestartCommandResult | null): boolean | null {
  if (result === null) return null;
  const output = result.stdout.trimEnd();
  const separator = output.lastIndexOf("\n");
  if (result.status !== 0 || separator < 0 || output.slice(separator + 1).trim() !== "200") {
    return false;
  }
  try {
    const document: unknown = JSON.parse(output.slice(0, separator));
    return (
      document !== null &&
      typeof document === "object" &&
      "ready" in document &&
      document.ready === true
    );
  } catch {
    return false;
  }
}

export async function restartSandboxGatewayWithDeps(
  sandboxName: string,
  {
    quiet = false,
    deps,
  }: {
    quiet?: boolean;
    deps: GatewayRestartDeps;
  },
): Promise<GatewayRestartResult> {
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
    const reason = `${agentRuntime.getAgentDisplayName(agent)} does not declare a supported native gateway restart runtime.`;
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
  const nativeCommand =
    agentName === "openclaw"
      ? "env -u OPENCLAW_HOME -u OPENCLAW_STATE_DIR -u OPENCLAW_CONFIG_PATH openclaw gateway restart --safe --skip-deferral --json"
      : `${agentName} gateway restart`;
  let restartResult: GatewayRestartCommandResult | null;
  try {
    restartResult = await deps.executeSandboxExecCommand(sandboxName, nativeCommand, 210000);
  } catch (error) {
    if (!(error instanceof SandboxCommandTransportError)) throw error;
    const detail = sanitizeGatewayRestartFailureDetail(error.message);
    printGatewayRestartFailure(sandboxName, "native agent command", detail);
    return { ok: false, failureLayer: "native agent command", detail };
  }
  if (!restartResult) {
    const detail = `${nativeCommand} did not return command output`;
    const gatewayLogTail =
      agentName === "hermes"
        ? await hermesGatewayLogTail(sandboxName, deps.executeSandboxExecCommand)
        : [];
    printGatewayRestartFailure(sandboxName, "native agent command", detail, gatewayLogTail);
    return { ok: false, failureLayer: "native agent command", detail };
  }
  const hermesRelayClosed =
    agentName === "hermes" && isExpectedHermesRestartRelayClosure(restartResult);
  if (restartResult.status !== 0 && !hermesRelayClosed) {
    const classified = classifyGatewayRestartFailure(restartResult);
    if (agentName === "hermes" && classified.layer === "secret-boundary refusal") {
      printGatewayRestartFailure(sandboxName, classified.layer, classified.detail);
      return { ok: false, failureLayer: classified.layer, detail: classified.detail };
    }
    const detail =
      sanitizeGatewayRestartFailureDetail(gatewayRestartOutput(restartResult)) ||
      `${nativeCommand} exited ${restartResult.status}`;
    const gatewayLogTail =
      agentName === "hermes"
        ? await hermesGatewayLogTail(sandboxName, deps.executeSandboxExecCommand)
        : [];
    printGatewayRestartFailure(sandboxName, "native agent command", detail, gatewayLogTail);
    return { ok: false, failureLayer: "native agent command", detail };
  }

  if (hermesRelayClosed && !(await deps.waitForSandboxControlPlaneReady(sandboxName))) {
    const detail = "Hermes restarted, but its OpenShell exec relay did not re-register";
    printGatewayRestartFailure(sandboxName, "health timeout", detail);
    return { ok: false, failureLayer: "health timeout", detail };
  }

  if (
    !(await deps.waitForRecoveredSandboxGateway(sandboxName, {
      quiet,
      initialManagedHealthPassed: false,
      managedProbeImpl: () => null,
      ...(agentName === "openclaw"
        ? {
            probeImpl: async (name: string) => {
              // Liveness stays green while OpenClaw refuses work during restart.
              // Readiness checks the same admission fence as user requests.
              try {
                const result = await deps.executeSandboxExecCommand(
                  name,
                  deps.buildOpenClawReadinessProbeCommand(name),
                  10_000,
                );
                return openClawRestartReady(result);
              } catch (error) {
                if (!(error instanceof SandboxCommandTransportError)) throw error;
                return null;
              }
            },
          }
        : {}),
    }))
  ) {
    const detail = `gateway process restarted but ${agentName === "openclaw" ? "readiness" : "health"} did not pass before timeout`;
    printGatewayRestartFailure(sandboxName, "health timeout", detail);
    await deps.printGatewayWedgeDiagnostics(sandboxName, deps.executeSandboxExecCommand);
    return { ok: false, failureLayer: "health timeout", detail };
  }

  const forwardRecovered = await deps.ensureSandboxPortForward(sandboxName);
  const dashboardForwardRecovered =
    await deps.ensureHermesDashboardPortForwardIfEnabled(sandboxName);
  const messagingForwardRecovered = await deps.recoverMessagingHostForward(sandboxName, { quiet });
  const declaredForwardsRecovered = await deps.recoverDeclaredAgentForwardPorts(
    sandboxName,
    dashboardPort,
    { quiet },
  );
  const auxiliaryFailureDetail = failedAuxiliaryRecoveryDetail([
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
  ]);

  if (!forwardRecovered) {
    const detail =
      "gateway health passed but the primary dashboard/API host forward could not be re-established";
    printGatewayRestartFailure(sandboxName, "forward recovery failure", detail);
    return { ok: false, failureLayer: "forward recovery failure", detail };
  }
  if (auxiliaryFailureDetail !== null) {
    printGatewayRestartFailure(sandboxName, "forward recovery failure", auxiliaryFailureDetail);
    return {
      ok: false,
      failureLayer: "forward recovery failure",
      detail: auxiliaryFailureDetail,
    };
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
