// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";

import type { AgentMcpAdapter } from "../../agent/defs";
import * as policies from "../../policy";
import {
  normalizeTrustedPrivateHost,
  parseTrustedPrivateHosts,
  replayTrustedPrivateEndpoint,
} from "../../security/trusted-private-endpoint";
import { withMcpLifecycleLock } from "../../state/mcp-lifecycle-lock";
import { assertHermesPortableCommandUnavailable } from "../../onboard/experimental/portable-agent-lifecycle";
import type { McpBridgeEntry } from "../../state/registry";
import * as registry from "../../state/registry";
import { withMcpCredentialOwnershipLock } from "../../state/mcp-lifecycle-lock/credential-ownership";
import {
  assertAgentMcpConfigMutationAllowed,
  assertAgentMcpMutationRuntimeCapability,
  inspectAgentAdapterRegistration,
  registerAgentAdapter,
  unregisterAgentAdapter,
} from "./mcp-bridge-adapters";
import { type McpBridgeAddOptions, McpBridgeError } from "./mcp-bridge-contracts";
import { assertHermesMcpRuntimeIntent } from "./mcp-bridge-hermes-reconciliation";
import {
  applyGeneratedPolicy,
  buildMcpBridgePolicyKey,
  buildMcpBridgePolicyName,
  buildMcpBridgePolicyYaml,
  removeGeneratedPolicy,
} from "./mcp-bridge-policy";
import {
  assertMcpProviderRecoverable,
  assertNoProviderCredentialCollisions,
  attachProvider,
  deleteProvider,
  detachMissingProviderReference,
  detachProvider,
  ensureMcpBridgeProviderProfile,
  inspectMcpProvider,
  type McpCredentialRevisionObservation,
  observeMcpCredentialRevision,
  providerMatchesCredential,
  providerShapeDetail,
  refreshMcpProviderEnvironment,
  upsertMcpProvider,
  waitForAttachedMcpCredential,
  waitForDetachedMcpCredential,
} from "./mcp-bridge-provider";
import {
  assertMcpDestroyNotPending,
  assertNoDerivedResourceCollision,
  bridgeState,
  ensureSandboxGatewaySelected,
  getBridgeAdapter,
  getSandboxAgent,
  getSandboxOrThrow,
  nowIso,
  writeBridgeEntry,
} from "./mcp-bridge-state";
import type { McpBridgeTargetValidation } from "./mcp-bridge-url-validation";
import {
  assertAuthenticatedCredentialReference,
  assertMcpCredentialBoundaryRuntimeVersion,
  buildMcpBridgeProviderName,
  normalizeMcpServerUrl,
  preflightMcpServerUrlResolvedTarget,
  resolveCredentialEnv,
  uniqueEnvNames,
  validateMcpServerName,
  validateSandboxName,
} from "./mcp-bridge-validation";

function sameMcpAddIntent(existing: McpBridgeEntry, requested: McpBridgeEntry): boolean {
  return (
    existing.server === requested.server &&
    existing.agent === requested.agent &&
    existing.adapter === requested.adapter &&
    existing.url === requested.url &&
    existing.providerName === requested.providerName &&
    existing.policyName === requested.policyName &&
    existing.trustedPrivateHost === requested.trustedPrivateHost &&
    (existing.allowedIps?.length ?? 0) === (requested.allowedIps?.length ?? 0) &&
    (existing.allowedIps ?? []).every(
      (address, index) => address === requested.allowedIps?.[index],
    ) &&
    existing.env.length === requested.env.length &&
    existing.env.every((name, index) => name === requested.env[index])
  );
}

