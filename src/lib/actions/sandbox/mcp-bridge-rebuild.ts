// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { McpBridgeEntry } from "../../state/registry";
import {
  rollbackScrubbedMcpAdapters,
  scrubManagedMcpAdapterOrThrow,
  type McpScrubbedAdapterEntry,
} from "./mcp-bridge-adapter-teardown";
import { McpBridgeError } from "./mcp-bridge-contracts";
import {
  assertMcpDestroySnapshotCurrent,
  cloneMcpBridgeEntry,
  discardSafeIncompleteMcpAdds,
  inspectExactMcpDestroyProvider,
} from "./mcp-bridge-destroy";
import {
  assertGeneratedPolicyMutationSafe,
  assertGeneratedPolicyRegistrationMutationSafe,
  buildRequiredMcpBridgePolicy,
  McpPolicyAuthorityRefusalError,
  qualifyMcpPolicyAuthorityReceipt,
  removeGeneratedPolicy,
  revalidateContainingMcpPolicyAuthority,
  revalidateMcpPolicyAuthorityReceipt,
} from "./mcp-bridge-policy";
import {
  assertMcpProviderRecoverable,
  assertNoProviderCredentialCollisions,
  assertNoRegisteredProviderCredentialCollisions,
  attachProvider,
  detachProvider,
  preflightMcpEntryTargets,
  refreshMcpProviderEnvironment,
  waitForAttachedMcpCredential,
  waitForDetachedMcpCredential,
} from "./mcp-bridge-provider";
import { restoreExistingMcpBridgeRuntime } from "./mcp-bridge-restart";
import {
  assertMcpAdapterConfigMutationsAllowed,
  assertMcpAdapterTeardownRuntimeCapabilities,
} from "./mcp-bridge-runtime-capabilities";
import {
  assertMcpDestroyNotPending,
  bridgeState,
  ensureSandboxGatewaySelected,
  getSandboxOrThrow,
  setBridgeState,
} from "./mcp-bridge-state";
import { assertAuthenticatedBridgeEntry, validateSandboxName } from "./mcp-bridge-validation";

export interface McpRebuildPreparation {
  entries: McpBridgeEntry[];
  detachedProviderEntries: McpBridgeEntry[];
  scrubbedAdapterEntries: McpScrubbedAdapterEntry[];
  /** Full read-only target, policy, provider, and registry proof before delete. */
  revalidateBeforeDelete?: () => Promise<void>;
  /** Final synchronous registry-only proof immediately before delete. */
  assertDeleteEdgeUnchanged?: () => void;
}

export { prepareMcpBridgesForExecUnavailableRebuild } from "./mcp-bridge-rebuild-exec-unavailable";

async function getCompleteMcpRebuildEntries(
  sandboxName: string,
  options: { sandboxAbsent?: boolean } = {},
  validateContainingPolicyReceipt?: () => Promise<void>,
): Promise<McpBridgeEntry[]> {
  validateSandboxName(sandboxName);
  const currentSandbox = getSandboxOrThrow(sandboxName);
  assertMcpDestroyNotPending(currentSandbox);
  if (!options.sandboxAbsent) {
    const entriesRequiringExternalCleanup = Object.values(bridgeState(currentSandbox)).filter(
      (entry) => entry.addState !== "prepared",
    );
    // This host-visible config preflight must precede
    // discardSafeIncompleteMcpAdds, which can remove an owned policy for a
    // providerless preflighted add. That cleanup has no adapter/provider to
    // probe; complete entries get the teardown runtime probe below.
    assertMcpAdapterConfigMutationsAllowed(
      sandboxName,
      currentSandbox,
      entriesRequiringExternalCleanup,
    );
  }
  await revalidateContainingMcpPolicyAuthority(validateContainingPolicyReceipt);
  const sandbox = await discardSafeIncompleteMcpAdds(sandboxName, currentSandbox, options);
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
  const entries = await getCompleteMcpRebuildEntries(sandboxName, { sandboxAbsent: true });
  if (entries.length === 0) {
    return {
      entries: [],
      detachedProviderEntries: [],
      scrubbedAdapterEntries: [],
    };
  }
  await preflightMcpEntryTargets(entries);
  await ensureSandboxGatewaySelected(sandboxName);
  for (const entry of entries) {
    assertGeneratedPolicyRegistrationMutationSafe(sandboxName, entry);
  }
  for (const entry of entries) assertMcpProviderRecoverable(entry);
  assertNoRegisteredProviderCredentialCollisions(entries);
  return {
    entries,
    detachedProviderEntries: [],
    scrubbedAdapterEntries: [],
  };
}

