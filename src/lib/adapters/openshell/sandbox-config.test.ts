// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { sdkPolicyDocument } from "./sandbox-config";

function document(endpoint: Record<string, unknown>) {
  return sdkPolicyDocument({
    version: 1,
    network_policies: {
      api: { name: "api", endpoints: [endpoint], binaries: [{ path: "/usr/bin/curl" }] },
    },
  });
}

function exportedEndpoint(endpoint: Record<string, unknown>) {
  return (document(endpoint).network_policies as { api: { endpoints: unknown[] } }).api
    .endpoints[0];
}

describe("SDK policy document conversion", () => {
  it("preserves filesystem defaults and omits an empty process identity", () => {
    expect(
      sdkPolicyDocument({
        version: 1,
        filesystem: { read_only: ["/usr"] },
        process: {},
        landlock: {},
      }),
    ).toEqual({
      version: 1,
      filesystem_policy: { include_workdir: false, read_only: ["/usr"] },
      landlock: {},
    });
  });

  it.each([
    [{ port: 443 }, { port: 443 }],
    [{ ports: [443] }, { port: 443 }],
    [{ port: 80, ports: [443, 8443] }, { ports: [443, 8443] }],
  ])("preserves effective ports for %j", (input, expected) => {
    expect(exportedEndpoint({ host: "api.example", ...input })).toEqual({
      host: "api.example",
      ...expected,
    });
  });

  it("preserves REST allow, deny, and query restrictions", () => {
    expect(
      exportedEndpoint({
        host: "api.example",
        port: 443,
        protocol: "rest",
        tls: "terminate",
        rules: [
          {
            allow: {
              method: "GET",
              path: "/v1/*",
              query: { repo: { glob: "NVIDIA/*" }, scope: { any: ["read", "list"] } },
            },
          },
        ],
        deny_rules: [{ method: "DELETE", path: "/v1/*" }],
      }),
    ).toEqual({
      host: "api.example",
      port: 443,
      protocol: "rest",
      tls: "terminate",
      rules: [
        {
          allow: {
            method: "GET",
            path: "/v1/*",
            query: { repo: "NVIDIA/*", scope: { any: ["read", "list"] } },
          },
        },
      ],
      deny_rules: [{ method: "DELETE", path: "/v1/*" }],
    });
  });

  it("preserves explicit false MCP options and tool restrictions", () => {
    expect(
      exportedEndpoint({
        protocol: "mcp",
        json_rpc_max_body_bytes: 4096,
        mcp: { strict_tool_names: false, allow_all_known_mcp_methods: false },
        rules: [
          {
            allow: {
              method: "tools/call",
              params: {
                name: { glob: "search" },
                "arguments.repo": { glob: "NVIDIA/*" },
                "arguments.limit": { any: ["1", "2"] },
              },
            },
          },
        ],
      }),
    ).toEqual({
      protocol: "mcp",
      mcp: { max_body_bytes: 4096, strict_tool_names: false, allow_all_known_mcp_methods: false },
      rules: [
        {
          allow: {
            method: "tools/call",
            tool: "search",
            params: { arguments: { repo: "NVIDIA/*", limit: { any: ["1", "2"] } } },
          },
        },
      ],
    });
  });

  it("uses the MCP method profile only when enabled", () => {
    expect(
      exportedEndpoint({
        protocol: "mcp",
        mcp: { allow_all_known_mcp_methods: true },
        rules: [
          { allow: { method: "tools/call", params: { name: { glob: "search" } } } },
          { allow: { method: "*" } },
        ],
        deny_rules: [{ method: "tools/call", params: { name: { any: ["delete", "write"] } } }],
      }),
    ).toEqual({
      protocol: "mcp",
      mcp: { allow_all_known_mcp_methods: true },
      rules: [{ allow: { tool: "search" } }, { allow: {} }],
      deny_rules: [{ tool: { any: ["delete", "write"] } }],
    });
  });

  it("keeps colliding MCP parameter paths flat without losing restrictions", () => {
    expect(
      exportedEndpoint({
        protocol: "mcp",
        rules: [{ allow: { params: { a: { glob: "x" }, "a.b": { glob: "y" } } } }],
      }),
    ).toEqual({
      protocol: "mcp",
      rules: [{ allow: { params: { a: "x", "a.b": "y" } } }],
    });
  });

  it("preserves JSON-RPC body limits and flat parameter keys", () => {
    expect(
      exportedEndpoint({
        protocol: "json-rpc",
        json_rpc_max_body_bytes: 4096,
        rules: [
          { allow: { method: "read", params: { name: { glob: "x" }, "a.b": { glob: "y" } } } },
        ],
      }),
    ).toEqual({
      protocol: "json-rpc",
      json_rpc: { max_body_bytes: 4096 },
      rules: [{ allow: { method: "read", params: { name: "x", "a.b": "y" } } }],
    });
  });

  it("preserves provider-composed rules and ignores the deprecated binary harness flag", () => {
    expect(
      sdkPolicyDocument({
        version: 1,
        network_policies: {
          "provider:nvidia": {
            name: "provider:nvidia",
            endpoints: [{ host: "api.example", port: 443 }],
            binaries: [{ path: "/usr/bin/curl", harness: true }],
          },
        },
      }),
    ).toEqual({
      version: 1,
      network_policies: {
        "provider:nvidia": {
          name: "provider:nvidia",
          endpoints: [{ host: "api.example", port: 443 }],
          binaries: [{ path: "/usr/bin/curl" }],
        },
      },
    });
  });
});
