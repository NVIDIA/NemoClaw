// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentMcpAdapter } from "../../agent/defs";
import { resolveSandboxGatewayName } from "../../onboard/gateway-binding";
import type { McpBridgeEntry, SandboxEntry } from "../../state/registry";
import { McpBridgeError } from "./mcp-bridge-contracts";
import {
  assertMcpDestroySnapshotCurrent,
  cloneMcpBridgeEntry,
  inspectExactMcpDestroyProvider,
} from "./mcp-bridge-destroy-preflight";
import {
  assertNoProviderCredentialCollisions,
  preflightMcpEntryTargets,
} from "./mcp-bridge-provider";
import {
  assertMcpDestroyNotPending,
  bridgeState,
  ensureSandboxGatewaySelected,
  getBridgeAdapter,
  getSandboxAgent,
  getSandboxOrThrow,
} from "./mcp-bridge-state";
import type { McpBridgeTargetValidation } from "./mcp-bridge-url-validation";
import { assertAuthenticatedBridgeEntry, validateSandboxName } from "./mcp-bridge-validation";

type ReadOnlyValidationSnapshot = {
  providerByServer: Map<string, string>;
  targetsByServer: Map<string, string>;
};

type ExplicitAdapterMcpBridgeEntry = McpBridgeEntry & { adapter: AgentMcpAdapter };

type McpOwnershipField = {
  label: string;
  value: (entry: McpBridgeEntry) => string | undefined;
};

export interface ExecUnavailableMcpRebuildPreparation {
  entries: McpBridgeEntry[];
  detachedProviderEntries: McpBridgeEntry[];
  scrubbedAdapterEntries: McpBridgeEntry[];
  revalidateBeforeDelete: () => Promise<void>;
  assertDeleteEdgeUnchanged: () => void;
}

function assertUniqueMcpOwnership(entries: readonly McpBridgeEntry[]): void {
  for (const entry of entries) assertAuthenticatedBridgeEntry(entry);

  const ownershipFields: readonly McpOwnershipField[] = [
    { label: "credential key", value: (entry) => entry.env[0] },
    { label: "provider name", value: (entry) => entry.providerName },
    { label: "provider ID", value: (entry) => entry.providerId },
    { label: "generated policy name", value: (entry) => entry.policyName },
  ];
  for (const field of ownershipFields) {
    const ownerByValue = new Map<string, string>();
    for (const entry of entries) {
      const value = field.value(entry);
      if (!value) continue;
      if (ownerByValue.has(value)) {
        const priorOwner = ownerByValue.get(value) ?? "<unknown>";
        throw new McpBridgeError(
          `MCP servers '${priorOwner}' and '${entry.server}' reuse the same ${field.label} '${value}'. Refusing read-only host-side rebuild recovery.`,
        );
      }
      ownerByValue.set(value, entry.server);
    }
  }
}

function snapshotCompleteEntries(sandboxName: string): {
  entries: ExplicitAdapterMcpBridgeEntry[];
  gatewayName: string;
  agentName: string;
  adapter: AgentMcpAdapter;
} {
  validateSandboxName(sandboxName);
  const sandbox = getSandboxOrThrow(sandboxName);
  assertMcpDestroyNotPending(sandbox);
  const entries = Object.values(bridgeState(sandbox)).map(cloneMcpBridgeEntry);
  const incomplete = entries.find((entry) => entry.addState !== undefined);
  if (incomplete) {
    throw new McpBridgeError(
      `MCP server '${incomplete.server}' has an incomplete add transaction (${incomplete.addState}). Read-only host-side rebuild recovery cannot discard or adopt it; re-run the original mcp add command or remove it with --force before rebuilding the sandbox.`,
    );
  }
  const agent = getSandboxAgent(sandbox);
  const adapter = getBridgeAdapter(agent);
  const incompatible = entries.find(
    (entry) => entry.agent !== agent.name || entry.adapter !== adapter,
  );
  if (incompatible) {
    throw new McpBridgeError(
      "Managed MCP adapter identity is missing or incompatible with the sandbox's recorded agent. Refusing read-only host-side rebuild recovery.",
    );
  }
  assertUniqueMcpOwnership(entries);
  return {
    entries: entries.map((entry) => ({ ...entry, adapter })),
    gatewayName: resolveSandboxGatewayName(sandbox),
    agentName: agent.name,
    adapter,
  };
}

function providerFingerprint(provider: ReturnType<typeof inspectExactMcpDestroyProvider>): string {
  return JSON.stringify({
    exists: provider.exists,
    id: provider.id,
    resourceVersion: provider.resourceVersion,
    type: provider.type,
    credentialKeys: provider.credentialKeys,
  });
}

function targetFingerprint(target: McpBridgeTargetValidation | undefined): string {
  if (!target || target.addresses.length === 0) {
    throw new McpBridgeError(
      "Resolved MCP target validation returned no exact address pins. Refusing host-side rebuild recovery.",
    );
  }
  return JSON.stringify([...target.addresses].sort());
}

