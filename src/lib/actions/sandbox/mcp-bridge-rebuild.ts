// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import YAML from "yaml";

import type { McpBridgeEntry } from "../../state/registry";
import * as policies from "../../policy";
import { isSandboxPolicyCredentialFree } from "../../policy/sandbox-policy-validation";
import {
  rollbackScrubbedMcpAdapters,
  scrubManagedMcpAdapterOrThrow,
  type McpScrubbedAdapterEntry,
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
  buildMcpBridgePolicyKey,
  removeGeneratedPolicy,
} from "./mcp-bridge-policy";
import {
  assertMcpProviderRecoverable,
  assertNoProviderCredentialCollisions,
  assertNoRegisteredProviderCredentialCollisions,
  detachProvider,
  getMcpProviderInspectionRuntimeSelection,
  type McpProviderInspectionRuntimeSelection,
  preflightMcpEntryTargets,
  waitForDetachedMcpCredential,
} from "./mcp-bridge-provider";
import { restoreExistingMcpBridgeRuntime } from "./mcp-bridge-restart";
import { assertMcpAdapterTeardownRuntimeCapabilities } from "./mcp-bridge-runtime-capabilities";
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
  /** Complete live OpenShell policy captured immediately before MCP teardown. */
  policyHandoff?: string;
  /** Full target, policy, provider, and registry proof before delete. */
  revalidateBeforeDelete?: () => Promise<void>;
  /** Final synchronous registry-only proof immediately before delete. */
  assertDeleteEdgeUnchanged?: () => void;
  /** One authority-derived OpenShell target frozen for this rebuild attempt. */
  runtimeSelection?: McpProviderInspectionRuntimeSelection;
}

function policyDocumentsMatch(left: string, right: string): boolean {
  try {
    return isDeepStrictEqual(YAML.parse(left), YAML.parse(right));
  } catch {
    return false;
  }
}

function policyWithoutManagedMcpEntries(
  policyHandoff: string,
  entries: readonly McpBridgeEntry[],
): string {
  return entries.reduce(
    (policy, entry) =>
      policies.removePresetFromPolicy(policy, `  ${buildMcpBridgePolicyKey(entry.server)}: {}\n`),
    policyHandoff,
  );
}

function assertMcpTeardownPolicyUnchanged(
  sandboxName: string,
  expectedTeardownPolicy: string,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
): void {
  const currentPolicy = policies.captureRecordedSandboxBasePolicy(
    sandboxName,
    "verify the live policy before MCP teardown",
    runtimeSelection,
  );
  if (!currentPolicy || !policyDocumentsMatch(currentPolicy, expectedTeardownPolicy)) {
    throw new McpBridgeError(
      `OpenShell policy changed while preparing MCP teardown for sandbox '${sandboxName}'. Refusing sandbox deletion.`,
    );
  }
}

export { prepareMcpBridgesForExecUnavailableRebuild } from "./mcp-bridge-rebuild-exec-unavailable";

async function getCompleteMcpRebuildEntries(
  sandboxName: string,
  options: {
    runtimeSelection?: McpProviderInspectionRuntimeSelection;
    sandboxAbsent?: boolean;
  } = {},
): Promise<{
  entries: McpBridgeEntry[];
  runtimeSelection?: McpProviderInspectionRuntimeSelection;
}> {
  validateSandboxName(sandboxName);
  const currentSandbox = getSandboxOrThrow(sandboxName);
  assertMcpDestroyNotPending(currentSandbox);
  const entriesRequiringExternalCleanup = Object.values(bridgeState(currentSandbox)).filter(
    (entry) => entry.addState !== "prepared",
  );
  let runtimeSelection = options.runtimeSelection;
  if (entriesRequiringExternalCleanup.length > 0) {
    runtimeSelection ??= getMcpProviderInspectionRuntimeSelection(currentSandbox);
  }
  const sandbox = await discardSafeIncompleteMcpAdds(sandboxName, currentSandbox, {
    ...options,
    runtimeSelection,
  });
  const entries = Object.values(bridgeState(sandbox)).map(cloneMcpBridgeEntry);
  const incompleteAdd = entries.find((entry) => entry.addState);
  if (incompleteAdd) {
    throw new McpBridgeError(
      `MCP server '${incompleteAdd.server}' has an incomplete add transaction (${incompleteAdd.addState}). Re-run the original mcp add command or remove it with --force before rebuilding the sandbox.`,
    );
  }
  if (entries.length > 0) {
    runtimeSelection ??= getMcpProviderInspectionRuntimeSelection(sandbox);
  }
  return { entries, runtimeSelection };
}

/**
 * Preserve MCP intent for stale-registry recovery after OpenShell has already
 * proved the sandbox absent. There is no sandbox process or retained adapter
 * to scrub, so this path validates targets and provider recoverability without
 * attempting sandbox exec or changing provider attachment state.
 */
