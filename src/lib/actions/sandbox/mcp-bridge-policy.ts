// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";

import * as policies from "../../policy";
import { assertTrustedPrivateEndpointCapability } from "../../security/trusted-private-endpoint";
import type { McpSourceEntry } from "./mcp-bridge-contracts";
import { isAgentMcpAdapter, McpBridgeError } from "./mcp-bridge-contracts";
import {
  buildMcpBridgeCapabilityPolicyYaml,
  buildMcpBridgePolicyKey,
  buildMcpBridgePolicyName,
  buildMcpBridgePolicyYaml,
} from "./mcp-bridge-policy-render";
import type { McpProviderInspectionRuntimeSelection } from "./mcp-bridge-provider-inspection";
import {
  parseMcpUrlWithValidatedTarget,
  type McpBridgeTargetValidation,
} from "./mcp-bridge-url-validation";

export { MCP_BRIDGE_POLICY_SOURCE } from "./mcp-bridge-contracts";
export {
  buildMcpBridgeCapabilityPolicyYaml,
  buildMcpBridgePolicyKey,
  buildMcpBridgePolicyName,
  buildMcpBridgePolicyYaml,
  MCP_BRIDGE_ALLOWED_METHODS,
  MCP_BRIDGE_POLICY_MAX_BODY_BYTES,
} from "./mcp-bridge-policy-render";

export async function applyGeneratedPolicy(
  sandboxName: string,
  entry: McpSourceEntry,
  target: McpBridgeTargetValidation,
  options: {
    bindCredential?: boolean;
    runtimeSelection: McpProviderInspectionRuntimeSelection;
  },
): Promise<void> {
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
  await applyGeneratedPolicyContent(sandboxName, entry, content, options.runtimeSelection);
}

/** Change only an existing public endpoint's pins in the observed OpenShell policy. */
export async function refreshMcpPublicPolicyPins(
  sandboxName: string,
  entry: McpSourceEntry,
  target: McpBridgeTargetValidation,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
): Promise<void> {
  assertGeneratedPolicyMutationSafe(sandboxName, entry);
  if (entry.trustedPrivateHost) {
    throw new McpBridgeError("Trusted-private pins require explicit remove-and-add approval.", 2);
  }
  const policyPins = [
    ...new Set((entry.allowedIps ?? []).map((address) => address.toLowerCase())),
  ].sort();
  const url = parseMcpUrlWithValidatedTarget(entry.url, { addresses: policyPins });
  assertMcpBridgePolicyTarget(entry, target);
  parseMcpUrlWithValidatedTarget(entry.url, target);
  const operation = `refresh public address pins for MCP server '${entry.server}'`;
  const context = await policies.inspectPolicyMutationContext(
    sandboxName,
    operation,
    runtimeSelection.gatewayName,
    runtimeSelection,
  );
  const document = YAML.parseDocument(context.basePolicyDocument);
  const endpoints = document.getIn(
    ["network_policies", buildMcpBridgePolicyKey(entry.server), "endpoints"],
    true,
  );
  const mcpEndpoints = YAML.isSeq(endpoints)
    ? endpoints.items.filter((node) => YAML.isMap(node) && node.get("protocol") === "mcp")
    : [];
  const endpoint = mcpEndpoints[0];
  if (document.errors.length > 0 || mcpEndpoints.length !== 1 || !YAML.isMap(endpoint)) {
    throw new McpBridgeError(
      "Public-pin refresh requires one unambiguous live MCP policy endpoint. No policy was changed.",
    );
  }
  const binding = endpoint.get("credential_binding", true);
  const pins = endpoint.get("allowed_ips", true);
  if (
    String(endpoint.get("host")).toLowerCase() !== url.hostname ||
    endpoint.get("port") !== Number(url.port || 443) ||
    endpoint.get("path") !== (url.pathname || "/") ||
    !YAML.isMap(binding) ||
    binding.get("provider") !== entry.providerName ||
    !YAML.isSeq(pins) ||
    !isDeepStrictEqual(pins.toJSON(), entry.allowedIps)
  ) {
    throw new McpBridgeError(
      "The live MCP endpoint or pins changed during public-pin refresh. No policy was changed; rerun against the current sources.",
    );
  }
  if (isDeepStrictEqual(policyPins, target.addresses)) return;
  endpoint.set("allowed_ips", target.addresses);
  if (
    !(await policies.setPolicyDocument(sandboxName, document.toString(), {
      nonFatal: true,
      operation,
      context,
    }))
  ) {
    throw new McpBridgeError(
      "Public-pin policy update was not confirmed. Inspect mcp status before retrying; no agent or credential state was changed.",
    );
  }
}

async function applyGeneratedPolicyContent(
  sandboxName: string,
  entry: McpSourceEntry,
  content: string,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
): Promise<void> {
  if (
    !(await policies.applyPresetContent(sandboxName, entry.policyName, content, {
      nonFatal: true,
      runtimeSelection,
    })) ||
    (await policies.getPresetContentGatewayState(
      sandboxName,
      content,
      undefined,
      runtimeSelection,
    )) !== "match"
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
}

export async function removeGeneratedPolicy(
  sandboxName: string,
  entry: McpSourceEntry,
  options: {
    bestEffort?: boolean;
    runtimeSelection: McpProviderInspectionRuntimeSelection;
  },
): Promise<void> {
  const policyKey = buildMcpBridgePolicyKey(entry.server);
  const content = `network_policies:\n  ${policyKey}: {}\n`;
  const removed = await policies.removePreset(sandboxName, entry.policyName, {
    nonFatal: true,
    presetContent: content,
    runtimeSelection: options.runtimeSelection,
  });
  if (removed) return;
  if (options.bestEffort) return;
  throw new McpBridgeError(`Failed to remove generated MCP policy '${entry.policyName}'.`);
}

export async function getPolicyPresence(
  sandboxName: string,
  entry: McpSourceEntry | undefined,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
): Promise<boolean | null> {
  if (!entry) return false;
  try {
    const document = YAML.parse(
      await policies.captureRecordedSandboxBasePolicy(
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
