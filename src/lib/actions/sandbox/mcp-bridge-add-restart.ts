// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentMcpAdapter } from "../../agent/defs";
import * as policies from "../../policy";
import {
  normalizeTrustedPrivateHost,
  parseTrustedPrivateHosts,
  replayTrustedPrivateEndpoint,
} from "../../security/trusted-private-endpoint";
import { withMcpLifecycleLock } from "../../state/mcp-lifecycle-lock";
import { assertHermesPortableCommandUnavailable } from "../../onboard/experimental/portable-agent-lifecycle";
import type { McpSourceEntry } from "./mcp-bridge-contracts";
import { withMcpCredentialOwnershipLock } from "../../state/mcp-lifecycle-lock/credential-ownership";
import {
  assertAgentMcpMutationRuntimeCapability,
  inspectAgentAdapterRegistration,
  reloadOpenClawGatewayAfterMcpMutation,
  registerAgentAdapterAtCurrentCredentialRevision,
  unregisterAgentAdapter,
} from "./mcp-bridge-adapters";
import { type McpBridgeAddOptions, McpBridgeError } from "./mcp-bridge-contracts";
import { assertUnchangedStableMcpCredentialAuthorized, statusMcpBridge } from "./mcp-bridge-status";
import {
  applyGeneratedPolicy,
  assertGeneratedPolicyMutationSafe,
  buildMcpBridgeCapabilityPolicyYaml,
  buildMcpBridgePolicyKey,
  buildMcpBridgePolicyName,
  buildMcpBridgePolicyYaml,
  removeGeneratedPolicy,
} from "./mcp-bridge-policy";
import {
  assertMcpProviderRecoverable,
  assertNoProviderCredentialCollisions,
  attachProvider,
  detachProvider,
  ensureMcpBridgeProviderProfile,
  getMcpProviderInspectionRuntimeSelection,
  inspectMcpProvider,
  inspectMcpProviderAttachments,
  MCP_BRIDGE_PROVIDER_TYPE,
  type McpCredentialRevisionObservation,
  observeMcpCredentialRevision,
  providerMatchesCredential,
  providerShapeDetail,
  preflightMcpEntryTargets,
  refreshMcpProviderEnvironment,
  upsertMcpProvider,
  waitForAttachedMcpCredential,
  waitForDetachedMcpCredential,
} from "./mcp-bridge-provider";
import {
  assertNoDerivedResourceCollision,
  ensureSandboxGatewaySelected,
  getBridgeAdapter,
  getSandboxAgent,
  getSandboxOrThrow,
} from "./mcp-bridge-state";
import { inspectPolicyOnlyMcpEntry, inspectSourceBridgeState } from "./mcp-bridge-source";
import {
  type McpBridgeTargetValidation,
  parseMcpUrlWithValidatedTarget,
} from "./mcp-bridge-url-validation";
import {
  assertAuthenticatedBridgeEntry,
  assertAuthenticatedCredentialReference,
  assertMcpCredentialBoundaryRuntimeVersion,
  buildMcpBridgeProviderName,
  normalizeMcpDenyTools,
  normalizeMcpServerUrl,
  preflightMcpServerUrlResolvedTarget,
  resolveCredentialEnv,
  uniqueEnvNames,
  validateMcpServerName,
  validateSandboxName,
} from "./mcp-bridge-validation";

function sameMcpAddIntent(existing: McpSourceEntry, requested: McpSourceEntry): boolean {
  return (
    existing.server === requested.server &&
    existing.agent === requested.agent &&
    existing.adapter === requested.adapter &&
    existing.url === requested.url &&
    existing.providerName === requested.providerName &&
    existing.policyName === requested.policyName &&
    existing.trustedPrivateHost === requested.trustedPrivateHost &&
    (existing.denyTools?.length ?? 0) === (requested.denyTools?.length ?? 0) &&
    (existing.denyTools ?? []).every((tool, index) => tool === requested.denyTools?.[index]) &&
    (existing.allowedIps?.length ?? 0) === (requested.allowedIps?.length ?? 0) &&
    (existing.allowedIps ?? []).every(
      (address, index) => address === requested.allowedIps?.[index],
    ) &&
    existing.env.length === requested.env.length &&
    existing.env.every((name, index) => name === requested.env[index])
  );
}

