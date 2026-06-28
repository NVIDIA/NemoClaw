// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";

import type { AgentDefinition, AgentMcpAdapter } from "../../agent/defs";
import * as policies from "../../policy";
import { withMcpLifecycleLock } from "../../state/mcp-lifecycle-lock";
import type { McpBridgeEntry, SandboxEntry } from "../../state/registry";
import * as registry from "../../state/registry";
import {
  assertAgentMcpMutationRuntimeCapability,
  inspectAgentAdapterRegistration,
  registerAgentAdapter,
  unregisterAgentAdapter,
} from "./mcp-bridge-adapters";
import {
  isAgentMcpAdapter,
  MCP_BRIDGE_POLICY_SOURCE,
  type McpBridgeAddOptions,
  McpBridgeError,
  type McpBridgeStatus,
} from "./mcp-bridge-contracts";
import {
  applyGeneratedPolicy,
  assertGeneratedPolicyMutationSafe,
  buildMcpBridgePolicyKey,
  buildMcpBridgePolicyName,
  buildMcpBridgePolicyYaml,
  removeGeneratedPolicy,
} from "./mcp-bridge-policy";
import {
  assertNoAttachedProviderCredentialCollision,
  assertMcpProviderRecoverable,
  assertMcpTransportRuntimeCapability,
  attachProvider,
  deleteProvider,
  detachMissingProviderReference,
  detachProvider,
  inspectMcpProvider,
  type McpProviderInspection,
  preflightMcpEntryTargets,
  providerMatchesCredential,
  providerShapeDetail,
  removeMcpCredentialRevisionSnapshot,
  snapshotMcpCredentialRevision,
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
  removeBridgeEntry,
  setBridgeState,
  writeBridgeEntry,
} from "./mcp-bridge-state";
import { buildJsonSummary, statusMcpBridge } from "./mcp-bridge-status";
import {
  assertAuthenticatedBridgeEntry,
  assertAuthenticatedCredentialReference,
  buildMcpBridgeProviderName,
  normalizeMcpServerUrl,
  parseMcpAddArgs,
  resolveCredentialEnv,
  uniqueEnvNames,
  validateMcpServerName,
  validateMcpServerUrlResolvedTarget,
  validateSandboxName,
} from "./mcp-bridge-validation";

export {
  buildDeepAgentsMcpRegisterCommand,
  buildDeepAgentsMcpRemoveCommand,
  buildDeepAgentsMcpStatusCommand,
  buildHermesMcpExecArgs,
  buildHermesMcpProbeCommand,
  buildHermesMcpRegisterCommand,
  buildOpenClawMcporterInspectCommand,
  buildOpenClawMcporterRegisterCommand,
  buildOpenClawMcporterRemoveCommand,
  DEEPAGENTS_MCP_CONFIG_PATH,
  MCPORTER_VERSION,
  mcporterHeadersMatchExpected,
  parseAdapterRegistrationInspection,
} from "./mcp-bridge-adapters";
export type {
  McpBridgeAddOptions,
  McpBridgeStatus,
  ParsedEnvReference,
  ParsedMcpAddArgs,
} from "./mcp-bridge-contracts";
export { MCP_BRIDGE_POLICY_SOURCE, McpBridgeError } from "./mcp-bridge-contracts";
export {
  redactBridgeSecretsForDisplay,
  redactCredentialValuesForDisplay,
} from "./mcp-bridge-output";
export {
  buildMcpBridgePolicyName,
  buildMcpBridgePolicyYaml,
  MCP_BRIDGE_ALLOWED_METHODS,
  MCP_BRIDGE_POLICY_MAX_BODY_BYTES,
} from "./mcp-bridge-policy";
export {
  buildMcpBridgeProviderArgs,
  buildMcpCredentialReadinessCommand,
  buildMcpCredentialRevisionSnapshotCommand,
  detachMissingProviderReference,
  parseMcpProviderAttachmentNames,
  parseMcpProviderMetadata,
  providerDetachChangedState,
} from "./mcp-bridge-provider";
export { statusMcpBridge } from "./mcp-bridge-status";
export {
  buildMcpBridgeProviderName,
  MCP_SERVER_URL_MAX_LENGTH,
  normalizeMcpServerUrl,
  parseMcpAddArgs,
  resolveCredentialEnv,
  validateMcpCredentialEnvName,
  validateMcpServerName,
} from "./mcp-bridge-validation";

function sameMcpAddIntent(existing: McpBridgeEntry, requested: McpBridgeEntry): boolean {
  return (
    existing.server === requested.server &&
    existing.agent === requested.agent &&
    existing.adapter === requested.adapter &&
    existing.url === requested.url &&
    existing.providerName === requested.providerName &&
    existing.policyName === requested.policyName &&
    existing.env.length === requested.env.length &&
    existing.env.every((name, index) => name === requested.env[index])
  );
}

function assertMcpAdapterMutationRuntimeCapabilities(
  sandboxName: string,
  sandbox: SandboxEntry,
  entries: readonly McpBridgeEntry[],
): void {
  const adapters = new Set(
    entries.map((entry) =>
      isAgentMcpAdapter(entry.adapter) ? entry.adapter : getBridgeAdapter(getSandboxAgent(sandbox)),
    ),
  );
  for (const adapter of adapters) {
    assertAgentMcpMutationRuntimeCapability(sandboxName, adapter);
  }
}

function assertPreparedMcpAddResourcesAbsent(
  sandboxName: string,
  adapter: AgentMcpAdapter,
  entry: McpBridgeEntry,
  resolvedAddresses?: readonly string[],
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
    resolvedAddresses,
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
  return withMcpLifecycleLock(sandboxName, () => addMcpBridgeUnlocked(sandboxName, options));
}