function assertPreparedMcpAddResourcesAbsent(
  sandboxName: string,
  adapter: AgentMcpAdapter,
  entry: McpBridgeEntry,
  target: McpBridgeTargetValidation,
): void {
  const adapterInspection = inspectAgentAdapterRegistration(sandboxName, adapter, entry);
  if (adapterInspection.state !== "absent") {
    const detail =
      adapterInspection.state === "error"
        ? adapterInspection.detail
        : `server name is already ${adapterInspection.state}`;
    throw new McpBridgeError(
      `MCP add preflight for '${entry.server}' found an existing ${adapter} adapter entry: ${detail}. The durable add manifest was preserved without claiming it.`,
    );
  }

  const providerInspection = inspectMcpProvider(entry.providerName);
  if (providerInspection.exists !== false) {
    const detail =
      providerInspection.exists === null
        ? (providerInspection.error ?? "provider inspection failed")
        : (providerShapeDetail(providerInspection, entry.env[0]) ?? "provider already exists");
    throw new McpBridgeError(
      `MCP add preflight for '${entry.server}' could not prove provider '${entry.providerName}' absent: ${detail}. The durable add manifest was preserved without claiming it.`,
    );
  }

  const existingPolicy = registry
    .getCustomPolicies(sandboxName)
    .find((policy) => policy.name === entry.policyName);
  if (existingPolicy) {
    throw new McpBridgeError(
      `MCP add preflight for '${entry.server}' found an existing policy ownership record '${entry.policyName}'. The durable add manifest was preserved without claiming it.`,
    );
  }
  const policyContent = buildMcpBridgePolicyYaml(
    entry.server,
    entry.url,
    adapter,
    target,
    entry.providerName ?? "",
  );
  const policyState = policies.getPresetContentGatewayState(sandboxName, policyContent);
  if (policyState !== "absent") {
    throw new McpBridgeError(
      `MCP add preflight for '${entry.server}' could not prove generated policy key '${buildMcpBridgePolicyKey(entry.server)}' absent (state: ${policyState ?? "unreachable"}). The durable add manifest was preserved without claiming it.`,
    );
  }
}

export async function addMcpBridge(
  sandboxName: string,
  options: McpBridgeAddOptions,
): Promise<void> {
  return withMcpLifecycleLock(sandboxName, () => {
    assertHermesPortableCommandUnavailable(sandboxName, "sandbox:mcp:add");
    return addMcpBridgeUnlocked(sandboxName, options);
  });
}

