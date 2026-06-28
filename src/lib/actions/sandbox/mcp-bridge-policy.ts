// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import YAML from "yaml";

import type { AgentMcpAdapter } from "../../agent/defs";
import * as policies from "../../policy";
import { isOpenShellMcpHostAlias } from "../../security/mcp-url-target";
import type { McpBridgeEntry } from "../../state/registry";
import * as registry from "../../state/registry";
import {
  isAgentMcpAdapter,
  MCP_BRIDGE_POLICY_SOURCE,
  McpBridgeError,
} from "./mcp-bridge-contracts";
import { parseMcpUrl, validateMcpServerName } from "./mcp-bridge-validation";

export const MCP_BRIDGE_POLICY_MAX_BODY_BYTES = 131_072;
export const MCP_BRIDGE_ALLOWED_METHODS = [
  "initialize",
  "notifications/initialized",
  "ping",
  "tools/list",
  "tools/call",
  "resources/list",
  "resources/read",
  "resources/templates/list",
  "resources/subscribe",
  "resources/unsubscribe",
  "prompts/list",
  "prompts/get",
  "tasks/list",
  "tasks/get",
  "tasks/update",
  "tasks/result",
  "tasks/cancel",
  "completion/complete",
  "logging/setLevel",
  "server/discover",
  "messages/listen",
  "notifications/cancelled",
  "notifications/progress",
  "notifications/roots/list_changed",
  "notifications/elicitation/complete",
] as const;

export function buildMcpBridgePolicyName(server: string): string {
  validateMcpServerName(server);
  return `mcp-bridge-${server.toLowerCase().replace(/_/g, "-")}`;
}

export function buildMcpBridgePolicyKey(server: string): string {
  return buildMcpBridgePolicyName(server).replace(/-/g, "_");
}

function endpointPort(url: URL): number {
  if (url.port) return Number.parseInt(url.port, 10);
  return url.protocol === "https:" ? 443 : 80;
}

function endpointPath(url: URL): string {
  return url.pathname || "/";
}

function binariesForAdapter(adapter: AgentMcpAdapter): Array<{ path: string }> {
  switch (adapter) {
    case "mcporter":
      return [
        { path: "/usr/local/bin/mcporter" },
        { path: "/usr/bin/mcporter" },
        { path: "/usr/local/bin/openclaw" },
        // Both npm entrypoints are #!/usr/bin/env node scripts. OpenShell binds
        // policy to /proc/<pid>/exe and ancestors, not spoofable argv paths.
        // The explicit endpoint/path/MCP method rules below are the compensating
        // boundary for other Node processes in the sandbox.
        { path: "/usr/local/bin/node" },
        { path: "/usr/bin/node" },
      ];
    case "hermes-config":
      return [{ path: "/usr/local/bin/hermes" }, { path: "/opt/hermes/.venv/bin/python*" }];
    case "deepagents-config":
      return [{ path: "/usr/local/bin/dcode" }, { path: "/opt/venv/bin/python3*" }];
  }
}

function allowedIpsForEndpoint(
  hostname: string,
  resolvedAddresses: readonly string[] | undefined,
): string[] | undefined {
  if (isOpenShellMcpHostAlias(hostname)) {
    // A host alias is an explicit opt-in URL selected by the host operator.
    // OpenShell maps its gateway IP per driver, so these private CIDRs cover
    // that mapping; policy remains pinned to the exact alias, port, path,
    // protocol, allowed MCP methods, and adapter binaries.
    return ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"];
  }
  return resolvedAddresses && resolvedAddresses.length > 0 ? [...resolvedAddresses] : undefined;
}

export function buildMcpBridgePolicyYaml(
  server: string,
  url: string,
  adapter: AgentMcpAdapter,
  resolvedAddresses?: readonly string[],
): string {
  const parsed = parseMcpUrl(url);
  const key = buildMcpBridgePolicyKey(server);
  const allowedIps = allowedIpsForEndpoint(parsed.hostname, resolvedAddresses);
  return YAML.stringify({
    preset: {
      name: buildMcpBridgePolicyName(server),
      description: `Generated MCP policy for ${server}`,
    },
    network_policies: {
      [key]: {
        name: key,
        endpoints: [
          {
            host: parsed.hostname,
            port: endpointPort(parsed),
            path: endpointPath(parsed),
            protocol: "mcp",
            enforcement: "enforce",
            ...(allowedIps ? { allowed_ips: allowedIps } : {}),
            mcp: {
              max_body_bytes: MCP_BRIDGE_POLICY_MAX_BODY_BYTES,
              strict_tool_names: true,
              allow_all_known_mcp_methods: false,
            },
            rules: MCP_BRIDGE_ALLOWED_METHODS.map((method) => ({
              allow: { method },
            })),
          },
        ],
        binaries: binariesForAdapter(adapter),
      },
    },
  });
}

