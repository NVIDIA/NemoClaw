// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import { findAmbiguousMcpCredentialTarget } from "../../domain/mcp-credential-target";
import { withMcpLifecycleLock } from "../../state/mcp-lifecycle-lock";
import * as registry from "../../state/registry";
import * as policies from "../../policy";
import {
  readLegacyMcpRegistryProjection,
  retireLegacyMcpRegistryProjection,
} from "../../state/registry/legacy-mcp";
import { readCommittedLegacyRegistryEntries, sameMcpRegistration } from "./mcp-bridge-source";
import {
  registerAgentAdapter,
  reloadOpenClawGatewayAfterMcpMutation,
  unregisterAgentAdapter,
} from "./mcp-bridge-adapters";
import { buildMcpBridgePolicyYaml, getPolicyPresence } from "./mcp-bridge-policy";
import type { McpSourceEntry } from "./mcp-bridge-contracts";
import { McpBridgeError } from "./mcp-bridge-contracts";
import {
  getMcpProviderInspectionRuntimeSelection,
  assertMcpProviderRecoverable,
  preflightMcpEntryTargets,
  providerAttached,
} from "./mcp-bridge-provider";
import {
  inspectAgentMcpSources,
  inspectLegacyBridgeState,
  joinMcpEntriesToOpenShell,
  removeLegacyAgentMcpEntry,
} from "./mcp-bridge-source";
import {
  ensureSandboxGatewaySelected,
  getBridgeAdapter,
  getSandboxAgent,
} from "./mcp-bridge-state";
import { validateSandboxName } from "./mcp-bridge-validation";

export type McpMigrationItem = {
  server: string;
  agent: string;
  source: "legacy-agent" | "legacy-registry";
  destination: "native";
  url: string;
  credentialEnv: string | null;
  policyName: string;
  policyPresent: boolean | null;
  providerName: string | null;
  providerAttached: boolean | null;
  deniedTools: string[];
  activationChanges: boolean;
  action: "migrate" | "already-migrated";
};

export type McpMigrationPlan = {
  sandbox: string;
  items: McpMigrationItem[];
  applied: boolean;
};

async function preflightMigrationOpenShellState(
  sandboxName: string,
  entries: readonly McpSourceEntry[],
  runtimeSelection: ReturnType<typeof getMcpProviderInspectionRuntimeSelection>,
): Promise<void> {
  const targets = await preflightMcpEntryTargets(entries);
  for (const entry of entries) {
    const target = targets.get(entry.server);
    if (!target) {
      throw new McpBridgeError(
        `Legacy MCP server '${entry.server}' has no validated policy target. No source was changed.`,
      );
    }
    await assertMcpProviderRecoverable(entry, runtimeSelection);
    if ((await providerAttached(sandboxName, entry.providerName, runtimeSelection)) !== true) {
      throw new McpBridgeError(
        `Legacy MCP server '${entry.server}' does not have its exact provider attached. No source was changed.`,
      );
    }
    const expectedPolicy = buildMcpBridgePolicyYaml(
      entry.server,
      entry.url,
      entry.adapter ?? "openclaw-config",
      target,
      entry.providerName ?? "",
      entry.denyTools,
    );
    if (
      (await policies.getPresetContentGatewayState(
        sandboxName,
        expectedPolicy,
        undefined,
        runtimeSelection,
      )) !== "match"
    ) {
      throw new McpBridgeError(
        `Legacy MCP server '${entry.server}' does not match the current restrictive OpenShell policy. No source was changed.`,
      );
    }
  }
}

