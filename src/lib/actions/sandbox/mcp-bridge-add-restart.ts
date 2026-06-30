// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";

import type { AgentMcpAdapter } from "../../agent/defs";
import * as policies from "../../policy";
import { withMcpLifecycleLock } from "../../state/mcp-lifecycle-lock";
import type { McpBridgeEntry, SandboxEntry } from "../../state/registry";
import * as registry from "../../state/registry";
import {
  assertAgentMcpConfigMutationAllowed,
  assertAgentMcpMutationRuntimeCapability,
  assertAgentMcpTeardownRuntimeCapability,
  inspectAgentAdapterRegistration,
  registerAgentAdapter,
  unregisterAgentAdapter,
} from "./mcp-bridge-adapters";
import {
  isAgentMcpAdapter,
  type McpBridgeAddOptions,
  McpBridgeError,
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
  assertMcpProviderRecoverable,
  assertNoAttachedProviderCredentialCollision,
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
  writeBridgeEntry,
} from "./mcp-bridge-state";
import {
  assertAuthenticatedBridgeEntry,
  assertAuthenticatedCredentialReference,
  buildMcpBridgeProviderName,
  normalizeMcpServerUrl,
  resolveCredentialEnv,
  uniqueEnvNames,
  validateMcpServerName,
  validateMcpServerUrlResolvedTarget,
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
    existing.env.length === requested.env.length &&
    existing.env.every((name, index) => name === requested.env[index])
  );
}

function resolvedTargetPins(
  resolvedByServer: ReadonlyMap<string, string[]>,
  entry: McpBridgeEntry,
): string[] {
  const addresses = resolvedByServer.get(entry.server);
  if (!addresses || addresses.length === 0) {
    throw new McpBridgeError(
      `MCP server '${entry.server}' has no validated public address pins. Refusing policy mutation.`,
    );
  }
  return addresses;
}

export function assertMcpAdapterMutationRuntimeCapabilities(
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

/**
 * Prove host-visible config mutability without requiring a capability marker
 * from the image being torn down. Deep Agents entries created by an older
 * NemoClaw release remain safe to scrub because their exact persisted adapter
 * definition is still ownership-checked by unregisterAgentAdapter.
 */
export function assertMcpAdapterConfigMutationsAllowed(
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
    assertAgentMcpConfigMutationAllowed(sandboxName, adapter);
  }
}

