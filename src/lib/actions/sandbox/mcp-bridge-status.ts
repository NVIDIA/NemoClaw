// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type AgentDefinition, type AgentMcpAdapter, loadAgent } from "../../agent/defs";
import type { McpBridgeEntry } from "../../state/registry";
import {
  buildDeepAgentsMcpStatusCommand,
  buildHermesMcpStatusCommand,
  buildOpenClawMcporterInspectCommand,
  DEFAULT_OPENCLAW_CONFIG_DIR,
  openClawMcporterRoot,
} from "./mcp-bridge-adapters";
import { parseUnsafeDeepAgentsMcpProjectionResult } from "./mcp-bridge-adapter-status";
import { isAgentMcpAdapter, McpBridgeError, type McpBridgeStatus } from "./mcp-bridge-contracts";
import {
  type HermesMcpReconciliationResult,
  inspectHermesMcpRuntimeIntent,
} from "./mcp-bridge-hermes-reconciliation";
import { redactBridgeSecretsForDisplay } from "./mcp-bridge-output";
import { getPolicyPresence, getRegisteredGeneratedPolicy } from "./mcp-bridge-policy";
import {
  inspectMcpProvider,
  observeMcpCredentialRevision,
  providerAttached,
  providerMatchesCredential,
  providerShapeDetail,
} from "./mcp-bridge-provider";
import type {
  McpAttachedCredentialRevision,
  McpCredentialRevisionObservation,
} from "./mcp-bridge-provider-readiness";
import {
  credentialResolutionWarning,
  probeCredentialResolution,
} from "./mcp-bridge-resolution-probe";
import {
  bridgeState,
  ensureSandboxGatewaySelected,
  getAgentConfigDir,
  getSandboxAgent,
  getSandboxOrThrow,
} from "./mcp-bridge-state";
import { discoverMcpTools } from "./mcp-bridge-tool-discovery";
import {
  inspectMcpRecordedTargetPins,
  type McpBridgeRecordedPinStatus,
} from "./mcp-bridge-url-validation";
import {
  assertAuthenticatedBridgeEntry,
  normalizeMcpServerUrl,
  resolvePersistedCredentialEnvForRedaction,
  validateMcpServerName,
  validateSandboxName,
} from "./mcp-bridge-validation";
import { executeSandboxCommand } from "./process-recovery";

export interface McpBridgeJsonSummary {
  sandbox: string;
  agent: string;
  support: McpBridgeStatus["support"];
  bridges: McpBridgeStatus[];
}

const UNSUPPORTED_STORED_URL_WARNING =
  "This persisted MCP URL no longer satisfies the authenticated endpoint boundary. Restart and rebuild fail closed for it; remove this server (use --force if cleanup is partial), then add a normal public HTTPS DNS endpoint.";
const UNSUPPORTED_STORED_CREDENTIAL_WARNING =
  "This persisted MCP credential name no longer satisfies the host-only credential boundary. Restart and rebuild fail closed for it; remove this server, then add it again with a dedicated service credential name.";
const UNSUPPORTED_ATTACHED_CREDENTIAL_DETAIL =
  "the unsupported legacy credential may still be attached to fresh sandbox children";

function storedUrlWarning(entry: McpBridgeEntry): string | undefined {
  try {
    return normalizeMcpServerUrl(entry.url, {
      trustedPrivateHosts: entry.trustedPrivateHost ? [entry.trustedPrivateHost] : undefined,
    }) === entry.url
      ? undefined
      : UNSUPPORTED_STORED_URL_WARNING;
  } catch {
    return UNSUPPORTED_STORED_URL_WARNING;
  }
}

function storedCredentialWarning(entry: McpBridgeEntry): string | undefined {
  try {
    assertAuthenticatedBridgeEntry(entry);
    return undefined;
  } catch {
    return UNSUPPORTED_STORED_CREDENTIAL_WARNING;
  }
}

