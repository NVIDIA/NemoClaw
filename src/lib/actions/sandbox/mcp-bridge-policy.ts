// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isIP } from "node:net";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";

import type { AgentMcpAdapter } from "../../agent/defs";
import { diagnosticPreview } from "../../name-validation";
import * as policies from "../../policy";
import { isBlockedMcpUrlTargetHost } from "../../security/mcp-url-target";
import {
  assertTrustedPrivateEndpointCapability,
  replayTrustedPrivateEndpoint,
} from "../../security/trusted-private-endpoint";
import type { McpBridgeEntry } from "../../state/registry";
import * as registry from "../../state/registry";
import {
  isAgentMcpAdapter,
  MCP_BRIDGE_POLICY_SOURCE,
  McpBridgeError,
} from "./mcp-bridge-contracts";
import {
  buildMcpBridgeCapabilityPolicyYaml,
  buildMcpBridgePolicyKey,
  buildMcpBridgePolicyName,
  buildMcpBridgePolicyYaml,
} from "./mcp-bridge-policy-render";
import type { McpBridgeTargetValidation } from "./mcp-bridge-url-validation";

export { MCP_BRIDGE_POLICY_SOURCE } from "./mcp-bridge-contracts";
export {
  buildMcpBridgePolicyKey,
  buildMcpBridgePolicyName,
  buildMcpBridgePolicyYaml,
  MCP_BRIDGE_ALLOWED_METHODS,
  MCP_BRIDGE_POLICY_MAX_BODY_BYTES,
} from "./mcp-bridge-policy-render";

export interface ExactManagedMcpPolicy {
  key: string;
  networkPolicy: unknown;
  policyName: string;
  server: string;
}

export interface ManagedMcpPolicyOmission {
  key?: string;
  policyName?: string;
  server?: string;
  reason: string;
}

export interface ProvableManagedMcpPolicies {
  policies: ExactManagedMcpPolicy[];
  omissions: ManagedMcpPolicyOmission[];
}

type ManagedMcpPolicyInspectionDeps = {
  getSandbox: typeof registry.getSandbox;
};

const managedMcpPolicyInspectionDeps: ManagedMcpPolicyInspectionDeps = {
  getSandbox: registry.getSandbox,
};

