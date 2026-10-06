// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { assertHermesPortableCommandUnavailable } from "../../onboard/experimental/portable-agent-lifecycle";
import { withMcpLifecycleLock } from "../../state/mcp-lifecycle-lock";
import {
  readLegacyMcpRegistryProjection,
  removeLegacyMcpRegistryEntry,
} from "../../state/registry/legacy-mcp";
import {
  assertAgentMcpTeardownRuntimeCapability,
  unregisterAgentAdapter,
} from "./mcp-bridge-adapters";
import { isAgentMcpAdapter, McpBridgeError, type McpSourceEntry } from "./mcp-bridge-contracts";
import { removeGeneratedPolicy } from "./mcp-bridge-policy";
import { readCommittedLegacyRegistryEntries, sameMcpRegistration } from "./mcp-bridge-source";
import {
  detachProvider,
  getMcpProviderInspectionRuntimeSelection,
  inspectMcpProvider,
  providerMatchesManagedCredential,
  waitForDetachedMcpCredential,
} from "./mcp-bridge-provider";
import {
  ensureSandboxGatewaySelected,
  getBridgeAdapter,
  getSandboxAgent,
  getSandboxOrThrow,
} from "./mcp-bridge-state";
import {
  inspectPolicyOnlyMcpEntry,
  inspectAgentMcpSources,
  inspectSourceBridgeState,
  removeLegacyAgentMcpEntry,
} from "./mcp-bridge-source";
import {
  resolvePersistedCredentialEnvForRedaction,
  validateMcpServerName,
  validateSandboxName,
} from "./mcp-bridge-validation";