function replayMcpAddTarget(
  entry: McpSourceEntry,
  normalizedUrl: string,
  matchingTrustedPrivateHosts: readonly string[],
): McpBridgeTargetValidation | null {
  const recordedPins = entry.allowedIps ?? [];
  if (recordedPins.length === 0) return null;
  if (entry.trustedPrivateHost) {
    const urlHost = new URL(normalizedUrl).hostname.toLowerCase();
    if (
      entry.trustedPrivateHost !== urlHost ||
      !matchingTrustedPrivateHosts.includes(entry.trustedPrivateHost)
    ) {
      throw new McpBridgeError(
        `MCP server '${entry.server}' has an incomplete add transaction with different trusted-private host intent. Re-run the original add command or remove it with --force before changing the definition.`,
        2,
      );
    }
    try {
      const replay = replayTrustedPrivateEndpoint(entry.trustedPrivateHost, recordedPins, {
        requireAllPrivate: true,
      });
      return {
        addresses: [...replay.addresses],
        trustedPrivateCapability: replay.trustedPrivateCapability,
        trustedPrivateHost: replay.host,
      };
    } catch (error) {
      throw new McpBridgeError(
        `MCP server '${entry.server}' has invalid durable trusted-private intent: ${error instanceof Error ? error.message : String(error)}. Remove it with --force and add it again.`,
        2,
      );
    }
  }
  const target = { addresses: [...recordedPins] };
  // Public policy pins are part of the committed transaction. Validate them
  // again, but do not replace them with a later DNS answer during an exact
  // retry; OpenShell must continue enforcing the originally admitted set.
  parseMcpUrlWithValidatedTarget(normalizedUrl, target);
  return target;
}

async function recoverCommittedPolicyTarget(
  sandboxName: string,
  sandbox: ReturnType<typeof getSandboxOrThrow>,
  adapter: AgentMcpAdapter,
  requestedEntry: McpSourceEntry,
  currentTarget: McpBridgeTargetValidation,
  matchingTrustedPrivateHosts: readonly string[],
  runtimeSelection: ReturnType<typeof getMcpProviderInspectionRuntimeSelection>,
): Promise<McpBridgeTargetValidation | null> {
  const boundState = policies.getPresetContentGatewayState(
    sandboxName,
    buildMcpBridgePolicyYaml(
      requestedEntry.server,
      requestedEntry.url,
      adapter,
      currentTarget,
      requestedEntry.providerName ?? "",
      requestedEntry.denyTools,
    ),
    undefined,
    runtimeSelection,
  );
  const capabilityState = policies.getPresetContentGatewayState(
    sandboxName,
    buildMcpBridgeCapabilityPolicyYaml(
      requestedEntry.server,
      requestedEntry.url,
      adapter,
      currentTarget,
      requestedEntry.denyTools,
    ),
    undefined,
    runtimeSelection,
  );
  if (boundState !== "drift" || capabilityState !== "drift") return null;
  const policyEntry = await inspectPolicyOnlyMcpEntry(
    sandbox,
    requestedEntry.server,
    requestedEntry.agent,
    adapter,
    runtimeSelection,
  );
  if (!policyEntry) return null;
  if (policyEntry.url !== requestedEntry.url) {
    throw new McpBridgeError(
      `MCP server '${requestedEntry.server}' has an incomplete add transaction for a different URL. Re-run the original add command or remove it with --force before changing the definition.`,
      2,
    );
  }
  return replayMcpAddTarget(policyEntry, requestedEntry.url, matchingTrustedPrivateHosts);
}

type McpAddRecovery = {
  entry: McpSourceEntry;
  adapterRegistered: boolean;
  attachmentPresent: boolean;
  policyState: "absent" | "capability" | "bound";
  resuming: boolean;
};

