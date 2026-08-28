// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentMcpAdapter } from "../../agent/defs";
import { withMcpLifecycleLock } from "../../state/mcp-lifecycle-lock";
import { assertHermesPortableCommandUnavailable } from "../../onboard/experimental/portable-agent-lifecycle";
import type { McpBridgeEntry } from "../../state/registry";
import { registerAgentAdapterAtCurrentCredentialRevision } from "./mcp-bridge-adapters";
import { McpBridgeError } from "./mcp-bridge-contracts";
import { assertHermesMcpRuntimeIntent } from "./mcp-bridge-hermes-reconciliation";
import {
  applyGeneratedPolicy,
  assertGeneratedPolicyMutationSafe,
  buildRequiredMcpBridgePolicy,
  McpPolicyAuthorityRefusalError,
  preflightMcpPolicyAuthority,
  qualifyMcpPolicyAuthorityReceipt,
  revalidateContainingMcpPolicyAuthority,
  revalidateMcpPolicyAuthorityReceipt,
} from "./mcp-bridge-policy";
import {
  assertMcpProviderRecoverable,
  assertNoAttachedProviderCredentialCollisions,
  assertNoProviderCredentialCollisions,
  attachProvider,
  detachMissingProviderReference,
  ensureMcpBridgeProviderProfile,
  refreshMcpProviderEnvironment,
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
import type { McpBridgeTargetValidation } from "./mcp-bridge-url-validation";
import {
  assertAuthenticatedBridgeEntry,
  assertMcpCredentialBoundaryRuntimeVersion,
  resolveCredentialEnv,
  validateSandboxName,
} from "./mcp-bridge-validation";

function resolvedTargetPins(
  resolvedByServer: ReadonlyMap<string, McpBridgeTargetValidation>,
  entry: McpBridgeEntry,
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
  assertMcpDestroyNotPending(sandbox);
  const agent = getSandboxAgent(sandbox);
  const adapter = getBridgeAdapter(agent);
  const bridges = bridgeState(sandbox);
  const targets = server ? [[server, bridges[server]] as const] : Object.entries(bridges);
  if (targets.length === 0) {
    if (adapter === "hermes-config") assertHermesMcpRuntimeIntent(sandboxName);
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
  const operation = server ? `restart MCP server '${server}'` : "restart managed MCP servers";
  const requiredPolicyContents = targetEntries.map((entry) =>
    buildRequiredMcpBridgePolicy(entry, resolvedTargetPins(resolvedByServer, entry)),
  );
  const recheckPolicyAuthority = () =>
    preflightMcpPolicyAuthority({
      externalPolicy: "verify",
      operation,
      requiredPolicyContents,
      sandboxName,
    });
  const policyAuthority = recheckPolicyAuthority();
  assertMcpCredentialBoundaryRuntimeVersion();
  await ensureSandboxGatewaySelected(sandboxName);
  // Prove every policy key is absent or still matches its recorded ownership
  // before inspecting or updating any provider. `applyGeneratedPolicy` repeats
  // this check immediately before mutation to close the preflight-to-apply race.
  if (policyAuthority === "nemoclaw-managed") {
    for (const entry of targetEntries) assertGeneratedPolicyMutationSafe(sandboxName, entry);
  }
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
  recheckPolicyAuthority();
  for (const entry of missingProviderEntries) {
    recheckPolicyAuthority();
    detachMissingProviderReference(sandboxName, entry);
  }
  assertMcpAdapterMutationRuntimeCapabilities(sandboxName, sandbox, targetEntries);
  for (const entry of missingProviderEntries) {
    waitForDetachedMcpCredential(sandboxName, entry);
  }
  // Inspect registered providers once before the first mutation. Per-entry
  // checks below inspect only attached providers at each mutation edge.
  assertNoProviderCredentialCollisions(sandboxName, targetEntries);
  for (const [name, storedEntry] of targets) {
    // Validated as a complete authenticated entry before gateway side effects.
    if (!storedEntry) continue;
    let entry = storedEntry;
    const envRefs = entry.env.map((envName) => ({ name: envName }));
    const adapterEnvValues = resolveCredentialEnv(envRefs);
    const target = resolvedTargetPins(resolvedByServer, entry);
    let previousCredentialRevision: McpCredentialRevisionObservation | undefined;
    assertNoAttachedProviderCredentialCollisions(sandboxName, [entry]);
    // Revalidate the actual running supervisor before rotating or recreating
    // credentials. The temporary policy cannot bind the provider until an
    // endpointless profile is attached.
    recheckPolicyAuthority();
    ensureMcpBridgeProviderProfile();
    if (policyAuthority === "nemoclaw-managed") {
      applyGeneratedPolicy(sandboxName, entry, target, { bindCredential: false });
    }
    const providerResult = upsertMcpProvider(entry.providerName ?? "", envRefs, {
      allowExisting: true,
      expectedProviderId: entry.providerId,
      prepareMutation: (action) => {
        recheckPolicyAuthority();
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
      // replacement object's immutable ID as recovery state before another
      // authority check can refuse policy, attachment, or adapter work.
      writeBridgeEntry(sandboxName, refreshedEntry);
      entry = refreshedEntry;
      recheckPolicyAuthority();
    }
    assertNoAttachedProviderCredentialCollisions(sandboxName, [entry]);
    if (providerResult.action === "updated" && previousCredentialRevision === undefined) {
      throw new McpBridgeError(
        `Could not retain the prior OpenShell credential revision for provider '${entry.providerName}'.`,
      );
    }
    recheckPolicyAuthority();
    attachProvider(sandboxName, entry);
    if (policyAuthority === "nemoclaw-managed") {
      applyGeneratedPolicy(sandboxName, entry, target);
    }
    recheckPolicyAuthority();
    refreshMcpProviderEnvironment(entry);
    const entryAdapter = (entry.adapter as AgentMcpAdapter | undefined) ?? adapter;
    const credentialRevision = waitForAttachedMcpCredential(sandboxName, entry, {
      ...(providerResult.action === "updated"
        ? { previousRevision: previousCredentialRevision }
        : {}),
    });
    recheckPolicyAuthority();
    registerAgentAdapterAtCurrentCredentialRevision(
      sandboxName,
      entryAdapter,
      entry,
      adapterEnvValues,
      credentialRevision,
      { replaceExisting: true },
    );
    recheckPolicyAuthority();
    writeBridgeEntry(sandboxName, {
      ...entry,
      adapter: (entry.adapter as AgentMcpAdapter | undefined) ?? adapter,
      updatedAt: nowIso(),
    });
    recheckPolicyAuthority();
    console.log(`  Refreshed MCP server '${name}'.`);
  }
  if (adapter === "hermes-config") assertHermesMcpRuntimeIntent(sandboxName);
}

export async function restoreExistingMcpBridgeRuntime(
  sandboxName: string,
  entries: readonly McpBridgeEntry[],
  options: {
    lifecyclePhase?: "active-mutation" | "teardown-rollback";
    /** Final refusal retained by the teardown caller while owned runtime compensation runs. */
    teardownPolicyAuthorityRefusal?: McpPolicyAuthorityRefusalError;
    validateContainingPolicyReceipt?: () => Promise<void>;
  } = {},
): Promise<void> {
  if (entries.length === 0) return;
  for (const entry of entries) assertAuthenticatedBridgeEntry(entry);
  const teardownRollback = options.lifecyclePhase === "teardown-rollback";
  const resolvedByServer = await preflightMcpEntryTargets(entries);
  const sandbox = getSandboxOrThrow(sandboxName);
  if (!teardownRollback || sandbox.mcp?.destroyPendingAt) {
    assertMcpDestroyNotPending(sandbox);
  }
  let teardownAuthorityRefusal = teardownRollback
    ? options.teardownPolicyAuthorityRefusal
    : undefined;
  let policyAuthorityReceipt: ReturnType<typeof qualifyMcpPolicyAuthorityReceipt> | undefined;
  if (!teardownAuthorityRefusal) {
    try {
      policyAuthorityReceipt = qualifyMcpPolicyAuthorityReceipt({
        operation: teardownRollback
          ? "restore managed MCP runtime after teardown abort"
          : "restore managed MCP runtime",
        requiredPolicyContents: entries.map((entry) =>
          buildRequiredMcpBridgePolicy(entry, resolvedTargetPins(resolvedByServer, entry)),
        ),
        sandboxName,
      });
    } catch (error) {
      if (!teardownRollback || !(error instanceof McpPolicyAuthorityRefusalError)) throw error;
      // Live policy must not change after this refusal. Provider and adapter
      // compensation still runs below, then the refusal reports that policy
      // restoration remains pending.
      teardownAuthorityRefusal = error;
    }
  }
  const revalidateBeforeMutation = () =>
    !teardownRollback && policyAuthorityReceipt
      ? revalidateMcpPolicyAuthorityReceipt(
          policyAuthorityReceipt,
          options.validateContainingPolicyReceipt,
        )
      : Promise.resolve();
  const observeTeardownContainingReceipt = async (): Promise<void> => {
    if (!teardownRollback || teardownAuthorityRefusal) return;
    try {
      await revalidateContainingMcpPolicyAuthority(options.validateContainingPolicyReceipt);
    } catch (error) {
      if (!(error instanceof McpPolicyAuthorityRefusalError)) throw error;
      teardownAuthorityRefusal = error;
    }
  };
  const revalidateBeforeRuntimeMutation = async (): Promise<void> => {
    await revalidateBeforeMutation();
    await observeTeardownContainingReceipt();
  };
  const policyAuthority = policyAuthorityReceipt?.authority ?? sandbox.policyAuthority;
  const runTeardownPolicyMutation = async (mutation: () => void): Promise<boolean> => {
    if (!teardownRollback) {
      mutation();
      return true;
    }
    await observeTeardownContainingReceipt();
    if (teardownAuthorityRefusal || !policyAuthorityReceipt) return false;
    try {
      // The containing lifecycle receipt can already be the reason teardown
      // aborted. Recheck the MCP receipt itself so owned compensation does not
      // reuse a stale enclosing receipt.
      await revalidateMcpPolicyAuthorityReceipt(policyAuthorityReceipt);
      mutation();
      return true;
    } catch (error) {
      if (!(error instanceof McpPolicyAuthorityRefusalError)) throw error;
      teardownAuthorityRefusal = error;
      return false;
    }
  };
  if (!teardownRollback) {
    assertMcpCredentialBoundaryRuntimeVersion();
  }
  await revalidateBeforeMutation();
  await ensureSandboxGatewaySelected(sandboxName);
  if (teardownRollback) {
    // A failed delete/rebuild must be able to restore a backward-compatible
    // Deep Agents entry on the same old image it just scrubbed. New/rebuilt
    // images use the default path and must prove the current marker before any
    // policy, provider, attachment, or adapter mutation.
    assertMcpAdapterTeardownRuntimeCapabilities(sandboxName, sandbox, entries);
  } else {
    assertMcpAdapterMutationRuntimeCapabilities(sandboxName, sandbox, entries);
  }
  const defaultAdapter = getBridgeAdapter(getSandboxAgent(sandbox));
  for (const entry of entries) {
    if (policyAuthority === "nemoclaw-managed") {
      if (teardownRollback) {
        await runTeardownPolicyMutation(() =>
          assertGeneratedPolicyMutationSafe(sandboxName, entry),
        );
      } else {
        assertGeneratedPolicyMutationSafe(sandboxName, entry);
      }
    }
    const provider = assertMcpProviderRecoverable(entry);
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
  assertNoProviderCredentialCollisions(sandboxName, entries);
  for (const entry of entries) {
    assertNoAttachedProviderCredentialCollisions(sandboxName, [entry]);
    await revalidateBeforeRuntimeMutation();
    ensureMcpBridgeProviderProfile();
    if (policyAuthority === "nemoclaw-managed") {
      if (teardownRollback) {
        await runTeardownPolicyMutation(() =>
          applyGeneratedPolicy(sandboxName, entry, resolvedTargetPins(resolvedByServer, entry), {
            bindCredential: false,
          }),
        );
      } else {
        await revalidateBeforeMutation();
        applyGeneratedPolicy(sandboxName, entry, resolvedTargetPins(resolvedByServer, entry), {
          bindCredential: false,
        });
      }
    }
    await revalidateBeforeRuntimeMutation();
    attachProvider(sandboxName, entry);
    if (policyAuthority === "nemoclaw-managed") {
      if (teardownRollback) {
        await runTeardownPolicyMutation(() =>
          applyGeneratedPolicy(sandboxName, entry, resolvedTargetPins(resolvedByServer, entry)),
        );
      } else {
        await revalidateBeforeMutation();
        applyGeneratedPolicy(sandboxName, entry, resolvedTargetPins(resolvedByServer, entry));
      }
    }
    await revalidateBeforeRuntimeMutation();
    refreshMcpProviderEnvironment(entry);
    const credentialRevision = waitForAttachedMcpCredential(sandboxName, entry);
    const adapter = (entry.adapter as AgentMcpAdapter | undefined) ?? defaultAdapter;
    await revalidateBeforeRuntimeMutation();
    registerAgentAdapterAtCurrentCredentialRevision(
      sandboxName,
      adapter,
      entry,
      {},
      credentialRevision,
      {
        replaceExisting: true,
        teardownRollback,
      },
    );
    if (!teardownRollback) {
      await revalidateBeforeMutation();
      writeBridgeEntry(sandboxName, { ...entry, adapter, updatedAt: nowIso() });
    }
  }
  if (
    defaultAdapter === "hermes-config" ||
    entries.some((entry) => entry.adapter === "hermes-config")
  ) {
    assertHermesMcpRuntimeIntent(sandboxName, { entries });
  }
  if (teardownRollback && policyAuthorityReceipt) {
    await runTeardownPolicyMutation(() => undefined);
  }
  if (teardownAuthorityRefusal && !options.teardownPolicyAuthorityRefusal) {
    throw teardownAuthorityRefusal;
  }
}