export async function removeMcpBridge(
  sandboxName: string,
  server: string,
  options: { force?: boolean; allowResidual?: boolean } = {},
): Promise<void> {
  return withMcpLifecycleLock(sandboxName, async () => {
    assertHermesPortableCommandUnavailable(sandboxName, "sandbox:mcp:remove");
    validateSandboxName(sandboxName);
    validateMcpServerName(server);
    const sandbox = getSandboxOrThrow(sandboxName);
    const runtimeSelection = getMcpProviderInspectionRuntimeSelection(sandbox);
    const observed = await inspectSourceBridgeState(sandbox, runtimeSelection);
    const agent = getSandboxAgent(sandbox);
    let entry: McpSourceEntry | undefined;
    let removedLegacySource = false;
    const legacyEntry = observed.sources.legacy[server];
    if (legacyEntry) {
      const legacyProjection = readLegacyMcpRegistryProjection(sandboxName);
      const committedEntries = readCommittedLegacyRegistryEntries(
        sandboxName,
        agent.name,
        getBridgeAdapter(agent),
        legacyProjection,
      );
      const committedEntry = committedEntries[server];
      if (
        !legacyProjection ||
        !committedEntry ||
        !sameMcpRegistration(legacyEntry, committedEntry)
      ) {
        throw new McpBridgeError(
          `Legacy MCP server '${server}' cannot be proven as registry-owned and was preserved. No source was changed.`,
          2,
        );
      }
      if (observed.sources.native[server]) {
        throw new McpBridgeError(
          `MCP server '${server}' exists in both legacy and native configuration. Migrate or explicitly resolve the duplicate before removal. No source was changed.`,
          2,
        );
      }
      const registryOnlyServers = Object.keys(committedEntries).filter(
        (candidateServer) =>
          candidateServer !== server && observed.sources.legacy[candidateServer] === undefined,
      );
      if (registryOnlyServers.length > 0) {
        throw new McpBridgeError(
          `Legacy MCP server '${server}' cannot be removed while registry-only legacy registration(s) '${registryOnlyServers.join(
            "', '",
          )}' remain. Migrate or explicitly resolve them first. No source was changed.`,
          2,
        );
      }
      await ensureSandboxGatewaySelected(sandboxName, runtimeSelection);
      const legacyAdapter = isAgentMcpAdapter(committedEntry.adapter)
        ? committedEntry.adapter
        : getBridgeAdapter(agent);
      await assertAgentMcpTeardownRuntimeCapability(sandboxName, legacyAdapter, runtimeSelection);
      await removeLegacyAgentMcpEntry(sandbox, legacyEntry, runtimeSelection);
      const remaining = await inspectAgentMcpSources(sandbox, runtimeSelection);
      if (remaining.legacy[server] || remaining.native[server]) {
        throw new McpBridgeError(
          `MCP server '${server}' remains in agent configuration. Registry ownership, policy, and provider state were preserved.`,
          2,
        );
      }
      removeLegacyMcpRegistryEntry(sandboxName, server, legacyProjection);
      entry = committedEntry;
      removedLegacySource = true;
    } else {
      entry = observed.bridges[server];
    }
    if (!entry && agent.mcpCapability.adapter) {
      entry =
        (await inspectPolicyOnlyMcpEntry(
          sandbox,
          server,
          agent.name,
          agent.mcpCapability.adapter,
          runtimeSelection,
        )) ?? undefined;
    }
    // A failed registry write may leave ownership after the agent entry is gone.
    // Reconcile that exact row on retry, without treating it as runtime state.
    if (!legacyEntry && !observed.sources.native[server]) {
      const legacyProjection = readLegacyMcpRegistryProjection(sandboxName);
      const committedEntry = legacyProjection
        ? readCommittedLegacyRegistryEntries(
            sandboxName,
            agent.name,
            getBridgeAdapter(agent),
            legacyProjection,
          )[server]
        : undefined;
      if (legacyProjection && committedEntry) {
        if (
          entry &&
          (!sameMcpRegistration(entry, committedEntry) ||
            entry.providerName !== committedEntry.providerName ||
            entry.providerId !== committedEntry.providerId)
        ) {
          throw new McpBridgeError(
            `Legacy MCP server '${server}' no longer matches its live policy and provider. Ownership and resources were preserved.`,
            2,
          );
        }
        const provider = await inspectMcpProvider(committedEntry.providerName, runtimeSelection);
        if (provider.exists === null) {
          throw new McpBridgeError(
            `Legacy MCP server '${server}' provider identity could not be inspected. Ownership and resources were preserved.`,
            2,
          );
        }
        if (provider.exists && provider.id !== committedEntry.providerId) {
          throw new McpBridgeError(
            `Legacy MCP server '${server}' provider identity changed. Ownership and resources were preserved.`,
            2,
          );
        }
        await ensureSandboxGatewaySelected(sandboxName, runtimeSelection);
        await assertAgentMcpTeardownRuntimeCapability(
          sandboxName,
          getBridgeAdapter(agent),
          runtimeSelection,
        );
        const remaining = await inspectAgentMcpSources(sandbox, runtimeSelection);
        if (remaining.legacy[server] || remaining.native[server]) {
          throw new McpBridgeError(
            `MCP server '${server}' reappeared before cleanup. Ownership and resources were preserved.`,
            2,
          );
        }
        removeLegacyMcpRegistryEntry(sandboxName, server, legacyProjection);
        entry = committedEntry;
        removedLegacySource = true;
      }
    }
    if (!entry) {
      if (!options.force) {
        throw new McpBridgeError(
          `MCP server '${server}' was not found in the ${agent.displayName} configuration.`,
        );
      }
      console.log(`  No native MCP server '${server}' is configured on sandbox '${sandboxName}'.`);
      return;
    }

    await ensureSandboxGatewaySelected(sandboxName, runtimeSelection);
    const adapter = isAgentMcpAdapter(entry.adapter)
      ? entry.adapter
      : getBridgeAdapter(getSandboxAgent(sandbox));

    if (!removedLegacySource) {
      await assertAgentMcpTeardownRuntimeCapability(sandboxName, adapter, runtimeSelection);
    }
    const removal = removedLegacySource
      ? "removed"
      : await unregisterAgentAdapter(sandboxName, adapter, entry, runtimeSelection, {
          force: options.force === true,
          envValues: resolvePersistedCredentialEnvForRedaction(entry.env),
          teardown: true,
        });
    if (removal === "unowned" && !options.force) {
      throw new McpBridgeError(
        `The native MCP server '${server}' changed before removal. Rerun against the current agent configuration.`,
      );
    }

    const warnings: string[] = [];
    try {
      await removeGeneratedPolicy(sandboxName, entry, { runtimeSelection });
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }

    if (entry.providerName) {
      const provider = await inspectMcpProvider(entry.providerName, runtimeSelection);
      const exact =
        !!entry.providerId &&
        providerMatchesManagedCredential(provider, entry.env[0], entry.providerId, {
          allowLegacyGeneric: true,
        });
      if (exact) {
        try {
          const outcome = await detachProvider(sandboxName, entry, {
            allowLegacyGeneric: true,
            runtimeSelection,
          });
          if (outcome === "unknown") {
            warnings.push(`Provider detach state for '${entry.providerName}' is unknown.`);
          } else {
            await waitForDetachedMcpCredential(sandboxName, entry, runtimeSelection);
          }
        } catch (error) {
          warnings.push(error instanceof Error ? error.message : String(error));
        }
      } else if (provider.exists !== false) {
        warnings.push(
          `Provider '${entry.providerName}' could not be proven as the current exact MCP provider and was preserved.`,
        );
      }
      if (provider.exists !== false) {
        console.warn(
          `  Preserved OpenShell provider '${entry.providerName}'. Remove it explicitly after confirming no sandbox uses it.`,
        );
      }
    }

    console.log(
      `  Removed MCP server '${server}' from the agent configuration on '${sandboxName}'.`,
    );
    for (const warning of warnings) console.warn(`  MCP cleanup warning: ${warning}`);
    if (warnings.length > 0 && !options.allowResidual && !options.force) {
      throw new McpBridgeError(
        `The agent registration was removed, but ${String(warnings.length)} conservative cleanup warning(s) remain.`,
      );
    }
  });
}
