// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { McpBridgeEntry } from "../../state/registry";
import * as registry from "../../state/registry";
import {
  rollbackScrubbedMcpAdapters,
  scrubManagedMcpAdapterOrThrow,
  type McpScrubbedAdapterEntry,
} from "./mcp-bridge-adapter-teardown";
import { MCP_BRIDGE_POLICY_SOURCE, McpBridgeError } from "./mcp-bridge-contracts";
import {
  assertGeneratedPolicyMutationSafe,
  buildRequiredMcpBridgePolicy,
  McpPolicyAuthorityRefusalError,
  qualifyMcpPolicyAuthorityReceipt,
  removeGeneratedPolicy,
  revalidateContainingMcpPolicyAuthority,
  revalidateDeletedMcpPolicyAuthorityReceipt,
  revalidateMcpPolicyAuthorityReceipt,
} from "./mcp-bridge-policy";
import type { McpDestroyPreparation } from "./mcp-bridge-destroy-preflight";
import {
  assertMcpDestroySnapshotCurrent,
  cloneMcpBridgeEntry,
  discardSafeIncompleteMcpAdds,
  inspectExactMcpDestroyProvider,
} from "./mcp-bridge-destroy-preflight";
import {
  deleteProvider,
  detachProvider,
  inspectMcpProvider,
  preflightMcpEntryTargets,
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
  getSandboxOrThrow,
  nowIso,
} from "./mcp-bridge-state";
import { validateSandboxName } from "./mcp-bridge-validation";

export type { McpDestroyPreparation } from "./mcp-bridge-destroy-preflight";
export {
  assertMcpDestroySnapshotCurrent,
  cloneMcpBridgeEntry,
  discardSafeIncompleteMcpAdds,
  inspectExactMcpDestroyProvider,
  prepareMcpBridgesForAbsentSandboxDestroy,
} from "./mcp-bridge-destroy-preflight";

/**
 * Phase one of sandbox destroy. Remove the adapter entry from the retained
 * sandbox volume and detach exact MCP providers while preserving the global
 * provider objects (and therefore their host-only credentials) and registry
 * cleanup manifest. OpenShell requires the bound policy to be removed before
 * detach. Any failure restores the managed runtime before returning.
 */
