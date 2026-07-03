// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as policies from "../../policy";
import type { McpBridgeEntry } from "../../state/registry";
import * as registry from "../../state/registry";
import {
  isAgentMcpAdapter,
  MCP_BRIDGE_POLICY_SOURCE,
  McpBridgeError,
} from "./mcp-bridge-contracts";
import { buildMcpBridgePolicyKey, buildMcpBridgePolicyYaml } from "./mcp-bridge-policy-render";

export {
  buildMcpBridgePolicyKey,
  buildMcpBridgePolicyName,
  buildMcpBridgePolicyYaml,
  MCP_BRIDGE_ALLOWED_METHODS,
  MCP_BRIDGE_POLICY_MAX_BODY_BYTES,
} from "./mcp-bridge-policy-render";

type GeneratedPolicyRegistrationState = {
  policy: registry.CustomPolicyEntry;
  state: "match" | "absent" | "drift" | null;
  confirmed: boolean;
};

function withoutPendingContent(
  policy: registry.CustomPolicyEntry,
  content = policy.content,
): registry.CustomPolicyEntry {
  const { pendingContent: _pendingContent, ...confirmed } = policy;
  return { ...confirmed, content };
}

function persistGeneratedPolicyRegistration(
  sandboxName: string,
  policy: registry.CustomPolicyEntry,
): void {
  if (!registry.addCustomPolicy(sandboxName, policy)) {
    throw new McpBridgeError(
      `Could not persist ownership for generated MCP policy '${policy.name}'.`,
    );
  }
}

/**
 * Resolve a crash-interrupted generated-policy transition against the effective
 * gateway policy. `content` remains the last confirmed value while
 * `pendingContent` reserves the desired value, so either side of the mutation
 * can be recognized safely after process death.
 */
function reconcileGeneratedPolicyRegistration(
  sandboxName: string,
  policy: registry.CustomPolicyEntry,
): GeneratedPolicyRegistrationState {
  const pendingContent = policy.pendingContent;
  if (pendingContent === undefined) {
    return {
      policy,
      state: policies.getPresetContentGatewayState(sandboxName, policy.content),
      confirmed: true,
    };
  }
  if (!pendingContent) {
    return { policy, state: "drift", confirmed: false };
  }

  const pendingState = policies.getPresetContentGatewayState(sandboxName, pendingContent);
  if (pendingState === "match") {
    const confirmedPolicy = withoutPendingContent(policy, pendingContent);
    persistGeneratedPolicyRegistration(sandboxName, confirmedPolicy);
    return { policy: confirmedPolicy, state: "match", confirmed: true };
  }

  // A new add has no older confirmed value; content equals the reservation.
  // Only an absent key is safe to retry.
  if (pendingContent === policy.content) {
    return { policy, state: pendingState, confirmed: false };
  }

  const confirmedState = policies.getPresetContentGatewayState(sandboxName, policy.content);
  if (confirmedState === "match" || (confirmedState === "absent" && pendingState === "absent")) {
    const confirmedPolicy = withoutPendingContent(policy);
    persistGeneratedPolicyRegistration(sandboxName, confirmedPolicy);
    return { policy: confirmedPolicy, state: confirmedState, confirmed: true };
  }
  return { policy, state: confirmedState === null ? null : "drift", confirmed: false };
}

