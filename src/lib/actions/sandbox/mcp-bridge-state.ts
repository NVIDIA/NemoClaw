// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type AgentDefinition, type AgentMcpAdapter, loadAgent } from "../../agent/defs";
import { recoverNamedGatewayRuntime } from "../../gateway-runtime-action";
import type { McpBridgeEntry, SandboxEntry } from "../../state/registry";
import * as registry from "../../state/registry";
import { getSandboxTargetGatewayName } from "./gateway-target";
import {
  isAgentMcpAdapter,
  MCP_BRIDGE_POLICY_SOURCE,
  McpBridgeError,
} from "./mcp-bridge-contracts";
import { validateSandboxName } from "./mcp-bridge-validation";

export function nowIso(): string {
  return new Date().toISOString();
}

export function getSandboxOrThrow(sandboxName: string): SandboxEntry {
  const sandbox = registry.getSandbox(sandboxName);
  if (!sandbox) {
    throw new McpBridgeError(`Sandbox '${sandboxName}' not found.`, 1);
  }
  return sandbox;
}

function getSandboxAgentName(sandbox: SandboxEntry): string {
  return sandbox.agent || "openclaw";
}

export function getSandboxAgent(sandbox: SandboxEntry): AgentDefinition {
  return loadAgent(getSandboxAgentName(sandbox));
}

function unsupportedMessage(agent: AgentDefinition): string {
  const reason = agent.mcpCapability.reason
    ? ` ${agent.mcpCapability.reason}`
    : " MCP support is disabled for this agent.";
  return `${agent.displayName} does not support managed MCP servers yet.${reason} Issue #566 tracks future design.`;
}

function assertBridgeSupported(agent: AgentDefinition): void {
  if (agent.mcpCapability.support === "bridge") return;
  throw new McpBridgeError(unsupportedMessage(agent), 1);
}

export function getBridgeAdapter(agent: AgentDefinition): AgentMcpAdapter {
  assertBridgeSupported(agent);
  const adapter = agent.mcpCapability.adapter;
  if (!adapter) {
    throw new McpBridgeError(
      `${agent.displayName} declares MCP support but does not declare an adapter.`,
      1,
    );
  }
  return adapter;
}

export function getEntryAdapter(
  entry: Pick<McpBridgeEntry, "adapter"> | undefined,
  agent: AgentDefinition,
): AgentMcpAdapter | null {
  if (entry && isAgentMcpAdapter(entry.adapter)) return entry.adapter;
  return agent.mcpCapability.support === "bridge" && agent.mcpCapability.adapter
    ? agent.mcpCapability.adapter
    : null;
}

export function bridgeState(sandbox: SandboxEntry): Record<string, McpBridgeEntry> {
  return sandbox.mcp?.bridges ?? {};
}

export function setBridgeState(sandboxName: string, bridges: Record<string, McpBridgeEntry>): void {
  const mcpState = registry.getSandbox(sandboxName)?.mcp;
  const destroyPreparedAt = mcpState?.destroyPreparedAt;
  const destroyPendingAt = mcpState?.destroyPendingAt;
  const committedServerNames = Object.values(bridges)
    .filter((entry) => !entry.addState)
    .map((entry) => entry.server);
  const managedServerNames = [
    ...new Set([...(mcpState?.managedServerNames ?? []), ...committedServerNames]),
  ].sort();
  const hasDestroyState = !!destroyPreparedAt || !!destroyPendingAt;
  const updated = registry.updateSandbox(sandboxName, {
    mcp:
      Object.keys(bridges).length > 0 || managedServerNames.length > 0 || hasDestroyState
        ? {
            bridges,
            ...(managedServerNames.length > 0 ? { managedServerNames } : {}),
            ...(destroyPreparedAt ? { destroyPreparedAt } : {}),
            ...(destroyPendingAt ? { destroyPendingAt } : {}),
          }
        : undefined,
  });
  if (!updated) {
    throw new McpBridgeError(`Could not persist MCP lifecycle state for sandbox '${sandboxName}'.`);
  }
}