export async function prepareMcpBridgesForAbsentSandboxRebuild(
  sandboxName: string,
  runtimeSelection?: McpProviderInspectionRuntimeSelection,
): Promise<McpRebuildPreparation> {
  const { entries, runtimeSelection: providerRuntimeSelection } =
    await getCompleteMcpRebuildEntries(sandboxName, { sandboxAbsent: true, runtimeSelection });
  if (entries.length === 0) {
    return {
      entries: [],
      detachedProviderEntries: [],
      scrubbedAdapterEntries: [],
      runtimeSelection: providerRuntimeSelection,
    };
  }
  if (!providerRuntimeSelection) {
    throw new McpBridgeError(`Could not resolve MCP runtime authority for '${sandboxName}'.`);
  }
  await preflightMcpEntryTargets(entries);
  await ensureSandboxGatewaySelected(sandboxName, providerRuntimeSelection);
  for (const entry of entries) {
    assertGeneratedPolicyRegistrationMutationSafe(sandboxName, entry);
  }
  for (const entry of entries) assertMcpProviderRecoverable(entry, providerRuntimeSelection);
  assertNoRegisteredProviderCredentialCollisions(entries, {
    runtimeSelection: providerRuntimeSelection,
  });
  return {
    entries,
    detachedProviderEntries: [],
    scrubbedAdapterEntries: [],
    runtimeSelection: providerRuntimeSelection,
  };
}

export async function prepareMcpBridgesForRebuild(
  sandboxName: string,
  runtimeSelection?: McpProviderInspectionRuntimeSelection,
): Promise<McpRebuildPreparation> {
  const sandbox = getSandboxOrThrow(sandboxName);
  const { entries, runtimeSelection: providerRuntimeSelection } =
    await getCompleteMcpRebuildEntries(sandboxName, { runtimeSelection });
  if (entries.length === 0) {
    return {
      entries: [],
      detachedProviderEntries: [],
      scrubbedAdapterEntries: [],
      runtimeSelection: providerRuntimeSelection,
    };
  }
  if (!providerRuntimeSelection) {
    throw new McpBridgeError(`Could not resolve MCP runtime authority for '${sandboxName}'.`);
  }
  await preflightMcpEntryTargets(entries);
  await ensureSandboxGatewaySelected(sandboxName, providerRuntimeSelection);
  for (const entry of entries) assertGeneratedPolicyMutationSafe(sandboxName, entry);
  assertMcpAdapterTeardownRuntimeCapabilities(
    sandboxName,
    sandbox,
    entries,
    providerRuntimeSelection,
  );
  for (const entry of entries) assertMcpProviderRecoverable(entry, providerRuntimeSelection);
  assertNoProviderCredentialCollisions(sandboxName, entries, providerRuntimeSelection);
  // This is the bounded replacement handoff, not a durable NemoClaw policy
  // record. Capture OpenShell immediately before the internal teardown
  // mutations so the replacement receives the complete operator-owned
  // document, including the MCP rules that must be removed temporarily from
  // the still-running source sandbox before provider detach.
  const policyHandoff = policies.captureRecordedSandboxBasePolicy(
    sandboxName,
    "capture the live policy before MCP teardown",
    providerRuntimeSelection,
  );
  if (!policyHandoff) {
    throw new McpBridgeError(
      `Could not capture the live OpenShell policy before MCP teardown for sandbox '${sandboxName}'.`,
    );
  }
  if (!isSandboxPolicyCredentialFree(policyHandoff)) {
    throw new McpBridgeError(
      `Cannot prepare the MCP rebuild policy handoff for sandbox '${sandboxName}' because its live OpenShell policy contains a literal credential value. Replace literal credentials with supported OpenShell credential bindings or resolver placeholders, then retry the rebuild.`,
    );
  }
  const expectedTeardownPolicy = policyWithoutManagedMcpEntries(policyHandoff, entries);
  const detached: McpBridgeEntry[] = [];
  const scrubbedAdapters: McpScrubbedAdapterEntry[] = [];
  const removedPolicies: McpBridgeEntry[] = [];
  try {
    for (const entry of entries) {
      // `/sandbox` may be a retained PVC. Scrub before delete so a replacement
      // Hermes/agent cannot boot with a stale placeholder while its provider
      // is intentionally detached during recreate.
      scrubbedAdapters.push(
        scrubManagedMcpAdapterOrThrow(sandboxName, sandbox, entry, providerRuntimeSelection),
      );
    }
    for (const entry of entries) {
      // The same-name replacement journal fingerprints this source row before
      // MCP teardown removes the live entry from the source sandbox. Rebuild's
      // OpenShell policy handoff already captured the complete live document.
      removeGeneratedPolicy(sandboxName, entry, {
        runtimeSelection: providerRuntimeSelection,
      });
      removedPolicies.push(entry);
    }
    for (const entry of entries) {
      // Keep the provider and its host-only credentials for the replacement
      // sandbox, but detach it before OpenShell deletes the old attachment.
      inspectExactMcpDestroyProvider(entry, {
        allowMissing: false,
        runtimeSelection: providerRuntimeSelection,
      });
      const detachOutcome = detachProvider(sandboxName, entry, {
        runtimeSelection: providerRuntimeSelection,
      });
      if (detachOutcome === "unknown") {
        throw new McpBridgeError(
          `Could not prove provider detach for MCP server '${entry.server}'.`,
        );
      }
      waitForDetachedMcpCredential(sandboxName, entry, providerRuntimeSelection);
      // A binding already absent on retry was still detached by this rebuild
      // transaction (possibly before a prior process died), so it must be
      // reattached if sandbox deletion later aborts.
      detached.push(entry);
    }
    assertMcpTeardownPolicyUnchanged(sandboxName, expectedTeardownPolicy, providerRuntimeSelection);
  } catch (error) {
    const rollbackFailures: string[] = [];
    let runtimeRestored = false;
    if (removedPolicies.length > 0) {
      try {
        await restoreExistingMcpBridgeRuntime(sandboxName, removedPolicies, {
          lifecyclePhase: "teardown-rollback",
          runtimeSelection: providerRuntimeSelection,
        });
        runtimeRestored = true;
      } catch (rollbackError) {
        rollbackFailures.push(
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        );
      }
    }
    if (!runtimeRestored) {
      rollbackFailures.push(
        ...rollbackScrubbedMcpAdapters(
          sandboxName,
          sandbox,
          scrubbedAdapters,
          providerRuntimeSelection,
        ),
      );
    }
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
    policyHandoff,
    runtimeSelection: providerRuntimeSelection,
    revalidateBeforeDelete: async () => {
      assertMcpTeardownPolicyUnchanged(
        sandboxName,
        expectedTeardownPolicy,
        providerRuntimeSelection,
      );
    },
  };
}

