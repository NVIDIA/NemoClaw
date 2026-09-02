// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runOpenshellProviderCommand } from "../../adapters/openshell/provider-command";
import { getAgentBranding } from "../../cli/branding";
import { waitUntil } from "../../core/wait";
import { isShieldsDown } from "../../shields";
import type { McpBridgeEntry } from "../../state/registry";
import {
  classifyGatewayRestartFailure,
  parseManagedGatewayControlCompletion,
} from "./gateway-restart";
import {
  type AdapterMutationOptions,
  type AdapterRegistrationInspection,
  inspectAdapterRegistrationCommand,
} from "./mcp-bridge-adapter-inspection";
import {
  buildHermesMcpStatusCommand,
  entryHeaders,
  HERMES_MCP_TRANSACTION_HELPER,
} from "./mcp-bridge-adapter-status";
import {
  type McpAttachedCredentialRevision,
  observeMcpCredentialRevision,
} from "./mcp-bridge-provider-readiness";
import { McpBridgeError } from "./mcp-bridge-contracts";
import { commandOutput, redactBridgeSecretsForDisplay } from "./mcp-bridge-output";
import { executeGatewaySupervisorAction } from "./process-recovery";

const HERMES_MCP_EXEC_TIMEOUT_SECONDS = 620;
const HERMES_MCP_PROBE_TIMEOUT_SECONDS = 30;
const HERMES_MCP_STARTUP_TIMEOUT_SECONDS = 90;
const HERMES_MCP_RECOVERY_TIMEOUT_MS = 210_000;
const HERMES_MCP_INITIAL_PROBE_ATTEMPTS = 3;
const HERMES_MCP_GATEWAY_NOT_READY = "Hermes gateway is not running for managed MCP reload";
const HERMES_MCP_LIFECYCLE_NOT_READY =
  "Hermes gateway is not running under the managed service lifecycle";

export function buildHermesMcpRegisterCommand(
  entry: McpBridgeEntry,
  replaceExisting = false,
  credentialRevision?: McpAttachedCredentialRevision,
): string[] {
  const payload = {
    server: entry.server,
    url: entry.url,
    headers: entryHeaders(entry, credentialRevision),
    replace_existing: replaceExisting,
  };
  return [HERMES_MCP_TRANSACTION_HELPER, "add", "--payload", JSON.stringify(payload)];
}

function buildHermesMcpRemoveCommand(entry: McpBridgeEntry, force = false): string[] {
  const payload = {
    server: entry.server,
    url: entry.url,
    headers: entryHeaders(entry),
    force,
  };
  return [HERMES_MCP_TRANSACTION_HELPER, "remove", "--payload", JSON.stringify(payload)];
}

export function buildHermesMcpExecArgs(
  sandboxName: string,
  command: readonly string[],
  timeoutSeconds = HERMES_MCP_EXEC_TIMEOUT_SECONDS,
): string[] {
  return [
    "sandbox",
    "exec",
    "--name",
    sandboxName,
    "--timeout",
    String(timeoutSeconds),
    "--no-tty",
    "--",
    ...command,
  ];
}

export function buildHermesMcpProbeCommand(): string[] {
  return [HERMES_MCP_TRANSACTION_HELPER, "probe"];
}

export function inspectHermesAdapterRegistration(
  sandboxName: string,
  entry: McpBridgeEntry,
  credentialRevision?: McpAttachedCredentialRevision,
): AdapterRegistrationInspection {
  return inspectAdapterRegistrationCommand(
    sandboxName,
    entry,
    buildHermesMcpStatusCommand(entry, credentialRevision),
  );
}

function parseLastJsonObject(output: string): Record<string, unknown> | null {
  for (const line of output.trim().split(/\r?\n/).reverse()) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // OpenShell may frame diagnostics around the command's JSON line.
    }
  }
  return null;
}

/** Refuse an in-sandbox Hermes config mutation while config is locked. */
export function assertHermesMcpConfigMutationAllowed(sandboxName: string): void {
  if (isShieldsDown(sandboxName, false)) return;
  throw new McpBridgeError(
    `Hermes sandbox '${sandboxName}' has shields up or an unreadable shields posture. Run \`nemohermes ${sandboxName} shields down --timeout 15m --reason "MCP maintenance"\` before changing MCP configuration.`,
  );
}

/**
 * Prove the running Hermes sandbox contains the packaged transaction helper
 * and can invoke it through OpenShell current main's ordinary exec path before
 * changing a global provider, policy, attachment, or adapter.
 */
