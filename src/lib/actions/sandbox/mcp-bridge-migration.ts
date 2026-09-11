// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import { readConfigFile } from "../../state/config-io";
import { withMcpLifecycleLock } from "../../state/mcp-lifecycle-lock";
import * as registry from "../../state/registry";
import * as policies from "../../policy";
import { REGISTRY_FILE } from "../../state/registry/persistence";
import {
  registerAgentAdapter,
  reloadOpenClawGatewayAfterMcpMutation,
  unregisterAgentAdapter,
} from "./mcp-bridge-adapters";
import {
  buildMcpBridgePolicyYaml,
  buildMcpBridgePolicyName,
  getPolicyPresence,
} from "./mcp-bridge-policy";
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
import { normalizeMcpDenyTools, validateSandboxName } from "./mcp-bridge-validation";

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

function sameRegistration(left: McpSourceEntry, right: McpSourceEntry): boolean {
  return (
    left.server === right.server && left.url === right.url && isDeepStrictEqual(left.env, right.env)
  );
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readCommittedLegacyRegistryEntries(
  sandboxName: string,
  currentAgent: string,
  currentAdapter: McpSourceEntry["adapter"],
): Record<string, McpSourceEntry> {
  const document = readConfigFile<unknown>(REGISTRY_FILE, {});
  if (!isObjectRecord(document) || !isObjectRecord(document.sandboxes)) return {};
  const rawSandbox = document.sandboxes[sandboxName];
  if (!isObjectRecord(rawSandbox) || !isObjectRecord(rawSandbox.mcp)) return {};
  const rawState = rawSandbox.mcp;
  if (rawState.destroyPreparedAt || rawState.destroyPendingAt) {
    throw new McpBridgeError(
      `Legacy MCP registry state for '${sandboxName}' contains an incomplete destroy transaction. No source was changed.`,
      2,
    );
  }
  if (!isObjectRecord(rawState.bridges)) return {};
  const entries: Record<string, McpSourceEntry> = {};
  for (const [server, raw] of Object.entries(rawState.bridges)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(server) || !isObjectRecord(raw)) {
      throw new McpBridgeError(
        `Legacy MCP registry server '${server}' is not a valid committed registration. No source was changed.`,
        2,
      );
    }
    if (raw.addState !== undefined) {
      throw new McpBridgeError(
        `Legacy MCP registry server '${server}' contains an incomplete add transaction. No source was changed.`,
        2,
      );
    }
    const agent = typeof raw.agent === "string" && raw.agent ? raw.agent : "openclaw";
    const recordedAdapter =
      typeof raw.adapter === "string" && raw.adapter ? raw.adapter : currentAdapter;
    const adapter = recordedAdapter === "mcporter" ? "openclaw-config" : recordedAdapter;
    if (agent !== currentAgent || adapter !== currentAdapter) {
      throw new McpBridgeError(
        `Legacy MCP registry server '${server}' targets ${agent}/${String(adapter)} instead of the current ${currentAgent}/${String(currentAdapter)} runtime. No source was changed.`,
        2,
      );
    }
    if (
      typeof raw.url !== "string" ||
      raw.url.length > 4096 ||
      !Array.isArray(raw.env) ||
      raw.env.length !== 1 ||
      typeof raw.env[0] !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(raw.env[0])
    ) {
      throw new McpBridgeError(
        `Legacy MCP registry server '${server}' is not a valid committed registration. No source was changed.`,
        2,
      );
    }
    let url: URL;
    try {
      url = new URL(raw.url);
    } catch {
      throw new McpBridgeError(
        `Legacy MCP registry server '${server}' has an invalid URL. No source was changed.`,
        2,
      );
    }
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new McpBridgeError(
        `Legacy MCP registry server '${server}' has an unsupported URL. No source was changed.`,
        2,
      );
    }
    const requestedDenyTools = raw.pendingDenyTools ?? raw.denyTools ?? [];
    if (
      !Array.isArray(requestedDenyTools) ||
      requestedDenyTools.some((tool) => typeof tool !== "string")
    ) {
      throw new McpBridgeError(
        `Legacy MCP registry server '${server}' has invalid denied-tool intent. No source was changed.`,
        2,
      );
    }
    const denyTools = normalizeMcpDenyTools(requestedDenyTools as string[]);
    const allowedIps = Array.isArray(raw.allowedIps)
      ? raw.allowedIps.filter((address): address is string => typeof address === "string")
      : undefined;
    entries[server] = {
      server,
      agent,
      adapter,
      url: url.toString(),
      env: [raw.env[0]],
      denyTools,
      ...(allowedIps?.length ? { allowedIps } : {}),
      ...(typeof raw.trustedPrivateHost === "string" && raw.trustedPrivateHost
        ? { trustedPrivateHost: raw.trustedPrivateHost }
        : {}),
      ...(typeof raw.providerName === "string" && raw.providerName
        ? { providerName: raw.providerName }
        : {}),
      ...(typeof raw.providerId === "string" && raw.providerId
        ? { providerId: raw.providerId }
        : {}),
      policyName: buildMcpBridgePolicyName(server),
      source: "legacy-registry",
    };
  }
  return entries;
}

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
    const committedRegistryEntries = readCommittedLegacyRegistryEntries(
      sandboxName,
      agent.name,
      adapter,
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
      if (agentLegacy && !sameRegistration(agentLegacy, registryEntry)) {
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
    const conflicts = entries.filter((entry) => {
      const native = observed.sources.native[entry.server];
      return native && !sameRegistration(native, entry);
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
          (entry) => !native[entry.server] || !sameRegistration(native[entry.server], entry),
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
      registry.updateSandbox(sandboxName, {});
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
        if (!current || !sameRegistration(current, entry)) {
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
      // Force a normal non-MCP registry serialization so legacy MCP fields are
      // omitted immediately after the explicit migration succeeds.
      registry.updateSandbox(sandboxName, {});
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