export async function prepareMcpBridgesForDestroy(
  sandboxName: string,
  validateContainingPolicyReceipt?: () => Promise<void>,
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
  await revalidateContainingMcpPolicyAuthority(validateContainingPolicyReceipt);
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
  const resolvedTargets = await preflightMcpEntryTargets(entries);
  const policyAuthorityReceipt = qualifyMcpPolicyAuthorityReceipt({
    operation: `prepare MCP bridges before destroying sandbox '${sandboxName}'`,
    requiredPolicyContents: entries.map((entry) => {
      const target = resolvedTargets.get(entry.server);
      if (!target) {
        throw new McpBridgeError(
          `MCP server '${entry.server}' has no validated address pins. Refusing destroy preparation.`,
        );
      }
      return buildRequiredMcpBridgePolicy(entry, target);
    }),
    sandboxName,
  });
  const revalidateBeforeMutation = async (): Promise<void> => {
    await revalidateMcpPolicyAuthorityReceipt(
      policyAuthorityReceipt,
      validateContainingPolicyReceipt,
      () => assertMcpDestroySnapshotCurrent(sandboxName, entries),
    );
  };
  const revalidateAfterDelete = async (): Promise<void> => {
    await revalidateDeletedMcpPolicyAuthorityReceipt(
      policyAuthorityReceipt,
      validateContainingPolicyReceipt,
      () => assertMcpDestroySnapshotCurrent(sandboxName, entries),
    );
  };
  const revalidateBeforeSuccess = async (): Promise<void> => {
    await revalidateDeletedMcpPolicyAuthorityReceipt(
      policyAuthorityReceipt,
      validateContainingPolicyReceipt,
    );
  };
  if (destroyAlreadyPrepared) {
    // Phase one completed before a prior process stopped. Requalify and retain
    // its exact current policy requirements before repeating sandbox delete.
    return {
      entries,
      detachedProviderEntries: entries.map(cloneMcpBridgeEntry),
      scrubbedAdapterEntries: entries.map(cloneMcpBridgeEntry),
      revalidateBeforeDelete: revalidateBeforeMutation,
      revalidateAfterDelete,
      revalidateBeforeSuccess,
      destroyAlreadyPrepared: true,
      destroyAlreadyPending: false,
    };
  }
  await ensureSandboxGatewaySelected(sandboxName);
  if (policyAuthorityReceipt.authority === "nemoclaw-managed") {
    for (const entry of entries) assertGeneratedPolicyMutationSafe(sandboxName, entry);
  }
  assertMcpAdapterTeardownRuntimeCapabilities(sandboxName, sandbox, entries);
  const detached: McpBridgeEntry[] = [];
  const scrubbedAdapters: McpScrubbedAdapterEntry[] = [];
  const removedPolicies: McpBridgeEntry[] = [];
  let providerDetachAttempted = false;
  try {
    for (const entry of entries) {
      await revalidateBeforeMutation();
      scrubbedAdapters.push(scrubManagedMcpAdapterOrThrow(sandboxName, sandbox, entry));
    }
    if (policyAuthorityReceipt.authority === "nemoclaw-managed") {
      for (const entry of entries) {
        await revalidateBeforeMutation();
        removeGeneratedPolicy(sandboxName, entry);
        removedPolicies.push(entry);
      }
    }
    for (const entry of entries) {
      await revalidateBeforeMutation();
      inspectExactMcpDestroyProvider(entry, { allowMissing: false });
      providerDetachAttempted = true;
      const detachOutcome = await detachProvider(sandboxName, entry, {
        allowLegacyGeneric: true,
        prepareMutation: revalidateBeforeMutation,
      });
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
    await revalidateBeforeMutation();
    const marked = registry.updateSandbox(sandboxName, {
      mcp: {
        bridges: Object.fromEntries(
          entries.map((entry) => [entry.server, cloneMcpBridgeEntry(entry)]),
        ),
        ...(sandbox.mcp?.managedServerNames
          ? { managedServerNames: sandbox.mcp.managedServerNames }
          : {}),
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
    let runtimeRestored = false;
    let snapshotCurrent = true;
    try {
      assertMcpDestroySnapshotCurrent(sandboxName, entries);
    } catch (snapshotError) {
      snapshotCurrent = false;
      rollbackFailures.push(
        snapshotError instanceof Error ? snapshotError.message : String(snapshotError),
      );
    }
    if (snapshotCurrent && scrubbedAdapters.length > 0) {
      try {
        await restoreExistingMcpBridgeRuntime(sandboxName, scrubbedAdapters, {
          ...(error instanceof McpPolicyAuthorityRefusalError
            ? { teardownPolicyAuthorityRefusal: error }
            : {}),
          lifecyclePhase: "teardown-rollback",
        });
        runtimeRestored = true;
      } catch (rollbackError) {
        rollbackFailures.push(
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        );
      }
    }
    if (
      snapshotCurrent &&
      !runtimeRestored &&
      removedPolicies.length === 0 &&
      !providerDetachAttempted &&
      !(error instanceof McpPolicyAuthorityRefusalError)
    ) {
      rollbackFailures.push(
        ...(await rollbackScrubbedMcpAdapters(
          sandboxName,
          sandbox,
          scrubbedAdapters,
          revalidateBeforeMutation,
        )),
      );
    }
    const current = registry.getSandbox(sandboxName);
    if (runtimeRestored && current?.mcp?.destroyPreparedAt) {
      try {
        registry.updateSandbox(sandboxName, {
          mcp: {
            bridges: Object.fromEntries(
              entries.map((entry) => [entry.server, cloneMcpBridgeEntry(entry)]),
            ),
            ...(current.mcp.managedServerNames
              ? { managedServerNames: current.mcp.managedServerNames }
              : {}),
          },
        });
      } catch (rollbackError) {
        rollbackFailures.push(
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        );
      }
    }
    const detail = error instanceof Error ? error.message : String(error);
    if (error instanceof McpPolicyAuthorityRefusalError) {
      throw new McpPolicyAuthorityRefusalError(
        rollbackFailures.length > 0
          ? `${detail}\nMCP destroy compensation remains pending: ${rollbackFailures.join("; ")}`
          : detail,
      );
    }
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
    revalidateBeforeDelete: revalidateBeforeMutation,
    revalidateAfterDelete,
    revalidateBeforeSuccess,
    destroyAlreadyPrepared: false,
    destroyAlreadyPending: false,
  };
}

/** Recheck exact MCP policy requirements before opening a delete-abort recovery window. */
export async function revalidateMcpDestroyAbortPolicyAuthority(
  sandboxName: string,
  preparation: McpDestroyPreparation,
  validateContainingPolicyReceipt?: () => Promise<void>,
): Promise<void> {
  if (preparation.entries.length === 0 || preparation.destroyAlreadyPending) return;
  await revalidateContainingMcpPolicyAuthority(validateContainingPolicyReceipt);
  const resolvedTargets = await preflightMcpEntryTargets(preparation.entries);
  const receipt = qualifyMcpPolicyAuthorityReceipt({
    operation: `restore MCP bridges after a refused delete of sandbox '${sandboxName}'`,
    requiredPolicyContents: preparation.entries.map((entry) => {
      const target = resolvedTargets.get(entry.server);
      if (!target) {
        throw new McpBridgeError(
          `MCP server '${entry.server}' has no validated address pins. Refusing delete-abort recovery.`,
        );
      }
      return buildRequiredMcpBridgePolicy(entry, target);
    }),
    sandboxName,
  });
  await revalidateMcpPolicyAuthorityReceipt(receipt, undefined, () =>
    assertMcpDestroySnapshotCurrent(sandboxName, preparation.entries),
  );
}

/** Restore all MCP runtime state after OpenShell refused to delete the sandbox. */
export async function restoreMcpBridgesAfterDestroyAbort(
  sandboxName: string,
  preparation: McpDestroyPreparation,
  validateContainingPolicyReceipt?: () => Promise<void>,
): Promise<void> {
  if (preparation.entries.length === 0 || preparation.destroyAlreadyPending) {
    return;
  }
  let authorityRefusal: McpPolicyAuthorityRefusalError | undefined;
  try {
    await revalidateMcpDestroyAbortPolicyAuthority(
      sandboxName,
      preparation,
      validateContainingPolicyReceipt,
    );
  } catch (error) {
    if (!(error instanceof McpPolicyAuthorityRefusalError)) throw error;
    authorityRefusal = error;
  }
  let preparedSandbox: ReturnType<typeof assertMcpDestroySnapshotCurrent>;
  try {
    preparedSandbox = assertMcpDestroySnapshotCurrent(sandboxName, preparation.entries);
  } catch (snapshotError) {
    if (!authorityRefusal) throw snapshotError;
    const snapshotDetail =
      snapshotError instanceof Error ? snapshotError.message : String(snapshotError);
    throw new McpPolicyAuthorityRefusalError(
      `${authorityRefusal.message}\nMCP destroy-abort snapshot validation also failed: ${snapshotDetail}`,
      {
        cause: new AggregateError(
          [authorityRefusal, snapshotError],
          "MCP destroy-abort authority and snapshot validation failed",
        ),
        exitCode: authorityRefusal.exitCode,
        reasonCode: authorityRefusal.reasonCode,
      },
    );
  }
  const destroyPreparedAt = preparedSandbox.mcp?.destroyPreparedAt ?? nowIso();
  const transitioned = registry.updateSandbox(sandboxName, {
    mcp: {
      bridges: Object.fromEntries(
        preparation.entries.map((entry) => [entry.server, cloneMcpBridgeEntry(entry)]),
      ),
      ...(preparedSandbox.mcp?.managedServerNames
        ? { managedServerNames: preparedSandbox.mcp.managedServerNames }
        : {}),
      ...(authorityRefusal ? { destroyPreparedAt } : {}),
    },
  });
  if (!transitioned) {
    throw new McpBridgeError(
      authorityRefusal
        ? `Could not retain prepared MCP destroy state for sandbox '${sandboxName}' before runtime compensation.`
        : `Could not clear prepared MCP destroy state for sandbox '${sandboxName}' before runtime restoration.`,
    );
  }
  try {
    // Reattach only the exact existing providers. This restoration path never
    // reads host secret values and therefore cannot rotate preserved credentials.
    for (const entry of preparation.entries)
      inspectExactMcpDestroyProvider(entry, { allowMissing: false });
    await restoreExistingMcpBridgeRuntime(sandboxName, preparation.entries, {
      ...(authorityRefusal ? { teardownPolicyAuthorityRefusal: authorityRefusal } : {}),
      lifecyclePhase: "teardown-rollback",
      ...(authorityRefusal ? {} : { validateContainingPolicyReceipt }),
    });
  } catch (error) {
    let markerRestoreFailure = "";
    try {
      const restored = registry.updateSandbox(sandboxName, {
        mcp: {
          bridges: Object.fromEntries(
            preparation.entries.map((entry) => [entry.server, cloneMcpBridgeEntry(entry)]),
          ),
          ...(preparedSandbox.mcp?.managedServerNames
            ? { managedServerNames: preparedSandbox.mcp.managedServerNames }
            : {}),
          destroyPreparedAt,
        },
      });
      if (!restored) markerRestoreFailure = "sandbox registry entry disappeared";
    } catch (restoreError) {
      markerRestoreFailure =
        restoreError instanceof Error ? restoreError.message : String(restoreError);
    }
    const detail = error instanceof Error ? error.message : String(error);
    if (authorityRefusal) {
      throw new McpPolicyAuthorityRefusalError(
        `${authorityRefusal.message}\nMCP destroy-abort compensation remains pending: ${
          markerRestoreFailure ? `${detail}; ${markerRestoreFailure}` : detail
        }`,
      );
    }
    if (error instanceof McpPolicyAuthorityRefusalError) {
      throw new McpPolicyAuthorityRefusalError(
        markerRestoreFailure
          ? `${detail}; MCP destroy compensation remains pending: ${markerRestoreFailure}`
          : detail,
      );
    }
    throw new McpBridgeError(
      markerRestoreFailure
        ? `${detail}; could not restore the MCP destroy retry marker: ${markerRestoreFailure}`
        : detail,
    );
  }
  if (authorityRefusal) throw authorityRefusal;
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
        ...(sandbox.mcp?.managedServerNames
          ? { managedServerNames: sandbox.mcp.managedServerNames }
          : {}),
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
    deleteProvider(entry, { allowLegacyGeneric: true, allowMissing: true });
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