export async function reattachMcpProvidersAfterRebuildAbort(
  sandboxName: string,
  entries: readonly McpBridgeEntry[],
  scrubbedAdapterEntries: readonly McpScrubbedAdapterEntry[] = [],
  runtimeSelection?: McpProviderInspectionRuntimeSelection,
): Promise<void> {
  if (entries.length === 0 && scrubbedAdapterEntries.length === 0) return;
  const sandbox = getSandboxOrThrow(sandboxName);
  const providerRuntimeSelection =
    runtimeSelection ?? getMcpProviderInspectionRuntimeSelection(sandbox);
  await ensureSandboxGatewaySelected(sandboxName, providerRuntimeSelection);
  assertMcpAdapterTeardownRuntimeCapabilities(
    sandboxName,
    sandbox,
    [...entries, ...scrubbedAdapterEntries],
    providerRuntimeSelection,
  );

  const failures: string[] = [];
  let runtimeRestored = false;
  if (entries.length > 0) {
    try {
      await restoreExistingMcpBridgeRuntime(sandboxName, entries, {
        lifecyclePhase: "teardown-rollback",
        runtimeSelection: providerRuntimeSelection,
      });
      runtimeRestored = true;
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (!runtimeRestored) {
    failures.push(
      ...rollbackScrubbedMcpAdapters(
        sandboxName,
        sandbox,
        scrubbedAdapterEntries,
        providerRuntimeSelection,
      ),
    );
  }
  if (failures.length > 0) {
    throw new McpBridgeError(failures.join("; "));
  }
}

export async function restoreMcpBridgesAfterRebuild(
  sandboxName: string,
  entries: readonly McpBridgeEntry[],
  runtimeSelection?: McpProviderInspectionRuntimeSelection,
): Promise<void> {
  if (entries.length === 0) return;
  for (const entry of entries) assertAuthenticatedBridgeEntry(entry);
  const bridges = Object.fromEntries(
    entries.map((entry) => [entry.server, cloneMcpBridgeEntry(entry)]),
  );
  // Persist the recovery contract before touching the gateway. If refresh
  // fails, `mcp restart` remains retryable after the operator fixes the cause.
  setBridgeState(sandboxName, bridges);
  // Sandbox creation already received the complete pre-rebuild OpenShell
  // policy. Restore providers and adapters without regenerating or overwriting
  // policy entries that an operator may have edited independently.
  await restoreExistingMcpBridgeRuntime(sandboxName, entries, {
    applyPolicy: false,
    ...(runtimeSelection ? { runtimeSelection } : {}),
  });
}
