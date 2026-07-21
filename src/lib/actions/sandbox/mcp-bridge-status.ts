// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type AgentDefinition, type AgentMcpAdapter, loadAgent } from "../../agent/defs";
import type { McpBridgeEntry } from "../../state/registry";
import {
  buildDeepAgentsMcpStatusCommand,
  buildHermesMcpStatusCommand,
  buildOpenClawMcporterInspectCommand,
} from "./mcp-bridge-adapters";
import { isAgentMcpAdapter, McpBridgeError, type McpBridgeStatus } from "./mcp-bridge-contracts";
import {
  type HermesMcpReconciliationResult,
  inspectHermesMcpRuntimeIntent,
} from "./mcp-bridge-hermes-reconciliation";
import { redactBridgeSecretsForDisplay } from "./mcp-bridge-output";
import { getPolicyPresence, getRegisteredGeneratedPolicy } from "./mcp-bridge-policy";
import {
  inspectMcpProvider,
  providerAttached,
  providerMatchesCredential,
  providerShapeDetail,
} from "./mcp-bridge-provider";
import {
  credentialResolutionWarning,
  probeCredentialResolution,
} from "./mcp-bridge-resolution-probe";
import {
  bridgeState,
  ensureSandboxGatewaySelected,
  getSandboxAgent,
  getSandboxOrThrow,
} from "./mcp-bridge-state";
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

// Source-of-truth review for the provider warning:
// invalidState: OpenShell can resolve one sandbox-scoped provider placeholder
// from another inspected route attributed to the same adapter runtime.
// sourceBoundary: OpenShell owns provider attachment and HTTP rewrite binding;
// NemoClaw owns the generated least-privilege route and operator diagnostics.
// whyNotSourceFix: v0.0.85 has no endpoint-exclusive provider attachment or
// enforceable Host, scheme, and query binding that NemoClaw can request.
// regressionTest: mcp-bridge-status-boundaries.test.ts pins this warning and the
// generated policy tests pin unique keys, explicit methods, and allowed IPs.
// removalCondition: remove only when OpenShell exposes and NemoClaw requires
// endpoint-exclusive credential binding plus Host, scheme, and query enforcement.
const SANDBOX_SCOPED_PROVIDER_WARNING =
  "OpenShell currently attaches this credential provider at sandbox scope, not exclusively to this MCP endpoint. Keep other inspected routes for the same adapter binary at least as restrictive until OpenShell supports endpoint-exclusive credential binding plus Host, scheme, and query enforcement.";
const UNSUPPORTED_STORED_URL_WARNING =
  "This persisted MCP URL no longer satisfies the authenticated endpoint boundary. Restart and rebuild fail closed for it; remove this server (use --force if cleanup is partial), then add a normal public HTTPS DNS endpoint.";
const UNSUPPORTED_STORED_CREDENTIAL_WARNING =
  "This persisted MCP credential name no longer satisfies the host-only credential boundary. Restart and rebuild fail closed for it; remove this server, then add it again with a dedicated service credential name.";

function storedUrlWarning(entry: McpBridgeEntry): string | undefined {
  try {
    return normalizeMcpServerUrl(entry.url) === entry.url
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
): McpBridgeStatus["adapter"] {
  if (!entry) return { registered: null };
  if (!adapter) return { registered: null, detail: "MCP adapter is not declared" };
  if (adapter === "hermes-config" && hermesReconciliation) {
    return hermesReconciliation.ok
      ? { registered: true }
      : { registered: false, detail: hermesReconciliation.detail };
  }
  const command =
    adapter === "mcporter"
      ? buildOpenClawMcporterInspectCommand(entry, false)
      : adapter === "hermes-config"
        ? buildHermesMcpStatusCommand(entry)
        : buildDeepAgentsMcpStatusCommand(entry);
  const result = executeSandboxCommand(sandboxName, command);
  if (!result) return { registered: null, detail: "sandbox unreachable" };
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
      },
    ];
  }

  const hermesReconciliation =
    agent.name === "hermes" &&
    (entries.length > 0 || (sandbox.mcp?.managedServerNames?.length ?? 0) > 0) &&
    entries.every(([, entry]) => !entry || storedCredentialWarning(entry) === undefined)
      ? inspectHermesMcpRuntimeIntent(sandboxName)
      : undefined;
  if (entries.length === 0 && hermesReconciliation && !hermesReconciliation.ok) {
    throw new McpBridgeError(
      `Hermes MCP runtime does not match the persisted managed intent for sandbox '${sandboxName}': ${hermesReconciliation.detail}.`,
    );
  }

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
    if (attached === true) warnings.push(SANDBOX_SCOPED_PROVIDER_WARNING);
    let credentialWarning: string | undefined;
    if (entry) {
      const urlWarning = storedUrlWarning(entry);
      if (urlWarning) warnings.push(urlWarning);
      credentialWarning = storedCredentialWarning(entry);
      if (credentialWarning) warnings.push(credentialWarning);
    }
    const unsafeCredentialMayBeAttached =
      !!credentialWarning && !!entry?.providerName && attached !== false;
    const credentialResolution =
      options.probeCredentialResolution && entry
        ? unsafeCredentialMayBeAttached
          ? {
              ok: null,
              detail:
                "probe skipped: the unsupported legacy credential may still be attached to fresh sandbox children",
            }
          : probeCredentialResolution(sandboxName, entry, support.adapter, {
              policyGatewayPresent: policyPresence,
              providerAttached: attached,
              providerCredentialReady,
            })
        : undefined;
    const resolutionWarning = credentialResolution
      ? credentialResolutionWarning(entry?.env[0], credentialResolution)
      : undefined;
    if (resolutionWarning) warnings.push(resolutionWarning);
    return {
      server: name,
      agent: entry?.agent ?? agent.name,
      warnings,
      support,
      ...(entry ? { url: entry.url } : {}),
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
      adapter: unsafeCredentialMayBeAttached
        ? {
            registered: null,
            detail:
              "Adapter inspection was skipped because the unsupported legacy credential may still be attached to fresh sandbox children.",
          }
        : getAdapterRegistration(sandboxName, support.adapter, entry, hermesReconciliation),
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
