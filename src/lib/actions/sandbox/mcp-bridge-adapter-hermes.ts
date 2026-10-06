// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runOpenshellProviderCommand } from "../../adapters/openshell/provider-command";
import { getAgentBranding } from "../../cli/branding";
import { waitUntil } from "../../core/wait";
import type { McpSourceEntry } from "./mcp-bridge-contracts";
import {
  type AdapterMutationOptions,
  type AdapterRegistrationInspection,
  inspectAdapterRegistrationCommand,
  restartMcpGatewayThroughSupervisor,
} from "./mcp-bridge-adapter-inspection";
import {
  buildHermesMcpStatusCommand,
  entryHeaders,
  HERMES_MCP_TRANSACTION_HELPER,
  hermesManagedServerConfig,
} from "./mcp-bridge-adapter-status";
import { McpBridgeError } from "./mcp-bridge-contracts";
import { commandOutput, redactBridgeSecretsForDisplay } from "./mcp-bridge-output";
import type { McpProviderInspectionRuntimeSelection } from "./mcp-bridge-provider-inspection";
import type { McpAttachedCredentialRevision } from "./mcp-bridge-provider-readiness";

const HERMES_MCP_EXEC_TIMEOUT_SECONDS = 620;
const HERMES_MCP_PROBE_TIMEOUT_SECONDS = 30;
const HERMES_MCP_INITIAL_PROBE_ATTEMPTS = 3;
const HERMES_MCP_RECONCILE_FINALITY_CAPABILITY_VERSION = 1;
const HERMES_MCP_GATEWAY_NOT_READY = "Hermes gateway is not running for managed MCP reload";
const HERMES_MCP_LIFECYCLE_NOT_READY =
  "Hermes gateway is not running under the managed service lifecycle";
// A relay-loss reconciliation can wait behind the original transaction's
// apply reload and rollback reload. Preserve the mutation's complete 620s
// remote bound, then reserve time for the read-only stability proof.
const HERMES_MCP_RECONCILE_TIMEOUT_SECONDS = HERMES_MCP_EXEC_TIMEOUT_SECONDS + 30;
const HERMES_MCP_RECONCILE_TRANSPORT_MARGIN_MS = 25_000;
const HERMES_MCP_RECONCILE_TRANSPORT_TIMEOUT_MS =
  HERMES_MCP_RECONCILE_TIMEOUT_SECONDS * 1_000 + HERMES_MCP_RECONCILE_TRANSPORT_MARGIN_MS;
const HERMES_MCP_RECONCILE_PROOF_RESERVE_SECONDS = 30;
const HERMES_MCP_RECONCILE_PROOF_RESERVE_MS = HERMES_MCP_RECONCILE_PROOF_RESERVE_SECONDS * 1_000;
const HERMES_RELOAD_RELAY_LOSS = `Error: x code: 'The service is currently unavailable', message: "exec relay closed before the command reported an exit status"`;

export class HermesMcpReloadRelayLossError extends McpBridgeError {
  readonly credentialRevision: McpAttachedCredentialRevision;

  constructor(credentialRevision: McpAttachedCredentialRevision) {
    super(
      "The Hermes MCP reload lost its OpenShell transport before the add outcome was confirmed.",
    );
    this.name = "HermesMcpReloadRelayLossError";
    this.credentialRevision = credentialRevision;
  }
}

export type HermesMcpReloadFinalityInspection =
  | { state: "committed" | "absent" }
  | { state: "unknown"; detail: string };

export interface HermesMcpReloadFinalityDeadline {
  readonly deadlineMs: number;
  readonly readinessDeadlineMs: number;
}

/**
 * Bind mutation, same-identity readiness, and read-only finality to one deadline.
 * Readiness may consume the mutation owner's 620-second bound, leaving thirty
 * seconds for proof and the existing transport margin.
 */
