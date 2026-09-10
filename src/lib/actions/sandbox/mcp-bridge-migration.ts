// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import { readConfigFile } from "../../state/config-io";
import { withMcpLifecycleLock } from "../../state/mcp-lifecycle-lock";
import * as registry from "../../state/registry";
import * as policies from "../../policy";
import { REGISTRY_FILE } from "../../state/registry/persistence";
import {
  registerAgentAdapterAtCurrentCredentialRevision,
  reloadOpenClawGatewayAfterMcpMutation,
  unregisterAgentAdapter,
} from "./mcp-bridge-adapters";
import {
  buildMcpBridgePolicyYaml,
  buildMcpBridgePolicyName,
  getPolicyPresence,
  mcpPolicySourceAuthority,
} from "./mcp-bridge-policy";
import type { McpSourceEntry } from "./mcp-bridge-contracts";
import { McpBridgeError } from "./mcp-bridge-contracts";
import {
  getMcpProviderInspectionRuntimeSelection,
  assertMcpProviderRecoverable,
  preflightMcpEntryTargets,
  providerAttached,
  waitForAttachedMcpCredential,
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
  resolveMcpOperationTarget,
  type McpOperationTarget,
} from "./mcp-bridge-state";
import { normalizeMcpDenyTools, validateSandboxName } from "./mcp-bridge-validation";
import { discoverMcpTools } from "./mcp-bridge-tool-discovery";

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

/** Explicit migration input for the existing bounded rebuild transaction. */
export interface McpMigrationRebuildIntent {
  readonly sandboxName: string;
  readonly entries: readonly McpSourceEntry[];
  readonly runtimeSelection: ReturnType<typeof getMcpProviderInspectionRuntimeSelection>;
}

function migrationRegistration(entry: McpSourceEntry) {
  return {
    server: entry.server,
    agent: entry.agent,
    source: entry.source === "legacy-registry" ? "legacy-registry" : "legacy-agent",
    url: entry.url,
    credentialEnv: entry.env[0] ?? null,
    policyName: entry.policyName,
    providerName: entry.providerName ?? null,
    deniedTools: entry.denyTools ?? [],
  };
}

/** Re-read the complete preview before an explicit migration may replace its source. */
export async function validateMcpMigrationRebuildIntent(
  sandboxName: string,
  intent: McpMigrationRebuildIntent,
  runtimeSelection: McpMigrationRebuildIntent["runtimeSelection"],
): Promise<void> {
  const { isRebuildMcpHandoff } = await import("../../state/rebuild/mcp-handoff");
  const currentTarget = resolveMcpOperationTarget(sandboxName);
  if (
    intent.sandboxName !== sandboxName ||
    currentTarget.sandbox.name !== sandboxName ||
    !isDeepStrictEqual(currentTarget.runtimeSelection, runtimeSelection) ||
    !isDeepStrictEqual(intent.runtimeSelection, runtimeSelection) ||
    !isRebuildMcpHandoff({ entries: intent.entries, runtimeSelection }) ||
    intent.entries.some(
      (entry) =>
        entry.agent !== "langchain-deepagents-code" ||
        entry.adapter !== "deepagents-config" ||
        (entry.source !== "legacy" && entry.source !== "legacy-registry"),
    )
  ) {
    throw new McpBridgeError("MCP migration rebuild intent is invalid or targets another sandbox.");
  }
  const current = await migrateMcpBridges(sandboxName);
  const actual = current.items.map(
    ({ server, agent, source, url, credentialEnv, policyName, providerName, deniedTools }) => ({
      server,
      agent,
      source,
      url,
      credentialEnv,
      policyName,
      providerName,
      deniedTools,
    }),
  );
  const expected = [...intent.entries]
    .sort((left, right) => left.server.localeCompare(right.server))
    .map(migrationRegistration);
  if (!isDeepStrictEqual(actual, expected)) {
    throw new McpBridgeError(
      "MCP migration sources changed or the rebuild intent omits legacy entries. Preview migration again before retrying.",
    );
  }
  await preflightMigrationOpenShellState(sandboxName, intent.entries, runtimeSelection);
}

