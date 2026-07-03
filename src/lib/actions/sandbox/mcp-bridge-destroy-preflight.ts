// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { McpBridgeEntry, SandboxEntry } from "../../state/registry";
import * as registry from "../../state/registry";
import { McpBridgeError } from "./mcp-bridge-contracts";
import {
  assertGeneratedPolicyRegistrationMutationSafe,
  removeGeneratedPolicy,
} from "./mcp-bridge-policy";
import {
  inspectMcpProvider,
  type McpProviderInspection,
  providerMatchesCredential,
  providerShapeDetail,
} from "./mcp-bridge-provider";
import {
  bridgeState,
  ensureSandboxGatewaySelected,
  getSandboxOrThrow,
  setBridgeState,
} from "./mcp-bridge-state";
import { assertAuthenticatedBridgeEntry, validateSandboxName } from "./mcp-bridge-validation";

export interface McpDestroyPreparation {
  entries: McpBridgeEntry[];
  detachedProviderEntries: McpBridgeEntry[];
  scrubbedAdapterEntries: McpBridgeEntry[];
  /** True when phase one was completed by an earlier destroy process. */
  destroyAlreadyPrepared: boolean;
  /** True when a previous destroy already confirmed the sandbox was absent. */
  destroyAlreadyPending: boolean;
}

export function cloneMcpBridgeEntry(entry: McpBridgeEntry): McpBridgeEntry {
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

export async function discardSafeIncompleteMcpAdds(
  sandboxName: string,
  sandbox: SandboxEntry,
  options: { sandboxAbsent?: boolean } = {},
): Promise<SandboxEntry> {
  const bridges = bridgeState(sandbox);
  const providerlessCandidates = Object.values(bridges).filter(
    (entry) => entry.addState === "preflighted" && !entry.providerId,
  );
  if (providerlessCandidates.length > 0) await ensureSandboxGatewaySelected(sandboxName);
  const remainingEntries: Array<[string, McpBridgeEntry]> = [];
  const providerlessPreflighted: McpBridgeEntry[] = [];
  for (const [server, entry] of Object.entries(bridges)) {
    if (entry.addState === "prepared") continue;
    if (entry.addState === "preflighted" && !entry.providerId) {
      assertAuthenticatedBridgeEntry(entry);
      const inspection = inspectMcpProvider(entry.providerName);
      if (inspection.exists === false) {
        providerlessPreflighted.push(entry);
        continue;
      }
    }
    remainingEntries.push([server, entry]);
  }
  const remaining = Object.fromEntries(remainingEntries);
  if (Object.keys(remaining).length === Object.keys(bridges).length) return sandbox;
  for (const entry of providerlessPreflighted) {
    if (options.sandboxAbsent) {
      const ownedRegistration = assertGeneratedPolicyRegistrationMutationSafe(sandboxName, entry);
      if (ownedRegistration) registry.removeCustomPolicyByName(sandboxName, entry.policyName);
    } else {
      removeGeneratedPolicy(sandboxName, entry);
    }
  }
  // A prepared add precedes all external side effects, so destroy drops only
  // its local manifest and never inspects same-name global resources.
  setBridgeState(sandboxName, remaining);
  return getSandboxOrThrow(sandboxName);
}

export function assertMcpDestroySnapshotCurrent(
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

export function inspectExactMcpDestroyProvider(
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

/** Build cleanup state after a gateway-pinned list proves the sandbox absent. */
export async function prepareMcpBridgesForAbsentSandboxDestroy(
  sandboxName: string,
  options: { force?: boolean } = {},
): Promise<McpDestroyPreparation> {
  validateSandboxName(sandboxName);
  const sandbox = await discardSafeIncompleteMcpAdds(sandboxName, getSandboxOrThrow(sandboxName), {
    sandboxAbsent: true,
  });
  const entries = Object.values(bridgeState(sandbox)).map(cloneMcpBridgeEntry);
  const destroyAlreadyPrepared = !!sandbox.mcp?.destroyPreparedAt;
  const destroyAlreadyPending = !!sandbox.mcp?.destroyPendingAt;
  for (const entry of entries) {
    inspectExactMcpDestroyProvider(entry, { allowMissing: true, force: options.force });
  }
  return {
    entries,
    detachedProviderEntries: [],
    scrubbedAdapterEntries: [],
    destroyAlreadyPrepared,
    destroyAlreadyPending,
  };
}