export function assertMcpDestroyNotPending(sandbox: SandboxEntry): void {
  if (!sandbox.mcp?.destroyPreparedAt && !sandbox.mcp?.destroyPendingAt) return;
  // Phase-aware recovery guidance. `destroyPendingAt` is written only after
  // OpenShell confirms deletion (mcp-bridge-destroy.ts), so the only safe action
  // is to finish the idempotent destroy. A prepared-only marker does not prove
  // deletion; `mcp remove --force` may recover in place if the sandbox is still
  // live, while failures preserve the marker.
  if (sandbox.mcp?.destroyPendingAt) {
    throw new McpBridgeError(
      `Sandbox '${sandbox.name}' is mid-destroy past the point of no return — the registry records that OpenShell deletion was already confirmed. Run \`nemoclaw ${sandbox.name} destroy\` to finish the (idempotent) cleanup.`,
    );
  }
  throw new McpBridgeError(
    `Sandbox '${sandbox.name}' has an incomplete MCP destroy transaction. Re-run the sandbox destroy command to finish cleanup, or, if the sandbox is still live, recover non-destructively with \`nemoclaw ${sandbox.name} mcp remove <server> --force\`.`,
  );
}

/**
 * Non-destructive recovery for a stuck MCP destroy transaction — PHASE-AWARE.
 *
 * When a prior destroy leaves a `destroyPreparedAt` marker behind (phase one:
 * in-sandbox scrub + provider detach done, deletion not durably confirmed)
 * every MCP command is refused by `assertMcpDestroyNotPending`, and rebuild
 * refuses up front with the same guard. Before #6376 the only advertised
 * recovery was `nemoclaw <name> destroy` — full sandbox destruction.
 *
 * This helper clears ONLY the prepared (phase-one) marker, in place, so a
 * `--force` caller can attempt the requested removal if the sandbox still
 * exists. It deliberately refuses the pending (phase-two) marker: that marker
 * records confirmed OpenShell deletion and is the durable retry state that
 * keeps still-owed provider/policy cleanup idempotent. Erasing it would silently
 * abandon that cleanup, so a pending transaction must be finished with
 * `nemoclaw <name> destroy`, not cleared.
 *
 * Callers clear the prepared marker only AFTER the requested removal succeeds
 * (see removeMcpBridge), so a failed recovery preserves the retry marker.
 * `setBridgeState` preserves the marker across the removal's own writes until
 * then.
 *
 * Returns whether the marker was actually cleared, so callers can log
 * accurately (no-op vs. cleared).
 *
 * Product contract (#6376), intentionally narrow:
 *   invalidState: a crash/abort mid-destroy leaves durable `destroyPreparedAt`
 *     and/or `destroyPendingAt` markers that fail every MCP command and rebuild.
 *   sourceBoundary: the markers are host-owned registry state; the sandbox does
 *     not write them. `destroyPreparedAt` = deletion is not durably confirmed
 *     (recoverable if still live); `destroyPendingAt` = the registry records
 *     confirmed OpenShell deletion (not recoverable in place — global
 *     provider/policy cleanup is still owed).
 *   sourceFixConstraint: there is no safe non-destructive reconciliation for the
 *     pending/both-marker live state, so this helper refuses it rather than
 *     guess. Prepared-only markers are recoverable with `mcp remove --force`;
 *     pending/both-marker state must finish `nemoclaw <name> destroy`.
 *   regressionTest: mcp-bridge-destroy-marker-recovery.test.ts (phase-aware
 *     clear/refuse, clear-only-after-proven-recovery, preserve-on-failure) and
 *     mcp-destroy-lifecycle.test.ts (phase-aware guard message).
 *   removalCondition: revisit if a safe pending-phase reconciliation is designed
 *     (proving the still-owed provider/policy cleanup is complete) — then this
 *     refusal could be relaxed.
 */
