// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import YAML from "yaml";

import type { AgentMcpAdapter } from "../../agent/defs";
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

function allowedIpsForEndpoint(
  resolvedAddresses: readonly string[] | undefined,
): string[] | undefined {
  // OpenShell resolves this hostname for every new connection, validates every
  // current answer against allowed_ips, and connects to that validated list.
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
  const allowedIps = allowedIpsForEndpoint(resolvedAddresses);
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
            rules: MCP_BRIDGE_ALLOWED_METHODS.map((method) => ({ allow: { method } })),
          },
        ],
        binaries: binariesForAdapter(adapter),
      },
    },
  });
}