async function addMcpBridgeUnlocked(
  sandboxName: string,
  options: McpBridgeAddOptions,
): Promise<void> {
  validateSandboxName(sandboxName);
  validateMcpServerName(options.server);
  assertAuthenticatedCredentialReference(options.env);
  const normalizedUrl = normalizeMcpServerUrl(options.url);
  const resolvedAddresses = await validateMcpServerUrlResolvedTarget(new URL(normalizedUrl));
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
  const policyName = buildMcpBridgePolicyName(options.server);
  assertNoDerivedResourceCollision(sandbox, options.server, providerName, policyName);
  const requestedEntry: McpBridgeEntry = {
    server: options.server,
    agent: agent.name,
    adapter,
    url: normalizedUrl,
    env: envNames,
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
    ? { ...existingEntry, env: [...existingEntry.env] }
    : requestedEntry;
  const resumingPreflightedAdd = existingEntry?.addState === "preflighted";
  // This is the durable ownership manifest for every resource created below.
  // It intentionally precedes gateway selection and all OpenShell mutations,
  // so process death can never leave an unowned provider/policy/adapter entry.
  if (!existingEntry) writeBridgeEntry(sandboxName, entry);

  let providerCreated = false;
  let providerAttachAttempted = false;
  let policyApplied = false;
  let adapterMutationAttempted = false;
  let credentialRevisionSnapshotPath: string | undefined;
  const adapterEnvValues = resolveCredentialEnv(options.env);
  try {
    await ensureSandboxGatewaySelected(sandboxName);
    assertMcpTransportRuntimeCapability(sandboxName);
    assertAgentMcpMutationRuntimeCapability(sandboxName, adapter);

    if (entry.addState === "prepared") {
      assertPreparedMcpAddResourcesAbsent(sandboxName, adapter, entry, resolvedAddresses);
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
    credentialRevisionSnapshotPath = snapshotMcpCredentialRevision(sandboxName, entry);
    const providerResult = upsertMcpProvider(providerName ?? "", options.env, {
      // A first mutation must still observe the absence proven above. Only a
      // retry of the durable preflighted transaction may encounter an exact
      // provider whose immutable ID was already persisted by this add.
      allowExisting: resumingPreflightedAdd,
      expectedProviderId: entry.providerId,
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
    assertNoAttachedProviderCredentialCollision(sandboxName, entry);
    applyGeneratedPolicy(sandboxName, entry, resolvedAddresses);
    policyApplied = true;
    providerAttachAttempted = true;
    attachProvider(sandboxName, entry);
    waitForAttachedMcpCredential(sandboxName, entry, {
      ...(providerResult.action === "updated"
        ? {
            previousRevisionSnapshotPath: credentialRevisionSnapshotPath,
          }
        : {}),
    });
    // The adapter was proven absent above, so cleanup is safe even when a
    // command commits config and then fails during its runtime reload.
    adapterMutationAttempted = true;
    registerAgentAdapter(sandboxName, adapter, entry, adapterEnvValues, {
      // An exact adapter entry is evidence of a post-commit process death.
      // Replacing it is idempotent and, for Hermes, re-verifies runtime reload.
      replaceExisting: resumingPreflightedAdd && adapterInspection.state === "registered",
    });
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
    if (policyApplied && reservationCleanupProved)
      removeGeneratedPolicy(sandboxName, entry, {
        bestEffort: true,
      });
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
  } finally {
    removeMcpCredentialRevisionSnapshot(sandboxName, credentialRevisionSnapshotPath);
  }
}

export async function restartMcpBridge(sandboxName: string, server?: string): Promise<void> {
  return withMcpLifecycleLock(sandboxName, () => restartMcpBridgeUnlocked(sandboxName, server));
}

async function restartMcpBridgeUnlocked(sandboxName: string, server?: string): Promise<void> {
  validateSandboxName(sandboxName);
  const sandbox = getSandboxOrThrow(sandboxName);
  assertMcpDestroyNotPending(sandbox);
  const agent = getSandboxAgent(sandbox);
  const adapter = getBridgeAdapter(agent);
  const bridges = bridgeState(sandbox);
  const targets = server ? [[server, bridges[server]] as const] : Object.entries(bridges);
  if (targets.length === 0) {
    console.log(`  No MCP servers for sandbox '${sandboxName}'.`);
    return;
  }
  for (const [name, entry] of targets) {
    if (!entry) {
      throw new McpBridgeError(`MCP server '${name}' not found on sandbox '${sandboxName}'.`);
    }
    if (entry.addState) {
      throw new McpBridgeError(
        `MCP server '${name}' has an incomplete add transaction (${entry.addState}). Re-run mcp add with the same URL and --env ${entry.env[0] ?? "KEY"}, or remove it with --force.`,
      );
    }
    assertAuthenticatedBridgeEntry(entry);
  }
  const targetEntries = targets
    .map(([, entry]) => entry)
    .filter((entry): entry is McpBridgeEntry => !!entry);
  const resolvedByServer = await preflightMcpEntryTargets(targetEntries);
  await ensureSandboxGatewaySelected(sandboxName);
  // Prove every policy key is absent or still matches its recorded ownership
  // before inspecting or updating any provider. `applyGeneratedPolicy` repeats
  // this check immediately before mutation to close the preflight-to-apply race.
  for (const entry of targetEntries) assertGeneratedPolicyMutationSafe(sandboxName, entry);
  const providerInspectionByServer = new Map<string, McpProviderInspection>();
  for (const entry of targetEntries) {
    providerInspectionByServer.set(entry.server, assertMcpProviderRecoverable(entry));
  }
  const missingProviderEntries = targetEntries.filter(
    (entry) => providerInspectionByServer.get(entry.server)?.exists === false,
  );
  // Detach every dangling name before asking the supervisor for a fresh exec.
  // Provider environment resolution can remain blocked while any missing name
  // is still present in the sandbox spec.
  for (const entry of missingProviderEntries) {
    detachMissingProviderReference(sandboxName, entry);
  }
  assertMcpTransportRuntimeCapability(sandboxName);
  assertMcpAdapterMutationRuntimeCapabilities(sandboxName, sandbox, targetEntries);
  for (const entry of missingProviderEntries) {
    waitForDetachedMcpCredential(sandboxName, entry);
  }
  for (const [name, storedEntry] of targets) {
    // Validated as a complete authenticated entry before gateway side effects.
    if (!storedEntry) continue;
    let entry = storedEntry;
    const envRefs = entry.env.map((envName) => ({ name: envName }));
    const adapterEnvValues = resolveCredentialEnv(envRefs);
    const resolvedAddresses = resolvedByServer.get(entry.server);
    let credentialRevisionSnapshotPath: string | undefined;
    try {
      if (providerInspectionByServer.get(entry.server)?.exists !== false) {
        credentialRevisionSnapshotPath = snapshotMcpCredentialRevision(sandboxName, entry);
      }
      const providerResult = upsertMcpProvider(entry.providerName ?? "", envRefs, {
        allowExisting: true,
        expectedProviderId: entry.providerId,
      });
      const providerId = providerResult.inspection.id;
      if (!providerId) {
        throw new McpBridgeError(
          `OpenShell did not return a stable provider ID for '${entry.providerName}'. Refusing later MCP side effects.`,
        );
      }
      const refreshedEntry =
        providerId === entry.providerId ? entry : { ...entry, providerId, updatedAt: nowIso() };
      if (refreshedEntry !== entry) {
        // A missing owned provider may be recreated during restart. Record the
        // replacement object's immutable ID before policy/attach/adapter work.
        writeBridgeEntry(sandboxName, refreshedEntry);
        entry = refreshedEntry;
      }
      assertNoAttachedProviderCredentialCollision(sandboxName, entry);
      applyGeneratedPolicy(sandboxName, entry, resolvedAddresses);
      attachProvider(sandboxName, entry);
      waitForAttachedMcpCredential(sandboxName, entry, {
        ...(providerResult.action === "updated"
          ? { previousRevisionSnapshotPath: credentialRevisionSnapshotPath }
          : {}),
      });
      registerAgentAdapter(
        sandboxName,
        (entry.adapter as AgentMcpAdapter | undefined) ?? adapter,
        entry,
        adapterEnvValues,
        { replaceExisting: true },
      );
    } finally {
      removeMcpCredentialRevisionSnapshot(sandboxName, credentialRevisionSnapshotPath);
    }
    writeBridgeEntry(sandboxName, {
      ...entry,
      adapter: (entry.adapter as AgentMcpAdapter | undefined) ?? adapter,
      updatedAt: nowIso(),
    });
    console.log(`  Refreshed MCP server '${name}'.`);
  }
}

export interface McpDestroyPreparation {
  entries: McpBridgeEntry[];
  detachedProviderEntries: McpBridgeEntry[];
  scrubbedAdapterEntries: McpBridgeEntry[];
  /** True when phase one was completed by an earlier destroy process. */
  destroyAlreadyPrepared: boolean;
  /** True when a previous destroy already confirmed the sandbox was absent. */
  destroyAlreadyPending: boolean;
}

function cloneMcpBridgeEntry(entry: McpBridgeEntry): McpBridgeEntry {
  return { ...entry, env: [...entry.env] };
}

function mcpBridgeEntriesEqual(left: McpBridgeEntry, right: McpBridgeEntry): boolean {
  return (
    left.server === right.server &&
    left.agent === right.agent &&
    left.adapter === right.adapter &&
    left.url === right.url &&
    left.providerName === right.providerName &&
    left.providerId === right.providerId &&
    left.policyName === right.policyName &&
    left.addedAt === right.addedAt &&
    left.updatedAt === right.updatedAt &&
    left.addState === right.addState &&
    left.env.length === right.env.length &&
    left.env.every((name, index) => name === right.env[index])
  );
}

function discardPreparedMcpAddsBeforeDestroy(
  sandboxName: string,
  sandbox: SandboxEntry,
): SandboxEntry {
  const bridges = bridgeState(sandbox);
  const remaining = Object.fromEntries(
    Object.entries(bridges).filter(([, entry]) => entry.addState !== "prepared"),
  );
  if (Object.keys(remaining).length === Object.keys(bridges).length) {
    return sandbox;
  }
  // A prepared add precedes all external side effects, so destroy must drop
  // only its local manifest and must not inspect/delete same-name global state.
  setBridgeState(sandboxName, remaining);
  return getSandboxOrThrow(sandboxName);
}

function assertMcpDestroySnapshotCurrent(
  sandboxName: string,
  entries: readonly McpBridgeEntry[],
): SandboxEntry {
  const sandbox = getSandboxOrThrow(sandboxName);
  const current = bridgeState(sandbox);
  const expectedServers = new Set(entries.map((entry) => entry.server));
  if (
    Object.keys(current).length !== expectedServers.size ||
    entries.some(
      (entry) => !current[entry.server] || !mcpBridgeEntriesEqual(current[entry.server], entry),
    )
  ) {
    throw new McpBridgeError(
      `MCP bridge definitions changed while sandbox '${sandboxName}' was being destroyed. Cleanup state was preserved; re-run destroy to reconcile the current definitions.`,
    );
  }
  return sandbox;
}

function inspectExactMcpDestroyProvider(
  entry: McpBridgeEntry,
  options: { allowMissing: boolean; force?: boolean },
): McpProviderInspection {
  assertAuthenticatedBridgeEntry(entry);
  if (!entry.providerId) {
    throw new McpBridgeError(
      `MCP server '${entry.server}' has no stable OpenShell provider ID. Refusing destructive cleanup of same-name provider '${entry.providerName}'. Remove the legacy bridge with --force only after independently cleaning that provider.`,
    );
  }
  const inspection = inspectMcpProvider(entry.providerName);
  if (inspection.exists === null) {
    throw new McpBridgeError(
      inspection.error ?? `Could not inspect OpenShell provider '${entry.providerName}'.`,
    );
  }
  if (!inspection.exists) {
    if (options.allowMissing) return inspection;
    throw new McpBridgeError(
      `OpenShell provider '${entry.providerName}' is missing. Refusing to destroy sandbox state because a failed sandbox delete could not restore authenticated MCP without the preserved provider credential.`,
    );
  }
  if (!providerMatchesCredential(inspection, entry.env[0], entry.providerId)) {
    const forceDetail = options.force
      ? " --force does not delete a non-matching global provider because it may be owned by another workflow."
      : "";
    throw new McpBridgeError(
      `OpenShell provider '${entry.providerName}' no longer exactly matches MCP server '${entry.server}'. ${providerShapeDetail(inspection, entry.env[0], entry.providerId)}${forceDetail}`,
    );
  }
  return inspection;
}

/**
 * Build the cleanup manifest when a gateway-pinned `sandbox list` has already
 * proved the sandbox is absent. No sandbox exec/adapter mutation is possible
 * in this branch; the current provider ID/type/key metadata must still match
 * the registry before delete confirmation and final cleanup.
 */
export async function prepareMcpBridgesForAbsentSandboxDestroy(
  sandboxName: string,
  options: { force?: boolean } = {},
): Promise<McpDestroyPreparation> {
  validateSandboxName(sandboxName);
  const sandbox = discardPreparedMcpAddsBeforeDestroy(sandboxName, getSandboxOrThrow(sandboxName));
  const entries = Object.values(bridgeState(sandbox)).map(cloneMcpBridgeEntry);
  const destroyAlreadyPrepared = !!sandbox.mcp?.destroyPreparedAt;
  const destroyAlreadyPending = !!sandbox.mcp?.destroyPendingAt;
  for (const entry of entries) {
    // Missing providers are already converged once the sandbox is confirmed
    // absent. Existing providers must still match exactly, including in force
    // mode, so this path cannot delete another workflow's credential.
    inspectExactMcpDestroyProvider(entry, {
      allowMissing: true,
      force: options.force,
    });
  }
  return {
    entries,
    detachedProviderEntries: [],
    scrubbedAdapterEntries: [],
    destroyAlreadyPrepared,
    destroyAlreadyPending,
  };
}

/**
 * Phase one of sandbox destroy. Remove the adapter entry from the retained
 * sandbox volume and detach exact MCP providers while preserving the global
 * provider objects (and therefore their host-only credentials), generated
 * policy, and registry cleanup manifest. Any failure restores adapter and
 * attachment state before returning.
 */
export async function prepareMcpBridgesForDestroy(
  sandboxName: string,
): Promise<McpDestroyPreparation> {
  validateSandboxName(sandboxName);
  const sandbox = discardPreparedMcpAddsBeforeDestroy(sandboxName, getSandboxOrThrow(sandboxName));
  const entries = Object.values(bridgeState(sandbox)).map(cloneMcpBridgeEntry);
  const destroyAlreadyPrepared = !!sandbox.mcp?.destroyPreparedAt;
  const destroyAlreadyPending = !!sandbox.mcp?.destroyPendingAt;
  const incompleteAdd = entries.find((entry) => entry.addState === "preflighted");
  if (incompleteAdd) {
    throw new McpBridgeError(
      `MCP server '${incompleteAdd.server}' has an incomplete add transaction. Re-run the original mcp add command or remove it with --force before destroying the live sandbox.`,
    );
  }
  if (entries.length === 0) {
    return {
      entries: [],
      detachedProviderEntries: [],
      scrubbedAdapterEntries: [],
      destroyAlreadyPrepared,
      destroyAlreadyPending,
    };
  }

  // A pending marker is written only after OpenShell confirmed deletion. On
  // retry, a provider may therefore already be absent due to partial cleanup;
  // the retained entries are the durable, idempotent cleanup manifest.
  for (const entry of entries) {
    inspectExactMcpDestroyProvider(entry, {
      allowMissing: destroyAlreadyPending,
    });
  }
  if (destroyAlreadyPending) {
    return {
      entries,
      detachedProviderEntries: [],
      scrubbedAdapterEntries: [],
      destroyAlreadyPrepared,
      destroyAlreadyPending: true,
    };
  }
  if (destroyAlreadyPrepared) {
    // Phase one completed before a prior process stopped. The sandbox may be
    // live with its adapter scrubbed/provider detached, or it may already be
    // gone. In either case, repeating delete is the next idempotent step.
    return {
      entries,
      detachedProviderEntries: entries.map(cloneMcpBridgeEntry),
      scrubbedAdapterEntries: entries.map(cloneMcpBridgeEntry),
      destroyAlreadyPrepared: true,
      destroyAlreadyPending: false,
    };
  }

  await ensureSandboxGatewaySelected(sandboxName);
  assertMcpTransportRuntimeCapability(sandboxName);
  assertMcpAdapterMutationRuntimeCapabilities(sandboxName, sandbox, entries);
  const detached: McpBridgeEntry[] = [];
  const scrubbedAdapters: McpBridgeEntry[] = [];
  try {
    for (const entry of entries) {
      const adapter = isAgentMcpAdapter(entry.adapter)
        ? entry.adapter
        : getBridgeAdapter(getSandboxAgent(sandbox));
      unregisterAgentAdapter(sandboxName, adapter, entry, {
        envValues: {},
      });
      scrubbedAdapters.push(entry);
    }
    for (const entry of entries) {
      inspectExactMcpDestroyProvider(entry, { allowMissing: false });
      const detachOutcome = detachProvider(sandboxName, entry);
      if (detachOutcome === "unknown") {
        throw new McpBridgeError(
          `Could not prove provider detach for MCP server '${entry.server}'.`,
        );
      }
      waitForDetachedMcpCredential(sandboxName, entry);
      // Both an acknowledged detach and a freshly-proven absent binding are
      // rollback responsibilities until destroyPreparedAt is durable. This
      // closes retry-after-process-death gaps where an earlier attempt already
      // detached one entry before a later entry fails.
      detached.push(entry);
    }
    const marked = registry.updateSandbox(sandboxName, {
      mcp: {
        bridges: Object.fromEntries(
          entries.map((entry) => [entry.server, cloneMcpBridgeEntry(entry)]),
        ),
        destroyPreparedAt: nowIso(),
      },
    });
    if (!marked) {
      throw new McpBridgeError(
        `Could not persist prepared MCP destroy state for sandbox '${sandboxName}'.`,
      );
    }
  } catch (error) {
    const rollbackFailures: string[] = [];
    for (const entry of [...detached].reverse()) {
      try {
        inspectExactMcpDestroyProvider(entry, { allowMissing: false });
        attachProvider(sandboxName, entry);
        // Reattach preserves the provider value, so presence is sufficient;
        // still wait before reloading an adapter that may connect immediately.
        waitForAttachedMcpCredential(sandboxName, entry);
      } catch (rollbackError) {
        rollbackFailures.push(
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        );
      }
    }
    for (const entry of scrubbedAdapters) {
      try {
        const adapter = isAgentMcpAdapter(entry.adapter)
          ? entry.adapter
          : getBridgeAdapter(getSandboxAgent(sandbox));
        registerAgentAdapter(
          sandboxName,
          adapter,
          entry,
          {},
          {
            replaceExisting: true,
          },
        );
      } catch (rollbackError) {
        rollbackFailures.push(
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        );
      }
    }
    const current = registry.getSandbox(sandboxName);
    if (current?.mcp?.destroyPreparedAt) {
      try {
        registry.updateSandbox(sandboxName, {
          mcp: {
            bridges: Object.fromEntries(
              entries.map((entry) => [entry.server, cloneMcpBridgeEntry(entry)]),
            ),
          },
        });
      } catch (rollbackError) {
        rollbackFailures.push(
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        );
      }
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new McpBridgeError(
      rollbackFailures.length > 0
        ? `${detail}\nMCP destroy rollback could not reattach: ${rollbackFailures.join("; ")}`
        : detail,
    );
  }
  return {
    entries,
    detachedProviderEntries: detached,
    scrubbedAdapterEntries: scrubbedAdapters,
    destroyAlreadyPrepared: false,
    destroyAlreadyPending: false,
  };
}

/** Restore all MCP runtime state after OpenShell refused to delete the sandbox. */
export async function restoreMcpBridgesAfterDestroyAbort(
  sandboxName: string,
  preparation: McpDestroyPreparation,
): Promise<void> {
  if (preparation.entries.length === 0 || preparation.destroyAlreadyPending) {
    return;
  }
  assertMcpDestroySnapshotCurrent(sandboxName, preparation.entries);
  const cleared = registry.updateSandbox(sandboxName, {
    mcp: {
      bridges: Object.fromEntries(
        preparation.entries.map((entry) => [entry.server, cloneMcpBridgeEntry(entry)]),
      ),
    },
  });
  if (!cleared) {
    throw new McpBridgeError(
      `Could not clear prepared MCP destroy state for sandbox '${sandboxName}' before runtime restoration.`,
    );
  }
  // Exact providers were required before phase one. Reusing them does not
  // require the host secret environment variable: OpenShell retains the
  // credential and restart writes only the placeholder into agent config.
  for (const entry of preparation.entries) {
    inspectExactMcpDestroyProvider(entry, { allowMissing: false });
  }
  await restartMcpBridge(sandboxName);
}

/**
 * Phase two of sandbox destroy, called only after OpenShell confirmed the
 * sandbox is gone. Delete exact matching global providers, then clear the MCP
 * bridge manifest and owned custom-policy records in one registry update.
 */
export async function finalizeMcpBridgesAfterSandboxDelete(
  sandboxName: string,
  preparation: McpDestroyPreparation,
  options: { force?: boolean } = {},
): Promise<void> {
  const entries = preparation.entries;
  if (entries.length === 0) return;

  await ensureSandboxGatewaySelected(sandboxName);

  const sandbox = assertMcpDestroySnapshotCurrent(sandboxName, entries);
  if (!sandbox.mcp?.destroyPendingAt) {
    const marked = registry.updateSandbox(sandboxName, {
      mcp: {
        bridges: Object.fromEntries(
          entries.map((entry) => [entry.server, cloneMcpBridgeEntry(entry)]),
        ),
        destroyPendingAt: nowIso(),
      },
    });
    if (!marked) {
      throw new McpBridgeError(
        `Could not persist MCP destroy cleanup state for sandbox '${sandboxName}'. No MCP providers were deleted.`,
      );
    }
    assertMcpDestroySnapshotCurrent(sandboxName, entries);
  }

  // Inspect every provider before deleting any so ownership drift cannot
  // produce a predictable partial cleanup. Missing is safe only now that the
  // durable pending marker proves the sandbox was already deleted.
  const inspections = entries.map((entry) =>
    inspectExactMcpDestroyProvider(entry, {
      allowMissing: true,
      force: options.force,
    }),
  );
  for (const [index, entry] of entries.entries()) {
    if (!inspections[index]?.exists) continue;
    const beforeDelete = inspectExactMcpDestroyProvider(entry, {
      allowMissing: true,
      force: options.force,
    });
    if (!beforeDelete.exists) continue;
    deleteProvider(entry, { allowMissing: true });
    const after = inspectMcpProvider(entry.providerName);
    if (after.exists !== false) {
      throw new McpBridgeError(
        after.error ??
          `OpenShell provider '${entry.providerName}' still exists after delete. MCP cleanup state was preserved for retry.`,
      );
    }
  }

  const finalSandbox = assertMcpDestroySnapshotCurrent(sandboxName, entries);
  const ownedPolicyNames = new Set(entries.map((entry) => entry.policyName));
  const remainingCustomPolicies = (finalSandbox.customPolicies ?? []).filter(
    (policy) =>
      !(ownedPolicyNames.has(policy.name) && policy.sourcePath === MCP_BRIDGE_POLICY_SOURCE),
  );
  const cleared = registry.updateSandbox(sandboxName, {
    mcp: undefined,
    customPolicies: remainingCustomPolicies.length > 0 ? remainingCustomPolicies : undefined,
  });
  if (!cleared) {
    throw new McpBridgeError(
      `MCP providers were deleted, but cleanup state for sandbox '${sandboxName}' could not be cleared. Re-run destroy; missing providers are accepted while cleanup is pending.`,
    );
  }
}

export interface McpRebuildPreparation {
  entries: McpBridgeEntry[];
  detachedProviderEntries: McpBridgeEntry[];
  scrubbedAdapterEntries: McpBridgeEntry[];
}

function getCompleteMcpRebuildEntries(sandboxName: string): McpBridgeEntry[] {
  validateSandboxName(sandboxName);
  const sandbox = getSandboxOrThrow(sandboxName);
  const entries = Object.values(bridgeState(sandbox)).map(cloneMcpBridgeEntry);
  const incompleteAdd = entries.find((entry) => entry.addState);
  if (incompleteAdd) {
    throw new McpBridgeError(
      `MCP server '${incompleteAdd.server}' has an incomplete add transaction (${incompleteAdd.addState}). Re-run the original mcp add command or remove it with --force before rebuilding the sandbox.`,
    );
  }
  return entries;
}

/**
 * Preserve MCP intent for stale-registry recovery after OpenShell has already
 * proved the sandbox absent. There is no sandbox process or retained adapter
 * to scrub, so this path validates targets and provider recoverability without
 * attempting sandbox exec or changing provider attachment state.
 */
export async function prepareMcpBridgesForAbsentSandboxRebuild(
  sandboxName: string,
): Promise<McpRebuildPreparation> {
  const entries = getCompleteMcpRebuildEntries(sandboxName);
  if (entries.length === 0) {
    return {
      entries: [],
      detachedProviderEntries: [],
      scrubbedAdapterEntries: [],
    };
  }
  await preflightMcpEntryTargets(entries);
  await ensureSandboxGatewaySelected(sandboxName);
  for (const entry of entries) assertMcpProviderRecoverable(entry);
  return {
    entries,
    detachedProviderEntries: [],
    scrubbedAdapterEntries: [],
  };
}

export async function prepareMcpBridgesForRebuild(
  sandboxName: string,
): Promise<McpRebuildPreparation> {
  const sandbox = getSandboxOrThrow(sandboxName);
  const entries = getCompleteMcpRebuildEntries(sandboxName);
  if (entries.length === 0) {
    return {
      entries: [],
      detachedProviderEntries: [],
      scrubbedAdapterEntries: [],
    };
  }
  await preflightMcpEntryTargets(entries);
  await ensureSandboxGatewaySelected(sandboxName);
  assertMcpTransportRuntimeCapability(sandboxName);
  assertMcpAdapterMutationRuntimeCapabilities(sandboxName, sandbox, entries);
  for (const entry of entries) assertMcpProviderRecoverable(entry);
  const detached: McpBridgeEntry[] = [];
  const scrubbedAdapters: McpBridgeEntry[] = [];
  try {
    for (const entry of entries) {
      const adapter = isAgentMcpAdapter(entry.adapter)
        ? entry.adapter
        : getBridgeAdapter(getSandboxAgent(sandbox));
      // `/sandbox` may be a retained PVC. Scrub before delete so a replacement
      // Hermes/agent cannot boot with a stale placeholder while its provider
      // is intentionally detached during recreate.
      unregisterAgentAdapter(sandboxName, adapter, entry, { envValues: {} });
      scrubbedAdapters.push(entry);
    }
    for (const entry of entries) {
      // Keep the provider and its host-only credentials for the replacement
      // sandbox, but detach it before OpenShell deletes the old attachment.
      inspectExactMcpDestroyProvider(entry, { allowMissing: false });
      const detachOutcome = detachProvider(sandboxName, entry);
      if (detachOutcome === "unknown") {
        throw new McpBridgeError(
          `Could not prove provider detach for MCP server '${entry.server}'.`,
        );
      }
      waitForDetachedMcpCredential(sandboxName, entry);
      // A binding already absent on retry was still detached by this rebuild
      // transaction (possibly before a prior process died), so it must be
      // reattached if sandbox deletion later aborts.
      detached.push(entry);
    }
  } catch (error) {
    const rollbackFailures: string[] = [];
    for (const entry of detached.reverse()) {
      try {
        inspectExactMcpDestroyProvider(entry, { allowMissing: false });
        attachProvider(sandboxName, entry);
        // Reattach preserves the provider value, so presence is sufficient;
        // still wait before reloading an adapter that may connect immediately.
        waitForAttachedMcpCredential(sandboxName, entry);
      } catch (rollbackError) {
        rollbackFailures.push(
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        );
      }
    }
    for (const entry of scrubbedAdapters) {
      try {
        const adapter = isAgentMcpAdapter(entry.adapter)
          ? entry.adapter
          : getBridgeAdapter(getSandboxAgent(sandbox));
        registerAgentAdapter(
          sandboxName,
          adapter,
          entry,
          {},
          {
            replaceExisting: true,
          },
        );
      } catch (rollbackError) {
        rollbackFailures.push(
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        );
      }
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new McpBridgeError(
      rollbackFailures.length > 0
        ? `${detail}\nMCP rebuild rollback could not reattach: ${rollbackFailures.join("; ")}`
        : detail,
    );
  }
  return {
    entries,
    detachedProviderEntries: detached,
    scrubbedAdapterEntries: scrubbedAdapters,
  };
}

export async function reattachMcpProvidersAfterRebuildAbort(
  sandboxName: string,
  entries: readonly McpBridgeEntry[],
  scrubbedAdapterEntries: readonly McpBridgeEntry[] = [],
): Promise<void> {
  if (entries.length === 0 && scrubbedAdapterEntries.length === 0) return;
  await ensureSandboxGatewaySelected(sandboxName);
  assertMcpTransportRuntimeCapability(sandboxName);
  const sandbox = getSandboxOrThrow(sandboxName);
  assertMcpAdapterMutationRuntimeCapabilities(sandboxName, sandbox, [
    ...entries,
    ...scrubbedAdapterEntries,
  ]);

  const failures: string[] = [];
  for (const entry of entries) {
    try {
      // Rebuild abort helpers are exported and may run after a long sandbox
      // delete attempt; re-prove the immutable provider identity immediately
      // before reattaching by its mutable name.
      assertMcpProviderRecoverable(entry);
      attachProvider(sandboxName, entry);
      waitForAttachedMcpCredential(sandboxName, entry);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  for (const entry of scrubbedAdapterEntries) {
    try {
      const adapter = isAgentMcpAdapter(entry.adapter)
        ? entry.adapter
        : getBridgeAdapter(getSandboxAgent(sandbox));
      registerAgentAdapter(
        sandboxName,
        adapter,
        entry,
        {},
        {
          replaceExisting: true,
        },
      );
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (failures.length > 0) {
    throw new McpBridgeError(failures.join("; "));
  }
}

export async function restoreMcpBridgesAfterRebuild(
  sandboxName: string,
  entries: readonly McpBridgeEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  for (const entry of entries) assertAuthenticatedBridgeEntry(entry);
  const bridges = Object.fromEntries(
    entries.map((entry) => [entry.server, { ...entry, env: [...entry.env] }]),
  );
  // Persist the recovery contract before touching the gateway. If refresh
  // fails, `mcp restart` remains retryable after the operator fixes the cause.
  setBridgeState(sandboxName, bridges);
  await restartMcpBridge(sandboxName);
}

export async function removeMcpBridge(
  sandboxName: string,
  server: string,
  options: { force?: boolean; allowResidual?: boolean } = {},
): Promise<void> {
  return withMcpLifecycleLock(sandboxName, () =>
    removeMcpBridgeUnlocked(sandboxName, server, options),
  );
}

async function removeMcpBridgeUnlocked(
  sandboxName: string,
  server: string,
  options: { force?: boolean; allowResidual?: boolean } = {},
): Promise<void> {
  validateSandboxName(sandboxName);
  validateMcpServerName(server);
  const sandbox = getSandboxOrThrow(sandboxName);
  assertMcpDestroyNotPending(sandbox);
  const entry = bridgeState(sandbox)[server];
  if (!entry) {
    if (!options.force) {
      throw new McpBridgeError(`MCP server '${server}' not found on sandbox '${sandboxName}'.`);
    }
    console.log(`  No MCP server '${server}' is registered on sandbox '${sandboxName}'.`);
    return;
  }
  if (entry.addState === "prepared") {
    // `prepared` is persisted before gateway selection and is advanced only
    // after adapter/provider/policy absence has been proven. It therefore owns
    // no external resources and can be cancelled without touching same-name
    // state another workflow may own.
    removeBridgeEntry(sandboxName, server);
    console.log(`  Cancelled incomplete MCP add for '${server}' on sandbox '${sandboxName}'.`);
    return;
  }
  // Cleanup follows the adapter persisted with the bridge. Requiring the
  // sandbox's current agent to still advertise MCP support would strand old
  // resources after an agent/capability migration.
  const adapter = isAgentMcpAdapter(entry.adapter)
    ? entry.adapter
    : getBridgeAdapter(getSandboxAgent(sandbox));
  await ensureSandboxGatewaySelected(sandboxName);
  assertGeneratedPolicyMutationSafe(sandboxName, entry);
  const failures: string[] = [];
  let providerOwnershipProved = !entry.providerName;
  let providerWasMissing = false;
  if (entry.providerName) {
    if (!entry.providerId) {
      const inspection = inspectMcpProvider(entry.providerName);
      if (inspection.exists === false) {
        // With no live provider there is no global object to adopt or destroy.
        // This lets an operator independently remove a legacy/orphan provider,
        // then use MCP remove to clear only the exact adapter/policy manifest.
        providerOwnershipProved = true;
        providerWasMissing = true;
      } else {
        const detail =
          inspection.exists === null
            ? (inspection.error ?? `Could not inspect OpenShell provider '${entry.providerName}'.`)
            : `MCP server '${entry.server}' has no stable OpenShell provider ID. Refusing to detach or delete same-name provider '${entry.providerName}'.`;
        if (!options.force) throw new McpBridgeError(detail);
        failures.push(detail);
      }
    } else {
      const inspection = inspectMcpProvider(entry.providerName);
      if (inspection.exists === false) {
        providerOwnershipProved = true;
        providerWasMissing = true;
      } else if (
        inspection.exists === true &&
        entry.env.length === 1 &&
        providerMatchesCredential(inspection, entry.env[0], entry.providerId)
      ) {
        providerOwnershipProved = true;
      } else {
        const detail =
          inspection.exists === null
            ? (inspection.error ?? `Could not inspect OpenShell provider '${entry.providerName}'.`)
            : `OpenShell provider '${entry.providerName}' has drifted or lacks a complete registered credential binding. ${providerShapeDetail(inspection, entry.env[0], entry.providerId) ?? ""}`;
        if (!options.force) {
          throw new McpBridgeError(detail);
        }
        // Force is allowed to continue cleaning resources whose ownership is
        // independently provable, but it never broadens ownership of a global
        // provider merely because the local bridge registry names it.
        failures.push(detail);
      }
    }
  }

  let missingProviderReferenceDetached = false;
  if (providerWasMissing && providerOwnershipProved && entry.providerName) {
    try {
      detachMissingProviderReference(sandboxName, entry);
      missingProviderReferenceDetached = true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (!options.force) throw new McpBridgeError(detail);
      failures.push(detail);
    }
  }

  // A dangling provider name can prevent fresh sandbox execs on OpenShell
  // main, so clear that host-side spec reference before probing or mutating the
  // in-sandbox adapter.
  assertMcpTransportRuntimeCapability(sandboxName);
  assertAgentMcpMutationRuntimeCapability(sandboxName, adapter);

  const adapterEnvValues = resolveCredentialEnv(entry.env.map((envName) => ({ name: envName })));
  let adapterCleanupProved = true;
  try {
    unregisterAgentAdapter(
      sandboxName,
      (entry.adapter as AgentMcpAdapter | undefined) ?? adapter,
      entry,
      { force: options.force === true, envValues: adapterEnvValues },
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (!options.force) throw new McpBridgeError(detail);
    adapterCleanupProved = false;
    failures.push(detail);
  }
  let reservationCleanupProved = !entry.providerName && adapterCleanupProved;
  if (adapterCleanupProved && providerOwnershipProved && entry.providerName) {
    try {
      // OpenShell main cannot list a sandbox whose spec references a missing
      // provider. Remove that dangling name directly before using the normal
      // table-backed detach path for a provider that still exists.
      const detachOutcome = providerWasMissing
        ? missingProviderReferenceDetached
          ? "detached"
          : "unknown"
        : detachProvider(sandboxName, entry);
      if (detachOutcome !== "unknown") {
        // A missing provider has no credential left to revoke. Its stock CLI
        // detach result is authoritative for the sandbox-spec reference, and
        // skipping a fresh-exec probe lets cleanup proceed even if another
        // unrelated provider reference is also dangling.
        if (!providerWasMissing) waitForDetachedMcpCredential(sandboxName, entry);
        reservationCleanupProved = true;
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (!options.force) throw new McpBridgeError(detail);
      failures.push(detail);
    }
  }
  if (reservationCleanupProved) {
    try {
      removeGeneratedPolicy(sandboxName, entry);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (!options.force) throw new McpBridgeError(detail);
      failures.push(detail);
    }
  } else {
    failures.push(
      `Provider detach state for '${entry.providerName}' is unknown; preserved the MCP policy and ownership manifest.`,
    );
  }
  if (
    reservationCleanupProved &&
    providerOwnershipProved &&
    !providerWasMissing &&
    entry.providerName
  ) {
    try {
      // Recheck immediately before the mutable-name delete to narrow the
      // replacement window. OpenShell main does not expose an atomic
      // identity-conditioned delete, so concurrent direct provider mutation
      // remains outside this lifecycle command's safety boundary.
      inspectExactMcpDestroyProvider(entry, {
        allowMissing: false,
        force: options.force,
      });
      deleteProvider(entry, {
        allowMissing: options.force === true || entry.addState === "preflighted",
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (!options.force) throw new McpBridgeError(detail);
      failures.push(detail);
    }
  }
  if (failures.length > 0) {
    console.warn(`  MCP force cleanup warnings:\n${failures.join("\n")}`);
    if (!options.allowResidual) {
      throw new McpBridgeError(
        `MCP force cleanup left residual resources for '${server}'. The registry entry was preserved so cleanup can be retried.`,
      );
    }
    return;
  }
  removeBridgeEntry(sandboxName, server);
  console.log(`  Removed MCP server '${server}' from sandbox '${sandboxName}'.`);
}

function renderList(
  sandboxName: string,
  statuses: McpBridgeStatus[],
  agent: AgentDefinition,
): void {
  console.log("");
  if (agent.mcpCapability.support !== "bridge") {
    console.log(`  MCP support: disabled for ${agent.displayName}`);
    if (agent.mcpCapability.reason) console.log(`  ${agent.mcpCapability.reason}`);
  }
  if (statuses.length === 0) {
    console.log(`  No MCP servers for sandbox '${sandboxName}'.`);
    console.log("");
    return;
  }
  console.log(`  MCP servers for sandbox '${sandboxName}':`);
  for (const status of statuses) {
    const policy = status.policy.gatewayPresent ? "policy" : "policy?";
    const provider =
      status.provider.registryPresent &&
      status.provider.gatewayPresent &&
      status.provider.attached === true &&
      status.provider.credentialReady === true
        ? "provider"
        : "provider?";
    const env = status.env.names.length > 0 ? status.env.names.join(", ") : "(none)";
    console.log(
      `    ${status.server.padEnd(18)} ${policy.padEnd(8)} ${provider.padEnd(10)} env: ${env}${status.addState ? `  add:${status.addState}` : ""}`,
    );
  }
  console.log("");
}

function renderStatus(
  sandboxName: string,
  statuses: McpBridgeStatus[],
  agent: AgentDefinition,
): void {
  if (statuses.length === 0) {
    console.log("");
    console.log(`  MCP servers for sandbox '${sandboxName}': none`);
    console.log(`    agent: ${agent.name}`);
    console.log(`    support: ${agent.mcpCapability.support}`);
    if (agent.mcpCapability.reason) console.log(`    reason: ${agent.mcpCapability.reason}`);
    console.log("");
    return;
  }
  for (const status of statuses) {
    console.log("");
    console.log(`  MCP server: ${status.server}`);
    console.log(`    agent: ${status.agent}`);
    console.log(`    support: ${status.support.mode}`);
    if (status.support.reason) console.log(`    reason: ${status.support.reason}`);
    if (status.url) console.log(`    endpoint: ${status.url}`);
    if (status.addState) console.log(`    add transaction: incomplete (${status.addState})`);
    console.log(
      `    provider: ${status.provider.registryPresent ? status.provider.name : "(none)"}`,
    );
    console.log(
      `    provider attached: ${status.provider.attached === null ? "unknown" : status.provider.attached ? "yes" : "no"}`,
    );
    console.log(
      `    provider credentials: ${status.provider.credentialReady === null ? "unknown" : status.provider.credentialReady ? "ready" : "drifted or missing"}`,
    );
    if (status.provider.detail) console.log(`    provider detail: ${status.provider.detail}`);
    console.log(
      `    policy: ${status.policy.gatewayPresent === null ? "unknown" : status.policy.gatewayPresent ? "present" : "missing"}`,
    );
    console.log(
      `    adapter: ${status.adapter.registered === null ? "unknown" : status.adapter.registered ? "registered" : "missing"}`,
    );
    console.log(
      `    env: ${status.env.ready ? "ready" : status.env.missing.length > 0 ? `missing ${status.env.missing.join(", ")}` : "not ready"}`,
    );
  }
  console.log("");
}

function parseJsonFlag(args: string[]): { json: boolean; rest: string[] } {
  return {
    json: args.includes("--json"),
    rest: args.filter((arg) => arg !== "--json"),
  };
}

function requireNoExtraArgs(args: string[], usage: string): void {
  if (args.length > 0) throw new McpBridgeError(usage, 2);
}

function requireAtMostOneArg(args: string[], usage: string): string | undefined {
  if (args.length > 1) throw new McpBridgeError(usage, 2);
  return args[0];
}

function hasHelpFlag(args: readonly string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

function renderMcpHelp(subcommand: string): void {
  switch (subcommand) {
    case "add":
      console.log(`USAGE
  nemoclaw <name> mcp add <server> --url <https-mcp-url> --env KEY

FLAGS
  --url URL        MCP Streamable HTTP endpoint
  --env KEY        Required host credential reference registered with OpenShell

SECURITY
  Credentials are registered as an OpenShell provider and appear inside the
  sandbox only as openshell:resolve:env:KEY placeholders. OpenShell resolves
  them at egress while enforcing the generated protocol: mcp policy.`);
      return;
    case "list":
      console.log(`USAGE
  nemoclaw <name> mcp list [--json]

FLAGS
  --json  Emit sandbox, support, and MCP server state as JSON`);
      return;
    case "status":
      console.log(`USAGE
  nemoclaw <name> mcp status [server] [--json]

FLAGS
  --json  Emit MCP server status as JSON`);
      return;
    case "restart":
      console.log(`USAGE
  nemoclaw <name> mcp restart [server]`);
      return;
    case "remove":
      console.log(`USAGE
  nemoclaw <name> mcp remove <server> [--force]

FLAGS
  --force  Best-effort owned cleanup; preserves registry state when residuals remain`);
      return;
    default:
      console.log(`USAGE
  nemoclaw <name> mcp <add|list|status|restart|remove> [args...]`);
  }
}

export async function dispatchMcpBridgeCommand(
  sandboxName: string,
  actionArgs: string[],
): Promise<void> {
  const [subcommand = "list", ...rest] = actionArgs;
  try {
    if (subcommand === "--help" || subcommand === "-h") {
      renderMcpHelp("mcp");
      return;
    }
    if (hasHelpFlag(rest)) {
      renderMcpHelp(subcommand);
      return;
    }
    switch (subcommand) {
      case "add": {
        const options = parseMcpAddArgs(rest);
        await addMcpBridge(sandboxName, options);
        console.log(`  MCP server '${options.server}' added to sandbox '${sandboxName}'.`);
        return;
      }
      case "list": {
        const { json, rest: listRest } = parseJsonFlag(rest);
        requireNoExtraArgs(listRest, "Usage: nemoclaw <sandbox> mcp list [--json]");
        const sandbox = getSandboxOrThrow(sandboxName);
        const agent = getSandboxAgent(sandbox);
        const statuses = await statusMcpBridge(sandboxName);
        if (json)
          console.log(JSON.stringify(buildJsonSummary(sandboxName, agent, statuses), null, 2));
        else renderList(sandboxName, statuses, agent);
        return;
      }
      case "status": {
        const { json, rest: statusRest } = parseJsonFlag(rest);
        const server = requireAtMostOneArg(
          statusRest,
          "Usage: nemoclaw <sandbox> mcp status [server] [--json]",
        );
        const sandbox = getSandboxOrThrow(sandboxName);
        const agent = getSandboxAgent(sandbox);
        const statuses = await statusMcpBridge(sandboxName, server);
        if (json) {
          console.log(
            JSON.stringify(
              server ? statuses[0] : buildJsonSummary(sandboxName, agent, statuses),
              null,
              2,
            ),
          );
        } else renderStatus(sandboxName, statuses, agent);
        return;
      }
      case "restart": {
        const server = requireAtMostOneArg(rest, "Usage: nemoclaw <sandbox> mcp restart [server]");
        await restartMcpBridge(sandboxName, server);
        return;
      }
      case "remove": {
        const force = rest.includes("--force");
        const names = rest.filter((arg) => arg !== "--force");
        const server = names[0];
        if (!server || names.length > 1)
          throw new McpBridgeError("Usage: nemoclaw <sandbox> mcp remove <server> [--force]", 2);
        await removeMcpBridge(sandboxName, server, { force });
        return;
      }
      default:
        throw new McpBridgeError(
          "Usage: nemoclaw <sandbox> mcp <add|list|status|restart|remove> [args...]",
          2,
        );
    }
  } catch (error) {
    if (error instanceof McpBridgeError) {
      console.error(`  ${error.message}`);
      process.exitCode = error.exitCode;
      return;
    }
    throw error;
  }
}
