// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { McpBridgeEntry } from "../../state/registry";
import * as registry from "../../state/registry";
import { registerAgentAdapter, unregisterAgentAdapter } from "./mcp-bridge-adapters";
import {
  isAgentMcpAdapter,
  MCP_BRIDGE_POLICY_SOURCE,
  McpBridgeError,
} from "./mcp-bridge-contracts";
import type { McpDestroyPreparation } from "./mcp-bridge-destroy-preflight";
import {
  assertMcpDestroySnapshotCurrent,
  cloneMcpBridgeEntry,
  discardSafeIncompleteMcpAdds,
  inspectExactMcpDestroyProvider,
} from "./mcp-bridge-destroy-preflight";
import {
  attachProvider,
  deleteProvider,
  detachProvider,
  inspectMcpProvider,
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
} from "./mcp-bridge-state";
import { validateSandboxName } from "./mcp-bridge-validation";

export type { McpDestroyPreparation } from "./mcp-bridge-destroy-preflight";
export {
  cloneMcpBridgeEntry,
  discardSafeIncompleteMcpAdds,
  inspectExactMcpDestroyProvider,
  prepareMcpBridgesForAbsentSandboxDestroy,
} from "./mcp-bridge-destroy-preflight";

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
