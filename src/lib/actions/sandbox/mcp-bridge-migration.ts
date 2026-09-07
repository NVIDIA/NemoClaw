// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import { readConfigFile } from "../../state/config-io";
import { withMcpLifecycleLock } from "../../state/mcp-lifecycle-lock";
import * as registry from "../../state/registry";
import { REGISTRY_FILE } from "../../state/registry/persistence";
import { registerAgentAdapter, unregisterAgentAdapter } from "./mcp-bridge-adapters";
import { buildMcpBridgePolicyName, getPolicyPresence } from "./mcp-bridge-policy";
import type { McpSourceEntry } from "./mcp-bridge-contracts";
import { McpBridgeError } from "./mcp-bridge-contracts";
import { getMcpProviderInspectionRuntimeSelection, providerAttached } from "./mcp-bridge-provider";
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
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(server) || !isObjectRecord(raw)) continue;
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
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      throw new McpBridgeError(
        `Legacy MCP registry server '${server}' has an unsupported URL. No source was changed.`,
        2,
      );
    }
    entries[server] = {
      server,
      agent,
      adapter,
      url: url.toString(),
      env: [raw.env[0]],
      policyName: buildMcpBridgePolicyName(server),
      source: "legacy-registry",
    };
  }
  return entries;
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
    const observed = inspectLegacyBridgeState(sandbox, runtimeSelection);
    const agent = getSandboxAgent(sandbox);
    const adapter = getBridgeAdapter(agent);
    const rawRegistryEntries = joinMcpEntriesToOpenShell(
      sandbox,
      readCommittedLegacyRegistryEntries(sandboxName, agent.name, adapter),
      runtimeSelection,
      "inspect legacy MCP registry migration state",
    );
    for (const [server, registryEntry] of Object.entries(rawRegistryEntries)) {
      const agentLegacy = observed.bridges[server];
      if (agentLegacy && !sameRegistration(agentLegacy, registryEntry)) {
        throw new McpBridgeError(
          `Legacy agent and registry MCP definitions conflict for '${server}'. No source was changed.`,
          2,
        );
      }
    }
    const legacyEntries = { ...rawRegistryEntries, ...observed.bridges };
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
    const items = entries.map((entry): McpMigrationItem => ({
      server: entry.server,
      agent: entry.agent,
      source: entry.source === "legacy-registry" ? "legacy-registry" : "legacy-agent",
      destination: "native",
      url: entry.url,
      credentialEnv: entry.env[0] ?? null,
      policyName: entry.policyName,
      policyPresent: getPolicyPresence(sandboxName, entry, runtimeSelection),
      providerName: entry.providerName ?? null,
      providerAttached: providerAttached(sandboxName, entry.providerName, runtimeSelection),
      activationChanges: adapter === "openclaw-config",
      action: observed.sources.native[entry.server] ? "already-migrated" : "migrate",
    }));
    if (!options.apply || entries.length === 0) {
      return { sandbox: sandboxName, items, applied: false };
    }

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
      const created: McpSourceEntry[] = [];
      try {
        let native = inspectAgentMcpSources(rebuilt, rebuiltRuntimeSelection).native;
        for (const entry of entries) {
          if (!native[entry.server]) {
            registerAgentAdapter(
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
        native = inspectAgentMcpSources(rebuilt, rebuiltRuntimeSelection).native;
        const missing = entries.filter(
          (entry) => !native[entry.server] || !sameRegistration(native[entry.server], entry),
        );
        if (missing.length > 0) {
          throw new McpBridgeError(
            `Deep Agents rebuild did not verify native MCP server${missing.length === 1 ? "" : "s"}: ${missing.map((entry) => entry.server).join(", ")}.`,
          );
        }
      } catch (error) {
        for (const entry of created.reverse()) {
          try {
            unregisterAgentAdapter(sandboxName, adapter, entry, rebuiltRuntimeSelection, {
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
    try {
      for (const entry of entries) {
        if (!observed.sources.native[entry.server]) {
          registerAgentAdapter(
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
        const current = inspectAgentMcpSources(sandbox, runtimeSelection).native[entry.server];
        if (!current || !sameRegistration(current, entry)) {
          throw new McpBridgeError(
            `Native MCP verification failed after migrating '${entry.server}'.`,
          );
        }
        if (observed.sources.legacy[entry.server]) {
          removeLegacyAgentMcpEntry(sandbox, entry, runtimeSelection);
        }
      }
      // Force a normal non-MCP registry serialization so legacy MCP fields are
      // omitted immediately after the explicit migration succeeds.
      registry.updateSandbox(sandboxName, {});
      return { sandbox: sandboxName, items, applied: true };
    } catch (error) {
      for (const entry of created.reverse()) {
        try {
          unregisterAgentAdapter(sandboxName, adapter, entry, runtimeSelection, {
            force: true,
            bestEffort: true,
          });
        } catch {
          // The original legacy source is retained; a rerun reports the exact
          // native/legacy conflict instead of guessing at cleanup authority.
        }
      }
      throw error;
    }
  });
}