async function inspectMcpAddRecovery(
  sandboxName: string,
  adapter: AgentMcpAdapter,
  entry: McpSourceEntry,
  target: McpBridgeTargetValidation,
  providerRuntimeSelection: ReturnType<typeof getMcpProviderInspectionRuntimeSelection>,
): Promise<McpAddRecovery> {
  const adapterInspection = await inspectAgentAdapterRegistration(
    sandboxName,
    adapter,
    entry,
    providerRuntimeSelection,
  );
  if (adapterInspection.state !== "absent" && adapterInspection.state !== "registered") {
    const detail =
      adapterInspection.state === "error"
        ? adapterInspection.detail
        : `server name is already ${adapterInspection.state}`;
    throw new McpBridgeError(
      `MCP add recovery for '${entry.server}' found an incompatible ${adapter} adapter entry: ${detail}. No source was changed.`,
    );
  }

  const providerInspection = await inspectMcpProvider(entry.providerName, providerRuntimeSelection);
  if (providerInspection.exists === null) {
    throw new McpBridgeError(
      `MCP add recovery for '${entry.server}' could not inspect provider '${entry.providerName}': ${providerInspection.error ?? "provider inspection failed"}. No source was changed.`,
    );
  }
  if (
    providerInspection.exists === true &&
    (!providerInspection.id ||
      providerInspection.resourceVersion === null ||
      providerInspection.type !== MCP_BRIDGE_PROVIDER_TYPE ||
      providerInspection.credentialKeys?.length !== 1 ||
      providerInspection.credentialKeys[0] !== entry.env[0])
  ) {
    throw new McpBridgeError(
      `MCP add recovery for '${entry.server}' found an incompatible provider '${entry.providerName}': ${providerShapeDetail(providerInspection, entry.env[0]) ?? "provider shape differs"}. No source was changed.`,
    );
  }
  const recoveredEntry = providerInspection.id
    ? { ...entry, providerId: providerInspection.id }
    : entry;

  const boundPolicyContent = buildMcpBridgePolicyYaml(
    entry.server,
    entry.url,
    adapter,
    target,
    entry.providerName ?? "",
    entry.denyTools,
  );
  const boundPolicyState = policies.getPresetContentGatewayState(
    sandboxName,
    boundPolicyContent,
    undefined,
    providerRuntimeSelection,
  );
  let policyState: McpAddRecovery["policyState"];
  if (boundPolicyState === "match") {
    policyState = "bound";
  } else if (boundPolicyState === "absent") {
    policyState = "absent";
  } else {
    const capabilityPolicyState = policies.getPresetContentGatewayState(
      sandboxName,
      buildMcpBridgeCapabilityPolicyYaml(entry.server, entry.url, adapter, target, entry.denyTools),
      undefined,
      providerRuntimeSelection,
    );
    if (capabilityPolicyState !== "match") {
      throw new McpBridgeError(
        `MCP add recovery for '${entry.server}' found a conflicting generated policy key '${buildMcpBridgePolicyKey(entry.server)}' (state: ${boundPolicyState ?? capabilityPolicyState ?? "unreachable"}). No source was changed.`,
      );
    }
    policyState = "capability";
  }

  const attachmentInspection = await inspectMcpProviderAttachments(
    sandboxName,
    providerRuntimeSelection,
  );
  if (!attachmentInspection.attachments) {
    throw new McpBridgeError(
      attachmentInspection.error ??
        `MCP add recovery for '${entry.server}' could not inspect provider attachments.`,
    );
  }
  const attachment = attachmentInspection.attachments.find(
    (candidate) => candidate.name === entry.providerName,
  );
  if (
    attachment &&
    (attachment.providerId !== recoveredEntry.providerId ||
      attachment.credentialKeys.length !== 1 ||
      attachment.credentialKeys[0] !== entry.env[0])
  ) {
    throw new McpBridgeError(
      `MCP add recovery for '${entry.server}' found an incompatible provider attachment '${entry.providerName}'. No source was changed.`,
    );
  }
  const providerPresent = providerInspection.exists === true;
  const attachmentPresent = Boolean(attachment);
  const adapterRegistered = adapterInspection.state === "registered";
  if (
    (providerPresent && policyState === "absent") ||
    (attachmentPresent && (!providerPresent || policyState === "absent")) ||
    (adapterRegistered && (!attachmentPresent || policyState !== "bound")) ||
    (policyState === "bound" && !providerPresent)
  ) {
    throw new McpBridgeError(
      `MCP add recovery for '${entry.server}' found non-prefix partial state across the native adapter, policy, provider, and attachment. No source was changed.`,
    );
  }
  return {
    entry: recoveredEntry,
    adapterRegistered,
    attachmentPresent,
    policyState,
    resuming: adapterRegistered || attachmentPresent || providerPresent || policyState !== "absent",
  };
}

