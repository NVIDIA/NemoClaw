// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { McpBridgeEntry } from "../../state/registry";
import {
  rollbackScrubbedMcpAdapters,
  scrubManagedMcpAdapterOrThrow,
} from "./mcp-bridge-adapter-teardown";
import { McpBridgeError } from "./mcp-bridge-contracts";
import {
  cloneMcpBridgeEntry,
  discardSafeIncompleteMcpAdds,
  inspectExactMcpDestroyProvider,
} from "./mcp-bridge-destroy";
import {
  assertGeneratedPolicyMutationSafe,
  assertGeneratedPolicyRegistrationMutationSafe,
} from "./mcp-bridge-policy";
import {
  assertMcpProviderRecoverable,
  attachProvider,
  detachProvider,
  preflightMcpEntryTargets,
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
  scrubbedAdapterEntries: McpBridgeEntry[];
}

async function getCompleteMcpRebuildEntries(
  sandboxName: string,
  options: { sandboxAbsent?: boolean } = {},
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
  const entries = await getCompleteMcpRebuildEntries(sandboxName);
  if (entries.length === 0) {
    return {
      entries: [],
      detachedProviderEntries: [],
      scrubbedAdapterEntries: [],
    };
  }
  await preflightMcpEntryTargets(entries);
  await ensureSandboxGatewaySelected(sandboxName);
  for (const entry of entries) assertGeneratedPolicyMutationSafe(sandboxName, entry);
  assertMcpAdapterTeardownRuntimeCapabilities(sandboxName, sandbox, entries);
  for (const entry of entries) assertMcpProviderRecoverable(entry);
  const detached: McpBridgeEntry[] = [];
  const scrubbedAdapters: McpBridgeEntry[] = [];
  try {
    for (const entry of entries) {
      // `/sandbox` may be a retained PVC. Scrub before delete so a replacement
      // Hermes/agent cannot boot with a stale placeholder while its provider
      // is intentionally detached during recreate.
      scrubManagedMcpAdapterOrThrow(sandboxName, sandbox, entry);
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
    rollbackFailures.push(...rollbackScrubbedMcpAdapters(sandboxName, sandbox, scrubbedAdapters));
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
  const sandbox = getSandboxOrThrow(sandboxName);
  assertMcpAdapterTeardownRuntimeCapabilities(sandboxName, sandbox, [
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
  failures.push(...rollbackScrubbedMcpAdapters(sandboxName, sandbox, scrubbedAdapterEntries));
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
  await restoreExistingMcpBridgeRuntime(sandboxName, entries);
}
