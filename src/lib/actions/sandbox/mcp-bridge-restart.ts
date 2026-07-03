// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentMcpAdapter } from "../../agent/defs";
import { withMcpLifecycleLock } from "../../state/mcp-lifecycle-lock";
import type { McpBridgeEntry } from "../../state/registry";
import { registerAgentAdapter } from "./mcp-bridge-adapters";
import { McpBridgeError } from "./mcp-bridge-contracts";
import { applyGeneratedPolicy, assertGeneratedPolicyMutationSafe } from "./mcp-bridge-policy";
import {
  assertMcpProviderRecoverable,
  assertNoAttachedProviderCredentialCollision,
  attachProvider,
  detachMissingProviderReference,
  type McpCredentialRevisionObservation,
  type McpProviderInspection,
  observeMcpCredentialRevision,
  preflightMcpEntryTargets,
  upsertMcpProvider,
  waitForAttachedMcpCredential,
  waitForDetachedMcpCredential,
} from "./mcp-bridge-provider";
import {
  assertMcpAdapterConfigMutationsAllowed,
  assertMcpAdapterMutationRuntimeCapabilities,
  assertMcpAdapterTeardownRuntimeCapabilities,
} from "./mcp-bridge-runtime-capabilities";
import {
  assertMcpDestroyNotPending,
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
  resolveCredentialEnv,
  validateSandboxName,
} from "./mcp-bridge-validation";

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
    let previousCredentialRevision: McpCredentialRevisionObservation | undefined;
    assertNoAttachedProviderCredentialCollision(sandboxName, entry);
    // Revalidate the actual running supervisor before rotating, recreating,
    // attaching, or re-registering an authenticated provider.
    applyGeneratedPolicy(sandboxName, entry, resolvedAddresses);
    const providerResult = upsertMcpProvider(entry.providerName ?? "", envRefs, {
      allowExisting: true,
      expectedProviderId: entry.providerId,
      prepareMutation: (action) => {
        if (action === "update") {
          previousCredentialRevision = observeMcpCredentialRevision(sandboxName, entry);
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
    if (providerResult.action === "updated" && previousCredentialRevision === undefined) {
      throw new McpBridgeError(
        `Could not retain the prior OpenShell credential revision for provider '${entry.providerName}'.`,
      );
    }
    attachProvider(sandboxName, entry);
    waitForAttachedMcpCredential(sandboxName, entry, {
      ...(providerResult.action === "updated"
        ? { previousRevision: previousCredentialRevision }
        : {}),
    });
    registerAgentAdapter(
      sandboxName,
      (entry.adapter as AgentMcpAdapter | undefined) ?? adapter,
      entry,
      adapterEnvValues,
      { replaceExisting: true },
    );
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