export async function addMcpBridge(
  sandboxName: string,
  options: McpBridgeAddOptions,
): Promise<ReturnType<typeof getMcpProviderInspectionRuntimeSelection>> {
  return withMcpLifecycleLock(sandboxName, () => {
    assertHermesPortableCommandUnavailable(sandboxName, "sandbox:mcp:add");
    return addMcpBridgeUnlocked(sandboxName, options);
  });
}

export async function updateMcpBridgeDenyTools(
  sandboxName: string,
  server: string,
  denyTools: readonly string[],
): Promise<void> {
  return withMcpLifecycleLock(sandboxName, () => {
    assertHermesPortableCommandUnavailable(sandboxName, "sandbox:mcp:update");
    return updateMcpBridgeDenyToolsUnlocked(sandboxName, server, denyTools);
  });
}

async function updateMcpBridgeDenyToolsUnlocked(
  sandboxName: string,
  server: string,
  denyTools: readonly string[],
): Promise<void> {
  validateSandboxName(sandboxName);
  validateMcpServerName(server);
  const normalizedDenyTools = normalizeMcpDenyTools(denyTools);
  const sandbox = getSandboxOrThrow(sandboxName);
  const runtimeSelection = getMcpProviderInspectionRuntimeSelection(sandbox);
  const observed = await inspectSourceBridgeState(sandbox, runtimeSelection);
  const legacyNames = Object.keys(observed.sources.legacy).sort();
  if (legacyNames.length > 0) {
    throw new McpBridgeError(
      `Legacy MCP agent configuration requires explicit migration for '${legacyNames.join(", ")}'. Run \`nemoclaw ${sandboxName} mcp migrate\` to preview it.`,
      2,
    );
  }
  const storedEntry = observed.bridges[server];
  if (!storedEntry) {
    throw new McpBridgeError(`MCP server '${server}' not found on sandbox '${sandboxName}'.`);
  }
  assertAuthenticatedBridgeEntry(storedEntry);
  const target = (await preflightMcpEntryTargets([storedEntry])).get(server);
  if (!target || target.addresses.length === 0) {
    throw new McpBridgeError(
      `MCP server '${server}' has no validated address pins. No policy was changed.`,
    );
  }
  const { denyTools: _previousDenyTools, ...entryWithoutDenyTools } = storedEntry;
  const updatedEntry: McpSourceEntry = {
    ...entryWithoutDenyTools,
    ...(normalizedDenyTools.length > 0 ? { denyTools: normalizedDenyTools } : {}),
    allowedIps: [...target.addresses],
  };
  assertGeneratedPolicyMutationSafe(sandboxName, updatedEntry);
  assertMcpCredentialBoundaryRuntimeVersion();
  await ensureSandboxGatewaySelected(sandboxName, runtimeSelection);
  await assertMcpProviderRecoverable(updatedEntry, runtimeSelection);

  // Live OpenShell policy owns enforcement state. Remove the prior allow route
  // before applying a stricter replacement so interruption fails closed; the
  // source registration remains available for an explicit update retry.
  removeGeneratedPolicy(sandboxName, storedEntry, { runtimeSelection });
  try {
    applyGeneratedPolicy(sandboxName, updatedEntry, target, { runtimeSelection });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const retryArgs =
      normalizedDenyTools.length > 0
        ? normalizedDenyTools.map((tool) => ` --deny-tool ${tool}`).join("")
        : " --clear-deny-tools";
    throw new McpBridgeError(
      `${detail} The MCP route remains blocked. Retry with \`nemoclaw ${sandboxName} mcp update ${server}${retryArgs}\`.`,
    );
  }
  console.log(
    normalizedDenyTools.length > 0
      ? `  Updated denied tools for MCP server '${server}'.`
      : `  Cleared denied tools for MCP server '${server}'.`,
  );
}