function sameRegistration(left: McpSourceEntry, right: McpSourceEntry): boolean {
  return (
    left.server === right.server && left.url === right.url && isDeepStrictEqual(left.env, right.env)
  );
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readCommittedLegacyRegistryEntries(
  sandboxName: string,
  currentAgent: string,
  currentAdapter: McpSourceEntry["adapter"],
): Record<string, McpSourceEntry> {
  const invalidStructure = `Legacy MCP registry structure for '${sandboxName}' is invalid. No source was changed.`;
  let rawState: unknown = readConfigFile<unknown>(REGISTRY_FILE, {});
  for (const key of ["sandboxes", sandboxName, "mcp"]) {
    if (!isObjectRecord(rawState)) throw new McpBridgeError(invalidStructure, 2);
    if (!Object.hasOwn(rawState, key)) return {};
    rawState = rawState[key];
  }
  if (!isObjectRecord(rawState)) throw new McpBridgeError(invalidStructure, 2);
  if (rawState.destroyPreparedAt || rawState.destroyPendingAt) {
    throw new McpBridgeError(
      `Legacy MCP registry state for '${sandboxName}' contains an incomplete destroy transaction. No source was changed.`,
      2,
    );
  }
  if (!isObjectRecord(rawState.bridges)) throw new McpBridgeError(invalidStructure, 2);
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
  operationTarget?: McpOperationTarget,
): Promise<void> {
  const sourceAuthority = mcpPolicySourceAuthority(operationTarget);
  operationTarget?.liveIdentity?.assertCurrent();
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
      policies.getPresetContentGatewayState(
        sandboxName,
        expectedPolicy,
        undefined,
        runtimeSelection,
        ...(sourceAuthority ? ([sourceAuthority] as const) : ([] as const)),
      ) !== "match"
    ) {
      throw new McpBridgeError(
        `Legacy MCP server '${entry.server}' does not match the current restrictive OpenShell policy. No source was changed.`,
      );
    }
  }
}

async function verifyMigratedMcpRuntime(
  sandboxName: string,
  entries: readonly McpSourceEntry[],
  adapter: ReturnType<typeof getBridgeAdapter>,
  runtimeSelection: ReturnType<typeof getMcpProviderInspectionRuntimeSelection>,
  operationTarget?: McpOperationTarget,
): Promise<void> {
  for (const entry of entries) {
    await waitForAttachedMcpCredential(sandboxName, entry, runtimeSelection);
    await preflightMigrationOpenShellState(
      sandboxName,
      [entry],
      runtimeSelection,
      ...(operationTarget ? ([operationTarget] as const) : ([] as const)),
    );
    operationTarget?.liveIdentity?.assertCurrent();
    const discovery = discoverMcpTools(
      sandboxName,
      entry,
      adapter,
      { policyGatewayPresent: true, providerAttached: true, providerCredentialReady: true },
      runtimeSelection,
    );
    if (!discovery.ok) {
      throw new McpBridgeError(
        `MCP migration could not verify authenticated tool discovery for '${entry.server}' (${discovery.failureClass ?? "unknown"} at ${discovery.failedStage ?? "unknown"}). Legacy configuration was preserved.`,
      );
    }
  }
}