async function addMcpBridgeUnlocked(
  sandboxName: string,
  options: McpBridgeAddOptions,
): Promise<void> {
  validateSandboxName(sandboxName);
  validateMcpServerName(options.server);
  assertAuthenticatedCredentialReference(options.env);
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
  assertMcpDestroyNotPending(sandbox);
  const agent = getSandboxAgent(sandbox);
  const adapter = getBridgeAdapter(agent);
  const existingEntry = bridgeState(sandbox)[options.server];
  if (existingEntry && !existingEntry.addState) {
    throw new McpBridgeError(
      `MCP server '${options.server}' already exists on sandbox '${sandboxName}'.`,
    );
  }
  let target: McpBridgeTargetValidation;
  if (existingEntry?.trustedPrivateHost) {
    if (
      existingEntry.trustedPrivateHost !== urlHost ||
      !matchingTrustedPrivateHosts.includes(existingEntry.trustedPrivateHost)
    ) {
      throw new McpBridgeError(
        `MCP server '${options.server}' has an incomplete add transaction with different trusted-private host intent. Re-run the original add command or remove it with --force before changing the definition.`,
        2,
      );
    }
    try {
      const replay = replayTrustedPrivateEndpoint(
        existingEntry.trustedPrivateHost,
        existingEntry.allowedIps ?? [],
        { requireAllPrivate: true },
      );
      target = {
        addresses: [...replay.addresses],
        trustedPrivateCapability: replay.trustedPrivateCapability,
        trustedPrivateHost: replay.host,
      };
    } catch (error) {
      throw new McpBridgeError(
        `MCP server '${options.server}' has invalid durable trusted-private intent: ${error instanceof Error ? error.message : String(error)}. Remove it with --force and add it again.`,
        2,
      );
    }
  } else {
    target = await preflightMcpServerUrlResolvedTarget(new URL(normalizedUrl), {
      trustedPrivateHosts: matchingTrustedPrivateHosts,
      requireTrustedPrivateEndpoint: explicitTrustedPrivateHosts.length > 0,
    });
  }

  const envNames = uniqueEnvNames(options.env);
  const envCollision = Object.values(bridgeState(sandbox)).find(
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
      ? (existingEntry?.providerName ??
        buildMcpBridgeProviderName(
          sandboxName,
          options.server,
          crypto.randomBytes(8).toString("hex"),
        ))
      : undefined;
  const adapterEnvValues = resolveCredentialEnv(options.env);
  if (!existingEntry && !Object.hasOwn(adapterEnvValues, envNames[0])) {
    throw new McpBridgeError(
      `Host environment variable '${envNames[0]}' is required to create MCP provider '${providerName}'.`,
      1,
    );
  }
  const policyName = buildMcpBridgePolicyName(options.server);
  assertNoDerivedResourceCollision(sandbox, options.server, providerName, policyName);
  const requestedEntry: McpBridgeEntry = {
    server: options.server,
    agent: agent.name,
    adapter,
    url: normalizedUrl,
    env: envNames,
    ...(target.trustedPrivateHost
      ? {
          trustedPrivateHost: target.trustedPrivateHost,
          allowedIps: [...target.addresses],
        }
      : {}),
    ...(providerName ? { providerName } : {}),
    policyName,
    addedAt: existingEntry?.addedAt ?? nowIso(),
    addState: existingEntry?.addState ?? "prepared",
  };

  if (existingEntry && !sameMcpAddIntent(existingEntry, requestedEntry)) {
    throw new McpBridgeError(
      `MCP server '${options.server}' has an incomplete add transaction with different URL, credential, agent, or derived resources. Re-run the original add command or remove it with --force before changing the definition.`,
      2,
    );
  }

  let entry: McpBridgeEntry = existingEntry
    ? {
        ...existingEntry,
        env: [...existingEntry.env],
        ...(existingEntry.allowedIps ? { allowedIps: [...existingEntry.allowedIps] } : {}),
      }
    : requestedEntry;
  const resumingPreflightedAdd = existingEntry?.addState === "preflighted";
  if (existingEntry?.addState === "prepared" && !Object.hasOwn(adapterEnvValues, entry.env[0])) {
    throw new McpBridgeError(
      `Host environment variable '${entry.env[0]}' is required to create MCP provider '${entry.providerName}'.`,
      1,
    );
  }
  // Hermes config posture is host-visible, so reject before even the durable
  // prepared manifest is written. The in-sandbox helper repeats the check at
  // the actual config write so a concurrent posture change still fails closed.
  assertAgentMcpConfigMutationAllowed(sandboxName, adapter);
  // Bind the static credential-name deny-list to the OpenShell binary before
  // persisting ownership or mutating a provider, policy, or adapter.
  assertMcpCredentialBoundaryRuntimeVersion();
  await ensureSandboxGatewaySelected(sandboxName);
  if (!existingEntry) {
    await withMcpCredentialOwnershipLock(() => {
      // Publish the durable MCP reservation under the same cross-command lock
      // used by credentials add. Neither command can pass its collision check
      // before the other records its credential-key reservation.
      assertNoProviderCredentialCollisions(sandboxName, [entry]);
      writeBridgeEntry(sandboxName, entry);
    });
  }
  let providerCreated = false;
  let providerAttachAttempted = false;
  let policyApplied = false;
  let adapterMutationAttempted = false;
  let previousCredentialRevision: McpCredentialRevisionObservation | undefined;
  try {
    let detachedMissingProviderReference = false;
    if (resumingPreflightedAdd) {
      const providerInspection = inspectMcpProvider(entry.providerName);
      if (providerInspection.exists === null) {
        throw new McpBridgeError(
          providerInspection.error ??
            `Could not inspect OpenShell provider '${entry.providerName}' before resuming MCP add.`,
        );
      }
      if (providerInspection.exists === false) {
        // A provider can disappear while its sandbox-spec attachment remains.
        // OpenShell cannot start any sandbox child while that dangling name is
        // present, so detaching the already-missing provider reference is the
        // one recovery side effect that must precede the image capability
        // probe. It neither reads nor replaces credential material, and the
        // durable add manifest retains ownership if the later probe fails.
        detachMissingProviderReference(sandboxName, entry);
        detachedMissingProviderReference = true;
      }
    }
    assertAgentMcpMutationRuntimeCapability(sandboxName, adapter);
    if (detachedMissingProviderReference) {
      waitForDetachedMcpCredential(sandboxName, entry);
    }
    if (resumingPreflightedAdd && !Object.hasOwn(adapterEnvValues, entry.env[0])) {
      try {
        // A retry may reuse an exact provider without re-exporting its secret,
        // but recreating a missing provider cannot. This check and any owned
        // policy cleanup happen only after the running-image capability probe.
        assertMcpProviderRecoverable(entry);
      } catch (error) {
        removeGeneratedPolicy(sandboxName, entry, { bestEffort: true });
        throw error;
      }
    }

    if (entry.addState === "prepared") {
      assertPreparedMcpAddResourcesAbsent(sandboxName, adapter, entry, target);
      entry = { ...entry, addState: "preflighted" };
      // This second durable boundary proves the derived resource names and the
      // adapter slot were absent before any side effect. After a crash, retries
      // may therefore reuse only missing or exact resources, never drift.
      writeBridgeEntry(sandboxName, entry);
    }
    const adapterInspection = inspectAgentAdapterRegistration(sandboxName, adapter, entry);
    if (
      adapterInspection.state !== "absent" &&
      !(resumingPreflightedAdd && adapterInspection.state === "registered")
    ) {
      const detail =
        adapterInspection.state === "error"
          ? adapterInspection.detail
          : `server name is already ${adapterInspection.state}`;
      throw new McpBridgeError(
        `MCP server '${entry.server}' cannot be registered in the ${adapter} adapter: ${detail}.`,
      );
    }
    // Credential keys are sandbox-global. Prove this key is not already
    // supplied by a foreign attachment before opening its MCP route, then check
    // again after provider creation to close the intervening race.
    assertNoProviderCredentialCollisions(sandboxName, [entry]);
    ensureMcpBridgeProviderProfile();
    // Load the real protocol:mcp policy without a credential binding before
    // provider mutation. OpenShell requires the endpointless provider to be
    // attached before it accepts credential_binding.provider, and withholds
    // that provider's static credential until the bound policy is active.
    applyGeneratedPolicy(sandboxName, entry, target, { bindCredential: false });
    policyApplied = true;
    const providerResult = upsertMcpProvider(providerName ?? "", options.env, {
      // A first mutation must still observe the absence proven above. Only a
      // retry of the durable preflighted transaction may encounter an exact
      // provider whose immutable ID was already persisted by this add.
      allowExisting: resumingPreflightedAdd,
      expectedProviderId: entry.providerId,
      prepareMutation: (action) => {
        // A fresh create has no prior revision to compare. Observe only the
        // bounded placeholder classification for an actual update, after the
        // running supervisor has accepted the authenticated MCP policy.
        if (action === "update") {
          previousCredentialRevision = observeMcpCredentialRevision(sandboxName, entry);
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
      // The immutable OpenShell identity is the ownership boundary for every
      // later lifecycle action. Persist it before policy, attachment, or
      // adapter mutations. A process death before this write fails closed.
      writeBridgeEntry(sandboxName, entry);
    }
    assertNoProviderCredentialCollisions(sandboxName, [entry]);
    if (providerResult.action === "updated" && previousCredentialRevision === undefined) {
      throw new McpBridgeError(
        `Could not retain the prior OpenShell credential revision for provider '${entry.providerName}'.`,
      );
    }
    providerAttachAttempted = true;
    attachProvider(sandboxName, entry);
    applyGeneratedPolicy(sandboxName, entry, target);
    let refreshedAfterObservedAbsence = false;
    let credentialRevision = waitForAttachedMcpCredential(sandboxName, entry, {
      ...(providerResult.action === "updated"
        ? {
            previousRevision: previousCredentialRevision,
          }
        : {}),
      // A no-field provider update advances only the provider resource version.
      // If the credential remains available, republish it after observing an
      // absence; otherwise, a hostless recovery advances the provider revision.
      refreshAfterObservedAbsence: () => {
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
        const republished = upsertMcpProvider(entry.providerName ?? "", options.env, {
          allowExisting: true,
          expectedProviderId: entry.providerId,
          requireExisting: true,
        });
        if (republished.action !== "updated") refreshMcpProviderEnvironment(entry);
      },
    });
    if (Object.hasOwn(adapterEnvValues, entry.env[0]) && !refreshedAfterObservedAbsence) {
      // OpenShell 0.0.106 polls provider state every ten seconds. First prove
      // the pre-republish generation is installed, then republish while the
      // bound policy is active and require a different observed revision.
      // This prevents a quick series of reads from accepting an intermediate
      // generation while the final credential-bearing update is still queued.
      upsertMcpProvider(entry.providerName ?? "", options.env, {
        allowExisting: true,
        expectedProviderId: entry.providerId,
        requireExisting: true,
      });
      credentialRevision = waitForAttachedMcpCredential(sandboxName, entry, {
        previousRevision: credentialRevision,
      });
    }
    // The adapter was proven absent above, so cleanup is safe even when a
    // command commits config and then fails during its runtime reload.
    adapterMutationAttempted = true;
    registerAgentAdapter(sandboxName, adapter, entry, adapterEnvValues, {
      // An exact adapter entry is evidence of a post-commit process death.
      // Replacing it is idempotent and, for Hermes, re-verifies runtime reload.
      // The wait above already proved the same revision stable in consecutive
      // fresh execs, so repeating reconciliation here can outlive the caller's
      // bounded provider-synchronization contract.
      replaceExisting: resumingPreflightedAdd && adapterInspection.state === "registered",
      credentialRevision,
    });
    if (adapter === "hermes-config") assertHermesMcpRuntimeIntent(sandboxName);
    const { addState: _completedAddState, ...committedEntry } = entry;
    writeBridgeEntry(sandboxName, committedEntry);
  } catch (error) {
    const rollbackProviderInspection =
      (providerAttachAttempted || providerCreated) && entry.providerId
        ? inspectMcpProvider(providerName)
        : undefined;
    const rollbackProviderOwned =
      !!rollbackProviderInspection &&
      providerMatchesCredential(rollbackProviderInspection, entry.env[0], entry.providerId);
    if (adapterMutationAttempted) {
      unregisterAgentAdapter(sandboxName, adapter, entry, {
        force: false,
        bestEffort: true,
        envValues: adapterEnvValues,
      });
    }
    if (policyApplied) {
      removeGeneratedPolicy(sandboxName, entry, { bestEffort: true });
    }
    const detachOutcome = providerAttachAttempted
      ? detachProvider(sandboxName, entry, { bestEffort: true })
      : "absent";
    let reservationCleanupProved = !providerAttachAttempted;
    if (providerAttachAttempted && detachOutcome !== "unknown") {
      try {
        waitForDetachedMcpCredential(sandboxName, entry);
        reservationCleanupProved = true;
      } catch {
        reservationCleanupProved = false;
      }
    }
    if (providerCreated && rollbackProviderOwned && reservationCleanupProved) {
      const beforeDelete = inspectMcpProvider(providerName);
      if (providerMatchesCredential(beforeDelete, entry.env[0], entry.providerId)) {
        deleteProvider(entry, { allowMissing: true, bestEffort: true });
      }
    }
    // Exception rollback is best-effort and process death skips it entirely.
    // Keep the durable add manifest until a retry converges or `mcp remove`
    // proves and cleans each exact resource.
    throw error;
  }
}
