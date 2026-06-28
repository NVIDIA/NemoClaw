// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  buildMcpBridgePolicyName,
  buildMcpBridgePolicyYaml,
  buildMcpBridgeProviderName,
  MCP_BRIDGE_ALLOWED_METHODS,
  MCP_BRIDGE_POLICY_MAX_BODY_BYTES,
} from "./mcp-bridge";

describe("MCP OpenShell policy", () => {
  it("mcporter Node binary grant requires full MCP endpoint compensating controls", () => {
    const policyName = buildMcpBridgePolicyName("GitHub_Server");
    const policy = YAML.parse(
      buildMcpBridgePolicyYaml("GitHub_Server", "https://api.githubcopilot.com/mcp", "mcporter", [
        "8.8.8.8",
        "2606:4700:4700::1111",
      ]),
    ) as {
      preset: { name: string };
      network_policies: Record<
        string,
        {
          endpoints: Array<{
            host: string;
            port: number;
            path: string;
            protocol: string;
            mcp: {
              max_body_bytes: number;
              strict_tool_names?: boolean;
              allow_all_known_mcp_methods?: boolean;
            };
            allowed_ips?: string[];
            rules?: Array<{ allow: { method: string } }>;
          }>;
          binaries: Array<{ path: string }>;
        }
      >;
    };
    const entry = policy.network_policies.mcp_bridge_github_server;

    expect(policyName).toBe("mcp-bridge-github-server");
    expect(policy.preset.name).toBe(policyName);
    expect(entry.endpoints[0]).toMatchObject({
      host: "api.githubcopilot.com",
      port: 443,
      path: "/mcp",
      protocol: "mcp",
      enforcement: "enforce",
      mcp: {
        max_body_bytes: MCP_BRIDGE_POLICY_MAX_BODY_BYTES,
        strict_tool_names: true,
        allow_all_known_mcp_methods: false,
      },
    });
    expect(entry.endpoints[0].rules).toEqual(
      MCP_BRIDGE_ALLOWED_METHODS.map((method) => ({
        allow: { method },
      })),
    );
    expect(entry.endpoints[0].allowed_ips).toEqual(["8.8.8.8", "2606:4700:4700::1111"]);
    expect(entry.binaries.map((binary) => binary.path)).toEqual([
      "/usr/local/bin/mcporter",
      "/usr/bin/mcporter",
      "/usr/local/bin/openclaw",
      "/usr/local/bin/node",
      "/usr/bin/node",
    ]);
    expect(entry.endpoints[0].mcp).toEqual({
      max_body_bytes: MCP_BRIDGE_POLICY_MAX_BODY_BYTES,
      strict_tool_names: true,
      allow_all_known_mcp_methods: false,
    });
  });

  it("pins the current OpenShell main client-to-server MCP method profile", () => {
    expect(MCP_BRIDGE_ALLOWED_METHODS).toEqual([
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
    ]);
  });

  it("emits only fields supported by OpenShell current main", () => {
    const policy = YAML.parse(
      buildMcpBridgePolicyYaml("srv", "https://mcp.example.test/mcp", "mcporter"),
    ) as { network_policies: Record<string, { endpoints: Array<Record<string, unknown>> }> };
    const endpoint = policy.network_policies.mcp_bridge_srv.endpoints[0];
    expect(endpoint).not.toHaveProperty("credential_keys");
    expect(endpoint).not.toHaveProperty("tls");
  });

  it("allows the OpenShell host alias with private-network SSRF guards", () => {
    const policy = YAML.parse(
      buildMcpBridgePolicyYaml("local", "https://host.openshell.internal:31337/mcp", "mcporter"),
    ) as {
      network_policies: Record<string, { endpoints: Array<{ allowed_ips: string[] }> }>;
    };

    expect(policy.network_policies.mcp_bridge_local.endpoints[0].allowed_ips).toEqual([
      "10.0.0.0/8",
      "172.16.0.0/12",
      "192.168.0.0/16",
      "fc00::/7",
    ]);
  });

  it("scopes binaries to the selected agent adapter", () => {
    const hermes = YAML.parse(
      buildMcpBridgePolicyYaml("srv", "https://mcp.example.test/mcp", "hermes-config"),
    ) as {
      network_policies: Record<string, { binaries: Array<{ path: string }> }>;
    };
    const deepAgents = YAML.parse(
      buildMcpBridgePolicyYaml("srv", "https://mcp.example.test/mcp", "deepagents-config"),
    ) as {
      network_policies: Record<string, { binaries: Array<{ path: string }> }>;
    };

    expect(hermes.network_policies.mcp_bridge_srv.binaries.map((b) => b.path)).toEqual([
      "/usr/local/bin/hermes",
      "/opt/hermes/.venv/bin/python*",
    ]);
    expect(deepAgents.network_policies.mcp_bridge_srv.binaries.map((b) => b.path)).toEqual([
      "/usr/local/bin/dcode",
      "/opt/venv/bin/python3*",
    ]);
  });

  it("uses stable provider names with a length guard", () => {
    expect(buildMcpBridgeProviderName("alpha", "GitHub_Server")).toBe("alpha-mcp-github-server");
    const long = buildMcpBridgeProviderName(
      "sandbox-name-with-a-long-prefix",
      "ServerNameThatWouldOtherwiseExceedTheProviderNameLimit",
    );
    expect(long.length).toBeLessThanOrEqual(63);
    expect(long).toMatch(/^sandbox-name-with-a-long-prefix-mcp-servername-[a-f0-9]{16}$/);
    expect(buildMcpBridgeProviderName("alpha", "GitHub_Server", "0123456789abcdef")).toBe(
      "alpha-mcp-github-server-0123456789abcdef",
    );
  });
});
