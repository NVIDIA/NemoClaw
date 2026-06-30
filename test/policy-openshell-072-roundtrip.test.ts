// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import path from "node:path";

import { describe, expect, it } from "vitest";

const requireForTest = createRequire(import.meta.url);
const YAML = requireForTest("yaml");
const policies = requireForTest(
  path.join(import.meta.dirname, "..", "src", "lib", "policy", "index.ts"),
) as typeof import("../src/lib/policy");

const EXISTING_POLICY = {
  version: 1,
  network_policies: {
    mcp_server: {
      endpoints: [
        {
          host: "mcp.example.com",
          port: 443,
          path: "/mcp",
          protocol: "mcp",
          enforcement: "enforce",
          mcp: {
            allow_all_known_mcp_methods: true,
            max_body_bytes: 131072,
            strict_tool_names: true,
          },
          rules: [{ allow: { tool: { any: ["search_web", "list_tools"] } } }],
          deny_rules: [{ tool: { any: ["send_email", "delete_resource"] } }],
        },
      ],
    },
    json_rpc_server: {
      endpoints: [
        {
          host: "rpc.example.com",
          port: 443,
          path: "/rpc",
          protocol: "json-rpc",
          enforcement: "enforce",
          json_rpc: { max_body_bytes: 131072 },
          rules: [{ allow: { method: "reports.search" } }],
        },
      ],
    },
  },
};

const PRESET_ENTRIES = YAML.stringify({
  pypi_access: {
    name: "pypi_access",
    endpoints: [{ host: "pypi.org", port: 443, access: "full" }],
  },
}).replace(/^/gm, "  ");

describe("OpenShell 0.0.72 policy round-trip compatibility", () => {
  it("preserves MCP and JSON-RPC fields while merging a preset", () => {
    const merged = YAML.parse(
      policies.mergePresetIntoPolicy(YAML.stringify(EXISTING_POLICY), PRESET_ENTRIES),
    );

    expect(merged.network_policies).toEqual({
      ...EXISTING_POLICY.network_policies,
      pypi_access: expect.any(Object),
    });
  });
});