function getAdapterRegistration(
  sandboxName: string,
  adapter: AgentMcpAdapter | undefined,
  entry: McpBridgeEntry | undefined,
  hermesReconciliation?: HermesMcpReconciliationResult,
  credentialRevision?: McpAttachedCredentialRevision,
  credentialObservationDetail?: string,
): McpBridgeStatus["adapter"] {
  if (!entry) return { registered: null };
  if (!adapter) return { registered: null, detail: "MCP adapter is not declared" };
  const credentialInspectionFailure = credentialObservationDetail
    ? {
        registered: null,
        detail: `Adapter inspection was skipped because ${credentialObservationDetail}.`,
      }
    : undefined;
  if (credentialInspectionFailure && adapter !== "deepagents-config")
    return credentialInspectionFailure;
  if (adapter === "hermes-config" && hermesReconciliation) {
    return hermesReconciliation.ok
      ? { registered: true }
      : { registered: false, detail: hermesReconciliation.detail };
  }
  const command =
    adapter === "mcporter"
      ? buildOpenClawMcporterInspectCommand(
          entry,
          false,
          openClawMcporterRoot(getAgentConfigDir(entry.agent, DEFAULT_OPENCLAW_CONFIG_DIR)),
          credentialRevision,
        )
      : adapter === "hermes-config"
        ? buildHermesMcpStatusCommand(entry, credentialRevision)
        : buildDeepAgentsMcpStatusCommand(entry, credentialRevision);
  const result = executeSandboxCommand(sandboxName, command);
  if (!result)
    return credentialInspectionFailure ?? { registered: null, detail: "sandbox unreachable" };
  const unsafeProjection =
    adapter === "deepagents-config" ? parseUnsafeDeepAgentsMcpProjectionResult(result) : null;
  if (unsafeProjection) {
    const redactedPath = redactBridgeSecretsForDisplay(
      unsafeProjection.path,
      entry,
      resolvePersistedCredentialEnvForRedaction(entry.env),
    ).trim();
    throw new McpBridgeError(`${unsafeProjection.messagePrefix}${redactedPath}`, 2);
  }
  if (credentialInspectionFailure) return credentialInspectionFailure;
  if (result.status === 0) {
    const output = result.stdout.trim();
    if (output === "registered") return { registered: true };
    return { registered: false, detail: output || "not found" };
  }
  const envValues = resolvePersistedCredentialEnvForRedaction(entry.env);
  return {
    registered: false,
    detail: redactBridgeSecretsForDisplay(
      result.stderr || result.stdout || "not found",
      entry,
      envValues,
    ),
  };
}

export interface McpBridgeStatusOptions {
  /**
   * Run the wire-level credential-resolution probe for each entry (#6379).
   * Costs one SSH round trip plus an in-sandbox MCP initialize per entry, so
   * the dispatch layer enables it only where the operator asked for it.
   */
  probeCredentialResolution?: boolean;
  /**
   * Enumerate names advertised by one managed MCP endpoint. The dispatch
   * layer restricts this live operation to an explicitly named server.
   */
  discoverTools?: boolean;
}

function attachedCredentialRevision(
  observation: McpCredentialRevisionObservation | null | undefined,
): McpAttachedCredentialRevision | undefined {
  return observation !== undefined &&
    observation !== null &&
    observation !== "absent" &&
    observation !== "canonical"
    ? observation
    : undefined;
}

function credentialObservationDetail(
  observation: McpCredentialRevisionObservation | null | undefined,
): string | undefined {
  if (observation === null)
    return "the current OpenShell credential revision could not be observed";
  if (observation === "absent") {
    return "a fresh OpenShell exec did not expose the credential placeholder";
  }
  if (observation === "canonical") {
    return "a fresh OpenShell exec exposed an identityless credential placeholder instead of a revision-scoped placeholder";
  }
  return undefined;
}