export function applyGeneratedPolicy(
  sandboxName: string,
  entry: McpBridgeEntry,
  resolvedAddresses: readonly string[],
): void {
  if (resolvedAddresses.length === 0) {
    throw new McpBridgeError(
      `Refusing to apply generated MCP policy '${entry.policyName}' without exact public address pins.`,
    );
  }
  const adapter = isAgentMcpAdapter(entry.adapter) ? entry.adapter : "mcporter";
  const content = buildMcpBridgePolicyYaml(entry.server, entry.url, adapter, resolvedAddresses);
  const policyKey = buildMcpBridgePolicyKey(entry.server);
  const sameNamePolicy = registry
    .getCustomPolicies(sandboxName)
    .find((policy) => policy.name === entry.policyName);
  if (sameNamePolicy && sameNamePolicy.sourcePath !== MCP_BRIDGE_POLICY_SOURCE) {
    throw new McpBridgeError(
      `Generated MCP policy '${entry.policyName}' conflicts with an unowned same-name registry record. Refusing to replace operator-owned policy state.`,
    );
  }
  const registeredPolicy = sameNamePolicy;
  let previousPolicy: registry.CustomPolicyEntry | undefined;
  let previousPolicyConfirmed = false;
  let ownsExistingPolicyKey = false;
  if (registeredPolicy) {
    const reconciled = reconcileGeneratedPolicyRegistration(sandboxName, registeredPolicy);
    previousPolicy = reconciled.policy;
    previousPolicyConfirmed = reconciled.confirmed;
    const previousState = reconciled.state;
    if (previousState !== "absent" && previousState !== "match") {
      throw new McpBridgeError(
        `Generated MCP policy '${entry.policyName}' has drifted or could not be inspected against its recorded content. Refusing to replace the live key.`,
      );
    }
    // A prior ownership record may have been reserved immediately before a
    // process died, so an absent key is safe to create. A present key is safe
    // to replace only after its full content matches that ownership record.
    ownsExistingPolicyKey = previousState === "match";
  } else {
    const unownedState = policies.getPresetContentGatewayState(sandboxName, content);
    if (unownedState !== "absent") {
      throw new McpBridgeError(
        `Generated MCP policy key '${policyKey}' is already present or could not be inspected without a NemoClaw ownership record.`,
      );
    }
  }

  // Preserve the last confirmed content while reserving a changed desired
  // value. For a brand-new key, content and pendingContent are intentionally
  // equal so an absent live key remains recognizable as an uncommitted add.
  let reservation: registry.CustomPolicyEntry;
  if (
    previousPolicy &&
    previousPolicy.content === content &&
    (previousPolicy.pendingContent === undefined || previousPolicy.pendingContent === content)
  ) {
    reservation = previousPolicy;
  } else if (previousPolicy) {
    reservation = { ...withoutPendingContent(previousPolicy), pendingContent: content };
    persistGeneratedPolicyRegistration(sandboxName, reservation);
  } else {
    reservation = {
      name: entry.policyName,
      content,
      pendingContent: content,
      sourcePath: MCP_BRIDGE_POLICY_SOURCE,
    };
    persistGeneratedPolicyRegistration(sandboxName, reservation);
  }
  // `custom` denotes user-supplied preset content and intentionally rejects
  // `allowed_ips`. This content is generated from validated MCP inputs and the
  // ownership reservation above; `skipRegistryUpdate` avoids a second write.
  const ok = policies.applyPresetContent(sandboxName, entry.policyName, content, {
    expectedExistingNetworkPolicyContent:
      ownsExistingPolicyKey && previousPolicy ? previousPolicy.content : null,
    nonFatal: true,
    skipRegistryUpdate: true,
  });
  // `policy set --wait` proves that a submitted revision loaded, but OpenShell
  // also returns success for unchanged and concurrently superseded revisions.
  // Confirm that the effective policy still contains our exact generated entry.
  const activeState = policies.getPresetContentGatewayState(sandboxName, content);
  if (ok !== false && activeState === "match") {
    persistGeneratedPolicyRegistration(sandboxName, withoutPendingContent(reservation, content));
    return;
  }

  if (previousPolicyConfirmed && previousPolicy) {
    const previousState = policies.getPresetContentGatewayState(
      sandboxName,
      previousPolicy.content,
    );
    if (previousState === "match" || (previousState === "absent" && activeState === "absent")) {
      persistGeneratedPolicyRegistration(sandboxName, withoutPendingContent(previousPolicy));
    }
  } else if (activeState === "absent") {
    registry.removeCustomPolicyByName(sandboxName, entry.policyName);
  }
  const detail =
    activeState === "match" ? "the update command failed" : `effective state: ${activeState}`;
  throw new McpBridgeError(
    `Failed to activate generated MCP policy '${entry.policyName}' (${detail}).`,
  );
}

function generatedPolicyContent(entry: McpBridgeEntry): string {
  const adapter = isAgentMcpAdapter(entry.adapter) ? entry.adapter : "mcporter";
  return buildMcpBridgePolicyYaml(entry.server, entry.url, adapter);
}

export function assertGeneratedPolicyMutationSafe(
  sandboxName: string,
  entry: McpBridgeEntry,
): void {
  const registeredPolicy = assertGeneratedPolicyRegistrationMutationSafe(sandboxName, entry);
  const owned = registeredPolicy !== undefined;
  const reconciled = registeredPolicy
    ? reconcileGeneratedPolicyRegistration(sandboxName, registeredPolicy)
    : undefined;
  const content = reconciled?.policy.content ?? generatedPolicyContent(entry);
  const state = reconciled?.state ?? policies.getPresetContentGatewayState(sandboxName, content);
  if (state === "absent") return;
  if (!owned || state !== "match") {
    throw new McpBridgeError(
      `Generated MCP policy '${entry.policyName}' is unowned, unreachable, or drifted. Refusing to mutate the adapter, provider, or same-key live policy until ownership is resolved.`,
    );
  }
}

