// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentMcpAdapter } from "../../agent/defs";
import { withMcpLifecycleLock } from "../../state/mcp-lifecycle-lock";
import { assertHermesPortableCommandUnavailable } from "../../onboard/experimental/portable-agent-lifecycle";
import type { McpSourceEntry } from "./mcp-bridge-contracts";
import {
  registerAgentAdapterAtCurrentCredentialRevision,
  reloadOpenClawGatewayAfterMcpMutation,
} from "./mcp-bridge-adapters";
import { McpBridgeError } from "./mcp-bridge-contracts";
import { applyGeneratedPolicy, assertGeneratedPolicyMutationSafe } from "./mcp-bridge-policy";
import {
  assertMcpProviderRecoverable,
  assertNoAttachedProviderCredentialCollisions,
  assertNoProviderCredentialCollisions,
  attachProvider,
  detachMissingProviderReference,
  ensureMcpBridgeProviderProfile,
  getMcpProviderInspectionRuntimeSelection,
  refreshMcpProviderEnvironment,
  type McpCredentialRevisionObservation,
  type McpProviderInspection,
  type McpProviderInspectionRuntimeSelection,
  observeMcpCredentialRevision,
  preflightMcpEntryTargets,
  upsertMcpProvider,
  waitForAttachedMcpCredential,
  waitForDetachedMcpCredential,
} from "./mcp-bridge-provider";
import {
  assertMcpAdapterMutationRuntimeCapabilities,
  assertMcpAdapterTeardownRuntimeCapabilities,
} from "./mcp-bridge-runtime-capabilities";
import {
  ensureSandboxGatewaySelected,
  getBridgeAdapter,
  getSandboxAgent,
  getSandboxOrThrow,
} from "./mcp-bridge-state";
import { inspectSourceBridgeState } from "./mcp-bridge-source";
import { statusMcpBridge } from "./mcp-bridge-status";
import type { McpBridgeTargetValidation } from "./mcp-bridge-url-validation";
import {
  assertAuthenticatedBridgeEntry,
  assertMcpCredentialBoundaryRuntimeVersion,
  resolveCredentialEnv,
  validateSandboxName,
} from "./mcp-bridge-validation";

function resolvedTargetPins(
  resolvedByServer: ReadonlyMap<string, McpBridgeTargetValidation>,
  entry: McpSourceEntry,
): McpBridgeTargetValidation {
  const target = resolvedByServer.get(entry.server);
  if (!target || target.addresses.length === 0) {
    throw new McpBridgeError(
      `MCP server '${entry.server}' has no validated address pins. Refusing policy mutation.`,
    );
  }
  return target;
}

export async function restartMcpBridge(sandboxName: string, server?: string): Promise<void> {
  return withMcpLifecycleLock(sandboxName, () => {
    assertHermesPortableCommandUnavailable(sandboxName, "sandbox:mcp:restart");
    return restartMcpBridgeUnlocked(sandboxName, server);
  });
}

async function restartMcpBridgeUnlocked(sandboxName: string, server?: string): Promise<void> {
  validateSandboxName(sandboxName);
  const sandbox = getSandboxOrThrow(sandboxName);
  const sourceRuntimeSelection = getMcpProviderInspectionRuntimeSelection(sandbox);
  const observed = inspectSourceBridgeState(sandbox, sourceRuntimeSelection);
  if (Object.keys(observed.sources.legacy).length > 0) {
    throw new McpBridgeError(
      `Legacy MCP agent configuration requires explicit migration. Run \`nemoclaw ${sandboxName} mcp migrate\` first.`,
      2,
    );
  }
  const agent = getSandboxAgent(sandbox);
  const adapter = getBridgeAdapter(agent);
  const bridges = observed.bridges;
  const targets = server ? [[server, bridges[server]] as const] : Object.entries(bridges);
  if (targets.length === 0) {
    console.log(`  No MCP servers for sandbox '${sandboxName}'.`);
    return;
  }
  for (const [name, entry] of targets) {
    if (!entry) {
      throw new McpBridgeError(`MCP server '${name}' not found on sandbox '${sandboxName}'.`);
    }
    assertAuthenticatedBridgeEntry(entry);
  }
  const targetEntries = targets
    .map(([, entry]) => entry)
    .filter((entry): entry is McpSourceEntry => !!entry);
  const providerRuntimeSelection = getMcpProviderInspectionRuntimeSelection(sandbox);
  const reloadedAdapters: AgentMcpAdapter[] = [];
  assertMcpCredentialBoundaryRuntimeVersion();
  await ensureSandboxGatewaySelected(sandboxName, providerRuntimeSelection);
  assertMcpAdapterMutationRuntimeCapabilities(
    sandboxName,
    sandbox,
    targetEntries,
    providerRuntimeSelection,
  );
  for (const [name, entry] of targets) {
    if (!entry) continue;
    const [status] = await statusMcpBridge(sandboxName, name, {
      runtimeSelection: providerRuntimeSelection,
    });
    if (
      status?.policy.present !== true ||
      status.provider.present !== true ||
      status.provider.attached !== true ||
      status.provider.credentialReady !== true
    ) {
      throw new McpBridgeError(
        `MCP server '${name}' is not ready in the current agent and OpenShell sources (policy=${String(status?.policy.state ?? "unavailable")}, provider=${String(status?.provider.state ?? "unavailable")}). Restart does not reconstruct missing source state.`,
      );
    }
    const credentialObservation = observeMcpCredentialRevision(
      sandboxName,
      entry,
      providerRuntimeSelection,
    );
    if (
      credentialObservation === null ||
      credentialObservation === "absent" ||
      credentialObservation === "canonical"
    ) {
      throw new McpBridgeError(
        `MCP server '${name}' does not expose a revision-scoped OpenShell credential to the running agent.`,
      );
    }
    const entryAdapter = entry.adapter ?? adapter;
    registerAgentAdapterAtCurrentCredentialRevision(
      sandboxName,
      entryAdapter,
      entry,
      providerRuntimeSelection,
      {},
      credentialObservation,
      { replaceExisting: true },
    );
    reloadedAdapters.push(entryAdapter);
    console.log(`  Reloaded MCP server '${name}' from current agent configuration.`);
  }
  reloadOpenClawGatewayAfterMcpMutation(sandboxName, reloadedAdapters);
}