export async function statusMcpBridge(
  sandboxName: string,
  server?: string,
  options: McpBridgeStatusOptions = {},
): Promise<McpBridgeStatus[]> {
  validateSandboxName(sandboxName);
  if (server !== undefined) validateMcpServerName(server);
  const sandbox = getSandboxOrThrow(sandboxName);
  const agent = getSandboxAgent(sandbox);
  const bridges = bridgeState(sandbox);
  if (Object.keys(bridges).length > 0) {
    await ensureSandboxGatewaySelected(sandboxName);
  }
  const selectedEntry =
    server !== undefined && Object.hasOwn(bridges, server) ? bridges[server] : undefined;
  const entries: Array<[string, McpBridgeEntry | undefined]> =
    server !== undefined ? [[server, selectedEntry]] : Object.entries(bridges);
  if (server !== undefined && !selectedEntry) {
    return [
      {
        server,
        agent: agent.name,
        warnings: [],
        support: {
          supported: agent.mcpCapability.support === "bridge",
          mode: agent.mcpCapability.support,
          ...(agent.mcpCapability.adapter ? { adapter: agent.mcpCapability.adapter } : {}),
          ...(agent.mcpCapability.reason ? { reason: agent.mcpCapability.reason } : {}),
        },
        env: { names: [], missing: [], ready: false },
        provider: {
          registryPresent: false,
          gatewayPresent: false,
          attached: null,
          credentialReady: null,
        },
        policy: { registryPresent: false, gatewayPresent: false },
        adapter: { registered: null },
        ...(options.discoverTools
          ? {
              toolDiscovery: {
                ok: false,
                count: 0,
                tools: [],
                truncated: false,
                detail: "tool discovery skipped: MCP server is not registered",
              },
            }
          : {}),
      },
    ];
  }

  const credentialObservations = new Map<string, McpCredentialRevisionObservation | null>();
  for (const [name, entry] of entries) {
    if (!entry || storedCredentialWarning(entry) !== undefined) continue;
    try {
      credentialObservations.set(name, observeMcpCredentialRevision(sandboxName, entry));
    } catch {
      credentialObservations.set(name, null);
    }
  }
  const credentialRevisions = new Map<string, McpAttachedCredentialRevision>();
  for (const [name, observation] of credentialObservations) {
    const revision = attachedCredentialRevision(observation);
    if (revision) credentialRevisions.set(name, revision);
  }
  const hermesCredentialObservationDetail = entries
    .map(([name, entry]) =>
      entry && storedCredentialWarning(entry) === undefined
        ? credentialObservationDetail(credentialObservations.get(name))
        : undefined,
    )
    .find((detail) => detail !== undefined);

  const hermesReconciliation =
    agent.name === "hermes" &&
    (entries.length > 0 || (sandbox.mcp?.managedServerNames?.length ?? 0) > 0) &&
    entries.every(([, entry]) => !entry || storedCredentialWarning(entry) === undefined)
      ? hermesCredentialObservationDetail
        ? {
            ok: false as const,
            state: "error" as const,
            detail: hermesCredentialObservationDetail,
          }
        : inspectHermesMcpRuntimeIntent(sandboxName, { credentialRevisions })
      : undefined;
  if (entries.length === 0 && hermesReconciliation && !hermesReconciliation.ok) {
    throw new McpBridgeError(
      `Hermes MCP runtime does not match the persisted managed intent for sandbox '${sandboxName}': ${hermesReconciliation.detail}.`,
    );
  }

  const privatePinStatusByServer = new Map<string, McpBridgeRecordedPinStatus>();
  await Promise.all(
    entries.map(async ([name, entry]) => {
      if (!entry?.trustedPrivateHost || !entry.allowedIps) return;
      privatePinStatusByServer.set(
        name,
        await inspectMcpRecordedTargetPins(
          new URL(entry.url),
          entry.trustedPrivateHost,
          entry.allowedIps,
        ),
      );
    }),
  );

  return entries.map(([name, entry]) => {
    const support = entry ? getPersistedBridgeSupport(entry) : getSupportSummary(agent);
    const registeredPolicy = getRegisteredGeneratedPolicy(sandboxName, entry);
    const policyPresence = getPolicyPresence(sandboxName, entry);
    const hasCredentialBinding =
      !!entry &&
      Array.isArray(entry.env) &&
      entry.env.length === 1 &&
      !!entry.providerName &&
      !!entry.providerId;
    const missingEnv = entry
      ? entry.env.filter(
          (envName: string) => process.env[envName] === undefined || process.env[envName] === "",
        )
      : [];
    const expectedCredential = entry?.env.length === 1 ? entry.env[0] : undefined;
    const providerInspection = inspectMcpProvider(entry?.providerName);
    const providerCredentialReady = providerMatchesCredential(
      providerInspection,
      expectedCredential,
      entry?.providerId,
    );
    const providerDetail = providerShapeDetail(
      providerInspection,
      expectedCredential,
      entry?.providerId,
    );
    const attached = providerAttached(sandboxName, entry?.providerName);
    const warnings: string[] = [];
    let credentialWarning: string | undefined;
    if (entry) {
      const urlWarning = storedUrlWarning(entry);
      if (urlWarning) warnings.push(urlWarning);
      credentialWarning = storedCredentialWarning(entry);
      if (credentialWarning) warnings.push(credentialWarning);
    }
    const privatePinStatus = privatePinStatusByServer.get(name);
    if (privatePinStatus?.state === "drift") {
      warnings.push(
        "Trusted-private DNS answers differ from the recorded pins. Remove and re-add this server to approve changed pins.",
      );
    } else if (privatePinStatus?.state === "unresolved") {
      warnings.push(
        "Trusted-private DNS resolution is unavailable. The recorded policy pins were not changed.",
      );
    }
    const unsafeCredentialMayBeAttached =
      !!credentialWarning && !!entry?.providerName && attached !== false;
    const credentialObservation = entry ? credentialObservations.get(name) : undefined;
    const credentialRevision = attachedCredentialRevision(credentialObservation);
    const observationDetail = credentialObservationDetail(credentialObservation);
    const readiness = {
      policyGatewayPresent: policyPresence,
      providerAttached: attached,
      providerCredentialReady,
    };
    const adapterRegistration = getAdapterRegistration(
      sandboxName,
      support.adapter,
      entry,
      hermesReconciliation,
      credentialRevision,
      unsafeCredentialMayBeAttached ? UNSUPPORTED_ATTACHED_CREDENTIAL_DETAIL : observationDetail,
    );
    const credentialResolution =
      options.probeCredentialResolution && entry
        ? unsafeCredentialMayBeAttached
          ? {
              ok: null,
              detail: `probe skipped: ${UNSUPPORTED_ATTACHED_CREDENTIAL_DETAIL}`,
            }
          : observationDetail
            ? { ok: null, detail: `probe skipped: ${observationDetail}` }
            : adapterRegistration.registered !== true
              ? {
                  ok: null,
                  detail:
                    "probe skipped: the managed agent adapter does not match the current credential revision",
                }
              : probeCredentialResolution(
                  sandboxName,
                  entry,
                  support.adapter,
                  readiness,
                  credentialRevision,
                )
        : undefined;
    const resolutionWarning = credentialResolution
      ? credentialResolutionWarning(entry?.env[0], credentialResolution)
      : undefined;
    if (resolutionWarning) warnings.push(resolutionWarning);
    const toolDiscovery =
      options.discoverTools && entry
        ? unsafeCredentialMayBeAttached
          ? {
              ok: false,
              count: 0,
              tools: [],
              truncated: false,
              detail: `tool discovery skipped: ${UNSUPPORTED_ATTACHED_CREDENTIAL_DETAIL}`,
            }
          : discoverMcpTools(sandboxName, entry, support.adapter, readiness)
        : undefined;
    return {
      server: name,
      agent: entry?.agent ?? agent.name,
      warnings,
      support,
      ...(entry ? { url: entry.url } : {}),
      ...(entry?.trustedPrivateHost && entry.allowedIps && privatePinStatus
        ? {
            trustedPrivateTarget: {
              host: entry.trustedPrivateHost,
              recordedPins: [...entry.allowedIps],
              ...(privatePinStatus.currentAddresses
                ? { currentPins: privatePinStatus.currentAddresses }
                : {}),
              state: privatePinStatus.state,
              ...(privatePinStatus.detail ? { detail: privatePinStatus.detail } : {}),
            },
          }
        : {}),
      ...(entry?.addState ? { addState: entry.addState } : {}),
      env: {
        names: entry?.env ?? [],
        missing: missingEnv,
        ready:
          hasCredentialBinding &&
          !entry?.addState &&
          (providerInspection.exists ? providerCredentialReady : missingEnv.length === 0),
      },
      provider: {
        name: entry?.providerName,
        registryPresent: !!entry?.providerName,
        gatewayPresent: entry?.providerName ? providerInspection.exists : null,
        attached,
        credentialReady: entry ? providerCredentialReady : null,
        ...(providerDetail ? { detail: providerDetail } : {}),
        ...(credentialResolution ? { credentialResolution } : {}),
      },
      policy: {
        name: entry?.policyName,
        registryPresent: !!registeredPolicy,
        gatewayPresent: policyPresence,
      },
      adapter: adapterRegistration,
      ...(toolDiscovery ? { toolDiscovery } : {}),
      ...(entry?.addedAt ? { addedAt: entry.addedAt } : {}),
      ...(entry?.updatedAt ? { updatedAt: entry.updatedAt } : {}),
    };
  });
}

function getPersistedBridgeSupport(entry: McpBridgeEntry): McpBridgeStatus["support"] {
  if (isAgentMcpAdapter(entry.adapter)) {
    return {
      supported: true,
      mode: "bridge",
      adapter: entry.adapter,
    };
  }
  try {
    return getSupportSummary(loadAgent(entry.agent));
  } catch {
    return {
      supported: false,
      mode: "disabled",
      reason: `Persisted agent '${entry.agent}' is unavailable.`,
    };
  }
}

function getSupportSummary(agent: AgentDefinition): McpBridgeStatus["support"] {
  return {
    supported: agent.mcpCapability.support === "bridge",
    mode: agent.mcpCapability.support,
    ...(agent.mcpCapability.adapter ? { adapter: agent.mcpCapability.adapter } : {}),
    ...(agent.mcpCapability.reason ? { reason: agent.mcpCapability.reason } : {}),
  };
}

export function buildJsonSummary(
  sandboxName: string,
  agent: AgentDefinition,
  statuses: McpBridgeStatus[],
): McpBridgeJsonSummary {
  return {
    sandbox: sandboxName,
    agent: agent.name,
    support: getSupportSummary(agent),
    bridges: statuses,
  };
}