export function assertHermesMcpMutationRuntimeCapability(sandboxName: string): void {
  assertHermesMcpConfigMutationAllowed(sandboxName);
  let lastDetail = "";
  const probe = (): boolean => {
    let result: ReturnType<typeof runOpenshellProviderCommand>;
    try {
      result = runOpenshellProviderCommand(
        buildHermesMcpExecArgs(
          sandboxName,
          buildHermesMcpProbeCommand(),
          HERMES_MCP_PROBE_TIMEOUT_SECONDS,
        ),
        {
          ignoreError: true,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 45_000,
        },
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new McpBridgeError(
        `Hermes sandbox '${sandboxName}' cannot invoke the managed MCP transaction helper. Rebuild the sandbox before changing authenticated MCP state${detail ? `: ${detail}` : "."}`,
      );
    }
    const response = parseLastJsonObject(result.stdout || "");
    if (result.status === 0 && !result.error && response?.ok === true) return true;
    lastDetail = commandOutput(result).trim();
    if (lastDetail === HERMES_MCP_GATEWAY_NOT_READY) return false;
    if (lastDetail === HERMES_MCP_LIFECYCLE_NOT_READY) {
      throw new McpBridgeError(
        `Hermes sandbox '${sandboxName}' is not running the managed service lifecycle required for authenticated MCP changes. Run \`${getAgentBranding().cli} ${sandboxName} recover\` and retry.`,
      );
    }
    throw new McpBridgeError(
      `Hermes sandbox '${sandboxName}' cannot invoke the managed MCP transaction helper. Rebuild the sandbox before changing authenticated MCP state${lastDetail ? `: ${lastDetail}` : "."}`,
    );
  };

  if (
    waitUntil(probe, {
      maxAttempts: HERMES_MCP_INITIAL_PROBE_ATTEMPTS,
      initialIntervalMs: 1_000,
      maxIntervalMs: 1_000,
      backoffFactor: 1,
    })
  ) {
    return;
  }

  let recovery: ReturnType<typeof executeGatewaySupervisorAction> = null;
  let recoveryFailureDetail = "";
  try {
    recovery = executeGatewaySupervisorAction(
      sandboxName,
      "recover",
      HERMES_MCP_RECOVERY_TIMEOUT_MS,
    );
  } catch (error) {
    recoveryFailureDetail = error instanceof Error ? error.message : String(error);
  }
  const recoveryCompleted = parseManagedGatewayControlCompletion(recovery) !== null;
  if (!recoveryCompleted) {
    recoveryFailureDetail ||= recovery ? commandOutput(recovery).trim() : "no controller result";
    const classification = classifyGatewayRestartFailure(recovery);
    const claimsInvalidCompletion =
      recovery !== null && (recovery.status === 0 || recovery.stdout.trim().length > 0);
    const terminalIntegrityFailure =
      claimsInvalidCompletion ||
      classification.layer === "secret-boundary refusal" ||
      classification.layer === "unsafe config path" ||
      classification.layer === "config hash mismatch" ||
      classification.layer === "relaunch quarantined" ||
      classification.layer === "health timeout" ||
      recoveryFailureDetail.includes("SUPERVISOR_REBUILD_REQUIRED") ||
      recoveryFailureDetail.includes("SUPERVISOR_UNSAFE_CONTROL_DIR") ||
      recoveryFailureDetail.includes("SUPERVISOR_BUSY") ||
      recoveryFailureDetail.includes("SUPERVISOR_INVALID_") ||
      recoveryFailureDetail.includes("GATEWAY_GUARDS_MISSING");
    if (terminalIntegrityFailure) {
      throw new McpBridgeError(
        `Hermes sandbox '${sandboxName}' managed gateway recovery failed before MCP mutation: ${recoveryFailureDetail || classification.detail}.`,
      );
    }
  }

  // A privileged controller completion never authorizes mutation by itself.
  // Even when transient controller unavailability lets the managed lifecycle
  // finish naturally, the ordinary sandbox identity must freshly prove the
  // packaged helper and a stable, trusted gateway topology before any MCP
  // provider, policy, attachment, or adapter side effect.
  if (!waitUntil(probe, HERMES_MCP_STARTUP_TIMEOUT_SECONDS, 1_000)) {
    const recoveryDetail = recoveryFailureDetail
      ? ` Managed recovery attempt did not complete: ${recoveryFailureDetail}.`
      : "";
    throw new McpBridgeError(
      `Hermes sandbox '${sandboxName}' cannot invoke the managed MCP transaction helper after managed gateway recovery. Rebuild the sandbox before changing authenticated MCP state${lastDetail ? `: ${lastDetail}` : "."}${recoveryDetail}`,
    );
  }
}

function runHermesAdapterCommand(
  sandboxName: string,
  entry: McpBridgeEntry,
  command: readonly string[],
  failureMessage: string,
  options: AdapterMutationOptions & { requireReload?: boolean } = {},
): void {
  // OpenShell current main executes this fixed helper argv with ordinary
  // workload authority. There is no listener, proxy, persistent service, or
  // MCP traffic on this control path; argv carries only an OpenShell
  // placeholder and endpoint metadata.
  let result: ReturnType<typeof runOpenshellProviderCommand>;
  try {
    result = runOpenshellProviderCommand(buildHermesMcpExecArgs(sandboxName, command), {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
      // The remote supervisor enforces 620s; keep a small transport margin so
      // remote termination is observed before this local subprocess is killed.
      timeout: 645_000,
    });
  } catch (error) {
    if (options.bestEffort) return;
    const detail = error instanceof Error ? error.message : String(error);
    throw new McpBridgeError(
      redactBridgeSecretsForDisplay(detail, entry, options.envValues ?? {}) || failureMessage,
    );
  }
  const output = redactBridgeSecretsForDisplay(
    commandOutput(result, options.envValues ?? {}),
    entry,
    options.envValues ?? {},
  );
  if (result.status !== 0 || result.error) {
    if (options.bestEffort) return;
    const errorDetail = result.error
      ? redactBridgeSecretsForDisplay(result.error.message, entry, options.envValues ?? {})
      : "";
    throw new McpBridgeError(errorDetail || output || failureMessage);
  }
  const stdout = result.stdout || "";
  const response = parseLastJsonObject(stdout);
  if (
    response?.ok !== true ||
    typeof response.changed !== "boolean" ||
    typeof response.reloaded !== "boolean"
  ) {
    if (options.bestEffort) return;
    throw new McpBridgeError(
      `Hermes MCP lifecycle command returned an invalid response for '${entry.server}'.`,
    );
  }
  if (options.requireReload && response.reloaded !== true) {
    if (options.bestEffort) return;
    throw new McpBridgeError(
      `Hermes gateway was not running, so MCP server '${entry.server}' was not loaded.`,
    );
  }
}

function verifyHermesAdapterRegistration(
  sandboxName: string,
  entry: McpBridgeEntry,
  credentialRevision?: McpAttachedCredentialRevision,
): void {
  const inspection = inspectHermesAdapterRegistration(sandboxName, entry, credentialRevision);
  if (inspection.state === "registered") return;
  const detail = inspection.state === "error" ? inspection.detail : inspection.state;
  throw new McpBridgeError(
    `hermes-config config verification failed after adding '${entry.server}': ${detail}.`,
  );
}

export function registerHermesAdapter(
  sandboxName: string,
  entry: McpBridgeEntry,
  envValues: Record<string, string> = {},
  replaceExisting = false,
  credentialRevision?: McpAttachedCredentialRevision,
): void {
  runHermesAdapterCommand(
    sandboxName,
    entry,
    buildHermesMcpRegisterCommand(entry, replaceExisting, credentialRevision),
    `Hermes MCP config registration failed for '${entry.server}'.`,
    { envValues, requireReload: true },
  );
  verifyHermesAdapterRegistration(sandboxName, entry, credentialRevision);
  if (credentialRevision === undefined) return;
  const afterReloadRevision = observeMcpCredentialRevision(sandboxName, entry);
  if (afterReloadRevision === credentialRevision) return;
  if (afterReloadRevision === "absent" || afterReloadRevision === "canonical") {
    throw new McpBridgeError(
      `Hermes MCP credential revision was unavailable after reloading '${entry.server}'.`,
    );
  }
  runHermesAdapterCommand(
    sandboxName,
    entry,
    buildHermesMcpRegisterCommand(entry, true, afterReloadRevision),
    `Hermes MCP config convergence failed for '${entry.server}'.`,
    { envValues, requireReload: true },
  );
  verifyHermesAdapterRegistration(sandboxName, entry, afterReloadRevision);
  if (observeMcpCredentialRevision(sandboxName, entry) !== afterReloadRevision) {
    throw new McpBridgeError(
      `Hermes MCP credential revision did not converge after reloading '${entry.server}'.`,
    );
  }
}

export function unregisterHermesAdapter(
  sandboxName: string,
  entry: McpBridgeEntry,
  options: AdapterMutationOptions = {},
): void {
  runHermesAdapterCommand(
    sandboxName,
    entry,
    buildHermesMcpRemoveCommand(entry, options.force === true),
    `Hermes MCP config removal failed for '${entry.server}'.`,
    options,
  );
}