async function addMcpBridgeUnlocked(
  sandboxName: string,
  options: McpBridgeAddOptions,
): Promise<ReturnType<typeof getMcpProviderInspectionRuntimeSelection>> {
  validateSandboxName(sandboxName);
  validateMcpServerName(options.server);
  assertAuthenticatedCredentialReference(options.env);
  const denyTools = normalizeMcpDenyTools(options.denyTools ?? []);
  let explicitTrustedPrivateHosts: string[];
  let configuredTrustedPrivateHosts: string[];
  try {
    explicitTrustedPrivateHosts = (options.trustedPrivateHosts ?? []).map((host) =>
      normalizeTrustedPrivateHost(host),
    );
    configuredTrustedPrivateHosts = parseTrustedPrivateHosts(
      process.env.NEMOCLAW_TRUSTED_PRIVATE_HOSTS,
    );
  } catch (error) {
    throw new McpBridgeError(error instanceof Error ? error.message : String(error), 2);
  }
  if (new Set(explicitTrustedPrivateHosts).size !== explicitTrustedPrivateHosts.length) {
    throw new McpBridgeError(
      "Duplicate --trusted-private-host declarations are not accepted after normalization.",
      2,
    );
  }
  const allTrustedPrivateHosts = [
    ...new Set([...explicitTrustedPrivateHosts, ...configuredTrustedPrivateHosts]),
  ];
  const normalizedUrl = normalizeMcpServerUrl(options.url, {
    trustedPrivateHosts: allTrustedPrivateHosts,
  });
  const urlHost = new URL(normalizedUrl).hostname.toLowerCase();
  const unrelatedExplicitHost = explicitTrustedPrivateHosts.find((host) => host !== urlHost);
  if (unrelatedExplicitHost) {
    throw new McpBridgeError(
      `--trusted-private-host ${unrelatedExplicitHost} does not match MCP server URL host '${urlHost}'.`,
      2,
    );
  }
  const matchingTrustedPrivateHosts = allTrustedPrivateHosts.filter((host) => host === urlHost);
  const sandbox = getSandboxOrThrow(sandboxName);
  const sourceRuntimeSelection = getMcpProviderInspectionRuntimeSelection(sandbox);
  const observed = await inspectSourceBridgeState(sandbox, sourceRuntimeSelection);
  const legacyNames = Object.keys(observed.sources.legacy).sort();
  if (legacyNames.length > 0) {
    throw new McpBridgeError(
      `Legacy MCP agent configuration requires explicit migration for '${legacyNames.join(", ")}'. Run \`nemoclaw ${sandboxName} mcp migrate\` to preview it.`,
      2,
    );
  }
  const agent = getSandboxAgent(sandbox);
  const adapter = getBridgeAdapter(agent);
  const existingEntry = observed.bridges[options.server];
  let target = existingEntry
    ? replayMcpAddTarget(existingEntry, normalizedUrl, matchingTrustedPrivateHosts)
    : null;
  if (!target) {
    target = await preflightMcpServerUrlResolvedTarget(new URL(normalizedUrl), {
      trustedPrivateHosts: matchingTrustedPrivateHosts,
      requireTrustedPrivateEndpoint: explicitTrustedPrivateHosts.length > 0,
    });
  }

  const envNames = uniqueEnvNames(options.env);
  const envCollision = Object.values(observed.bridges).find(
    (entry) =>
      entry.server !== options.server && entry.env.some((envName) => envNames.includes(envName)),
  );
  if (envCollision) {
    const duplicate = envCollision.env.find((envName) => envNames.includes(envName));
    throw new McpBridgeError(
      `Credential key '${duplicate}' is already attached through MCP server '${envCollision.server}'. OpenShell static credential keys must be unique within a sandbox; use a distinct host environment name.`,
      2,
    );
  }
  const providerName =
    envNames.length > 0
      ? (existingEntry?.providerName ?? buildMcpBridgeProviderName(sandboxName, options.server))
      : undefined;
  const adapterEnvValues = resolveCredentialEnv(options.env);
  const policyName = buildMcpBridgePolicyName(options.server);
  assertNoDerivedResourceCollision(observed.bridges, options.server, providerName, policyName);
  let requestedEntry: McpSourceEntry = {
    server: options.server,
    agent: agent.name,
    adapter,
    url: normalizedUrl,
    env: envNames,
    ...(denyTools.length > 0 ? { denyTools } : {}),
    allowedIps: [...target.addresses],
    ...(target.trustedPrivateHost
      ? {
          trustedPrivateHost: target.trustedPrivateHost,
        }
      : {}),
    ...(providerName ? { providerName } : {}),
    policyName,
  };

  if (existingEntry && !sameMcpAddIntent(existingEntry, requestedEntry)) {
    throw new McpBridgeError(
      `MCP server '${options.server}' already exists with different URL, credential, denied tools, agent, or derived resources. Re-run the original add command or remove it with --force before changing the definition.`,
      2,
    );
  }

  let entry = requestedEntry;
  const providerRuntimeSelection = getMcpProviderInspectionRuntimeSelection(sandbox);
  // Bind the static credential-name deny-list to the OpenShell binary before
  // mutating a provider, policy, or adapter.
  assertMcpCredentialBoundaryRuntimeVersion();
  await ensureSandboxGatewaySelected(sandboxName, providerRuntimeSelection);
  const committedPolicyTarget = await recoverCommittedPolicyTarget(
    sandboxName,
    sandbox,
    adapter,
    requestedEntry,
    target,
    matchingTrustedPrivateHosts,
    providerRuntimeSelection,
  );
  if (committedPolicyTarget) {
    target = committedPolicyTarget;
    const { trustedPrivateHost: _currentTrustedPrivateHost, ...requestedWithoutPrivateHost } =
      requestedEntry;
    requestedEntry = {
      ...requestedWithoutPrivateHost,
      allowedIps: [...target.addresses],
      ...(target.trustedPrivateHost ? { trustedPrivateHost: target.trustedPrivateHost } : {}),
    };
    if (existingEntry && !sameMcpAddIntent(existingEntry, requestedEntry)) {
      throw new McpBridgeError(
        `MCP server '${options.server}' already exists with different URL, credential, denied tools, agent, or derived resources. Re-run the original add command or remove it with --force before changing the definition.`,
        2,
      );
    }
    entry = requestedEntry;
  }
  let recovery!: McpAddRecovery;
  await withMcpCredentialOwnershipLock(async () => {
    recovery = await inspectMcpAddRecovery(
      sandboxName,
      adapter,
      entry,
      target,
      providerRuntimeSelection,
    );
    entry = recovery.entry;
    // Check live providers under the same cross-command lock used by
    // credentials add so neither command can race its collision check.
    await assertNoProviderCredentialCollisions(sandboxName, [entry], providerRuntimeSelection);
  });
  if (!entry.providerId && !Object.hasOwn(adapterEnvValues, entry.env[0])) {
    throw new McpBridgeError(
      `Host environment variable '${entry.env[0]}' is required to create MCP provider '${entry.providerName}'.`,
      1,
    );
  }
  let providerCreated = false;
  let providerAttachAttempted = false;
  let policyApplied = false;
  let policyRebound = false;
  let adapterMutationAttempted = false;
  let adapterWasRegistered = false;
  let previousCredentialRevision: McpCredentialRevisionObservation | undefined;
  try {
    await assertAgentMcpMutationRuntimeCapability(sandboxName, adapter, providerRuntimeSelection);
    if (entry.providerId && !Object.hasOwn(adapterEnvValues, entry.env[0])) {
      // A process-boundary retry can reuse the exact live provider without
      // re-exporting its secret. Its immutable ID was re-derived above from
      // the matching policy, provider, attachment, and native source prefix.
      await assertMcpProviderRecoverable(entry, providerRuntimeSelection);
    }
    // Credential keys are sandbox-global. Prove this key is not already
    // supplied by a foreign attachment before opening its MCP route, then check
    // again after provider creation to close the intervening race.
    await assertNoProviderCredentialCollisions(sandboxName, [entry], providerRuntimeSelection);
    await ensureMcpBridgeProviderProfile(providerRuntimeSelection);
    // Load the real protocol:mcp policy without a credential binding before
    // provider mutation. OpenShell requires the endpointless provider to be
    // attached before it accepts credential_binding.provider, and withholds
    // that provider's static credential until the bound policy is active.
    if (recovery.policyState === "absent") {
      applyGeneratedPolicy(sandboxName, entry, target, {
        bindCredential: false,
        runtimeSelection: providerRuntimeSelection,
      });
      policyApplied = true;
    }
    adapterWasRegistered = recovery.adapterRegistered;
    const providerResult = await upsertMcpProvider(providerName ?? "", options.env, {
      // Existing provider identity is accepted only after the complete live
      // partial-state prefix above has tied it to this exact add request.
      allowExisting: recovery.resuming,
      expectedProviderId: entry.providerId,
      runtimeSelection: providerRuntimeSelection,
      prepareMutation: async (action) => {
        // A fresh create has no prior revision to compare. Observe only the
        // bounded placeholder classification for an actual update, after the
        // running supervisor has accepted the authenticated MCP policy.
        if (action === "update") {
          previousCredentialRevision = await observeMcpCredentialRevision(
            sandboxName,
            entry,
            providerRuntimeSelection,
          );
        }
      },
    });
    providerCreated = providerResult.action === "created";
    const providerId = providerResult.inspection.id;
    if (!providerId) {
      throw new McpBridgeError(
        `OpenShell did not return a stable provider ID for '${providerName}'. Refusing later MCP side effects.`,
      );
    }
    if (entry.providerId !== providerId) {
      entry = { ...entry, providerId };
    }
    await assertNoProviderCredentialCollisions(sandboxName, [entry], providerRuntimeSelection);
    if (providerResult.action === "updated" && previousCredentialRevision === undefined) {
      throw new McpBridgeError(
        `Could not retain the prior OpenShell credential revision for provider '${entry.providerName}'.`,
      );
    }
    if (!recovery.attachmentPresent) {
      providerAttachAttempted = true;
      await attachProvider(sandboxName, entry, providerRuntimeSelection);
    }
    if (recovery.policyState !== "bound") {
      applyGeneratedPolicy(sandboxName, entry, target, {
        runtimeSelection: providerRuntimeSelection,
      });
      policyRebound = recovery.policyState === "capability";
    }
    let refreshedAfterObservedAbsence = false;
    let authorizationPreviousRevision =
      providerResult.action === "updated" ? previousCredentialRevision : undefined;
    let credentialRevision = await waitForAttachedMcpCredential(
      sandboxName,
      entry,
      providerRuntimeSelection,
      {
        ...(providerResult.action === "updated"
          ? {
              previousRevision: previousCredentialRevision,
            }
          : {}),
        // A no-field provider update advances only the provider resource version.
        // If the credential remains available, republish it after observing an
        // absence; otherwise, a hostless recovery advances the provider revision.
        refreshAfterObservedAbsence: async () => {
          refreshedAfterObservedAbsence = true;
          // invalidState: OpenShell 0.0.106 can coalesce a no-field provider
          // refresh without publishing the credential into fresh sandbox execs.
          // sourceBoundary: OpenShell owns provider revision projection.
          // whyNotSourceFix: NemoClaw can only observe absence after the bound
          // policy is active, then republish when this process still has the host
          // credential value. Hostless recovery retains the credential-free path.
          // regressionTest: mcp-add-crash-consistency.test.ts covers republish
          // and hostless recovery; mcp-provider-ownership.test.ts covers loss of
          // the persisted provider identity before republish.
          // removalCondition: remove the credential-bearing republish when the
          // supported OpenShell version guarantees that a post-policy no-field
          // refresh projects the bound credential into fresh sandbox execs.
          const republished = await upsertMcpProvider(entry.providerName ?? "", options.env, {
            allowExisting: true,
            expectedProviderId: entry.providerId,
            requireExisting: true,
            runtimeSelection: providerRuntimeSelection,
          });
          if (republished.action !== "updated") {
            await refreshMcpProviderEnvironment(entry, providerRuntimeSelection);
          }
        },
      },
    );
    if (Object.hasOwn(adapterEnvValues, entry.env[0]) && !refreshedAfterObservedAbsence) {
      // OpenShell 0.0.106 polls provider state every ten seconds. First prove
      // the pre-republish generation is installed, then republish while the
      // bound policy is active and require a different observed revision.
      // This prevents a quick series of reads from accepting an intermediate
      // generation while the final credential-bearing update is still queued.
      authorizationPreviousRevision = credentialRevision;
      await upsertMcpProvider(entry.providerName ?? "", options.env, {
        allowExisting: true,
        expectedProviderId: entry.providerId,
        requireExisting: true,
        runtimeSelection: providerRuntimeSelection,
      });
      credentialRevision = await waitForAttachedMcpCredential(
        sandboxName,
        entry,
        providerRuntimeSelection,
        { previousRevision: credentialRevision },
      );
    }
    await assertUnchangedStableMcpCredentialAuthorized(
      sandboxName,
      entry,
      providerRuntimeSelection,
      authorizationPreviousRevision,
      credentialRevision,
      statusMcpBridge,
    );
    adapterMutationAttempted = true;
    await registerAgentAdapterAtCurrentCredentialRevision(
      sandboxName,
      adapter,
      entry,
      providerRuntimeSelection,
      adapterEnvValues,
      credentialRevision,
      {
        // An exact adapter entry is evidence of a post-commit process death.
        // Replacing it is idempotent and, for Hermes, re-verifies runtime reload.
        replaceExisting: recovery.adapterRegistered,
      },
    );
    await reloadOpenClawGatewayAfterMcpMutation(sandboxName, [adapter]);
  } catch (error) {
    const rollbackProviderInspection =
      (providerAttachAttempted || providerCreated) && entry.providerId
        ? await inspectMcpProvider(providerName, providerRuntimeSelection)
        : undefined;
    const rollbackProviderOwned =
      !!rollbackProviderInspection &&
      providerMatchesCredential(rollbackProviderInspection, entry.env[0], entry.providerId);
    if ((adapterMutationAttempted && !recovery.adapterRegistered) || adapterWasRegistered) {
      await unregisterAgentAdapter(sandboxName, adapter, entry, providerRuntimeSelection, {
        force: false,
        bestEffort: true,
        envValues: adapterEnvValues,
      });
    }
    if (policyApplied) {
      removeGeneratedPolicy(sandboxName, entry, {
        bestEffort: true,
        runtimeSelection: providerRuntimeSelection,
      });
    } else if (policyRebound) {
      try {
        applyGeneratedPolicy(sandboxName, entry, target, {
          bindCredential: false,
          runtimeSelection: providerRuntimeSelection,
        });
      } catch {
        // Preserve the live source set for an identity-checked retry.
      }
    }
    const detachOutcome = providerAttachAttempted
      ? await detachProvider(sandboxName, entry, {
          bestEffort: true,
          runtimeSelection: providerRuntimeSelection,
        })
      : "absent";
    let reservationCleanupProved = !providerAttachAttempted;
    if (providerAttachAttempted && detachOutcome !== "unknown") {
      try {
        await waitForDetachedMcpCredential(sandboxName, entry, providerRuntimeSelection);
        reservationCleanupProved = true;
      } catch {
        reservationCleanupProved = false;
      }
    }
    if (providerCreated && rollbackProviderOwned && reservationCleanupProved) {
      console.warn(
        `  Preserved detached OpenShell provider '${providerName}' after MCP add rollback. Remove it explicitly after confirming no sandbox uses it.`,
      );
    }
    // Exception rollback is best-effort and process death skips it entirely.
    // A retry re-derives the partial transaction from the agent and OpenShell.
    throw error;
  }
  return providerRuntimeSelection;
}