export function applyGeneratedPolicy(
  sandboxName: string,
  entry: McpBridgeEntry,
  resolvedAddresses?: readonly string[],
): void {
  const adapter = isAgentMcpAdapter(entry.adapter) ? entry.adapter : "mcporter";
  const content = buildMcpBridgePolicyYaml(entry.server, entry.url, adapter, resolvedAddresses);
  const policyKey = buildMcpBridgePolicyKey(entry.server);
  const previousPolicy = registry
    .getCustomPolicies(sandboxName)
    .find(
      (policy) =>
        policy.name === entry.policyName && policy.sourcePath === MCP_BRIDGE_POLICY_SOURCE,
    );
  let ownsExistingPolicyKey = false;
  if (previousPolicy) {
    const previousState = policies.getPresetContentGatewayState(
      sandboxName,
      previousPolicy.content,
    );
    if (previousState !== "absent" && previousState !== "match") {
      throw new McpBridgeError(
        `Generated MCP policy '${entry.policyName}' has drifted or could not be inspected against its recorded content. Refusing to replace the live key.`,
      );
    }
    // A prior ownership record may have been reserved immediately before a
    // process died, so an absent key is safe to create. A present key is safe
    // to replace only after its full content matches that ownership record.
    ownsExistingPolicyKey = previousState === "match";
  } else if (!previousPolicy) {
    const unownedState = policies.getPresetContentGatewayState(sandboxName, content);
    if (unownedState !== "absent") {
      throw new McpBridgeError(
        `Generated MCP policy key '${policyKey}' is already present or could not be inspected without a NemoClaw ownership record.`,
      );
    }
  }

  // Reserve/update ownership before the live gateway mutation. This avoids a
  // successful policy set followed by a registry-write failure leaving an
  // unowned live key that neither rollback nor retry can safely touch.
  const ownershipRecorded = registry.addCustomPolicy(sandboxName, {
    name: entry.policyName,
    content,
    sourcePath: MCP_BRIDGE_POLICY_SOURCE,
  });
  if (!ownershipRecorded) {
    throw new McpBridgeError(
      `Could not reserve ownership for generated MCP policy '${entry.policyName}'.`,
    );
  }
  const ok = policies.applyPresetContent(sandboxName, entry.policyName, content, {
    custom: { sourcePath: MCP_BRIDGE_POLICY_SOURCE },
    allowedExistingNetworkPolicyKeys: ownsExistingPolicyKey ? [policyKey] : [],
    nonFatal: true,
    skipRegistryUpdate: true,
  });
  if (ok === false) {
    const after = policies.getPresetContentGatewayState(sandboxName, content);
    if (after !== "match") {
      if (previousPolicy) {
        registry.addCustomPolicy(sandboxName, previousPolicy);
      } else {
        registry.removeCustomPolicyByName(sandboxName, entry.policyName);
      }
    }
    throw new McpBridgeError(`Failed to apply generated MCP policy '${entry.policyName}'.`);
  }
}

function generatedPolicyContent(entry: McpBridgeEntry): string {
  const adapter = isAgentMcpAdapter(entry.adapter) ? entry.adapter : "mcporter";
  return buildMcpBridgePolicyYaml(entry.server, entry.url, adapter);
}

export function assertGeneratedPolicyMutationSafe(
  sandboxName: string,
  entry: McpBridgeEntry,
): void {
  const registeredPolicy = registry
    .getCustomPolicies(sandboxName)
    .find((policy) => policy.name === entry.policyName);
  const content = registeredPolicy?.content ?? generatedPolicyContent(entry);
  const state = policies.getPresetContentGatewayState(sandboxName, content);
  const owned = registeredPolicy?.sourcePath === MCP_BRIDGE_POLICY_SOURCE;
  if (state === "absent") return;
  if (!owned || state !== "match") {
    throw new McpBridgeError(
      `Generated MCP policy '${entry.policyName}' is unowned, unreachable, or drifted. Refusing to mutate the adapter, provider, or same-key live policy until ownership is resolved.`,
    );
  }
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
  const content = registeredPolicy?.content ?? generatedPolicyContent(entry);
  const gatewayState = policies.getPresetContentGatewayState(sandboxName, content);
  if (gatewayState === "absent") {
    if (registeredPolicy?.sourcePath === MCP_BRIDGE_POLICY_SOURCE) {
      registry.removeCustomPolicyByName(sandboxName, policyName);
    }
    return;
  }
  const ownsRegistration = registeredPolicy?.sourcePath === MCP_BRIDGE_POLICY_SOURCE;
  if (!ownsRegistration || gatewayState !== "match") {
    if (options.bestEffort) return;
    throw new McpBridgeError(
      `Generated MCP policy '${policyName}' is unowned, unreachable, or no longer matches its registered content. Refusing to delete same-key policy state.`,
    );
  }
  const ok = policies.removePreset(sandboxName, policyName, { nonFatal: true });
  if (!ok) {
    if (options.bestEffort) return;
    throw new McpBridgeError(`Failed to remove generated MCP policy '${policyName}'.`);
  }
  registry.removeCustomPolicyByName(sandboxName, policyName);
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
  return policies.presetContentMatchesGateway(sandboxName, registeredPolicy.content);
}