export function clearMcpDestroyMarkers(sandboxName: string): boolean {
  // Validate the name before any registry read/update — this helper mutates
  // durable state and must not trust an unvalidated identifier.
  validateSandboxName(sandboxName);
  const sandbox = registry.getSandbox(sandboxName);
  const mcpState = sandbox?.mcp;
  if (!mcpState?.destroyPreparedAt && !mcpState?.destroyPendingAt) return false;
  if (mcpState.destroyPendingAt) {
    throw new McpBridgeError(
      `Sandbox '${sandboxName}' is mid-destroy past the point of no return — the registry records that OpenShell deletion was already confirmed. Run \`nemoclaw ${sandboxName} destroy\` to finish cleanup; the pending-destroy marker cannot be cleared non-destructively.`,
    );
  }
  const bridges = mcpState.bridges ?? {};
  const managedServerNames = mcpState.managedServerNames ?? [];
  const updated = registry.updateSandbox(sandboxName, {
    mcp:
      Object.keys(bridges).length > 0 || managedServerNames.length > 0
        ? {
            bridges,
            ...(managedServerNames.length > 0 ? { managedServerNames } : {}),
          }
        : undefined,
  });
  if (!updated) {
    throw new McpBridgeError(
      `Could not clear incomplete MCP destroy markers for sandbox '${sandboxName}'.`,
    );
  }
  return true;
}

export function assertNoDerivedResourceCollision(
  sandbox: SandboxEntry,
  server: string,
  providerName: string | undefined,
  policyName: string,
): void {
  const conflictingCustomPolicy = sandbox.customPolicies?.find(
    (policy) => policy.name === policyName && policy.sourcePath !== MCP_BRIDGE_POLICY_SOURCE,
  );
  if (conflictingCustomPolicy || sandbox.policies?.includes(policyName)) {
    throw new McpBridgeError(
      `Generated MCP policy name '${policyName}' conflicts with an existing non-MCP policy. Choose a different server name.`,
      2,
    );
  }
  for (const entry of Object.values(bridgeState(sandbox))) {
    if (entry.server === server) continue;
    const providerCollision =
      providerName !== undefined &&
      entry.providerName !== undefined &&
      entry.providerName === providerName;
    if (providerCollision || entry.policyName === policyName) {
      throw new McpBridgeError(
        `MCP server '${server}' conflicts with existing server '${entry.server}' after OpenShell resource-name normalization. Choose a name that differs beyond case, hyphens, and underscores.`,
        2,
      );
    }
  }
}

export function writeBridgeEntry(sandboxName: string, entry: McpBridgeEntry): void {
  const sandbox = getSandboxOrThrow(sandboxName);
  const bridges = { ...bridgeState(sandbox), [entry.server]: entry };
  setBridgeState(sandboxName, bridges);
}

export function removeBridgeEntry(sandboxName: string, server: string): void {
  const sandbox = getSandboxOrThrow(sandboxName);
  const bridges = { ...bridgeState(sandbox) };
  delete bridges[server];
  setBridgeState(sandboxName, bridges);
}

export async function ensureSandboxGatewaySelected(sandboxName: string): Promise<void> {
  const gatewayName = getSandboxTargetGatewayName(sandboxName);
  const recovery = await recoverNamedGatewayRuntime({
    gatewayName,
  });
  if (!recovery.recovered || recovery.after.state !== "healthy_named") {
    throw new McpBridgeError(
      `Could not select healthy OpenShell gateway '${gatewayName}' for sandbox '${sandboxName}' (before: ${recovery.before.state}, after: ${recovery.after.state}). Refusing to mutate MCP resources on another gateway.`,
    );
  }
  // Pin every subsequent OpenShell subprocess in this lifecycle operation to
  // the sandbox's recorded gateway. The globally selected gateway is mutable
  // shared metadata and another NemoClaw process may select a sibling between
  // this health check and the provider/policy mutation.
  process.env.OPENSHELL_GATEWAY = gatewayName;
}
