// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import YAML from "yaml";

import type { AgentMcpAdapter } from "../../agent/defs";
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
        // npm entrypoints are #!/usr/bin/env node scripts. OpenShell binds
        // policy to /proc/<pid>/exe and ancestors, not spoofable argv paths.
        { path: "/usr/local/bin/node" },
        { path: "/usr/bin/node" },
      ];
    case "hermes-config":
      return [
        { path: "/usr/local/bin/hermes" },
        // Hermes is a Python console script; /proc/<pid>/exe resolves the venv
        // interpreter to the system Python binary after the wrapper execs it.
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
): string {
  const parsed = parseMcpUrlWithValidatedTarget(url, target);
  const key = buildMcpBridgePolicyKey(server);
  // OpenShell resolves this hostname for every new connection, validates every
  // current answer against allowed_ips, and connects to that validated list.
  const allowedIps = [...target.addresses];
  const normalizedDenyTools = normalizeMcpDenyTools(denyTools);
  const normalizedAllowTools = allowTools ? [...allowTools].sort() : [];
  const isAllowlistMode = normalizedAllowTools.length > 0;

  // In allowlist mode, we generate explicit allow rules for each tool.
  // In denylist mode (default), we generate deny rules for each tool.
  const toolRules = isAllowlistMode
    ? normalizedAllowTools.map((tool) => ({ allow: { method: "tools/call", tool } }))
    : normalizedDenyTools.map((tool) => ({ deny: { method: "tools/call", tool } }));

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
            },
            rules: [
              ...MCP_BRIDGE_ALLOWED_METHODS.map((method) => ({ allow: { method } })),
              ...toolRules,
            ],
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
  );
}

/** Render the temporary credential-free policy used before first provider attachment. */
export function buildMcpBridgeCapabilityPolicyYaml(
  server: string,
  url: string,
  adapter: AgentMcpAdapter,
  target: McpBridgeTargetValidation,
  denyTools: readonly string[] = [],
  allowTools?: readonly string[],
): string {
  return renderMcpBridgePolicyYaml(server, url, adapter, target, undefined, denyTools, allowTools);
}