export async function migrateMcpBridges(
  sandboxName: string,
  options: {
    apply?: boolean;
    rebuildSandbox?: (sandboxName: string) => Promise<void>;
  } = {},
): Promise<McpMigrationPlan> {
  return withMcpLifecycleLock(sandboxName, async () => {
    validateSandboxName(sandboxName);
    const sandbox = registry.getSandbox(sandboxName);
    if (!sandbox) throw new McpBridgeError(`Sandbox '${sandboxName}' not found.`, 1);
    const runtimeSelection = getMcpProviderInspectionRuntimeSelection(sandbox);
    await ensureSandboxGatewaySelected(sandboxName, runtimeSelection);
    const observed = await inspectLegacyBridgeState(sandbox, runtimeSelection);
    const agent = getSandboxAgent(sandbox);
    const adapter = getBridgeAdapter(agent);
    const legacyProjection = readLegacyMcpRegistryProjection(sandboxName);
    const committedRegistryEntries = readCommittedLegacyRegistryEntries(
      sandboxName,
      agent.name,
      adapter,
      legacyProjection,
    );
    const rawRegistryEntries = await joinMcpEntriesToOpenShell(
      sandbox,
      committedRegistryEntries,
      runtimeSelection,
      "inspect legacy MCP registry migration state",
    );
    for (const [server, committedEntry] of Object.entries(committedRegistryEntries)) {
      if (
        (await getPolicyPresence(sandboxName, committedEntry, runtimeSelection)) === true &&
        !isDeepStrictEqual(
          committedEntry.denyTools ?? [],
          rawRegistryEntries[server]?.denyTools ?? [],
        )
      ) {
        throw new McpBridgeError(
          `Legacy MCP registry denied-tool intent conflicts with the current OpenShell policy for '${server}'. The live policy remains authoritative and no source was changed.`,
          2,
        );
      }
    }
    for (const [server, registryEntry] of Object.entries(rawRegistryEntries)) {
      const agentLegacy = observed.bridges[server];
      if (agentLegacy && !sameMcpRegistration(agentLegacy, registryEntry)) {
        throw new McpBridgeError(
          `Legacy agent and registry MCP definitions conflict for '${server}'. No source was changed.`,
          2,
        );
      }
    }
    const legacyEntries = { ...observed.bridges, ...rawRegistryEntries };
    const entries = Object.values(legacyEntries).sort((left, right) =>
      left.server.localeCompare(right.server),
    );
    const nativeEntries = await joinMcpEntriesToOpenShell(
      sandbox,
      observed.sources.native,
      runtimeSelection,
      "inspect native MCP migration conflict state",
    );
    const ambiguousTarget = findAmbiguousMcpCredentialTarget([
      ...entries,
      ...Object.values(nativeEntries),
    ]);
    if (ambiguousTarget) {
      throw new McpBridgeError(
        `MCP servers '${ambiguousTarget.entry.server}' and '${ambiguousTarget.conflict.server}' target the same URL with different credential bindings. OpenShell cannot safely choose between credentials for an indistinguishable endpoint. Remove one owned legacy registration with \`nemoclaw ${sandboxName} mcp remove <server>\`, then rerun migration. No source was changed.`,
        2,
      );
    }
    const conflicts = entries.filter((entry) => {
      const native = observed.sources.native[entry.server];
      return native && !sameMcpRegistration(native, entry);
    });
    if (conflicts.length > 0) {
      throw new McpBridgeError(
        `Native MCP configuration conflicts with legacy server${conflicts.length === 1 ? "" : "s"}: ${conflicts.map((entry) => entry.server).join(", ")}. No source was changed.`,
        2,
      );
    }
    const items = await Promise.all(
      entries.map(async (entry): Promise<McpMigrationItem> => {
        const action = observed.sources.native[entry.server] ? "already-migrated" : "migrate";
        return {
          server: entry.server,
          agent: entry.agent,
          source: entry.source === "legacy-registry" ? "legacy-registry" : "legacy-agent",
          destination: "native",
          url: entry.url,
          credentialEnv: entry.env[0] ?? null,
          policyName: entry.policyName,
          policyPresent: await getPolicyPresence(sandboxName, entry, runtimeSelection),
          providerName: entry.providerName ?? null,
          providerAttached: await providerAttached(
            sandboxName,
            entry.providerName,
            runtimeSelection,
          ),
          deniedTools: [...(entry.denyTools ?? [])],
          activationChanges: adapter === "openclaw-config" && action === "migrate",
          action,
        };
      }),
    );
    if (!options.apply || entries.length === 0) {
      return { sandbox: sandboxName, items, applied: false };
    }
    await preflightMigrationOpenShellState(sandboxName, entries, runtimeSelection);

    if (adapter === "deepagents-config") {
      if (!options.rebuildSandbox) {
        throw new McpBridgeError("Deep Agents MCP migration requires the rebuild coordinator.");
      }
      await options.rebuildSandbox(sandboxName);
      const rebuilt = registry.getSandbox(sandboxName);
      if (!rebuilt) {
        throw new McpBridgeError(
          `Deep Agents MCP migration rebuilt '${sandboxName}' but its registered sandbox route is unavailable.`,
        );
      }
      const rebuiltRuntimeSelection = getMcpProviderInspectionRuntimeSelection(rebuilt);
      await preflightMigrationOpenShellState(sandboxName, entries, rebuiltRuntimeSelection);
      const created: McpSourceEntry[] = [];
      let cleanupStarted = false;
      try {
        let native = (await inspectAgentMcpSources(rebuilt, rebuiltRuntimeSelection)).native;
        for (const entry of entries) {
          if (!native[entry.server]) {
            await registerAgentAdapter(
              sandboxName,
              adapter,
              entry,
              rebuiltRuntimeSelection,
              {},
              { replaceExisting: false },
            );
            created.push(entry);
          }
        }
        native = (await inspectAgentMcpSources(rebuilt, rebuiltRuntimeSelection)).native;
        const missing = entries.filter(
          (entry) => !native[entry.server] || !sameMcpRegistration(native[entry.server], entry),
        );
        if (missing.length > 0) {
          throw new McpBridgeError(
            `Deep Agents rebuild did not verify native MCP server${missing.length === 1 ? "" : "s"}: ${missing.map((entry) => entry.server).join(", ")}.`,
          );
        }
        for (const entry of entries) {
          if (observed.sources.legacy[entry.server]) {
            cleanupStarted = true;
            await removeLegacyAgentMcpEntry(rebuilt, entry, rebuiltRuntimeSelection);
          }
        }
      } catch (error) {
        for (const entry of cleanupStarted ? [] : created.reverse()) {
          try {
            await unregisterAgentAdapter(sandboxName, adapter, entry, rebuiltRuntimeSelection, {
              force: true,
              bestEffort: true,
            });
          } catch {
            // Leave legacy and OpenShell source state available for retry.
          }
        }
        throw error;
      }
      retireLegacyMcpRegistryProjection(sandboxName, legacyProjection);
      return { sandbox: sandboxName, items, applied: true };
    }

    const created: McpSourceEntry[] = [];
    let cleanupStarted = false;
    try {
      for (const entry of entries) {
        if (!observed.sources.native[entry.server]) {
          await registerAgentAdapter(
            sandboxName,
            adapter,
            entry,
            runtimeSelection,
            {},
            {
              replaceExisting: false,
            },
          );
          created.push(entry);
        }
        const current = (await inspectAgentMcpSources(sandbox, runtimeSelection)).native[
          entry.server
        ];
        if (!current || !sameMcpRegistration(current, entry)) {
          throw new McpBridgeError(
            `Native MCP verification failed after migrating '${entry.server}'.`,
          );
        }
      }
      await reloadOpenClawGatewayAfterMcpMutation(sandboxName, [adapter]);
      for (const entry of entries) {
        if (observed.sources.legacy[entry.server]) {
          cleanupStarted = true;
          await removeLegacyAgentMcpEntry(sandbox, entry, runtimeSelection);
        }
      }
      retireLegacyMcpRegistryProjection(sandboxName, legacyProjection);
      return { sandbox: sandboxName, items, applied: true };
    } catch (error) {
      if (!cleanupStarted) {
        for (const entry of created.reverse()) {
          try {
            await unregisterAgentAdapter(sandboxName, adapter, entry, runtimeSelection, {
              force: true,
              bestEffort: true,
            });
          } catch {
            // The original legacy source is retained; a rerun reports the exact
            // native/legacy conflict instead of guessing at cleanup authority.
          }
        }
      }
      throw error;
    }
  });
}