export async function restoreExistingMcpBridgeRuntime(
  sandboxName: string,
  entries: readonly McpSourceEntry[],
  options: {
    lifecyclePhase?: "active-mutation" | "teardown-rollback";
    applyPolicy?: boolean;
    runtimeSelection?: McpProviderInspectionRuntimeSelection;
  } = {},
): Promise<void> {
  if (entries.length === 0) return;
  for (const entry of entries) assertAuthenticatedBridgeEntry(entry);
  const resolvedByServer = await preflightMcpEntryTargets(entries);
  if (options.lifecyclePhase !== "teardown-rollback") {
    assertMcpCredentialBoundaryRuntimeVersion();
  }
  const sandbox = getSandboxOrThrow(sandboxName);
  const providerRuntimeSelection =
    options.runtimeSelection ?? getMcpProviderInspectionRuntimeSelection(sandbox);
  await ensureSandboxGatewaySelected(sandboxName, providerRuntimeSelection);
  if (options.lifecyclePhase === "teardown-rollback") {
    // A failed delete/rebuild must be able to restore a backward-compatible
    // Deep Agents entry on the same old image it just scrubbed. New/rebuilt
    // images use the default path and must prove the current marker before any
    // policy, provider, attachment, or adapter mutation.
    assertMcpAdapterTeardownRuntimeCapabilities(
      sandboxName,
      sandbox,
      entries,
      providerRuntimeSelection,
    );
  } else {
    assertMcpAdapterMutationRuntimeCapabilities(
      sandboxName,
      sandbox,
      entries,
      providerRuntimeSelection,
    );
  }
  const defaultAdapter = getBridgeAdapter(getSandboxAgent(sandbox));
  const restoredAdapters: AgentMcpAdapter[] = [];
  for (const entry of entries) {
    assertGeneratedPolicyMutationSafe(sandboxName, entry);
    const provider = assertMcpProviderRecoverable(entry, providerRuntimeSelection);
    if (provider.exists !== true) {
      throw new McpBridgeError(
        `OpenShell provider '${entry.providerName}' is missing. Runtime restoration refuses to create or rotate credentials; run explicit MCP restart after exporting '${entry.env[0]}'.`,
      );
    }
  }
  // Reject every current collision before the first restore mutation, so a
  // pre-existing collision on a later entry cannot follow an earlier restore
  // mutation. Per-entry attached-provider checks detect new collisions at each
  // restore mutation edge.
  assertNoProviderCredentialCollisions(sandboxName, entries, providerRuntimeSelection);
  for (const entry of entries) {
    assertNoAttachedProviderCredentialCollisions(sandboxName, [entry], providerRuntimeSelection);
    ensureMcpBridgeProviderProfile(providerRuntimeSelection);
    if (options.applyPolicy !== false) {
      applyGeneratedPolicy(sandboxName, entry, resolvedTargetPins(resolvedByServer, entry), {
        bindCredential: false,
        runtimeSelection: providerRuntimeSelection,
      });
    }
    attachProvider(sandboxName, entry, providerRuntimeSelection);
    if (options.applyPolicy !== false) {
      applyGeneratedPolicy(sandboxName, entry, resolvedTargetPins(resolvedByServer, entry), {
        runtimeSelection: providerRuntimeSelection,
      });
    }
    const adapter = entry.adapter ?? defaultAdapter;
    refreshMcpProviderEnvironment(entry, providerRuntimeSelection);
    const credentialRevision = waitForAttachedMcpCredential(
      sandboxName,
      entry,
      providerRuntimeSelection,
    );
    registerAgentAdapterAtCurrentCredentialRevision(
      sandboxName,
      adapter,
      entry,
      providerRuntimeSelection,
      {},
      credentialRevision,
      {
        replaceExisting: true,
        teardownRollback: options.lifecyclePhase === "teardown-rollback",
      },
    );
    restoredAdapters.push(adapter);
  }
  reloadOpenClawGatewayAfterMcpMutation(sandboxName, restoredAdapters);
}
