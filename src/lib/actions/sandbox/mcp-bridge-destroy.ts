// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { McpBridgeEntry, SandboxEntry } from "../../state/registry";
import * as registry from "../../state/registry";
import { registerAgentAdapter, unregisterAgentAdapter } from "./mcp-bridge-adapters";
import {
  isAgentMcpAdapter,
  MCP_BRIDGE_POLICY_SOURCE,
  McpBridgeError,
} from "./mcp-bridge-contracts";
import {
  assertGeneratedPolicyRegistrationMutationSafe,
  removeGeneratedPolicy,
} from "./mcp-bridge-policy";
import {
  attachProvider,
  deleteProvider,
  detachProvider,
  inspectMcpProvider,
  type McpProviderInspection,
  providerMatchesCredential,
  providerShapeDetail,
  waitForAttachedMcpCredential,
  waitForDetachedMcpCredential,
} from "./mcp-bridge-provider";
import { restoreExistingMcpBridgeRuntime } from "./mcp-bridge-restart";
import {
  assertMcpAdapterConfigMutationsAllowed,
  assertMcpAdapterTeardownRuntimeCapabilities,
} from "./mcp-bridge-runtime-capabilities";
import {
  bridgeState,
  ensureSandboxGatewaySelected,
  getBridgeAdapter,
  getSandboxAgent,
  getSandboxOrThrow,
  nowIso,
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
  if (Object.keys(remaining).length === Object.keys(bridges).length) {
    return sandbox;
  }
  for (const entry of providerlessPreflighted) {
    if (options.sandboxAbsent) {
      const ownedRegistration = assertGeneratedPolicyRegistrationMutationSafe(sandboxName, entry);
      if (ownedRegistration) registry.removeCustomPolicyByName(sandboxName, entry.policyName);
    } else {
      removeGeneratedPolicy(sandboxName, entry);
    }
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
  const sandbox = await discardSafeIncompleteMcpAdds(sandboxName, getSandboxOrThrow(sandboxName), {
    sandboxAbsent: true,
  });
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
  const currentSandbox = getSandboxOrThrow(sandboxName);
  const entriesRequiringExternalCleanup = Object.values(bridgeState(currentSandbox)).filter(
    (entry) => entry.addState !== "prepared",
  );
  // Run the host-visible config preflight before
  // discardSafeIncompleteMcpAdds, which may remove an owned policy for a
  // providerless preflighted add. That cleanup has no adapter/provider to
  // probe; complete entries get the teardown runtime probe after retry markers.
  assertMcpAdapterConfigMutationsAllowed(
    sandboxName,
    currentSandbox,
    entriesRequiringExternalCleanup,
  );
  const sandbox = await discardSafeIncompleteMcpAdds(sandboxName, currentSandbox);
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
  assertMcpAdapterTeardownRuntimeCapabilities(sandboxName, sandbox, entries);
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
  const preparedSandbox = assertMcpDestroySnapshotCurrent(sandboxName, preparation.entries);
  const destroyPreparedAt = preparedSandbox.mcp?.destroyPreparedAt ?? nowIso();
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
  try {
    // Reattach only the exact existing providers. This restoration path never
    // reads host secret values and therefore cannot rotate preserved credentials.
    for (const entry of preparation.entries)
      inspectExactMcpDestroyProvider(entry, { allowMissing: false });
    await restoreExistingMcpBridgeRuntime(sandboxName, preparation.entries, {
      lifecyclePhase: "teardown-rollback",
    });
  } catch (error) {
    let markerRestoreFailure = "";
    try {
      const restored = registry.updateSandbox(sandboxName, {
        mcp: {
          bridges: Object.fromEntries(
            preparation.entries.map((entry) => [entry.server, cloneMcpBridgeEntry(entry)]),
          ),
          destroyPreparedAt,
        },
      });
      if (!restored) markerRestoreFailure = "sandbox registry entry disappeared";
    } catch (restoreError) {
      markerRestoreFailure =
        restoreError instanceof Error ? restoreError.message : String(restoreError);
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new McpBridgeError(
      markerRestoreFailure
        ? `${detail}; could not restore the MCP destroy retry marker: ${markerRestoreFailure}`
        : detail,
    );
  }
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
