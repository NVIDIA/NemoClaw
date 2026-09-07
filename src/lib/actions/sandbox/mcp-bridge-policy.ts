// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import type { AgentMcpAdapter } from "../../agent/defs";
import * as policies from "../../policy";
import {
  assertTrustedPrivateEndpointCapability,
  replayTrustedPrivateEndpoint,
} from "../../security/trusted-private-endpoint";
import type { McpBridgeEntry } from "../../state/registry";
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
import type { McpProviderInspectionRuntimeSelection } from "./mcp-bridge-provider-inspection";
import type { McpBridgeTargetValidation } from "./mcp-bridge-url-validation";

export { MCP_BRIDGE_POLICY_SOURCE } from "./mcp-bridge-contracts";
export {
  buildMcpBridgePolicyKey,
  buildMcpBridgePolicyName,
  buildMcpBridgePolicyYaml,
  MCP_BRIDGE_ALLOWED_METHODS,
  MCP_BRIDGE_POLICY_MAX_BODY_BYTES,
} from "./mcp-bridge-policy-render";

export function applyGeneratedPolicy(
  sandboxName: string,
  entry: McpBridgeEntry,
  target: McpBridgeTargetValidation,
  options: {
    bindCredential?: boolean;
    runtimeSelection: McpProviderInspectionRuntimeSelection;
  },
): void {
  const addresses = assertMcpBridgePolicyTarget(entry, target);
  if (addresses.length === 0) {
    throw new McpBridgeError(
      `Refusing to apply generated MCP policy '${entry.policyName}' without address pins.`,
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
  if (
    !policies.applyPresetContent(sandboxName, entry.policyName, content, {
      nonFatal: true,
      runtimeSelection: options.runtimeSelection,
    }) ||
    policies.getPresetContentGatewayState(
      sandboxName,
      content,
      undefined,
      options.runtimeSelection,
    ) !== "match"
  ) {
    throw new McpBridgeError(`Failed to activate generated MCP policy '${entry.policyName}'.`);
  }
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

function recordedMcpTarget(entry: McpBridgeEntry): McpBridgeTargetValidation {
  if (entry.trustedPrivateHost) {
    const replay = replayTrustedPrivateEndpoint(entry.trustedPrivateHost, entry.allowedIps ?? [], {
      requireAllPrivate: true,
    });
    return {
      addresses: [...replay.addresses],
      trustedPrivateCapability: replay.trustedPrivateCapability,
      trustedPrivateHost: replay.host,
    };
  }
  return { addresses: [...(entry.allowedIps ?? [])] };
}

function generatedPolicyContent(
  entry: McpBridgeEntry,
  adapter: AgentMcpAdapter = isAgentMcpAdapter(entry.adapter) ? entry.adapter : "mcporter",
  target: McpBridgeTargetValidation = recordedMcpTarget(entry),
): string {
  assertMcpBridgePolicyTarget(entry, target);
  return buildMcpBridgePolicyYaml(
    entry.server,
    entry.url,
    adapter,
    target,
    entry.providerName ?? "",
  );
}

export function assertGeneratedPolicyMutationSafe(
  _sandboxName: string,
  entry: McpBridgeEntry,
): void {
  if (entry.policyName !== buildMcpBridgePolicyName(entry.server)) {
    throw new McpBridgeError("Generated MCP policy name does not match its bridge definition.");
  }
}

export function assertGeneratedPolicyRegistrationMutationSafe(
  _sandboxName: string,
  entry: McpBridgeEntry,
) {
  assertGeneratedPolicyMutationSafe(_sandboxName, entry);
  return {
    name: entry.policyName,
    content: generatedPolicyContent(entry),
    sourcePath: MCP_BRIDGE_POLICY_SOURCE,
  };
}

export function removeGeneratedPolicy(
  sandboxName: string,
  entry: McpBridgeEntry,
  options: {
    bestEffort?: boolean;
    runtimeSelection: McpProviderInspectionRuntimeSelection;
  },
): void {
  const policyKey = buildMcpBridgePolicyKey(entry.server);
  const content = `network_policies:\n  ${policyKey}: {}\n`;
  const removed = policies.removePreset(sandboxName, entry.policyName, {
    nonFatal: true,
    presetContent: content,
    runtimeSelection: options.runtimeSelection,
  });
  if (removed) return;
  if (options.bestEffort) return;
  throw new McpBridgeError(`Failed to remove generated MCP policy '${entry.policyName}'.`);
}

export function getRegisteredGeneratedPolicy(
  _sandboxName: string,
  entry: McpBridgeEntry | undefined,
) {
  if (!entry?.policyName) return undefined;
  try {
    return {
      name: entry.policyName,
      content: generatedPolicyContent(entry),
      sourcePath: MCP_BRIDGE_POLICY_SOURCE,
    };
  } catch {
    return undefined;
  }
}

export function getPolicyPresence(
  sandboxName: string,
  entry: McpBridgeEntry | undefined,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
): boolean | null {
  const registered = getRegisteredGeneratedPolicy(sandboxName, entry);
  if (!registered) return entry ? null : false;
  const state = policies.getPresetContentGatewayState(
    sandboxName,
    registered.content,
    undefined,
    runtimeSelection,
  );
  return state === "match" ? true : state === "absent" ? false : null;
}