function parseManagedPolicyDocument(source: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = YAML.parse(source);
  } catch {
    throw new Error(`${label} is not valid YAML`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a YAML mapping`);
  }
  return parsed as Record<string, unknown>;
}

function readManagedNetworkPolicies(
  document: Record<string, unknown>,
  label: string,
): Record<string, unknown> {
  const networkPolicies = document.network_policies;
  if (networkPolicies === undefined || networkPolicies === null) return {};
  if (typeof networkPolicies !== "object" || Array.isArray(networkPolicies)) {
    throw new Error(`${label} network_policies must be a mapping`);
  }
  return networkPolicies as Record<string, unknown>;
}

function requireCanonicalAllowedIps(
  networkPolicy: unknown,
  policyName: string,
  bridge: McpBridgeEntry,
): McpBridgeTargetValidation {
  const addressKind = bridge.trustedPrivateHost ? "trusted-private" : "public";
  if (!networkPolicy || typeof networkPolicy !== "object" || Array.isArray(networkPolicy)) {
    throw new Error(`Managed MCP policy '${policyName}' has non-canonical generated content`);
  }
  const endpoints = (networkPolicy as Record<string, unknown>).endpoints;
  if (!Array.isArray(endpoints) || endpoints.length !== 1) {
    throw new Error(`Managed MCP policy '${policyName}' has non-canonical generated content`);
  }
  const endpoint = endpoints[0];
  if (!endpoint || typeof endpoint !== "object" || Array.isArray(endpoint)) {
    throw new Error(`Managed MCP policy '${policyName}' has non-canonical generated content`);
  }
  const allowedIps = (endpoint as Record<string, unknown>).allowed_ips;
  if (!Array.isArray(allowedIps) || allowedIps.length === 0) {
    throw new Error(`Managed MCP policy '${policyName}' has no exact ${addressKind} address pins`);
  }
  if (
    allowedIps.some(
      (address) =>
        typeof address !== "string" ||
        address !== address.toLowerCase() ||
        address.includes("%") ||
        isIP(address) === 0,
    )
  ) {
    throw new Error(`Managed MCP policy '${policyName}' has invalid ${addressKind} address pins`);
  }
  const pins = allowedIps as string[];
  if (new Set(pins).size !== pins.length || !isDeepStrictEqual(pins, [...pins].sort())) {
    throw new Error(
      `Managed MCP policy '${policyName}' has non-canonical ${addressKind} address pins`,
    );
  }
  if (bridge.trustedPrivateHost) {
    let replay;
    try {
      replay = replayTrustedPrivateEndpoint(bridge.trustedPrivateHost, bridge.allowedIps ?? [], {
        requireAllPrivate: true,
      });
    } catch {
      throw new Error(
        `Managed MCP policy '${policyName}' has invalid trusted-private address pins`,
      );
    }
    if (
      replay.host !== bridge.trustedPrivateHost ||
      !isDeepStrictEqual(replay.addresses, bridge.allowedIps) ||
      !isDeepStrictEqual(pins, bridge.allowedIps)
    ) {
      throw new Error(
        `Managed MCP policy '${policyName}' does not match its recorded trusted-private address pins`,
      );
    }
    return {
      addresses: [...pins],
      trustedPrivateCapability: replay.trustedPrivateCapability,
      trustedPrivateHost: replay.host,
    };
  } else if (pins.some((address) => isBlockedMcpUrlTargetHost(address))) {
    throw new Error(`Managed MCP policy '${policyName}' has invalid public address pins`);
  }
  return { addresses: [...pins] };
}

function resolveCanonicalManagedMcpAdapter(
  sandbox: registry.SandboxEntry,
  bridge: McpBridgeEntry,
): AgentMcpAdapter {
  if (isAgentMcpAdapter(bridge.adapter)) return bridge.adapter;
  switch (sandbox.agent || "openclaw") {
    case "openclaw":
      return "mcporter";
    case "hermes":
      return "hermes-config";
    case "langchain-deepagents-code":
      return "deepagents-config";
    default:
      throw new Error("Managed MCP bridge has no canonical adapter");
  }
}

function requireCanonicalManagedPolicy(
  sandbox: registry.SandboxEntry,
  server: string,
  livePolicies?: Record<string, unknown>,
): ExactManagedMcpPolicy {
  const bridge = sandbox.mcp?.bridges[server];
  if (!bridge || bridge.addState || bridge.server !== server) {
    throw new Error(
      `Managed MCP bridge ${diagnosticPreview(server)} has an incomplete lifecycle transition`,
    );
  }

  const policyName = buildMcpBridgePolicyName(server);
  const policyKey = buildMcpBridgePolicyKey(server);
  if (bridge.policyName !== policyName) {
    throw new Error(`Managed MCP bridge '${server}' has a non-canonical policy name`);
  }

  const registrations = (sandbox.customPolicies ?? []).filter(
    (policy) => policy.name === policyName,
  );
  if (registrations.length !== 1) {
    throw new Error(
      `Managed MCP bridge '${server}' does not have one exact policy ownership record`,
    );
  }
  const [registration] = registrations;
  if (registration?.sourcePath !== MCP_BRIDGE_POLICY_SOURCE) {
    throw new Error(`Managed MCP bridge '${server}' has no NemoClaw-owned policy record`);
  }
  if (registration.pendingContent !== undefined) {
    throw new Error(`Managed MCP bridge '${server}' has an incomplete policy transition`);
  }

  const registeredDocument = parseManagedPolicyDocument(
    registration.content,
    `Managed MCP policy '${policyName}'`,
  );
  const preset = registeredDocument.preset;
  if (
    !preset ||
    typeof preset !== "object" ||
    Array.isArray(preset) ||
    (preset as Record<string, unknown>).name !== policyName
  ) {
    throw new Error(`Managed MCP policy '${policyName}' has non-canonical preset metadata`);
  }
  const registeredPolicies = readManagedNetworkPolicies(
    registeredDocument,
    `Managed MCP policy '${policyName}'`,
  );
  const registeredKeys = Object.keys(registeredPolicies);
  if (registeredKeys.length !== 1 || registeredKeys[0] !== policyKey) {
    throw new Error(`Managed MCP policy '${policyName}' has a non-canonical network policy key`);
  }

  const registeredNetworkPolicy = registeredPolicies[policyKey];
  const target = requireCanonicalAllowedIps(registeredNetworkPolicy, policyName, bridge);
  let expectedDocument: Record<string, unknown>;
  try {
    expectedDocument = parseManagedPolicyDocument(
      buildMcpBridgePolicyYaml(
        bridge.server,
        bridge.url,
        resolveCanonicalManagedMcpAdapter(sandbox, bridge),
        target,
        bridge.providerName ?? "",
      ),
      `Canonical managed MCP policy '${policyName}'`,
    );
  } catch {
    throw new Error(`Managed MCP policy '${policyName}' has non-canonical generated content`);
  }
  if (!isDeepStrictEqual(registeredDocument, expectedDocument)) {
    throw new Error(`Managed MCP policy '${policyName}' has non-canonical generated content`);
  }

  if (livePolicies && !Object.hasOwn(livePolicies, policyKey)) {
    throw new Error(`Managed MCP policy '${policyName}' is absent from the live gateway policy`);
  }
  if (livePolicies && !isDeepStrictEqual(livePolicies[policyKey], registeredNetworkPolicy)) {
    throw new Error(`Managed MCP policy '${policyName}' has drifted from its ownership record`);
  }

  return {
    key: policyKey,
    networkPolicy: registeredNetworkPolicy,
    policyName,
    server,
  };
}

/**
 * Resolve the exact generated MCP entries that NemoClaw currently owns.
 *
 * The registry is an ownership claim, not sufficient authority to overwrite
 * the gateway. Every committed bridge must have one canonical, fully
 * committed custom-policy record whose sole network entry exactly matches the
 * live base policy.
 */
function inspectCanonicalManagedMcpPolicies(
  sandboxName: string,
  livePolicies: Record<string, unknown> | undefined,
  deps: ManagedMcpPolicyInspectionDeps = managedMcpPolicyInspectionDeps,
): ExactManagedMcpPolicy[] {
  const sandbox = deps.getSandbox(sandboxName);
  if (!sandbox) {
    const unclassifiedKey = Object.keys(livePolicies ?? {}).find((key) =>
      key.startsWith("mcp_bridge_"),
    );
    if (unclassifiedKey) {
      throw new Error(
        `Reserved MCP policy key ${diagnosticPreview(unclassifiedKey)} has no committed managed bridge ownership`,
      );
    }
    return [];
  }
  const generatedRegistrations = (sandbox.customPolicies ?? []).filter(
    (policy) => policy.sourcePath === MCP_BRIDGE_POLICY_SOURCE,
  );
  if (!sandbox.mcp) {
    const orphaned = generatedRegistrations[0];
    if (orphaned) {
      throw new Error(
        `Generated MCP policy ${diagnosticPreview(orphaned.name)} has no committed managed bridge ownership`,
      );
    }
    const unclassifiedKey = Object.keys(livePolicies ?? {}).find((key) =>
      key.startsWith("mcp_bridge_"),
    );
    if (unclassifiedKey) {
      throw new Error(
        `Reserved MCP policy key ${diagnosticPreview(unclassifiedKey)} has no committed managed bridge ownership`,
      );
    }
    return [];
  }
  if (sandbox.mcp.destroyPreparedAt || sandbox.mcp.destroyPendingAt) {
    throw new Error("Managed MCP sandbox destruction is incomplete");
  }

  const bridgeEntries = Object.entries(sandbox.mcp.bridges);
  if (bridgeEntries.some(([, bridge]) => bridge.addState !== undefined)) {
    throw new Error("A managed MCP bridge lifecycle transition is incomplete");
  }
  const exact = bridgeEntries.map(([server]) =>
    requireCanonicalManagedPolicy(sandbox, server, livePolicies),
  );

  const committedPolicyNames = new Set(exact.map((entry) => entry.policyName));
  const orphaned = generatedRegistrations.find(
    (registration) => !committedPolicyNames.has(registration.name),
  );
  if (orphaned) {
    throw new Error(
      `Generated MCP policy ${diagnosticPreview(orphaned.name)} has no committed managed bridge ownership`,
    );
  }

  const keys = new Set<string>();
  for (const entry of exact) {
    if (keys.has(entry.key)) {
      throw new Error(`Managed MCP policy key '${entry.key}' has ambiguous bridge ownership`);
    }
    keys.add(entry.key);
  }
  const unclassifiedKey = Object.keys(livePolicies ?? {}).find(
    (key) => key.startsWith("mcp_bridge_") && !keys.has(key),
  );
  if (unclassifiedKey) {
    throw new Error(
      `Reserved MCP policy key ${diagnosticPreview(unclassifiedKey)} has no committed managed bridge ownership`,
    );
  }
  return exact.sort((left, right) => left.key.localeCompare(right.key));
}

export function inspectExactManagedMcpPolicies(
  sandboxName: string,
  livePolicyYaml: string,
  deps: ManagedMcpPolicyInspectionDeps = managedMcpPolicyInspectionDeps,
): ExactManagedMcpPolicy[] {
  const liveDocument = parseManagedPolicyDocument(livePolicyYaml, "Live gateway policy");
  return inspectCanonicalManagedMcpPolicies(
    sandboxName,
    readManagedNetworkPolicies(liveDocument, "Live gateway policy"),
    deps,
  );
}

export function inspectRecordedManagedMcpPolicies(
  sandboxName: string,
  deps: ManagedMcpPolicyInspectionDeps = managedMcpPolicyInspectionDeps,
): ExactManagedMcpPolicy[] {
  return inspectCanonicalManagedMcpPolicies(sandboxName, undefined, deps);
}

/**
 * Deadline-only inspection for automatic Shields restoration.
 *
 * Each entry is admitted independently through the same exact committed/live
 * proof as the strict path. Incomplete, drifted, orphaned, or ambiguous claims
 * are omitted instead of extending the mutable window; registry state is never
 * reconciled or rewritten here.
 */
export function inspectProvableManagedMcpPoliciesForDeadline(
  sandboxName: string,
  livePolicyYaml: string,
  deps: ManagedMcpPolicyInspectionDeps = managedMcpPolicyInspectionDeps,
): ProvableManagedMcpPolicies {
  const derivedIdentity = (server: string): { key?: string; policyName?: string } => {
    try {
      return {
        key: buildMcpBridgePolicyKey(server),
        policyName: buildMcpBridgePolicyName(server),
      };
    } catch {
      return {};
    }
  };
  const omit = (reason: string, server?: string, policyName?: string): ManagedMcpPolicyOmission => {
    const identity = server ? derivedIdentity(server) : {};
    return {
      ...(server ? { server } : {}),
      ...identity,
      ...(policyName ? { policyName } : {}),
      reason,
    };
  };
  const sandbox = deps.getSandbox(sandboxName);
  const generatedRegistrations = (sandbox?.customPolicies ?? []).filter(
    (policy) => policy.sourcePath === MCP_BRIDGE_POLICY_SOURCE,
  );
  const bridgeEntries = Object.entries(sandbox?.mcp?.bridges ?? {});

  if (sandbox?.mcp?.destroyPreparedAt || sandbox?.mcp?.destroyPendingAt) {
    const reason = "Managed MCP sandbox destruction is incomplete";
    const omissions = bridgeEntries.map(([server]) => omit(reason, server));
    for (const registration of generatedRegistrations) {
      if (!omissions.some((entry) => entry.policyName === registration.name)) {
        omissions.push(omit(reason, undefined, registration.name));
      }
    }
    if (omissions.length === 0) omissions.push({ reason });
    return { policies: [], omissions };
  }

  let livePolicies: Record<string, unknown>;
  try {
    livePolicies = readManagedNetworkPolicies(
      parseManagedPolicyDocument(livePolicyYaml, "Live gateway policy"),
      "Live gateway policy",
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const omissions = bridgeEntries.map(([server]) => omit(reason, server));
    for (const registration of generatedRegistrations) {
      if (!omissions.some((entry) => entry.policyName === registration.name)) {
        omissions.push(omit(reason, undefined, registration.name));
      }
    }
    return { policies: [], omissions };
  }

  const policies: ExactManagedMcpPolicy[] = [];
  const omissions: ManagedMcpPolicyOmission[] = [];
  if (!sandbox) {
    for (const key of Object.keys(livePolicies).filter((candidate) =>
      candidate.startsWith("mcp_bridge_"),
    )) {
      omissions.push({
        key,
        reason: `Reserved MCP policy key '${key}' has no committed managed bridge ownership`,
      });
    }
    return { policies, omissions };
  }
  const claimedServersByKey = new Map<string, string[]>();
  const claimedServersByPolicyName = new Map<string, string[]>();
  for (const [server] of bridgeEntries) {
    const identity = derivedIdentity(server);
    if (identity.key) {
      const servers = claimedServersByKey.get(identity.key) ?? [];
      servers.push(server);
      claimedServersByKey.set(identity.key, servers);
    }
    if (identity.policyName) {
      const servers = claimedServersByPolicyName.get(identity.policyName) ?? [];
      servers.push(server);
      claimedServersByPolicyName.set(identity.policyName, servers);
    }
  }
  const ambiguousServers = new Set<string>();
  for (const servers of [...claimedServersByKey.values(), ...claimedServersByPolicyName.values()]) {
    if (servers.length <= 1) continue;
    for (const server of servers) ambiguousServers.add(server);
  }
  for (const [server] of bridgeEntries) {
    if (ambiguousServers.has(server)) {
      omissions.push(omit("Managed MCP policy identity has ambiguous bridge ownership", server));
      continue;
    }
    try {
      policies.push(requireCanonicalManagedPolicy(sandbox, server, livePolicies));
    } catch (error) {
      omissions.push(omit(error instanceof Error ? error.message : String(error), server));
    }
  }

  const bridgePolicyNames = new Set(
    bridgeEntries
      .map(([server]) => derivedIdentity(server).policyName)
      .filter((name): name is string => name !== undefined),
  );
  for (const registration of generatedRegistrations) {
    if (!bridgePolicyNames.has(registration.name)) {
      omissions.push(
        omit(
          `Generated MCP policy '${registration.name}' has no committed managed bridge ownership`,
          undefined,
          registration.name,
        ),
      );
    }
  }

  const policiesByKey = new Map<string, ExactManagedMcpPolicy[]>();
  for (const policy of policies) {
    const entries = policiesByKey.get(policy.key) ?? [];
    entries.push(policy);
    policiesByKey.set(policy.key, entries);
  }
  const exact: ExactManagedMcpPolicy[] = [];
  for (const entries of policiesByKey.values()) {
    if (entries.length === 1) {
      exact.push(entries[0]!);
      continue;
    }
    for (const entry of entries) {
      omissions.push(
        omit(`Managed MCP policy key '${entry.key}' has ambiguous ownership`, entry.server),
      );
    }
  }
  const exactKeys = new Set(exact.map((entry) => entry.key));
  for (const key of Object.keys(livePolicies).filter(
    (candidate) => candidate.startsWith("mcp_bridge_") && !exactKeys.has(candidate),
  )) {
    if (omissions.some((entry) => entry.key === key)) continue;
    omissions.push({
      key,
      reason: `Reserved MCP policy key '${key}' has no exact committed managed bridge ownership`,
    });
  }
  return {
    policies: exact.sort((left, right) => left.key.localeCompare(right.key)),
    omissions,
  };
}

export function hasManagedMcpPolicyClaims(
  sandboxName: string,
  deps: ManagedMcpPolicyInspectionDeps = managedMcpPolicyInspectionDeps,
): boolean {
  const sandbox = deps.getSandbox(sandboxName);
  if (!sandbox) return false;
  return (
    Boolean(
      sandbox.mcp &&
      (Object.keys(sandbox.mcp.bridges).length > 0 ||
        (sandbox.mcp.managedServerNames?.length ?? 0) > 0 ||
        sandbox.mcp.destroyPreparedAt ||
        sandbox.mcp.destroyPendingAt),
    ) ||
    (sandbox.customPolicies ?? []).some((policy) => policy.sourcePath === MCP_BRIDGE_POLICY_SOURCE)
  );
}

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
  target: McpBridgeTargetValidation,
  options: { bindCredential?: boolean } = {},
): void {
  const resolvedAddresses = assertMcpBridgePolicyTarget(entry, target);
  if (resolvedAddresses.length === 0) {
    throw new McpBridgeError(
      `Refusing to apply generated MCP policy '${entry.policyName}' without exact public address pins.`,
    );
  }
  const adapter = isAgentMcpAdapter(entry.adapter) ? entry.adapter : "mcporter";
  const content =
    options.bindCredential === false
      ? buildMcpBridgeCapabilityPolicyYaml(entry.server, entry.url, adapter, target)
      : buildMcpBridgePolicyYaml(
          entry.server,
          entry.url,
          adapter,
          target,
          entry.providerName ?? "",
        );
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

export function assertMcpBridgePolicyTarget(
  entry: McpBridgeEntry,
  target: McpBridgeTargetValidation,
): readonly string[] {
  if (target.addresses.length === 0) {
    throw new McpBridgeError(
      `Refusing to apply generated MCP policy '${entry.policyName}' without exact ${entry.trustedPrivateHost ? "trusted-private" : "public"} address pins.`,
    );
  }
  if (!entry.trustedPrivateHost) {
    if (target.trustedPrivateCapability || target.trustedPrivateHost) {
      throw new McpBridgeError(
        `MCP server '${entry.server}' has no durable trusted-private intent. Refusing private policy mutation.`,
      );
    }
    return target.addresses;
  }
  let authority;
  try {
    authority = assertTrustedPrivateEndpointCapability(
      entry.trustedPrivateHost,
      target.addresses,
      target.trustedPrivateCapability,
      { requireAllPrivate: true },
    );
  } catch {
    throw new McpBridgeError(
      `MCP server '${entry.server}' has no provenance-checked capability for trusted private host '${entry.trustedPrivateHost}'.`,
    );
  }
  const recordedPins = entry.allowedIps ?? [];
  if (
    target.trustedPrivateHost !== authority.host ||
    !isDeepStrictEqual(authority.addresses, recordedPins)
  ) {
    throw new McpBridgeError(
      `MCP server '${entry.server}' no longer resolves to its recorded trusted-private address pins. Remove and re-add the server to approve changed pins.`,
      2,
    );
  }
  return recordedPins;
}

function getUnownedGeneratedPolicyState(
  sandboxName: string,
  entry: McpBridgeEntry,
): "absent" | "present" | null {
  try {
    return policies.getLiveSandboxPolicyEntryDigest(
      sandboxName,
      buildMcpBridgePolicyKey(entry.server),
    ) === null
      ? "absent"
      : "present";
  } catch {
    return null;
  }
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
  const state = reconciled?.state ?? getUnownedGeneratedPolicyState(sandboxName, entry);
  if (state === "absent") return;
  if (!owned || state !== "match") {
    throw new McpBridgeError(
      `Generated MCP policy '${entry.policyName}' is unowned, unreachable, or drifted. Refusing to mutate the adapter, provider, or same-key live policy until ownership is resolved. The registry entry was preserved so cleanup can be retried.`,
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

/**
 * Prove that a complete bridge still owns its exact live policy without
 * reconciling crash markers or writing registry state. This is intentionally
 * stricter than the mutation preflight: a still-live sandbox whose adapter
 * cannot be inspected may cross the rebuild delete boundary only from a fully
 * committed policy registration generated for the authoritative recorded-agent
 * adapter and exactly matching the gateway.
 */
export function assertGeneratedPolicyExactReadOnly(
  sandboxName: string,
  entry: McpBridgeEntry,
  adapter: AgentMcpAdapter,
  target: McpBridgeTargetValidation,
): registry.CustomPolicyEntry {
  const resolvedAddresses = assertMcpBridgePolicyTarget(entry, target);
  const canonicalOwnershipError = (): McpBridgeError =>
    new McpBridgeError(
      "Generated MCP policy ownership is not canonical for its recorded bridge definition. Refusing host-side rebuild recovery.",
    );
  let expectedPolicyName: string;
  try {
    expectedPolicyName = buildMcpBridgePolicyName(entry.server);
  } catch {
    throw canonicalOwnershipError();
  }
  if (
    entry.policyName !== expectedPolicyName ||
    entry.adapter !== adapter ||
    resolvedAddresses.length === 0
  ) {
    throw canonicalOwnershipError();
  }
  let expectedContent: string;
  try {
    expectedContent = buildMcpBridgePolicyYaml(
      entry.server,
      entry.url,
      adapter,
      target,
      entry.providerName ?? "",
    );
  } catch {
    // Registry entries are untrusted local state. Keep malformed URLs and any
    // credential-shaped material out of the recovery diagnostic.
    throw canonicalOwnershipError();
  }
  const sameNamePolicies = registry
    .getCustomPolicies(sandboxName)
    .filter((policy) => policy.name === expectedPolicyName);
  if (sameNamePolicies.length !== 1) {
    throw new McpBridgeError(
      "Generated MCP policy ownership is missing or ambiguous. Refusing host-side rebuild recovery for a still-live sandbox.",
    );
  }
  const [registeredPolicy] = sameNamePolicies;
  if (registeredPolicy?.sourcePath !== MCP_BRIDGE_POLICY_SOURCE) {
    throw new McpBridgeError(
      "Generated MCP policy has no exact NemoClaw ownership record. Refusing host-side rebuild recovery for a still-live sandbox.",
    );
  }
  if (registeredPolicy.pendingContent !== undefined) {
    throw new McpBridgeError(
      "Generated MCP policy has an incomplete registry transition. Refusing read-only host-side rebuild recovery.",
    );
  }
  if (registeredPolicy.content !== expectedContent) {
    throw canonicalOwnershipError();
  }
  const state = policies.getPresetContentGatewayState(sandboxName, registeredPolicy.content);
  if (state !== "match") {
    throw new McpBridgeError(
      "Generated MCP policy is absent, unreachable, or drifted from its exact ownership record. Refusing host-side rebuild recovery.",
    );
  }
  return { ...registeredPolicy };
}

export function removeGeneratedPolicy(
  sandboxName: string,
  entry: McpBridgeEntry,
  options: { bestEffort?: boolean; preserveRegistryOwnership?: boolean } = {},
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
  const content = effectiveRegistration?.content;
  const gatewayState =
    reconciled?.state ??
    (content
      ? policies.getPresetContentGatewayState(sandboxName, content)
      : getUnownedGeneratedPolicyState(sandboxName, entry));
  if (gatewayState === "absent") {
    if (ownsRegistration && !options.preserveRegistryOwnership) {
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
  if (!content) {
    if (options.bestEffort) return;
    throw new McpBridgeError(
      `Generated MCP policy '${policyName}' has no exact ownership content. Refusing to delete same-key policy state.`,
    );
  }
  const activeState = policies.getPresetContentGatewayState(sandboxName, content);
  if (activeState === "absent") {
    if (!options.preserveRegistryOwnership) {
      registry.removeCustomPolicyByName(sandboxName, policyName);
    }
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