export function assertMcpAdapterTeardownRuntimeCapabilities(
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
    assertAgentMcpTeardownRuntimeCapability(sandboxName, adapter);
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
  // This is the durable ownership manifest for every resource created below.
  // It intentionally precedes gateway selection and all OpenShell mutations,
  // so process death can never leave an unowned provider/policy/adapter entry.
  if (!existingEntry) writeBridgeEntry(sandboxName, entry);

  let providerCreated = false;
  let providerAttachAttempted = false;
  let policyApplied = false;
  let adapterMutationAttempted = false;
  let credentialRevisionSnapshotPath: string | undefined;
  try {
    await ensureSandboxGatewaySelected(sandboxName);
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
    // Credential keys are sandbox-global. Prove this key is not already
    // supplied by a foreign attachment before opening its MCP route, then check
    // again after provider creation to close the intervening race.
    assertNoAttachedProviderCredentialCollision(sandboxName, entry);
    // Loading the real protocol:mcp policy with --wait is the authoritative
    // running-supervisor capability check. Do it before any host credential is
    // created or updated so unsupported runtimes fail without that side effect.
    applyGeneratedPolicy(sandboxName, entry, resolvedAddresses);
    policyApplied = true;
    const providerResult = upsertMcpProvider(providerName ?? "", options.env, {
      // A first mutation must still observe the absence proven above. Only a
      // retry of the durable preflighted transaction may encounter an exact
      // provider whose immutable ID was already persisted by this add.
      allowExisting: resumingPreflightedAdd,
      expectedProviderId: entry.providerId,
      prepareMutation: (action) => {
        // A fresh create has no prior revision to compare. Capture an opaque
        // placeholder only for an actual update, after the running supervisor
        // has accepted the authenticated MCP policy.
        if (action === "update") {
          credentialRevisionSnapshotPath = snapshotMcpCredentialRevision(sandboxName, entry);
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
    assertNoAttachedProviderCredentialCollision(sandboxName, entry);
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
  // Hermes shields posture is host-visible. Refuse before DNS, gateway
  // recovery/selection, provider inspection, or any lifecycle mutation.
  assertMcpAdapterConfigMutationsAllowed(sandboxName, sandbox, targetEntries);
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
  // is still present in the sandbox spec. These references name providers
  // already proven absent; no live credential is removed before the runtime
  // capability probe, and the durable bridge manifest is retained on failure.
  for (const entry of missingProviderEntries) {
    detachMissingProviderReference(sandboxName, entry);
  }
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
    const resolvedAddresses = resolvedTargetPins(resolvedByServer, entry);
    let credentialRevisionSnapshotPath: string | undefined;
    try {
      assertNoAttachedProviderCredentialCollision(sandboxName, entry);
      // Revalidate the actual running supervisor before rotating, recreating,
      // attaching, or re-registering an authenticated provider.
      applyGeneratedPolicy(sandboxName, entry, resolvedAddresses);
      const providerResult = upsertMcpProvider(entry.providerName ?? "", envRefs, {
        allowExisting: true,
        expectedProviderId: entry.providerId,
        prepareMutation: (action) => {
          if (action === "update") {
            credentialRevisionSnapshotPath = snapshotMcpCredentialRevision(sandboxName, entry);
          }
        },
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

export async function restoreExistingMcpBridgeRuntime(
  sandboxName: string,
  entries: readonly McpBridgeEntry[],
  options: { lifecyclePhase?: "active-mutation" | "teardown-rollback" } = {},
): Promise<void> {
  if (entries.length === 0) return;
  for (const entry of entries) assertAuthenticatedBridgeEntry(entry);
  const resolvedByServer = await preflightMcpEntryTargets(entries);
  await ensureSandboxGatewaySelected(sandboxName);
  const sandbox = getSandboxOrThrow(sandboxName);
  assertMcpDestroyNotPending(sandbox);
  if (options.lifecyclePhase === "teardown-rollback") {
    // A failed delete/rebuild must be able to restore a backward-compatible
    // Deep Agents entry on the same old image it just scrubbed. New/rebuilt
    // images use the default path and must prove the current marker before any
    // policy, provider, attachment, or adapter mutation.
    assertMcpAdapterTeardownRuntimeCapabilities(sandboxName, sandbox, entries);
  } else {
    assertMcpAdapterMutationRuntimeCapabilities(sandboxName, sandbox, entries);
  }
  for (const entry of entries) {
    assertGeneratedPolicyMutationSafe(sandboxName, entry);
    const provider = assertMcpProviderRecoverable(entry);
    if (provider.exists !== true) {
      throw new McpBridgeError(
        `OpenShell provider '${entry.providerName}' is missing. Runtime restoration refuses to create or rotate credentials; run explicit MCP restart after exporting '${entry.env[0]}'.`,
      );
    }
    assertNoAttachedProviderCredentialCollision(sandboxName, entry);
    applyGeneratedPolicy(sandboxName, entry, resolvedTargetPins(resolvedByServer, entry));
    attachProvider(sandboxName, entry);
    waitForAttachedMcpCredential(sandboxName, entry);
    const adapter =
      (entry.adapter as AgentMcpAdapter | undefined) ?? getBridgeAdapter(getSandboxAgent(sandbox));
    registerAgentAdapter(sandboxName, adapter, entry, {}, { replaceExisting: true });
    writeBridgeEntry(sandboxName, { ...entry, adapter, updatedAt: nowIso() });
  }
}