async function inspectReadOnlyRecoveryState(
  sandboxName: string,
  entries: readonly McpBridgeEntry[],
): Promise<ReadOnlyValidationSnapshot> {
  const resolvedTargets = await preflightMcpEntryTargets(entries);
  // This may start or recover the sandbox's recorded host gateway and select
  // it in CLI context. It does not mutate MCP lifecycle state or sandbox
  // contents; the provider and target checks below remain inspection-only.
  if (entries.length > 0) await ensureSandboxGatewaySelected(sandboxName);

  const providerByServer = new Map<string, string>();
  const targetsByServer = new Map<string, string>();
  for (const entry of entries) {
    const target = resolvedTargets.get(entry.server);
    const provider = inspectExactMcpDestroyProvider(entry, { allowMissing: false });
    providerByServer.set(entry.server, providerFingerprint(provider));
    targetsByServer.set(entry.server, targetFingerprint(target));
  }
  assertNoProviderCredentialCollisions(sandboxName, entries);
  return { providerByServer, targetsByServer };
}

function assertValidationSnapshotCurrent(
  entries: readonly McpBridgeEntry[],
  expected: ReadOnlyValidationSnapshot,
  current: ReadOnlyValidationSnapshot,
): void {
  const drifted = entries.find(
    (entry) =>
      current.providerByServer.get(entry.server) !== expected.providerByServer.get(entry.server) ||
      current.targetsByServer.get(entry.server) !== expected.targetsByServer.get(entry.server),
  );
  if (drifted) {
    throw new McpBridgeError(
      `MCP server '${drifted.server}' changed after host-side rebuild preflight. Refusing to delete the still-live sandbox; retry after its target and provider state are stable.`,
    );
  }
}

function assertDeleteEdgeUnchanged(
  sandboxName: string,
  expectedEntries: readonly McpBridgeEntry[],
  expectedGatewayName: string,
  expectedAgentName: string,
  expectedAdapter: AgentMcpAdapter,
): void {
  const sandbox: SandboxEntry = assertMcpDestroySnapshotCurrent(sandboxName, expectedEntries);
  assertMcpDestroyNotPending(sandbox);
  try {
    const agent = getSandboxAgent(sandbox);
    if (agent.name !== expectedAgentName || getBridgeAdapter(agent) !== expectedAdapter) {
      throw new Error("adapter binding changed");
    }
  } catch {
    throw new McpBridgeError(
      `Sandbox '${sandboxName}' changed its recorded agent or MCP adapter after host-side rebuild preflight. Refusing to delete it.`,
    );
  }
  if (resolveSandboxGatewayName(sandbox) !== expectedGatewayName) {
    throw new McpBridgeError(
      `Sandbox '${sandboxName}' changed its recorded gateway after host-side rebuild preflight. Refusing to delete it.`,
    );
  }
}

async function revalidateBeforeDelete(
  sandboxName: string,
  expectedEntries: readonly McpBridgeEntry[],
  expectedGatewayName: string,
  expectedAgentName: string,
  expectedAdapter: AgentMcpAdapter,
  expectedValidation: ReadOnlyValidationSnapshot,
): Promise<void> {
  assertDeleteEdgeUnchanged(
    sandboxName,
    expectedEntries,
    expectedGatewayName,
    expectedAgentName,
    expectedAdapter,
  );
  const currentValidation = await inspectReadOnlyRecoveryState(sandboxName, expectedEntries);
  assertValidationSnapshotCurrent(expectedEntries, expectedValidation, currentValidation);
}

/**
 * Preserve complete MCP intent when sandbox exec is unavailable but OpenShell
 * still reports the sandbox live. Unlike absent-sandbox recovery, this path is
 * read-only with respect to MCP lifecycle state and sandbox contents: it may recover
 * and select the recorded host gateway for inspection, but it never discards
 * add markers, scrubs adapters, detaches providers, or changes policy before
 * delete.
 */
export async function prepareMcpBridgesForExecUnavailableRebuild(
  sandboxName: string,
): Promise<ExecUnavailableMcpRebuildPreparation> {
  const { entries, gatewayName, agentName, adapter } = snapshotCompleteEntries(sandboxName);
  const expectedEntries = entries.map(cloneMcpBridgeEntry);
  const expectedValidation = await inspectReadOnlyRecoveryState(sandboxName, expectedEntries);
  return {
    entries: entries.map(cloneMcpBridgeEntry),
    detachedProviderEntries: [],
    scrubbedAdapterEntries: [],
    revalidateBeforeDelete: () =>
      revalidateBeforeDelete(
        sandboxName,
        expectedEntries,
        gatewayName,
        agentName,
        adapter,
        expectedValidation,
      ),
    assertDeleteEdgeUnchanged: () =>
      assertDeleteEdgeUnchanged(sandboxName, expectedEntries, gatewayName, agentName, adapter),
  };
}