export async function migrateMcpBridges(
  sandboxName: string,
  options: {
    apply?: boolean;
    rebuildSandbox?: (sandboxName: string, intent: McpMigrationRebuildIntent) => Promise<void>;
  } = {},
): Promise<McpMigrationPlan> {
  return withMcpLifecycleLock(sandboxName, async () => {
    validateSandboxName(sandboxName);
    const target = resolveMcpOperationTarget(sandboxName);
    const { sandbox, runtimeSelection } = target;
    const operationTarget = target.liveIdentity ? target : undefined;
    await ensureSandboxGatewaySelected(sandboxName, runtimeSelection);
    const observed = await inspectLegacyBridgeState(
      sandbox,
      runtimeSelection,
      ...(operationTarget ? ([operationTarget] as const) : ([] as const)),
    );
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
      ...(operationTarget ? ([operationTarget] as const) : ([] as const)),
    );
    for (const [server, committedEntry] of Object.entries(committedRegistryEntries)) {
      if (
        getPolicyPresence(
          sandboxName,
          committedEntry,
          runtimeSelection,
          ...(operationTarget ? ([operationTarget] as const) : ([] as const)),
        ) === true &&
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
          policyPresent: getPolicyPresence(
            sandboxName,
            entry,
            runtimeSelection,
            ...(operationTarget ? ([operationTarget] as const) : ([] as const)),
          ),
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
    await preflightMigrationOpenShellState(
      sandboxName,
      entries,
      runtimeSelection,
      ...(operationTarget ? ([operationTarget] as const) : ([] as const)),
    );

    if (adapter === "deepagents-config") {
      if (!options.rebuildSandbox) {
        throw new McpBridgeError("Deep Agents MCP migration requires the rebuild coordinator.");
      }
      await options.rebuildSandbox(sandboxName, {
        sandboxName,
        entries: entries.map((entry) => structuredClone(entry)),
        runtimeSelection: { ...runtimeSelection },
      });
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
        let native = inspectAgentMcpSources(rebuilt, rebuiltRuntimeSelection).native;
        for (const entry of entries) {
          if (!native[entry.server]) {
            const credentialRevision = await waitForAttachedMcpCredential(
              sandboxName,
              entry,
              rebuiltRuntimeSelection,
            );
            await registerAgentAdapterAtCurrentCredentialRevision(
              sandboxName,
              adapter,
              entry,
              rebuiltRuntimeSelection,
              {},
              credentialRevision,
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
        await verifyMigratedMcpRuntime(sandboxName, entries, adapter, rebuiltRuntimeSelection);
        for (const entry of entries) {
          if (observed.sources.legacy[entry.server]) {
            cleanupStarted = true;
            removeLegacyAgentMcpEntry(rebuilt, entry, rebuiltRuntimeSelection);
          }
        }
      } catch (error) {
        for (const entry of cleanupStarted ? [] : created.reverse()) {
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
    let cleanupStarted = false;
    try {
      for (const entry of entries) {
        if (!observed.sources.native[entry.server]) {
          const credentialRevision = await waitForAttachedMcpCredential(
            sandboxName,
            entry,
            runtimeSelection,
          );
          await registerAgentAdapterAtCurrentCredentialRevision(
            sandboxName,
            adapter,
            entry,
            runtimeSelection,
            {},
            credentialRevision,
            {
              replaceExisting: false,
              ...(operationTarget ? { operationTarget } : {}),
            },
          );
          created.push(entry);
        }
        operationTarget?.liveIdentity?.assertCurrent();
        const current = inspectAgentMcpSources(sandbox, runtimeSelection).native[entry.server];
        if (!current || !sameRegistration(current, entry)) {
          throw new McpBridgeError(
            `Native MCP verification failed after migrating '${entry.server}'.`,
          );
        }
      }
      await reloadOpenClawGatewayAfterMcpMutation(
        sandboxName,
        [adapter],
        ...(operationTarget ? ([operationTarget] as const) : ([] as const)),
      );
      await verifyMigratedMcpRuntime(
        sandboxName,
        entries,
        adapter,
        runtimeSelection,
        ...(operationTarget ? ([operationTarget] as const) : ([] as const)),
      );
      for (const entry of entries) {
        if (observed.sources.legacy[entry.server]) {
          cleanupStarted = true;
          operationTarget?.liveIdentity?.assertCurrent();
          removeLegacyAgentMcpEntry(sandbox, entry, runtimeSelection);
        }
      }
      // Force a normal non-MCP registry serialization so legacy MCP fields are
      // omitted immediately after verification. Publication may retire the last
      // legacy source before reporting a durability failure.
      cleanupStarted = true;
      if (!operationTarget) registry.updateSandbox(sandboxName, {});
      return { sandbox: sandboxName, items, applied: true };
    } catch (error) {
      if (!cleanupStarted) {
        for (const entry of created.reverse()) {
          try {
            unregisterAgentAdapter(sandboxName, adapter, entry, runtimeSelection, {
              force: true,
              bestEffort: true,
              ...(operationTarget ? { operationTarget } : {}),
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
