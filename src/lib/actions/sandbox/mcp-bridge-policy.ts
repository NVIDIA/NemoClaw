// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";

import * as policies from "../../policy";
import { assertTrustedPrivateEndpointCapability } from "../../security/trusted-private-endpoint";
import type { McpSourceEntry } from "./mcp-bridge-contracts";
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
  buildMcpBridgeCapabilityPolicyYaml,
  buildMcpBridgePolicyKey,
  buildMcpBridgePolicyName,
  buildMcpBridgePolicyYaml,
  MCP_BRIDGE_ALLOWED_METHODS,
  MCP_BRIDGE_POLICY_MAX_BODY_BYTES,
} from "./mcp-bridge-policy-render";

export function applyGeneratedPolicy(
  sandboxName: string,
  entry: McpSourceEntry,
  target: McpBridgeTargetValidation,
  options: {
    bindCredential?: boolean;
    runtimeSelection: McpProviderInspectionRuntimeSelection;
  },
): void {
  assertGeneratedPolicyMutationSafe(sandboxName, entry);
  const addresses = assertMcpBridgePolicyTarget(entry, target);
  if (addresses.length === 0) {
    throw new McpBridgeError(
      `Refusing to apply generated MCP policy '${entry.policyName}' without address pins.`,
    );
  }
  const adapter = isAgentMcpAdapter(entry.adapter) ? entry.adapter : "openclaw-config";
  const content =
    options.bindCredential === false
      ? buildMcpBridgeCapabilityPolicyYaml(
          entry.server,
          entry.url,
          adapter,
          target,
          entry.denyTools,
        )
      : buildMcpBridgePolicyYaml(
          entry.server,
          entry.url,
          adapter,
          target,
          entry.providerName ?? "",
          entry.denyTools,
        );
  applyGeneratedPolicyContent(sandboxName, entry, content, options.runtimeSelection);
}

function applyGeneratedPolicyContent(
  sandboxName: string,
  entry: McpSourceEntry,
  content: string,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
): void {
  if (
    !policies.applyPresetContent(sandboxName, entry.policyName, content, {
      nonFatal: true,
      runtimeSelection,
    }) ||
    policies.getPresetContentGatewayState(sandboxName, content, undefined, runtimeSelection) !==
      "match"
  ) {
    throw new McpBridgeError(`Failed to activate generated MCP policy '${entry.policyName}'.`);
  }
}

export function assertMcpBridgePolicyTarget(
  entry: McpSourceEntry,
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

export function assertGeneratedPolicyMutationSafe(
  _sandboxName: string,
  entry: McpSourceEntry,
): void {
  if (entry.policyName !== buildMcpBridgePolicyName(entry.server)) {
    throw new McpBridgeError("Generated MCP policy name does not match its bridge definition.");
  }
  if (entry.policyConflict) {
    throw new McpBridgeError(
      `MCP server '${entry.server}' has conflicting live policy. Reconcile the live policy with the native MCP configuration before retrying.`,
      2,
    );
  }
}

export function removeGeneratedPolicy(
  sandboxName: string,
  entry: McpSourceEntry,
  options: {
    bestEffort?: boolean;
    runtimeSelection: McpProviderInspectionRuntimeSelection;
  },
): void {
  assertGeneratedPolicyMutationSafe(sandboxName, entry);
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

export function getPolicyPresence(
  sandboxName: string,
  entry: McpSourceEntry | undefined,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
): boolean | null {
  if (!entry) return false;
  try {
    const document = YAML.parse(
      policies.captureRecordedSandboxBasePolicy(
        sandboxName,
        "inspect current MCP policy",
        runtimeSelection,
      ),
    ) as { network_policies?: Record<string, unknown> } | null;
    return Boolean(
      document?.network_policies &&
      Object.hasOwn(document.network_policies, buildMcpBridgePolicyKey(entry.server)),
    );
  } catch {
    return null;
  }
}
