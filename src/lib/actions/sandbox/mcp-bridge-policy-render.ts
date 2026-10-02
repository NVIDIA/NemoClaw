// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import YAML from "yaml";

import type { AgentMcpAdapter } from "../../agent/defs";
import type { McpServerIdentity, McpTransport } from "./mcp-bridge-contracts";
import {
  type McpBridgeTargetValidation,
  parseMcpUrlWithValidatedTarget,
} from "./mcp-bridge-url-validation";
import { normalizeMcpDenyTools, validateMcpServerName } from "./mcp-bridge-validation";

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
    case "openclaw-config":
      return [
        { path: "/usr/local/bin/openclaw" },
        { path: "/usr/local/bin/node" },
        { path: "/usr/bin/node" },
      ];
    case "hermes-config":
      return [
        { path: "/usr/local/bin/hermes" },
        { path: "/usr/bin/python3*" },
        { path: "/opt/hermes/.venv/bin/python*" },
      ];
    case "deepagents-config":
      return [{ path: "/usr/local/bin/dcode" }, { path: "/opt/venv/bin/python3*" }];
  }
}

function renderMcpBridgePolicyYaml(
  server: string,
  url: string,
  adapter: AgentMcpAdapter,
  target: McpBridgeTargetValidation,
  providerName?: string,
  denyTools: readonly string[] = [],
  allowTools?: readonly string[],
  _serverIdentity?: McpServerIdentity,
  _transport?: McpTransport,
  _requireOAuth?: boolean,
): string {
  const parsed = parseMcpUrlWithValidatedTarget(url, target);
  const key = buildMcpBridgePolicyKey(server);
  const allowedIps = [...target.addresses];
  const normalizedDenyTools = normalizeMcpDenyTools(denyTools);
  const normalizedAllowTools = allowTools ? [...allowTools].sort() : [];
  const isAllowlistMode = normalizedAllowTools.length > 0;

  // OpenShell 0.0.116 reads:
  // - tool names from allow.params.name (in allowlist mode)
  // - denials from endpoint.deny_rules (in denylist mode)
  const denyRules = normalizedDenyTools.map((tool) => {
    return {
      method: "tools/call",
      params: { name: tool },
    };
  });

  const allowedMethods = isAllowlistMode
    ? MCP_BRIDGE_ALLOWED_METHODS.filter((m) => m !== "tools/call")
    : MCP_BRIDGE_ALLOWED_METHODS;

  // In allowlist mode, emit explicit allow rules using params.name
  const allowRules = normalizedAllowTools.map((tool) => {
    return {
      allow: { method: "tools/call", params: { name: tool } },
    };
  });

  // In denylist mode, emit deny rules at endpoint level (deny_rules)
  // Do NOT emit deny entries in the rules array — not part of schema
  // No serverIdentity, transport, or requireOAuth in mcp config - these are unsupported by OpenShell v0.0.116.
  // They are persisted separately in the bridge state and restored during add/rebuild.
  // The mcp.allow field is also unsupported; allowlist rules belong in rules[].allow.params.name.
  const mcpConfig: Record<string, unknown> = {};

  // In denylist mode, emit deny rules at endpoint level
  const endpointDenyRules = isAllowlistMode || denyRules.length === 0 ? undefined : denyRules;

  const mcpExtras: Record<string, unknown> = {};

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
            allowed_ips: allowedIps,
            ...(providerName ? { credential_binding: { provider: providerName } } : {}),
            mcp: {
              max_body_bytes: MCP_BRIDGE_POLICY_MAX_BODY_BYTES,
              strict_tool_names: true,
              allow_all_known_mcp_methods: false,
              ...mcpConfig,
              ...mcpExtras,
            },
            ...(endpointDenyRules ? { deny_rules: endpointDenyRules } : {}),
            rules: [...allowedMethods.map((method) => ({ allow: { method } })), ...allowRules],
          },
        ],
        binaries: binariesForAdapter(adapter),
      },
    },
  });
}

export function buildMcpBridgePolicyYaml(
  server: string,
  url: string,
  adapter: AgentMcpAdapter,
  target: McpBridgeTargetValidation,
  providerName: string,
  denyTools: readonly string[] = [],
  allowTools?: readonly string[],
  serverIdentity?: McpServerIdentity,
  transport?: McpTransport,
  requireOAuth?: boolean,
): string {
  if (providerName.trim() !== providerName || providerName.length === 0) {
    throw new Error("Generated MCP credential binding requires an exact provider name.");
  }
  return renderMcpBridgePolicyYaml(
    server,
    url,
    adapter,
    target,
    providerName,
    denyTools,
    allowTools,
    serverIdentity,
    transport,
    requireOAuth,
  );
}

export function buildMcpBridgeCapabilityPolicyYaml(
  server: string,
  url: string,
  adapter: AgentMcpAdapter,
  target: McpBridgeTargetValidation,
  denyTools: readonly string[] = [],
  allowTools?: readonly string[],
  serverIdentity?: McpServerIdentity,
  transport?: McpTransport,
  requireOAuth?: boolean,
): string {
  return renderMcpBridgePolicyYaml(
    server,
    url,
    adapter,
    target,
    undefined,
    denyTools,
    allowTools,
    serverIdentity,
    transport,
    requireOAuth,
  );
}