/** Check registry ownership without consulting a sandbox already proven absent. */
export function assertGeneratedPolicyRegistrationMutationSafe(
  sandboxName: string,
  entry: McpBridgeEntry,
): registry.CustomPolicyEntry | undefined {
  const registeredPolicy = registry
    .getCustomPolicies(sandboxName)
    .find((policy) => policy.name === entry.policyName);
  const owned = registeredPolicy?.sourcePath === MCP_BRIDGE_POLICY_SOURCE;
  if (registeredPolicy && !owned) {
    throw new McpBridgeError(
      `Generated MCP policy '${entry.policyName}' conflicts with an unowned same-name registry record. Refusing to mutate the adapter, provider, or live policy.`,
    );
  }
  return owned ? registeredPolicy : undefined;
}

export function removeGeneratedPolicy(
  sandboxName: string,
  entry: McpBridgeEntry,
  options: { bestEffort?: boolean } = {},
): void {
  const policyName = entry.policyName;
  const registeredPolicy = registry
    .getCustomPolicies(sandboxName)
    .find((policy) => policy.name === policyName);
  const ownsRegistration = registeredPolicy?.sourcePath === MCP_BRIDGE_POLICY_SOURCE;
  const reconciled =
    registeredPolicy && ownsRegistration
      ? reconcileGeneratedPolicyRegistration(sandboxName, registeredPolicy)
      : undefined;
  const effectiveRegistration = reconciled?.policy ?? registeredPolicy;
  const content = effectiveRegistration?.content ?? generatedPolicyContent(entry);
  const gatewayState =
    reconciled?.state ?? policies.getPresetContentGatewayState(sandboxName, content);
  if (gatewayState === "absent") {
    if (ownsRegistration) {
      registry.removeCustomPolicyByName(sandboxName, policyName);
    }
    return;
  }
  if (!ownsRegistration || gatewayState !== "match") {
    if (options.bestEffort) return;
    throw new McpBridgeError(
      `Generated MCP policy '${policyName}' is unowned, unreachable, or no longer matches its registered content. Refusing to delete same-key policy state.`,
    );
  }
  const ok = policies.removePreset(sandboxName, policyName, {
    nonFatal: true,
    // Keep ownership durable across a crash or superseded OpenShell revision.
    // It is cleared only after the exact live key is proven absent below.
    skipRegistryUpdate: true,
  });
  // OpenShell can acknowledge a superseded policy revision as success. Confirm
  // the exact generated key is absent before discarding its ownership record.
  const activeState = policies.getPresetContentGatewayState(sandboxName, content);
  if (activeState === "absent") {
    registry.removeCustomPolicyByName(sandboxName, policyName);
    return;
  }
  // Keep (or defensively restore) the last reconciled ownership record when
  // exact post-state is not proven.
  if (ownsRegistration && effectiveRegistration) {
    persistGeneratedPolicyRegistration(sandboxName, effectiveRegistration);
  }
  if (options.bestEffort) return;
  const detail = ok ? `effective state: ${activeState}` : "the removal command failed";
  throw new McpBridgeError(`Failed to remove generated MCP policy '${policyName}' (${detail}).`);
}

export function getRegisteredGeneratedPolicy(
  sandboxName: string,
  entry: McpBridgeEntry | undefined,
): ReturnType<typeof registry.getCustomPolicies>[number] | undefined {
  if (!entry?.policyName) return undefined;
  return registry
    .getCustomPolicies(sandboxName)
    .find(
      (policy) =>
        policy.name === entry.policyName && policy.sourcePath === MCP_BRIDGE_POLICY_SOURCE,
    );
}

export function getPolicyPresence(
  sandboxName: string,
  entry: McpBridgeEntry | undefined,
): boolean | null {
  if (!entry?.policyName) return false;
  const registeredPolicy = getRegisteredGeneratedPolicy(sandboxName, entry);
  if (!registeredPolicy) return null;
  const confirmedState = policies.getPresetContentGatewayState(
    sandboxName,
    registeredPolicy.content,
  );
  if (confirmedState === "match") return true;
  const pendingContent = registeredPolicy.pendingContent;
  if (typeof pendingContent !== "string" || pendingContent.length === 0) {
    return confirmedState === null ? null : false;
  }
  const pendingState = policies.getPresetContentGatewayState(sandboxName, pendingContent);
  if (pendingState === "match") return true;
  return confirmedState === null || pendingState === null ? null : false;
}