export function beginHermesMcpReloadFinalityDeadline(): HermesMcpReloadFinalityDeadline {
  const startedAtMs = performance.now();
  const deadlineMs = startedAtMs + HERMES_MCP_RECONCILE_TRANSPORT_TIMEOUT_MS;
  return {
    deadlineMs,
    readinessDeadlineMs:
      deadlineMs - HERMES_MCP_RECONCILE_PROOF_RESERVE_MS - HERMES_MCP_RECONCILE_TRANSPORT_MARGIN_MS,
  };
}

function remainingFinalityTransportMs(deadline: HermesMcpReloadFinalityDeadline): number {
  const remaining = deadline.deadlineMs - performance.now();
  return Number.isFinite(remaining) ? Math.max(0, Math.floor(remaining)) : 0;
}

function remainingFinalityRemoteSeconds(remainingTransportMs: number): number {
  return Math.min(
    HERMES_MCP_RECONCILE_TIMEOUT_SECONDS,
    Math.floor((remainingTransportMs - HERMES_MCP_RECONCILE_TRANSPORT_MARGIN_MS) / 1_000),
  );
}

function normalizeHermesReloadDiagnostic(value: string): string {
  return value
    .replace(/\u001b\[[0-9;]*m/gu, "")
    .replace(/[\u2502]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^Error:\s*\u00d7\s+code:/u, "Error: x code:");
}

function isHermesReloadRelayLossResult(
  result: ReturnType<typeof runOpenshellProviderCommand>,
  output: string,
): boolean {
  return (
    result.status === 1 &&
    !result.error &&
    normalizeHermesReloadDiagnostic(output) === HERMES_RELOAD_RELAY_LOSS
  );
}

function rawHermesCommandOutput(result: ReturnType<typeof runOpenshellProviderCommand>): string {
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return `${stderr}${stdout}`.replace(/\r/gu, "").trim();
}

export function buildHermesMcpRegisterCommand(
  entry: McpSourceEntry,
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

function buildHermesMcpRemoveCommand(entry: McpSourceEntry, force = false): string[] {
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

export function buildHermesMcpReconcileCommand(
  entry: McpSourceEntry,
  credentialRevision: McpAttachedCredentialRevision,
  state: "committed" | "absent",
): string[] {
  const payload =
    state === "committed"
      ? {
          present: {
            [entry.server]: hermesManagedServerConfig(entry, credentialRevision),
          },
          absent: [],
        }
      : { present: {}, absent: [entry.server] };
  return [HERMES_MCP_TRANSACTION_HELPER, "reconcile", "--payload", JSON.stringify(payload)];
}

function inspectHermesMcpReconcileState(
  sandboxName: string,
  entry: McpSourceEntry,
  credentialRevision: McpAttachedCredentialRevision,
  expectedState: "committed" | "absent",
  runtimeSelection: McpProviderInspectionRuntimeSelection,
  timeoutSeconds = HERMES_MCP_RECONCILE_TIMEOUT_SECONDS,
  transportTimeoutMs = HERMES_MCP_RECONCILE_TRANSPORT_TIMEOUT_MS,
): HermesMcpReloadFinalityInspection {
  let result: ReturnType<typeof runOpenshellProviderCommand>;
  try {
    result = runOpenshellProviderCommand(
      buildHermesMcpExecArgs(
        sandboxName,
        buildHermesMcpReconcileCommand(entry, credentialRevision, expectedState),
        timeoutSeconds,
      ),
      {
        ignoreError: true,
        runtimeSelection,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: transportTimeoutMs,
      },
    );
  } catch (error) {
    return {
      state: "unknown",
      detail: redactBridgeSecretsForDisplay(
        error instanceof Error ? error.message : String(error),
        entry,
      ),
    };
  }
  const output = redactBridgeSecretsForDisplay(commandOutput(result), entry);
  const response = parseLastJsonObject(result.stdout || "");
  if (
    result.status === 0 &&
    !result.error &&
    response?.ok === true &&
    response.state === expectedState
  ) {
    return { state: expectedState };
  }
  return {
    state: "unknown",
    detail: output || "Hermes MCP reconciliation returned no result.",
  };
}

/** Prove committed state or exact absence without repeating the mutation. */
export function inspectHermesMcpReloadFinality(
  sandboxName: string,
  entry: McpSourceEntry,
  credentialRevision: McpAttachedCredentialRevision,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
  deadline?: HermesMcpReloadFinalityDeadline,
): HermesMcpReloadFinalityInspection {
  const activeDeadline = deadline ?? beginHermesMcpReloadFinalityDeadline();
  const initialTransportMs = deadline
    ? remainingFinalityTransportMs(activeDeadline)
    : HERMES_MCP_RECONCILE_TRANSPORT_TIMEOUT_MS;
  const initialRemoteSeconds = remainingFinalityRemoteSeconds(initialTransportMs);
  if (initialRemoteSeconds < HERMES_MCP_RECONCILE_PROOF_RESERVE_SECONDS) {
    return {
      state: "unknown",
      detail: "Hermes MCP reconciliation exhausted its finality deadline.",
    };
  }
  const committed = inspectHermesMcpReconcileState(
    sandboxName,
    entry,
    credentialRevision,
    "committed",
    runtimeSelection,
    initialRemoteSeconds,
    initialTransportMs,
  );
  if (committed.state === "committed") return committed;
  const remainingTransportMs = remainingFinalityTransportMs(activeDeadline);
  const remainingRemoteSeconds = remainingFinalityRemoteSeconds(remainingTransportMs);
  if (remainingRemoteSeconds <= 0) {
    return {
      state: "unknown",
      detail: "Hermes MCP reconciliation exhausted its finality deadline.",
    };
  }
  const absent = inspectHermesMcpReconcileState(
    sandboxName,
    entry,
    credentialRevision,
    "absent",
    runtimeSelection,
    remainingRemoteSeconds,
    remainingTransportMs,
  );
  if (absent.state === "absent") return absent;
  return {
    state: "unknown",
    detail: "Hermes MCP reconciliation proved neither committed state nor absence.",
  };
}

export async function inspectHermesAdapterRegistration(
  sandboxName: string,
  entry: McpSourceEntry,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
  credentialRevision?: McpAttachedCredentialRevision,
  timeoutMs?: number,
): Promise<AdapterRegistrationInspection> {
  return await inspectAdapterRegistrationCommand(
    sandboxName,
    entry,
    buildHermesMcpStatusCommand(entry, credentialRevision),
    runtimeSelection,
    timeoutMs,
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

function hasHermesMcpReconcileFinalityCapability(
  response: Record<string, unknown> | null,
): boolean {
  const capabilities = response?.capabilities;
  return (
    capabilities !== null &&
    typeof capabilities === "object" &&
    !Array.isArray(capabilities) &&
    (capabilities as Record<string, unknown>).reconcile_finality ===
      HERMES_MCP_RECONCILE_FINALITY_CAPABILITY_VERSION
  );
}

/**
 * Prove the running Hermes sandbox contains the packaged transaction helper
 * and can invoke it through OpenShell current main's ordinary exec path before
 * changing a global provider, policy, attachment, or adapter.
 */
function assertHermesMcpRuntimeCapability(
  sandboxName: string,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
  requireReconcileFinality: boolean,
): void {
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
          runtimeSelection,
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
    if (result.status === 0 && !result.error && response?.ok === true) {
      if (!requireReconcileFinality || hasHermesMcpReconcileFinalityCapability(response)) {
        return true;
      }
      throw new McpBridgeError(
        `Hermes sandbox '${sandboxName}' does not provide managed MCP reconcile-finality capability version ${HERMES_MCP_RECONCILE_FINALITY_CAPABILITY_VERSION}. Rebuild the sandbox before changing authenticated MCP state.`,
      );
    }
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

  throw new McpBridgeError(
    `Hermes sandbox '${sandboxName}' gateway is not ready on recorded OpenShell target '${runtimeSelection.gatewayName}'. Run \`${getAgentBranding().cli} ${sandboxName} recover\` and retry. NemoClaw did not attempt host-local supervisor recovery.`,
  );
}

export function assertHermesMcpMutationRuntimeCapability(
  sandboxName: string,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
): void {
  assertHermesMcpRuntimeCapability(sandboxName, runtimeSelection, true);
}

/**
 * Keep the baseline helper and lifecycle proof available for preservation-safe
 * rebuild teardown. The replacement helper must pass the current mutation
 * capability gate before it restores the retained registration.
 */
export function assertHermesMcpTeardownRuntimeCapability(
  sandboxName: string,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
): void {
  assertHermesMcpRuntimeCapability(sandboxName, runtimeSelection, false);
}

function runHermesAdapterCommand(
  sandboxName: string,
  entry: McpSourceEntry,
  command: readonly string[],
  failureMessage: string,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
  options: AdapterMutationOptions & {
    credentialRevision?: McpAttachedCredentialRevision;
    requireReload?: boolean;
  } = {},
): void {
  // OpenShell current main executes this fixed helper argv with ordinary
  // workload authority. There is no listener, proxy, persistent service, or
  // MCP traffic on this control path; argv carries only an OpenShell
  // placeholder and endpoint metadata.
  let result: ReturnType<typeof runOpenshellProviderCommand>;
  try {
    result = runOpenshellProviderCommand(buildHermesMcpExecArgs(sandboxName, command), {
      ignoreError: true,
      runtimeSelection,
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
  const rawOutput = rawHermesCommandOutput(result);
  const output = redactBridgeSecretsForDisplay(rawOutput, entry, options.envValues ?? {});
  if (result.status !== 0 || result.error) {
    if (options.bestEffort) return;
    if (
      options.requireReload &&
      options.credentialRevision &&
      isHermesReloadRelayLossResult(result, rawOutput)
    ) {
      throw new HermesMcpReloadRelayLossError(options.credentialRevision);
    }
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

async function verifyHermesAdapterRegistration(
  sandboxName: string,
  entry: McpSourceEntry,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
  credentialRevision?: McpAttachedCredentialRevision,
): Promise<void> {
  const inspection = await inspectHermesAdapterRegistration(
    sandboxName,
    entry,
    runtimeSelection,
    credentialRevision,
  );
  if (inspection.state === "registered") return;
  const detail = inspection.state === "error" ? inspection.detail : inspection.state;
  throw new McpBridgeError(
    `hermes-config config verification failed after adding '${entry.server}': ${detail}.`,
  );
}

export async function registerHermesAdapter(
  sandboxName: string,
  entry: McpSourceEntry,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
  envValues: Record<string, string> = {},
  replaceExisting = false,
  credentialRevision?: McpAttachedCredentialRevision,
): Promise<void> {
  runHermesAdapterCommand(
    sandboxName,
    entry,
    buildHermesMcpRegisterCommand(entry, replaceExisting, credentialRevision),
    `Hermes MCP config registration failed for '${entry.server}'.`,
    runtimeSelection,
    { credentialRevision, envValues, requireReload: true },
  );
  await verifyHermesAdapterRegistration(sandboxName, entry, runtimeSelection, credentialRevision);
}

/** Restart an unchanged Hermes MCP definition through the authenticated host supervisor. */
export async function reloadHermesGatewayAfterMcpRestart(sandboxName: string): Promise<void> {
  const result = await restartMcpGatewayThroughSupervisor(sandboxName);
  if (result.ok) return;
  throw new McpBridgeError(
    `Hermes gateway did not reload the current MCP configuration (${result.failureLayer}: ${result.detail}).`,
  );
}

export function unregisterHermesAdapter(
  sandboxName: string,
  entry: McpSourceEntry,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
  options: AdapterMutationOptions = {},
): void {
  runHermesAdapterCommand(
    sandboxName,
    entry,
    buildHermesMcpRemoveCommand(entry, options.force === true),
    `Hermes MCP config removal failed for '${entry.server}'.`,
    runtimeSelection,
    options,
  );
}
