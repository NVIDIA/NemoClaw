// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { GATEWAY_RESTART_MARKERS as MARKERS } from "../../agent/gateway-restart-markers";
import * as agentRuntime from "../../agent/runtime";
import { G, R } from "../../cli/terminal-style";
import { redactFullWithUrls } from "../../security/redact";
import { hermesMcpReconciliationRemediationLines } from "./mcp-bridge-hermes-reconciliation";
import { inspectHermesMcpReconciliationRefusal } from "./mcp-bridge-recovery";
import { assertHermesPortableCommandUnavailable } from "../../onboard/experimental/portable-agent-lifecycle";
import { withMcpLifecycleLockSync } from "../../state/mcp-lifecycle-lock-acquisition";

export function withUnsupportedHermesPortableGatewayRestartFence<T>(
  sandboxName: string,
  operation: () => T,
): T {
  return withMcpLifecycleLockSync(sandboxName, () => {
    assertHermesPortableCommandUnavailable(sandboxName, "sandbox:gateway:restart");
    return operation();
  });
}

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
  | "privileged control unavailable"
  | "supervisor not running"
  | "supervisor unavailable"
  | "container identity changed"
  | "secret-boundary refusal"
  | "unsafe config path"
  | "config hash mismatch"
  | "MCP reconciliation refusal"
  | "relaunch quarantined"
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
    }
  | {
      ok: false;
      failureLayer: "MCP reconciliation refusal";
      detail: string;
      restarted: true;
      healthPassed: true;
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

// Substrings of the in-sandbox supervisor's quarantine lines. The supervisor
// only forwards allowlisted lines to the host, so matching them is what tells
// the host that no further relaunch will be attempted until the sandbox is
// rebuilt. Keep in sync with the quarantine messages in agents/hermes/start.sh
// and their allowlist in scripts/managed-gateway-control.py.
const GATEWAY_RELAUNCH_QUARANTINE_MARKERS = [
  "quarantined until sandbox recreation",
  "quarantined until MCP integrity is restored",
  "quarantined without another launch",
  "quarantining the managed startup supervisor",
] as const;

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
  inspectHermesMcpReconciliationRefusal: typeof inspectHermesMcpReconciliationRefusal;
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
          outputLines.filter((line) => !isIdentityChangedMarkerLine(line)).join("\n").trim(),
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
  // A quarantined supervisor is the strictly more specific and terminal fact:
  // it stops attempting relaunch entirely, so the controller then reports the
  // generic health timeout it would report for any unresponsive gateway, and a
  // config refusal that tripped the crash budget is reported as MCP drift by the
  // non-root startup guard. Classify the quarantine ahead of both so the host
  // names the state that actually blocks recovery instead of its side effect.
  if (GATEWAY_RELAUNCH_QUARANTINE_MARKERS.some((marker) => output.includes(marker))) {
    return {
      layer: "relaunch quarantined",
      detail: detail || "the in-sandbox supervisor quarantined gateway relaunch",
    };
  }
  if (
    output.includes("mcp-integrity") ||
    output.includes("mcp-reconcile-required") ||
    output.includes("HERMES_MCP_CONFIG_DRIFT")
  ) {
    return {
      layer: "MCP reconciliation refusal",
      detail: detail || "Hermes MCP reconciliation refused",
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
    return { layer: "health timeout", detail: detail || "gateway health timeout" };
  }
  return { layer: "launch failure", detail: detail || `restart exited ${result.status}` };
}

export function isGatewayIntegrityRepairLayer(
  layer: GatewayRestartFailureLayer | null | undefined,
): layer is "config hash mismatch" | "relaunch quarantined" {
  return layer === "config hash mismatch" || layer === "relaunch quarantined";
}

/**
 * The supported repair for a sandbox whose protected configuration drifted away
 * from its recorded integrity metadata. Both layers are deterministic refusals:
 * every relaunch re-reads the same drifted file, so retrying a restart or a
 * recover only burns the supervisor's crash budget. `rebuild` is the documented
 * command that restores the registered configuration, refreshes the integrity
 * hashes, and brings the gateway back in one transaction (#7801).
 */
export function gatewayIntegrityRepairLines(
  sandboxName: string,
  layer: "config hash mismatch" | "relaunch quarantined",
): readonly string[] {
  const cause =
    layer === "config hash mismatch"
      ? "A protected configuration file no longer matches its recorded integrity hash."
      : "The in-sandbox supervisor quarantined gateway relaunch after a startup refusal.";
  return [
    `${cause} Retrying the restart cannot clear it.`,
    `Restore the registered configuration and refresh its integrity metadata with \`nemoclaw ${sandboxName} rebuild --yes\`.`,
    `Then make intended changes through supported commands such as \`nemoclaw ${sandboxName} config set\` or \`nemoclaw inference set --sandbox ${sandboxName}\`, which update the configuration and its hashes together.`,
  ];
}

const HERMES_GATEWAY_LOG_TAIL_LINES = 12;
const HERMES_GATEWAY_LOG_TAIL_COMMAND = `tail -n ${String(HERMES_GATEWAY_LOG_TAIL_LINES)} /tmp/gateway.log 2>/dev/null || true`;

function hermesGatewayLogTail(
  sandboxName: string,
  exec: (sandboxName: string, command: string) => GatewayRestartCommandResult | null,
): string[] {
  const result = exec(sandboxName, HERMES_GATEWAY_LOG_TAIL_COMMAND);
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
  if (layer === "MCP reconciliation refusal") {
    for (const line of hermesMcpReconciliationRemediationLines(sandboxName)) {
      console.error(`  ${line}`);
    }
  }
  if (gatewayLogTail.length > 0) {
    console.error("  Hermes gateway log tail (sanitized):");
    for (const line of gatewayLogTail) console.error(`  ${line}`);
  }
  if (isGatewayIntegrityRepairLayer(layer)) {
    for (const line of gatewayIntegrityRepairLines(sandboxName, layer)) {
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
    const gatewayLogTail =
      agentName === "hermes"
        ? hermesGatewayLogTail(sandboxName, deps.executeSandboxExecCommand)
        : [];
    printGatewayRestartFailure(sandboxName, failure.layer, failure.detail, gatewayLogTail);
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

  if (agentName === "hermes") {
    const refusal = deps.inspectHermesMcpReconciliationRefusal(sandboxName);
    if (refusal) {
      const { detail } = refusal;
      printGatewayRestartFailure(sandboxName, "MCP reconciliation refusal", detail);
      return {
        ok: false,
        failureLayer: "MCP reconciliation refusal",
        detail,
        restarted: true,
        healthPassed: true,
      };
    }
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