export async function prepareMcpBridgesForRebuild(
  sandboxName: string,
  validateContainingPolicyReceipt?: () => Promise<void>,
): Promise<McpRebuildPreparation> {
  const sandbox = getSandboxOrThrow(sandboxName);
  const entries = await getCompleteMcpRebuildEntries(
    sandboxName,
    undefined,
    validateContainingPolicyReceipt,
  );
  if (entries.length === 0) {
    return {
      entries: [],
      detachedProviderEntries: [],
      scrubbedAdapterEntries: [],
    };
  }
  const resolvedTargets = await preflightMcpEntryTargets(entries);
  const policyAuthorityReceipt = qualifyMcpPolicyAuthorityReceipt({
    operation: `prepare MCP bridges before rebuilding sandbox '${sandboxName}'`,
    requiredPolicyContents: entries.map((entry) => {
      const target = resolvedTargets.get(entry.server);
      if (!target) {
        throw new McpBridgeError(
          `MCP server '${entry.server}' has no validated address pins. Refusing rebuild preparation.`,
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
  await ensureSandboxGatewaySelected(sandboxName);
  if (policyAuthorityReceipt.authority === "nemoclaw-managed") {
    for (const entry of entries) assertGeneratedPolicyMutationSafe(sandboxName, entry);
  }
  assertMcpAdapterTeardownRuntimeCapabilities(sandboxName, sandbox, entries);
  for (const entry of entries) assertMcpProviderRecoverable(entry);
  assertNoProviderCredentialCollisions(sandboxName, entries);
  const detached: McpBridgeEntry[] = [];
  const scrubbedAdapters: McpScrubbedAdapterEntry[] = [];
  const removedPolicies: McpBridgeEntry[] = [];
  let providerDetachAttempted = false;
  try {
    for (const entry of entries) {
      // `/sandbox` may be a retained PVC. Scrub before delete so a replacement
      // Hermes/agent cannot boot with a stale placeholder while its provider
      // is intentionally detached during recreate.
      await revalidateBeforeMutation();
      scrubbedAdapters.push(scrubManagedMcpAdapterOrThrow(sandboxName, sandbox, entry));
    }
    if (policyAuthorityReceipt.authority === "nemoclaw-managed") {
      for (const entry of entries) {
        // The same-name replacement journal fingerprints this source row before
        // MCP teardown. Keep exact generated-policy ownership in that preserved
        // row while removing only the live policy; inner onboarding excludes the
        // generated name and post-rebuild restoration reuses this ownership.
        await revalidateBeforeMutation();
        removeGeneratedPolicy(sandboxName, entry, { preserveRegistryOwnership: true });
        removedPolicies.push(entry);
      }
    }
    for (const entry of entries) {
      // Keep the provider and its host-only credentials for the replacement
      // sandbox, but detach it before OpenShell deletes the old attachment.
      await revalidateBeforeMutation();
      inspectExactMcpDestroyProvider(entry, { allowMissing: false });
      providerDetachAttempted = true;
      const detachOutcome = await detachProvider(sandboxName, entry, {
        prepareMutation: revalidateBeforeMutation,
      });
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
    const detail = error instanceof Error ? error.message : String(error);
    if (error instanceof McpPolicyAuthorityRefusalError) {
      throw new McpPolicyAuthorityRefusalError(
        rollbackFailures.length > 0
          ? `${detail}\nMCP rebuild compensation remains pending: ${rollbackFailures.join("; ")}`
          : detail,
      );
    }
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
  scrubbedAdapterEntries: readonly McpScrubbedAdapterEntry[] = [],
  validateContainingPolicyReceipt?: () => Promise<void>,
): Promise<void> {
  if (entries.length === 0 && scrubbedAdapterEntries.length === 0) return;
  let authorityRefusal: McpPolicyAuthorityRefusalError | undefined;
  try {
    await revalidateContainingMcpPolicyAuthority(validateContainingPolicyReceipt);
  } catch (error) {
    if (!(error instanceof McpPolicyAuthorityRefusalError)) throw error;
    authorityRefusal = error;
  }
  await ensureSandboxGatewaySelected(sandboxName);
  const sandbox = getSandboxOrThrow(sandboxName);
  assertMcpAdapterTeardownRuntimeCapabilities(sandboxName, sandbox, [
    ...entries,
    ...scrubbedAdapterEntries,
  ]);

  const failures: string[] = [];
  let runtimeRestored = false;
  if (entries.length > 0) {
    try {
      await restoreExistingMcpBridgeRuntime(sandboxName, entries, {
        ...(authorityRefusal ? { teardownPolicyAuthorityRefusal: authorityRefusal } : {}),
        lifecyclePhase: "teardown-rollback",
        ...(authorityRefusal ? {} : { validateContainingPolicyReceipt }),
      });
      runtimeRestored = true;
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (!runtimeRestored && !authorityRefusal) {
    failures.push(
      ...(await rollbackScrubbedMcpAdapters(sandboxName, sandbox, scrubbedAdapterEntries, () =>
        revalidateContainingMcpPolicyAuthority(validateContainingPolicyReceipt),
      )),
    );
  }
  if (failures.length > 0) {
    if (authorityRefusal) {
      throw new McpPolicyAuthorityRefusalError(
        `${authorityRefusal.message}\nMCP rebuild-abort compensation remains pending: ${failures.join("; ")}`,
      );
    }
    throw new McpBridgeError(failures.join("; "));
  }
  if (authorityRefusal) throw authorityRefusal;
}

export async function restoreMcpBridgesAfterRebuild(
  sandboxName: string,
  entries: readonly McpBridgeEntry[],
  validateContainingPolicyReceipt?: () => Promise<void>,
): Promise<void> {
  if (entries.length === 0) return;
  for (const entry of entries) assertAuthenticatedBridgeEntry(entry);
  const bridges = Object.fromEntries(
    entries.map((entry) => [entry.server, cloneMcpBridgeEntry(entry)]),
  );
  // Persist the recovery contract before touching the gateway. If refresh
  // fails, `mcp restart` remains retryable after the operator fixes the cause.
  await revalidateContainingMcpPolicyAuthority(validateContainingPolicyReceipt);
  setBridgeState(sandboxName, bridges);
  await revalidateContainingMcpPolicyAuthority(validateContainingPolicyReceipt);
  await restoreExistingMcpBridgeRuntime(sandboxName, entries, {
    validateContainingPolicyReceipt,
  });
  await revalidateContainingMcpPolicyAuthority(validateContainingPolicyReceipt);
}
